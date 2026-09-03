//! Fire-and-forget question endpoints: `/questions/request` (MCP
//! `ask_user_question`) and the builtin `AskUserQuestion` PreToolUse hook.
//! Both post a durable card and never block on an ANSWER - split from
//! `permission.rs` (todo 624), which blocks on a oneshot while this one never
//! does. `on_question_request` alone also awaits a render confirmation (todo 735).

use super::decision::deny_decision;
use super::validated_json::ValidatedJson;
use super::HookCtx;
use crate::daemon::state::DaemonState;
use axum::{extract::State as AxState, http::StatusCode, response::IntoResponse, Json};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::oneshot;

/// Stamp the durable "waiting on the user" state for a question prompt and
/// tell every window about it. Both halves matter: the registry write is what
/// survives a chat reopen, and the `instances_changed` publish is what flips
/// the sidebar NOW - the question set/clear paths used to skip the publish
/// (uniquely among all awaiting writers), leaving rows on a stale status until
/// the 15s poll or an unrelated event happened by.
/// Shared with `permission.rs`: a blocking tool-permission prompt is just as
/// much "waiting on the user" as a question card, and used to write nothing
/// here at all - leaving the phone and every non-receiving window showing
/// In Progress while claude sat blocked.
///
/// Returns whether the registry was actually written. On the `asking` side a
/// `false` means the card surfaces nowhere, which is what the Stop hook's
/// undelivered-question block keys off (todo 818).
pub(super) fn set_question_awaiting(state: &Arc<DaemonState>, session_id: Option<&str>, asking: bool) -> bool {
    let Some(sid) = session_id else { return false };
    let changed = if asking {
        // Publish only for sessions the registry actually tracks - hook tests
        // (and terminal-side sessions) pass ids the registry has never seen.
        if state.registry.get(sid).is_none() {
            return false;
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
    changed
}

#[derive(Deserialize)]
pub(super) struct QuestRequestBody {
    id: String,
    questions: Value,
    #[serde(default)]
    session_id: Option<String>,
}

/// True if `input` is a well-formed AskUserQuestion-shaped tool call (used by
/// `permission::is_auto_accept_eligible` to exempt questions from server-side
/// auto-accept - a question always needs a human, even with auto-accept on).
pub(super) fn is_question_shaped(input: &Value) -> bool {
    let Some(questions) = input.as_object().and_then(|o| o.get("questions")).and_then(|v| v.as_array()) else {
        return false;
    };
    !questions.is_empty()
        && questions.iter().all(|q| {
            q.as_object().and_then(|o| o.get("question")).and_then(|v| v.as_str()).is_some()
        })
}

/// Parameterized fire-and-forget note/deny-reason text: the MCP path names
/// itself "this tool", the builtin path names "AskUserQuestion" - otherwise
/// byte-identical. One function instead of two hardcoded consts (todo 622;
/// `861b4a06` drifted the old copies apart).
fn fire_and_forget_note(tool_label: &str) -> String {
    format!(
        "Your question has been shown to the user in the app and the card is now \
waiting for their answer. Do NOT call {tool_label} again and do NOT keep working \
on this task - end your turn now with at most a brief acknowledgement. The \
user will reply in a separate follow-up message when they're ready, and that \
reply resumes the work in a fresh turn. If they send something unrelated \
instead, treat this question as dropped."
    )
}

/// Shared six-step "post a durable question card" sequence (todo 622): record
/// the durable prompt, push the blocked-notify + jarvis wake, mark the session
/// awaiting, publish both broadcast frames. Returns the `question_request`
/// publish's subscriber count for the MCP caller's own log line.
async fn post_fire_and_forget_question(
    ctx: &Arc<HookCtx>,
    id: &str,
    mut payload: Value,
    session_id: Option<&str>,
    wake_label: &str,
) -> usize {
    // `seq` lets the frontend tell a genuinely newer question apart from a
    // stale/ghost one when it lists multiple pending prompts for the same
    // session - see `DaemonState::prompt_seq`'s doc.
    if let Value::Object(map) = &mut payload {
        map.insert("seq".to_string(), json!(ctx.state.next_prompt_seq()));
    }
    ctx.state.add_prompt(id, "question-requested", payload.clone(), true).await;
    ctx.state.fire_blocked_prompt(session_id, id);
    crate::daemon::jarvis_wake::wake_on_worker_blocked(&ctx.state, session_id, id, Some(wake_label)).await;
    let surfaced = set_question_awaiting(&ctx.state, session_id, true);
    if let Some(sid) = session_id {
        let gen = ctx.state.registry.current_turn_gen(sid);
        ctx.state.registry.mark_question_posted(sid, gen, surfaced);
    }
    let subs = ctx.state.notifier.publish("question_request", payload);
    ctx.state.notifier.publish(
        "turn_sound",
        json!({ "session_id": session_id, "awaiting": "question" }),
    );
    subs
}

/// Well above the normal poll+emit+render round trip (well under 2s, todo
/// 735's feasibility trace), but short enough that "no client attached" - a
/// normal state - fails fast instead of hanging the calling agent.
const RENDER_CONFIRM_TIMEOUT: Duration = Duration::from_secs(8);

/// `true` once a client commits (shown or parked), `false` on timeout -
/// tearing down the waiter either way. Split out so tests can pass a short timeout.
async fn await_render_confirmation(
    state: &Arc<DaemonState>,
    id: &str,
    confirm_rx: oneshot::Receiver<()>,
    timeout: Duration,
) -> bool {
    tokio::select! {
        res = confirm_rx => res.is_ok(),
        _ = tokio::time::sleep(timeout) => {
            state.cancel_render_confirm(id).await;
            false
        }
    }
}

/// No pending answer oneshot, no blocking wait on the USER. It DOES briefly
/// wait on a render-confirmation signal before acking (todo 735), so a caller
/// can no longer get `acknowledged: true` for a card nobody ever saw or parked.
pub(super) async fn on_question_request(
    AxState(ctx): AxState<Arc<HookCtx>>,
    ValidatedJson(body): ValidatedJson<QuestRequestBody>,
) -> impl IntoResponse {
    // todo 824 remaining 1: only the MCP `ask_user_question` tool posts here -
    // the builtin AskUserQuestion PreToolUse hook curls `on_ask_question_hook`
    // instead - so landing here proves the MCP transport is up this turn.
    if let Some(sid) = body.session_id.as_deref() {
        super::mark_mcp_tool_used(&ctx, sid);
    }
    let payload = json!({
        "id": body.id,
        "questions": body.questions,
        "session_id": body.session_id,
    });
    // Registered BEFORE the post so a confirmation that races in fast (a
    // client already polling) can never land before there's a waiter to hit.
    let confirm_rx = ctx.state.register_render_confirm(&body.id).await;
    let subs =
        post_fire_and_forget_question(&ctx, &body.id, payload, body.session_id.as_deref(), "question").await;
    log::info!(
        "[perm-relay] published question_request id={} session={:?} -> {} subscriber(s)",
        body.id, body.session_id, subs
    );
    if !await_render_confirmation(&ctx.state, &body.id, confirm_rx, RENDER_CONFIRM_TIMEOUT).await {
        log::warn!(
            "[perm-relay] question {} not confirmed shown/parked within {:?}; acknowledging false",
            body.id, RENDER_CONFIRM_TIMEOUT
        );
        return (
            StatusCode::OK,
            Json(json!({
                "acknowledged": false,
                "note": "Could not confirm any client actually received this question within the \
timeout window - it may not have reached the user at all. Do not wait any longer on this call. \
Re-send the same question as a plain-text message via send_message right now instead.",
            })),
        );
    }
    (StatusCode::OK, Json(json!({ "acknowledged": true, "note": fire_and_forget_note("this tool") })))
}

/// PreToolUse-hook endpoint for the builtin `AskUserQuestion` tool. The in-app
/// `claude -p` session gets a per-session PreToolUse hook (see
/// `daemon::claude_config::write_hook_settings`) whose command `curl`s the raw
/// hook payload here. We surface the questions through the same relay the MCP
/// `ask_user_question` tool uses (`question_request` -> the chat's question
/// card -> `respond_question`) and return a PreToolUse `deny` whose reason
/// carries feedback. `claude` reads the reason and continues. This is the
/// channel that replaced the dead permission relay: current `claude` no
/// longer routes `AskUserQuestion` through `--permission-prompt-tool`, but a
/// `PreToolUse` hook still fires for it.
///
/// The response body IS the hook's stdout, so it must be exactly the
/// `hookSpecificOutput` decision claude expects - nothing else.
pub(super) async fn on_ask_question_hook(
    AxState(ctx): AxState<Arc<HookCtx>>,
    Json(body): Json<Value>,
) -> impl IntoResponse {
    (StatusCode::OK, Json(ask_question_decision(&ctx, body).await))
}

/// Attempts on/after this one post the degraded card instead of redirecting.
/// Two nudges is the budget: a model that ignores both isn't going to comply,
/// and a hung turn (no ask channel at all) is worse than a thin card.
const BUILTIN_ASK_FALLBACK_THRESHOLD: u32 = 3;

const ASK_REDIRECT_REASON: &str =
    "The built-in AskUserQuestion tool is disabled in this app: its schema \
carries no domain/badges fields and it caps at 4 questions, so a call through \
it would render a degraded card. Call the mcp__cc_conductor__ask_user_question \
tool right now, in this same turn, with the identical question(s) you just \
asked - do not end the turn first and do not call AskUserQuestion again.";

/// Attempts 1 and 2 redirect the model to the MCP tool without posting a card;
/// only the 3rd posts the degraded durable card, flagged `degraded_builtin`
/// for the frontend badge. Split from the axum handler to stay unit-testable.
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

    // No session_id to key the counter on (hook-test / terminal-side calls) -
    // fall straight to posting the card, same as the pre-counter behaviour.
    let attempt = session_id
        .as_deref()
        .map(|sid| ctx.state.registry.record_builtin_ask_attempt(sid));
    if attempt.map(|n| n < BUILTIN_ASK_FALLBACK_THRESHOLD).unwrap_or(false) {
        return deny_decision(ASK_REDIRECT_REASON);
    }

    let id = uuid::Uuid::new_v4().to_string();
    let payload = json!({
        "id": id, "questions": questions, "session_id": session_id.clone(), "degraded_builtin": true,
    });
    post_fire_and_forget_question(ctx, &id, payload, session_id.as_deref(), "AskUserQuestion").await;
    deny_decision(&fire_and_forget_note("AskUserQuestion"))
}

#[cfg(test)]
mod tests {
    use super::{
        ask_question_decision, await_render_confirmation, is_question_shaped, on_question_request,
        AxState, QuestRequestBody, ValidatedJson, HookCtx,
    };
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::daemon::state::DaemonState;
    use crate::types::Settings;
    use axum::response::IntoResponse;
    use serde_json::json;
    use std::sync::Arc;
    use std::time::Duration;

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

    fn ask_body(session_id: &str) -> serde_json::Value {
        json!({
            "session_id": session_id,
            "tool_input": { "questions": [
                { "question": "Tabs or spaces?", "options": [ {"label": "Tabs"}, {"label": "Spaces"} ] }
            ] }
        })
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
        state.registry.record_builtin_ask_attempt("s1");
        state.registry.record_builtin_ask_attempt("s1");

        let mut rx = state.notifier.subscribe();
        let decision = ask_question_decision(&ctx, ask_body("s1")).await;

        let hso = &decision["hookSpecificOutput"];
        assert_eq!(hso["hookEventName"], "PreToolUse");
        assert_eq!(hso["permissionDecision"], "deny");
        let reason = hso["permissionDecisionReason"].as_str().unwrap();
        assert!(reason.contains("card is now"), "3rd attempt must hand back the posted-card reason");

        assert!(state.pending.lock().await.is_empty(), "fire-and-forget must not insert a oneshot");

        let prompts = state.list_prompts().await;
        assert_eq!(prompts.len(), 1, "one recorded prompt");
        assert_eq!(prompts[0]["event"], "question-requested");
        assert_eq!(prompts[0]["durable"], true, "the fire-and-forget prompt must be durable");
        assert_eq!(prompts[0]["payload"]["degraded_builtin"], true);
        let id = prompts[0]["id"].as_str().unwrap().to_string();

        let frame = rx.recv().await.expect("question_request published");
        assert_eq!(frame["method"], "question_request");
        assert_eq!(frame["params"]["session_id"], "s1");
        assert_eq!(frame["params"]["id"].as_str().unwrap(), id);
    }

    /// Piece 1: the 1st and 2nd builtin attempt in a session must NOT post any
    /// prompt - just a deny redirecting the model to the MCP tool.
    #[tokio::test]
    async fn first_two_builtin_attempts_redirect_without_posting_a_card() {
        let state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        let ctx = Arc::new(HookCtx { state: state.clone() });

        for attempt in 1..=2 {
            let decision = ask_question_decision(&ctx, ask_body("s1")).await;
            let hso = &decision["hookSpecificOutput"];
            assert_eq!(hso["permissionDecision"], "deny");
            let reason = hso["permissionDecisionReason"].as_str().unwrap();
            assert!(
                reason.contains("mcp__cc_conductor__ask_user_question"),
                "attempt {attempt} must redirect to the MCP tool"
            );
            assert!(state.list_prompts().await.is_empty(), "attempt {attempt} must not post a card");
        }
    }

    /// Piece 1: the 3rd attempt falls back to posting the durable card, carrying
    /// the `degraded_builtin` cross-builder flag the frontend badges on.
    #[tokio::test]
    async fn third_builtin_attempt_posts_degraded_card() {
        let state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        let ctx = Arc::new(HookCtx { state: state.clone() });

        for _ in 1..=2 {
            ask_question_decision(&ctx, ask_body("s1")).await;
        }
        let decision = ask_question_decision(&ctx, ask_body("s1")).await;
        let reason = decision["hookSpecificOutput"]["permissionDecisionReason"].as_str().unwrap();
        assert!(reason.contains("card is now"), "3rd attempt must post and hand back the posted-card reason");

        let prompts = state.list_prompts().await;
        assert_eq!(prompts.len(), 1);
        assert_eq!(prompts[0]["payload"]["degraded_builtin"], true);
    }

    /// Piece 1: two sessions must not share an attempt budget.
    #[tokio::test]
    async fn attempt_counter_is_per_session_id() {
        let state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        let ctx = Arc::new(HookCtx { state: state.clone() });

        ask_question_decision(&ctx, ask_body("s1")).await;
        ask_question_decision(&ctx, ask_body("s1")).await;
        // s1 is now primed for its 3rd (fallback) attempt; s2 must still be on
        // its 1st and redirect, not inherit s1's count.
        let decision = ask_question_decision(&ctx, ask_body("s2")).await;
        let reason = decision["hookSpecificOutput"]["permissionDecisionReason"].as_str().unwrap();
        assert!(reason.contains("mcp__cc_conductor__ask_user_question"), "s2 must start at attempt 1");
        assert!(state.list_prompts().await.is_empty(), "s2's 1st attempt must not post a card");
    }

    /// A durable AskUserQuestion prompt must SURVIVE the asking turn's EOF: the
    /// pump loop calls `expire_prompts_for_session` when the child closes, and
    /// that must not wipe a fire-and-forget card the user hasn't answered yet.
    #[tokio::test]
    async fn durable_question_survives_turn_end_expiry() {
        let state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        let ctx = Arc::new(HookCtx { state: state.clone() });
        state.registry.record_builtin_ask_attempt("s1");
        state.registry.record_builtin_ask_attempt("s1");
        ask_question_decision(&ctx, ask_body("s1")).await;
        assert_eq!(state.list_prompts().await.len(), 1);

        // The child EOFs at turn end -> expiry runs. The durable card stays.
        let expired = state.expire_prompts_for_session("s1").await;
        assert_eq!(expired, 0, "durable question must be skipped by turn-end expiry");
        assert_eq!(state.list_prompts().await.len(), 1, "card still open for the user to answer");
    }

    /// `expire_prompts_for_session` is also the reset point for the builtin
    /// attempt counter (a fresh `claude -p` child per turn), so a new turn
    /// gets a fresh redirect budget instead of inheriting the old turn's count.
    #[tokio::test]
    async fn expiry_resets_the_builtin_attempt_counter() {
        let state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        let ctx = Arc::new(HookCtx { state: state.clone() });
        ask_question_decision(&ctx, ask_body("s1")).await;
        ask_question_decision(&ctx, ask_body("s1")).await;

        state.expire_prompts_for_session("s1").await;

        let decision = ask_question_decision(&ctx, ask_body("s1")).await;
        let reason = decision["hookSpecificOutput"]["permissionDecisionReason"].as_str().unwrap();
        assert!(reason.contains("mcp__cc_conductor__ask_user_question"), "counter must have reset to attempt 1");
    }

    /// No pending answer oneshot is ever inserted - simulates the "shown"
    /// frontend branch confirming almost immediately, well inside the timeout.
    #[tokio::test]
    async fn question_request_acks_true_once_shown_branch_confirms() {
        let state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        let ctx = Arc::new(HookCtx { state: state.clone() });
        let mut rx = state.notifier.subscribe();

        let body = QuestRequestBody {
            id: "q1".to_string(),
            questions: json!([{ "question": "Tabs or spaces?" }]),
            session_id: Some("s1".to_string()),
        };
        let confirmer_state = state.clone();
        let confirmer = tokio::spawn(async move {
            // A tiny head start lets on_question_request register its waiter
            // first - mirrors the real ordering (register happens before the
            // frontend can possibly have mounted anything).
            tokio::time::sleep(Duration::from_millis(10)).await;
            confirmer_state.confirm_question_rendered("q1").await;
        });
        let resp = on_question_request(AxState(ctx), ValidatedJson(body)).await.into_response();
        confirmer.await.unwrap();
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        let decision: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(decision["acknowledged"], true);

        assert!(state.pending.lock().await.is_empty(), "fire-and-forget must not insert a oneshot");
        let prompts = state.list_prompts().await;
        assert_eq!(prompts.len(), 1, "one recorded prompt");
        assert_eq!(prompts[0]["event"], "question-requested");
        assert_eq!(prompts[0]["durable"], true, "must be durable so turn-end can't wipe it");

        let frame = rx.recv().await.expect("question_request published");
        assert_eq!(frame["method"], "question_request");
        assert_eq!(frame["params"]["session_id"], "s1");
    }

    /// The daemon can't tell a "shown" confirmation from a "parked" one - both
    /// branches call the exact same RPC, and a backgrounded park is just as
    /// genuine a delivery as mounting the card DOM (todo 735 requires both).
    #[tokio::test]
    async fn question_request_acks_true_once_parked_branch_confirms() {
        let state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        let ctx = Arc::new(HookCtx { state: state.clone() });

        let body = QuestRequestBody {
            id: "q2".to_string(),
            questions: json!([{ "question": "Tabs or spaces?" }]),
            session_id: Some("s1".to_string()),
        };
        let confirmer_state = state.clone();
        let confirmer = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(10)).await;
            // Stands in for index.ts's parked branch (storePendingPrompt +
            // rerenderSidebar) calling the same RPC as the render path.
            confirmer_state.confirm_question_rendered("q2").await;
        });
        let resp = on_question_request(AxState(ctx), ValidatedJson(body)).await.into_response();
        confirmer.await.unwrap();
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        let decision: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(decision["acknowledged"], true, "a parked prompt is a genuine delivery, not a drop");
    }

    /// Timeout path: nobody ever confirms (no client attached - a normal
    /// state). Drives the helper directly with a short timeout instead of
    /// waiting out the real (multi-second) production ceiling.
    #[tokio::test]
    async fn await_render_confirmation_reports_false_and_cleans_up_on_timeout() {
        let state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        let confirm_rx = state.register_render_confirm("q3").await;

        let rendered = await_render_confirmation(&state, "q3", confirm_rx, Duration::from_millis(30)).await;

        assert!(!rendered, "no confirmation ever arrives -> must report false, not hang or silently succeed");
        assert!(
            state.render_confirm.lock().await.get("q3").is_none(),
            "a timed-out waiter must be torn down, not leaked"
        );
    }

    #[tokio::test]
    async fn ask_question_with_no_questions_denies_without_blocking() {
        let state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        let ctx = Arc::new(HookCtx { state });
        let decision = ask_question_decision(&ctx, json!({ "tool_input": {} })).await;
        assert_eq!(decision["hookSpecificOutput"]["permissionDecision"], "deny");
    }
}
