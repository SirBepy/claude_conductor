use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default, ts_rs::TS)]
#[serde(default)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct AutomationConfig {
    pub enabled: bool,
    pub autostart_on_boot: bool,
    pub session_name_prefix: Option<String>,
    pub continue_flag: bool,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, ts_rs::TS)]
#[serde(rename_all = "kebab-case")]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub enum EndReason {
    HookSessionEnd,
    ProcessGone,
    ChildExit,
    Manual,
    /// Forked onto another account by `move_session_to_account`. The successor
    /// session carries the full transcript under a fresh id; this record stays
    /// only as the History entry for the pre-move stretch.
    Moved,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, ts_rs::TS)]
#[serde(rename_all = "lowercase")]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub enum AuthState {
    LoggedIn,
    NeedsLogin,
    InProgress,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, ts_rs::TS)]
#[serde(rename_all = "lowercase")]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub enum ChannelStatus {
    /// Starting but no child or hwnd yet.
    Starting,
    /// Running with a live child.
    Running,
    /// Exited recently; restart policy may re-spawn.
    Stopped,
    /// Crashed and backoff has exhausted; no automatic restart.
    Crashed,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn end_reason_serializes_kebab_case() {
        let cases: Vec<(EndReason, &str)> = vec![
            (EndReason::HookSessionEnd, "\"hook-session-end\""),
            (EndReason::ProcessGone, "\"process-gone\""),
            (EndReason::ChildExit, "\"child-exit\""),
            (EndReason::Manual, "\"manual\""),
        ];
        for (r, expected) in cases {
            assert_eq!(serde_json::to_string(&r).unwrap(), expected);
        }
    }

    #[test]
    fn channel_status_serializes_lowercase() {
        assert_eq!(
            serde_json::to_string(&ChannelStatus::Running).unwrap(),
            "\"running\""
        );
    }
}
