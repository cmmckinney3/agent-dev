// AgentDev backend: runs interactive CLI agents (Claude Code, Codex) inside
// pseudo-terminals and streams their I/O to the frontend.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

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
    child: Box<dyn portable_pty::Child + Send + Sync>,
    epoch: u64,
}

#[derive(Default)]
struct AppState {
    sessions: Arc<Mutex<HashMap<String, PtySession>>>,
    next_epoch: AtomicU64,
}

#[derive(Clone, Serialize)]
struct OutputEvent {
    id: String,
    /// PTY bytes, base64-encoded so binary/ANSI data survives the JSON bridge.
    data: String,
}

#[derive(Clone, Serialize)]
struct ExitEvent {
    id: String,
    /// Process exit code, when the child could be reaped (None if unknown).
    /// Lets the frontend distinguish a clean headless completion from a crash.
    code: Option<u32>,
}

/// Resolve a program name to an executable. On Windows, npm-style `.cmd`/`.bat`
/// shims (e.g. `codex.cmd`) must be launched through `cmd.exe /c`.
fn resolve_command(program: &str) -> (String, Vec<String>) {
    match which::which(program) {
        Ok(path) => {
            let resolved = path.to_string_lossy().to_string();
            let lower = resolved.to_lowercase();
            if lower.ends_with(".cmd") || lower.ends_with(".bat") {
                ("cmd.exe".to_string(), vec!["/c".to_string(), resolved])
            } else {
                (resolved, Vec::new())
            }
        }
        Err(_) => (program.to_string(), Vec::new()),
    }
}

#[tauri::command]
fn spawn_agent(
    app: AppHandle,
    state: State<AppState>,
    id: String,
    program: String,
    args: Vec<String>,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let sessions = state.sessions.clone();
    let epoch = state.next_epoch.fetch_add(1, Ordering::SeqCst);

    // Replace any existing session under this id.
    if let Some(mut old) = sessions.lock().unwrap().remove(&id) {
        let _ = old.child.kill();
    }

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
            child,
            epoch,
        },
    );

    // Stream PTY output to the frontend until the process exits.
    let app_handle = app.clone();
    let read_id = id.clone();
    let thread_sessions = sessions.clone();
    std::thread::spawn(move || {
        let mut reader = reader;
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => {
                    // Only report the exit if this thread still owns the live
                    // session for this id; otherwise a newer spawn replaced us
                    // (Restart) and the exit is stale. Drop the dead session.
                    let mut map = thread_sessions.lock().unwrap();
                    if map.get(&read_id).map(|s| s.epoch) == Some(epoch) {
                        let mut session = map.remove(&read_id).unwrap();
                        drop(map);
                        // EOF means the child is gone (or going); reap it so
                        // the exit code reaches the frontend.
                        let code = session.child.wait().ok().map(|s| s.exit_code());
                        let _ = app_handle.emit(
                            "agent-exit",
                            ExitEvent {
                                id: read_id.clone(),
                                code,
                            },
                        );
                    }
                    break;
                }
                Ok(n) => {
                    let data = base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
                    let _ = app_handle.emit(
                        "agent-output",
                        OutputEvent {
                            id: read_id.clone(),
                            data,
                        },
                    );
                }
            }
        }
    });

    Ok(())
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
    if let Some(mut session) = state.sessions.lock().unwrap().remove(&id) {
        let _ = session.child.kill();
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .on_window_event(|window, event| {
            // Reap every running agent when the window closes so we don't leave
            // orphaned `claude`/`codex` processes behind.
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                let state = window.state::<AppState>();
                let mut map = state.sessions.lock().unwrap();
                for (_, mut session) in map.drain() {
                    let _ = session.child.kill();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            spawn_agent,
            write_to_agent,
            resize_agent,
            kill_agent
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
