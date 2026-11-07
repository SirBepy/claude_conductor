//! Per-kind fire handlers for `daemon::schedule`'s tick loop (todo 419, split
//! out of `schedule.rs`): the `fire_kind` dispatcher and one handler per
//! `ScheduledKind` variant - `fire_jarvis_hygiene`, `fire_message` (plus its
//! `respawn_for_message` helper), and `fire_new_chat`. Called from
//! `schedule::compute_fired`; owns no store I/O or tick bookkeeping itself.

use super::schedule::RATE_LIMITED_PREFIX;
use crate::daemon::jarvis_wake;
use crate::daemon::lifecycle::{self, LifecycleError, StartSessionParams};
use crate::daemon::state::DaemonState;
use crate::sessions::scheduled_items::{ScheduledItem, ScheduledKind};
use std::path::PathBuf;
use std::sync::Arc;

/// Marks a fired `/schedule` item in the transcript, same convention
/// `[repo-channel]`/`[fleet]` already use for `chat-classifiers.ts`'s buckets.
pub(crate) const SCHEDULE_PREFIX: &str = "[schedule]";

/// Idempotent: a rate-limited turn is requeued from `Session::last_prompt`,
/// which already carries the tag, so re-firing must not stack a second one.
fn tag_schedule(prompt: &str) -> String {
    if prompt.starts_with(SCHEDULE_PREFIX) {
        prompt.to_string()
    } else {
        format!("{SCHEDULE_PREFIX} {prompt}")
    }
}

/// `Ok(Some(session_id))` on success: the session id the fire sent into
/// (spawned fresh for `NewChat`, or the existing target for `Message`).
pub(crate) async fn fire_kind(state: &Arc<DaemonState>, item: &ScheduledItem) -> Result<Option<String>, String> {
    match &item.kind {
        ScheduledKind::Message { session_id, cwd } => {
            fire_message(state, session_id, cwd, &item.prompt).await?;
            Ok(Some(session_id.clone()))
        }
        ScheduledKind::NewChat { cwd, model, effort, account_id, character_id, auto_accept, .. } => {
            fire_new_chat(
                state, cwd, model, effort, account_id.as_deref(),
                character_id.as_deref(), *auto_accept, &item.prompt,
            ).await
        }
        ScheduledKind::JarvisHygiene => fire_jarvis_hygiene(state, &item.prompt).await,
    }
}

/// `ScheduledKind::JarvisHygiene` fire path: resolves the CURRENT jarvis
/// session id from `Settings.jarvis_session_id` at fire time (never a value
/// baked into the item - see the kind's doc comment), so a Jarvis respawn
/// under a new session id never orphans this recurring item. "Live" mirrors
/// `ensure_jarvis_session`'s own "ended == gone" treatment of the pointer.
///
/// Delivery reuses the jarvis wake queue (`jarvis_wake::enqueue`/`drain`)
/// instead of writing into Jarvis's stdin directly - `drain` alone decides
/// whether it's safe to send now (idle) or leaves the line queued for the
/// next trigger (busy: a worker terminal wake, or Jarvis's own turn ending
/// drains it). This is the same discipline every other write into Jarvis
/// follows; nothing here re-checks `busy` itself.
///
/// Returns `Err` (never a panic) when there's no live jarvis session to
/// target. `compute_fired` advances a recurring item to its next occurrence
/// regardless of `Ok`/`Err`, so a quiet stretch with no Jarvis spawned yet is
/// a graceful skip, not a stuck or terminally-failed item.
async fn fire_jarvis_hygiene(state: &Arc<DaemonState>, prompt: &str) -> Result<Option<String>, String> {
    let jarvis_id = state.settings.snapshot().jarvis_session_id;
    let live = jarvis_id
        .as_deref()
        .and_then(|id| state.registry.get(id))
        .map(|inst| inst.ended_at.is_none())
        .unwrap_or(false);
    let Some(jarvis_id) = jarvis_id.filter(|_| live) else {
        return Err("no live jarvis session configured; hygiene pass skipped".to_string());
    };
    jarvis_wake::enqueue(state, &jarvis_id, jarvis_wake::tag_hygiene(prompt));
    jarvis_wake::drain(state, &jarvis_id).await;
    Ok(Some(jarvis_id))
}

/// Sends `prompt` into `session_id`, respawning it first (via `resume_id`,
/// daemon-internal) if it isn't currently live. Mirrors the app-side -32004
/// retry in `ipc/chat/run.rs::send_message_daemon` (~line 126), but without
/// the RPC hop: this runs inside the daemon itself.
async fn fire_message(
    state: &Arc<DaemonState>,
    session_id: &str,
    cwd: &str,
    prompt: &str,
) -> Result<(), String> {
    // The account may still be blocked even though this item came due: a
    // seven-day window can outlast the five-hour reset we scheduled against.
    // Bail with the requeue sentinel rather than spending the turn to learn
    // that the hard way.
    if let Some(resets_at) = state
        .registry
        .get(session_id)
        .and_then(|i| i.rate_limited_resets_at)
        .filter(|ts| *ts > chrono::Utc::now().timestamp())
    {
        return Err(format!("{RATE_LIMITED_PREFIX}{resets_at}"));
    }
    // Clear an auto-freeze now that the window's clear - never a manual one
    // (`auto_frozen` only pairs with it) - or spawn_session's guard below refuses.
    if state.registry.get(session_id).map(|i| i.frozen && i.auto_frozen).unwrap_or(false) {
        state.registry.set_frozen(session_id, false);
        state.registry.set_auto_frozen(session_id, false);
    }
    // Mirror jarvis_fleet::send_to_session's guard: the daemon has no turn
    // queue, so writing into a mid-turn child's stdin is undefined behavior.
    if lifecycle::is_busy(state, session_id) {
        return Err(
            "target session is still mid-turn; the daemon has no turn queue so sending now \
             would be undefined behavior - wait until it goes idle and retry"
                .to_string(),
        );
    }
    lifecycle::refuse_if_api_credit_blocked(state, session_id).map_err(|e| e.to_string())?;
    // A sub that ended with its main chat is not respawned for a schedule, and a
    // finished one is continued through the same door a reply to it uses.
    let sub_prior = crate::daemon::subchats::before_scheduled_fire(state, session_id)?;
    let sent = async {
        // A model/effort pick made on the idle chat waits for the next send
        // (`apply_launch_change`); a fire is that send when Joe did not type
        // one first, and the picker already shows the new pair. Its respawn
        // swaps the channel, which the app re-attaches to on `channel_epoch`.
        lifecycle::refresh_stale_launch(state, session_id).await;
        let session = match state.sessions.get(session_id).map(|s| s.clone()) {
            Some(s) => s,
            None => respawn_for_message(state, session_id, cwd).await?,
        };
        lifecycle::send_message(&session, &tag_schedule(prompt), true).await.map_err(|e| e.to_string())
    }
    .await;
    if let Err(e) = sent {
        if let Some(prior) = sub_prior {
            crate::daemon::subchats::restore(state, session_id, prior);
        }
        return Err(e);
    }
    state.registry.set_awaiting(session_id, None);
    // todo 873 (2026-10-02 cycle 1): this gen-bump path logged nothing, unlike
    // `send_message`'s own "turn_gen N -> N+1" line - a scheduled retry's
    // respawn was invisible in the log when diagnosing a stuck-busy session.
    let gen_before = state.registry.current_turn_gen(session_id);
    state.registry.set_busy_from_wake(session_id);
    log::info!(
        "daemon: fire_message {session_id}: turn_gen {gen_before} -> {} (scheduled respawn/wake)",
        state.registry.current_turn_gen(session_id)
    );
    crate::sessions::chat_state::set_busy(session_id, true);
    crate::daemon::machines::publish_instances_changed(&state);
    Ok(())
}

/// Respawns a not-currently-live session with `--resume`, using the
/// registry's last-known model/effort/account (falling back to opus/high/
/// default when the registry has nothing recorded, same fallback
/// `ipc/chat/run.rs::send_message` uses for a cold cache).
async fn respawn_for_message(
    state: &Arc<DaemonState>,
    session_id: &str,
    cwd: &str,
) -> Result<Arc<crate::daemon::session::Session>, String> {
    let (model, effort, account_id) = state
        .registry
        .get(session_id)
        .map(|inst| {
            let model = if inst.model.is_empty() { lifecycle::SPAWN_DEFAULT_MODEL.to_string() } else { inst.model };
            let effort = if inst.effort.is_empty() { lifecycle::SPAWN_DEFAULT_EFFORT.to_string() } else { inst.effort };
            (model, effort, inst.account_id)
        })
        .unwrap_or_else(|| (lifecycle::SPAWN_DEFAULT_MODEL.to_string(), lifecycle::SPAWN_DEFAULT_EFFORT.to_string(), None));
    let params = StartSessionParams {
        cwd: PathBuf::from(cwd),
        model,
        effort,
        resume_id: Some(session_id.to_string()),
        account_id,
        fork: false,
        new_session_id: None,
    };
    lifecycle::spawn_session(state, params).await.map_err(err_to_string)
}

/// Spawns a brand-new chat and sends `prompt` as its first turn. Registers it
/// via the shared `session_registration::register_new_session` (todo 420) -
/// same bookkeeping the `start_session` RPC handler performs around
/// `spawn_session` - since this fires with no RPC round trip to replicate
/// that path automatically. Respects the metered-billing gate already inside
/// `spawn_session` (surfaces as `Err` -> `Failed{reason}`).
///
/// `character_id`/`auto_accept` are the new-chat modal's settings, captured
/// on `ScheduledKind::NewChat` at scheduling time (they'd otherwise be lost
/// before this fire path ever runs - the modal's own settings only reach a
/// session via two follow-up client calls, `pending-pane.ts`, that a
/// scheduled fire has no client to make). Carried onto the new session id via
/// the shared helper's own `auto_accept`/`character_id` params.
async fn fire_new_chat(
    state: &Arc<DaemonState>,
    cwd: &str,
    model: &str,
    effort: &str,
    account_id: Option<&str>,
    character_id: Option<&str>,
    auto_accept: bool,
    prompt: &str,
) -> Result<Option<String>, String> {
    let params = StartSessionParams {
        cwd: PathBuf::from(cwd),
        model: model.to_string(),
        effort: effort.to_string(),
        resume_id: None,
        account_id: account_id.map(|s| s.to_string()),
        fork: false,
        new_session_id: None,
    };
    let session = lifecycle::spawn_session(state, params).await.map_err(err_to_string)?;
    let sid = session.session_id.clone();

    let now = chrono::Utc::now().to_rfc3339();
    crate::daemon::session_registration::register_new_session(
        state, &sid, &PathBuf::from(cwd), model, effort, &session.account_id, &now,
        auto_accept, character_id, false,
    );
    crate::sessions::persistence::save_snapshot_default(&state.registry);

    lifecycle::send_message(&session, &tag_schedule(prompt), true).await.map_err(|e| e.to_string())?;
    state.registry.set_awaiting(&sid, None);
    state.registry.set_busy_from_wake(&sid);
    crate::sessions::chat_state::set_busy(&sid, true);
    crate::daemon::machines::publish_instances_changed(&state);
    Ok(Some(sid))
}

fn err_to_string(e: LifecycleError) -> String {
    e.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::types::Settings;

    fn test_state() -> Arc<DaemonState> {
        DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()))
    }

    #[tokio::test]
    async fn fire_message_unknown_session_and_missing_cwd_fails_with_reason() {
        let state = test_state();
        let result = fire_message(&state, "no-such-session", "Z:\\does\\not\\exist", "hi").await;
        assert!(result.is_err(), "respawn of a session with a missing cwd must fail, not panic");
    }

    #[tokio::test]
    async fn fire_message_refuses_a_busy_target_instead_of_writing_stdin() {
        // No live ChildStdin exists in this test, so a successful send would
        // panic - exactly why the busy guard must short-circuit before ever
        // reaching lifecycle::send_message.
        let state = test_state();
        state.registry.upsert_interactive("sess-1", std::path::Path::new("."), "proj-1", "2026-08-01T00:00:00Z");
        state.registry.set_busy("sess-1", true);

        let result = fire_message(&state, "sess-1", ".", "hi").await;

        let err = result.expect_err("a busy target must refuse, not write into its stdin");
        assert!(err.contains("mid-turn"), "{err}");
    }

    #[tokio::test]
    async fn fire_message_clears_a_rate_limit_auto_freeze_before_respawning() {
        // The respawn itself still fails in this test env, but never at
        // spawn_session's frozen guard - the auto-unfreeze below runs first.
        let state = test_state();
        state.registry.upsert_interactive("sess-1", std::path::Path::new("."), "proj-1", "2026-08-11T00:00:00Z");
        state.registry.set_frozen("sess-1", true);
        state.registry.set_auto_frozen("sess-1", true);

        let result = fire_message(&state, "sess-1", "Z:\\does\\not\\exist", "hi").await;

        let err = result.expect_err("the respawn attempt must still fail in this test env");
        assert!(!err.contains("frozen"), "auto-freeze must be cleared before the respawn attempt: {err}");
        let inst = state.registry.get("sess-1").unwrap();
        assert!(!inst.frozen, "auto-freeze must be cleared once the resume is ready to fire");
        assert!(!inst.auto_frozen);
    }

    /// `expected_exit` marks a respawn attempt (set before the kill). The
    /// respawn cannot finish here, since it would start `claude`.
    #[cfg(windows)]
    /// Returns whether a respawn was attempted, with what `fire_message` answered
    /// (for the failure message). The id is per test: the send path writes
    /// process-wide chat state keyed by it.
    #[cfg(windows)]
    async fn fire_into_live_chat(sid: &str, registry_pair: (&str, &str)) -> (bool, Result<(), String>) {
        let _data = crate::daemon::subchats::TempDataDir::new();
        let state = test_state();
        let (_child, session) = lifecycle::probe::live_session(&state, sid, ("opus", "high"), registry_pair);
        let fired = fire_message(&state, sid, "Z:\\does\\not\\exist", "hi").await;
        (session.expected_exit.load(std::sync::atomic::Ordering::SeqCst), fired)
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn fire_message_applies_a_pending_model_pick_by_respawning_the_idle_chat() {
        let (attempted, fired) = fire_into_live_chat("sched-pick-stale", ("sonnet", "low")).await;
        assert!(attempted, "the picker shows sonnet, so the fired turn must run on it: {fired:?}");
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn fire_message_leaves_a_chat_already_on_its_pick_alone() {
        let (attempted, fired) = fire_into_live_chat("sched-pick-current", ("opus", "high")).await;
        assert!(!attempted, "{fired:?}");
    }

    #[tokio::test]
    async fn fire_message_refuses_a_manually_frozen_target_without_clearing_it() {
        // frozen=true, auto_frozen=false: a manual freeze - never auto-cleared,
        // regardless of which guard actually trips the failure.
        let state = test_state();
        state.registry.upsert_interactive("sess-1", std::path::Path::new("."), "proj-1", "2026-08-11T00:00:00Z");
        state.registry.set_frozen("sess-1", true);

        let result = fire_message(&state, "sess-1", ".", "hi").await;

        assert!(result.is_err(), "a manually frozen target must not succeed");
        let inst = state.registry.get("sess-1").unwrap();
        assert!(inst.frozen, "a manual freeze must survive a fire attempt");
        assert!(!inst.auto_frozen, "auto_frozen must stay false for a manual freeze");
    }

    // --- a sub as the target ---

    fn sub_pair(state: &Arc<DaemonState>, tag: &str) -> (String, String) {
        let (main, sub) = (format!("{tag}-main"), format!("{tag}-sub"));
        for id in [&main, &sub] {
            state.registry.upsert_interactive(id, std::path::Path::new("."), "proj-1", "2026-11-05T00:00:00Z");
        }
        state.registry.set_subchat_of(&sub, Some(main.clone()));
        (main, sub)
    }

    /// A sub ended with its parent has no row anyone can see or close. Respawning
    /// it for a schedule (a `this_chat` item of its own, a rate-limit resume) would
    /// start a billed child for it.
    #[tokio::test]
    async fn a_scheduled_message_does_not_revive_a_sub_that_ended_with_its_parent() {
        let state = test_state();
        let (_main, sub) = sub_pair(&state, "sched-ended");
        state.registry.mark_ended(&sub, crate::types::EndReason::Manual, "2026-11-05T00:00:01Z");

        let err = fire_message(&state, &sub, "Z:\\does\\not\\exist", "hi").await.expect_err("must refuse");

        assert!(err.contains("ended with its main chat"), "refused for the right reason, not by chance: {err}");
        assert!(state.sessions.is_empty(), "no child was started");
        assert!(state.registry.get(&sub).unwrap().ended_at.is_some(), "still ended");
    }

    #[tokio::test]
    async fn a_scheduled_message_does_not_revive_a_sub_whose_row_left_the_snapshot_either() {
        let _data = crate::daemon::subchats::TempDataDir::new();
        let state = test_state();
        // After a restart only the brief says it was a sub.
        crate::daemon::subchats::store_sub_brief("sched-gone-sub", "sched-gone-main");

        let err = fire_message(&state, "sched-gone-sub", "Z:\\does\\not\\exist", "hi").await.expect_err("must refuse");

        assert!(err.contains("ended with its main chat"), "{err}");
    }

    /// A finished sub resumes through the same door a reply uses, so the finished
    /// flag is cleared for the turn; a failed send puts it back.
    #[tokio::test]
    async fn a_scheduled_message_continues_a_finished_sub_and_a_failed_send_leaves_it_finished() {
        let state = test_state();
        let (_main, sub) = sub_pair(&state, "sched-finished");
        state.registry.set_subchat_finished(&sub, true);

        let err = fire_message(&state, &sub, "Z:\\does\\not\\exist", "hi").await.expect_err("the respawn fails in this env");

        assert!(!err.contains("ended with its main chat"), "it was not refused as ended: {err}");
        let row = state.registry.get(&sub).unwrap();
        assert!(row.subchat_finished, "a failed continue leaves the sub as it was found");
        assert!(row.ended_at.is_none());
    }

    #[test]
    fn before_scheduled_fire_clears_the_finished_flag_for_a_sub_that_can_continue() {
        let state = test_state();
        let (_main, sub) = sub_pair(&state, "sched-prep");
        state.registry.set_subchat_finished(&sub, true);
        let prior = crate::daemon::subchats::before_scheduled_fire(&state, &sub).unwrap();
        assert!(prior.is_some(), "a finished sub is continued");
        assert!(!state.registry.get(&sub).unwrap().subchat_finished);
        // A sub still running and an ordinary chat are untouched.
        let (_m2, running) = sub_pair(&state, "sched-run");
        assert!(crate::daemon::subchats::before_scheduled_fire(&state, &running).unwrap().is_none());
        assert!(crate::daemon::subchats::before_scheduled_fire(&state, "sched-run-main").unwrap().is_none());
        assert!(crate::daemon::subchats::before_scheduled_fire(&state, "nobody").unwrap().is_none());
    }

    // --- ScheduledKind::JarvisHygiene fire path ---

    #[tokio::test]
    async fn fire_jarvis_hygiene_skips_gracefully_when_no_jarvis_session_configured() {
        let state = test_state(); // Settings::default() -> jarvis_session_id is None
        let result = fire_jarvis_hygiene(&state, "hi").await;
        assert!(result.is_err(), "no jarvis session configured must be a graceful skip, not a panic");
    }

    #[tokio::test]
    async fn fire_jarvis_hygiene_skips_gracefully_when_pointer_is_a_stale_ended_session() {
        let state = test_state();
        state.registry.upsert_interactive("jv-1", std::path::Path::new("."), "proj-1", "2026-07-27T00:00:00Z");
        state.registry.mark_ended("jv-1", crate::types::EndReason::Manual, "2026-07-27T00:00:01Z");
        state.settings.set_jarvis_session_id("jv-1");

        let result = fire_jarvis_hygiene(&state, "hi").await;

        assert!(result.is_err(), "an ended jarvis pointer is treated the same as no pointer at all");
    }

    #[tokio::test]
    async fn fire_jarvis_hygiene_routes_through_the_wake_queue_when_jarvis_is_busy() {
        // No live ChildStdin exists in this test, so a successful direct send
        // would panic - which is exactly why this must go through `enqueue`
        // + `drain` (whose own busy guard short-circuits) rather than writing
        // into Jarvis's stdin itself.
        let state = test_state();
        state.registry.upsert_interactive("jv-1", std::path::Path::new("."), "proj-1", "2026-07-27T00:00:00Z");
        state.registry.set_busy("jv-1", true);
        state.settings.set_jarvis_session_id("jv-1");

        let result = fire_jarvis_hygiene(&state, "hi").await;

        assert_eq!(result, Ok(Some("jv-1".to_string())));
        let queues = state.jarvis_wakes.lock().unwrap();
        let pending = queues.get("jv-1").expect("hygiene prompt queued for the busy jarvis");
        assert_eq!(pending.iter().cloned().collect::<Vec<_>>(), vec!["[hygiene] hi".to_string()]);
    }

    #[test]
    fn tag_schedule_marks_a_fire_once_even_across_a_rate_limited_replay() {
        assert_eq!(tag_schedule("run the report"), "[schedule] run the report");
        assert_eq!(tag_schedule("[schedule] run the report"), "[schedule] run the report");
    }
}
