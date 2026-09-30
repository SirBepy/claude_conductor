//! Nightly auto-arm: once a night, at the user's chosen local time, arm the
//! protocol in `ArmMode::Nightly`. Config lives in the settings extra bag under
//! `nightlyWhenDone` (`{ enabled, action, time: "HH:MM" }`), written by the
//! Settings > System view; read fresh every tick so a save applies at once.

use super::{arm, ArmMode, ProtocolPhase, TerminalAction};
use crate::state::AppState;
use chrono::{Local, NaiveDate, NaiveDateTime, NaiveTime};
use serde::Deserialize;
use std::time::Duration;
use tauri::{AppHandle, Manager};

const TICK: Duration = Duration::from_secs(30);
/// How late past the set time an arm still happens, for a PC that was asleep or
/// an app that was closed at that exact minute. Past this it waits for the next
/// night, so booting the PC in the morning never arms a shutdown.
const GRACE_MINS: i64 = 60;

#[derive(Deserialize, Debug, PartialEq)]
#[serde(default)]
struct NightlyConfig {
    enabled: bool,
    action: TerminalAction,
    time: String,
}

impl Default for NightlyConfig {
    fn default() -> Self {
        Self { enabled: false, action: TerminalAction::Shutdown, time: "02:00".into() }
    }
}

/// The enabled config's action and time, or `None` when off, absent, or
/// malformed (a bad value must never arm anything).
fn parse_config(raw: Option<&serde_json::Value>) -> Option<(TerminalAction, NaiveTime)> {
    let cfg: NightlyConfig = serde_json::from_value(raw?.clone()).ok()?;
    if !cfg.enabled {
        return None;
    }
    let at = NaiveTime::parse_from_str(&cfg.time, "%H:%M").ok()?;
    Some((cfg.action, at))
}

/// The night (the date its arm time falls on) that is due to arm at `now`, if
/// any. Checks yesterday too, so a 23:30 arm time still catches up at 00:10.
fn due_night(now: NaiveDateTime, at: NaiveTime, last_armed: Option<NaiveDate>) -> Option<NaiveDate> {
    let today = now.date();
    [Some(today), today.pred_opt()].into_iter().flatten().find(|day| {
        let target = day.and_time(at);
        Some(*day) != last_armed
            && now >= target
            && now < target + chrono::Duration::minutes(GRACE_MINS)
    })
}

/// Start the nightly scheduler loop. Runs for the app's lifetime.
pub fn spawn(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        // In-memory on purpose: once a night is consumed (armed, or skipped
        // because something was already armed), cancelling it keeps it off
        // until the next night.
        let mut last_armed: Option<NaiveDate> = None;
        loop {
            tokio::time::sleep(TICK).await;
            let state = app.state::<AppState>();
            let raw = state.settings.lock().unwrap().extra.get("nightlyWhenDone").cloned();
            let Some((action, at)) = parse_config(raw.as_ref()) else { continue };
            let Some(night) = due_night(Local::now().naive_local(), at, last_armed) else { continue };
            last_armed = Some(night);

            let already_armed = state.when_done.lock().unwrap().state.phase != ProtocolPhase::Disarmed;
            if already_armed {
                log::info!("when_done: nightly arm skipped, a when-done run is already armed");
                continue;
            }
            log::info!("when_done: nightly arm ({action:?})");
            arm(&app, action, ArmMode::Nightly);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn dt(s: &str) -> NaiveDateTime {
        NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M").unwrap()
    }

    fn two_am() -> NaiveTime {
        NaiveTime::from_hms_opt(2, 0, 0).unwrap()
    }

    #[test]
    fn arms_at_the_set_time_and_within_the_grace_window() {
        assert_eq!(due_night(dt("2026-09-30 02:00"), two_am(), None), Some(dt("2026-09-30 00:00").date()));
        assert_eq!(due_night(dt("2026-09-30 02:59"), two_am(), None), Some(dt("2026-09-30 00:00").date()));
    }

    #[test]
    fn does_not_arm_before_the_time_or_after_the_grace_window() {
        assert_eq!(due_night(dt("2026-09-30 01:59"), two_am(), None), None);
        // Booting the PC in the morning must not arm a shutdown.
        assert_eq!(due_night(dt("2026-09-30 09:00"), two_am(), None), None);
    }

    #[test]
    fn arms_once_per_night() {
        let night = dt("2026-09-30 00:00").date();
        assert_eq!(due_night(dt("2026-09-30 02:30"), two_am(), Some(night)), None);
        assert_eq!(due_night(dt("2026-10-01 02:00"), two_am(), Some(night)), Some(dt("2026-10-01 00:00").date()));
    }

    #[test]
    fn a_late_evening_time_catches_up_past_midnight() {
        let at = NaiveTime::from_hms_opt(23, 30, 0).unwrap();
        assert_eq!(due_night(dt("2026-10-01 00:10"), at, None), Some(dt("2026-09-30 00:00").date()));
    }

    #[test]
    fn parses_only_an_enabled_well_formed_config() {
        assert_eq!(
            parse_config(Some(&json!({ "enabled": true, "action": "sleep", "time": "01:15" }))),
            Some((TerminalAction::Sleep, NaiveTime::from_hms_opt(1, 15, 0).unwrap()))
        );
        assert_eq!(parse_config(Some(&json!({ "enabled": true }))), Some((TerminalAction::Shutdown, two_am())));
        assert_eq!(parse_config(Some(&json!({ "enabled": false, "time": "02:00" }))), None);
        assert_eq!(parse_config(Some(&json!({ "enabled": true, "time": "2am" }))), None);
        assert_eq!(parse_config(None), None);
    }
}
