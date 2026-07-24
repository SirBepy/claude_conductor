//! `context_status` RPC: mirrors the desktop `context_status` Tauri command
//! (`ipc/git.rs`) and the daemon's own localhost-only `/context` hooks-server
//! endpoint (`daemon/hooks_server/context.rs`) - both already call
//! `context_status::context_status_for_session`, this just exposes that same
//! computation over the pipe RPC so the phone (which cannot reach the
//! 127.0.0.1-bound hooks_server) gets the authoritative, transcript-derived
//! context % instead of the frontend's stale-model fallback heuristic.

use crate::daemon::rpc::{Router, RpcError};
use crate::daemon::state::DaemonState;
use serde_json::json;
use std::sync::Arc;

pub fn register_context(router: &mut Router, state: Arc<DaemonState>) {
    #[derive(serde::Deserialize)]
    struct SessionId { session_id: String }

    let state = state.clone();
    router.register("context_status", move |params, _ctx| {
        let state = state.clone();
        async move {
            let p: SessionId = serde_json::from_value(params.unwrap_or(serde_json::Value::Null))
                .map_err(|e| RpcError::invalid_params(e.to_string()))?;
            let registry = state.registry.clone();
            let status = tokio::task::spawn_blocking(move || {
                crate::context_status::context_status_for_session(&registry, &p.session_id)
            })
            .await
            .map_err(|e| RpcError::internal(format!("join: {e}")))?;
            Ok(json!(status))
        }
    });
}
