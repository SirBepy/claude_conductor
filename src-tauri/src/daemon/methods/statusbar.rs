//! Session-statusbar + location-picker RPCs: mirror the desktop `ipc::git`,
//! `ipc::servers`, and `ipc::claude_scopes` Tauri commands so the phone's
//! git/servers chips and the "Open .claude" modal aren't wired to nothing.
//! Same pattern as `worktrees.rs`; every path is gated by `is_known_cwd`.

use super::pr_review::is_known_cwd;
use crate::daemon::rpc::{Router, RpcError};
use crate::daemon::state::DaemonState;
use serde_json::json;
use std::sync::Arc;

fn reject_unknown(state: &DaemonState, path: &str) -> Result<(), RpcError> {
    if is_known_cwd(state, path) {
        Ok(())
    } else {
        Err(RpcError::invalid_params("unknown cwd".to_string()))
    }
}

pub fn register_statusbar(router: &mut Router, state: Arc<DaemonState>) {
    {
        let state = state.clone();
        router.register("get_git_info", move |params, _ctx| {
            let state = state.clone();
            async move {
                #[derive(serde::Deserialize)]
                struct P {
                    cwd: String,
                }
                let p: P = serde_json::from_value(params.unwrap_or(serde_json::Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                reject_unknown(&state, &p.cwd)?;
                Ok(json!(crate::ipc::git::get_git_info(p.cwd).await))
            }
        });
    }

    {
        let state = state.clone();
        router.register("get_git_dirty", move |params, _ctx| {
            let state = state.clone();
            async move {
                #[derive(serde::Deserialize)]
                struct P {
                    cwd: String,
                }
                let p: P = serde_json::from_value(params.unwrap_or(serde_json::Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                reject_unknown(&state, &p.cwd)?;
                Ok(json!(crate::ipc::git::get_git_dirty(p.cwd).await))
            }
        });
    }

    {
        let state = state.clone();
        router.register("get_commit_sync", move |params, _ctx| {
            let state = state.clone();
            async move {
                #[derive(serde::Deserialize)]
                struct P {
                    cwd: String,
                }
                let p: P = serde_json::from_value(params.unwrap_or(serde_json::Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                reject_unknown(&state, &p.cwd)?;
                Ok(json!(crate::ipc::git::get_commit_sync(p.cwd).await))
            }
        });
    }

    {
        let state = state.clone();
        router.register("list_project_servers", move |params, _ctx| {
            let state = state.clone();
            async move {
                #[derive(serde::Deserialize)]
                struct P {
                    cwd: String,
                }
                let p: P = serde_json::from_value(params.unwrap_or(serde_json::Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                reject_unknown(&state, &p.cwd)?;
                Ok(json!(crate::ipc::servers::list_project_servers(p.cwd).await))
            }
        });
    }

    router.register("list_claude_md_scopes", move |params, _ctx| {
        let state = state.clone();
        async move {
            #[derive(serde::Deserialize)]
            struct P {
                worktree_path: String,
            }
            let p: P = serde_json::from_value(params.unwrap_or(serde_json::Value::Null))
                .map_err(|e| RpcError::invalid_params(e.to_string()))?;
            reject_unknown(&state, &p.worktree_path)?;
            let scopes = crate::ipc::claude_scopes::list_claude_md_scopes(p.worktree_path)
                .await
                .map_err(RpcError::internal)?;
            Ok(json!(scopes))
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
        register_statusbar(&mut r, state);
        r.dispatch(
            Request { jsonrpc: "2.0".into(), id: json!(1), method: method.into(), params: Some(params) },
            dummy_ctx(),
        )
        .await
    }

    #[tokio::test]
    async fn get_git_info_dispatches_for_a_known_cwd() {
        let st = state();
        let cwd = std::env::current_dir().unwrap();
        st.settings.upsert_project_for_cwd(&cwd, "2026-01-01T00:00:00Z");
        let resp = call(st, "get_git_info", json!({"cwd": cwd.to_string_lossy()})).await;
        assert!(resp.error.is_none(), "got {:?}", resp.error);
    }

    #[tokio::test]
    async fn get_git_dirty_dispatches_for_a_known_cwd() {
        let st = state();
        let cwd = std::env::current_dir().unwrap();
        st.settings.upsert_project_for_cwd(&cwd, "2026-01-01T00:00:00Z");
        let resp = call(st, "get_git_dirty", json!({"cwd": cwd.to_string_lossy()})).await;
        assert!(resp.error.is_none(), "got {:?}", resp.error);
        assert!(resp.result.as_ref().map(serde_json::Value::is_array).unwrap_or(false));
    }

    #[tokio::test]
    async fn get_commit_sync_dispatches_for_a_known_cwd() {
        let st = state();
        let cwd = std::env::current_dir().unwrap();
        st.settings.upsert_project_for_cwd(&cwd, "2026-01-01T00:00:00Z");
        let resp = call(st, "get_commit_sync", json!({"cwd": cwd.to_string_lossy()})).await;
        assert!(resp.error.is_none(), "got {:?}", resp.error);
    }

    #[tokio::test]
    async fn list_project_servers_dispatches_for_a_known_cwd() {
        let st = state();
        let cwd = std::env::current_dir().unwrap();
        st.settings.upsert_project_for_cwd(&cwd, "2026-01-01T00:00:00Z");
        let resp = call(st, "list_project_servers", json!({"cwd": cwd.to_string_lossy()})).await;
        assert!(resp.error.is_none(), "got {:?}", resp.error);
        assert!(resp.result.as_ref().map(serde_json::Value::is_array).unwrap_or(false));
    }

    #[tokio::test]
    async fn list_claude_md_scopes_dispatches_for_a_known_cwd() {
        let st = state();
        let cwd = std::env::current_dir().unwrap();
        st.settings.upsert_project_for_cwd(&cwd, "2026-01-01T00:00:00Z");
        let resp = call(st, "list_claude_md_scopes", json!({"worktree_path": cwd.to_string_lossy()})).await;
        assert!(resp.error.is_none(), "got {:?}", resp.error);
        assert!(resp.result.as_ref().map(serde_json::Value::is_array).unwrap_or(false));
    }

    /// All five are in `remote_handlers.rs`'s SAFE_METHODS, so an unknown
    /// path must be refused before it reaches git or the filesystem.
    #[tokio::test]
    async fn every_statusbar_method_rejects_an_unknown_path() {
        let cases = [
            ("get_git_info", json!({"cwd": "C:\\nope\\not\\registered"})),
            ("get_git_dirty", json!({"cwd": "C:\\nope\\not\\registered"})),
            ("get_commit_sync", json!({"cwd": "C:\\nope\\not\\registered"})),
            ("list_project_servers", json!({"cwd": "C:\\nope\\not\\registered"})),
            ("list_claude_md_scopes", json!({"worktree_path": "C:\\nope\\not\\registered"})),
        ];
        for (method, params) in cases {
            let resp = call(state(), method, params).await;
            assert!(resp.error.is_some(), "{method} must reject an unknown path");
        }
    }
}
