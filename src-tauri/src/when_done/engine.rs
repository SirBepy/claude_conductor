pub use super::protocol::{ArmMode, TerminalAction, ProtocolPhase, ProtocolState};
use super::deps::EngineDeps;
use super::idle::{log_comment, next_countdown, waiting_on_ids};
use crate::state::AppState;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

const TICK_MS: u64 = 1000;
pub(super) const COUNTDOWN_SECS: u32 = 30;
const NO_PROGRESS_LIMIT: Duration = Duration::from_secs(180);
/// A nightly arm only fires once there has been no keyboard/mouse input for this
/// long, so it never shuts the PC down under someone still using it.
pub(super) const NIGHTLY_AWAY_SECS: u64 = 15 * 60;

/// Read the current ProtocolState under the lock, mutate it via `f`, store it,
/// and emit `when-done-state` with the new value. Returns the new state.
pub(super) fn update_and_emit<F: FnOnce(&mut ProtocolState)>(
    app: &AppHandle,
    f: F,
) -> ProtocolState {
    let state = app.state::<AppState>();
    let new_state = {
        let mut inner = state.when_done.lock().unwrap();
        f(&mut inner.state);
        inner.state.clone()
    };
    let _ = app.emit("when-done-state", new_state.clone());
    new_state
}

/// Whether cancel was requested: the stored phase has been forced to Disarmed by
/// `cancel_when_done`.
pub(super) fn is_cancelled(app: &AppHandle) -> bool {
    let state = app.state::<AppState>();
    let inner = state.when_done.lock().unwrap();
    inner.state.phase == ProtocolPhase::Disarmed
}

/// The engine task. Thin production wiring: build the real seams, then run the
/// phase machine. All behavior lives in `run_engine_with_deps`.
pub(super) async fn run_engine(app: AppHandle, action: TerminalAction, mode: ArmMode) {
    run_engine_with_deps(EngineDeps::production(app), action, mode).await;
}

/// Outcome of the CountingDown phase.
enum Countdown {
    Finished,
    Cancelled,
    /// Nightly only: the user came back or a chat went busy mid-countdown, so
    /// the engine drops back to Watching instead of firing.
    Interrupted,
}

/// Whether the engine may leave Watching (or keep counting down). A nightly arm
/// additionally needs the user to have been away for `NIGHTLY_AWAY_SECS`.
fn ready_to_fire(deps: &EngineDeps, mode: ArmMode) -> bool {
    (deps.all_idle)()
        && (mode == ArmMode::Manual || (deps.user_idle_secs)() >= NIGHTLY_AWAY_SECS)
}

/// The phase machine: Watching -> CountingDown -> Firing. Drives only through
/// `deps`, so it is identical for production and tests. Runs until the action
/// fires, the protocol is cancelled, or the runaway guard trips. A nightly run
/// drops back to Watching if interrupted. Chats are never closed: every one is
/// still there after boot.
async fn run_engine_with_deps(deps: EngineDeps, action: TerminalAction, mode: ArmMode) {
    loop {
        if !watch(&deps, mode, action).await {
            return;
        }
        match countdown(&deps, mode).await {
            Countdown::Finished => break,
            Countdown::Cancelled => return,
            Countdown::Interrupted => continue,
        }
    }

    if (deps.is_cancelled)() {
        return;
    }

    // --- Phase: Firing. Emit, then perform the terminal action. ---
    (deps.mutate_and_emit)(&mut |s| {
        s.phase = ProtocolPhase::Firing;
        s.countdown_remaining_secs = Some(0);
    });

    let result = (deps.terminal)(action);
    if let Err(e) = result {
        log_comment(&format!("[when-done] terminal action failed: {e}"));
        log::error!("when_done: terminal action failed: {e}");
    }
}

/// Phase: Watching. Wait until `ready_to_fire`, auto-resolving prompts on a
/// manual arm. False when cancelled or the runaway guard gave up on the
/// protocol (todo 894: distinct from a plain cancel, see `ProtocolState::gave_up`).
async fn watch(deps: &EngineDeps, mode: ArmMode, action: TerminalAction) -> bool {
    let mut no_progress_since = (deps.now)();
    let mut last_idle_signature: Option<Vec<(String, bool)>> = None;

    loop {
        if (deps.is_cancelled)() {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(TICK_MS)).await;
        if (deps.is_cancelled)() {
            return false;
        }

        if mode == ArmMode::Manual {
            (deps.auto_resolve)().await;
        }

        let busy_map = (deps.busy_map)();
        let waiting: Vec<String> = waiting_on_ids(&busy_map);

        (deps.mutate_and_emit)(&mut |s| {
            s.phase = ProtocolPhase::Watching;
            s.countdown_remaining_secs = None;
            s.waiting_on = waiting.clone();
        });

        // Runaway guard: if the busy signature is unchanged for too long, bail.
        // Not on a nightly arm: nobody is there to re-arm it, and staying armed
        // only keeps the PC on, which is what would happen without it anyway.
        let sig = Some(busy_map.clone());
        if sig != last_idle_signature {
            last_idle_signature = sig;
            no_progress_since = (deps.now)();
        } else if mode == ArmMode::Manual
            && (deps.now)().duration_since(no_progress_since) > NO_PROGRESS_LIMIT
        {
            const REASON: &str = "no progress in Watching for 3 min (sessions never went idle)";
            log_comment(&format!("[when-done] gave up: {REASON}; disarming"));
            (deps.mutate_and_emit)(&mut |s| {
                *s = ProtocolState::gave_up(action, REASON, waiting.clone());
            });
            return false;
        }

        // All live sessions idle? (Empty list counts as idle: nothing to wait on.)
        if ready_to_fire(deps, mode) {
            return true;
        }
    }
}

/// Phase: CountingDown. 30s, decrement + emit each second.
async fn countdown(deps: &EngineDeps, mode: ArmMode) -> Countdown {
    if (deps.is_cancelled)() {
        return Countdown::Cancelled;
    }

    (deps.mutate_and_emit)(&mut |s| {
        s.phase = ProtocolPhase::CountingDown;
        s.countdown_remaining_secs = Some(COUNTDOWN_SECS);
        s.waiting_on.clear();
    });

    let mut remaining = COUNTDOWN_SECS;
    while let Some(next) = next_countdown(remaining) {
        if (deps.is_cancelled)() {
            return Countdown::Cancelled;
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
        if (deps.is_cancelled)() {
            return Countdown::Cancelled;
        }
        if mode == ArmMode::Nightly && !ready_to_fire(deps, mode) {
            return Countdown::Interrupted;
        }
        remaining = next;
        (deps.mutate_and_emit)(&mut |s| {
            s.countdown_remaining_secs = Some(remaining);
        });
    }

    if (deps.is_cancelled)() {
        return Countdown::Cancelled;
    }
    Countdown::Finished
}

#[cfg(test)]
#[path = "engine_tests.rs"]
mod tests;
