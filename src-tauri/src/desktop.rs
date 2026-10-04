use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};

static STORE_LOCK: Mutex<()> = Mutex::new(());
static REVIEW_LOCK: Mutex<()> = Mutex::new(());
const SNAPSHOT_LIMIT: usize = 16 * 1024 * 1024;
const FILE_LIMIT: u64 = 1024 * 1024;
const GIT_DETAIL_LIMIT: usize = 300;
pub const LOG_LIMIT: u64 = 8 * 1024 * 1024;
/// Most of a teammate run's memory or outbox file read back; the frontend
/// caps what it keeps far below this.
const TEAMMATE_READ_LIMIT: u64 = 256 * 1024;

pub fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    #[cfg(debug_assertions)]
    if let Some(path) = std::env::var_os("CRUCIBLE_TEST_DATA_DIR") {
        let path = PathBuf::from(path);
        if !path.is_absolute() {
            return Err("Verification data directory must be absolute".into());
        }
        fs::create_dir_all(&path).map_err(|e| e.to_string())?;
        return Ok(path);
    }
    let path = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    Ok(path)
}
pub fn valid_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > 100
        || !id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
    {
        return Err("Invalid record ID".into());
    }
    Ok(())
}
pub fn run_dir(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    valid_id(id)?;
    let dir = data_dir(app)?.join("runs").join(id);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

#[cfg(windows)]
fn protect(bytes: &[u8], decrypt: bool) -> Result<Vec<u8>, String> {
    #[repr(C)]
    struct Blob {
        len: u32,
        data: *mut u8,
    }
    #[link(name = "crypt32")]
    extern "system" {
        fn CryptProtectData(
            input: *const Blob,
            description: *const u16,
            entropy: *const Blob,
            reserved: *mut std::ffi::c_void,
            prompt: *mut std::ffi::c_void,
            flags: u32,
            output: *mut Blob,
        ) -> i32;
        fn CryptUnprotectData(
            input: *const Blob,
            description: *mut *mut u16,
            entropy: *const Blob,
            reserved: *mut std::ffi::c_void,
            prompt: *mut std::ffi::c_void,
            flags: u32,
            output: *mut Blob,
        ) -> i32;
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn LocalFree(memory: *mut std::ffi::c_void) -> *mut std::ffi::c_void;
    }
    let input = Blob {
        len: bytes
            .len()
            .try_into()
            .map_err(|_| "Credential data too large")?,
        data: bytes.as_ptr() as *mut u8,
    };
    let mut output = Blob {
        len: 0,
        data: std::ptr::null_mut(),
    };
    let result = unsafe {
        if decrypt {
            CryptUnprotectData(
                &input,
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                1,
                &mut output,
            )
        } else {
            CryptProtectData(
                &input,
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                1,
                &mut output,
            )
        }
    };
    if result == 0 {
        return Err(format!(
            "Windows credential protection failed: {}",
            std::io::Error::last_os_error()
        ));
    }
    let value = unsafe { std::slice::from_raw_parts(output.data, output.len as usize).to_vec() };
    unsafe {
        LocalFree(output.data.cast());
    }
    Ok(value)
}
#[cfg(not(windows))]
fn protect(_bytes: &[u8], _decrypt: bool) -> Result<Vec<u8>, String> {
    Err("This build's credential vault requires Windows.".into())
}

pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    let temp = path.with_file_name(format!(
        ".{}.{}.pending",
        path.file_name()
            .ok_or("Invalid file path")?
            .to_string_lossy(),
        nonce
    ));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)
        .map_err(|e| e.to_string())?;
    // Every failure past this point must take the half-written temp file with
    // it, or a failing disk quietly fills the data directory with `.pending`.
    let written = file
        .write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|e| e.to_string());
    drop(file);
    let replaced = written.and_then(|_| {
        #[cfg(windows)]
        {
            use std::os::windows::ffi::OsStrExt;
            #[link(name = "kernel32")]
            extern "system" {
                fn MoveFileExW(from: *const u16, to: *const u16, flags: u32) -> i32;
            }
            let from: Vec<_> = temp.as_os_str().encode_wide().chain(Some(0)).collect();
            let to: Vec<_> = path.as_os_str().encode_wide().chain(Some(0)).collect();
            if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), 1 | 8) } == 0 {
                return Err(std::io::Error::last_os_error().to_string());
            }
            Ok(())
        }
        #[cfg(not(windows))]
        fs::rename(&temp, path).map_err(|e| e.to_string())
    });
    if replaced.is_err() {
        let _ = fs::remove_file(&temp);
    }
    replaced
}
/// A store plus the reason its credentials could not be restored, if any.
struct Store {
    value: Value,
    vault_error: Option<String>,
}
fn unlock_vault(dir: &Path, vault: &str, value: &mut Value) -> Result<(), String> {
    valid_id(vault)?;
    let secret_bytes = protect(
        &fs::read(dir.join(format!("{vault}.bin"))).map_err(|e| e.to_string())?,
        true,
    )?;
    let secrets: Value = serde_json::from_slice(&secret_bytes).map_err(|e| e.to_string())?;
    value["settings"]["openRouter"]["apiKey"] = secrets["apiKey"].clone();
    if let Some(agents) = value["agents"].as_array_mut() {
        for agent in agents {
            let id = agent["id"].as_str().unwrap_or("").to_owned();
            agent["env"] = secrets["env"].get(&id).cloned().unwrap_or(json!({}));
        }
    }
    Ok(())
}
fn read_store(dir: &Path, file: &str) -> Result<Store, String> {
    let mut value: Value =
        serde_json::from_slice(&fs::read(dir.join(file)).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    validate_store(&value)?;
    let mut vault_error = None;
    if let Some(vault) = value
        .get("_vault")
        .and_then(Value::as_str)
        .map(str::to_owned)
    {
        // Secrets are a separate concern from the workspace. DPAPI cannot
        // decrypt a blob sealed under a different Windows profile, so treating
        // that as a load failure would present a re-enterable credential
        // problem as the loss of every project, task and run.
        if let Err(error) = unlock_vault(dir, &vault, &mut value) {
            value["settings"]["openRouter"]["apiKey"] = json!("");
            if let Some(agents) = value["agents"].as_array_mut() {
                for agent in agents {
                    agent["env"] = json!({});
                }
            }
            vault_error = Some(error);
        }
        value.as_object_mut().unwrap().remove("_vault");
    }
    Ok(Store { value, vault_error })
}
fn validate_store(value: &Value) -> Result<(), String> {
    if value["version"] != 7
        || !value["projects"].as_array().is_some_and(|p| {
            !p.is_empty()
                && p.iter()
                    .all(|p| p["layout"].as_array().is_some_and(|l| !l.is_empty()))
        })
        || !value["agents"].is_array()
        || !value["tasks"].is_array()
        || !value["usage"].is_array()
        || !value["settings"]["openRouter"].is_object()
    {
        return Err("The saved workspace is incomplete or uses an unsupported format.".into());
    }
    Ok(())
}
#[tauri::command]
pub async fn load_workspace(app: AppHandle, recovery: Option<bool>) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || load_workspace_inner(app, recovery))
        .await
        .map_err(|e| e.to_string())?
}
fn load_workspace_inner(app: AppHandle, recovery: Option<bool>) -> Result<Value, String> {
    let _lock = STORE_LOCK.lock().map_err(|_| "Storage is unavailable")?;
    let dir = data_dir(&app)?;
    if recovery == Some(true) {
        return read_store(&dir, "workspace.backup.json").map(|store| loaded(store, true, None));
    }
    if !dir.join("workspace.json").exists() {
        return Ok(json!({"workspace":null}));
    }
    match read_store(&dir, "workspace.json") {
        Ok(store) => Ok(loaded(store, false, None)),
        Err(error) => read_store(&dir, "workspace.backup.json")
            .map(|store| loaded(store, true, Some(error.clone())))
            .map_err(|_| format!("Could not open the saved workspace: {error}")),
    }
}
/// Shape the load result, keeping a credential problem separate from a
/// workspace problem so the UI can ask for a key instead of reporting data loss.
fn loaded(store: Store, recovered: bool, warning: Option<String>) -> Value {
    let mut result = json!({"workspace":store.value});
    let map = result.as_object_mut().unwrap();
    if recovered {
        map.insert("recovered".into(), json!(true));
    }
    if let Some(warning) = warning {
        map.insert("warning".into(), json!(warning));
    }
    if let Some(error) = store.vault_error {
        map.insert(
            "credentials".into(),
            json!(format!(
                "Saved credentials could not be unlocked, so they were cleared: {error}"
            )),
        );
    }
    result
}
#[tauri::command]
pub async fn save_workspace(app: AppHandle, workspace: Value) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || save_workspace_inner(app, workspace))
        .await
        .map_err(|e| e.to_string())?
}
fn save_workspace_inner(app: AppHandle, mut workspace: Value) -> Result<(), String> {
    let _lock = STORE_LOCK.lock().map_err(|_| "Storage is unavailable")?;
    validate_store(&workspace)?;
    let dir = data_dir(&app)?;
    // A repeated React save must not rotate away the recovery snapshot.
    if read_store(&dir, "workspace.json").is_ok_and(|saved| saved.value == workspace) {
        return Ok(());
    }
    let mut env = serde_json::Map::new();
    for agent in workspace["agents"].as_array_mut().unwrap() {
        let id = agent["id"].as_str().ok_or("Invalid agent ID")?.to_owned();
        env.insert(id, agent["env"].take());
        agent["env"] = json!({});
    }
    let secrets =
        json!({"apiKey": workspace["settings"]["openRouter"]["apiKey"].take(), "env":env});
    workspace["settings"]["openRouter"]["apiKey"] = json!("");
    let vault = format!(
        "vault-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_nanos()
    );
    atomic_write(
        &dir.join(format!("{vault}.bin")),
        &protect(
            &serde_json::to_vec(&secrets).map_err(|e| e.to_string())?,
            false,
        )?,
    )?;
    workspace["_vault"] = json!(vault);
    let old = if read_store(&dir, "workspace.json").is_ok() {
        fs::read(dir.join("workspace.json")).ok()
    } else {
        None
    };
    if let Some(ref old) = old {
        atomic_write(&dir.join("workspace.backup.json"), old)?;
    }
    atomic_write(
        &dir.join("workspace.json"),
        &serde_json::to_vec(&workspace).map_err(|e| e.to_string())?,
    )?;
    let previous_vault = fs::read(dir.join("workspace.backup.json"))
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .and_then(|v| v["_vault"].as_str().map(str::to_owned));
    // Only prune vault files created by this store, preserving both atomic snapshots.
    if let Ok(files) = fs::read_dir(&dir) {
        for file in files.flatten() {
            let name = file.file_name().to_string_lossy().to_string();
            if name.starts_with("vault-")
                && name.ends_with(".bin")
                && name != format!("{vault}.bin")
                && previous_vault
                    .as_ref()
                    .is_none_or(|v| name != format!("{v}.bin"))
            {
                let _ = fs::remove_file(file.path());
            }
        }
    }
    let mut retained = BTreeSet::new();
    for snapshot in [
        Some(workspace),
        fs::read(dir.join("workspace.backup.json"))
            .ok()
            .and_then(|b| serde_json::from_slice::<Value>(&b).ok()),
    ]
    .into_iter()
    .flatten()
    {
        if let Some(runs) = snapshot["usage"].as_array() {
            for run in runs {
                if let Some(id) = run["id"].as_str() {
                    retained.insert(id.to_owned());
                }
            }
        }
    }
    prune_runs(&dir, &retained);
    Ok(())
}

fn prune_runs(dir: &Path, retained: &BTreeSet<String>) {
    let root = dir.join("runs");
    let Ok(canonical_root) = fs::canonicalize(&root) else {
        return;
    };
    let Ok(entries) = fs::read_dir(&root) else {
        return;
    };
    for entry in entries.flatten() {
        let id = entry.file_name().to_string_lossy().into_owned();
        if !id.starts_with("run-") || valid_id(&id).is_err() || retained.contains(&id) {
            continue;
        }
        let Ok(meta) = entry.path().symlink_metadata() else {
            continue;
        };
        // Keep recent unindexed runs during asynchronous launch/restore. Never
        // follow links or delete anything outside this app's own run directory.
        if !meta.is_dir()
            || meta.file_type().is_symlink()
            || !meta
                .modified()
                .ok()
                .and_then(|t| t.elapsed().ok())
                .is_some_and(|age| age.as_secs() > 86400)
        {
            continue;
        }
        let Ok(path) = fs::canonicalize(entry.path()) else {
            continue;
        };
        if path.parent() == Some(canonical_root.as_path()) {
            let _ = fs::remove_dir_all(path);
        }
    }
}

pub fn command(program: &str) -> Command {
    let mut c = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x08000000);
    }
    c.stdin(Stdio::null());
    c
}
struct GitError {
    /// `None` when Git could not be run at all, so there is no exit status.
    status: Option<i32>,
    message: String,
}
fn git_output(cwd: &Path, args: &[&str]) -> Result<String, GitError> {
    let out = command("git")
        .current_dir(cwd)
        .args(args)
        .output()
        .map_err(|e| GitError {
            status: None,
            message: e.to_string(),
        })?;
    if !out.status.success() {
        return Err(GitError {
            status: out.status.code(),
            message: String::from_utf8_lossy(&out.stderr).trim().into(),
        });
    }
    let text = String::from_utf8_lossy(&out.stdout);
    Ok(if args.contains(&"-z") {
        text.into_owned()
    } else {
        text.trim().into()
    })
}
fn git(cwd: &Path, args: &[&str]) -> Result<String, String> {
    git_output(cwd, args).map_err(|e| e.message)
}
/// Git's own text, collapsed to one line and bounded so a large stderr cannot
/// bloat a stored review record.
fn git_detail(message: &str) -> String {
    let collapsed = message.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() <= GIT_DETAIL_LIMIT {
        return collapsed;
    }
    collapsed
        .chars()
        .take(GIT_DETAIL_LIMIT)
        .chain(Some('…'))
        .collect()
}
/// True when Git's refusal only means "there is no repository here". That is an
/// ordinary answer and keeps the generic notice; every other failure carries a
/// diagnostic the user needs.
fn git_missing_repo(detail: &str) -> bool {
    let lower = detail.to_lowercase();
    detail.is_empty()
        || lower.contains("not a git repository")
        || lower.contains("does not appear to be a git repository")
}
/// Git exits 128 both for "there is no repository here" and for refusals such
/// as `detected dubious ownership`, so only its message separates them. The
/// first case is ordinary and keeps the generic notice; anything else is a real
/// failure whose diagnostic has to survive into the review warnings.
fn git_capture_warning(status: Option<i32>, message: &str) -> Option<String> {
    let detail = git_detail(message);
    if git_missing_repo(&detail) {
        return None;
    }
    Some(if status.is_none() {
        format!("Git could not run in this project, so file review is unavailable: {detail}")
    } else {
        format!("Git could not read this project, so file review is unavailable: {detail}")
    })
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInfo {
    pub name: String,
    pub cwd: String,
    pub branch: Option<String>,
    pub dirty: bool,
    pub git: bool,
    /// Set when Git refused this folder for a reason other than "no repository
    /// here", so the header can say why instead of implying a plain folder.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub git_error: Option<String>,
}
#[tauri::command]
pub async fn project_info(cwd: String) -> Result<ProjectInfo, String> {
    tauri::async_runtime::spawn_blocking(move || project_info_inner(cwd))
        .await
        .map_err(|e| e.to_string())?
}
fn project_info_inner(cwd: String) -> Result<ProjectInfo, String> {
    let dir = fs::canonicalize(&cwd).map_err(|e| format!("Open a valid project folder: {e}"))?;
    if !dir.is_dir() {
        return Err("Choose a folder.".into());
    }
    let head = git_output(&dir, &["branch", "--show-current"]);
    let git_error = head.as_ref().err().and_then(|e| {
        let detail = git_detail(&e.message);
        (!git_missing_repo(&detail)).then(|| format!("Git could not read this project: {detail}"))
    });
    let branch = head.ok();
    let dirty = git(&dir, &["status", "--porcelain"]).is_ok_and(|s| !s.is_empty());
    Ok(ProjectInfo {
        name: dir.file_name().unwrap_or_default().to_string_lossy().into(),
        cwd,
        git: branch.is_some(),
        git_error,
        branch: branch.map(|s| {
            if s.is_empty() {
                "Detached HEAD".into()
            } else {
                s
            }
        }),
        dirty,
    })
}
#[tauri::command]
pub async fn check_agent(program: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = which::which(&program).map_err(|_| {
            format!("{program} was not found on PATH. Install the CLI, then restart Crucible.")
        })?;
        let (exe, prefix) = crate::resolve_command(&program);
        let mut child = command(&exe)
            .args(prefix)
            .arg("--version")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| e.to_string())?;
        let start = std::time::Instant::now();
        loop {
            if child.try_wait().map_err(|e| e.to_string())?.is_some() {
                break;
            }
            if start.elapsed().as_secs() >= 3 {
                let _ = child.kill();
                let _ = child.wait();
                return Ok(json!({"path":path,"version":"Installed; version check timed out"}));
            }
            std::thread::sleep(std::time::Duration::from_millis(40));
        }
        let output = child.wait_with_output().map_err(|e| e.to_string())?;
        let text = String::from_utf8_lossy(&output.stdout)
            .chars()
            .take(300)
            .collect::<String>();
        Ok(json!({"path":path,"version":text.trim()}))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Default, Serialize, Deserialize)]
pub struct Snapshot {
    cwd: String,
    files: BTreeMap<String, String>,
    skipped: Vec<String>,
    git: bool,
    /// Set when this folder looks non-Git only because Git refused or failed;
    /// absent for an ordinary folder that simply has no repository. Defaulted so
    /// baselines recorded before this field still load.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    git_error: Option<String>,
}
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    path: String,
    status: String,
    diff: String,
}
#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Review {
    files: Vec<FileChange>,
    warnings: Vec<String>,
    git: bool,
}
fn capture(cwd: &str) -> Snapshot {
    let dir = Path::new(cwd);
    let mut snapshot = Snapshot {
        cwd: cwd.into(),
        ..Default::default()
    };
    let list = match git_output(
        dir,
        &[
            "ls-files",
            "-z",
            "--cached",
            "--others",
            "--exclude-standard",
        ],
    ) {
        Ok(list) => list,
        Err(error) => {
            snapshot.git_error = git_capture_warning(error.status, &error.message);
            return snapshot;
        }
    };
    snapshot.git = true;
    let canonical = fs::canonicalize(dir).ok();
    let mut size = 0;
    for path in list
        .split('\0')
        .filter(|s| !s.is_empty())
        .collect::<BTreeSet<_>>()
    {
        let full = dir.join(path);
        if fs::symlink_metadata(&full).is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound) {
            continue;
        }
        let safe = fs::canonicalize(&full)
            .ok()
            .zip(canonical.as_ref())
            .is_some_and(|(p, root)| p.starts_with(root));
        if !safe
            || fs::metadata(&full)
                .map(|m| m.len() > FILE_LIMIT)
                .unwrap_or(true)
        {
            snapshot.skipped.push(path.into());
            continue;
        }
        match fs::read_to_string(&full) {
            Ok(content) if !content.contains('\0') && size + content.len() <= SNAPSHOT_LIMIT => {
                size += content.len();
                snapshot.files.insert(path.into(), content);
            }
            _ => snapshot.skipped.push(path.into()),
        }
    }
    snapshot
}
pub fn begin_run(app: &AppHandle, run_id: &str, cwd: &str) -> Result<PathBuf, String> {
    let dir = run_dir(app, run_id)?;
    atomic_write(
        &dir.join("baseline.json"),
        &serde_json::to_vec(&capture(cwd)).map_err(|e| e.to_string())?,
    )?;
    fs::File::create(dir.join("output.log")).map_err(|e| e.to_string())?;
    Ok(dir)
}
pub fn finish_run(dir: &Path) -> Result<Review, String> {
    let _lock = REVIEW_LOCK
        .lock()
        .map_err(|_| "File review is unavailable")?;
    let baseline: Snapshot =
        serde_json::from_slice(&fs::read(dir.join("baseline.json")).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    let current = capture(&baseline.cwd);
    let mut review = Review {
        git: baseline.git,
        ..Default::default()
    };
    if !baseline.git {
        // A refusal is not the same as a plain non-Git folder: keep Git's reason.
        review
            .warnings
            .push(baseline.git_error.clone().unwrap_or_else(|| {
                "File review is available for Git projects. The terminal output is still saved."
                    .into()
            }));
    }
    let skipped: BTreeSet<_> = baseline
        .skipped
        .iter()
        .chain(current.skipped.iter())
        .collect();
    if !skipped.is_empty() {
        review.warnings.push(format!("{} binary, large, or inaccessible files were not compared. Snapshot budget: 16 MiB, 1 MiB per file.", skipped.len()));
    }
    if baseline.git && !current.git {
        review
            .warnings
            .push(current.git_error.clone().unwrap_or_else(|| {
                "The project is no longer accessible. File changes could not be captured.".into()
            }));
    }
    if baseline.git && current.git {
        let files: BTreeSet<_> = baseline.files.keys().chain(current.files.keys()).collect();
        for path in files {
            if skipped.contains(path) {
                continue;
            }
            let before = baseline.files.get(path);
            let after = current.files.get(path);
            if before == after {
                continue;
            }
            let status = if before.is_none() {
                "added"
            } else if after.is_none() {
                "deleted"
            } else {
                "modified"
            };
            let a = dir.join("before.txt");
            let b = dir.join("after.txt");
            fs::write(&a, before.map(String::as_str).unwrap_or("")).map_err(|e| e.to_string())?;
            fs::write(&b, after.map(String::as_str).unwrap_or("")).map_err(|e| e.to_string())?;
            let diff = command("git")
                .args(["diff", "--no-index", "--no-color", "--no-ext-diff", "--"])
                .arg(&a)
                .arg(&b)
                .output()
                .map_err(|e| e.to_string())?;
            // `git diff --no-index` exits 1 when the files differ; any other
            // code means the diff itself failed, so don't store a silent blank.
            let text = if matches!(diff.status.code(), Some(0 | 1)) {
                String::from_utf8_lossy(&diff.stdout)
                    .lines()
                    .skip(4)
                    .collect::<Vec<_>>()
                    .join("\n")
            } else {
                let detail = git_detail(&String::from_utf8_lossy(&diff.stderr));
                let warning = if detail.is_empty() {
                    "Git could not produce diffs for this run.".into()
                } else {
                    format!("Git could not produce diffs for this run: {detail}")
                };
                if !review.warnings.contains(&warning) {
                    review.warnings.push(warning);
                }
                String::new()
            };
            review.files.push(FileChange {
                path: path.clone(),
                status: status.into(),
                diff: format!("--- a/{path}\n+++ b/{path}\n{text}"),
            });
        }
    }
    atomic_write(
        &dir.join("review.json"),
        &serde_json::to_vec(&review).map_err(|e| e.to_string())?,
    )?;
    Ok(review)
}
#[tauri::command]
pub async fn read_run(
    app: AppHandle,
    run_id: String,
    refresh: Option<bool>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = run_dir(&app, &run_id)?;
        if !dir.join("baseline.json").exists() {return Err("Saved output is unavailable on this device. This run may predate recording or come from a portable backup.".into());}
        let log = fs::read(dir.join("output.log")).unwrap_or_default();
        let review = if refresh == Some(true) || !dir.join("review.json").exists() { finish_run(&dir)? } else { serde_json::from_slice(&fs::read(dir.join("review.json")).map_err(|e| e.to_string())?).map_err(|e| e.to_string())? };
        Ok(json!({"output":String::from_utf8_lossy(&log),"truncated":log.len() as u64 >= LOG_LIMIT,"review":review}))
    }).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn create_worktree(
    app: AppHandle,
    cwd: String,
    task_id: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        valid_id(&task_id)?;
        let root = data_dir(&app)?.join("worktrees");
        fs::create_dir_all(&root).map_err(|e| e.to_string())?;
        let target = root.join(&task_id);
        if target.exists() {
            return Err(
                "A worktree already exists for this task. Choose it explicitly or use a new task."
                    .into(),
            );
        }
        let branch = format!("codex/{task_id}");
        git(
            Path::new(&cwd),
            &[
                "worktree",
                "add",
                "-b",
                &branch,
                &target.to_string_lossy(),
                "HEAD",
            ],
        )?;
        Ok(target.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Files a teammate run's folder may hold; nothing else is read or removed.
const TEAMMATE_FILES: [&str; 3] = ["memory.md", "inbox.md", "outbox.md"];
/// Seeding and removing run folders hold this, so removing an empty
/// `.crucible` can never race another run creating its folder inside it.
static TEAMMATE_LOCK: Mutex<()> = Mutex::new(());

/// A teammate run's own folder, `<cwd>/.crucible/<folder>`. Only a bare
/// `[a-z0-9-]` name is accepted, so the path cannot leave `.crucible`.
fn teammate_dir(cwd: &str, folder: &str) -> Result<PathBuf, String> {
    let valid = !folder.is_empty()
        && folder.len() <= 80
        && !folder.starts_with('-')
        && folder
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-');
    if !valid {
        return Err("Invalid teammate folder name".into());
    }
    let dir = Path::new(cwd);
    if !dir.is_dir() {
        return Err("The run's folder does not exist.".into());
    }
    Ok(dir.join(".crucible").join(folder))
}
/// The folder exists and resolves inside the run's folder: a `.crucible` link
/// pointing elsewhere must not redirect a write, a read or a removal.
fn inside(dir: &Path, cwd: &str) -> bool {
    fs::canonicalize(dir)
        .ok()
        .zip(fs::canonicalize(cwd).ok())
        .is_some_and(|(d, root)| d.starts_with(root))
}
/// Keep `.crucible/` out of Git by adding it to the repository's
/// `info/exclude` once. From a linked worktree Git names the shared file, so
/// every worktree of the repository is covered. Not a repository: nothing to do.
fn exclude_crucible(cwd: &Path) {
    let Ok(path) = git(cwd, &["rev-parse", "--git-path", "info/exclude"]) else {
        return;
    };
    let path = PathBuf::from(path);
    let path = if path.is_absolute() {
        path
    } else {
        cwd.join(path)
    };
    let existing = fs::read_to_string(&path).unwrap_or_default();
    if existing.lines().any(|line| {
        matches!(
            line.trim(),
            ".crucible/" | ".crucible" | "/.crucible/" | "/.crucible"
        )
    }) {
        return;
    }
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let mut text = existing;
    if !text.is_empty() && !text.ends_with('\n') {
        text.push('\n');
    }
    text.push_str(".crucible/\n");
    let _ = fs::write(&path, text);
}
fn seed_teammate_run_inner(
    cwd: &str,
    folder: &str,
    memory: &str,
    inbox: Option<&str>,
    outbox: bool,
) -> Result<String, String> {
    let dir = teammate_dir(cwd, folder)?;
    exclude_crucible(Path::new(cwd));
    let _lock = TEAMMATE_LOCK
        .lock()
        .map_err(|_| "Teammate files are unavailable")?;
    // Check `.crucible` before creating anything inside it, then the folder.
    for path in [dir.parent().ok_or("Invalid teammate folder")?, &dir] {
        fs::create_dir_all(path).map_err(|e| e.to_string())?;
        if !inside(path, cwd) {
            return Err("The teammate folder resolves outside the run's folder.".into());
        }
    }
    atomic_write(&dir.join("memory.md"), memory.as_bytes())?;
    if let Some(inbox) = inbox {
        atomic_write(&dir.join("inbox.md"), inbox.as_bytes())?;
    }
    if outbox {
        atomic_write(&dir.join("outbox.md"), b"")?;
    }
    Ok(format!(".crucible/{folder}"))
}
#[derive(Serialize, Debug, Default, PartialEq)]
pub struct TeammateFiles {
    memory: Option<String>,
    outbox: Option<String>,
}
fn read_capped(path: &Path) -> Result<Option<String>, String> {
    let Ok(handle) = fs::File::open(path) else {
        return Ok(None);
    };
    let mut bytes = Vec::new();
    handle
        .take(TEAMMATE_READ_LIMIT)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    Ok(Some(String::from_utf8_lossy(&bytes).into_owned()))
}
fn collect_teammate_run_inner(
    cwd: &str,
    folder: &str,
    remove: bool,
) -> Result<TeammateFiles, String> {
    let dir = teammate_dir(cwd, folder)?;
    if !dir.is_dir() {
        return Ok(TeammateFiles::default());
    }
    if !inside(&dir, cwd) {
        return Err("The teammate folder resolves outside the run's folder.".into());
    }
    let files = TeammateFiles {
        memory: read_capped(&dir.join("memory.md"))?,
        outbox: read_capped(&dir.join("outbox.md"))?,
    };
    if remove {
        let _lock = TEAMMATE_LOCK
            .lock()
            .map_err(|_| "Teammate files are unavailable")?;
        for name in TEAMMATE_FILES {
            let _ = fs::remove_file(dir.join(name));
        }
        // Only empty folders go: anything else the teammate left stays put.
        let _ = fs::remove_dir(&dir);
        if let Some(parent) = dir.parent() {
            let _ = fs::remove_dir(parent);
        }
    }
    Ok(files)
}
/// Set up a teammate run's folder before it starts: its memory, the messages
/// delivered to it and an empty outbox. Returns the folder relative to `cwd`,
/// which is what the prompt names.
#[tauri::command]
pub async fn seed_teammate_run(
    cwd: String,
    folder: String,
    memory: String,
    inbox: Option<String>,
    outbox: bool,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        seed_teammate_run_inner(&cwd, &folder, &memory, inbox.as_deref(), outbox)
    })
    .await
    .map_err(|e| e.to_string())?
}
/// Read a teammate run's memory and outbox back (`None` for a missing file);
/// with `remove`, once the run is over, the folder is cleaned up.
#[tauri::command]
pub async fn collect_teammate_run(
    cwd: String,
    folder: String,
    remove: bool,
) -> Result<TeammateFiles, String> {
    tauri::async_runtime::spawn_blocking(move || collect_teammate_run_inner(&cwd, &folder, remove))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn export_backup(app: AppHandle, contents: String) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let _: Value = serde_json::from_str(&contents).map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let Some(file) = app
            .dialog()
            .file()
            .add_filter("Crucible backup", &["json"])
            .set_file_name("crucible-backup.json")
            .blocking_save_file()
        else {
            return Ok(None);
        };
        let path = file.into_path().map_err(|e| e.to_string())?;
        atomic_write(&path, contents.as_bytes())?;
        Ok(Some(path.to_string_lossy().into_owned()))
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn import_backup(app: AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    tauri::async_runtime::spawn_blocking(move || {
        let Some(file) = app
            .dialog()
            .file()
            .add_filter("Crucible backup", &["json"])
            .blocking_pick_file()
        else {
            return Ok(None);
        };
        let path = file.into_path().map_err(|e| e.to_string())?;
        if fs::metadata(&path).map_err(|e| e.to_string())?.len() > 32 * 1024 * 1024 {
            return Err("Backup is larger than 32 MiB.".into());
        }
        fs::read_to_string(path)
            .map(Some)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub fn save_window_state(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        let maximized = window.is_maximized().unwrap_or(false);
        let old = fs::read(data_dir(&app)?.join("window.json"))
            .ok()
            .and_then(|s| serde_json::from_slice::<Value>(&s).ok())
            .unwrap_or(json!({}));
        let value = if maximized {
            json!({"maximized":true,"width":old["width"],"height":old["height"],"x":old["x"],"y":old["y"]})
        } else {
            let size = window.inner_size().map_err(|e| e.to_string())?;
            let pos = window.outer_position().map_err(|e| e.to_string())?;
            json!({"maximized":false,"width":size.width,"height":size.height,"x":pos.x,"y":pos.y})
        };
        atomic_write(
            &data_dir(&app)?.join("window.json"),
            &serde_json::to_vec(&value).unwrap(),
        )?;
    }
    Ok(())
}
pub fn restore_window(app: &AppHandle) {
    let Ok(dir) = data_dir(app) else { return };
    let Ok(bytes) = fs::read(dir.join("window.json")) else {
        return;
    };
    let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
        return;
    };
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let width = value["width"].as_u64().unwrap_or(1280).clamp(900, 5000) as u32;
    let height = value["height"].as_u64().unwrap_or(820).clamp(600, 3000) as u32;
    let x = value["x"].as_i64().unwrap_or(100) as i32;
    let y = value["y"].as_i64().unwrap_or(100) as i32;
    if window
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .any(|m| {
            x >= m.position().x
                && y >= m.position().y
                && x + 100 < m.position().x + m.size().width as i32
                && y + 60 < m.position().y + m.size().height as i32
        })
    {
        let _ = window.set_size(tauri::PhysicalSize::new(width, height));
        let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
    }
    if value["maximized"] == true {
        let _ = window.maximize();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_path_traversal() {
        for bad in ["../outside", "", "a/b", "a\\b", "x:foo"] {
            assert!(valid_id(bad).is_err());
        }
        assert!(valid_id("run-1234-abcd").is_ok());
    }
    #[cfg(windows)]
    #[test]
    fn credentials_roundtrip_and_reject_corruption() {
        let plaintext = b"private-test-value";
        let encrypted = protect(plaintext, false).unwrap();
        assert_ne!(&encrypted, plaintext);
        assert_eq!(protect(&encrypted, true).unwrap(), plaintext);
        assert!(protect(b"invalid ciphertext", true).is_err());
    }
    fn fixture() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "crucible-review-test-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }
    #[test]
    fn atomic_replace_and_corruption_recovery_input() {
        let dir = fixture();
        let file = dir.join("record.json");
        atomic_write(&file, b"first").unwrap();
        atomic_write(&file, b"second").unwrap();
        assert_eq!(fs::read(&file).unwrap(), b"second");
        assert_eq!(pending_files(&dir), 0, "a successful write leaves no temp");
        // The real temp is `.record.json.<nonce>.pending`, so a failing write
        // has to be observed by scanning the directory.
        assert!(atomic_write(&dir.join("missing-dir").join("record.json"), b"x").is_err());
        assert_eq!(pending_files(&dir), 0, "a failed write cleans up its temp");
        fs::write(dir.join("workspace.json"), b"not json").unwrap();
        assert!(read_store(&dir, "workspace.json").is_err());
    }
    fn pending_files(dir: &Path) -> usize {
        fs::read_dir(dir)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|e| e.file_name().to_string_lossy().ends_with(".pending"))
            .count()
    }
    /// A structurally valid v7 store, so tests can focus on one concern each.
    fn store_value() -> Value {
        json!({
            "version": 7,
            "projects": [{"id":"project-1","layout":[{"id":"col-1","size":1,
                "panes":[{"id":"pane-1","size":1}]}]}],
            "agents": [{"id":"codex","env":{"TOKEN":"plain-token"}}],
            "tasks": [],
            "usage": [],
            "settings": {"openRouter":{"apiKey":"plain-key"}}
        })
    }
    #[cfg(windows)]
    #[test]
    fn vault_store_roundtrip_keeps_secrets_off_disk_and_survives_a_locked_vault() {
        let dir = fixture();
        let mut workspace = store_value();
        let secrets = json!({"apiKey":"plain-key","env":{"codex":{"TOKEN":"plain-token"}}});
        atomic_write(
            &dir.join("vault-1.bin"),
            &protect(&serde_json::to_vec(&secrets).unwrap(), false).unwrap(),
        )
        .unwrap();
        workspace["settings"]["openRouter"]["apiKey"] = json!("");
        workspace["agents"][0]["env"] = json!({});
        workspace["_vault"] = json!("vault-1");
        atomic_write(
            &dir.join("workspace.json"),
            &serde_json::to_vec(&workspace).unwrap(),
        )
        .unwrap();

        // Nothing secret may sit in the plaintext store.
        let raw = String::from_utf8(fs::read(dir.join("workspace.json")).unwrap()).unwrap();
        assert!(!raw.contains("plain-key") && !raw.contains("plain-token"));

        // Reading re-inlines the secrets against the right agent and hides the pointer.
        let store = read_store(&dir, "workspace.json").unwrap();
        assert_eq!(store.vault_error, None);
        assert_eq!(store.value["settings"]["openRouter"]["apiKey"], "plain-key");
        assert_eq!(store.value["agents"][0]["env"]["TOKEN"], "plain-token");
        assert!(store.value.get("_vault").is_none());

        // A blob sealed by another Windows profile is a credential problem, not
        // the loss of every project: the workspace still loads, secrets cleared.
        for broken in [Some(b"sealed by another profile".to_vec()), None] {
            match broken {
                Some(bytes) => fs::write(dir.join("vault-1.bin"), bytes).unwrap(),
                None => fs::remove_file(dir.join("vault-1.bin")).unwrap(),
            }
            let store = read_store(&dir, "workspace.json").unwrap();
            assert!(store.vault_error.is_some());
            assert_eq!(store.value["settings"]["openRouter"]["apiKey"], "");
            assert_eq!(store.value["agents"][0]["env"], json!({}));
            assert_eq!(store.value["projects"][0]["id"], "project-1");
            let result = loaded(store, false, None);
            assert!(result["credentials"].as_str().unwrap().contains("cleared"));
            assert!(result["workspace"]["projects"].is_array());
        }
    }
    #[test]
    fn validate_store_rejects_unusable_shapes() {
        assert!(validate_store(&store_value()).is_ok());
        for (field, value) in [
            ("version", json!(8)),
            ("projects", json!([])),
            ("agents", json!({})),
            ("tasks", json!(null)),
            ("usage", json!("none")),
        ] {
            let mut broken = store_value();
            broken[field] = value;
            assert!(validate_store(&broken).is_err(), "{field} must be rejected");
        }
        let mut empty_layout = store_value();
        empty_layout["projects"][0]["layout"] = json!([]);
        assert!(validate_store(&empty_layout).is_err());
    }
    #[test]
    fn review_compares_launch_baseline_including_deletions_and_new_files() {
        let dir = fixture();
        git(&dir, &["init", "-q"]).unwrap();
        fs::write(dir.join("existing.txt"), "committed\n").unwrap();
        fs::write(dir.join("deleted.txt"), "delete me\n").unwrap();
        git(&dir, &["add", "."]).unwrap();
        git(
            &dir,
            &[
                "-c",
                "user.name=Crucible Test",
                "-c",
                "user.email=test@example.invalid",
                "commit",
                "-qm",
                "fixture",
            ],
        )
        .unwrap();
        fs::write(dir.join("existing.txt"), "uncommitted baseline\n").unwrap();
        let run = fixture();
        atomic_write(
            &run.join("baseline.json"),
            &serde_json::to_vec(&capture(dir.to_str().unwrap())).unwrap(),
        )
        .unwrap();
        fs::write(dir.join("existing.txt"), "agent result\n").unwrap();
        fs::remove_file(dir.join("deleted.txt")).unwrap();
        fs::write(dir.join("new.txt"), "new file\n").unwrap();
        let review = finish_run(&run).unwrap();
        assert_eq!(review.files.len(), 3);
        assert!(review
            .files
            .iter()
            .any(|f| f.path == "deleted.txt" && f.status == "deleted"));
        let changed = review
            .files
            .iter()
            .find(|f| f.path == "existing.txt")
            .unwrap();
        assert!(changed.diff.contains("-uncommitted baseline"));
        assert!(changed.diff.contains("+agent result"));
        assert!(!changed.diff.contains("-committed"));
    }
    #[test]
    fn git_access_failure_keeps_its_diagnostic_in_review_warnings() {
        // An ordinary folder with no repository keeps the generic notice.
        assert_eq!(
            git_capture_warning(
                Some(128),
                "fatal: not a git repository (or any of the parent directories): .git"
            ),
            None
        );
        let ownership = "fatal: detected dubious ownership in repository at 'C:/fixture/project'\n'C:/fixture/project' is owned by:\n\tS-1-5-21-1\nbut the current user is:\n\tS-1-5-21-2\nTo add an exception for this directory, call:\n\n\tgit config --global --add safe.directory C:/fixture/project";
        let warning = git_capture_warning(Some(128), ownership).unwrap();
        assert!(warning.contains("detected dubious ownership"));
        assert!(warning.contains("C:/fixture/project"));
        assert!(!warning.contains("available for Git projects"));
        assert!(!warning.contains('\n'));
        assert!(
            git_capture_warning(Some(128), "fatal: cannot access '.git': Permission denied")
                .unwrap()
                .contains("Permission denied")
        );
        // Git that cannot even start has no status but still has a reason.
        assert!(git_capture_warning(None, "program not found")
            .unwrap()
            .contains("program not found"));
        // A huge stderr cannot bloat the stored record.
        let bounded =
            git_capture_warning(Some(128), &"fatal: detected dubious ownership ".repeat(200))
                .unwrap();
        assert!(bounded.chars().count() < GIT_DETAIL_LIMIT + 120);
        assert!(bounded.ends_with('…'));
        // Baselines recorded before this field still load.
        let old: Snapshot =
            serde_json::from_str(r#"{"cwd":"x","files":{},"skipped":[],"git":false}"#).unwrap();
        assert_eq!(old.git_error, None);
        // The diagnostic reaches the review the frontend reads.
        let run = fixture();
        atomic_write(
            &run.join("baseline.json"),
            &serde_json::to_vec(&Snapshot {
                cwd: fixture().to_string_lossy().into_owned(),
                git_error: Some(warning.clone()),
                ..Default::default()
            })
            .unwrap(),
        )
        .unwrap();
        let review = finish_run(&run).unwrap();
        assert!(!review.git);
        assert_eq!(review.warnings, vec![warning]);
    }
    #[test]
    fn review_skips_binary_and_ignored_files() {
        let dir = fixture();
        git(&dir, &["init", "-q"]).unwrap();
        fs::write(dir.join(".gitignore"), "ignored.txt\n").unwrap();
        fs::write(dir.join("ignored.txt"), "private").unwrap();
        fs::write(dir.join("binary.dat"), [0, 255, 0]).unwrap();
        let s = capture(dir.to_str().unwrap());
        assert!(!s.files.contains_key("ignored.txt"));
        assert!(s.skipped.contains(&"binary.dat".to_string()));
    }
    #[test]
    fn isolated_worktree_starts_from_commit_and_preserves_working_changes() {
        let dir = fixture();
        git(&dir, &["init", "-q"]).unwrap();
        fs::write(dir.join("file.txt"), "committed").unwrap();
        git(&dir, &["add", "."]).unwrap();
        git(
            &dir,
            &[
                "-c",
                "user.name=Crucible Test",
                "-c",
                "user.email=test@example.invalid",
                "commit",
                "-qm",
                "fixture",
            ],
        )
        .unwrap();
        fs::write(dir.join("file.txt"), "local changes").unwrap();
        let target = fixture().join("isolated");
        git(
            &dir,
            &[
                "worktree",
                "add",
                "-b",
                "codex/test",
                target.to_str().unwrap(),
                "HEAD",
            ],
        )
        .unwrap();
        assert_eq!(
            fs::read_to_string(target.join("file.txt")).unwrap(),
            "committed"
        );
        assert_eq!(
            fs::read_to_string(dir.join("file.txt")).unwrap(),
            "local changes"
        );
    }

    fn init_repo(dir: &Path) {
        git(dir, &["init", "-q"]).unwrap();
        fs::write(dir.join("file.txt"), "committed").unwrap();
        git(dir, &["add", "."]).unwrap();
        git(
            dir,
            &[
                "-c",
                "user.name=Crucible Test",
                "-c",
                "user.email=test@example.invalid",
                "commit",
                "-qm",
                "fixture",
            ],
        )
        .unwrap();
    }
    fn exclude_lines(dir: &Path) -> usize {
        let path = PathBuf::from(git(dir, &["rev-parse", "--git-path", "info/exclude"]).unwrap());
        let path = if path.is_absolute() {
            path
        } else {
            dir.join(path)
        };
        fs::read_to_string(path)
            .unwrap_or_default()
            .lines()
            .filter(|l| l.trim() == ".crucible/")
            .count()
    }
    fn files(memory: Option<&str>, outbox: Option<&str>) -> TeammateFiles {
        TeammateFiles {
            memory: memory.map(String::from),
            outbox: outbox.map(String::from),
        }
    }
    #[test]
    fn teammate_folder_names_cannot_leave_the_crucible_folder() {
        let dir = fixture();
        let cwd = dir.to_str().unwrap();
        for bad in [
            "", "-a", "A", "a b", "..", "../a", "a/b", "a\\b", "a.md", "a_b", "a\0",
        ] {
            assert!(teammate_dir(cwd, bad).is_err(), "{bad:?} must be refused");
        }
        assert!(teammate_dir(cwd, &"a".repeat(81)).is_err());
        assert!(teammate_dir(cwd, "front-end-ab12cd34").is_ok());
        assert!(teammate_dir(dir.join("missing").to_str().unwrap(), "a").is_err());
    }
    #[test]
    fn a_teammate_run_round_trips_stays_out_of_git_and_is_removed_after() {
        let dir = fixture();
        init_repo(&dir);
        let cwd = dir.to_str().unwrap();
        assert_eq!(
            collect_teammate_run_inner(cwd, "ada-1", false).unwrap(),
            files(None, None)
        );
        let path =
            seed_teammate_run_inner(cwd, "ada-1", "- pnpm\n", Some("# Inbox"), true).unwrap();
        assert_eq!(path, ".crucible/ada-1");
        let folder = dir.join(".crucible").join("ada-1");
        assert_eq!(
            fs::read_to_string(folder.join("inbox.md")).unwrap(),
            "# Inbox"
        );
        assert_eq!(fs::read_to_string(folder.join("outbox.md")).unwrap(), "");
        // A second run of the same teammate has its own folder.
        seed_teammate_run_inner(cwd, "ada-2", "- pnpm\n", None, false).unwrap();
        assert!(!dir.join(".crucible/ada-2/inbox.md").exists());
        assert!(!dir.join(".crucible/ada-2/outbox.md").exists());
        fs::write(folder.join("memory.md"), "- pnpm\n- vitest\n").unwrap();
        fs::write(folder.join("outbox.md"), "## To: Ben\nhello").unwrap();
        assert_eq!(exclude_lines(&dir), 1, "the exclude line is written once");
        assert_eq!(git(&dir, &["status", "--porcelain"]).unwrap(), "");
        let listed = git(&dir, &["ls-files", "--others", "--exclude-standard"]).unwrap();
        assert!(!listed.contains(".crucible"), "run snapshots never see it");
        // Reading mid-run leaves everything in place.
        let read = collect_teammate_run_inner(cwd, "ada-1", false).unwrap();
        assert_eq!(
            read,
            files(Some("- pnpm\n- vitest\n"), Some("## To: Ben\nhello"))
        );
        assert!(folder.join("outbox.md").exists());
        // After the run its folder goes; the other run's stays, so `.crucible` does too.
        assert_eq!(
            collect_teammate_run_inner(cwd, "ada-1", true).unwrap(),
            read
        );
        assert!(!folder.exists());
        assert!(dir.join(".crucible/ada-2/memory.md").exists());
        collect_teammate_run_inner(cwd, "ada-2", true).unwrap();
        assert!(
            !dir.join(".crucible").exists(),
            "an empty .crucible goes too"
        );
    }
    #[test]
    fn removal_keeps_files_the_teammate_added() {
        let dir = fixture();
        let cwd = dir.to_str().unwrap();
        seed_teammate_run_inner(cwd, "ada-1", "note", None, true).unwrap();
        let folder = dir.join(".crucible/ada-1");
        fs::write(folder.join("scratch.txt"), "mine").unwrap();
        collect_teammate_run_inner(cwd, "ada-1", true).unwrap();
        assert!(!folder.join("memory.md").exists());
        assert!(!folder.join("outbox.md").exists());
        assert_eq!(
            fs::read_to_string(folder.join("scratch.txt")).unwrap(),
            "mine"
        );
    }
    #[test]
    fn a_teammate_run_in_a_worktree_is_excluded_for_the_whole_repository() {
        let dir = fixture();
        init_repo(&dir);
        let target = fixture().join("lane");
        git(
            &dir,
            &[
                "worktree",
                "add",
                "-b",
                "codex/lane",
                target.to_str().unwrap(),
                "HEAD",
            ],
        )
        .unwrap();
        seed_teammate_run_inner(target.to_str().unwrap(), "ada-1", "note", None, true).unwrap();
        seed_teammate_run_inner(dir.to_str().unwrap(), "ada-2", "note", None, true).unwrap();
        assert_eq!(exclude_lines(&dir), 1);
        assert_eq!(git(&target, &["status", "--porcelain"]).unwrap(), "");
        assert_eq!(git(&dir, &["status", "--porcelain"]).unwrap(), "");
    }
    #[test]
    fn a_teammate_run_outside_a_repository_still_round_trips() {
        let dir = fixture();
        let cwd = dir.to_str().unwrap();
        seed_teammate_run_inner(cwd, "ada-1", "note", None, false).unwrap();
        assert_eq!(
            collect_teammate_run_inner(cwd, "ada-1", true).unwrap(),
            files(Some("note"), None)
        );
    }
}
