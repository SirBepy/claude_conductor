//! Live tail for a `waiting_on` local-process log path (todo 675 layer 3).
//! `path` was already validated once at MCP ingest, in a DIFFERENT process
//! against that process's own cwd - this RPC is what actually opens the
//! file and is remote-reachable directly, so it re-validates from scratch.

use crate::daemon::rpc::{Router, RpcError};
use crate::daemon::state::DaemonState;
use crate::mcp::server::waiting_target::safe_local_path;
use serde_json::json;
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;
use std::sync::Arc;

/// Cap one read so a huge or rotated log can't blow up the response.
const MAX_READ_BYTES: u64 = 256 * 1024;
/// First poll (no offset yet) shows only the tail, not the whole file.
const INITIAL_TAIL_BYTES: u64 = 8 * 1024;

/// Same two roots `default_roots` grants at MCP ingest (session cwd + app
/// log dir), but resolved from the REGISTRY's record of cwd rather than
/// `std::env::current_dir()` - this RPC runs in the single daemon process,
/// not a per-session MCP child, so process cwd is meaningless here.
fn roots_for_session(state: &DaemonState, session_id: &str) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(inst) = state.registry.get(session_id) {
        roots.push(inst.cwd);
    }
    if let Ok(f) = crate::settings::paths::log_file() {
        if let Some(dir) = f.parent() {
            roots.push(dir.to_path_buf());
        }
    }
    roots
}

fn read_tail(path: &std::path::Path, offset: Option<u64>) -> Result<(String, u64), String> {
    let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let len = file.metadata().map_err(|e| e.to_string())?.len();
    let start = match offset {
        Some(o) => o.min(len),
        None => len.saturating_sub(INITIAL_TAIL_BYTES),
    };
    file.seek(SeekFrom::Start(start)).map_err(|e| e.to_string())?;
    let cap = (len - start).min(MAX_READ_BYTES) as usize;
    let mut buf = vec![0u8; cap];
    file.read_exact(&mut buf).map_err(|e| e.to_string())?;
    Ok((String::from_utf8_lossy(&buf).into_owned(), start + cap as u64))
}

pub fn register_waiting_tail(router: &mut Router, state: Arc<DaemonState>) {
    router.register("tail_waiting_log", move |params, _ctx| {
        let state = state.clone();
        async move {
            #[derive(serde::Deserialize)]
            struct P {
                session_id: String,
                path: String,
                #[serde(default)]
                offset: Option<u64>,
            }
            let p: P = serde_json::from_value(params.unwrap_or(serde_json::Value::Null))
                .map_err(|e| RpcError::invalid_params(e.to_string()))?;
            let roots = roots_for_session(&state, &p.session_id);
            let real = safe_local_path(&p.path, &roots)
                .ok_or_else(|| RpcError::invalid_params("path outside the allowed area".to_string()))?;
            let offset = p.offset;
            let (content, new_offset) = tokio::task::spawn_blocking(move || {
                read_tail(std::path::Path::new(&real), offset)
            })
            .await
            .map_err(|e| RpcError::internal(e.to_string()))?
            .map_err(RpcError::internal)?;
            Ok(json!({ "content": content, "offset": new_offset }))
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::rpc::{ConnectionContext, Request};
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::types::Settings;
    use std::io::Write;

    fn dummy_ctx() -> ConnectionContext {
        let (tx, _rx) = tokio::sync::mpsc::channel(16);
        ConnectionContext::new(tx)
    }

    async fn call(state: Arc<DaemonState>, params: serde_json::Value) -> crate::daemon::rpc::Response {
        let mut r = Router::new();
        register_waiting_tail(&mut r, state);
        r.dispatch(
            Request { jsonrpc: "2.0".into(), id: json!(1), method: "tail_waiting_log".into(), params: Some(params) },
            dummy_ctx(),
        )
        .await
    }

    fn test_state() -> Arc<DaemonState> {
        DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()))
    }

    /// The load-bearing case: a session's own cwd never registered with this
    /// path must reject it, even though the file genuinely exists on disk.
    #[tokio::test]
    async fn a_path_outside_the_session_roots_is_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        let outside = tmp.path().join("secret.txt");
        writeln!(std::fs::File::create(&outside).unwrap(), "nope").unwrap();

        // No session registered at all -> roots_for_session yields no cwd root,
        // only the (unrelated) app log dir - the file must not be readable.
        let resp = call(
            test_state(),
            json!({"session_id": "unknown-session", "path": outside.to_str().unwrap()}),
        )
        .await;
        assert!(resp.error.is_some(), "a path outside every known root must be rejected");
    }

    #[tokio::test]
    async fn a_path_inside_the_registered_sessions_cwd_is_readable() {
        let state = test_state();
        let tmp = tempfile::tempdir().unwrap();
        let cwd = tmp.path().join("session-cwd");
        std::fs::create_dir_all(&cwd).unwrap();
        let log = cwd.join("build.log");
        writeln!(std::fs::File::create(&log).unwrap(), "hello world").unwrap();

        let settings = std::sync::Mutex::new(Settings::default());
        state.registry.record_interactive_session("s", &cwd, &settings, "2026-08-18T00:00:00Z");

        let resp = call(state, json!({"session_id": "s", "path": log.to_str().unwrap()})).await;
        assert!(resp.error.is_none(), "a path inside the session's own cwd must be readable");
        let result = resp.result.unwrap();
        assert!(result["content"].as_str().unwrap().contains("hello world"));
    }

    #[tokio::test]
    async fn dot_dot_traversal_out_of_the_session_cwd_is_rejected() {
        let state = test_state();
        let tmp = tempfile::tempdir().unwrap();
        let cwd = tmp.path().join("session-cwd");
        let outside = tmp.path().join("elsewhere");
        std::fs::create_dir_all(&cwd).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        let secret = outside.join("secret.txt");
        writeln!(std::fs::File::create(&secret).unwrap(), "nope").unwrap();

        let settings = std::sync::Mutex::new(Settings::default());
        state.registry.record_interactive_session("s", &cwd, &settings, "2026-08-18T00:00:00Z");

        let traversal = cwd.join("..").join("elsewhere").join("secret.txt");
        let resp = call(state, json!({"session_id": "s", "path": traversal.to_str().unwrap()})).await;
        assert!(resp.error.is_some(), "`..` escaping the session's cwd must be rejected");
    }

    #[test]
    fn read_tail_with_no_offset_returns_only_the_recent_tail() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("big.log");
        let mut f = std::fs::File::create(&file).unwrap();
        let body = "x".repeat((INITIAL_TAIL_BYTES * 3) as usize);
        f.write_all(body.as_bytes()).unwrap();
        let (content, offset) = read_tail(&file, None).unwrap();
        assert_eq!(content.len() as u64, INITIAL_TAIL_BYTES);
        assert_eq!(offset, body.len() as u64);
    }

    #[test]
    fn read_tail_resumes_from_a_given_offset() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("small.log");
        std::fs::write(&file, "0123456789").unwrap();
        let (content, offset) = read_tail(&file, Some(5)).unwrap();
        assert_eq!(content, "56789");
        assert_eq!(offset, 10);
    }
}
