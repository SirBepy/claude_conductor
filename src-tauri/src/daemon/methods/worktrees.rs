//! Worktree/branch RPC methods (ai_todo 434): mirror the desktop
//! `ipc::worktrees` Tauri commands plus `ipc::git::get_recent_branches`, so
//! the phone's worktree picker has a daemon RPC to call - previously neither
//! `remote_handlers.rs` nor `http-transport.ts` knew these existed.

use crate::daemon::rpc::{Router, RpcError};
use serde_json::json;

pub fn register_worktrees(router: &mut Router) {
    router.register("list_worktree_details", move |params, _ctx| async move {
        #[derive(serde::Deserialize)]
        struct P {
            repo_path: String,
        }
        let p: P = serde_json::from_value(params.unwrap_or(serde_json::Value::Null))
            .map_err(|e| RpcError::invalid_params(e.to_string()))?;
        let result = crate::ipc::worktrees::list_worktree_details(p.repo_path)
            .await
            .map_err(RpcError::internal)?;
        Ok(json!(result))
    });

    router.register("create_worktree", move |params, _ctx| async move {
        #[derive(serde::Deserialize)]
        struct P {
            repo_path: String,
            branch_name: String,
            worktree_name: Option<String>,
            base_branch: Option<String>,
        }
        let p: P = serde_json::from_value(params.unwrap_or(serde_json::Value::Null))
            .map_err(|e| RpcError::invalid_params(e.to_string()))?;
        let result =
            crate::ipc::worktrees::create_worktree(p.repo_path, p.branch_name, p.worktree_name, p.base_branch)
                .await
                .map_err(RpcError::internal)?;
        Ok(json!(result))
    });

    router.register("remove_worktree", move |params, _ctx| async move {
        #[derive(serde::Deserialize)]
        struct P {
            repo_path: String,
            worktree_path: String,
            force: bool,
        }
        let p: P = serde_json::from_value(params.unwrap_or(serde_json::Value::Null))
            .map_err(|e| RpcError::invalid_params(e.to_string()))?;
        crate::ipc::worktrees::remove_worktree(p.repo_path, p.worktree_path, p.force)
            .await
            .map_err(RpcError::internal)?;
        Ok(json!({"ok": true}))
    });

    // Needed by the picker's "New worktree" base-branch field; not part of
    // `ipc::worktrees` itself but has no other remote path either.
    router.register("get_recent_branches", move |params, _ctx| async move {
        #[derive(serde::Deserialize)]
        struct P {
            cwd: String,
        }
        let p: P = serde_json::from_value(params.unwrap_or(serde_json::Value::Null))
            .map_err(|e| RpcError::invalid_params(e.to_string()))?;
        Ok(json!(crate::ipc::git::get_recent_branches(p.cwd).await))
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::rpc::{ConnectionContext, Request};
    use serde_json::json;

    fn dummy_ctx() -> ConnectionContext {
        let (tx, _rx) = tokio::sync::mpsc::channel(16);
        ConnectionContext::new(tx)
    }

    #[tokio::test]
    async fn list_worktree_details_dispatches_to_registered_handler() {
        // Guards ai_todo 434: without this route, dispatch returns -32601 and
        // the phone worktree picker silently shows nothing forever.
        let mut r = Router::new();
        register_worktrees(&mut r);
        let resp = r
            .dispatch(
                Request {
                    jsonrpc: "2.0".into(),
                    id: json!(1),
                    method: "list_worktree_details".into(),
                    params: Some(json!({"repo_path": "."})),
                },
                dummy_ctx(),
            )
            .await;
        assert!(resp.error.is_none(), "got {:?}", resp.error);
        assert!(resp.result.as_ref().map(serde_json::Value::is_array).unwrap_or(false));
    }

    #[tokio::test]
    async fn get_recent_branches_dispatches_to_registered_handler() {
        let mut r = Router::new();
        register_worktrees(&mut r);
        let resp = r
            .dispatch(
                Request {
                    jsonrpc: "2.0".into(),
                    id: json!(1),
                    method: "get_recent_branches".into(),
                    params: Some(json!({"cwd": "."})),
                },
                dummy_ctx(),
            )
            .await;
        assert!(resp.error.is_none(), "got {:?}", resp.error);
        assert!(resp.result.as_ref().map(serde_json::Value::is_array).unwrap_or(false));
    }
}
