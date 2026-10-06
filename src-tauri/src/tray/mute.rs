//! The tray's mute menu: the pure choice/deadline decisions, plus
//! `select_mute` / `expire_timed_mute`, which apply them to the persisted
//! settings and run the timed-mute expiry.

use crate::state::AppState;
use crate::types::{now_epoch_ms, MuteChoice, TimedMute};
use tauri::{AppHandle, Manager};

/// Pure decision: the next mute choice after picking `choice` again vs a
/// different one. Picking the already-active choice unmutes.
pub(super) fn next_mute_choice(current: Option<MuteChoice>, choice: MuteChoice) -> Option<MuteChoice> {
    if current == Some(choice) { None } else { Some(choice) }
}

/// Pure decision: the `TimedMute` to persist for a given next choice. Takes
/// `now_ms` as a parameter (rather than calling `now_epoch_ms()` itself) so
/// the deadline math is testable without a real clock.
pub(super) fn timed_mute_for_choice(next: Option<MuteChoice>, now_ms: i64) -> Option<TimedMute> {
    match next {
        Some(MuteChoice::Timed(secs)) => Some(TimedMute { until_ms: now_ms + (secs as i64) * 1000, secs }),
        _ => None,
    }
}

/// Pure decision: whether a firing timer, identified by the deadline it was
/// scheduled with, still matches the live timed mute. A timer superseded by
/// a later pick (or cleared by a manual unmute) finds a different deadline
/// (or `None`) and must do nothing.
pub(super) fn timed_mute_still_current(live: Option<TimedMute>, fired_until_ms: i64) -> bool {
    live.map(|t| t.until_ms) == Some(fired_until_ms)
}

/// Picking the active choice again unmutes. A timed pick clears the persisted
/// `muteAll` flag, so the timer expiring returns to unmuted rather than to
/// "until I turn it back on".
pub(crate) fn select_mute(app: AppHandle, choice: MuteChoice) {
    use crate::settings::paths;
    use tauri::Emitter;
    let state = app.state::<AppState>();
    let (updated, deadline) = {
        let mut s = state.settings.lock().unwrap();
        let next = next_mute_choice(s.mute_choice(), choice);
        let forever = next == Some(MuteChoice::Forever);
        s.extra.insert("muteAll".into(), serde_json::Value::Bool(forever));
        s.timed_mute = timed_mute_for_choice(next, now_epoch_ms());
        s.bump_generation();
        (s.clone(), s.timed_mute.map(|t| t.until_ms))
    };
    if let Ok(path) = paths::settings_file() {
        if let Err(e) = crate::settings::save(&path, &updated) {
            log::warn!("persist mute toggle failed: {e}");
        }
    }
    let _ = app.emit("settings-changed", &updated);
    if let Some(until_ms) = deadline {
        let h = app.clone();
        tauri::async_runtime::spawn(async move {
            let wait = (until_ms - now_epoch_ms()).max(0) as u64;
            tokio::time::sleep(std::time::Duration::from_millis(wait)).await;
            expire_timed_mute(&h, until_ms);
        });
    }
}

/// `until_ms` identifies the timer, so a timer superseded by a later pick
/// (or cleared by a manual unmute) finds a different deadline and does nothing.
fn expire_timed_mute(app: &AppHandle, until_ms: i64) {
    use crate::settings::paths;
    use tauri::Emitter;
    let state = app.state::<AppState>();
    let updated = {
        let mut s = state.settings.lock().unwrap();
        if !timed_mute_still_current(s.timed_mute, until_ms) {
            return;
        }
        s.timed_mute = None;
        s.bump_generation();
        s.clone()
    };
    if let Ok(path) = paths::settings_file() {
        if let Err(e) = crate::settings::save(&path, &updated) {
            log::warn!("persist timed mute expiry failed: {e}");
        }
    }
    let _ = app.emit("settings-changed", &updated);
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOUR_SECS: u64 = 3600;

    /// Todo 1087: picking the already-active choice again must unmute.
    #[test]
    fn next_mute_choice_toggles_off_on_the_same_pick() {
        assert_eq!(next_mute_choice(Some(MuteChoice::Forever), MuteChoice::Forever), None);
        assert_eq!(
            next_mute_choice(Some(MuteChoice::Timed(HOUR_SECS)), MuteChoice::Timed(HOUR_SECS)),
            None
        );
    }

    #[test]
    fn next_mute_choice_switches_to_a_different_pick() {
        assert_eq!(
            next_mute_choice(Some(MuteChoice::Forever), MuteChoice::Timed(HOUR_SECS)),
            Some(MuteChoice::Timed(HOUR_SECS))
        );
        assert_eq!(next_mute_choice(None, MuteChoice::Forever), Some(MuteChoice::Forever));
        // Different durations are different choices, not "the same pick".
        assert_eq!(
            next_mute_choice(Some(MuteChoice::Timed(HOUR_SECS)), MuteChoice::Timed(3 * HOUR_SECS)),
            Some(MuteChoice::Timed(3 * HOUR_SECS))
        );
    }

    #[test]
    fn timed_mute_for_choice_builds_the_deadline_from_now_ms() {
        let out = timed_mute_for_choice(Some(MuteChoice::Timed(HOUR_SECS)), 1_000);
        assert_eq!(out, Some(TimedMute { until_ms: 1_000 + (HOUR_SECS as i64) * 1000, secs: HOUR_SECS }));
    }

    #[test]
    fn timed_mute_for_choice_is_none_for_forever_or_unmuted() {
        assert_eq!(timed_mute_for_choice(Some(MuteChoice::Forever), 1_000), None);
        assert_eq!(timed_mute_for_choice(None, 1_000), None);
    }

    /// Todo 1087: a timer whose deadline was superseded by a later pick must
    /// find the live `timed_mute` doesn't match and do nothing.
    #[test]
    fn timed_mute_still_current_rejects_a_stale_deadline() {
        let live = Some(TimedMute { until_ms: 5_000, secs: HOUR_SECS });
        assert!(!timed_mute_still_current(live, 4_000), "a different deadline is a superseded timer");
    }

    #[test]
    fn timed_mute_still_current_rejects_a_manual_unmute() {
        assert!(!timed_mute_still_current(None, 5_000), "cleared state means do nothing, not a match");
    }

    #[test]
    fn timed_mute_still_current_accepts_the_matching_deadline() {
        let live = Some(TimedMute { until_ms: 5_000, secs: HOUR_SECS });
        assert!(timed_mute_still_current(live, 5_000));
    }
}
