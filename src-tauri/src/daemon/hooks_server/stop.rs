//! Stop endpoint: `/hooks/stop`. Parses the transcript for skill-usage events
//! and records them on a background task.

use super::HookCtx;
use crate::settings::paths;
use axum::{extract::State as AxState, http::StatusCode, response::IntoResponse, Json};
use serde::Deserialize;
use serde_json::json;
use std::path::PathBuf;
use std::sync::Arc;

/// One reason per missing combination: both checks fold into a single block
/// because `stop_hook_active` caps the retry at one block per turn.
const REPORT_MISSING_REASON: &str = "Call the report_turn_status tool as the very last thing you do before ending your turn - required every turn, even a tool-only one with no chat reply. It requires a 'status' argument (one of done|question|waiting|working) - calling it with no arguments will fail.";
const SEND_MISSING_REASON: &str = "Call the send_message tool before ending your turn - it is the ONLY channel Joe sees. Your assistant text and tool-call narration are not rendered in the chat at all. Send him a terse, self-contained summary of what happened this turn.";
/// todo 818: `ask_user_question` answers `{"acknowledged": true}` the instant
/// the daemon takes the card, so a card that surfaced NOWHERE looks identical
/// to a delivered one and the turn ends waiting for an answer nobody can give.
const QUESTION_UNDELIVERED_REASON: &str = "Your ask_user_question card was accepted but never surfaced - this session is not in the app's live registry, so no window, sidebar row or phone ever showed it and no answer can ever arrive. Do NOT end the turn waiting on it: ask the same question as plain text through send_message instead, and carry on from the user's reply.";
const BOTH_MISSING_REASON: &str = "Before ending your turn, call BOTH tools: report_turn_status (required every turn, even a tool-only one with no chat reply; it requires a 'status' argument - one of done|question|waiting|working, calling it with no arguments will fail) and send_message (the ONLY channel Joe sees - your assistant text and tool-call narration are not rendered in the chat at all; send him a terse, self-contained summary of what happened this turn).";
/// todo 824: shown instead of a block when this session's MCP transport
/// isn't attached, so report_turn_status/send_message are unreachable and
/// demanding them would be an unsatisfiable loop.
const MCP_UNAVAILABLE_REASON: &str = "report_turn_status/send_message weren't called, but this session's MCP transport isn't attached right now, so those tools are unreachable - not blocking on it. Assistant text is a real fallback channel; use it if you need to reach Joe, and the MCP tools again once they reappear.";

/// Verdict from [`missing_requirement_reason`]: `Block` halts the turn end,
/// `Inform` returns a non-blocking, softened note (MCP transport down),
/// `Ok` lets the turn end silently.
#[derive(Debug, PartialEq, Eq)]
enum TurnEndVerdict {
    Ok,
    Block(&'static str),
    Inform(&'static str),
}

/// `Some(true)` means a prior Stop already blocked this turn, so never block again.
/// Pure so it stays testable without a live Session/ChildStdin.
///
/// `status` gates the send_message half: a turn reporting `working`/`waiting`
/// is mid-chain and something will re-invoke Claude, so silence is fine there.
/// Same for `done` on a wake-opened turn (todo 607, `opened_by_wake`) - nobody
/// asked, so `done` owes only the report, not a chat message.
/// `mcp_attached` false (todo 824) degrades a missing call to `Inform`
/// instead of `Block`: the tool itself is unreachable then.
fn missing_requirement_reason(
    stop_hook_active: Option<bool>,
    has_report: bool,
    has_send: bool,
    status: Option<&str>,
    opened_by_wake: bool,
    mcp_attached: bool,
) -> TurnEndVerdict {
    if stop_hook_active == Some(true) {
        return TurnEndVerdict::Ok;
    }
    let send_required = !opened_by_wake && !matches!(status, Some("working") | Some("waiting"));
    let missing = match (has_report, has_send || !send_required) {
        (false, false) => Some(BOTH_MISSING_REASON),
        (false, true) => Some(REPORT_MISSING_REASON),
        (true, false) => Some(SEND_MISSING_REASON),
        (true, true) => None,
    };
    match missing {
        None => TurnEndVerdict::Ok,
        Some(reason) if mcp_attached => TurnEndVerdict::Block(reason),
        Some(_) => TurnEndVerdict::Inform(MCP_UNAVAILABLE_REASON),
    }
}

#[derive(Deserialize, Debug, Default)]
pub(super) struct StopPayload {
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub transcript_path: Option<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    /// True when this Stop fires because a previous Stop hook already blocked
    /// this same turn - the CLI's loop guard. Never block when set.
    #[serde(default)]
    pub stop_hook_active: Option<bool>,
    /// Background tasks still live at turn end - ground truth for the
    /// "working" status, unlike the self-reported marker.
    #[serde(default)]
    pub background_tasks: Option<Vec<serde_json::Value>>,
    /// Scheduled wakes still pending for this session. Non-empty means the
    /// session is parked on a future trigger, i.e. `waiting`, no guessing.
    #[serde(default)]
    pub session_crons: Option<Vec<serde_json::Value>>,
}

pub(super) async fn on_stop(
    AxState(ctx): AxState<Arc<HookCtx>>,
    Json(payload): Json<StopPayload>,
) -> impl IntoResponse {
    log::info!(
        "hook /hooks/stop: session={} cwd={} transcript={}",
        payload.session_id.as_deref().unwrap_or("-"),
        payload.cwd.as_deref().unwrap_or("-"),
        payload.transcript_path.as_deref().unwrap_or("-"),
    );

    let Some(transcript_path) = payload.transcript_path.clone() else {
        return (StatusCode::OK, Json(json!({"ok": true, "reason": "no transcript"})));
    };
    let Some(session_id) = payload.session_id.clone() else {
        return (StatusCode::OK, Json(json!({"ok": true, "reason": "no session_id"})));
    };

    // Daemon-hosted chats only: this global hook also fires for the dev's own
    // terminal sessions, which must never be status-tracked or blocked.
    if ctx.state.sessions.contains_key(&session_id) {
        // Record BEFORE returning: the CLI holds the `result` line until this
        // hook responds, so the pump's result-line handler always reads a
        // fresh verdict (see `daemon::lifecycle`'s awaiting override).
        let activity = super::activity::classify(
            payload.background_tasks.as_deref().unwrap_or(&[]),
            payload.session_crons.as_deref().unwrap_or(&[]),
        );
        ctx.state.registry.set_turn_activity(&session_id, activity);

        // Enforcement (todo 435 + quiet-mode fix): block once (stop_hook_active
        // caps the retry) if report_turn_status and/or send_message weren't
        // called this turn - folded into ONE block, see missing_requirement_reason.
        let gen = ctx.state.registry.current_turn_gen(&session_id);
        // Checked before the report/send pair: one block per turn is all
        // `stop_hook_active` allows, and a question nobody can see is the more
        // urgent of the two failures.
        if payload.stop_hook_active != Some(true)
            && ctx.state.registry.question_undelivered_this_turn(&session_id, gen)
        {
            log::warn!("hook /hooks/stop: blocking {session_id} - ask_user_question card never surfaced");
            return (
                StatusCode::OK,
                Json(json!({"decision": "block", "reason": QUESTION_UNDELIVERED_REASON})),
            );
        }
        let reported = ctx.state.registry.peek_reported_status(&session_id);
        let has_current_report = reported.as_ref().map(|r| r.turn_gen == gen).unwrap_or(false);
        let has_current_send = ctx.state.registry.peek_message_sent_gen(&session_id).map(|g| g == gen).unwrap_or(false);
        let status = reported.as_ref().filter(|r| r.turn_gen == gen).map(|r| r.status.as_str());
        let opened_by_wake = ctx.state.registry.is_turn_opened_by_wake(&session_id, gen);
        // todo 824: mcp_config_path is only set for sessions the daemon
        // actually wrote a per-session .mcp.json for at spawn - the closest
        // attachment signal available without a live disconnect feed.
        let mcp_attached = ctx
            .state
            .sessions
            .get(&session_id)
            .map(|s| s.mcp_config_path.is_some())
            .unwrap_or(false);
        match missing_requirement_reason(payload.stop_hook_active, has_current_report, has_current_send, status, opened_by_wake, mcp_attached) {
            TurnEndVerdict::Ok => {}
            TurnEndVerdict::Block(reason) => {
                log::info!(
                    "hook /hooks/stop: blocking {session_id} - report_turn_status={has_current_report} send_message={has_current_send}"
                );
                return (StatusCode::OK, Json(json!({"decision": "block", "reason": reason})));
            }
            TurnEndVerdict::Inform(reason) => {
                log::info!(
                    "hook /hooks/stop: not blocking {session_id} - MCP transport not attached (report_turn_status={has_current_report} send_message={has_current_send})"
                );
                return (StatusCode::OK, Json(json!({"ok": true, "reason": reason})));
            }
        }
        // Title: durable transcript record, mirrors /close's manual rename.
        // Best-effort - a write failure must never block the turn.
        if let Some(title) = reported.as_ref().filter(|r| r.turn_gen == gen).and_then(|r| r.title.as_deref()) {
            if !title.trim().is_empty() {
                if let Err(e) = crate::tokens::append_ai_title_record(std::path::Path::new(&transcript_path), title) {
                    log::warn!("hook /hooks/stop: failed to append ai-title record for {session_id}: {e}");
                }
            }
        }
        // todo 675: same "carried, not yet wired to a client" state as
        // pump.rs's result-line handler - this is the earliest point a
        // waiting target is visible, since Stop fires before pump's take.
        if let Some(target) = reported.as_ref().filter(|r| r.turn_gen == gen).and_then(|r| r.waiting_on.as_ref()) {
            log::info!("hook /hooks/stop: session {session_id} waiting on: {target}");
        }
    }

    let state = ctx.state.clone();
    tokio::spawn(async move {
        let dir = match paths::skill_usage_dir() {
            Ok(d) => d,
            Err(e) => {
                log::warn!("skill_usage_dir failed: {e}");
                return;
            }
        };
        let transcript = PathBuf::from(transcript_path);
        let events = tokio::task::spawn_blocking(move || {
            crate::skill_usage::parser::parse_transcript(&transcript)
        })
        .await
        .unwrap_or_default();

        // mark_session stays file-based: it's a per-session/per-day dedup marker
        // (records that a session ran AT ALL, even with zero skill events) that
        // feeds `total_sessions`. The SQLite store has no per-session marker
        // table, so preserving it here keeps that count correct. Skill EVENTS
        // now go to the DB instead of the per-day events-*.jsonl files.
        let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
        if let Err(e) = crate::skill_usage::store::mark_session(&dir, &session_id, &today) {
            log::warn!("mark_session failed: {e}");
        }
        if !events.is_empty() {
            if let Some(db) = state.db.clone() {
                let _ = tokio::task::spawn_blocking(move || {
                    let mgr = db.lock().unwrap_or_else(|p| p.into_inner());
                    let conn = mgr.conn();
                    for event in &events {
                        if let Err(e) = crate::storage::skill_store::insert_skill_event(conn, event) {
                            log::warn!("daemon: insert_skill_event failed: {e:#}");
                        }
                    }
                })
                .await;
            } else {
                log::warn!("daemon: companion.db unavailable; dropping {} skill event(s)", events.len());
            }
        }
        state.notifier.publish("skill_usage_changed", json!({}));
    });

    (StatusCode::OK, Json(json!({"ok": true})))
}

// Route level needs a live Session/ChildStdin (the `contains_key` gate above),
// so the pure decision core carries the enforcement coverage instead.
#[cfg(test)]
mod tests {
    use super::*;

    const DONE: Option<&str> = Some("done");

    #[test]
    fn report_present_send_absent_blocks_with_send_reason() {
        assert_eq!(missing_requirement_reason(None, true, false, DONE, false, true), TurnEndVerdict::Block(SEND_MISSING_REASON));
    }

    #[test]
    fn report_absent_send_present_blocks_with_report_reason() {
        assert_eq!(missing_requirement_reason(None, false, true, DONE, false, true), TurnEndVerdict::Block(REPORT_MISSING_REASON));
    }

    #[test]
    fn both_absent_blocks_with_combined_reason() {
        assert_eq!(missing_requirement_reason(None, false, false, DONE, false, true), TurnEndVerdict::Block(BOTH_MISSING_REASON));
    }

    #[test]
    fn both_present_does_not_block() {
        assert_eq!(missing_requirement_reason(None, true, true, DONE, false, true), TurnEndVerdict::Ok);
    }

    #[test]
    fn stop_hook_active_true_never_blocks_even_with_both_missing() {
        assert_eq!(missing_requirement_reason(Some(true), false, false, DONE, false, true), TurnEndVerdict::Ok);
    }

    #[test]
    fn stop_hook_active_false_still_enforces() {
        assert_eq!(missing_requirement_reason(Some(false), false, false, DONE, false, true), TurnEndVerdict::Block(BOTH_MISSING_REASON));
    }

    #[test]
    fn mid_chain_working_turn_may_stay_silent() {
        assert_eq!(missing_requirement_reason(None, true, false, Some("working"), false, true), TurnEndVerdict::Ok);
    }

    #[test]
    fn mid_chain_waiting_turn_may_stay_silent() {
        assert_eq!(missing_requirement_reason(None, true, false, Some("waiting"), false, true), TurnEndVerdict::Ok);
    }

    #[test]
    fn a_silent_working_turn_still_owes_a_status_report() {
        assert_eq!(
            missing_requirement_reason(None, false, false, Some("working"), false, true),
            TurnEndVerdict::Block(REPORT_MISSING_REASON),
        );
    }

    #[test]
    fn question_turn_still_requires_a_message() {
        assert_eq!(
            missing_requirement_reason(None, true, false, Some("question"), false, true),
            TurnEndVerdict::Block(SEND_MISSING_REASON),
        );
    }

    #[test]
    fn unreported_status_defaults_to_requiring_a_message() {
        assert_eq!(missing_requirement_reason(None, true, false, None, false, true), TurnEndVerdict::Block(SEND_MISSING_REASON));
    }

    #[test]
    fn wake_opened_done_turn_may_stay_silent() {
        // todo 607: a peer-channel/Jarvis/scheduled wake that resolves to
        // "nothing to do" has nobody to answer - report still required, but
        // `done` no longer compels a chat message.
        assert_eq!(missing_requirement_reason(None, true, false, DONE, true, true), TurnEndVerdict::Ok);
    }

    #[test]
    fn wake_opened_turn_still_owes_a_status_report() {
        assert_eq!(
            missing_requirement_reason(None, false, false, DONE, true, true),
            TurnEndVerdict::Block(REPORT_MISSING_REASON),
        );
    }

    #[test]
    fn user_opened_done_turn_still_requires_a_message() {
        // Unchanged: opened_by_wake=false is the default path every existing
        // `DONE` test above already covers, restated here for contrast with
        // the wake-opened cases.
        assert_eq!(missing_requirement_reason(None, true, false, DONE, false, true), TurnEndVerdict::Block(SEND_MISSING_REASON));
    }

    // todo 824: MCP transport not attached degrades every would-be block to
    // a non-blocking, softened note instead.
    #[test]
    fn mcp_not_attached_informs_instead_of_blocking_on_send() {
        assert_eq!(missing_requirement_reason(None, true, false, DONE, false, false), TurnEndVerdict::Inform(MCP_UNAVAILABLE_REASON));
    }

    #[test]
    fn mcp_not_attached_informs_instead_of_blocking_on_report() {
        assert_eq!(missing_requirement_reason(None, false, true, DONE, false, false), TurnEndVerdict::Inform(MCP_UNAVAILABLE_REASON));
    }

    #[test]
    fn mcp_not_attached_informs_instead_of_blocking_on_both() {
        assert_eq!(missing_requirement_reason(None, false, false, DONE, false, false), TurnEndVerdict::Inform(MCP_UNAVAILABLE_REASON));
    }

    #[test]
    fn mcp_not_attached_still_silent_when_nothing_missing() {
        assert_eq!(missing_requirement_reason(None, true, true, DONE, false, false), TurnEndVerdict::Ok);
    }

    #[test]
    fn mcp_not_attached_stop_hook_active_still_never_blocks() {
        assert_eq!(missing_requirement_reason(Some(true), false, false, DONE, false, false), TurnEndVerdict::Ok);
    }
}
