//! Stop endpoint: `/hooks/stop`. Parses the transcript for skill-usage events
//! and records them on a background task.

use super::stop_verdict::{
    missing_requirement_reason, mcp_is_attached, streak_update, StreakUpdate, TurnEndVerdict,
    QUESTION_UNDELIVERED_REASON,
};
use super::HookCtx;
use crate::settings::paths;
use axum::{extract::State as AxState, http::StatusCode, response::IntoResponse, Json};
use serde::Deserialize;
use serde_json::json;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::Arc;

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
            payload.background_tasks.as_deref(),
            payload.session_crons.as_deref().unwrap_or(&[]),
        );
        ctx.state.registry.set_turn_activity(&session_id, activity);
        // The verdict that can override a self-reported status, so a row stuck
        // reading in-progress is diagnosable from the log alone.
        log::info!(
            "hook /hooks/stop: {session_id} activity={activity:?} background_tasks={} session_crons={}",
            payload.background_tasks.as_ref().map_or("absent".to_string(), |t| t.len().to_string()),
            payload.session_crons.as_ref().map_or("absent".to_string(), |c| c.len().to_string()),
        );

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
        let mcp_config_written = ctx
            .state
            .sessions
            .get(&session_id)
            .map(|s| s.mcp_config_path.is_some())
            .unwrap_or(false);
        let miss_streak = ctx
            .state
            .sessions
            .get(&session_id)
            .map(|s| s.mcp_miss_streak.load(Ordering::Relaxed))
            .unwrap_or(0);
        let mcp_attached = mcp_is_attached(mcp_config_written, miss_streak);
        let verdict = missing_requirement_reason(payload.stop_hook_active, has_current_report, has_current_send, status, opened_by_wake, mcp_attached);
        let mcp_tool_used_this_turn =
            ctx.state.registry.peek_mcp_tool_used_gen(&session_id).map(|g| g == gen).unwrap_or(false);
        let update = streak_update(payload.stop_hook_active, &verdict, mcp_tool_used_this_turn);
        if let Some(session) = ctx.state.sessions.get(&session_id) {
            match update {
                StreakUpdate::Reset => session.mcp_miss_streak.store(0, Ordering::Relaxed),
                StreakUpdate::Increment => {
                    session.mcp_miss_streak.fetch_add(1, Ordering::Relaxed);
                }
                StreakUpdate::Unchanged => {}
            }
        }
        // todo 824 remaining 2 (optional): one-time note when a streak that had
        // already crossed the threshold resets - the transport just came back.
        if !mcp_attached && matches!(update, StreakUpdate::Reset) {
            log::info!("hook /hooks/stop: MCP transport for {session_id} reconnected after a {miss_streak}-turn miss streak");
        }
        match verdict {
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
        // Past every early return above, so this only runs when the turn is
        // genuinely over (a `block` keeps it alive, and its subagents with it).
        // Anything still tracked finished without firing `SubagentStop`;
        // carrying it forward would make a later interrupt blame subagents that
        // stopped running turns ago. See `hooks_server::subagents`.
        ctx.state.clear_live_subagents(&session_id);
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

/// `/mcp/announce`: `run_stdio` posts here once at startup (todo 824
/// remaining 2). Reuses `mark_mcp_tool_used` so a live process resets the
/// miss streak without waiting for a real tool call this turn.
pub(super) async fn on_mcp_announce(
    AxState(ctx): AxState<Arc<HookCtx>>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    let session_id = body["session_id"].as_str().unwrap_or_default();
    if !session_id.is_empty() {
        super::mark_mcp_tool_used(&ctx, session_id);
    }
    (StatusCode::OK, Json(json!({"ok": true})))
}

// Route level needs a live Session/ChildStdin (the `contains_key` gate above),
// so the pure decision core in `stop_verdict.rs` carries the enforcement
// coverage instead; this module keeps only route-level coverage.
#[cfg(test)]
mod tests {
    use super::*;

    // todo 824 remaining 2: `/mcp/announce` route-level coverage.
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::daemon::state::DaemonState;
    use crate::types::Settings;

    fn announce_ctx() -> Arc<HookCtx> {
        Arc::new(HookCtx { state: DaemonState::new(new_session_map(), SettingsCache::new(Settings::default())) })
    }

    #[tokio::test]
    async fn announce_marks_mcp_tool_used_for_the_current_gen() {
        let c = announce_ctx();
        let body = json!({"session_id": "s"});
        let resp = on_mcp_announce(AxState(c.clone()), Json(body)).await.into_response();
        assert_eq!(resp.status(), StatusCode::OK);
        let gen = c.state.registry.current_turn_gen("s");
        assert_eq!(c.state.registry.peek_mcp_tool_used_gen("s"), Some(gen));
    }

    #[tokio::test]
    async fn announce_with_no_session_id_does_not_mark_anything() {
        let c = announce_ctx();
        let resp = on_mcp_announce(AxState(c.clone()), Json(json!({}))).await.into_response();
        assert_eq!(resp.status(), StatusCode::OK);
        assert!(c.state.registry.peek_mcp_tool_used_gen("").is_none());
    }
}
