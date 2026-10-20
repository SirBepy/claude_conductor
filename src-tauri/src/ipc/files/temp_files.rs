//! Temp-file writers the preview panel and lightbox hand to the OS.

/// Shared scaffolding for `write_temp_image`/`write_temp_html`: pick a
/// `claude-conductor-<uuid>.<ext>` path in the OS temp dir and write `bytes`
/// to it off the async runtime thread.
fn write_temp_file(ext: &str, bytes: Vec<u8>) -> Result<String, String> {
    let path = std::env::temp_dir().join(format!("claude-conductor-{}.{ext}", uuid::Uuid::new_v4()));
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
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
        write_temp_file(ext, bytes)
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
    tauri::async_runtime::spawn_blocking(move || write_temp_file("html", html.into_bytes()))
        .await
        .map_err(|e| format!("write_temp_html join error: {e}"))?
}
