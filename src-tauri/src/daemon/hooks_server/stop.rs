//! Stop endpoint: `/hooks/stop`. Parses the transcript for skill-usage events
//! and records them on a background task.

use super::stop_verdict::{
    missing_requirement_reason, mcp_is_attached, streak_update, sub_turn_end, title_missing, StreakUpdate, SubTurnEnd,
    SubTurnFacts, TurnEndVerdict, QUESTION_UNDELIVERED_REASON, TITLE_MISSING_REASON,
};
use super::HookCtx;
use crate::context_status::tail::CursorStore;
use crate::settings::paths;
use crate::skill_usage::parser::SkillTail;
use axum::{extract::State as AxState, http::StatusCode, response::IntoResponse, Json};
use serde::Deserialize;
use serde_json::json;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::Arc;

/// Where each chat's skill-usage parse stopped in its transcript.
static SKILL_CURSORS: std::sync::LazyLock<CursorStore<SkillTail>> =
    std::sync::LazyLock::new(|| CursorStore::new("skills"));

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

    // The turn is over, so no commit call of this session is still running.
    if let Some(id) = payload.session_id.as_deref() {
        super::commit_lock::release_held_by(&ctx.state, id);
    }
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
        let question_card_posted = question_card_is_up(&ctx.state, &session_id, gen).await;
        // A sub owes `finish_subchat` instead of the report/send pair, so it
        // takes its own sequence (block once, nudge once, then a card) and the
        // verdict below passes for it.
        let is_sub = ctx.state.registry.get(&session_id).is_some_and(|i| crate::daemon::subchats::is_sub(&i));
        if is_sub {
            if let Some(reason) = sub_stop(
                &ctx.state,
                &session_id,
                gen,
                payload.stop_hook_active,
                activity,
                status,
                question_card_posted,
                mcp_attached,
            )
            .await
            {
                return (StatusCode::OK, Json(json!({"decision": "block", "reason": reason})));
            }
        }
        let verdict = report_send_verdict(
            is_sub,
            payload.stop_hook_active,
            has_current_report,
            has_current_send,
            status,
            opened_by_wake,
            mcp_attached,
            question_card_posted,
        );
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
            TurnEndVerdict::Ok => {
                let report_title = reported.as_ref().filter(|r| r.turn_gen == gen).and_then(|r| r.title.as_deref());
                let tp = std::path::Path::new(&transcript_path);
                if !is_sub && title_missing(payload.stop_hook_active, has_current_report, status, report_title, opened_by_wake, mcp_attached, tp) {
                    log::info!("hook /hooks/stop: blocking {session_id} - chat has no title yet");
                    return (StatusCode::OK, Json(json!({"decision": "block", "reason": TITLE_MISSING_REASON})));
                }
            }
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
        // Settle the row now instead of at the `result` line: the CLI emits that
        // line only after every OTHER Stop hook finishes and has been seen
        // trailing this hook by 5s to 7 minutes, the whole time reading In
        // Progress. Gated on a report for THIS gen so a late Stop from a
        // superseded turn can't clear a newer turn's busy. The pump's result
        // handler re-applies the same values, so this stays idempotent.
        if let Some(status) = status {
            if settle_at_stop(&ctx.state, &session_id, gen, status, activity).await {
                crate::sessions::chat_state::set_busy(&session_id, false);
            }
        }
        close_now_if_confirmed(&ctx.state, &session_id);
        // Title: durable transcript record, mirrors a manual rename.
        // Best-effort - a write failure must never block the turn.
        // Not for a sub: its name was given at spawn and a title it wrote would
        // rename it on the next restart.
        let fixed_name = crate::daemon::subchats::name_is_fixed(&ctx.state.registry, &session_id);
        if let Some(title) = reported.as_ref().filter(|r| r.turn_gen == gen && !fixed_name).and_then(|r| r.title.as_deref()) {
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
        let cursor_key = session_id.clone();
        // Only the lines appended since this chat's previous Stop: the cursor
        // is per session and persisted, so a restart does not re-read the file
        // and re-emit every past invocation.
        let events = tokio::task::spawn_blocking(move || {
            SKILL_CURSORS.with(crate::context_status::tail::cursor_dir().as_deref(), &cursor_key, |tail| {
                crate::skill_usage::parser::parse_transcript_tail(&transcript, tail)
            })
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

/// Tears down a chat whose `close_session` call was confirmed, as soon as its
/// turn is over. The pump would do it at the `result` line, but the CLI emits
/// that only after every other Stop hook finishes, which has run 4 minutes
/// behind this hook (2026-11-05): long enough for Joe to type again, and that
/// message resumed the chat the daemon was about to kill. `mark_ended` clears
/// the flag, so the pump's EOF handler finds nothing left to tear down.
fn close_now_if_confirmed(state: &Arc<crate::daemon::state::DaemonState>, session_id: &str) {
    if !state.registry.peek_close_requested(session_id) {
        return;
    }
    let Some(session) = state.sessions.get(session_id).map(|s| s.value().clone()) else { return };
    crate::daemon::pump::close::finalize_close(state, &session);
}

/// The per-turn `report_turn_status` + `send_message` duty. A sub is excused:
/// `finish_subchat` replaces it, and `sub_stop` enforces that instead.
#[allow(clippy::too_many_arguments)]
fn report_send_verdict(
    is_sub: bool,
    stop_hook_active: Option<bool>,
    has_report: bool,
    has_send: bool,
    status: Option<&str>,
    opened_by_wake: bool,
    mcp_attached: bool,
    question_card_posted: bool,
) -> TurnEndVerdict {
    if is_sub {
        return TurnEndVerdict::Ok;
    }
    missing_requirement_reason(
        stop_hook_active,
        has_report,
        has_send,
        status,
        opened_by_wake,
        mcp_attached,
        question_card_posted,
    )
}

/// The Stop hook's half of a sub's turn end: records what the turn owes and
/// returns the block text when the one block should be spent. The nudge goes
/// out once the turn is over (`subchats::turn_end`); the card needs no idle
/// child, so it goes up at once.
///
/// Exempt, so the turn simply ends: a `finish_subchat` this turn, a pending
/// question or permission card, background work, a pause (`subchats::pause`:
/// a freeze, a gaming-mode park, a rate limit), and a place in the writer
/// slot's queue: the write guard told that sub to end its turn and wait, and it
/// is woken when the slot is its own.
#[allow(clippy::too_many_arguments)]
async fn sub_stop(
    state: &Arc<crate::daemon::state::DaemonState>,
    sub_id: &str,
    gen: u64,
    stop_hook_active: Option<bool>,
    activity: crate::sessions::registry_turn::TurnActivity,
    status: Option<&str>,
    question_card_posted: bool,
    mcp_attached: bool,
) -> Option<&'static str> {
    use crate::daemon::subchats::finish::has_background_work;
    use crate::daemon::subchats::runtime::runtime;
    use crate::daemon::subchats::stall::{self, Stall};
    let rt = runtime();
    let background = has_background_work(activity);
    // A finish accepted earlier this turn is dropped if background work has
    // started since: stopping the process would kill it.
    let mut finishing = rt.finish_pending(sub_id);
    if finishing && background {
        rt.take_pending_finish(sub_id);
        finishing = false;
    }
    let now = chrono::Utc::now().timestamp();
    let paused = state.registry.get(sub_id).is_some_and(|i| crate::daemon::subchats::pause::is_paused(&i, now));
    let card_waiting = crate::daemon::lifecycle::has_open_prompt(state, sub_id).await;
    let slot_wait = crate::daemon::subchats::writers::waiting_behind(state, sub_id);
    if let Some(holder) = slot_wait.as_deref() {
        log::info!("hook /hooks/stop: sub {sub_id} ended a turn queued for the writer slot behind {holder:?}, not unfinished");
        // A card raised before it queued is about a stall that is now a wait.
        stall::withdraw(state, sub_id, Stall::Unfinished).await;
    }
    let facts = SubTurnFacts {
        finishing,
        exempt: background || paused || card_waiting || slot_wait.is_some(),
        stop_hook_active: stop_hook_active == Some(true),
        question_without_card: status == Some("question") && !question_card_posted,
        mcp_attached,
        nudge_turn: rt.is_nudge_turn(sub_id, gen),
        nudge_pending: rt.nudge_armed(sub_id),
    };
    let (next, outcome) = sub_turn_end(rt.stage(sub_id), facts);
    rt.set_stage(sub_id, next);
    match outcome {
        SubTurnEnd::Allow => None,
        SubTurnEnd::Block(reason) => {
            log::info!("hook /hooks/stop: blocking sub {sub_id} - ended a turn without finish_subchat");
            Some(reason)
        }
        SubTurnEnd::Nudge => {
            log::info!("hook /hooks/stop: sub {sub_id} still unfinished after the block, nudging once the turn is over");
            rt.set_nudge_due(sub_id);
            None
        }
        SubTurnEnd::Card => {
            log::warn!("hook /hooks/stop: sub {sub_id} still unfinished after the nudge, raising a card");
            let (state, sub) = (state.clone(), sub_id.to_string());
            tokio::spawn(async move {
                stall::raise(&state, &sub, Stall::Unfinished).await;
            });
            None
        }
        SubTurnEnd::CardNoTransport => {
            log::warn!("hook /hooks/stop: sub {sub_id} ended a turn with no MCP transport, raising a card without blocking it");
            let (state, sub) = (state.clone(), sub_id.to_string());
            tokio::spawn(async move {
                stall::raise_noted(&state, &sub, Stall::Unfinished, Some(stall::NO_TRANSPORT_NOTE)).await;
            });
            None
        }
        SubTurnEnd::CardNudgeFailed => {
            log::warn!("hook /hooks/stop: sub {sub_id} still unfinished after Joe's nudge, telling him instead of asking again");
            let note = (!mcp_attached).then_some(stall::NO_TRANSPORT_NOTE);
            let (state, sub) = (state.clone(), sub_id.to_string());
            tokio::spawn(async move {
                stall::raise_nudge_failed(&state, &sub, note).await;
            });
            None
        }
    }
}

/// A `question` status is backed when a card went up this turn, or an earlier
/// turn's card is still open (a parked or durable one): either way Joe has
/// something to answer, so the turn must not be told to post a second card.
async fn question_card_is_up(state: &crate::daemon::state::DaemonState, session_id: &str, gen: u64) -> bool {
    state.registry.question_posted_this_turn(session_id, gen) || state.session_has_pending_question(session_id).await
}

/// Registry half of the Stop-time settle. Returns whether busy was cleared, so
/// the caller can mirror it to the on-disk chat state (kept out of here so
/// tests never touch the real data dir).
async fn settle_at_stop(
    state: &crate::daemon::state::DaemonState,
    session_id: &str,
    gen: u64,
    status: &str,
    activity: crate::sessions::registry_turn::TurnActivity,
) -> bool {
    let settled = activity.correct(Some(status.to_string()));
    let settled = state.settled_awaiting_for(session_id, settled).await;
    state.registry.set_awaiting_if_gen(session_id, settled, gen);
    let cleared = state.registry.set_busy_false_if_gen(session_id, gen);
    crate::daemon::machines::publish_instances_changed(state);
    cleared
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

    use crate::sessions::registry_turn::TurnActivity;
    use std::sync::Mutex;

    /// One recorded chat with a live turn open (busy, gen 1).
    fn state_with_busy_turn(sid: &str) -> (Arc<DaemonState>, u64) {
        let state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        let settings = Mutex::new(Settings::default());
        state.registry.record_interactive_session(sid, std::path::Path::new("/tmp/x"), &settings, "2026-10-26T00:00:00Z");
        state.registry.set_busy(sid, true);
        let gen = state.registry.current_turn_gen(sid);
        (state, gen)
    }

    /// The turn ending means no commit call of the session is still running.
    #[tokio::test]
    async fn a_turn_ending_frees_a_commit_lock_the_session_left_behind() {
        let ctx = announce_ctx();
        assert!(ctx.state.try_acquire_commit_lock("tree", "s1"));
        let payload = StopPayload { session_id: Some("s1".to_string()), ..Default::default() };
        let _ = on_stop(AxState(ctx.clone()), Json(payload)).await;
        assert!(ctx.state.try_acquire_commit_lock("tree", "s2"));
    }

    #[tokio::test]
    async fn stop_with_a_current_gen_report_clears_busy_and_sets_awaiting() {
        let (state, gen) = state_with_busy_turn("s");
        assert!(settle_at_stop(&state, "s", gen, "done", TurnActivity::Idle).await);
        let row = state.registry.get("s").unwrap();
        assert!(!row.busy);
        assert_eq!(row.awaiting.as_deref(), Some("done"));
    }

    /// The turn that posted a question card ends with a "done" report, but the
    /// card still waits on Joe: the row must read "question", not "done".
    #[tokio::test]
    async fn stop_with_an_open_question_card_settles_to_question_not_the_report() {
        let (state, gen) = state_with_busy_turn("s");
        state.add_prompt("q1", "question-requested", json!({"session_id": "s", "seq": 1}), true).await;
        assert!(settle_at_stop(&state, "s", gen, "done", TurnActivity::Idle).await);
        let row = state.registry.get("s").unwrap();
        assert!(!row.busy);
        assert_eq!(row.awaiting.as_deref(), Some("question"));
    }

    /// The turn that kept a `question` status after the one block (no card ever
    /// went up) must not leave the row reading input needed.
    #[tokio::test]
    async fn stop_with_a_question_report_and_no_open_card_does_not_settle_to_question() {
        let (state, gen) = state_with_busy_turn("s");
        assert!(settle_at_stop(&state, "s", gen, "question", TurnActivity::Idle).await);
        let row = state.registry.get("s").unwrap();
        assert!(!row.busy);
        assert_ne!(row.awaiting.as_deref(), Some("question"));
    }

    /// A card left open from an earlier turn backs a `question` status this turn,
    /// so the Stop hook must not tell the chat to post a duplicate.
    #[tokio::test]
    async fn an_older_open_question_card_counts_as_a_card_up_this_turn() {
        let (state, gen) = state_with_busy_turn("s");
        assert!(!question_card_is_up(&state, "s", gen).await);
        state.add_prompt("q1", "question-requested", json!({"session_id": "s", "seq": 1}), true).await;
        assert!(question_card_is_up(&state, "s", gen).await);
        assert!(!question_card_is_up(&state, "other", gen).await);
    }

    /// A confirmed close must not wait for the result line (which trailed the
    /// Stop hook by 4 minutes on 2026-11-05): the Stop hook ends the row and
    /// kills the child.
    #[cfg(windows)]
    #[tokio::test]
    async fn a_confirmed_close_tears_the_chat_down_at_stop() {
        use crate::daemon::session_test_support::spawn_fake_session;
        let (state, _gen) = state_with_busy_turn("s");
        let mut child = spawn_fake_session(&state.sessions, "s").await;
        state.registry.set_close_requested("s");

        close_now_if_confirmed(&state, "s");

        let row = state.registry.get("s").unwrap();
        assert!(row.end_reason.is_some(), "the row must end at Stop, not at the result line");
        tokio::time::timeout(std::time::Duration::from_secs(5), child.wait())
            .await
            .expect("the child must be killed")
            .unwrap();
    }

    /// No `close_session` call this turn: Stop leaves the chat alone.
    #[cfg(windows)]
    #[tokio::test]
    async fn a_stop_without_a_confirmed_close_leaves_the_chat_running() {
        use crate::daemon::session_test_support::spawn_fake_session;
        let (state, _gen) = state_with_busy_turn("s");
        let mut child = spawn_fake_session(&state.sessions, "s").await;

        close_now_if_confirmed(&state, "s");

        assert!(state.registry.get("s").unwrap().end_reason.is_none());
        assert!(child.try_wait().unwrap().is_none(), "the child must still be running");
    }

    #[tokio::test]
    async fn a_late_stop_leaves_a_newer_turns_busy_alone() {
        let (state, old_gen) = state_with_busy_turn("s");
        state.registry.set_busy("s", true); // newer turn bumps the gen
        assert!(!settle_at_stop(&state, "s", old_gen, "done", TurnActivity::Idle).await);
        let row = state.registry.get("s").unwrap();
        assert!(row.busy);
        assert_eq!(row.awaiting, None);
    }

    #[tokio::test]
    async fn stop_maps_a_done_report_through_the_live_activity() {
        for (activity, want) in [
            (TurnActivity::Working, "working"),
            (TurnActivity::WaitingOnProcess, "waiting"),
            (TurnActivity::WaitingOnSchedule, "waiting"),
        ] {
            let (state, gen) = state_with_busy_turn("s");
            settle_at_stop(&state, "s", gen, "done", activity).await;
            assert_eq!(state.registry.get("s").unwrap().awaiting.as_deref(), Some(want), "{activity:?}");
        }
    }

    // ── a sub's turn end ────────────────────────────────────────────────────

    use crate::daemon::subchats::runtime::{runtime, SubStage};
    use crate::daemon::hooks_server::stop_verdict::{QUESTION_NEEDS_CARD_REASON, SUB_NOT_FINISHED_REASON};

    fn state_with_sub(tag: &str) -> (Arc<DaemonState>, String) {
        let state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        let settings = Mutex::new(Settings::default());
        let (main, sub) = (format!("{tag}-main"), format!("{tag}-sub"));
        for id in [&main, &sub] {
            state.registry.record_interactive_session(id, std::path::Path::new("/tmp/x"), &settings, "2026-11-05T00:00:00Z");
        }
        state.registry.set_subchat_of(&sub, Some(main));
        (state, sub)
    }

    async fn stop(
        st: &Arc<DaemonState>,
        sub: &str,
        active: bool,
        activity: TurnActivity,
        status: Option<&str>,
    ) -> Option<&'static str> {
        let gen = st.registry.current_turn_gen(sub);
        sub_stop(st, sub, gen, Some(active), activity, status, false, true).await
    }

    async fn wait_for_a_card(st: &Arc<DaemonState>) -> Vec<serde_json::Value> {
        for _ in 0..200 {
            let cards = st.list_prompts().await;
            if !cards.is_empty() {
                return cards;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        Vec::new()
    }

    #[tokio::test]
    async fn a_sub_that_ends_a_turn_unfinished_is_blocked_once_then_nudged_then_carded() {
        let (st, sub) = state_with_sub("stop-seq");
        // First end: the one block, with text a sub can act on.
        assert_eq!(stop(&st, &sub, false, TurnActivity::Idle, Some("done")).await, Some(SUB_NOT_FINISHED_REASON));
        assert_eq!(runtime().stage(&sub), SubStage::Blocked);
        // The CLI re-fires Stop with stop_hook_active after a block: no second block, a nudge is due.
        assert_eq!(stop(&st, &sub, true, TurnActivity::Idle, Some("done")).await, None);
        assert_eq!(runtime().stage(&sub), SubStage::Nudged);
        assert!(runtime().take_nudge_due(&sub), "the daemon nudges once the turn is over");
        assert!(st.list_prompts().await.is_empty(), "no card yet");
        // The nudged turn also ends unfinished: now Joe gets the card.
        runtime().note_nudge_gen(&sub, st.registry.current_turn_gen(&sub));
        assert_eq!(stop(&st, &sub, false, TurnActivity::Idle, Some("done")).await, None);
        let cards = wait_for_a_card(&st).await;
        assert_eq!(cards.len(), 1, "exactly one card");
        assert_eq!(cards[0]["payload"]["card_kind"], "subchat_unfinished");
        assert_eq!(cards[0]["payload"]["display_session_id"], "stop-seq-main");
        assert!(!runtime().take_nudge_due(&sub), "the card path sends no further nudge");
    }

    fn question_of(card: &serde_json::Value) -> String {
        card["payload"]["questions"][0]["question"].as_str().unwrap_or_default().to_string()
    }

    fn labels_of(card: &serde_json::Value) -> Vec<String> {
        card["payload"]["questions"][0]["options"]
            .as_array()
            .map(|o| o.iter().filter_map(|x| x["label"].as_str().map(str::to_string)).collect())
            .unwrap_or_default()
    }

    /// 2026-11-11: Joe picked "Nudge again", the sub stopped again seconds later,
    /// and the identical card came back, round after round. His failed nudge now
    /// draws one card that says it did not help, and nothing after that.
    #[tokio::test]
    async fn a_nudge_again_that_fails_never_brings_back_the_same_card() {
        use crate::daemon::subchats::cards::{withdraw_card, NUDGE_AGAIN};
        let (st, sub) = state_with_sub("stop-joenudge");
        runtime().set_stage(&sub, SubStage::Nudged);
        runtime().note_nudge_gen(&sub, st.registry.current_turn_gen(&sub));
        stop(&st, &sub, false, TurnActivity::Idle, None).await;
        let first = wait_for_a_card(&st).await.remove(0);
        // Joe picks "Nudge again": the card goes and his nudge opens a turn.
        withdraw_card(&st, first["id"].as_str().unwrap()).await;
        runtime().set_stage(&sub, SubStage::JoeNudged);
        runtime().note_nudge_gen(&sub, st.registry.current_turn_gen(&sub));
        assert_eq!(stop(&st, &sub, false, TurnActivity::Idle, None).await, None, "not blocked: Joe already nudged it");
        let second = wait_for_a_card(&st).await.remove(0);
        assert_ne!(question_of(&second), question_of(&first), "not the same question again");
        assert!(question_of(&second).contains("did not help"), "{}", question_of(&second));
        assert!(!labels_of(&second).iter().any(|l| l == NUDGE_AGAIN), "a nudge already failed twice: {:?}", labels_of(&second));
        // A further end of that turn raises nothing more.
        withdraw_card(&st, second["id"].as_str().unwrap()).await;
        stop(&st, &sub, true, TurnActivity::Idle, None).await;
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert!(st.list_prompts().await.is_empty());
    }

    /// 2026-11-11: phone-ime-voice-swipe and display-misfit-log were queued for
    /// the writer slot, the guard told them to end their turn, and each turn end
    /// was blocked, nudged and carded. A queued sub ending its turn is waiting.
    #[tokio::test]
    async fn a_sub_queued_for_the_writer_slot_is_not_blocked_nudged_or_carded() {
        use crate::daemon::subchats::{git::test_repo, store_sub_brief, writers, TempDataDir};
        let _data = TempDataDir::new();
        let (_dir, root) = test_repo::init();
        let st = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        let mut ids = Vec::new();
        for tag in ["slot-holder", "slot-waiter"] {
            let (main, id) = (format!("{tag}-main"), format!("{tag}-sub"));
            st.registry.upsert_interactive(&main, &root, "proj", "2026-11-05T00:00:00Z");
            st.registry.upsert_interactive(&id, &root, "proj", "2026-11-05T00:00:00Z");
            st.registry.set_subchat_of(&id, Some(main.clone()));
            st.registry.set_name(&id, tag.to_string());
            store_sub_brief(&id, &main);
            let mut b = crate::sessions::chat_config::get(&id).unwrap().subchat.unwrap();
            b.writes = true;
            crate::sessions::chat_config::set_subchat(&id, Some(b));
            ids.push(id);
        }
        let (holder, waiter) = (&ids[0], &ids[1]);
        assert_eq!(writers::check_write(&st, holder), writers::WriteCheck::Allow);
        assert!(matches!(writers::check_write(&st, waiter), writers::WriteCheck::Wait { .. }), "the waiter is queued");
        // Every end of every kind of turn, nudged or not, stays quiet.
        for (active, nudge) in [(false, false), (true, false), (false, true)] {
            if nudge {
                runtime().set_stage(waiter, SubStage::Nudged);
                runtime().note_nudge_gen(waiter, st.registry.current_turn_gen(waiter));
            }
            assert_eq!(stop(&st, waiter, active, TurnActivity::Idle, Some("done")).await, None);
            assert_eq!(runtime().stage(waiter), SubStage::Fresh);
            assert!(!runtime().take_nudge_due(waiter), "never nudged");
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert!(st.list_prompts().await.is_empty(), "never carded");
        // Once the slot is its own, an unfinished end is unfinished again.
        writers::release(&st, holder);
        assert!(writers::waiting_behind(&st, waiter).is_none());
        assert_eq!(stop(&st, waiter, false, TurnActivity::Idle, Some("done")).await, Some(SUB_NOT_FINISHED_REASON));
    }

    #[tokio::test]
    async fn the_sub_block_text_leaves_out_the_per_turn_send_message_duty() {
        assert!(SUB_NOT_FINISHED_REASON.contains("finish_subchat"));
        assert!(!SUB_NOT_FINISHED_REASON.contains("send_message") && !SUB_NOT_FINISHED_REASON.contains("report_turn_status"));
    }

    #[tokio::test]
    async fn a_pending_question_background_work_and_a_freeze_do_not_block_a_sub() {
        // Background work, each of the three kinds.
        for (i, a) in [TurnActivity::Working, TurnActivity::WaitingOnProcess, TurnActivity::WaitingOnSchedule].into_iter().enumerate() {
            let (st, sub) = state_with_sub(&format!("stop-bg{i}"));
            assert_eq!(stop(&st, &sub, false, a, Some("working")).await, None, "{a:?}");
            assert_eq!(runtime().stage(&sub), SubStage::Fresh, "an exempt end does not advance the sequence");
        }
        // A pending question.
        let (st, sub) = state_with_sub("stop-q");
        st.add_prompt("q1", "question-requested", json!({"session_id": sub, "seq": 1}), true).await;
        assert_eq!(stop(&st, &sub, false, TurnActivity::Idle, Some("question")).await, None);
        // A pending permission prompt.
        let (st, sub) = state_with_sub("stop-p");
        st.add_prompt("p1", "permission-requested", json!({"session_id": sub}), false).await;
        assert_eq!(stop(&st, &sub, false, TurnActivity::Idle, None).await, None);
        // A freeze: the user's, and the auto-freeze a rate-limit rejection sets.
        let (st, sub) = state_with_sub("stop-frz");
        st.registry.set_frozen(&sub, true);
        st.registry.set_auto_frozen(&sub, true);
        assert_eq!(stop(&st, &sub, false, TurnActivity::Idle, None).await, None);
        assert_eq!(runtime().stage(&sub), SubStage::Fresh);
    }

    #[tokio::test]
    async fn exemption_after_a_block_starts_the_sequence_over() {
        let (st, sub) = state_with_sub("stop-reset");
        assert!(stop(&st, &sub, false, TurnActivity::Idle, None).await.is_some());
        assert_eq!(runtime().stage(&sub), SubStage::Blocked);
        assert_eq!(stop(&st, &sub, false, TurnActivity::Working, None).await, None);
        assert_eq!(runtime().stage(&sub), SubStage::Fresh);
        assert!(stop(&st, &sub, false, TurnActivity::Idle, None).await.is_some(), "blocked once again, not nudged");
    }

    #[tokio::test]
    async fn a_finishing_sub_ends_its_turn_unblocked_but_background_work_cancels_the_finish() {
        use crate::daemon::subchats::finish::FinishRecord;
        let (st, sub) = state_with_sub("stop-fin");
        runtime().set_pending_finish(&sub, FinishRecord { sub_id: sub.clone(), ..FinishRecord::default() });
        assert_eq!(stop(&st, &sub, false, TurnActivity::Idle, None).await, None);
        assert!(runtime().finish_pending(&sub), "left for the pump to commit");

        let (st, sub) = state_with_sub("stop-finbg");
        runtime().set_pending_finish(&sub, FinishRecord { sub_id: sub.clone(), ..FinishRecord::default() });
        assert_eq!(stop(&st, &sub, false, TurnActivity::Working, None).await, None);
        assert!(!runtime().finish_pending(&sub), "work started after the call: the finish is dropped, nothing is killed");
    }

    /// A finish dropped because background work started after the call tells the
    /// sub nothing then. It recovers when that work ends and the CLI wakes it: the
    /// woken turn is an unfinished end like any other, so it is blocked and told
    /// to call `finish_subchat`. The dropped finish must not have spent the block.
    #[tokio::test]
    async fn a_sub_whose_finish_was_dropped_for_background_work_is_blocked_when_it_wakes_unfinished() {
        use crate::daemon::subchats::finish::FinishRecord;
        let (st, sub) = state_with_sub("stop-droprecover");
        runtime().set_pending_finish(&sub, FinishRecord { sub_id: sub.clone(), ..FinishRecord::default() });
        assert_eq!(stop(&st, &sub, false, TurnActivity::Working, None).await, None, "the turn ends quietly");
        assert!(!runtime().finish_pending(&sub));
        assert_eq!(runtime().stage(&sub), SubStage::Fresh);
        // The background job ends, the CLI wakes the sub, and it stops without finishing.
        assert_eq!(stop(&st, &sub, false, TurnActivity::Idle, Some("done")).await, Some(SUB_NOT_FINISHED_REASON));
    }

    /// 015b8b4f: a `question` status with no card is blocked. For a sub that
    /// block names the card, and it is the sub's one block.
    #[tokio::test]
    async fn a_sub_reporting_question_with_no_card_gets_the_card_text_as_its_one_block() {
        let (st, sub) = state_with_sub("stop-qnocard");
        assert_eq!(stop(&st, &sub, false, TurnActivity::Idle, Some("question")).await, Some(QUESTION_NEEDS_CARD_REASON));
        assert_eq!(stop(&st, &sub, true, TurnActivity::Idle, Some("question")).await, None, "the retry is not blocked again");
    }

    #[tokio::test]
    async fn a_sub_without_a_reachable_mcp_transport_is_not_blocked_but_gets_a_card() {
        let (st, sub) = state_with_sub("stop-nomcp");
        let r = sub_stop(&st, &sub, 0, Some(false), TurnActivity::Idle, None, false, false).await;
        assert_eq!(r, None, "finish_subchat is unreachable, so demanding it is an unsatisfiable loop");
        let cards = wait_for_a_card(&st).await;
        assert_eq!(cards.len(), 1, "a silent sub with no way to speak must not sit unseen");
        assert_eq!(cards[0]["payload"]["card_kind"], "subchat_unfinished");
        assert_eq!(cards[0]["payload"]["display_session_id"], "stop-nomcp-main");
        let text = cards[0]["payload"]["questions"][0]["question"].as_str().unwrap();
        assert!(text.contains("link to the daemon's tools is down"), "{text}");
        assert!(!runtime().take_nudge_due(&sub), "a nudge asks for what it cannot do");
        // Asking again while the card is open adds nothing.
        sub_stop(&st, &sub, 0, Some(false), TurnActivity::Idle, None, false, false).await;
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert_eq!(st.list_prompts().await.len(), 1);
    }

    #[tokio::test]
    async fn a_gaming_mode_park_and_a_rate_limit_exempt_a_sub_from_the_stop_rule() {
        // A parked sub ends on a stopping note, not a finish: no freeze is set.
        let _data = crate::daemon::subchats::TempDataDir::new();
        let (st, sub) = state_with_sub("stop-park");
        crate::daemon::gaming_mode::set_file_for_test(&[&sub]);
        assert!(!st.registry.get(&sub).unwrap().frozen, "gaming mode freezes nothing");
        assert_eq!(stop(&st, &sub, false, TurnActivity::Idle, Some("done")).await, None);
        assert_eq!(runtime().stage(&sub), SubStage::Fresh, "an exempt end does not advance the sequence");
        assert!(st.list_prompts().await.is_empty());
        crate::daemon::gaming_mode::set_file_for_test(&[]);
        assert!(stop(&st, &sub, false, TurnActivity::Idle, Some("done")).await.is_some(), "blocked again once the park is over");

        // An account that is blocked until a reset still ahead, though this sub was not rejected itself.
        let (st, sub) = state_with_sub("stop-rate");
        st.registry.set_account(&sub, "acct");
        st.registry.set_rate_limited_for_account("acct", chrono::Utc::now().timestamp() + 600, "five_hour");
        assert!(!st.registry.get(&sub).unwrap().frozen);
        assert_eq!(stop(&st, &sub, false, TurnActivity::Idle, Some("done")).await, None);
        assert_eq!(runtime().stage(&sub), SubStage::Fresh);
    }

    #[test]
    fn a_normal_chat_still_owes_report_and_send_but_a_sub_does_not() {
        use crate::daemon::hooks_server::stop_verdict::BOTH_MISSING_REASON;
        let normal = report_send_verdict(false, None, false, false, Some("done"), false, true, false);
        assert_eq!(normal, TurnEndVerdict::Block(BOTH_MISSING_REASON), "unchanged for every chat that is not a sub");
        let sub = report_send_verdict(true, None, false, false, Some("done"), false, true, false);
        assert_eq!(sub, TurnEndVerdict::Ok);
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
