//! Phone/peer-machine RPC mirror of the desktop `list_project_files` Tauri
//! command (`ipc::files::list_project_files` -> `files::scan`, a pure
//! `git ls-files` wrapper) - the `@`-mention file-autocomplete popup's data
//! source (todo 1022, split from todo 1007's reachability table, which had
//! no daemon RPC for this at all and hid the popup on the phone instead),
//! and Code mode's file tree for a session mirrored from a
//! paired peer machine. `resolve_cwd` (shared with `statusbar.rs`/
//! `worktrees.rs`) resolves `project_dir` from this daemon's own session
//! registry when `session_id` is given (ignoring any client-supplied path),
//! else gates the legacy phone call shape with `reject_unknown` - without
//! either a remote client could point `git ls-files` at any path on disk.

use super::pr_review::resolve_cwd_for;
use crate::daemon::rpc::{Router, RpcError};
use crate::daemon::state::DaemonState;
use serde_json::json;
use std::path::PathBuf;
use std::sync::Arc;

pub fn register_files(router: &mut Router, state: Arc<DaemonState>) {
    router.register("list_project_files", move |params, ctx| {
        let state = state.clone();
        let transport = ctx.transport.clone();
        async move {
            #[derive(serde::Deserialize)]
            struct P {
                project_dir: String,
                #[serde(default)]
                session_id: Option<String>,
            }
            let p: P = serde_json::from_value(params.unwrap_or(serde_json::Value::Null))
                .map_err(|e| RpcError::invalid_params(e.to_string()))?;
            let project_dir = resolve_cwd_for(&state, &transport, p.project_dir, p.session_id.as_deref())?;
            let dir = PathBuf::from(project_dir);
            let files = tokio::task::spawn_blocking(move || crate::files::scan(&dir))
                .await
                .map_err(|e| RpcError::internal(format!("join: {e}")))?
                .map_err(RpcError::internal)?;
            Ok(json!(files))
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
    use serde_json::json;

    fn dummy_ctx() -> ConnectionContext {
        let (tx, _rx) = tokio::sync::mpsc::channel(16);
        ConnectionContext::new(tx)
    }

    fn state() -> Arc<DaemonState> {
        DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()))
    }

    async fn call(state: Arc<DaemonState>, params: serde_json::Value) -> crate::daemon::rpc::Response {
        let mut r = Router::new();
        register_files(&mut r, state);
        r.dispatch(
            Request {
                jsonrpc: "2.0".into(),
                id: json!(1),
                method: "list_project_files".into(),
                params: Some(params),
            },
            dummy_ctx(),
        )
        .await
    }

    /// The security boundary: without `reject_unknown`, a remote client could
    /// point `git ls-files` at any directory on disk (todo 1022's whole reason
    /// for gating this the same way `statusbar.rs`/`worktrees.rs` do).
    #[tokio::test]
    async fn rejects_an_unknown_project_dir() {
        let resp = call(state(), json!({"project_dir": "C:\\nope\\not\\registered"})).await;
        assert!(resp.error.is_some(), "unknown project_dir must be rejected");
    }

    #[tokio::test]
    async fn dispatches_for_a_known_project_dir() {
        let st = state();
        let cwd = std::env::current_dir().unwrap();
        st.settings.upsert_project_for_cwd(&cwd, "2026-01-01T00:00:00Z");
        let resp = call(st, json!({"project_dir": cwd.to_string_lossy()})).await;
        assert!(resp.error.is_none(), "got {:?}", resp.error);
        assert!(resp.result.as_ref().map(serde_json::Value::is_array).unwrap_or(false));
    }

    /// Code mode's file tree for a session mirrored from a
    /// paired peer carries a `session_id` this daemon owns but no
    /// `project_dir` it would otherwise recognize - `resolve_cwd` must
    /// resolve the real path from the registry instead of rejecting it.
    #[tokio::test]
    async fn dispatches_via_session_id_with_an_unknown_project_dir() {
        use crate::sessions::kinds::InstanceKind;
        use crate::sessions::registry::RegisterInput;

        let st = state();
        let settings = std::sync::Mutex::new(Settings::default());
        let real_cwd = std::env::current_dir().unwrap();
        st.registry.register(
            RegisterInput {
                session_id: "s1".into(),
                cwd: real_cwd,
                pid: 1,
                kind: InstanceKind::Interactive,
                is_remote: false,
                transcript_path: None,
                started_at: "2026-01-01T00:00:00Z".into(),
            },
            &settings,
            "2026-01-01T00:00:00Z",
        );
        let resp = call(st, json!({"project_dir": "C:\\nope\\not\\registered", "session_id": "s1"})).await;
        assert!(resp.error.is_none(), "got {:?}", resp.error);
        assert!(resp.result.as_ref().map(serde_json::Value::is_array).unwrap_or(false));
    }
}
