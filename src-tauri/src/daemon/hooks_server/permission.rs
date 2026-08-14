//! Blocking permission endpoint: `/permissions/request` blocks on a oneshot
//! until `respond_permission` answers or the prompt times out. The
//! fire-and-forget question paths (`/questions/request`, the builtin
//! AskUserQuestion hook) live in the sibling `question` module (todo 624).

use super::validated_json::ValidatedJson;
use super::HookCtx;
use axum::{extract::State as AxState, http::StatusCode, response::IntoResponse, Json};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;

/// How long the daemon holds a permission/question prompt open waiting for the
/// user before giving up. The curl `--max-time` and the PreToolUse hook's
/// `timeout` field (both in `daemon::claude_config::write_hook_settings`) are set
/// to 3660s so they out-wait this by 60s - the daemon's response always lands
/// before the hook process is killed. Without this bound the `rx.await` blocks
/// until Claude Code's own PreToolUse ceiling (600s default) kills the hook,
/// silently truncating the intended window and dropping the answer.
pub(crate) const PROMPT_TIMEOUT: Duration = Duration::from_secs(3600);

/// Await the answer oneshot with an upper bound. `Some(val)` iff the user
/// responded; `None` if the wait elapsed OR the sender was dropped (daemon
/// restart / dismissal). Both map to the same "no answer" wire behavior, so
/// callers treat them identically.
async fn await_answer(rx: tokio::sync::oneshot::Receiver<Value>, timeout: Duration) -> Option<Value> {
    match tokio::time::timeout(timeout, rx).await {
        Ok(Ok(val)) => Some(val),
        _ => None,
    }
}

#[derive(Deserialize)]
pub(super) struct PermRequestBody {
    id: String,
    tool_name: String,
    input: Value,
    #[serde(default)]
    session_id: Option<String>,
}

/// Mirrors the frontend's `isAutoAccept(sid) && extractQuestions(input) ===
/// null` gate (permission-modal/gating.ts + question-state.ts's
/// `extractQuestions`): fires for a session with the persisted auto-accept
/// flag on, UNLESS the payload is a well-formed AskUserQuestion-shaped tool
/// call (an MCP `ask_user_question` call routed through the ordinary
/// permission-prompt-tool path, which always needs a human). Checked
/// server-side, not just client-side, because a client's in-memory gate only
/// catches up to a freshly forked/spawned session's persisted setting AFTER
/// the RPC that created it resolves - a session that requests a tool
/// permission immediately upon resume (`move_session_to_account`, scheduled
/// new-chat, Jarvis workers) can race that and pop the modal anyway.
fn is_auto_accept_eligible(auto_accept: bool, input: &Value) -> bool {
    auto_accept && !super::question::is_question_shaped(input)
}

pub(super) async fn on_permission_request(
    AxState(ctx): AxState<Arc<HookCtx>>,
    ValidatedJson(body): ValidatedJson<PermRequestBody>,
) -> impl IntoResponse {
    let auto_accept = body.session_id.as_deref()
        .and_then(crate::sessions::chat_config::get)
        .map(|c| c.auto_accept)
        .unwrap_or(false);
    if is_auto_accept_eligible(auto_accept, &body.input) {
        log::debug!(
            "[perm-relay] server-side auto-accept id={} tool={} session={:?}",
            body.id, body.tool_name, body.session_id
        );
        return (StatusCode::OK, Json(json!({"behavior": "allow", "updatedInput": body.input})));
    }
    let payload = json!({
        "id": body.id,
        "tool_name": body.tool_name,
        "input": body.input,
        "session_id": body.session_id,
    });
    let (tx, rx) = tokio::sync::oneshot::channel::<Value>();
    ctx.state.pending.lock().await.insert(body.id.clone(), tx);
    ctx.state.add_prompt(&body.id, "permission-requested", payload.clone(), false).await;
    // Push the phone if Joe is away (ai_todo 119): Claude is now blocked on him.
    ctx.state.fire_blocked_prompt(body.session_id.as_deref(), &body.id);
    // Wake Jarvis (todo 272 chunk 3) if this prompt belongs to one of its
    // workers - no-op for every other session.
    crate::daemon::jarvis_wake::wake_on_worker_blocked(
        &ctx.state, body.session_id.as_deref(), &body.id, Some(body.tool_name.as_str()),
    ).await;
    let subs = ctx.state.notifier.publish("permission_request", payload);
    log::info!(
        "[perm-relay] published permission_request id={} tool={} session={:?} -> {} subscriber(s)",
        body.id, body.tool_name, body.session_id, subs
    );
    let result = match await_answer(rx, PROMPT_TIMEOUT).await {
        Some(val) => (StatusCode::OK, Json(val)),
        None => {
            ctx.state.pending.lock().await.remove(&body.id);
            (
                StatusCode::OK,
                Json(json!({"behavior": "deny", "message": "user did not respond in time"})),
            )
        }
    };
    ctx.state.remove_prompt(&body.id).await;
    result
}

#[cfg(test)]
mod tests {
    use super::{is_auto_accept_eligible};
    use serde_json::json;

    #[test]
    fn is_auto_accept_eligible_requires_the_flag_and_a_non_question_payload() {
        let ordinary = json!({ "command": "ls" });
        let question = json!({ "questions": [ { "question": "Tabs or spaces?" } ] });
        assert!(is_auto_accept_eligible(true, &ordinary));
        assert!(!is_auto_accept_eligible(false, &ordinary), "flag off never auto-accepts");
        assert!(!is_auto_accept_eligible(true, &question), "question-shaped always needs a human");
    }
}
