//! PR-review git RPCs (ai_todo 244): mirror the desktop `ipc::git_diff`
//! Tauri commands so the phone PR modal's Commits/Files tabs work remotely.
//! Same registration pattern as `daemon/methods/worktrees.rs` (ai_todo 434).

use crate::daemon::rpc::{Router, RpcError};
use crate::daemon::state::DaemonState;
use crate::settings::identity::project_key;
use serde_json::json;
use std::sync::Arc;

// Must match a project the daemon already knows, so a remote client can't
// point git at an arbitrary path. Shared with `worktrees.rs`, which is in the
// same SAFE_METHODS set and shipped without this gate (fixed 2026-08-12).
pub(super) fn is_known_cwd(state: &DaemonState, cwd: &str) -> bool {
    let key = project_key(std::path::Path::new(cwd));
    state.registry.list().iter().any(|i| project_key(&i.cwd) == key)
        || state.settings.snapshot().projects.iter().any(|p| project_key(&p.path) == key)
}

// Canonical wrapper: was independently re-copied into `statusbar.rs` and
// `worktrees.rs` (ai_todo 636). Call BEFORE any filesystem access on `cwd`.
pub(super) fn reject_unknown(state: &DaemonState, cwd: &str) -> Result<(), RpcError> {
    if is_known_cwd(state, cwd) {
        Ok(())
    } else {
        Err(RpcError::invalid_params("unknown cwd".to_string()))
    }
}

pub fn register_pr_review(router: &mut Router, state: Arc<DaemonState>) {
    {
        let state = state.clone();
        router.register("get_range_files", move |params, _ctx| {
            let state = state.clone();
            async move {
                #[derive(serde::Deserialize)]
                struct P { cwd: String, from: Option<String>, to: String }
                let p: P = serde_json::from_value(params.unwrap_or(serde_json::Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                if !is_known_cwd(&state, &p.cwd) {
                    return Err(RpcError::invalid_params("unknown cwd".to_string()));
                }
                let files = crate::ipc::git_diff::get_range_files(p.cwd, p.from, p.to)
                    .await
                    .map_err(RpcError::internal)?;
                Ok(json!(files))
            }
        });
    }

    router.register("get_file_diff", move |params, _ctx| {
        let state = state.clone();
        async move {
            #[derive(serde::Deserialize)]
            struct P { cwd: String, from: Option<String>, to: String, path: String }
            let p: P = serde_json::from_value(params.unwrap_or(serde_json::Value::Null))
                .map_err(|e| RpcError::invalid_params(e.to_string()))?;
            if !is_known_cwd(&state, &p.cwd) {
                return Err(RpcError::invalid_params("unknown cwd".to_string()));
            }
            let diff = crate::ipc::git_diff::get_file_diff(p.cwd, p.from, p.to, p.path)
                .await
                .map_err(RpcError::internal)?;
            Ok(json!(diff))
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

    fn dummy_state() -> Arc<DaemonState> {
        DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()))
    }

    #[tokio::test]
    async fn get_range_files_rejects_unknown_cwd() {
        // Guards ai_todo 244's security note: a remote client must not be able
        // to point git diff at an arbitrary host path the daemon has never
        // seen for this session/project.
        let mut r = Router::new();
        register_pr_review(&mut r, dummy_state());
        let resp = r.dispatch(Request {
            jsonrpc: "2.0".into(),
            id: json!(1),
            method: "get_range_files".into(),
            params: Some(json!({"cwd": "C:\\nope\\not\\registered", "from": null, "to": "HEAD"})),
        }, dummy_ctx()).await;
        assert!(resp.error.is_some(), "unknown cwd must be rejected");
    }

    #[tokio::test]
    async fn get_range_files_dispatches_for_known_cwd() {
        // Guards ai_todo 244: without this route, dispatch returns -32601 and
        // the phone PR modal's Files tab silently stays "unavailable".
        let state = dummy_state();
        let cwd = std::env::current_dir().unwrap();
        state.settings.upsert_project_for_cwd(&cwd, "2026-01-01T00:00:00Z");
        let mut r = Router::new();
        register_pr_review(&mut r, state);
        let resp = r.dispatch(Request {
            jsonrpc: "2.0".into(),
            id: json!(1),
            method: "get_range_files".into(),
            params: Some(json!({"cwd": cwd.to_string_lossy(), "from": null, "to": "HEAD"})),
        }, dummy_ctx()).await;
        assert!(resp.error.is_none(), "got {:?}", resp.error);
    }
}
