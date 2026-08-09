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
const BOTH_MISSING_REASON: &str = "Before ending your turn, call BOTH tools: report_turn_status (required every turn, even a tool-only one with no chat reply; it requires a 'status' argument - one of done|question|waiting|working, calling it with no arguments will fail) and send_message (the ONLY channel Joe sees - your assistant text and tool-call narration are not rendered in the chat at all; send him a terse, self-contained summary of what happened this turn).";

/// `Some(true)` means a prior Stop already blocked this turn, so never block again.
/// Pure so it stays testable without a live Session/ChildStdin.
fn missing_requirement_reason(stop_hook_active: Option<bool>, has_report: bool, has_send: bool) -> Option<&'static str> {
    if stop_hook_active == Some(true) {
        return None;
    }
    match (has_report, has_send) {
        (false, false) => Some(BOTH_MISSING_REASON),
        (false, true) => Some(REPORT_MISSING_REASON),
        (true, false) => Some(SEND_MISSING_REASON),
        (true, true) => None,
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
        // Record the CLI's live background-task count BEFORE returning: the
        // CLI holds the `result` line until this hook responds, so the pump's
        // result-line handler always reads a fresh count (see
        // `daemon::lifecycle`'s awaiting override).
        let bg_count = payload.background_tasks.as_ref().map(Vec::len).unwrap_or(0);
        ctx.state.registry.set_background_tasks(&session_id, bg_count);

        // Enforcement (todo 435 + quiet-mode fix): block once (stop_hook_active
        // caps the retry) if report_turn_status and/or send_message weren't
        // called this turn - folded into ONE block, see missing_requirement_reason.
        let gen = ctx.state.registry.current_turn_gen(&session_id);
        let reported = ctx.state.registry.peek_reported_status(&session_id);
        let has_current_report = reported.as_ref().map(|r| r.turn_gen == gen).unwrap_or(false);
        let has_current_send = ctx.state.registry.peek_message_sent_gen(&session_id).map(|g| g == gen).unwrap_or(false);
        if let Some(reason) = missing_requirement_reason(payload.stop_hook_active, has_current_report, has_current_send) {
            log::info!(
                "hook /hooks/stop: blocking {session_id} - report_turn_status={has_current_report} send_message={has_current_send}"
            );
            return (StatusCode::OK, Json(json!({"decision": "block", "reason": reason})));
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

    #[test]
    fn report_present_send_absent_blocks_with_send_reason() {
        assert_eq!(missing_requirement_reason(None, true, false), Some(SEND_MISSING_REASON));
    }

    #[test]
    fn report_absent_send_present_blocks_with_report_reason() {
        assert_eq!(missing_requirement_reason(None, false, true), Some(REPORT_MISSING_REASON));
    }

    #[test]
    fn both_absent_blocks_with_combined_reason() {
        assert_eq!(missing_requirement_reason(None, false, false), Some(BOTH_MISSING_REASON));
    }

    #[test]
    fn both_present_does_not_block() {
        assert_eq!(missing_requirement_reason(None, true, true), None);
    }

    #[test]
    fn stop_hook_active_true_never_blocks_even_with_both_missing() {
        assert_eq!(missing_requirement_reason(Some(true), false, false), None);
    }

    #[test]
    fn stop_hook_active_false_still_enforces() {
        assert_eq!(missing_requirement_reason(Some(false), false, false), Some(BOTH_MISSING_REASON));
    }
}
