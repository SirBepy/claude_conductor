use serde::{Deserialize, Serialize};
use tauri::async_runtime::JoinHandle;

/// The terminal action to perform once every session is idle.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, ts_rs::TS)]
#[serde(rename_all = "lowercase")]
#[ts(export_to = "../../../src/types/ipc.generated.ts")]
pub enum TerminalAction {
    Sleep,
    Shutdown,
}

/// How the protocol was armed. `Nightly` is the unattended scheduled arm: it
/// never auto-answers prompts, never gives up on a long turn, and also waits
/// for the user to have stepped away from the PC.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ArmMode {
    Manual,
    Nightly,
}

/// Where the protocol currently is in its lifecycle.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "../../../src/types/ipc.generated.ts")]
pub enum ProtocolPhase {
    Disarmed,
    Watching,
    CountingDown,
    Firing,
    /// Aborted without firing: the Watching no-progress guard gave up (todo
    /// 894). Distinct from `Disarmed` so the UI can tell "it tried and gave
    /// up" from "it was never armed" - the two used to be byte-identical.
    GaveUp,
}

/// Snapshot of the protocol, emitted to the frontend each tick.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, ts_rs::TS)]
#[ts(export_to = "../../../src/types/ipc.generated.ts")]
pub struct ProtocolState {
    pub action: Option<TerminalAction>,
    pub phase: ProtocolPhase,
    pub countdown_remaining_secs: Option<u32>,
    /// Session ids not yet idle. In the `GaveUp` phase, this is instead
    /// the set of session ids that were still blocking progress when the
    /// Watching loop gave up.
    pub waiting_on: Vec<String>,
    /// Why the protocol gave up, set only when `phase == GaveUp`. `None` for
    /// every other phase.
    #[serde(default)]
    pub gave_up_reason: Option<String>,
}

impl ProtocolState {
    pub fn disarmed() -> Self {
        Self {
            action: None,
            phase: ProtocolPhase::Disarmed,
            countdown_remaining_secs: None,
            waiting_on: Vec::new(),
            gave_up_reason: None,
        }
    }

    /// Aborted without firing: carries the action that was armed (so the UI
    /// can still name it), why it gave up, and which session ids were still
    /// blocking progress.
    pub fn gave_up(action: TerminalAction, reason: impl Into<String>, blocking: Vec<String>) -> Self {
        Self {
            action: Some(action),
            phase: ProtocolPhase::GaveUp,
            countdown_remaining_secs: None,
            waiting_on: blocking,
            gave_up_reason: Some(reason.into()),
        }
    }
}

/// AppState-held protocol state plus a handle to the running engine task.
pub struct WhenDoneInner {
    pub state: ProtocolState,
    pub task: Option<JoinHandle<()>>,
}

impl Default for WhenDoneInner {
    fn default() -> Self {
        Self {
            state: ProtocolState::disarmed(),
            task: None,
        }
    }
}
