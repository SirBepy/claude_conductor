//! Permission/question endpoints: `/permissions/request` + `/questions/request`.
//! Each inserts a oneshot into `state.pending`, emits a notifier event, and
//! blocks the HTTP response until the app responds (via the daemon-side RPC
//! `respond_*` in methods.rs) or the prompt timeout fires.

use super::decision::deny_decision;
use super::validated_json::ValidatedJson;
use super::HookCtx;
use crate::daemon::state::DaemonState;
use axum::{extract::State as AxState, http::StatusCode, response::IntoResponse, Json};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;

/// Stamp the durable "waiting on the user" state for a question prompt and
/// tell every window about it. Both halves matter: the registry write is what
/// survives a chat reopen, and the `instances_changed` publish is what flips
/// the sidebar NOW - the question set/clear paths used to skip the publish
/// (uniquely among all awaiting writers), leaving rows on a stale status until
/// the 15s poll or an unrelated event happened by.
fn set_question_awaiting(state: &Arc<DaemonState>, session_id: Option<&str>, asking: bool) {
    let Some(sid) = session_id else { return };
    let changed = if asking {
        // Publish only for sessions the registry actually tracks - hook tests
        // (and terminal-side sessions) pass ids the registry has never seen.
        if state.registry.get(sid).is_none() {
            return;
        }
        state.registry.set_awaiting(sid, Some("question".into()));
        true
    } else {
        // Only clear a "question" value: a newer turn's real end-of-turn
        // status (done/working/waiting) must not be stomped by a late-resuming
        // prompt handler.
        state.registry.clear_awaiting_if_question(sid)
    };
    if changed {
        state.notifier.publish(
            "instances_changed",
            json!({"instances": state.registry.list()}),
        );
    }
}

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

#[derive(Deserialize)]
pub(super) struct QuestRequestBody {
    id: String,
    questions: Value,
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
    auto_accept && !is_question_shaped(input)
}

fn is_question_shaped(input: &Value) -> bool {
    let Some(questions) = input.as_object().and_then(|o| o.get("questions")).and_then(|v| v.as_array()) else {
        return false;
    };
    !questions.is_empty()
        && questions.iter().all(|q| {
            q.as_object().and_then(|o| o.get("question")).and_then(|v| v.as_str()).is_some()
        })
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

pub(super) async fn on_question_request(
    AxState(ctx): AxState<Arc<HookCtx>>,
    ValidatedJson(body): ValidatedJson<QuestRequestBody>,
) -> impl IntoResponse {
    let payload = json!({
        "id": body.id,
        "questions": body.questions,
        "session_id": body.session_id,
    });
    let (tx, rx) = tokio::sync::oneshot::channel::<Value>();
    ctx.state.pending.lock().await.insert(body.id.clone(), tx);
    // Reliable delivery: record the prompt so the app's poll surfaces it even if
    // the lossy notifier broadcast drops the frame.
    ctx.state.add_prompt(&body.id, "question-requested", payload.clone(), false).await;
    ctx.state.fire_blocked_prompt(body.session_id.as_deref(), &body.id);
    // Wake Jarvis (todo 272 chunk 3) if this prompt belongs to one of its
    // workers - no-op for every other session.
    crate::daemon::jarvis_wake::wake_on_worker_blocked(
        &ctx.state, body.session_id.as_deref(), &body.id, Some("question"),
    ).await;
    // Durable "waiting on the user" state + sidebar publish, mirroring the
    // AskUserQuestion hook path below - this relay used to leave the registry
    // untouched, so a question asked via the MCP tool never showed (or cleared)
    // "Input Needed" except by the model's own end-of-turn marker.
    set_question_awaiting(&ctx.state, body.session_id.as_deref(), true);
    let subs = ctx.state.notifier.publish("question_request", payload);
    // Character "asking" sound (see `ask_question_decision` for the rationale).
    ctx.state.notifier.publish(
        "turn_sound",
        json!({ "session_id": body.session_id, "awaiting": "question" }),
    );
    log::info!(
        "[perm-relay] published question_request id={} session={:?} -> {} subscriber(s)",
        body.id, body.session_id, subs
    );
    let result = match await_answer(rx, PROMPT_TIMEOUT).await {
        Some(val) => (StatusCode::OK, Json(val)),
        None => {
            ctx.state.pending.lock().await.remove(&body.id);
            ctx.state.notifier.publish(
                "question_expired",
                json!({ "session_id": body.session_id, "id": body.id }),
            );
            (StatusCode::OK, Json(json!({"answers": {}})))
        }
    };
    ctx.state.remove_prompt(&body.id).await;
    set_question_awaiting(&ctx.state, body.session_id.as_deref(), false);
    result
}

/// PreToolUse-hook endpoint for the builtin `AskUserQuestion` tool. The in-app
/// `claude -p` session gets a per-session PreToolUse hook (see
/// `daemon::lifecycle::write_hook_settings`) whose command `curl`s the raw hook
/// payload here. We surface the questions through the same relay the MCP
/// `ask_user_question` tool uses (`question_request` -> the chat's question
/// card -> `respond_question`), wait for the answer, and return a PreToolUse
/// `deny` whose reason carries that answer. `claude` reads the reason as
/// feedback and continues. This is the channel that replaced the dead permission
/// relay: current `claude` no longer routes `AskUserQuestion` through
/// `--permission-prompt-tool`, but a `PreToolUse` hook still fires for it.
///
/// The response body IS the hook's stdout, so it must be exactly the
/// `hookSpecificOutput` decision claude expects - nothing else.
pub(super) async fn on_ask_question_hook(
    AxState(ctx): AxState<Arc<HookCtx>>,
    Json(body): Json<Value>,
) -> impl IntoResponse {
    (StatusCode::OK, Json(ask_question_decision(&ctx, body).await))
}

/// The firm PreToolUse deny reason handed back the instant the card is posted.
/// This is internal tool feedback (never rendered in the chat) whose ONLY job is
/// to tell the model: the card is live, stop now, don't re-ask. The wording is
/// deliberately blunt about not re-calling the tool - that prompt discipline is
/// the one guardrail against a deny->re-ask loop now that no blocking wait
/// physically parks the turn (the previous timeout branch even INVITED a re-ask,
/// which must not leak into this path).
const ASK_FIRE_AND_FORGET_REASON: &str =
    "Your question has been shown to the user in the app and the card is now \
waiting for their answer. Do NOT call AskUserQuestion again and do NOT keep \
working on this task - end your turn now with at most a brief acknowledgement. \
The user will reply in a separate follow-up message when they're ready, and \
that reply resumes the work in a fresh turn. If they send something unrelated \
instead, treat this question as dropped.";

/// Core of the AskUserQuestion hook, FIRE-AND-FORGET: post the question card and
/// return IMMEDIATELY so the asking turn ends. There is no pending oneshot and
/// no blocking wait, so the ask can never hit a timeout ceiling. The user's
/// answer arrives later as an ordinary follow-up message (the chat card's submit
/// sends it via `send_message`, folding in any held/queued messages), which
/// resumes the work in a fresh turn. Split out from the axum handler so it can
/// be unit-tested without an HTTP round-trip.
pub(super) async fn ask_question_decision(ctx: &Arc<HookCtx>, body: Value) -> Value {
    let questions = body
        .get("tool_input")
        .and_then(|t| t.get("questions"))
        .cloned()
        .unwrap_or(Value::Null);
    if !questions.is_array() {
        return deny_decision("No questions found in the AskUserQuestion call.");
    }
    let session_id = body
        .get("session_id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let id = uuid::Uuid::new_v4().to_string();
    let payload = json!({ "id": id, "questions": questions, "session_id": session_id.clone() });
    // Reliable delivery: record the prompt so the app's poll surfaces it even if
    // the lossy notifier broadcast drops the frame. DURABLE, because this turn
    // is about to end - the child's EOF must NOT expire the card (see
    // state.rs::add_prompt / expire_prompts_for_session). Cleared only by an
    // explicit answer/skip via `respond_question`.
    ctx.state.add_prompt(&id, "question-requested", payload.clone(), true).await;
    ctx.state.fire_blocked_prompt(session_id.as_deref(), &id);
    // Wake Jarvis (todo 272 chunk 3) if this prompt belongs to one of its
    // workers - no-op for every other session.
    crate::daemon::jarvis_wake::wake_on_worker_blocked(
        &ctx.state, session_id.as_deref(), &id, Some("AskUserQuestion"),
    ).await;
    // Durable "waiting on the user" state -> sidebar "Input Needed". The asking
    // turn never emits its own `awaiting:question` result line, so this is the
    // only source of that state; `respond_question`'s `settle_prompt` clears it
    // when the user answers or skips.
    set_question_awaiting(&ctx.state, session_id.as_deref(), true);
    ctx.state.notifier.publish("question_request", payload);
    // Character "asking" sound (mapped to `notifications::fire(QuestionAsked)`).
    ctx.state.notifier.publish(
        "turn_sound",
        json!({ "session_id": session_id, "awaiting": "question" }),
    );
    deny_decision(ASK_FIRE_AND_FORGET_REASON)
}

#[cfg(test)]
mod tests {
    use super::{ask_question_decision, is_auto_accept_eligible, is_question_shaped, ASK_FIRE_AND_FORGET_REASON, HookCtx};
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::daemon::state::DaemonState;
    use crate::types::Settings;
    use serde_json::json;
    use std::sync::Arc;

    #[test]
    fn is_question_shaped_detects_well_formed_ask_user_question_payload() {
        let input = json!({ "questions": [ { "question": "Tabs or spaces?", "options": [] } ] });
        assert!(is_question_shaped(&input));
    }

    #[test]
    fn is_question_shaped_false_for_ordinary_tool_input() {
        assert!(!is_question_shaped(&json!({ "command": "ls" })));
        assert!(!is_question_shaped(&json!({})));
        assert!(!is_question_shaped(&json!(null)));
    }

    #[test]
    fn is_question_shaped_false_for_empty_or_malformed_questions_array() {
        assert!(!is_question_shaped(&json!({ "questions": [] })));
        assert!(!is_question_shaped(&json!({ "questions": [ { "no_question_field": true } ] })));
        assert!(!is_question_shaped(&json!({ "questions": "not-an-array" })));
    }

    #[test]
    fn is_auto_accept_eligible_requires_the_flag_and_a_non_question_payload() {
        let ordinary = json!({ "command": "ls" });
        let question = json!({ "questions": [ { "question": "Tabs or spaces?" } ] });
        assert!(is_auto_accept_eligible(true, &ordinary));
        assert!(!is_auto_accept_eligible(false, &ordinary), "flag off never auto-accepts");
        assert!(!is_auto_accept_eligible(true, &question), "question-shaped always needs a human");
    }

    /// Fire-and-forget: the hook posts the card and returns IMMEDIATELY without
    /// inserting a pending oneshot or waiting. It publishes `question_request`,
    /// records a DURABLE prompt (so the turn-end EOF can't wipe the card), marks
    /// the session "Input Needed", and hands back the terse "card shown, stop"
    /// deny reason - never the answer (that arrives later as a normal message).
    #[tokio::test]
    async fn ask_question_posts_card_and_returns_immediately() {
        let state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        let ctx = Arc::new(HookCtx { state: state.clone() });

        let mut rx = state.notifier.subscribe();
        let body = json!({
            "session_id": "s1",
            "tool_input": { "questions": [
                { "question": "Tabs or spaces?", "options": [ {"label": "Tabs"}, {"label": "Spaces"} ] }
            ] }
        });

        // Must resolve without any answerer: nothing is blocking on a oneshot.
        let decision = ask_question_decision(&ctx, body).await;

        let hso = &decision["hookSpecificOutput"];
        assert_eq!(hso["hookEventName"], "PreToolUse");
        assert_eq!(hso["permissionDecision"], "deny");
        let reason = hso["permissionDecisionReason"].as_str().unwrap();
        assert_eq!(reason, ASK_FIRE_AND_FORGET_REASON, "must be the terse handshake, not the answer");

        // No blocking waiter was registered.
        assert!(state.pending.lock().await.is_empty(), "fire-and-forget must not insert a oneshot");

        // A durable question prompt is recorded so `list_pending_prompts` keeps
        // surfacing the card after the asking turn ends.
        let prompts = state.list_prompts().await;
        assert_eq!(prompts.len(), 1, "one recorded prompt");
        assert_eq!(prompts[0]["event"], "question-requested");
        assert_eq!(prompts[0]["durable"], true, "the fire-and-forget prompt must be durable");
        let id = prompts[0]["id"].as_str().unwrap().to_string();

        // The card was published.
        let frame = rx.recv().await.expect("question_request published");
        assert_eq!(frame["method"], "question_request");
        assert_eq!(frame["params"]["session_id"], "s1");
        assert_eq!(frame["params"]["id"].as_str().unwrap(), id);
    }

    /// A durable AskUserQuestion prompt must SURVIVE the asking turn's EOF: the
    /// pump loop calls `expire_prompts_for_session` when the child closes, and
    /// that must not wipe a fire-and-forget card the user hasn't answered yet.
    #[tokio::test]
    async fn durable_question_survives_turn_end_expiry() {
        let state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        let ctx = Arc::new(HookCtx { state: state.clone() });
        let body = json!({
            "session_id": "s1",
            "tool_input": { "questions": [ { "question": "Tabs or spaces?" } ] }
        });
        ask_question_decision(&ctx, body).await;
        assert_eq!(state.list_prompts().await.len(), 1);

        // The child EOFs at turn end -> expiry runs. The durable card stays.
        let expired = state.expire_prompts_for_session("s1").await;
        assert_eq!(expired, 0, "durable question must be skipped by turn-end expiry");
        assert_eq!(state.list_prompts().await.len(), 1, "card still open for the user to answer");
    }

    #[tokio::test]
    async fn ask_question_with_no_questions_denies_without_blocking() {
        let state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        let ctx = Arc::new(HookCtx { state });
        let decision = ask_question_decision(&ctx, json!({ "tool_input": {} })).await;
        assert_eq!(decision["hookSpecificOutput"]["permissionDecision"], "deny");
    }
}
