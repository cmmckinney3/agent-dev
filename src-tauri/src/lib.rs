mod desktop;
// Crucible backend: runs interactive CLI agents (Claude Code, Codex) inside
// pseudo-terminals and streams their I/O to the frontend.

use std::collections::{HashMap, HashSet};
use std::fs::OpenOptions;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};

use base64::Engine;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

/// A single running agent: its PTY master (for resize), a writer for input,
/// and the child process handle (for termination). `epoch` uniquely tags this
/// spawn so a stale reader thread can't report an exit for a session that has
/// already been replaced (e.g. on Restart).
struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn portable_pty::ChildKiller + Send + Sync>,
    epoch: u64,
}

#[derive(Default)]
struct AppState {
    sessions: Arc<Mutex<HashMap<String, PtySession>>>,
    spawning: Arc<Mutex<HashSet<String>>>,
    readers: Arc<(Mutex<usize>, Condvar)>,
    next_epoch: AtomicU64,
}

struct SpawnGuard {
    ids: Arc<Mutex<HashSet<String>>>,
    id: String,
}
impl Drop for SpawnGuard {
    fn drop(&mut self) {
        if let Ok(mut ids) = self.ids.lock() {
            ids.remove(&self.id);
        }
    }
}

#[derive(Clone, Serialize)]
struct OutputEvent {
    id: String,
    /// PTY bytes, base64-encoded so binary/ANSI data survives the JSON bridge.
    data: String,
    run_id: String,
}

#[derive(Clone, Serialize)]
struct ExitEvent {
    id: String,
    /// Process exit code, when the child could be reaped (None if unknown).
    /// Lets the frontend distinguish a clean headless completion from a crash.
    code: Option<u32>,
    run_id: String,
}
#[derive(Clone, Serialize)]
struct SavedEvent {
    id: String,
    run_id: String,
    error: Option<String>,
}

/// Resolve a program name to an executable. On Windows, npm-style `.cmd` shims
/// (e.g. `codex.cmd`) are launched as the script they wrap; any other `.cmd`/`.bat`
/// has to go through `cmd.exe /c`.
fn resolve_command(program: &str) -> (String, Vec<String>) {
    match which::which(program) {
        Ok(path) => {
            let resolved = path.to_string_lossy().to_string();
            let lower = resolved.to_lowercase();
            if lower.ends_with(".cmd") || lower.ends_with(".bat") {
                npm_shim_command(&path)
                    .unwrap_or_else(|| ("cmd.exe".to_string(), vec!["/c".to_string(), resolved]))
            } else {
                (resolved, Vec::new())
            }
        }
        Err(_) => (program.to_string(), Vec::new()),
    }
}

/// The script an npm cmd-shim forwards `%*` to, relative to the shim's folder:
/// the last `"%dp0%\…"` (or legacy `"%~dp0\…"`) path on a line ending in `%*`.
fn npm_shim_target(shim: &str) -> Option<String> {
    let line = shim.lines().rev().find(|l| l.trim_end().ends_with("%*"))?;
    let (_, rest) = ["\"%dp0%\\", "\"%~dp0\\"]
        .iter()
        .filter_map(|marker| line.rfind(marker).map(|i| (i, &line[i + marker.len()..])))
        .max_by_key(|(i, _)| *i)?;
    let target = &rest[..rest.find('"')?];
    (!target.is_empty() && !target.contains('%')).then(|| target.to_string())
}

/// Launch an npm cmd-shim's script directly. Routing it through `cmd.exe /c` lets
/// cmd reparse the prompt: it ignores the `\"` escaping portable-pty uses, so a
/// quote followed by `&` or `|` runs another command, `%VAR%` expands, and a
/// newline ends the command. Returns None for anything that isn't such a shim.
fn npm_shim_command(shim: &std::path::Path) -> Option<(String, Vec<String>)> {
    let text = std::fs::read_to_string(shim).ok()?;
    let dir = shim.parent()?;
    let script = npm_shim_target(&text)?
        .split(['\\', '/'])
        .filter(|part| !part.is_empty())
        .fold(dir.to_path_buf(), |path, part| path.join(part));
    if !script.is_file() {
        return None;
    }
    let ext = script
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let script_path = script.to_string_lossy().to_string();
    if matches!(ext.as_str(), "js" | "cjs" | "mjs") || text.to_lowercase().contains("node.exe") {
        let beside = dir.join("node.exe");
        let node = if beside.is_file() {
            beside
        } else {
            which::which("node").ok()?
        };
        Some((node.to_string_lossy().to_string(), vec![script_path]))
    } else if matches!(ext.as_str(), "exe" | "com") {
        Some((script_path, Vec::new()))
    } else {
        None
    }
}

/// Characters cmd.exe acts on even inside the quotes portable-pty adds, or
/// outside them when an argument has no whitespace to trigger quoting.
fn cmd_unsafe(arg: &str) -> bool {
    arg.contains(['"', '%', '!', '^', '&', '|', '<', '>', '\r', '\n'])
}

// Windows ConPTY does not deliver EOF until its master is closed. Reap the
// process independently, then drop its handles outside the session-map lock.
fn reap_session(
    sessions: &Arc<Mutex<HashMap<String, PtySession>>>,
    id: &str,
    epoch: u64,
    mut child: Box<dyn portable_pty::Child + Send + Sync>,
) -> (Option<u32>, bool) {
    let code = child.wait().ok().map(|s| s.exit_code());
    let retired = {
        let mut map = sessions.lock().unwrap();
        if map.get(id).is_some_and(|s| s.epoch == epoch) {
            map.remove(id)
        } else {
            None
        }
    };
    let owned = retired.is_some();
    drop(retired);
    (code, owned)
}

#[tauri::command]
async fn spawn_agent(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    run_id: String,
    record_output: bool,
    program: String,
    args: Vec<String>,
    cwd: Option<String>,
    // Extra environment for the child (provider keys, base URLs, model ids).
    // Resolved and filtered by the frontend; empty values never reach here.
    env: Option<HashMap<String, String>>,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let sessions = state.sessions.clone();
    let spawning = state.spawning.clone();
    let readers = state.readers.clone();
    let epoch = state.next_epoch.fetch_add(1, Ordering::SeqCst);

    tauri::async_runtime::spawn_blocking(move || {
        if !spawning
            .lock()
            .map_err(|_| "Launch state unavailable")?
            .insert(id.clone())
        {
            return Err("This session is already starting".into());
        }
        let _guard = SpawnGuard {
            ids: spawning,
            id: id.clone(),
        };
        desktop::valid_id(&run_id)?;
        // Starting is deliberately not a restart. The caller must stop explicitly.
        if sessions
            .lock()
            .map_err(|_| "Session state unavailable")?
            .contains_key(&id)
        {
            return Err("This session is already running. Stop it before restarting.".into());
        }
        let directory = cwd
            .clone()
            .filter(|s| !s.is_empty())
            .ok_or("Choose a project folder before starting an agent.")?;
        if !std::path::Path::new(&directory).is_dir() {
            return Err("The working directory no longer exists.".into());
        }
        let run_dir = if record_output {
            Some(desktop::begin_run(&app, &run_id, &directory)?)
        } else {
            None
        };

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())?;

        let (exe, prefix_args) = resolve_command(&program);
        if exe == "cmd.exe" && args.iter().any(|a| cmd_unsafe(a)) {
            return Err(format!(
                "{program} is a batch script, and Windows cannot pass this prompt to it \
                 safely. Remove quotes, % ! ^ & | < > and line breaks from the prompt, or \
                 point the agent at its executable instead."
            ));
        }
        let mut cmd = CommandBuilder::new(exe);
        for a in prefix_args {
            cmd.arg(a);
        }
        for a in &args {
            cmd.arg(a);
        }
        if let Some(dir) = cwd.filter(|d| !d.is_empty()) {
            cmd.cwd(dir);
        }
        cmd.env("TERM", "xterm-256color");
        for (key, value) in env.unwrap_or_default() {
            if !key.is_empty() {
                cmd.env(key, value);
            }
        }

        let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
        // Close the slave in the parent so EOF is observed when the child exits.
        drop(pair.slave);

        let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
        let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

        // Register the session before starting the reader so an instant exit is
        // still observed against the correct epoch.
        sessions.lock().unwrap().insert(
            id.clone(),
            PtySession {
                master: pair.master,
                writer,
                child: child.clone_killer(),
                epoch,
            },
        );

        // Stream PTY output to the frontend until the process exits.
        let app_handle = app.clone();
        let read_id = id.clone();
        let thread_sessions = sessions.clone();
        let (exit_tx, exit_rx) = std::sync::mpsc::channel();
        let wait_id = id.clone();
        std::thread::spawn(move || {
            let result = reap_session(&thread_sessions, &wait_id, epoch, child);
            let _ = exit_tx.send(result);
        });
        *readers.0.lock().unwrap() += 1;
        std::thread::spawn(move || {
            let mut reader = reader;
            let mut buf = [0u8; 8192];
            let mut log = run_dir.as_ref().and_then(|dir| {
                OpenOptions::new()
                    .append(true)
                    .open(dir.join("output.log"))
                    .ok()
            });
            let mut logged = 0u64;
            let mut recording_error = if run_dir.is_some() && log.is_none() {
                Some("Could not open the output recording.".to_string())
            } else {
                None
            };
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => {
                        // Only report the exit if this thread still owns the live
                        // session for this id; otherwise a newer spawn replaced us
                        // (Restart) and the exit is stale. Drop the dead session.
                        if let Some(ref dir) = run_dir {
                            if let Some(ref file) = log {
                                if let Err(error) = file.sync_all() {
                                    recording_error = Some(error.to_string());
                                }
                            }
                            if let Err(error) = desktop::finish_run(dir) {
                                recording_error = Some(error);
                            }
                            let _ = app_handle.emit(
                                "run-saved",
                                SavedEvent {
                                    id: read_id.clone(),
                                    run_id: run_id.clone(),
                                    error: recording_error.clone(),
                                },
                            );
                        }
                        if let Ok((code, true)) = exit_rx.recv() {
                            let _ = app_handle.emit(
                                "agent-exit",
                                ExitEvent {
                                    id: read_id.clone(),
                                    code,
                                    run_id: run_id.clone(),
                                },
                            );
                        }
                        break;
                    }
                    Ok(n) => {
                        if let Some(file) = log.as_mut() {
                            let keep = (desktop::LOG_LIMIT.saturating_sub(logged) as usize).min(n);
                            if keep > 0 {
                                if let Err(error) = file.write_all(&buf[..keep]) {
                                    recording_error = Some(error.to_string());
                                }
                                logged += keep as u64;
                            }
                        }
                        let data = base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
                        let _ = app_handle.emit(
                            "agent-output",
                            OutputEvent {
                                id: read_id.clone(),
                                data,
                                run_id: run_id.clone(),
                            },
                        );
                    }
                }
            }
            *readers.0.lock().unwrap() -= 1;
            readers.1.notify_all();
        });

        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn wait_for_saves(state: State<'_, AppState>) -> Result<(), String> {
    let readers = state.readers.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let active = readers.0.lock().map_err(|_| "Output saving unavailable")?;
        let (active, _) = readers
            .1
            .wait_timeout_while(active, std::time::Duration::from_secs(30), |n| *n > 0)
            .map_err(|_| "Output saving unavailable")?;
        if *active > 0 {
            Err("Output is still being saved. Keep the app open and try again shortly.".into())
        } else {
            Ok(())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn write_to_agent(state: State<AppState>, id: String, data: String) -> Result<(), String> {
    let mut sessions = state.sessions.lock().unwrap();
    let session = sessions
        .get_mut(&id)
        .ok_or_else(|| format!("no running session: {id}"))?;
    session
        .writer
        .write_all(data.as_bytes())
        .map_err(|e| e.to_string())?;
    session.writer.flush().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn resize_agent(state: State<AppState>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    let sessions = state.sessions.lock().unwrap();
    if let Some(session) = sessions.get(&id) {
        session
            .master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn kill_agent(state: State<AppState>, id: String) -> Result<(), String> {
    let retired = {
        let mut sessions = state
            .sessions
            .lock()
            .map_err(|_| "Session state unavailable")?;
        if let Some(session) = sessions.get_mut(&id) {
            session.child.kill().map_err(|e| e.to_string())?;
        }
        sessions.remove(&id)
    };
    drop(retired);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(AppState::default())
        .setup(|app| {
            desktop::restore_window(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            spawn_agent,
            write_to_agent,
            resize_agent,
            kill_agent,
            wait_for_saves,
            desktop::load_workspace,
            desktop::save_workspace,
            desktop::project_info,
            desktop::check_agent,
            desktop::read_run,
            desktop::create_worktree,
            desktop::save_window_state,
            desktop::export_backup,
            desktop::import_backup
        ])
        .build(tauri::generate_context!())
        .expect("error while building Crucible")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                let state = app.state::<AppState>();
                if let Ok(mut sessions) = state.sessions.lock() {
                    for (_, mut session) in sessions.drain() {
                        let _ = session.child.kill();
                    }
                };
            }
        });
}

#[cfg(test)]
mod shim_tests {
    use super::*;

    const MODERN: &str = "@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST \"%dp0%\\node.exe\" (\r\n  SET \"_prog=%dp0%\\node.exe\"\r\n) ELSE (\r\n  SET \"_prog=node\"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & \"%_prog%\"  \"%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js\" %*\r\n";
    const LEGACY: &str = "@IF EXIST \"%~dp0\\node.exe\" (\r\n  \"%~dp0\\node.exe\"  \"%~dp0\\node_modules\\@anthropic-ai\\claude-code\\cli.js\" %*\r\n) ELSE (\r\n  @SETLOCAL\r\n  @SET PATHEXT=%PATHEXT:;.JS;=;%\r\n  node  \"%~dp0\\node_modules\\@anthropic-ai\\claude-code\\cli.js\" %*\r\n)\r\n";

    #[test]
    fn npm_shim_target_reads_modern_and_legacy_shims() {
        assert_eq!(
            npm_shim_target(MODERN).as_deref(),
            Some("node_modules\\@openai\\codex\\bin\\codex.js")
        );
        assert_eq!(
            npm_shim_target(LEGACY).as_deref(),
            Some("node_modules\\@anthropic-ai\\claude-code\\cli.js")
        );
        for other in [
            "@echo off\r\necho hello\r\n",
            "\"%dp0%\\%OTHER%\\x.js\" %*",
            "",
        ] {
            assert_eq!(npm_shim_target(other), None, "{other:?}");
        }
    }

    #[test]
    fn npm_shims_launch_their_script_without_cmd() {
        let dir = std::env::temp_dir().join(format!("crucible-shim-{}", std::process::id()));
        let script_dir = dir
            .join("node_modules")
            .join("@openai")
            .join("codex")
            .join("bin");
        std::fs::create_dir_all(&script_dir).unwrap();
        std::fs::write(script_dir.join("codex.js"), "").unwrap();
        std::fs::write(dir.join("node.exe"), "").unwrap();
        std::fs::write(dir.join("codex.cmd"), MODERN).unwrap();
        let (exe, args) = npm_shim_command(&dir.join("codex.cmd")).unwrap();
        assert_eq!(exe, dir.join("node.exe").to_string_lossy());
        assert_eq!(
            args,
            vec![script_dir.join("codex.js").to_string_lossy().to_string()]
        );

        // A shim whose script is missing, or an ordinary batch file, keeps cmd.exe.
        std::fs::write(dir.join("gone.cmd"), MODERN.replace("codex.js", "gone.js")).unwrap();
        assert!(npm_shim_command(&dir.join("gone.cmd")).is_none());
        std::fs::write(dir.join("plain.bat"), "@echo off\r\necho %*\r\n").unwrap();
        assert!(npm_shim_command(&dir.join("plain.bat")).is_none());
        std::fs::write(dir.join("tool.py"), "").unwrap();
        std::fs::write(dir.join("tool.cmd"), "@python \"%~dp0\\tool.py\" %*\r\n").unwrap();
        assert!(npm_shim_command(&dir.join("tool.cmd")).is_none());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn prompts_cmd_would_reinterpret_are_flagged() {
        for arg in [
            "say \"hi\" & echo INJECTED",
            "a&b",
            "50%PATH%",
            "line one\nline two",
            "x | y",
            "^",
        ] {
            assert!(cmd_unsafe(arg), "{arg:?}");
        }
        for arg in [
            "-p",
            "Fix the login bug in src/auth.ts",
            "C:\\Work\\app (copy)",
        ] {
            assert!(!cmd_unsafe(arg), "{arg:?}");
        }
    }
}

#[cfg(all(test, windows))]
mod pty_tests {
    use super::*;
    #[test]
    fn native_exit_closes_output_and_preserves_exit_code() {
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let mut cmd = CommandBuilder::new("cmd.exe");
        cmd.args(["/d", "/c", "echo native-pty-regression & exit /b 7"]);
        let child = pair.slave.spawn_command(cmd).unwrap();
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().unwrap();
        let writer = pair.master.take_writer().unwrap();
        let sessions = Arc::new(Mutex::new(HashMap::new()));
        sessions.lock().unwrap().insert(
            "test".into(),
            PtySession {
                master: pair.master,
                writer,
                child: child.clone_killer(),
                epoch: 42,
            },
        );
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            let _ = reader.read_to_end(&mut bytes);
            tx.send(bytes).unwrap();
        });
        let (code, owned) = reap_session(&sessions, "test", 42, child);
        assert_eq!(code, Some(7));
        assert!(owned);
        assert!(sessions.lock().unwrap().is_empty());
        let bytes = rx
            .recv_timeout(std::time::Duration::from_secs(10))
            .expect("ConPTY must reach EOF after exit");
        assert!(String::from_utf8_lossy(&bytes).contains("native-pty-regression"));
    }
}
