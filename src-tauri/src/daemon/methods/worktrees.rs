//! Worktree/branch RPC methods (ai_todo 434): mirror the desktop
//! `ipc::worktrees` Tauri commands plus `ipc::git::get_recent_branches`, so
//! the phone's worktree picker has a daemon RPC to call - previously neither
//! `remote_handlers.rs` nor `http-transport.ts` knew these existed.
//!
//! Every path param is gated by `is_known_cwd`: these are in SAFE_METHODS, so
//! without it a paired remote client could `remove_worktree` any repo on disk.

use super::pr_review::reject_unknown;
use crate::daemon::rpc::{Router, RpcError};
use crate::daemon::state::DaemonState;
use serde_json::json;
use std::sync::Arc;

pub fn register_worktrees(router: &mut Router, state: Arc<DaemonState>) {
    {
        let state = state.clone();
        router.register("list_worktree_details", move |params, _ctx| {
            let state = state.clone();
            async move {
                #[derive(serde::Deserialize)]
                struct P {
                    repo_path: String,
                }
                let p: P = serde_json::from_value(params.unwrap_or(serde_json::Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                reject_unknown(&state, &p.repo_path)?;
                let result = crate::ipc::worktrees::list_worktree_details(p.repo_path)
                    .await
                    .map_err(RpcError::internal)?;
                Ok(json!(result))
            }
        });
    }

    {
        let state = state.clone();
        router.register("create_worktree", move |params, _ctx| {
            let state = state.clone();
            async move {
                #[derive(serde::Deserialize)]
                struct P {
                    repo_path: String,
                    branch_name: String,
                    worktree_name: Option<String>,
                    base_branch: Option<String>,
                }
                let p: P = serde_json::from_value(params.unwrap_or(serde_json::Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                reject_unknown(&state, &p.repo_path)?;
                let result = crate::ipc::worktrees::create_worktree(
                    p.repo_path,
                    p.branch_name,
                    p.worktree_name,
                    p.base_branch,
                )
                .await
                .map_err(RpcError::internal)?;
                Ok(json!(result))
            }
        });
    }

    {
        let state = state.clone();
        router.register("remove_worktree", move |params, _ctx| {
            let state = state.clone();
            async move {
                #[derive(serde::Deserialize)]
                struct P {
                    repo_path: String,
                    worktree_path: String,
                    force: bool,
                }
                let p: P = serde_json::from_value(params.unwrap_or(serde_json::Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                // Both paths: the parent repo AND the worktree being deleted.
                reject_unknown(&state, &p.repo_path)?;
                reject_unknown(&state, &p.worktree_path)?;
                crate::ipc::worktrees::remove_worktree(p.repo_path, p.worktree_path, p.force)
                    .await
                    .map_err(RpcError::internal)?;
                Ok(json!({"ok": true}))
            }
        });
    }

    // Needed by the picker's "New worktree" base-branch field; not part of
    // `ipc::worktrees` itself but has no other remote path either.
    router.register("get_recent_branches", move |params, _ctx| {
        let state = state.clone();
        async move {
            #[derive(serde::Deserialize)]
            struct P {
                cwd: String,
            }
            let p: P = serde_json::from_value(params.unwrap_or(serde_json::Value::Null))
                .map_err(|e| RpcError::invalid_params(e.to_string()))?;
            reject_unknown(&state, &p.cwd)?;
            Ok(json!(crate::ipc::git::get_recent_branches(p.cwd).await))
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

    async fn call(state: Arc<DaemonState>, method: &str, params: serde_json::Value) -> crate::daemon::rpc::Response {
        let mut r = Router::new();
        register_worktrees(&mut r, state);
        r.dispatch(
            Request { jsonrpc: "2.0".into(), id: json!(1), method: method.into(), params: Some(params) },
            dummy_ctx(),
        )
        .await
    }

    #[tokio::test]
    async fn list_worktree_details_dispatches_to_registered_handler() {
        // Guards ai_todo 434: without this route, dispatch returns -32601 and
        // the phone worktree picker silently shows nothing forever.
        let st = state();
        let cwd = std::env::current_dir().unwrap();
        st.settings.upsert_project_for_cwd(&cwd, "2026-01-01T00:00:00Z");
        let resp = call(st, "list_worktree_details", json!({"repo_path": cwd.to_string_lossy()})).await;
        assert!(resp.error.is_none(), "got {:?}", resp.error);
        assert!(resp.result.as_ref().map(serde_json::Value::is_array).unwrap_or(false));
    }

    #[tokio::test]
    async fn get_recent_branches_dispatches_to_registered_handler() {
        let st = state();
        let cwd = std::env::current_dir().unwrap();
        st.settings.upsert_project_for_cwd(&cwd, "2026-01-01T00:00:00Z");
        let resp = call(st, "get_recent_branches", json!({"cwd": cwd.to_string_lossy()})).await;
        assert!(resp.error.is_none(), "got {:?}", resp.error);
        assert!(resp.result.as_ref().map(serde_json::Value::is_array).unwrap_or(false));
    }

    /// These four are in `remote_handlers.rs`'s SAFE_METHODS, so an unknown
    /// path must be refused before it reaches git.
    #[tokio::test]
    async fn every_worktree_method_rejects_an_unknown_path() {
        let cases = [
            ("list_worktree_details", json!({"repo_path": "C:\\nope\\not\\registered"})),
            ("create_worktree", json!({"repo_path": "C:\\nope", "branch_name": "x", "worktree_name": null, "base_branch": null})),
            ("remove_worktree", json!({"repo_path": "C:\\nope", "worktree_path": "C:\\nope\\wt", "force": true})),
            ("get_recent_branches", json!({"cwd": "C:\\nope\\not\\registered"})),
        ];
        for (method, params) in cases {
            let resp = call(state(), method, params).await;
            assert!(resp.error.is_some(), "{method} must reject an unknown path");
        }
    }

    #[tokio::test]
    async fn remove_worktree_rejects_a_known_repo_with_a_foreign_worktree_path() {
        let st = state();
        let cwd = std::env::current_dir().unwrap();
        st.settings.upsert_project_for_cwd(&cwd, "2026-01-01T00:00:00Z");
        let resp = call(
            st,
            "remove_worktree",
            json!({"repo_path": cwd.to_string_lossy(), "worktree_path": "C:\\nope\\wt", "force": true}),
        )
        .await;
        assert!(resp.error.is_some(), "a known repo must not authorise deleting an unknown path");
    }
}
