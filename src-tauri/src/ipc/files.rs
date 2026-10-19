//! File/folder picker, editor-open, log, and local-file read/write IPC
//! commands. Single concern: anything that touches the local filesystem or
//! the app log on behalf of the frontend.

use std::path::PathBuf;
use tauri::{AppHandle, Manager, State};

use crate::files;
use crate::ipc::mirror::mirrored_client;
use crate::state::AppState;

/// `pub(crate)` pure local read, reused directly by the daemon's own
/// `list_project_files` RPC handler (`daemon/methods/files.rs`) - see
/// `ipc::git::get_git_dirty_local`'s doc for why the Tauri-facing wrapper
/// below is split out from this one.
pub(crate) async fn list_project_files_local(project_dir: String) -> Result<Vec<String>, String> {
    let p = PathBuf::from(project_dir);
    tauri::async_runtime::spawn_blocking(move || files::scan(&p))
        .await
        .map_err(|e| e.to_string())?
}

/// Tauri-facing command: routes to the owning peer when `session_id`
/// resolves to a mirrored session (G10, docs/multi-machine.md), else runs
/// the same local scan as before - used by Code mode's file tree/quick-open
/// and the chat composer's `@`-mention autocomplete.
#[tauri::command]
pub async fn list_project_files(
    project_dir: String,
    session_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<String>, String> {
    if let Some(client) = mirrored_client(&state, session_id.as_deref()).await {
        return client
            .list_project_files(session_id.as_deref().unwrap(), &project_dir)
            .await
            .map_err(|e| e.to_string());
    }
    list_project_files_local(project_dir).await
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

/// True if `url` is one Conductor's own shell opener may receive. Scoped to
/// what the app's callers actually pass (grepped `src/`): an `http(s)://`
/// link (news items, the update-available link, waiting-on chips, the
/// dev-server popover) or a `mailto:` link, or a local file on a drive path
/// (a bare path, or a `file:` URL from a chat link) - the preview panel's
/// "Open in browser" passes the temp file `write_temp_file` just wrote. A
/// local file must exist and must not be an executable or script type, and
/// every other scheme and any UNC share is refused, so an XSS bug or an
/// AI-authored link that reaches this command can't launch a program.
fn is_allowed_external_url(url: &str) -> bool {
    // Checked on the untrimmed string: `trim()` itself strips a trailing
    // control char like `\n`, which would otherwise let one slip through
    // the check below unnoticed.
    if url.is_empty() || url.chars().any(|c| c.is_control()) {
        return false;
    }
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return false;
    }
    let lower = trimmed.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") || lower.starts_with("mailto:") {
        // Embedded whitespace is an argument-injection / scheme-confusion
        // surface that a well-formed URL never needs.
        return !trimmed.chars().any(|c| c.is_whitespace());
    }
    // Chat links to local files (`file:///C:/.../shot.png`) are a working
    // affordance, so a file: URL is judged as the path it names.
    let local = if lower.starts_with("file:///") {
        &trimmed[8..]
    } else if lower.starts_with("file://") {
        &trimmed[7..]
    } else {
        trimmed
    };
    // A Windows drive path ("C:\..." / "C:/...") contains a colon but is not
    // a URI scheme - check that before the generic scheme guard below, or
    // every local path on this OS would be misread as an unknown scheme.
    let bytes = local.as_bytes();
    let is_drive_path = bytes.len() > 2
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'\\' | b'/');
    if !is_drive_path {
        return false; // javascript:, data:, UNC shares, relative paths, any other scheme
    }
    is_openable_local_file(std::path::Path::new(local))
}

/// The shell opener runs a program for an executable or script, so a link
/// (AI-authored chat text included) may only open an existing file of a
/// type that the OS hands to a viewer, never one it executes.
fn is_openable_local_file(path: &std::path::Path) -> bool {
    const EXECUTABLE: &[&str] = &[
        "exe", "com", "bat", "cmd", "ps1", "psm1", "vbs", "vbe", "js", "jse", "wsf", "wsh", "msi",
        "msp", "scr", "pif", "cpl", "hta", "lnk", "url", "reg", "jar", "appref-ms", "application",
        "gadget", "msc", "inf", "sys", "dll",
    ];
    let Ok(target) = path.canonicalize() else { return false };
    if !target.is_file() {
        return false;
    }
    let ext = target.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    !ext.is_empty() && !EXECUTABLE.contains(&ext.as_str())
}

#[tauri::command]
pub async fn open_external(app: AppHandle, url: String) -> Result<(), String> {
    if !is_allowed_external_url(&url) {
        return Err(format!("open_external: refused to open {url:?}"));
    }
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
    let ext = target.extension().and_then(|e| e.to_str()).unwrap_or("");
    // Shared map; unknown extension keeps this caller's own fallback rather
    // than one baked into `mime_for_ext` itself.
    let mime = crate::ipc::chat::attachments::mime_for_ext(ext)
        .unwrap_or("application/octet-stream")
        .to_string();
    let base64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(crate::ipc::chat::attachments::AttachmentData { mime, base64 })
}

/// Max bytes `read_text_file` returns. Files larger than this are returned
/// truncated (capped prefix + `truncated: true`) so the in-app read-only file
/// viewer never tries to highlight a multi-megabyte blob. Mirrors the spirit
/// of `read_image_file` (which reads any absolute path the agent surfaced).
const TEXT_FILE_CAP_BYTES: usize = 2 * 1024 * 1024; // 2 MB

#[derive(serde::Serialize, serde::Deserialize, ts_rs::TS)]
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

/// Roots `write_text_file` may write under: every registered project's
/// directory, plus the app data dir (for the app's own files, e.g. a
/// settings/export doc opened through the same editor). Canonicalized so a
/// `..` or a symlink/junction can't walk the write outside either (todo
/// 1212). A root that no longer exists on disk (deleted project folder,
/// data dir not yet created) is silently skipped rather than failing the
/// whole write.
fn write_text_file_roots(state: &AppState) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Ok(dir) = crate::settings::paths::ensure_data_dir() {
        if let Ok(c) = dir.canonicalize() {
            roots.push(c);
        }
    }
    if let Ok(settings) = state.settings.lock() {
        for p in &settings.projects {
            if let Ok(c) = p.path.canonicalize() {
                roots.push(c);
            }
        }
    }
    roots
}

/// Pure core of `write_text_file`: canonicalizes `path` and requires it land
/// under one of `roots` (already-canonicalized), so the Tauri command can be
/// tested without spinning up a Tauri `AppState`/DB.
fn write_text_file_impl(path: &str, content: &str, roots: &[PathBuf]) -> Result<(), String> {
    let target = PathBuf::from(path)
        .canonicalize()
        .map_err(|e| format!("file not found: {e}"))?;
    if !roots.iter().any(|root| target.starts_with(root)) {
        return Err(
            "write_text_file: path is outside every registered project root and the app data dir"
                .to_string(),
        );
    }
    std::fs::write(&target, content).map_err(|e| e.to_string())
}

/// Overwrite a local text file from the in-app file editor (ai_todo 95 slice 3).
/// The counterpart to `read_text_file`: writes an absolute path, but one
/// confined to a registered project root or the app data dir -
/// not any path on disk. The frontend only enables editing for files that
/// were read whole (not truncated), so a save can never drop a capped tail.
#[tauri::command]
pub async fn write_text_file(
    path: String,
    content: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let roots = write_text_file_roots(&state);
    tauri::async_runtime::spawn_blocking(move || write_text_file_impl(&path, &content, &roots))
        .await
        .map_err(|e| format!("write_text_file join error: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::{is_allowed_external_url, read_log_contents, write_text_file_impl};
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

    // ── open_external scheme/path allowlist ─────────────────────────────

    #[test]
    fn accepts_https_and_http_and_mailto() {
        assert!(is_allowed_external_url("https://example.com/releases"));
        assert!(is_allowed_external_url("http://localhost:4173"));
        assert!(is_allowed_external_url("mailto:joe@example.com"));
    }

    #[test]
    fn rejects_an_exe_path() {
        // The exact case named in the todo's acceptance criteria.
        assert!(!is_allowed_external_url("C:\\x.exe"));
    }

    fn temp_file_with_ext(ext: &str) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!("open-external-test-{}.{ext}", uuid::Uuid::new_v4()));
        std::fs::write(&path, "x").unwrap();
        path
    }

    #[test]
    fn rejects_an_existing_executable_or_script_by_path_or_file_url() {
        for ext in ["exe", "bat", "cmd", "ps1", "lnk", "hta"] {
            let path = temp_file_with_ext(ext);
            let raw = path.to_str().unwrap().to_string();
            let url = format!("file:///{}", raw.replace('\\', "/"));
            let (as_path, as_url) = (is_allowed_external_url(&raw), is_allowed_external_url(&url));
            let _ = std::fs::remove_file(&path);
            assert!(!as_path && !as_url, "{ext} must never be handed to the shell opener");
        }
    }

    #[test]
    fn accepts_an_existing_viewable_file_by_path_or_file_url() {
        let path = temp_file_with_ext("png");
        let raw = path.to_str().unwrap().to_string();
        let url = format!("file:///{}", raw.replace('\\', "/"));
        let (as_path, as_url) = (is_allowed_external_url(&raw), is_allowed_external_url(&url));
        let _ = std::fs::remove_file(&path);
        assert!(as_path && as_url, "a chat link to a screenshot keeps opening");
    }

    #[test]
    fn rejects_a_missing_file_and_a_non_drive_file_url() {
        assert!(!is_allowed_external_url("file:///C:/definitely-missing-file.png"));
        assert!(!is_allowed_external_url("file:///etc/passwd"));
    }

    #[test]
    fn rejects_javascript_and_data_schemes() {
        assert!(!is_allowed_external_url("javascript:alert(1)"));
        assert!(!is_allowed_external_url("data:text/html,<script>1</script>"));
    }

    #[test]
    fn rejects_a_unc_share() {
        assert!(!is_allowed_external_url("\\\\attacker\\share\\payload.exe"));
    }

    #[test]
    fn rejects_whitespace_and_control_chars_in_an_http_url() {
        assert!(!is_allowed_external_url("http://example.com/ x"));
        assert!(!is_allowed_external_url("http://example.com/\n"));
        assert!(!is_allowed_external_url(""));
    }

    #[test]
    fn accepts_this_apps_own_temp_preview_file() {
        // Mirrors exactly what write_temp_file() produces and what
        // preview-panel.ts's "Open in browser" then passes to open_external.
        let path = std::env::temp_dir().join(format!("claude-conductor-{}.html", uuid::Uuid::new_v4()));
        std::fs::write(&path, "<html></html>").unwrap();
        let ok = is_allowed_external_url(path.to_str().unwrap());
        let _ = std::fs::remove_file(&path);
        assert!(ok, "temp preview file should be allowed");
    }

    // ── write_text_file project-root/app-data confinement ───────────────────

    #[test]
    fn accepts_a_write_inside_a_registered_root() {
        let root = tempdir().unwrap();
        let file = root.path().join("notes.txt");
        std::fs::write(&file, "old").unwrap();
        let roots = vec![root.path().canonicalize().unwrap()];
        write_text_file_impl(file.to_str().unwrap(), "new", &roots).unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "new");
    }

    #[test]
    fn accepts_a_write_in_a_subdirectory_of_a_registered_root() {
        let root = tempdir().unwrap();
        let sub = root.path().join("src");
        std::fs::create_dir_all(&sub).unwrap();
        let file = sub.join("main.rs");
        std::fs::write(&file, "old").unwrap();
        let roots = vec![root.path().canonicalize().unwrap()];
        write_text_file_impl(file.to_str().unwrap(), "new", &roots).unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "new");
    }

    #[test]
    fn rejects_a_write_outside_every_registered_root() {
        let root = tempdir().unwrap();
        let outside = tempdir().unwrap();
        let file = outside.path().join("secret.txt");
        std::fs::write(&file, "old").unwrap();
        let roots = vec![root.path().canonicalize().unwrap()];
        let err = write_text_file_impl(file.to_str().unwrap(), "pwned", &roots).unwrap_err();
        assert!(err.contains("outside"), "got: {err}");
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "old", "file must be untouched");
    }

    #[test]
    fn rejects_a_target_that_does_not_exist() {
        let root = tempdir().unwrap();
        let missing = root.path().join("does-not-exist.txt");
        let roots = vec![root.path().canonicalize().unwrap()];
        assert!(write_text_file_impl(missing.to_str().unwrap(), "x", &roots).is_err());
    }
}
