//! The tray's mute menu: the pure choice/deadline decisions, plus
//! `select_mute` / `expire_timed_mute`, which apply them to the persisted
//! settings and run the timed-mute expiry.

use crate::state::AppState;
use crate::types::{now_epoch_ms, MuteChoice, Settings, TimedMute};
use std::path::Path;
use std::sync::Mutex;
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
    let Ok(path) = paths::settings_file() else { return };
    let (updated, deadline) = match apply_mute(&state.settings, &path, choice, now_epoch_ms()) {
        Ok(done) => done,
        Err(e) => {
            log::warn!("persist mute toggle failed: {e}");
            return;
        }
    };
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
    let Ok(path) = paths::settings_file() else { return };
    match apply_expiry(&state.settings, &path, until_ms) {
        Ok(Some(updated)) => {
            let _ = app.emit("settings-changed", &updated);
        }
        Ok(None) => {}
        Err(e) => log::warn!("persist timed mute expiry failed: {e}"),
    }
}

/// The mute pick applied and saved under the live settings' own lock
/// (`mutate_and_save`): a peer's settings merged in between a separate read and
/// write would otherwise be written over by this older copy, and the next save would
/// send that revert back to the peer.
fn apply_mute(settings: &Mutex<Settings>, path: &Path, choice: MuteChoice, now_ms: i64) -> Result<(Settings, Option<i64>), String> {
    let saved = crate::settings::mutate_and_save(settings, path, |s| {
        let next = next_mute_choice(s.mute_choice(), choice);
        let forever = next == Some(MuteChoice::Forever);
        s.extra.insert("muteAll".into(), serde_json::Value::Bool(forever));
        s.timed_mute = timed_mute_for_choice(next, now_ms);
        Ok(())
    })?;
    let deadline = saved.timed_mute.map(|t| t.until_ms);
    Ok((saved, deadline))
}

/// [`apply_mute`] for the timer: `Ok(None)` when the deadline is no longer the live one.
fn apply_expiry(settings: &Mutex<Settings>, path: &Path, until_ms: i64) -> Result<Option<Settings>, String> {
    match crate::settings::mutate_and_save(settings, path, |s| {
        if !timed_mute_still_current(s.timed_mute, until_ms) {
            return Err(STALE_TIMER.to_string());
        }
        s.timed_mute = None;
        Ok(())
    }) {
        Ok(saved) => Ok(Some(saved)),
        Err(e) if e == STALE_TIMER => Ok(None),
        Err(e) => Err(e),
    }
}

/// `mutate_and_save`'s way to say "nothing to change, save nothing".
const STALE_TIMER: &str = "the timer was superseded";

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

    fn seeded() -> (tempfile::TempDir, std::path::PathBuf, Mutex<Settings>) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        crate::settings::save(&path, &Settings::default()).unwrap();
        let live = Mutex::new(crate::settings::load(&path));
        (dir, path, live)
    }

    #[test]
    fn a_timed_pick_is_saved_and_its_expiry_clears_it_unless_superseded() {
        let (_dir, path, live) = seeded();
        let (saved, deadline) = apply_mute(&live, &path, MuteChoice::Timed(HOUR_SECS), 1_000).unwrap();
        assert_eq!(deadline, Some(1_000 + 3_600_000));
        assert_eq!(saved.timed_mute.map(|t| t.until_ms), deadline);

        let before = live.lock().unwrap().settings_generation;
        assert!(apply_expiry(&live, &path, 5).unwrap().is_none(), "a superseded timer changes nothing");
        assert_eq!(live.lock().unwrap().settings_generation, before, "and saves nothing");
        let cleared = apply_expiry(&live, &path, deadline.unwrap()).unwrap().unwrap();
        assert!(cleared.timed_mute.is_none());
        assert!(live.lock().unwrap().timed_mute.is_none());
    }

    /// A peer's settings merged between this save's read and write used to be written
    /// over by this older copy (the lock was dropped first), and the next save sent
    /// that revert to the peer as a local edit. Held across the save, the merge and the
    /// mute toggles serialise: the file always equals the live copy and the peer's key
    /// keeps the peer's stamp.
    #[test]
    fn a_mute_toggle_racing_a_peers_merge_never_reverts_it() {
        use crate::settings::sync::{Change, Stamp};
        let (_dir, path, live) = seeded();
        let live = std::sync::Arc::new(live);
        let toggles = {
            let (live, path) = (live.clone(), path.clone());
            std::thread::spawn(move || {
                for _ in 0..400 {
                    apply_mute(&live, &path, MuteChoice::Forever, 0).unwrap();
                }
            })
        };
        let now = chrono::Utc::now();
        for n in 1..=400u32 {
            let stamp = Stamp { at: (now - chrono::Duration::hours(1) + chrono::Duration::seconds(n as i64)).to_rfc3339(), by: "mac".into() };
            let change = Change { key: "paceBand".into(), value: serde_json::json!(n), stamp };
            crate::settings::sync_store::apply_to_live(&live, &path, &[change], now).unwrap();
        }
        toggles.join().unwrap();
        let on_disk = crate::settings::load(&path);
        assert_eq!(on_disk.extra["paceBand"], serde_json::json!(400));
        assert_eq!(on_disk.extra, live.lock().unwrap().extra, "the file must not trail the live copy");
        let clocks = crate::settings::sync_store::load_clocks(&crate::settings::sync_store::clocks_path(&path));
        assert_eq!(clocks["paceBand"].by, "mac", "a revert would have been stamped as a local edit");
    }
}
