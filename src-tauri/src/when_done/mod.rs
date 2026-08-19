//! "Do-X-when-all-sessions-idle" protocol engine.
//!
//! Lives in the Tauri MAIN process (not the daemon). One armed protocol at a
//! time. When armed, a background tokio task:
//!   1. Watches every live session and auto-resolves any blocking prompt
//!      (permission -> allow as-is, question -> first/default option).
//!   2. Once all sessions are idle, injects `/close` into each and waits for
//!      each close turn to finish.
//!   3. Counts down 30s, then fires the terminal action (sleep / shutdown).
//!
//! Cancellation, per-session timeouts, and a no-progress runaway guard keep the
//! task from spinning forever. Every tick emits the current `ProtocolState` to
//! all windows on the `when-done-state` event.

mod protocol;
mod actions;
mod engine;
mod idle;

pub use protocol::{TerminalAction, ProtocolPhase, ProtocolState, WhenDoneInner};
use engine::run_engine;

use crate::state::AppState;
use tauri::{AppHandle, Emitter};

/// Arm the protocol: set the action, spawn the engine task (aborting any
/// existing one first), and return the new state.
#[tauri::command]
pub async fn arm_when_done(
    action: TerminalAction,
    state: tauri::State<'_, AppState>,
    app: AppHandle,
) -> Result<ProtocolState, String> {
    // Abort any existing engine task and reset to a fresh Watching state.
    let new_state = {
        let mut inner = state.when_done.lock().unwrap();
        if let Some(handle) = inner.task.take() {
            handle.abort();
        }
        inner.state = ProtocolState {
            action: Some(action),
            phase: ProtocolPhase::Watching,
            countdown_remaining_secs: None,
            waiting_on: Vec::new(),
        };
        inner.state.clone()
    };

    let app_for_task = app.clone();
    let handle = tauri::async_runtime::spawn(async move {
        run_engine(app_for_task, action).await;
    });
    {
        let mut inner = state.when_done.lock().unwrap();
        inner.task = Some(handle);
    }

    let _ = app.emit("when-done-state", new_state.clone());
    Ok(new_state)
}

/// Cancel the protocol: abort the engine task, reset to Disarmed, emit, return.
#[tauri::command]
pub async fn cancel_when_done(
    state: tauri::State<'_, AppState>,
    app: AppHandle,
) -> Result<ProtocolState, String> {
    let new_state = {
        let mut inner = state.when_done.lock().unwrap();
        if let Some(handle) = inner.task.take() {
            handle.abort();
        }
        inner.state = ProtocolState::disarmed();
        inner.state.clone()
    };
    let _ = app.emit("when-done-state", new_state.clone());
    Ok(new_state)
}

/// Read the current protocol state.
#[tauri::command]
pub async fn get_when_done_state(
    state: tauri::State<'_, AppState>,
) -> Result<ProtocolState, String> {
    let inner = state.when_done.lock().unwrap();
    Ok(inner.state.clone())
}
