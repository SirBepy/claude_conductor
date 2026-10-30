use serde::{Deserialize, Serialize};

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
}
