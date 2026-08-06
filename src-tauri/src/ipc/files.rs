//! File/folder picker, editor-open, log, and local-file read/write IPC
//! commands. Single concern: anything that touches the local filesystem or
//! the app log on behalf of the frontend.

use std::path::PathBuf;
use tauri::{AppHandle, Manager};

use crate::files;

#[tauri::command]
pub async fn list_project_files(project_dir: String) -> Result<Vec<String>, String> {
    let p = PathBuf::from(project_dir);
    tauri::async_runtime::spawn_blocking(move || files::scan(&p))
        .await
        .map_err(|e| e.to_string())?
}

/// Read a local file and return its contents as a base64 string so the
/// webview can embed it as a `data:` URL (img-src only allows data: and self).
/// Used by the PR preview modal to display local screenshots.
#[tauri::command]
pub async fn read_file_as_base64(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use base64::Engine as _;
        let bytes = std::fs::read(&path).map_err(|e| format!("{e}"))?;
        Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Reads a log file from disk, returning a friendly placeholder when it does
/// not exist yet (common on a fresh install before the first log line is
/// written). Extracted from the Tauri command so it can be unit-tested.
pub fn read_log_contents(log_path: &std::path::Path) -> Result<String, String> {
    match std::fs::read_to_string(log_path) {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            Ok(format!("(no log file yet at {})", log_path.display()))
        }
        Err(e) => Err(format!("reading {}: {e}", log_path.display())),
    }
}

/// Reads the tauri-plugin-log log file and returns its contents as a string.
/// The renderer writes this to the clipboard for bug reports.
#[tauri::command]
pub async fn read_log_file(app: AppHandle) -> Result<String, String> {
    let log_dir = app.path().app_log_dir().map_err(|e| e.to_string())?;
    let product = app.package_info().name.clone();
    let log_path = log_dir.join(format!("{product}.log"));
    tauri::async_runtime::spawn_blocking(move || read_log_contents(&log_path))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn copy_logs(app: AppHandle) -> Result<(), String> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    let log_dir = app.path().app_log_dir().map_err(|e| e.to_string())?;
    let product = app.package_info().name.clone();
    let log_path = log_dir.join(format!("{product}.log"));
    let contents = tauri::async_runtime::spawn_blocking(move || {
        read_log_contents(&log_path).unwrap_or_else(|e| format!("<error reading log: {e}>"))
    })
    .await
    .map_err(|e| e.to_string())?;
    app.clipboard().write_text(contents).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn pick_folder(app: AppHandle) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .pick_folder(move |path| {
            let _ = tx.send(path);
        });
    rx.await.unwrap_or(None).map(|p| p.to_string())
}

#[tauri::command]
pub async fn create_folder(path: String) -> Result<(), String> {
    std::fs::create_dir_all(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn open_external(app: AppHandle, url: String) -> Result<(), String> {
    use tauri_plugin_shell::ShellExt;
    #[allow(deprecated)]
    app.shell().open(url, None).map_err(|e| e.to_string())
}

/// Open a file path in VS Code. Spawns detached (never waits on the child).
///
/// On Windows VS Code's CLI is `code.cmd`, so `Command::new("code")` won't
/// resolve - we go through `cmd /C code <path>` with CREATE_NO_WINDOW
/// (via `hide_console`) so no console window flashes (a known freeze/flicker
/// source in this app). If `code` can't be spawned we fall back to the OS
/// default handler via the same `tauri-plugin-shell` mechanism `open_external`
/// uses to open URLs/paths.
#[tauri::command]
pub async fn open_in_editor(app: AppHandle, path: String) -> Result<(), String> {
    use std::process::Command;

    let spawned = {
        #[cfg(target_os = "windows")]
        {
            let mut cmd = Command::new("cmd");
            cmd.args(["/C", "code", &path]);
            crate::util::process::hide_console(&mut cmd);
            cmd.spawn().is_ok()
        }
        #[cfg(not(target_os = "windows"))]
        {
            Command::new("code").arg(&path).spawn().is_ok()
        }
    };

    if spawned {
        return Ok(());
    }

    // VS Code not found / spawn failed - fall back to the OS default handler,
    // mirroring `open_external`.
    use tauri_plugin_shell::ShellExt;
    #[allow(deprecated)]
    app.shell().open(path, None).map_err(|e| e.to_string())
}

/// Read an arbitrary local image file as `{mime, base64}` for an in-app
/// lightbox. Unlike `read_attachment` (which is sandboxed to the
/// chat-attachments directory), this reads any absolute path the agent
/// surfaced - e.g. a `.png` the model Read. MIME is inferred from the
/// extension; unknown extensions fall back to `application/octet-stream`.
#[tauri::command]
pub async fn read_image_file(
    path: String,
) -> Result<crate::ipc::chat::attachments::AttachmentData, String> {
    use base64::Engine;
    let target = std::path::PathBuf::from(&path)
        .canonicalize()
        .map_err(|e| format!("file not found: {e}"))?;
    let bytes = std::fs::read(&target).map_err(|e| e.to_string())?;
    let mime = match target.extension().and_then(|e| e.to_str()) {
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("bmp") => "image/bmp",
        Some("svg") => "image/svg+xml",
        _ => "application/octet-stream",
    }
    .to_string();
    let base64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(crate::ipc::chat::attachments::AttachmentData { mime, base64 })
}

/// Max bytes `read_text_file` returns. Files larger than this are returned
/// truncated (capped prefix + `truncated: true`) so the in-app read-only file
/// viewer never tries to highlight a multi-megabyte blob. Mirrors the spirit
/// of `read_image_file` (which reads any absolute path the agent surfaced).
const TEXT_FILE_CAP_BYTES: usize = 2 * 1024 * 1024; // 2 MB

#[derive(serde::Serialize, ts_rs::TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct TextFileData {
    pub content: String,
    pub truncated: bool,
}

/// Read an arbitrary local text file for the in-app read-only file viewer.
/// Like `read_image_file`, this reads any absolute path the agent surfaced
/// (not sandboxed). The read is capped at `TEXT_FILE_CAP_BYTES`: a larger file
/// yields the capped prefix with `truncated: true`. Decoding is lossy UTF-8 so
/// binary-ish files produce replacement characters instead of panicking.
#[tauri::command]
pub async fn read_text_file(path: String) -> Result<TextFileData, String> {
    use std::io::Read;
    tauri::async_runtime::spawn_blocking(move || {
        let target = std::path::PathBuf::from(&path)
            .canonicalize()
            .map_err(|e| format!("file not found: {e}"))?;
        let file = std::fs::File::open(&target).map_err(|e| e.to_string())?;
        // Read one byte past the cap so we can tell "exactly at cap" from
        // "larger than cap".
        let mut buf = Vec::new();
        file.take((TEXT_FILE_CAP_BYTES + 1) as u64)
            .read_to_end(&mut buf)
            .map_err(|e| e.to_string())?;
        let truncated = buf.len() > TEXT_FILE_CAP_BYTES;
        if truncated {
            buf.truncate(TEXT_FILE_CAP_BYTES);
        }
        let content = String::from_utf8_lossy(&buf).into_owned();
        Ok(TextFileData { content, truncated })
    })
    .await
    .map_err(|e| format!("read_text_file join error: {e}"))?
}

/// Write base64 image bytes to a temp file so it can be revealed in the OS
/// file manager. Used by the lightbox "Show in File Explorer" menu item for
/// images that have no known source path (inline chat-block images from an
/// MCP tool result, e.g. a chrome-devtools screenshot) - the temp copy is a
/// synthesized stand-in, not the original file.
#[tauri::command]
pub async fn write_temp_image(mime: String, base64: String) -> Result<String, String> {
    use base64::Engine;
    tauri::async_runtime::spawn_blocking(move || {
        let ext = match mime.as_str() {
            "image/png" => "png",
            "image/jpeg" => "jpg",
            "image/gif" => "gif",
            "image/webp" => "webp",
            "image/bmp" => "bmp",
            "image/svg+xml" => "svg",
            _ => "bin",
        };
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&base64)
            .map_err(|e| e.to_string())?;
        let path = std::env::temp_dir().join(format!("claude-conductor-{}.{ext}", uuid::Uuid::new_v4()));
        std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
        Ok(path.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| format!("write_temp_image join error: {e}"))?
}

/// Write HTML to a temp `.html` file so "Open in browser" can hand the OS a
/// real file path instead of a `data:` URL - Windows' `ShellExecuteW` has no
/// protocol handler for `data:` and fails trying to treat the whole URI as a
/// filename.
#[tauri::command]
pub async fn write_temp_html(html: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = std::env::temp_dir().join(format!("claude-conductor-{}.html", uuid::Uuid::new_v4()));
        std::fs::write(&path, html.as_bytes()).map_err(|e| e.to_string())?;
        Ok(path.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| format!("write_temp_html join error: {e}"))?
}

/// Reveal (and select, where the OS supports it) a specific FILE in the OS
/// file manager. Unlike `open_in_explorer` (which opens a directory), this
/// takes a file path and highlights it in its parent folder.
#[tauri::command]
pub async fn reveal_file_in_explorer(path: String) -> Result<(), String> {
    if path.is_empty() { return Err("empty path".into()) }
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(target_os = "windows")]
        {
            std::process::Command::new("explorer")
                .arg(format!("/select,{path}"))
                .spawn()
                .map(|_| ())
                .map_err(|e| format!("explorer spawn failed: {e}"))
        }
        #[cfg(target_os = "macos")]
        {
            std::process::Command::new("open")
                .arg("-R")
                .arg(&path)
                .spawn()
                .map(|_| ())
                .map_err(|e| format!("open -R spawn failed: {e}"))
        }
        #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
        {
            let parent = std::path::Path::new(&path)
                .parent()
                .map(|p| p.to_path_buf())
                .unwrap_or_else(|| std::path::PathBuf::from(&path));
            std::process::Command::new("xdg-open")
                .arg(&parent)
                .spawn()
                .map(|_| ())
                .map_err(|e| format!("xdg-open spawn failed: {e}"))
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Overwrite a local text file from the in-app file editor (ai_todo 95 slice 3).
/// The counterpart to `read_text_file`: writes any absolute path the agent
/// surfaced (not sandboxed). The frontend only enables editing for files that
/// were read whole (not truncated), so a save can never drop a capped tail.
#[tauri::command]
pub async fn write_text_file(path: String, content: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::write(&path, content).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("write_text_file join error: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::read_log_contents;
    use tempfile::tempdir;

    #[test]
    fn returns_placeholder_when_log_missing() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("does-not-exist.log");
        let out = read_log_contents(&path).unwrap();
        assert!(out.starts_with("(no log file yet at "), "got: {out}");
    }

    #[test]
    fn returns_file_contents_when_present() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("app.log");
        std::fs::write(&path, "line 1\nline 2\n").unwrap();
        assert_eq!(read_log_contents(&path).unwrap(), "line 1\nline 2\n");
    }
}
