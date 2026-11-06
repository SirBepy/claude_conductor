//! Manual postpone of an armed when-done run: the action stays armed but will
//! not fire (and an under-way countdown drops back to Watching) until the
//! snooze ends. The engine reads `WhenDoneInner::snooze_until`; this module
//! only writes it.

use super::protocol::{ProtocolPhase, ProtocolState, WhenDoneInner};
use crate::state::AppState;
use std::time::{Duration, Instant};

/// Longest postpone one call may ask for; a bigger number is a bug in the
/// caller, and a day is already past any "just not now" intent.
const MAX_SNOOZE_MINS: u32 = 24 * 60;

/// Whether `phase` is one a postpone means anything for. `Firing` is too late
/// (the terminal action is already running); `Disarmed`/`GaveUp` have nothing
/// to postpone.
fn can_snooze(phase: ProtocolPhase) -> bool {
    matches!(phase, ProtocolPhase::Watching | ProtocolPhase::CountingDown)
}

/// Postpone `inner` by `minutes` from `now`. Returns whether it applied.
/// `now_unix_ms` is only the display copy of the end time.
fn apply_snooze(inner: &mut WhenDoneInner, now: Instant, now_unix_ms: i64, minutes: u32) -> bool {
    if !can_snooze(inner.state.phase) {
        return false;
    }
    let mins = minutes.clamp(1, MAX_SNOOZE_MINS);
    inner.snooze_until = Some(now + Duration::from_secs(u64::from(mins) * 60));
    inner.state.snoozed_until_unix_ms = Some(now_unix_ms + i64::from(mins) * 60_000);
    true
}

/// Postpone the run held in `AppState` by `minutes` and return the new state. A
/// no-op (returns the current state) when nothing is armed or it is firing.
/// A tauri command must live in `when_done/mod.rs` (the macro's hidden items are
/// not re-exported from a submodule), so `snooze_when_done` there calls this.
pub(super) fn snooze_in_state(state: &AppState, minutes: u32) -> ProtocolState {
    let now_unix_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64);
    let mut inner = state.when_done.lock().unwrap();
    apply_snooze(&mut inner, Instant::now(), now_unix_ms, minutes);
    inner.state.clone()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::when_done::TerminalAction;

    fn armed(phase: ProtocolPhase) -> WhenDoneInner {
        let mut inner = WhenDoneInner::default();
        inner.state = ProtocolState { phase, ..ProtocolState::watching(TerminalAction::Shutdown) };
        inner
    }

    #[test]
    fn snoozes_a_watching_run_and_records_both_ends() {
        let mut inner = armed(ProtocolPhase::Watching);
        let now = Instant::now();
        assert!(apply_snooze(&mut inner, now, 1_000_000, 30));
        assert_eq!(inner.snooze_until, Some(now + Duration::from_secs(30 * 60)));
        assert_eq!(inner.state.snoozed_until_unix_ms, Some(1_000_000 + 30 * 60_000));
    }

    #[test]
    fn snoozes_a_counting_down_run() {
        let mut inner = armed(ProtocolPhase::CountingDown);
        assert!(apply_snooze(&mut inner, Instant::now(), 0, 60));
    }

    #[test]
    fn refuses_when_nothing_is_armed_or_it_is_already_firing() {
        for phase in [ProtocolPhase::Disarmed, ProtocolPhase::GaveUp, ProtocolPhase::Firing] {
            let mut inner = armed(phase);
            assert!(!apply_snooze(&mut inner, Instant::now(), 0, 30), "{phase:?}");
            assert_eq!(inner.snooze_until, None);
            assert_eq!(inner.state.snoozed_until_unix_ms, None);
        }
    }

    #[test]
    fn clamps_the_length_to_one_minute_through_a_day() {
        let mut inner = armed(ProtocolPhase::Watching);
        let now = Instant::now();
        apply_snooze(&mut inner, now, 0, 0);
        assert_eq!(inner.snooze_until, Some(now + Duration::from_secs(60)));
        apply_snooze(&mut inner, now, 0, u32::MAX);
        assert_eq!(inner.snooze_until, Some(now + Duration::from_secs(24 * 3600)));
    }

    #[test]
    fn a_second_snooze_replaces_the_first() {
        let mut inner = armed(ProtocolPhase::Watching);
        let now = Instant::now();
        apply_snooze(&mut inner, now, 0, 180);
        apply_snooze(&mut inner, now, 0, 30);
        assert_eq!(inner.snooze_until, Some(now + Duration::from_secs(30 * 60)));
    }
}
