//! Read-only mirrors of the desktop `list_history` / `load_history` Tauri
//! commands (`ipc/chat/history.rs`), so the phone History view has a daemon
//! RPC to call instead of hitting `HttpTransport`'s default branch and
//! throwing `RemoteUnavailableError` (the empty-list bug this module fixes).
//! Reuses `collect_history` and `chat::history::{locate_transcript, replay}`
//! directly - no parsing logic is duplicated here.

use crate::daemon::rpc::{Router, RpcError};
use crate::daemon::state::DaemonState;
use serde_json::json;
use std::sync::Arc;

pub fn register_history(router: &mut Router, state: Arc<DaemonState>) {
    {
        let state = state.clone();
        router.register("list_history", move |params, _ctx| {
            let state = state.clone();
            async move {
                #[derive(serde::Deserialize, Default)]
                struct P {
                    project_id: Option<String>,
                    search: Option<String>,
                    limit: u32,
                    offset: u32,
                }
                let p: P = serde_json::from_value(params.unwrap_or(serde_json::Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                let projects_dir = crate::tokens::claude_projects_dir()
                    .ok_or_else(|| RpcError::internal("no home dir"))?;
                // No AppState on the daemon (separate process) - use the
                // daemon's own registry for the live-session exclusion instead
                // of the desktop command's `state.cached_instances`.
                let live_ids: std::collections::HashSet<String> = state
                    .registry
                    .list()
                    .into_iter()
                    .filter(|i| i.ended_at.is_none())
                    .map(|i| i.session_id)
                    .collect();
                let entries = tokio::task::spawn_blocking(move || {
                    let mut entries = crate::ipc::chat::history::collect_history(
                        &projects_dir,
                        p.project_id,
                        p.search,
                        p.limit,
                        p.offset,
                    );
                    entries.retain(|e| !live_ids.contains(&e.session_id));
                    entries
                })
                .await
                .map_err(|e| RpcError::internal(format!("join: {e}")))?;
                Ok(json!(entries))
            }
        });
    }
    router.register("load_history", move |params, _ctx| {
        async move {
            #[derive(serde::Deserialize)]
            struct P {
                session_id: String,
                #[serde(default)]
                cwd: Option<String>,
            }
            let p: P = serde_json::from_value(params.unwrap_or(serde_json::Value::Null))
                .map_err(|e| RpcError::invalid_params(e.to_string()))?;
            crate::ipc::chat::attachments::validate_session_id(&p.session_id)
                .map_err(RpcError::invalid_params)?;
            let events = tokio::task::spawn_blocking(move || {
                let path = crate::chat::history::locate_transcript(&p.session_id, p.cwd.as_deref())?;
                crate::chat::history::replay(&path)
            })
            .await
            .map_err(|e| RpcError::internal(format!("join: {e}")))?
            .map_err(RpcError::internal)?;
            Ok(json!(events))
        }
    });
}
