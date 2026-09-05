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
    if state.registry.get(session_id).map(|i| i.busy).unwrap_or(false) {
        return Err(
            "target session is still mid-turn; the daemon has no turn queue so sending now \
             would be undefined behavior - wait until it goes idle and retry"
                .to_string(),
        );
    }
    let session = match state.sessions.get(session_id).map(|s| s.clone()) {
        Some(s) => s,
        None => respawn_for_message(state, session_id, cwd).await?,
    };
    lifecycle::send_message(&session, &tag_schedule(prompt), true).await.map_err(|e| e.to_string())?;
    state.registry.set_awaiting(session_id, None);
    state.registry.set_busy_from_wake(session_id);
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
            let model = if inst.model.is_empty() { "opus".to_string() } else { inst.model };
            let effort = if inst.effort.is_empty() { "high".to_string() } else { inst.effort };
            (model, effort, inst.account_id)
        })
        .unwrap_or_else(|| ("opus".to_string(), "high".to_string(), None));
    let params = StartSessionParams {
        cwd: PathBuf::from(cwd),
        model,
        effort,
        resume_id: Some(session_id.to_string()),
        remote: false,
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
        remote: false,
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
