//! Daemon-wide backstop sweep for todo 525 ("sidebar stuck in progress").
//! `methods/lifecycle.rs` and `pump.rs` close the two KNOWN ways `busy` can
//! latch on; this catches whatever's still unknown, on wall-clock silence
//! rather than turn duration.

use crate::daemon::state::DaemonState;
use std::sync::Arc;
use std::time::Duration;

const SWEEP_INTERVAL: Duration = Duration::from_secs(60);
/// How long `busy` may sit with zero events before the sweep force-clears it.
/// Generous on purpose: the only stamps are stdout lines and the turn-end
/// status hook, so ONE long tool call (a 15-minute build) is total silence.
/// Clearing under a live turn flushes held messages into it, bumping
/// `turn_gen` mid-turn - which re-creates the very latch todo 525 fixed.
const STALE_THRESHOLD: chrono::Duration = chrono::Duration::minutes(20);
/// Longer, and measuring something weaker: `last_event_at` is only stamped
/// mid-turn, so on an idle session this is time-since-turn-end, not silence.
/// A detached background task is invisible here, so the bound has to clear
/// the worst legitimate one - a ~20 minute Rust build - with margin.
const WORKING_STALE_THRESHOLD: chrono::Duration = chrono::Duration::minutes(45);
/// Two ticks this far apart (the interval is 60s) mean the whole process was
/// suspended - machine sleep freezes the daemon and every claude child alike -
/// not that the sweep ran late.
const SUSPEND_GAP: chrono::Duration = chrono::Duration::minutes(3);

pub fn spawn(state: Arc<DaemonState>) {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(SWEEP_INTERVAL);
        let mut clock = SweepClock::default();
        loop {
            ticker.tick().await;
            sweep(&state, &mut clock, chrono::Utc::now());
        }
    });
}

/// Wall-clock silence is only evidence while the process is awake. After a
/// sleep, every turn that was mid-flight looks hours silent on the first tick
/// although its child was frozen with it (2026-10-09: three live turns
/// force-cleared at wake after a 6h sleep, each ending normally within 95s).
/// Silence is therefore counted from the last resume when that is later.
#[derive(Default)]
struct SweepClock {
    last_tick: Option<chrono::DateTime<chrono::Utc>>,
    resumed_at: Option<chrono::DateTime<chrono::Utc>>,
}

impl SweepClock {
    fn tick(&mut self, now: chrono::DateTime<chrono::Utc>) {
        if let Some(last) = self.last_tick {
            let gap = now.signed_duration_since(last);
            if gap > SUSPEND_GAP {
                log::info!(
                    "busy_watchdog: {}m since the last sweep, treating it as a suspend and restarting every silence window",
                    gap.num_minutes()
                );
                self.resumed_at = Some(now);
            }
        }
        self.last_tick = Some(now);
    }
}

/// `now` is injected (rather than read internally) so tests can simulate
/// elapsed wall-clock time without needing to poke a fake past timestamp
/// into the registry directly.
fn sweep(state: &Arc<DaemonState>, clock: &mut SweepClock, now: chrono::DateTime<chrono::Utc>) {
    clock.tick(now);
    let resumed_at = clock.resumed_at;
    let live: Vec<crate::types::Instance> =
        state.registry.list().into_iter().filter(|i| i.ended_at.is_none()).collect();
    let stale_working: Vec<String> = live
        .iter()
        .filter(|i| !i.busy)
        .filter(|i| i.awaiting.as_deref() == Some("working") || i.local_task_running)
        .filter(|i| is_stale(i.last_event_at.as_deref(), resumed_at, now, WORKING_STALE_THRESHOLD))
        .map(|i| i.session_id.clone())
        .collect();
    let stale: Vec<String> = live
        .into_iter()
        .filter(|i| i.busy)
        .filter(|i| is_stale(i.last_event_at.as_deref(), resumed_at, now, STALE_THRESHOLD))
        .map(|i| i.session_id)
        .collect();
    if stale.is_empty() && stale_working.is_empty() {
        return;
    }
    for session_id in &stale_working {
        log::warn!(
            "busy_watchdog: clearing stale \"working\" for session {session_id} - turn ended over \
             {}m ago and nothing restarted it (todo 888: nothing else revisits `awaiting`)",
            WORKING_STALE_THRESHOLD.num_minutes()
        );
        // Unknown, not Idle: the verdict expired, it was never contradicted.
        // Also resets `local_task_running`, which when_done reads alongside
        // `awaiting` - clearing only one leaves the session blocking shutdown.
        state.registry.set_turn_activity(session_id, crate::sessions::registry_turn::TurnActivity::Unknown);
        state.registry.set_awaiting(session_id, None);
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
    crate::daemon::machines::publish_instances_changed(&state);
}

/// True if `last_event_at` is unset (untrustworthy - e.g. a session
/// restored from a pre-todo-525 snapshot) or older than `threshold`, counting
/// from `resumed_at` instead when the process woke from a suspend after it.
fn is_stale(
    last_event_at: Option<&str>,
    resumed_at: Option<chrono::DateTime<chrono::Utc>>,
    now: chrono::DateTime<chrono::Utc>,
    threshold: chrono::Duration,
) -> bool {
    match last_event_at.and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok()) {
        Some(last) => {
            let last = last.with_timezone(&chrono::Utc);
            let since = resumed_at.map_or(last, |r| r.max(last));
            now.signed_duration_since(since) > threshold
        }
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
        sweep(&state, &mut SweepClock::default(), later);
        assert!(!state.registry.get("s").unwrap().busy, "watchdog must clear busy after silence");
    }

    /// todo 888: `awaiting` is written once at turn end and nothing revisits
    /// it, so an upgraded-to-`working` verdict outlives the work it described.
    #[test]
    fn clears_a_stale_working_verdict_on_an_idle_session() {
        let state = test_state();
        let settings = std::sync::Mutex::new(Settings::default());
        state.registry.record_interactive_session("s", Path::new("/tmp/x"), &settings, "2026-08-01T00:00:00Z");
        state.registry.set_busy("s", true);
        state.registry.set_busy("s", false); // turn ended, stamps last_event_at
        state.registry.set_turn_activity("s", crate::sessions::registry_turn::TurnActivity::Working);
        state.registry.set_awaiting("s", Some("working".into()));
        let later = chrono::Utc::now() + chrono::Duration::minutes(50);
        sweep(&state, &mut SweepClock::default(), later);
        let i = state.registry.get("s").unwrap();
        assert_eq!(i.awaiting, None, "a stale working must not keep the row in progress");
        assert!(!i.local_task_running, "when_done reads this too - clearing one is not enough");
    }

    #[test]
    fn leaves_a_fresh_working_verdict_alone() {
        let state = test_state();
        let settings = std::sync::Mutex::new(Settings::default());
        state.registry.record_interactive_session("s", Path::new("/tmp/x"), &settings, "2026-08-01T00:00:00Z");
        state.registry.set_busy("s", true);
        state.registry.set_busy("s", false);
        state.registry.set_turn_activity("s", crate::sessions::registry_turn::TurnActivity::Working);
        state.registry.set_awaiting("s", Some("working".into()));
        // Past the busy branch's own 20m bound on purpose: a background build
        // routinely outlives that, and sweeping it would let the machine sleep.
        let later = chrono::Utc::now() + chrono::Duration::minutes(30);
        sweep(&state, &mut SweepClock::default(), later);
        let i = state.registry.get("s").unwrap();
        assert_eq!(i.awaiting.as_deref(), Some("working"), "a live subagent run must keep holding the machine awake");
        assert!(i.local_task_running);
    }

    /// The other terminal statuses describe state no elapsed time disproves.
    #[test]
    fn a_stale_question_is_never_swept() {
        let state = test_state();
        let settings = std::sync::Mutex::new(Settings::default());
        state.registry.record_interactive_session("s", Path::new("/tmp/x"), &settings, "2026-08-01T00:00:00Z");
        state.registry.set_busy("s", true);
        state.registry.set_busy("s", false);
        state.registry.set_awaiting("s", Some("question".into()));
        let later = chrono::Utc::now() + chrono::Duration::minutes(25);
        sweep(&state, &mut SweepClock::default(), later);
        assert_eq!(state.registry.get("s").unwrap().awaiting.as_deref(), Some("question"));
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
        sweep(&state, &mut SweepClock::default(), later);
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
        sweep(&state, &mut SweepClock::default(), later);
        // Ended sessions are excluded from the sweep filter entirely; busy is
        // stale leftover state on a dead row, not this backstop's concern.
        assert!(state.registry.get("s").unwrap().busy);
    }

    #[test]
    fn is_stale_treats_missing_timestamp_as_stale() {
        assert!(is_stale(None, None, chrono::Utc::now(), STALE_THRESHOLD));
    }

    #[test]
    fn is_stale_treats_fresh_timestamp_as_not_stale() {
        assert!(!is_stale(Some(&chrono::Utc::now().to_rfc3339()), None, chrono::Utc::now(), STALE_THRESHOLD));
    }

    /// 2026-10-09: a 6h machine sleep, then the first tick after wake saw
    /// three live turns as hours silent and force-cleared them; each ended
    /// normally within 95s. A suspend-sized gap between ticks restarts the
    /// silence window instead of counting the sleep as silence.
    #[test]
    fn a_suspend_gap_between_ticks_does_not_count_as_silence() {
        let state = test_state();
        let settings = std::sync::Mutex::new(Settings::default());
        state.registry.record_interactive_session("s", Path::new("/tmp/x"), &settings, "2026-08-01T00:00:00Z");
        state.registry.record_interactive_session("w", Path::new("/tmp/y"), &settings, "2026-08-01T00:00:00Z");
        state.registry.set_busy("s", true);
        state.registry.set_busy("w", true);
        state.registry.set_busy("w", false);
        state.registry.set_turn_activity("w", crate::sessions::registry_turn::TurnActivity::Working);
        state.registry.set_awaiting("w", Some("working".into()));
        let mut clock = SweepClock::default();
        let t0 = chrono::Utc::now();
        sweep(&state, &mut clock, t0);
        let woke = t0 + chrono::Duration::hours(6);
        sweep(&state, &mut clock, woke);
        sweep(&state, &mut clock, woke + chrono::Duration::seconds(1));
        assert!(state.registry.get("s").unwrap().busy, "a turn frozen by sleep is not stuck");
        assert_eq!(state.registry.get("w").unwrap().awaiting.as_deref(), Some("working"));
    }

    /// The window restarts at wake, it is not suppressed: a turn that stays
    /// silent a full threshold after waking is still cleared.
    #[test]
    fn a_turn_still_silent_a_threshold_after_wake_is_cleared() {
        let state = test_state();
        let settings = std::sync::Mutex::new(Settings::default());
        state.registry.record_interactive_session("s", Path::new("/tmp/x"), &settings, "2026-08-01T00:00:00Z");
        state.registry.set_busy("s", true);
        let mut clock = SweepClock::default();
        let t0 = chrono::Utc::now();
        sweep(&state, &mut clock, t0);
        let woke = t0 + chrono::Duration::hours(6);
        sweep(&state, &mut clock, woke);
        let mut t = woke;
        while t < woke + chrono::Duration::minutes(21) {
            t += chrono::Duration::minutes(1);
            sweep(&state, &mut clock, t);
        }
        assert!(!state.registry.get("s").unwrap().busy);
    }
}
