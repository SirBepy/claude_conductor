//! External-terminal spawning for chat sessions. Split out of `lifecycle.rs`
//! (see `.claude/todos/509-split-ipc-chat-lifecycle-terminal-spawn.md`).

use super::attachments::validate_session_id;
use crate::state::AppState;
use tauri::State;

/// Open the given chat session in an external terminal window, running
/// `claude --resume <session_id>` in the session's cwd. Independent of the
/// Tauri app process - survives app restarts (Path C per-turn model means
/// the claude jsonl is the source of truth; both this app and the external
/// terminal can resume the same session, just not simultaneously).
///
/// Platform behavior:
/// - Windows: prefers Windows Terminal (`wt.exe`); falls back to `cmd.exe`.
/// - macOS: `osascript` driving Terminal.app.
/// - Linux: tries `gnome-terminal`, `konsole`, `xterm` in order.
#[tauri::command]
pub async fn open_session_in_terminal(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    validate_session_id(&session_id)?;
    let entry = state
        .cached_instances
        .lock()
        .unwrap()
        .iter()
        .find(|i| i.session_id == session_id)
        .cloned()
        .ok_or_else(|| format!("session {session_id} not found in registry"))?;
    let cwd = entry.cwd.clone();
    if !cwd.exists() {
        return Err(format!("cwd does not exist: {}", cwd.display()));
    }
    spawn_terminal_for_session(&session_id, &cwd).map_err(|e| e.to_string())?;
    let guard = state.daemon_client.lock().await;
    if let Some(client) = guard.as_ref() {
        let _ = client.externalize_session(&session_id).await;
    }
    Ok(())
}

/// Open a plain terminal in a directory without attaching any claude session.
#[tauri::command]
pub async fn open_terminal_in_directory(path: String) -> Result<(), String> {
    let dir = std::path::Path::new(&path);
    if !dir.exists() {
        return Err(format!("directory does not exist: {path}"));
    }
    spawn_terminal_in_dir(dir).map_err(|e| e.to_string())
}

/// Open `claude --resume <id>` in an external terminal in the session's cwd.
fn spawn_terminal_for_session(
    session_id: &str,
    cwd: &std::path::Path,
) -> std::io::Result<()> {
    open_terminal(cwd, Some(&format!("claude --resume {session_id}")))
}

/// Open a plain terminal in `cwd` with no attached command.
fn spawn_terminal_in_dir(cwd: &std::path::Path) -> std::io::Result<()> {
    open_terminal(cwd, None)
}

/// Single per-platform terminal opener. `initial_cmd`, when present, is the
/// shell command run in the new terminal (e.g. `claude --resume <id>`); when
/// `None`, an empty interactive terminal is opened in `cwd`.
///
/// Platform behavior:
/// - Windows: prefers Windows Terminal (`wt.exe`); falls back to `cmd.exe`.
/// - macOS: `osascript` driving Terminal.app.
/// - Linux: tries `gnome-terminal`, `konsole`, `xfce4-terminal`, `xterm` in order.
#[cfg(target_os = "windows")]
fn open_terminal(cwd: &std::path::Path, initial_cmd: Option<&str>) -> std::io::Result<()> {
    use std::process::Command;
    let cwd_str = cwd.to_string_lossy().to_string();
    // Try Windows Terminal first.
    let mut wt = Command::new("wt.exe");
    wt.args(["-d", &cwd_str]);
    if let Some(cmd) = initial_cmd {
        wt.args(["cmd.exe", "/K", cmd]);
    }
    if wt.spawn().is_ok() {
        return Ok(());
    }
    // Fall back to bare cmd.exe in a new console window.
    let mut fallback = Command::new("cmd.exe");
    fallback.arg("/C").arg("start").arg("").arg("cmd.exe");
    if let Some(cmd) = initial_cmd {
        fallback.arg("/K").arg(cmd);
    }
    fallback.current_dir(cwd).spawn()?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn open_terminal(cwd: &std::path::Path, initial_cmd: Option<&str>) -> std::io::Result<()> {
    use std::process::Command;
    // AppleScript escaping: backslash + double-quotes.
    let cwd_esc = cwd.to_string_lossy().replace('\\', "\\\\").replace('"', "\\\"");
    let script = match initial_cmd {
        Some(cmd) => {
            let cmd_esc = cmd.replace('\\', "\\\\").replace('"', "\\\"");
            format!(
                "tell application \"Terminal\" to do script \"cd \\\"{cwd_esc}\\\" && {cmd_esc}\""
            )
        }
        None => format!(
            "tell application \"Terminal\" to do script \"cd \\\"{cwd_esc}\\\"\""
        ),
    };
    Command::new("osascript").arg("-e").arg(&script).spawn()?;
    // Bring Terminal.app forward.
    let _ = Command::new("osascript")
        .arg("-e")
        .arg("tell application \"Terminal\" to activate")
        .spawn();
    Ok(())
}

#[cfg(target_os = "linux")]
fn open_terminal(cwd: &std::path::Path, initial_cmd: Option<&str>) -> std::io::Result<()> {
    use std::process::Command;
    let cwd_str = cwd.to_string_lossy().to_string();
    let run = initial_cmd.map(|c| format!("{c}; exec bash"));
    let candidates = ["gnome-terminal", "konsole", "xfce4-terminal", "xterm"];
    for bin in candidates {
        let mut cmd = Command::new(bin);
        match bin {
            "gnome-terminal" => {
                cmd.arg(format!("--working-directory={cwd_str}"));
                if let Some(r) = &run {
                    cmd.arg("--").arg("bash").arg("-c").arg(r);
                }
            }
            "konsole" => {
                cmd.arg("--workdir").arg(&cwd_str);
                if let Some(r) = &run {
                    cmd.arg("-e").arg("bash").arg("-c").arg(r);
                }
            }
            "xfce4-terminal" => {
                cmd.arg(format!("--working-directory={cwd_str}"));
                if let Some(r) = &run {
                    cmd.arg("-e").arg(format!("bash -c '{r}'"));
                }
            }
            _ => {
                cmd.current_dir(cwd);
                if let Some(r) = &run {
                    cmd.arg("-e").arg("bash").arg("-c").arg(r);
                }
            }
        }
        if cmd.spawn().is_ok() {
            return Ok(());
        }
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::NotFound,
        "no supported terminal emulator found (tried gnome-terminal, konsole, xfce4-terminal, xterm)",
    ))
}
