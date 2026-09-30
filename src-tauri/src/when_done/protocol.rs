use serde::{Deserialize, Serialize};
use tauri::async_runtime::JoinHandle;

/// The terminal action to perform once every session has been closed.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, ts_rs::TS)]
#[serde(rename_all = "lowercase")]
#[ts(export_to = "../../../src/types/ipc.generated.ts")]
pub enum TerminalAction {
    Sleep,
    Shutdown,
}

/// How the protocol was armed. `Nightly` is the unattended scheduled arm: it
/// leaves every chat exactly as it is (no `/close`, no auto-answered prompts) so
/// they are all still there after boot, never gives up on a long turn, and also
/// waits for the user to have stepped away from the PC.
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
    Closing,
    CountingDown,
    Firing,
}

/// Snapshot of the protocol, emitted to the frontend each tick.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, ts_rs::TS)]
#[ts(export_to = "../../../src/types/ipc.generated.ts")]
pub struct ProtocolState {
    pub action: Option<TerminalAction>,
    pub phase: ProtocolPhase,
    pub countdown_remaining_secs: Option<u32>,
    /// Session ids not yet idle/closed.
    pub waiting_on: Vec<String>,
}

impl ProtocolState {
    pub fn disarmed() -> Self {
        Self {
            action: None,
            phase: ProtocolPhase::Disarmed,
            countdown_remaining_secs: None,
            waiting_on: Vec::new(),
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
