//! The tray's mute-choice types: a self-contained concern kept apart from
//! `Settings` (`notifications.rs`), which already carries sort order, hooks,
//! accounts and retention policy and has no reason to also own this shape.
//! `Settings` itself, and the `mute_all` / `mute_choice` methods that read
//! these types, stay in `notifications.rs` since they're `Settings` behavior.

use super::notifications::Settings;

/// A timed mute: the deadline (epoch ms) and the length it was picked with, so
/// the tray can tick the matching duration's check mark.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TimedMute {
    pub until_ms: i64,
    pub secs: u64,
}

/// What the tray's Mute Notifications submenu has selected.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MuteChoice {
    /// Persisted `muteAll` flag: stays muted until switched off.
    Forever,
    Timed(u64),
}

/// Pure carry-over for `save_settings`'s full-replace: the frontend never
/// round-trips the tray's timed mute (it is `serde(skip)`, so a save built
/// from the dashboard's own snapshot always carries `timed_mute: None`).
/// Copying the live value onto the incoming payload keeps that replace from
/// silently cancelling an active timed mute.
pub(crate) fn carry_over_timed_mute(mut updated: Settings, live: Option<TimedMute>) -> Settings {
    updated.timed_mute = live;
    updated
}

pub(crate) fn now_epoch_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Todo 1087: `save_settings`'s full-replace must not cancel an active
    /// timed mute just because the dashboard's own snapshot never carries
    /// one (the field is `serde(skip)`).
    #[test]
    fn carry_over_timed_mute_restores_the_live_value_onto_a_payload_with_none() {
        let incoming = Settings { timed_mute: None, ..Settings::default() };
        let live = Some(TimedMute { until_ms: 123_456, secs: 3600 });
        let out = carry_over_timed_mute(incoming, live);
        assert_eq!(out.timed_mute, live);
    }

    #[test]
    fn carry_over_timed_mute_clears_when_the_live_value_is_none() {
        let incoming = Settings {
            timed_mute: Some(TimedMute { until_ms: 1, secs: 1 }),
            ..Settings::default()
        };
        let out = carry_over_timed_mute(incoming, None);
        assert_eq!(out.timed_mute, None);
    }
}
