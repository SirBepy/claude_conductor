//! Rate-limit rejection handling: what happens when the CLI reports an
//! account is out of quota mid-turn. Split out of `daemon::lifecycle`
//! (ai_todo 214) because it is a self-contained concern - it only touches
//! `state.registry` (`set_rate_limited_for_account`/`clear_rate_limit_for_
//! account`), `crate::sessions::scheduled_items` (dedupe + upsert), and
//! `crate::daemon::schedule::next_stagger_slot` - with no dependency on the
//! process-spawning machinery that dominates `lifecycle.rs`.

use crate::daemon::session::Session;
use crate::daemon::state::DaemonState;
use std::sync::Arc;

/// The CLI rejected a turn because the account is out of quota. Three effects:
///
/// 1. Mark EVERY live session on that account blocked. One account's window
///    blocks all of its chats at once, even the idle ones, and the UI has to
///    say so before the user types into a chat that cannot answer.
/// 2. Queue a resume for THIS session only. It is the one whose turn died
///    mid-flight; the account's other sessions are merely unable to start, and
///    have no interrupted work to replay.
/// 3. Auto-freeze THIS session (`auto_frozen`) until the queued resume above
///    actually fires and sends - never needs a manual unfreeze.
///
/// The resume is a real persisted `ScheduledItem`, not an in-process timer, so
/// it survives an app restart and shows up in the schedule view where the user
/// can see, edit, or cancel it.
///
/// `pump_turn_gen` is the generation the pump captured for the turn being
/// rejected (todo 873, 2026-10-02 cycle 1): a rate-limit rejection ends the
/// turn, but the CLI's own trailing `result` line(s) for it reliably land as
/// `TurnAction::ReplayedResult` (refused by `pump.rs`'s gen-matched turn-end
/// gate), so busy never clears on the normal path - 157 stuck-busy watchdog
/// fires traced to exactly this. This is the only reliable place left to
/// clear it, gen-guarded the same way `pump/exit.rs`'s EOF-without-result
/// clear is: `saw_stream_turn` (`TurnBoundary::is_live()`) is NOT used as the
/// gate here, even though it sounds like the "live vs replay" signal - it is
/// false for a rejection that lands before the turn's first `stream_event`
/// (the common case: the CLI rejects before generating anything), which is
/// exactly the documented session (`dc094d2f`, 2026-10-01) this fix targets.
/// The gen match is what actually distinguishes a live rejection (current
/// turn) from a stale one (an older turn's notification arriving after a
/// newer turn already started) - the same distinction `set_busy_false_if_gen`
/// already enforces everywhere else.
pub(crate) fn handle_rate_limit_rejection(
    state: &Arc<DaemonState>,
    session: &Arc<Session>,
    body: &str,
    saw_stream_turn: bool,
    pump_turn_gen: u64,
) {
    let Ok(info) = serde_json::from_str::<serde_json::Value>(body) else {
        log::warn!("daemon: rate_limit body was not JSON: {body}");
        return;
    };
    let Some(resets_at) = info.get("resetsAt").and_then(|v| v.as_i64()) else {
        log::warn!("daemon: rate_limit body has no resetsAt: {body}");
        return;
    };
    let window = info.get("rateLimitType").and_then(|v| v.as_str()).unwrap_or("five_hour");
    let blocked = state
        .registry
        .set_rate_limited_for_account(&session.account_id, resets_at, window);
    log::info!(
        "daemon: account {} rate limited ({window}) until {resets_at}; {} session(s) blocked",
        session.account_id,
        blocked.len()
    );

    // Replay the exact prompt when the turn died before producing anything.
    // Once output has streamed, resending the prompt would redo finished work,
    // so nudge instead. Either way it must read sensibly in the schedule view.
    let prompt = if saw_stream_turn {
        "Continue from where you left off.".to_string()
    } else {
        session
            .last_prompt
            .lock()
            .ok()
            .map(|p| p.clone())
            .filter(|p| !p.trim().is_empty())
            .unwrap_or_else(|| "Continue from where you left off.".to_string())
    };

    // A second rejection for the same session (user retried, got blocked again)
    // must not leave two resumes queued for one chat.
    while let Some(existing) =
        crate::sessions::scheduled_items::find_pending_message_for_session(&session.session_id)
    {
        crate::sessions::scheduled_items::delete(&existing.id);
    }

    let fire_at =
        crate::daemon::schedule::next_stagger_slot(state, Some(&session.account_id), resets_at);
    let item = crate::sessions::scheduled_items::ScheduledItem::new(
        crate::sessions::scheduled_items::ScheduledKind::Message {
            session_id: session.session_id.clone(),
            cwd: session.cwd.to_string_lossy().to_string(),
        },
        prompt,
        fire_at.to_rfc3339(),
        None,
    );
    crate::sessions::scheduled_items::upsert(item);

    // Skip if already frozen - never stomps a manual freeze's own
    // `frozen_needs_continue` bookkeeping (the resume above replaces it).
    if !state.registry.get(&session.session_id).map(|i| i.frozen).unwrap_or(false) {
        state.registry.set_frozen(&session.session_id, true);
        state.registry.set_auto_frozen(&session.session_id, true);
    }
    // The turn is over either way (rejected, not completed) - see the doc
    // comment above for why this is gen-guarded instead of `saw_stream_turn`.
    if state.registry.set_busy_false_if_gen(&session.session_id, pump_turn_gen) {
        crate::sessions::chat_state::set_busy(&session.session_id, false);
    }
    crate::sessions::persistence::save_snapshot_default(&state.registry);

    state.notifier.publish(
        "instances_changed",
        serde_json::json!({"instances": state.registry.list()}),
    );
    state.notifier.publish(
        "scheduled_items_changed",
        serde_json::json!({"items": crate::sessions::scheduled_items::list()}),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rate_limited_sentinel_round_trips() {
        use crate::daemon::schedule::parse_rate_limited as parse;
        assert_eq!(parse("RATE_LIMITED:1800000000"), Some(1_800_000_000));
        assert_eq!(parse("sent"), None);
        assert_eq!(parse("RATE_LIMITED:not-a-number"), None);
    }

    /// Windows-only (same reason as `session_test_support`): a real
    /// `ChildStdin` is needed to build a live `Session`.
    #[cfg(windows)]
    mod busy_clear {
        use super::*;
        use crate::daemon::session::new_session_map;
        use crate::daemon::session_test_support::spawn_fake_session;
        use crate::daemon::settings_cache::SettingsCache;
        use crate::types::Settings;
        use std::sync::Mutex;

        fn rejection_body() -> String {
            serde_json::json!({
                "status": "rejected",
                "rateLimitType": "five_hour",
                "resetsAt": chrono::Utc::now().timestamp() + 120,
            })
            .to_string()
        }

        /// todo 873, 2026-10-02 cycle 1: a rate-limit rejection never produces
        /// a genuine turn-end (its result lines land as `ReplayedResult`,
        /// refused by `pump.rs`'s gen gate), so without this fix `busy`
        /// latches on until the 20-minute watchdog force-clears it.
        #[tokio::test]
        async fn live_rejection_clears_busy_when_gen_matches() {
            let _guard = crate::util::ENV_MUTATION_LOCK.lock().unwrap();
            let dir = tempfile::tempdir().unwrap();
            std::env::set_var("CC_DATA_DIR", dir.path());

            let map = new_session_map();
            let state = DaemonState::new(map.clone(), SettingsCache::new(Settings::default()));
            let sid = format!("rl-test-{}", uuid::Uuid::new_v4());
            let settings = Mutex::new(Settings::default());
            state.registry.record_interactive_session(
                &sid,
                std::path::Path::new("/tmp/x"),
                &settings,
                "2026-01-01T00:00:00Z",
            );
            state.registry.set_busy(&sid, true);
            let gen = state.registry.current_turn_gen(&sid);

            let mut child = spawn_fake_session(&map, &sid).await;
            let session = map.get(&sid).unwrap().clone();

            handle_rate_limit_rejection(&state, &session, &rejection_body(), true, gen);

            assert!(
                !state.registry.get(&sid).unwrap().busy,
                "a live rejection (gen matches the current turn) must clear busy"
            );
            assert!(
                !crate::sessions::chat_state::get(&sid).map(|c| c.busy).unwrap_or(false),
                "chat_state must mirror the registry clear"
            );

            let _ = child.kill().await;
            std::env::remove_var("CC_DATA_DIR");
        }

        /// A rejection naming a STALE gen (a newer turn already started since
        /// the pump captured it) must not clear the newer turn's busy - the
        /// same stale-notification guard `set_busy_false_if_gen` enforces for
        /// a late/replayed result line everywhere else.
        #[tokio::test]
        async fn stale_rejection_does_not_clear_a_newer_turns_busy() {
            let _guard = crate::util::ENV_MUTATION_LOCK.lock().unwrap();
            let dir = tempfile::tempdir().unwrap();
            std::env::set_var("CC_DATA_DIR", dir.path());

            let map = new_session_map();
            let state = DaemonState::new(map.clone(), SettingsCache::new(Settings::default()));
            let sid = format!("rl-test-{}", uuid::Uuid::new_v4());
            let settings = Mutex::new(Settings::default());
            state.registry.record_interactive_session(
                &sid,
                std::path::Path::new("/tmp/x"),
                &settings,
                "2026-01-01T00:00:00Z",
            );
            state.registry.set_busy(&sid, true);
            let stale_gen = state.registry.current_turn_gen(&sid);
            // A newer turn starts before the stale rejection is handled.
            state.registry.set_busy(&sid, true);

            let mut child = spawn_fake_session(&map, &sid).await;
            let session = map.get(&sid).unwrap().clone();

            handle_rate_limit_rejection(&state, &session, &rejection_body(), true, stale_gen);

            assert!(
                state.registry.get(&sid).unwrap().busy,
                "a stale/replayed rejection must not clear the newer turn's busy"
            );

            let _ = child.kill().await;
            std::env::remove_var("CC_DATA_DIR");
        }
    }
}
