//! `read_image_file` RPC: the remote-callable counterpart of the desktop's
//! `read_image_file` Tauri command, so a chat mirrored from a paired machine
//! can show an image that lives on the HOST's disk (an `ask_user_question`
//! option preview, an agent-surfaced image in the status bar).
//!
//! The desktop command reads any absolute path the local user's own agent
//! surfaced. A remote caller (phone or paired peer) must not inherit that: a
//! token holder could otherwise pull `~/.ssh/...`-style files by naming them.
//! So this handler refuses everything except a small raster image that sits
//! under a place the host already treats as the chat's own: a registered
//! project root, a session's cwd, or its chat-attachments dir.

use crate::daemon::machines::is_local_session;
use crate::daemon::rpc::{Router, RpcError, Transport};
use crate::daemon::state::DaemonState;
use crate::ipc::chat::attachments::{mime_for_ext, AttachmentData};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// Largest image served. A screenshot or generated mock is well under this;
/// the cap keeps one call from base64-ing a multi-hundred-MB file over the wire.
const MAX_IMAGE_BYTES: u64 = 20 * 1024 * 1024;

/// svg is excluded on purpose: it can carry script and external references.
const RASTER_EXTS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "bmp"];

fn raster_ext(path: &Path) -> Option<String> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    RASTER_EXTS.contains(&ext.as_str()).then_some(ext)
}

/// Pure guarded read. `roots` need not be canonical; each is canonicalized by
/// the confinement check, and a root that no longer exists is skipped.
pub(crate) fn read_raster_under(roots: &[PathBuf], path: &str) -> Result<AttachmentData, String> {
    use base64::Engine;
    let requested = PathBuf::from(path);
    if raster_ext(&requested).is_none() {
        return Err("not a raster image (png, jpg, gif, webp, bmp)".to_string());
    }
    // `canonicalize` resolves `..` and symlinks, so the prefix check below
    // runs on where the bytes really live.
    let target = requested.canonicalize().map_err(|e| format!("file not found: {e}"))?;
    // A symlink named `x.png` can point at any file: judge the real target.
    let Some(ext) = raster_ext(&target) else {
        return Err("not a raster image (png, jpg, gif, webp, bmp)".to_string());
    };
    if !roots.iter().any(|r| crate::util::path::confine_absolute(r, &target).is_ok()) {
        return Err("path is outside every project root and chat attachments dir".to_string());
    }
    let meta = std::fs::metadata(&target).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("not a file".to_string());
    }
    if meta.len() > MAX_IMAGE_BYTES {
        return Err(format!("image too large: {} bytes (max {MAX_IMAGE_BYTES})", meta.len()));
    }
    let bytes = std::fs::read(&target).map_err(|e| e.to_string())?;
    let mime = mime_for_ext(&ext).unwrap_or("application/octet-stream").to_string();
    Ok(AttachmentData { mime, base64: base64::engine::general_purpose::STANDARD.encode(bytes) })
}

/// Registered project folders, every session's cwd, and the host's own
/// chat-attachments dir.
fn allowed_roots(state: &DaemonState) -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = state.settings.snapshot().projects.into_iter().map(|p| p.path).collect();
    roots.extend(state.registry.list().into_iter().map(|i| i.cwd));
    if let Ok(dir) = crate::settings::paths::data_dir() {
        roots.push(dir.join("chat-attachments"));
    }
    roots
}

pub fn register_image_read(router: &mut Router, state: Arc<DaemonState>) {
    // `session_id` is optional for a phone, which names no chat. For a peer
    // machine it is required and must be a chat hosted here: the peer reads
    // images for the chat it mirrors, nothing else. It also lets
    // `machines/forward.rs::extract_session_id` route a mirrored chat's call
    // to the host before this handler runs.
    router.register("read_image_file", move |params, ctx| {
        let state = state.clone();
        async move {
            #[derive(serde::Deserialize)]
            struct P {
                path: String,
                #[serde(default)]
                session_id: Option<String>,
            }
            let p: P = serde_json::from_value(params.unwrap_or(Value::Null))
                .map_err(|e| RpcError::invalid_params(e.to_string()))?;
            if matches!(ctx.transport, Transport::PeerMachine(_)) {
                let sid = p
                    .session_id
                    .as_deref()
                    .ok_or_else(|| RpcError::invalid_params("session_id is required"))?;
                if !is_local_session(&state, sid) {
                    return Err(RpcError::invalid_params("unknown session_id"));
                }
            }
            let roots = allowed_roots(&state);
            let data = tokio::task::spawn_blocking(move || read_raster_under(&roots, &p.path))
                .await
                .map_err(|e| RpcError::internal(e.to_string()))?
                .map_err(RpcError::invalid_params)?;
            Ok(json!(data))
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    const PNG: &[u8] = &[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];

    fn project_with_png() -> (tempfile::TempDir, PathBuf) {
        let dir = tempdir().unwrap();
        let png = dir.path().join("shot.png");
        std::fs::write(&png, PNG).unwrap();
        (dir, png)
    }

    #[test]
    fn serves_a_png_under_a_project_root() {
        let (dir, png) = project_with_png();
        let data = read_raster_under(&[dir.path().to_path_buf()], png.to_str().unwrap()).unwrap();
        assert_eq!(data.mime, "image/png");
        assert!(!data.base64.is_empty());
    }

    #[test]
    fn refuses_a_path_outside_every_root() {
        let (_dir, png) = project_with_png();
        let other = tempdir().unwrap();
        let err = read_raster_under(&[other.path().to_path_buf()], png.to_str().unwrap()).err().expect("must be refused");
        assert!(err.contains("outside"), "{err}");
    }

    #[test]
    fn refuses_a_non_raster_extension_even_inside_a_root() {
        let dir = tempdir().unwrap();
        for name in ["secrets.txt", "icon.svg", "key", "a.png.exe"] {
            let f = dir.path().join(name);
            std::fs::write(&f, b"x").unwrap();
            let err = read_raster_under(&[dir.path().to_path_buf()], f.to_str().unwrap()).err().expect("must be refused");
            assert!(err.contains("not a raster"), "{name}: {err}");
        }
    }

    /// `<root>/sub/../../outside/x.png` names a file beside the root; the
    /// canonical form is outside, so the textual prefix must not be trusted.
    #[test]
    fn refuses_a_dotdot_escape() {
        let parent = tempdir().unwrap();
        let root = parent.path().join("proj");
        let outside = parent.path().join("outside");
        std::fs::create_dir_all(root.join("sub")).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("x.png"), PNG).unwrap();
        let sneaky = root.join("sub").join("..").join("..").join("outside").join("x.png");
        let err = read_raster_under(&[root], sneaky.to_str().unwrap()).err().expect("must be refused");
        assert!(err.contains("outside"), "{err}");
    }

    #[test]
    fn refuses_a_file_over_the_size_cap() {
        let dir = tempdir().unwrap();
        let big = dir.path().join("big.png");
        let f = std::fs::File::create(&big).unwrap();
        f.set_len(MAX_IMAGE_BYTES + 1).unwrap();
        let err = read_raster_under(&[dir.path().to_path_buf()], big.to_str().unwrap()).err().expect("must be refused");
        assert!(err.contains("too large"), "{err}");
    }

    #[test]
    fn a_missing_file_is_not_found_not_a_panic() {
        let dir = tempdir().unwrap();
        let gone = dir.path().join("gone.png");
        assert!(read_raster_under(&[dir.path().to_path_buf()], gone.to_str().unwrap()).is_err());
    }

    async fn call_as(state: Arc<DaemonState>, transport: Transport, params: Value) -> crate::daemon::rpc::Response {
        use crate::daemon::rpc::{ConnectionContext, Request, TRANSPORT};
        let mut router = Router::new();
        register_image_read(&mut router, state);
        TRANSPORT
            .scope(transport, async {
                let (tx, _rx) = tokio::sync::mpsc::channel(16);
                router
                    .dispatch(
                        Request { jsonrpc: "2.0".into(), id: json!(1), method: "read_image_file".into(), params: Some(params) },
                        ConnectionContext::new(tx),
                    )
                    .await
            })
            .await
    }

    fn state() -> Arc<DaemonState> {
        use crate::daemon::session::new_session_map;
        use crate::daemon::settings_cache::SettingsCache;
        DaemonState::new(new_session_map(), SettingsCache::new(crate::types::Settings::default()))
    }

    /// The handler is what a peer actually reaches: it must name a chat this
    /// machine hosts, and the image must sit under that chat's (or another
    /// registered) folder.
    #[tokio::test]
    async fn a_peer_must_name_a_chat_hosted_here_and_stay_inside_its_roots() {
        let (dir, png) = project_with_png();
        let st = state();
        st.registry.upsert_interactive("s1", dir.path(), "proj", "2026-10-23T00:00:00Z");
        let peer = Transport::PeerMachine("mach-b".into());
        let path = png.to_str().unwrap();

        let no_session = call_as(st.clone(), peer.clone(), json!({"path": path})).await;
        assert!(no_session.error.is_some(), "a peer without a session_id must be refused");

        let unknown = call_as(st.clone(), peer.clone(), json!({"path": path, "session_id": "not-hosted-here"})).await;
        assert!(unknown.error.is_some(), "a session this machine does not host must be refused");

        let ok = call_as(st.clone(), peer.clone(), json!({"path": path, "session_id": "s1"})).await;
        assert_eq!(ok.result.expect("served")["mime"], "image/png");

        let elsewhere = tempdir().unwrap();
        let stray = elsewhere.path().join("stray.png");
        std::fs::write(&stray, PNG).unwrap();
        let outside = call_as(st, peer, json!({"path": stray.to_str().unwrap(), "session_id": "s1"})).await;
        assert!(outside.error.is_some(), "an image outside every root must be refused for a peer");
    }
}
