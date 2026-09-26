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

/// Open a folder in VS Code.
#[tauri::command]
pub async fn open_in_vscode(path: String) -> Result<(), String> {
    if path.is_empty() { return Err("empty path".into()) }
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
