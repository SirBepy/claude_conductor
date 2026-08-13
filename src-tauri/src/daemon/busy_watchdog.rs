//! Daemon-wide backstop sweep for todo 525 ("sidebar stuck in progress").
//! `methods/lifecycle.rs` and `pump.rs` close the two KNOWN ways `busy` can
//! latch on; this catches whatever's still unknown, on wall-clock silence
//! rather than turn duration.

use crate::daemon::state::DaemonState;
use std::sync::Arc;
use std::time::Duration;

const SWEEP_INTERVAL: Duration = Duration::from_secs(60);
/// How long `busy` may sit with zero events before the sweep force-clears
/// it. Generous: Joe routinely runs 40+ minute builds with a steady tool
/// trickle well under this, and killing a live turn is worse than a stuck
/// row sitting an extra 20 minutes.
const STALE_THRESHOLD: chrono::Duration = chrono::Duration::minutes(20);

pub fn spawn(state: Arc<DaemonState>) {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(SWEEP_INTERVAL);
        loop {
            ticker.tick().await;
            sweep(&state, chrono::Utc::now());
        }
    });
}

/// `now` is injected (rather than read internally) so tests can simulate
/// elapsed wall-clock time without needing to poke a fake past timestamp
/// into the registry directly.
fn sweep(state: &Arc<DaemonState>, now: chrono::DateTime<chrono::Utc>) {
    let stale: Vec<String> = state
        .registry
        .list()
        .into_iter()
        .filter(|i| i.busy && i.ended_at.is_none())
        .filter(|i| is_stale(i.last_event_at.as_deref(), now))
        .map(|i| i.session_id)
        .collect();
    if stale.is_empty() {
        return;
    }
    for session_id in &stale {
        log::warn!(
            "busy_watchdog: force-clearing stuck busy for session {session_id} - no activity \
             for over {}m (todo 525 backstop; bypasses the gen guard on purpose)",
            STALE_THRESHOLD.num_minutes()
        );
        // Unconditional, not set_busy_false_if_gen: that's the guarded path
        // this backstop exists to cover for, and after this much silence any
        // legitimately in-flight turn would have produced something.
        state.registry.set_busy(session_id, false);
        crate::sessions::chat_state::set_busy(session_id, false);
    }
    state.notifier.publish("instances_changed", serde_json::json!({"instances": state.registry.list()}));
}

/// True if `last_event_at` is unset (untrustworthy - e.g. a session
/// restored from a pre-todo-525 snapshot) or older than [`STALE_THRESHOLD`].
fn is_stale(last_event_at: Option<&str>, now: chrono::DateTime<chrono::Utc>) -> bool {
    match last_event_at.and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok()) {
        Some(last) => now.signed_duration_since(last) > STALE_THRESHOLD,
        None => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::types::Settings;
    use std::path::Path;

    fn test_state() -> Arc<DaemonState> {
        DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()))
    }

    #[test]
    fn fires_after_silence_past_threshold() {
        let state = test_state();
        let settings = std::sync::Mutex::new(Settings::default());
        state.registry.record_interactive_session("s", Path::new("/tmp/x"), &settings, "2026-08-01T00:00:00Z");
        state.registry.set_busy("s", true); // stamps last_event_at = now
        let later = chrono::Utc::now() + chrono::Duration::minutes(25);
        sweep(&state, later);
        assert!(!state.registry.get("s").unwrap().busy, "watchdog must clear busy after silence");
    }

    #[test]
    fn does_not_fire_while_events_keep_arriving() {
        let state = test_state();
        let settings = std::sync::Mutex::new(Settings::default());
        state.registry.record_interactive_session("s", Path::new("/tmp/x"), &settings, "2026-08-01T00:00:00Z");
        state.registry.set_busy("s", true);
        state.registry.touch_activity("s"); // a tool event refreshes activity
        // Sweep runs only 5 minutes after the (real-time) refresh - well
        // under threshold, unlike the 25-minute gap in the fires-after test.
        let later = chrono::Utc::now() + chrono::Duration::minutes(5);
        sweep(&state, later);
        assert!(state.registry.get("s").unwrap().busy, "a steady trickle of events must never be swept");
    }

    #[test]
    fn ended_session_is_never_touched() {
        let state = test_state();
        let settings = std::sync::Mutex::new(Settings::default());
        state.registry.record_interactive_session("s", Path::new("/tmp/x"), &settings, "2026-08-01T00:00:00Z");
        state.registry.set_busy("s", true);
        state.registry.mark_ended("s", crate::types::EndReason::Manual, "2026-08-01T01:00:00Z");
        let later = chrono::Utc::now() + chrono::Duration::minutes(25);
        sweep(&state, later);
        // Ended sessions are excluded from the sweep filter entirely; busy is
        // stale leftover state on a dead row, not this backstop's concern.
        assert!(state.registry.get("s").unwrap().busy);
    }

    #[test]
    fn is_stale_treats_missing_timestamp_as_stale() {
        assert!(is_stale(None, chrono::Utc::now()));
    }

    #[test]
    fn is_stale_treats_fresh_timestamp_as_not_stale() {
        assert!(!is_stale(Some(&chrono::Utc::now().to_rfc3339()), chrono::Utc::now()));
    }
}
