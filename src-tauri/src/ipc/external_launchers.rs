//! External process launchers (file manager, VS Code), split out of
//! `ipc/projects.rs` (todo 941) - named as one of the file's mixed concerns
//! in that todo's own context, self-contained with no shared `AppState`.

/// Open a filesystem path in the OS file manager (Explorer on Windows,
/// Finder on macOS, default handler on Linux). Intentionally does NOT
/// suppress the console window because explorer/open/xdg-open ARE the
/// user-facing window the click is asking for.
#[tauri::command]
pub async fn open_in_explorer(path: String) -> Result<(), String> {
    if path.is_empty() { return Err("empty path".into()) }
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(target_os = "windows")]
        {
            std::process::Command::new("explorer")
                .arg(&path)
                .spawn()
                .map(|_| ())
                .map_err(|e| format!("explorer spawn failed: {e}"))
        }
        #[cfg(target_os = "macos")]
        {
            std::process::Command::new("open").arg(&path).spawn()
                .map(|_| ()).map_err(|e| format!("open spawn failed: {e}"))
        }
        #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
        {
            std::process::Command::new("xdg-open").arg(&path).spawn()
                .map(|_| ()).map_err(|e| format!("xdg-open spawn failed: {e}"))
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// cmd.exe treats these as syntax even inside an argument std leaves unquoted
/// (it only quotes args with spaces), so `C:\a&calc.md` would run `calc`. The
/// path can come from a chat transcript (the dashboard's Files list), so a
/// path holding one is refused rather than handed to `cmd /C`.
const CMD_METACHARS: &[char] = &['&', '|', '<', '>', '^', '%', '"', '!'];

fn cmd_safe_path(path: &str) -> Result<(), String> {
    if path.is_empty() { return Err("empty path".into()) }
    if path.contains(CMD_METACHARS) {
        return Err(format!("cannot open {path} in VS Code: its name has a character the Windows shell would run as a command"));
    }
    Ok(())
}

/// Open a folder in VS Code.
#[tauri::command]
pub async fn open_in_vscode(path: String) -> Result<(), String> {
    cmd_safe_path(&path)?;
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(target_os = "windows")]
        {
            // VS Code on Windows ships only as `code.cmd`, so launch via
            // cmd.exe /C. Hide the console window the cmd shim would otherwise
            // flash.
            let mut cmd = std::process::Command::new("cmd");
            cmd.args(["/C", "code", "-n", &path]);
            crate::util::process::hide_console(&mut cmd);
            cmd.spawn()
                .map(|_| ())
                .map_err(|e| format!("code launch failed: {e}"))
        }
        #[cfg(not(target_os = "windows"))]
        {
            let mut cmd = std::process::Command::new("code");
            cmd.args(["-n", &path]);
            crate::util::process::hide_console(&mut cmd);
            cmd.spawn()
                .map(|_| ())
                .map_err(|e| format!("code launch failed: {e}"))
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::cmd_safe_path;

    #[test]
    fn a_path_with_shell_syntax_is_refused_and_a_plain_one_passes() {
        assert!(cmd_safe_path(r"C:\repo\a&calc.md").is_err());
        assert!(cmd_safe_path(r"C:\repo\x|y.md").is_err());
        assert!(cmd_safe_path(r"C:\repo\%PATH%.md").is_err());
        assert!(cmd_safe_path("").is_err());
        assert!(cmd_safe_path(r"C:\Users\me\My Projects\notes (v2).md").is_ok());
    }
}
