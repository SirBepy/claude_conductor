//! File/folder picker, editor-open, log, and local-file read/write IPC
//! commands. Single concern: anything that touches the local filesystem or
//! the app log on behalf of the frontend.

use std::path::PathBuf;
use tauri::{AppHandle, Manager, State};

use crate::files;
use crate::state::AppState;

mod open_external_guard;
mod temp_files;
mod write_guard;

use open_external_guard::is_allowed_external_url;
pub use temp_files::*;
use write_guard::{stat_text_file_impl, write_text_file_impl, write_text_file_roots};

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
    list_project_files_routed(project_dir, session_id, &state.cached_instances, state.client().await).await
}

/// `list_project_files` with its two inputs from `AppState` passed in, so a
/// test can drive the mirrored branch with a fake client.
async fn list_project_files_routed<C: crate::ipc::mirror::MirrorReads>(
    project_dir: String,
    session_id: Option<String>,
    instances: &std::sync::Mutex<Vec<crate::types::Instance>>,
    client: Option<C>,
) -> Result<Vec<String>, String> {
    if let Some(client) = crate::ipc::mirror::route_mirrored(instances, session_id.as_deref(), client) {
        let sid = session_id.as_deref().unwrap_or_default();
        return client.list_project_files(sid, &project_dir).await.map_err(|e| e.to_string());
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
///
/// A `line` (and optional `col`) opens the file at that position via
/// `code -g`; the OS-handler fallback has no position, so it opens the file only.
#[tauri::command]
pub async fn open_in_editor(
    app: AppHandle,
    path: String,
    line: Option<u32>,
    col: Option<u32>,
) -> Result<(), String> {
    use std::process::Command;

    // The path can originate in model-written chat text, and `cmd /C` re-parses
    // its arguments, so a metacharacter would run a second command. Refused
    // before any spawn, and before the OS-handler fallback too.
    #[cfg(target_os = "windows")]
    if let Some(c) = cmd_metachar(&path) {
        return Err(format!("open_in_editor: refused path containing {c:?}"));
    }

    let spawned = {
        #[cfg(target_os = "windows")]
        {
            let mut cmd = Command::new("cmd");
            cmd.arg("/C").arg("code").args(editor_args(&path, line, col));
            crate::util::process::hide_console(&mut cmd);
            cmd.spawn().is_ok()
        }
        #[cfg(not(target_os = "windows"))]
        {
            Command::new("code").args(editor_args(&path, line, col)).spawn().is_ok()
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

/// First character of `path` that `cmd.exe` treats as syntax even inside an
/// argument Rust left unquoted (Rust only quotes on spaces/tabs). Pure so it is
/// testable on any OS; only the Windows spawn path calls it. Parentheses and
/// `!` stay allowed: outside an if/for block, and with delayed expansion off
/// (the `cmd /C` default), they are literal, and real paths such as
/// `C:\Program Files (x86)` contain them.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn cmd_metachar(path: &str) -> Option<char> {
    path.chars().find(|c| matches!(c, '&' | '|' | '^' | '%' | '<' | '>' | '"' | '\n' | '\r'))
}

/// Arguments after `code`: the bare path, or `-g path:line[:col]` when a line
/// is known. A column without a line is dropped, since `-g` needs the line.
fn editor_args(path: &str, line: Option<u32>, col: Option<u32>) -> Vec<String> {
    match (line, col) {
        (None, _) => vec![path.to_string()],
        (Some(l), None) => vec!["-g".into(), format!("{path}:{l}")],
        (Some(l), Some(c)) => vec!["-g".into(), format!("{path}:{l}:{c}")],
    }
}

/// Read an arbitrary local image file as `{mime, base64}` for an in-app
/// lightbox. Unlike `read_attachment` (which is sandboxed to the
/// chat-attachments directory), this reads any absolute path the agent
/// surfaced - e.g. a `.png` the model Read. MIME is inferred from the
/// extension; unknown extensions fall back to `application/octet-stream`.
///
/// `session_id` names the chat the image belongs to. For a chat mirrored from
/// a paired machine the file is on THAT machine's disk, so the read goes to
/// the daemon, which forwards it to the host (confined there to raster images
/// under its project roots); a local chat keeps this unrestricted local read.
/// A chat started on a peer seconds ago is not tagged in the cache yet, so a
/// local miss for a chat's image retries once through the daemon, whose
/// pending-owner map already routes that id to its host.
#[tauri::command]
pub async fn read_image_file(
    path: String,
    session_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<crate::ipc::chat::attachments::AttachmentData, String> {
    use base64::Engine;
    if let Some(forwarded) =
        read_image_file_forwarded(&path, session_id.as_deref(), &state.cached_instances, state.client().await).await
    {
        return forwarded;
    }
    let target = match std::path::PathBuf::from(&path).canonicalize() {
        Ok(t) => t,
        Err(e) => {
            let local_err = format!("file not found: {e}");
            let tagged = session_id
                .as_deref()
                .is_some_and(|sid| crate::ipc::chat::history::is_mirrored(&state.cached_instances.lock().unwrap(), sid));
            let Some(sid) = session_id.as_deref().filter(|_| image_retry_via_daemon(true, tagged)) else {
                return Err(local_err);
            };
            let client = state.client().await.ok_or(local_err)?;
            return client.read_image_file(&path, sid).await.map_err(|e| e.to_string());
        }
    };
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

/// The mirrored branch of `read_image_file`: `Some` with the host's answer for
/// a chat mirrored from a paired machine, `None` when the read is local. Split
/// out with its two `AppState` inputs passed in so a test can drive it with a
/// fake client.
async fn read_image_file_forwarded<C: crate::ipc::mirror::MirrorReads>(
    path: &str,
    session_id: Option<&str>,
    instances: &std::sync::Mutex<Vec<crate::types::Instance>>,
    client: Option<C>,
) -> Option<Result<crate::ipc::chat::attachments::AttachmentData, String>> {
    let client = crate::ipc::mirror::route_mirrored(instances, session_id, client)?;
    Some(client.read_image_file(path, session_id.unwrap_or_default()).await.map_err(|e| e.to_string()))
}

/// Whether a local not-found image read retries through the daemon: only for
/// an image that names its chat, and never for one already routed there as
/// mirrored (same rule as the history reads' `should_retry_via_daemon`).
fn image_retry_via_daemon(has_session: bool, tagged_mirrored: bool) -> bool {
    has_session && crate::ipc::chat::history::should_retry_via_daemon(true, tagged_mirrored)
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

/// What the in-app editor needs besides a file's content: its mtime, to
/// notice a change made on disk while it is open, and whether
/// `write_text_file` would accept it.
#[derive(serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct TextFileStamp {
    #[ts(type = "number")]
    pub mtime_us: u64,
    pub writable: bool,
}

/// The editor reads this before `read_text_file`, then polls it while the
/// file is open: cheap enough to poll, unlike re-reading the content.
#[tauri::command]
pub async fn stat_text_file(path: String, state: State<'_, AppState>) -> Result<TextFileStamp, String> {
    let roots = write_text_file_roots(&state);
    tauri::async_runtime::spawn_blocking(move || stat_text_file_impl(&path, &roots))
        .await
        .map_err(|e| format!("stat_text_file join error: {e}"))?
}

/// Overwrite a local text file from the in-app file editor's autosave.
/// The counterpart to `read_text_file`: writes an absolute path, but one
/// confined to a registered project root or the app data dir -
/// not any path on disk. The frontend only enables editing for files that
/// were read whole (not truncated), so a save can never drop a capped tail.
/// `expected_mtime_us` is the stamp the editor last loaded or wrote; the
/// write is refused with `CHANGED_ON_DISK` if the file has moved on since.
#[tauri::command]
pub async fn write_text_file(
    path: String,
    content: String,
    expected_mtime_us: Option<u64>,
    state: State<'_, AppState>,
) -> Result<u64, String> {
    let roots = write_text_file_roots(&state);
    tauri::async_runtime::spawn_blocking(move || write_text_file_impl(&path, &content, expected_mtime_us, &roots))
        .await
        .map_err(|e| format!("write_text_file join error: {e}"))?
}

#[cfg(test)]
mod mirrored_branch_tests {
    use super::*;
    use crate::ipc::mirror::fake::{instance_cache, FakeMirror, PEER_CONTENT, PEER_FILE};

    #[tokio::test]
    async fn a_mirrored_row_lists_the_project_files_through_the_client_by_session_id() {
        let fake = FakeMirror::ok();
        let cache = instance_cache("local-1", "mirror-1");

        let files = list_project_files_routed("C:/peer/repo".into(), Some("mirror-1".into()), &cache, Some(fake.clone()))
            .await
            .unwrap();

        assert_eq!(files, [PEER_FILE]);
        assert_eq!(fake.calls(), [("list_project_files".into(), "mirror-1".into(), "C:/peer/repo".into())]);
    }

    #[tokio::test]
    async fn a_client_error_fails_the_project_files_read() {
        let fake = FakeMirror::failing();
        let cache = instance_cache("local-1", "mirror-1");

        let err = list_project_files_routed("C:/peer/repo".into(), Some("mirror-1".into()), &cache, Some(fake.clone()))
            .await
            .unwrap_err();

        assert!(err.contains("peer unreachable"), "got: {err}");
    }

    #[tokio::test]
    async fn a_mirrored_row_reads_the_image_through_the_client_by_session_id() {
        let fake = FakeMirror::ok();
        let cache = instance_cache("local-1", "mirror-1");

        let data = read_image_file_forwarded("C:/peer/shot.png", Some("mirror-1"), &cache, Some(fake.clone()))
            .await
            .expect("a mirrored row forwards")
            .unwrap();

        assert_eq!(data.base64, PEER_CONTENT);
        assert_eq!(fake.calls(), [("read_image_file".into(), "mirror-1".into(), "C:/peer/shot.png".into())]);
    }

    #[tokio::test]
    async fn a_client_error_fails_the_image_read() {
        let fake = FakeMirror::failing();
        let cache = instance_cache("local-1", "mirror-1");

        let err = read_image_file_forwarded("C:/peer/shot.png", Some("mirror-1"), &cache, Some(fake.clone()))
            .await
            .expect("a mirrored row forwards")
            .map(|d| d.base64)
            .unwrap_err();

        assert!(err.contains("peer unreachable"), "got: {err}");
    }

    #[tokio::test]
    async fn a_local_or_session_less_image_read_never_touches_the_client() {
        let fake = FakeMirror::ok();
        let cache = instance_cache("local-1", "mirror-1");

        assert!(read_image_file_forwarded("C:/x.png", Some("local-1"), &cache, Some(fake.clone())).await.is_none());
        assert!(read_image_file_forwarded("C:/x.png", None, &cache, Some(fake.clone())).await.is_none());
        assert!(fake.calls().is_empty());
    }
}

#[cfg(test)]
mod tests {
    use super::{cmd_metachar, editor_args};

    #[test]
    fn cmd_metacharacters_in_a_path_are_refused() {
        for bad in [r"C:\x&calc.exe", r"C:\x|y", r"C:\x^y", r"C:\%PATH%\a", r"C:\x>out", r"C:\x<in", "C:\\x\"y", "C:\\x\ncalc"] {
            assert!(cmd_metachar(bad).is_some(), "should refuse {bad:?}");
        }
    }

    #[test]
    fn ordinary_paths_with_spaces_and_dots_pass_the_metachar_check() {
        for ok in [r"C:\Users\Joe Doe\my.proj\src\a.test.ts", "C:/a b/c.rs", "/home/joe/p/a-b_c.rs", r"C:\a\b@2+x~.rs", r"C:\Program Files (x86)\App\a.txt", r"C:\x!y\a.rs"] {
            assert_eq!(cmd_metachar(ok), None, "should accept {ok:?}");
        }
    }

    #[test]
    fn editor_args_without_a_line_is_just_the_path() {
        assert_eq!(editor_args(r"C:\a\b.rs", None, None), vec![r"C:\a\b.rs"]);
        assert_eq!(editor_args("/a/b.rs", None, Some(3)), vec!["/a/b.rs"]);
    }

    #[test]
    fn editor_args_with_a_line_uses_goto() {
        assert_eq!(editor_args("/a/b.rs", Some(42), None), vec!["-g", "/a/b.rs:42"]);
        assert_eq!(editor_args("/a/b.rs", Some(42), Some(7)), vec!["-g", "/a/b.rs:42:7"]);
    }

    #[test]
    fn a_missing_chat_image_retries_through_the_daemon_unless_already_routed_there() {
        assert!(super::image_retry_via_daemon(true, false), "a chat not tagged mirrored yet");
        assert!(!super::image_retry_via_daemon(true, true), "already went to the daemon");
        assert!(!super::image_retry_via_daemon(false, false), "no chat to route by");
    }

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
