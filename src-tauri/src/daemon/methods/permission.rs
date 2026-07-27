//! Permission/question responder RPC methods. The app calls these to resolve
//! the pending oneshot channels that the hooks server is blocking on while it
//! waits for a user decision.
//!
//! Both responders tolerate GHOST prompts: if the session's `claude -p` child
//! died while the prompt was open, its hook `curl` died with it and axum
//! dropped the blocked handler future on client disconnect - so the handler's
//! own post-await cleanup (remove_prompt + awaiting clear) never ran. The
//! prompt record then kept resurrecting the card on every
//! `list_pending_prompts` poll, and answering it hit "unknown request_id" and
//! changed nothing: the row sat on "Input Needed" forever. Answering any
//! prompt - live or ghost - now always tears the record down and settles the
//! registry state.

use crate::daemon::rpc::{Router, RpcError};
use crate::daemon::state::DaemonState;
use std::sync::Arc;

/// Shared tail of both responders: drop the prompt record (ghost or live) and,
/// for question prompts, clear a lingering `awaiting == "question"` and tell
/// every window. `clear_awaiting` is false for permission prompts - they never
/// set `awaiting`, and a coincident real question from another prompt must
/// survive a permission answer.
async fn settle_prompt(state: &Arc<DaemonState>, request_id: &str, clear_awaiting: bool) {
    let session_id = state.prompt_session_id(request_id).await;
    state.remove_prompt(request_id).await;
    if !clear_awaiting {
        return;
    }
    if let Some(sid) = session_id.as_deref() {
        if state.registry.clear_awaiting_if_question(sid) {
            state.notifier.publish(
                "instances_changed",
                serde_json::json!({"instances": state.registry.list()}),
            );
        }
    }
}

/// Core of `respond_permission`, factored out so the Jarvis `respond_worker_prompt`
/// route (`daemon::methods::jarvis::respond_worker_prompt`) can answer a
/// worker's permission prompt without going through the RPC `Router` (the
/// hooks-server handlers that route works don't have a `Router`/`ConnectionContext`
/// to dispatch through - see `hooks_server::jarvis`). Returns whether a live
/// waiter was actually resolved (`false` for a ghost/unknown request_id, same
/// as the RPC handler below).
pub(crate) async fn respond_permission_inner(
    state: &Arc<DaemonState>,
    request_id: &str,
    allow: bool,
    updated_input: Option<serde_json::Value>,
    message: Option<String>,
) -> bool {
    let tx = state.pending.lock().await.remove(request_id);
    let delivered = match tx {
        Some(tx) => {
            let payload = if allow {
                serde_json::json!({
                    "behavior": "allow",
                    "updatedInput": updated_input.unwrap_or(serde_json::Value::Object(Default::default())),
                })
            } else {
                serde_json::json!({
                    "behavior": "deny",
                    "message": message.unwrap_or_default(),
                })
            };
            let _ = tx.send(payload);
            true
        }
        None => false,
    };
    settle_prompt(state, request_id, false).await;
    delivered
}

/// Core of `respond_question`, factored out for the same reason as
/// `respond_permission_inner` above.
pub(crate) async fn respond_question_inner(
    state: &Arc<DaemonState>,
    request_id: &str,
    answers: serde_json::Value,
) -> bool {
    let tx = state.pending.lock().await.remove(request_id);
    let delivered = match tx {
        Some(tx) => {
            let _ = tx.send(serde_json::json!({"answers": answers}));
            true
        }
        None => false,
    };
    settle_prompt(state, request_id, true).await;
    delivered
}

pub fn register_responders(router: &mut Router, state: Arc<DaemonState>) {
    {
        let state = state.clone();
        router.register("respond_permission", move |params, _ctx| {
            let state = state.clone();
            async move {
                #[derive(serde::Deserialize)]
                struct Body {
                    request_id: String,
                    allow: bool,
                    #[serde(default)] updated_input: Option<serde_json::Value>,
                    #[serde(default)] message: Option<String>,
                }
                let b: Body = serde_json::from_value(params.unwrap_or(serde_json::Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                let delivered = respond_permission_inner(&state, &b.request_id, b.allow, b.updated_input, b.message).await;
                Ok(serde_json::json!({"ok": true, "delivered": delivered}))
            }
        });
    }
    {
        let state = state.clone();
        router.register("list_pending_prompts", move |_params, _ctx| {
            let state = state.clone();
            // Reliable poll path: the app fetches open prompts over RPC instead
            // of relying on the lossy notifier broadcast (which silently dropped
            // question_request frames and hung AskUserQuestion turns).
            async move { Ok(serde_json::Value::Array(state.list_prompts().await)) }
        });
    }
    router.register("respond_question", move |params, _ctx| {
        let state = state.clone();
        async move {
            #[derive(serde::Deserialize)]
            struct Body { request_id: String, answers: serde_json::Value }
            let b: Body = serde_json::from_value(params.unwrap_or(serde_json::Value::Null))
                .map_err(|e| RpcError::invalid_params(e.to_string()))?;
            let delivered = respond_question_inner(&state, &b.request_id, b.answers).await;
            Ok(serde_json::json!({"ok": true, "delivered": delivered}))
        }
    });
}
