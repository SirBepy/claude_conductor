//! Pure detection logic + the SignalSource abstraction (no OS calls here).
//! Ported from tauri_kit_meeting.

use serde::Serialize;

/// Snapshot of the three raw signals at one poll.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
pub struct Sources {
    pub camera: bool,
    pub mic: bool,
    pub audio: bool,
}

impl Sources {
    /// The signals that are on, by the name each field carries. `audio` means a
    /// meeting-app audio session, not any sound.
    pub fn names(self) -> Vec<&'static str> {
        [("camera", self.camera), ("mic", self.mic), ("audio", self.audio)]
            .into_iter()
            .filter_map(|(name, on)| on.then_some(name))
            .collect()
    }
}

/// Reads the three raw signals. Implemented by the OS layer; faked in tests.
pub trait SignalSource: Send {
    fn camera_in_use(&self) -> bool;
    fn mic_in_use(&self) -> bool;
    /// True if any process whose name matches `allow` has an active audio render session.
    fn meeting_app_audio_active(&self, allow: &[String]) -> bool;
}

/// Combine the three raw signals into a single "in meeting" boolean.
pub fn compute_in_meeting(s: Sources) -> bool {
    s.camera || s.mic || s.audio
}

/// Case-insensitive match of a process image name against the allow list.
/// `proc_name` is e.g. "Teams.exe"; `allow` entries may be "teams.exe" or "Teams.exe".
pub fn process_name_matches(proc_name: &str, allow: &[String]) -> bool {
    allow.iter().any(|a| a.eq_ignore_ascii_case(proc_name))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn in_meeting_when_any_signal_true() {
        assert!(!compute_in_meeting(Sources::default()));
        assert!(compute_in_meeting(Sources { camera: true, ..Default::default() }));
        assert!(compute_in_meeting(Sources { mic: true, ..Default::default() }));
        assert!(compute_in_meeting(Sources { audio: true, ..Default::default() }));
    }

    #[test]
    fn names_lists_only_the_signals_that_are_on() {
        assert!(Sources::default().names().is_empty());
        assert_eq!(Sources { camera: true, mic: false, audio: true }.names(), vec!["camera", "audio"]);
        assert_eq!(Sources { camera: true, mic: true, audio: true }.names(), vec!["camera", "mic", "audio"]);
    }

    #[test]
    fn process_match_is_case_insensitive() {
        let allow = vec!["Teams.exe".to_string(), "zoom.exe".to_string()];
        assert!(process_name_matches("teams.exe", &allow));
        assert!(process_name_matches("ZOOM.EXE", &allow));
        assert!(!process_name_matches("chrome.exe", &allow));
    }
}
