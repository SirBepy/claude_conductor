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

/// Params shared by `load_history` and `transcript_stats`: both just resolve
/// a transcript by session id (+ optional cwd hint) and run a pure function
/// over it via `chat::history::with_transcript`.
#[derive(serde::Deserialize)]
struct TranscriptParams {
    session_id: String,
    #[serde(default)]
    cwd: Option<String>,
}

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
                    #[serde(default)]
                    model_filter: Option<String>,
                    #[serde(default)]
                    date_from: Option<String>,
                    #[serde(default)]
                    date_to: Option<String>,
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
                        p.model_filter,
                        p.date_from,
                        p.date_to,
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
            let p: TranscriptParams = serde_json::from_value(params.unwrap_or(serde_json::Value::Null))
                .map_err(|e| RpcError::invalid_params(e.to_string()))?;
            crate::ipc::chat::attachments::validate_session_id(&p.session_id)
                .map_err(RpcError::invalid_params)?;
            let events = crate::chat::history::with_transcript(p.session_id, p.cwd, crate::chat::history::replay)
                .await
                .map_err(RpcError::internal)?;
            Ok(json!(events))
        }
    });
    router.register("transcript_stats", move |params, _ctx| {
        async move {
            let p: TranscriptParams = serde_json::from_value(params.unwrap_or(serde_json::Value::Null))
                .map_err(|e| RpcError::invalid_params(e.to_string()))?;
            crate::ipc::chat::attachments::validate_session_id(&p.session_id)
                .map_err(RpcError::invalid_params)?;
            let stats = crate::chat::history::with_transcript(p.session_id, p.cwd, crate::chat::history::stats)
                .await
                .map_err(RpcError::internal)?;
            Ok(json!(stats))
        }
    });
}
