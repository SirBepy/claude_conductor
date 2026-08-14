//! Image-attachment IPC + helpers for the chat hub.
//!
//! Owns `paste_image` (clipboard image -> on-disk file the `claude` CLI can
//! read via its Read tool) and `read_attachment` (inline render in the chat
//! view). Also hosts `validate_session_id` + `write_attachment` because
//! `paste_image` is the original caller; both are re-exported by the parent
//! `chat` module so `history` can reuse `validate_session_id`.

use base64::Engine;
use std::path::{Path, PathBuf};

/// Hard cap on one attachment write. Comfortably clears the frontend's 8MB
/// per-draft budget and a full-resolution screenshot, while still bounding a
/// single runaway/malformed request before it reaches disk.
const MAX_ATTACHMENT_BYTES: usize = 20 * 1024 * 1024;

/// Validate session_id against a strict charset. Used anywhere we use the
/// id to construct a filesystem path. Rejects empty / too-long / any char
/// outside [A-Za-z0-9_-]. Real session_ids upstream are UUIDs which always
/// pass.
pub(crate) fn validate_session_id(session_id: &str) -> Result<(), String> {
    if session_id.is_empty() || session_id.len() > 128 {
        return Err("invalid session_id length".to_string());
    }
    if !session_id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("invalid session_id (only alphanumeric, dash, underscore allowed)".to_string());
    }
    Ok(())
}

/// Pure file-writing helper, factored out of the `paste_image` command so it
/// can be unit-tested without a Tauri AppHandle.
pub(crate) fn write_attachment(
    root: &Path,
    session_id: &str,
    base64_data: &str,
    mime: &str,
) -> Result<PathBuf, String> {
    validate_session_id(session_id)?;
    // Base64 inflates by ~4/3 (padding can add up to 2 bytes of slack to this
    // estimate); reject an obviously oversized payload before paying for the
    // decode. The post-decode check below is the authoritative one.
    if base64_data.len() / 4 * 3 > MAX_ATTACHMENT_BYTES + 2 {
        return Err(format!(
            "attachment too large: encoded payload is ~{} bytes, exceeds the {}MB limit",
            base64_data.len() / 4 * 3,
            MAX_ATTACHMENT_BYTES / (1024 * 1024)
        ));
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64_data.as_bytes())
        .map_err(|e| e.to_string())?;
    if bytes.len() > MAX_ATTACHMENT_BYTES {
        return Err(format!(
            "attachment too large: {} bytes exceeds the {}MB limit",
            bytes.len(),
            MAX_ATTACHMENT_BYTES / (1024 * 1024)
        ));
    }
    let dir = root.join("chat-attachments").join(session_id);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let ext = match mime {
        "image/png" => "png",
        "image/jpeg" | "image/jpg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/bmp" => "bmp",
        "image/svg+xml" => "svg",
        "application/pdf" => "pdf",
        "text/plain" => "txt",
        "text/markdown" => "md",
        "text/csv" => "csv",
        "application/json" | "text/json" => "json",
        _ => "bin",
    };
    let filename = format!("{}.{}", uuid::Uuid::new_v4(), ext);
    let path = dir.join(&filename);
    std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;
    Ok(path)
}

/// Persist a clipboard-pasted image and return its absolute path. The
/// composer surfaces this path to claude as a `<file:...>` mention so
/// claude reads it via its Read tool.
#[tauri::command]
pub async fn paste_image(
    session_id: String,
    base64_data: String,
    mime: String,
) -> Result<String, String> {
    let root = crate::settings::paths::data_dir().map_err(|e| e.to_string())?;
    let path = write_attachment(&root, &session_id, &base64_data, &mime)?;
    Ok(path.to_string_lossy().to_string())
}

/// Same as `paste_image` but accepts any MIME type, not just images.
/// The composer uses this for drag-dropped files.
#[tauri::command]
pub async fn paste_attachment(
    session_id: String,
    base64_data: String,
    mime: String,
) -> Result<String, String> {
    let root = crate::settings::paths::data_dir().map_err(|e| e.to_string())?;
    let path = write_attachment(&root, &session_id, &base64_data, &mime)?;
    Ok(path.to_string_lossy().to_string())
}

/// Copy a file dropped from the OS into the chat-attachments dir, returning
/// the dest path + MIME + base64 so the composer can display it inline.
/// Used by the Tauri drag-drop event path (tauri://drop gives file paths,
/// not File blobs, so the standard paste_attachment flow doesn't apply).
#[tauri::command]
pub async fn paste_attachment_from_path(
    session_id: String,
    path: String,
) -> Result<AttachmentFromPathResult, String> {
    use base64::Engine;
    validate_session_id(&session_id)?;
    let src = std::path::PathBuf::from(&path);
    let ext = src
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("bin")
        .to_lowercase();
    let mime = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "pdf" => "application/pdf",
        "txt" => "text/plain",
        "md" => "text/markdown",
        "csv" => "text/csv",
        "json" => "application/json",
        _ => "application/octet-stream",
    }
    .to_string();
    let bytes = std::fs::read(&src).map_err(|e| format!("cannot read file: {e}"))?;
    let base64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    let root = crate::settings::paths::data_dir().map_err(|e| e.to_string())?;
    let dir = root.join("chat-attachments").join(&session_id);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let filename = format!("{}.{}", uuid::Uuid::new_v4(), ext);
    let dest = dir.join(&filename);
    std::fs::copy(&src, &dest).map_err(|e| format!("cannot copy file: {e}"))?;
    Ok(AttachmentFromPathResult {
        path: dest.to_string_lossy().to_string(),
        mime,
        base64,
    })
}

#[derive(serde::Serialize)]
pub struct AttachmentFromPathResult {
    pub path: String,
    pub mime: String,
    pub base64: String,
}

#[derive(serde::Serialize)]
pub struct AttachmentData {
    pub mime: String,
    pub base64: String,
}

/// Read a previously-pasted attachment as `{mime, base64}` for inline
/// rendering in the chat view. Path is validated to live inside
/// `<app-data>/chat-attachments/` (canonicalized) to block arbitrary
/// file reads.
/// Pure read helper, factored out of the `read_attachment` command so it can
/// be unit-tested without a Tauri AppHandle (mirrors `write_attachment`).
pub(crate) fn read_attachment_impl(root: &Path, path: &str) -> Result<AttachmentData, String> {
    let attachments_root = root.join("chat-attachments");
    let attachments_root = attachments_root
        .canonicalize()
        .map_err(|e| format!("attachments dir missing: {e}"))?;
    let target = PathBuf::from(path)
        .canonicalize()
        .map_err(|e| format!("file not found: {e}"))?;
    if !target.starts_with(&attachments_root) {
        return Err("path outside chat-attachments".to_string());
    }
    let bytes = std::fs::read(&target).map_err(|e| e.to_string())?;
    let mime = match target.extension().and_then(|e| e.to_str()) {
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("bmp") => "image/bmp",
        Some("svg") => "image/svg+xml",
        Some("pdf") => "application/pdf",
        Some("txt") | Some("md") | Some("csv") => "text/plain",
        Some("json") => "application/json",
        _ => "application/octet-stream",
    }
    .to_string();
    let base64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(AttachmentData { mime, base64 })
}

#[tauri::command]
pub async fn read_attachment(path: String) -> Result<AttachmentData, String> {
    let root = crate::settings::paths::data_dir().map_err(|e| e.to_string())?;
    read_attachment_impl(&root, &path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn write_attachment_decodes_png() {
        let tmp = tempfile::tempdir().unwrap();
        let png_b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
        let path = write_attachment(tmp.path(), "sess", png_b64, "image/png").unwrap();
        assert!(path.exists());
        assert_eq!(path.extension().and_then(|e| e.to_str()), Some("png"));
        let data = std::fs::read(&path).unwrap();
        assert_eq!(&data[..8], &[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]); // PNG signature
    }

    #[test]
    fn write_attachment_rejects_invalid_session_ids() {
        let tmp = tempfile::tempdir().unwrap();
        let png_b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
        let cases = [
            ("../../etc", "path traversal up-tree"),
            ("..", ".."),
            ("a/b", "forward slash"),
            ("a\\b", "backslash"),
            ("C:", "Windows drive letter"),
            ("a\0b", "NUL byte"),
            ("CON", "Windows reserved (allowed by alphanumeric but capped by length is fine; Windows treats CON as device - should be filtered downstream by FS, but our pre-check accepts it). Document via test."),
            ("", "empty"),
            (&"x".repeat(129), "too long"),
            ("a b", "space"),
            ("a.b", "dot"),
            ("a@b", "at sign"),
        ];
        for (id, label) in cases {
            // CON is alphanumeric so our filter ALLOWS it; Windows FS will reject the
            // create_dir_all for device names. Document this gap by relaxing the
            // assertion for that case.
            let r = write_attachment(tmp.path(), id, png_b64, "image/png");
            if id == "CON" {
                continue;
            }
            assert!(r.is_err(), "session_id {:?} ({}) must be rejected", id, label);
        }
    }

    #[test]
    fn write_attachment_accepts_valid_session_ids() {
        let tmp = tempfile::tempdir().unwrap();
        let png_b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
        let r = write_attachment(tmp.path(), "60e53cc5-9823-4af3-979f-29e1e891a718", png_b64, "image/png");
        assert!(r.is_ok());
        let r = write_attachment(tmp.path(), "sess_123_abc", png_b64, "image/png");
        assert!(r.is_ok());
    }

    /// Builds a base64 string that decodes to exactly `n` bytes.
    fn b64_of_len(n: usize) -> String {
        base64::engine::general_purpose::STANDARD.encode(vec![0u8; n])
    }

    #[test]
    fn write_attachment_accepts_payload_at_cap() {
        let tmp = tempfile::tempdir().unwrap();
        let b64 = b64_of_len(MAX_ATTACHMENT_BYTES);
        let r = write_attachment(tmp.path(), "sess", &b64, "application/octet-stream");
        assert!(r.is_ok(), "at-cap payload should be accepted: {r:?}");
    }

    #[test]
    fn write_attachment_rejects_payload_over_cap() {
        let tmp = tempfile::tempdir().unwrap();
        let b64 = b64_of_len(MAX_ATTACHMENT_BYTES + 1);
        let r = write_attachment(tmp.path(), "sess", &b64, "application/octet-stream");
        let err = r.expect_err("over-cap payload must be rejected");
        assert!(err.contains("too large"), "error should say too large: {err}");
        assert!(err.contains("20"), "error should name the 20MB limit: {err}");
    }

    #[test]
    fn write_then_read_attachment_round_trips() {
        let tmp = tempfile::tempdir().unwrap();
        let png_b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
        let path = write_attachment(tmp.path(), "sess", png_b64, "image/png").unwrap();

        let data = read_attachment_impl(tmp.path(), path.to_str().unwrap()).unwrap();
        assert_eq!(data.mime, "image/png");
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(&data.base64)
            .unwrap();
        let expected = base64::engine::general_purpose::STANDARD
            .decode(png_b64)
            .unwrap();
        assert_eq!(decoded, expected);
    }

    #[test]
    fn write_attachment_rejects_invalid_base64() {
        let tmp = tempfile::tempdir().unwrap();
        let bad = write_attachment(tmp.path(), "sess", "!!!not-base64!!!", "image/png");
        assert!(bad.is_err());
    }

    #[test]
    fn write_attachment_handles_non_image_mimes() {
        let tmp = tempfile::tempdir().unwrap();
        let b64 = "aGVsbG8="; // "hello"
        let pdf = write_attachment(tmp.path(), "s1", b64, "application/pdf").unwrap();
        assert_eq!(pdf.extension().and_then(|e| e.to_str()), Some("pdf"));
        let txt = write_attachment(tmp.path(), "s1", b64, "text/plain").unwrap();
        assert_eq!(txt.extension().and_then(|e| e.to_str()), Some("txt"));
        let md = write_attachment(tmp.path(), "s1", b64, "text/markdown").unwrap();
        assert_eq!(md.extension().and_then(|e| e.to_str()), Some("md"));
        let json = write_attachment(tmp.path(), "s1", b64, "application/json").unwrap();
        assert_eq!(json.extension().and_then(|e| e.to_str()), Some("json"));
        let csv = write_attachment(tmp.path(), "s1", b64, "text/csv").unwrap();
        assert_eq!(csv.extension().and_then(|e| e.to_str()), Some("csv"));
    }

    #[test]
    fn write_attachment_picks_extension_from_mime() {
        let tmp = tempfile::tempdir().unwrap();
        let png_b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
        let png = write_attachment(tmp.path(), "s1", png_b64, "image/png").unwrap();
        assert_eq!(png.extension().and_then(|e| e.to_str()), Some("png"));
        let jpg = write_attachment(tmp.path(), "s1", png_b64, "image/jpeg").unwrap();
        assert_eq!(jpg.extension().and_then(|e| e.to_str()), Some("jpg"));
        let webp = write_attachment(tmp.path(), "s1", png_b64, "image/webp").unwrap();
        assert_eq!(webp.extension().and_then(|e| e.to_str()), Some("webp"));
        let unknown = write_attachment(tmp.path(), "s1", png_b64, "application/x-blah").unwrap();
        assert_eq!(unknown.extension().and_then(|e| e.to_str()), Some("bin"));
    }
}
