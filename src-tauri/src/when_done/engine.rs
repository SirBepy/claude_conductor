pub use super::protocol::{ArmMode, TerminalAction, ProtocolPhase, ProtocolState, OverdueAction};
use super::deps::EngineDeps;
use super::idle::{log_comment, next_countdown, waiting_on_ids};
use crate::state::AppState;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

/// Nightly only: once `deadline` passes without the arm having fired, stop
/// waiting - either give up and go back to normal, or force the action
/// regardless of busy/away state. `deadline` is computed once, at arm time,
/// from the configured number of overdue hours.
#[derive(Clone, Copy)]
pub(crate) struct Overdue {
    pub(crate) deadline: Instant,
    pub(crate) action: OverdueAction,
}

const TICK_MS: u64 = 1000;
pub(super) const COUNTDOWN_SECS: u32 = 30;
const NO_PROGRESS_LIMIT: Duration = Duration::from_secs(12 * 60 * 60);
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
pub(super) async fn run_engine(
    app: AppHandle,
    action: TerminalAction,
    mode: ArmMode,
    overdue: Option<Overdue>,
) {
    run_engine_with_deps(EngineDeps::production(app), action, mode, overdue).await;
}

/// Outcome of the CountingDown phase.
enum Countdown {
    Finished,
    Cancelled,
    /// The user postponed mid-countdown, or (nightly only) came back or a chat
    /// went busy, so the engine drops back to Watching instead of firing.
    Interrupted,
}

/// Outcome of the Watching phase.
enum WatchOutcome {
    /// Ready to count down. `forced` is true only when a nightly overdue
    /// cutoff forced this through regardless of busy/away state - the
    /// countdown must not let a nightly interrupt check reverse that.
    Ready { forced: bool },
    /// Cancelled, or gave up (either the no-progress runaway guard, or a
    /// nightly overdue cutoff set to cancel rather than force).
    GiveUp,
}

/// How long after a postpone ends a nightly overdue cutoff may still apply.
/// Without it a postpone that runs past the cutoff would hit the cutoff the
/// moment it ends, so a `Cancel` cutoff would give up exactly when the run could
/// finally fire.
const SNOOZE_OVERDUE_GRACE: Duration = Duration::from_secs(10 * 60);

/// Whether a manual postpone (`snooze_when_done`) is still in force.
fn snoozed(deps: &EngineDeps) -> bool {
    (deps.snooze_until)().is_some_and(|until| (deps.now)() < until)
}

/// Whether the engine may leave Watching (or keep counting down). A nightly arm
/// additionally needs the user to have been away for `NIGHTLY_AWAY_SECS`.
fn ready_to_fire(deps: &EngineDeps, mode: ArmMode) -> bool {
    !snoozed(deps)
        && (deps.all_idle)()
        && (mode == ArmMode::Manual || (deps.user_idle_secs)() >= NIGHTLY_AWAY_SECS)
}

/// The phase machine: Watching -> CountingDown -> Firing. Drives only through
/// `deps`, so it is identical for production and tests. Runs until the action
/// fires, the protocol is cancelled, or the runaway guard trips. A run drops
/// back to Watching if interrupted: by a postpone in any mode, or on a nightly
/// run by the user returning or a chat going busy. Chats are never closed:
/// every one is still there after boot.
async fn run_engine_with_deps(
    deps: EngineDeps,
    action: TerminalAction,
    mode: ArmMode,
    overdue: Option<Overdue>,
) {
    loop {
        let forced = match watch(&deps, mode, action, overdue).await {
            WatchOutcome::GiveUp => return,
            WatchOutcome::Ready { forced } => forced,
        };
        match countdown(&deps, mode, forced).await {
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
/// manual arm. `GiveUp` when cancelled, the runaway guard gave up (todo 894:
/// distinct from a plain cancel, see `ProtocolState::gave_up`), or a nightly
/// overdue cutoff passed with `OverdueAction::Cancel`.
async fn watch(deps: &EngineDeps, mode: ArmMode, action: TerminalAction, overdue: Option<Overdue>) -> WatchOutcome {
    let mut no_progress_since = (deps.now)();
    let mut last_idle_signature: Option<Vec<(String, bool)>> = None;

    loop {
        if (deps.is_cancelled)() {
            return WatchOutcome::GiveUp;
        }
        tokio::time::sleep(Duration::from_millis(TICK_MS)).await;
        if (deps.is_cancelled)() {
            return WatchOutcome::GiveUp;
        }

        if mode == ArmMode::Manual {
            (deps.auto_resolve)().await;
        }

        let busy_map = (deps.busy_map)();
        let waiting: Vec<String> = waiting_on_ids(&busy_map);

        let postponed = snoozed(deps);
        (deps.mutate_and_emit)(&mut |s| {
            s.phase = ProtocolPhase::Watching;
            s.countdown_remaining_secs = None;
            s.waiting_on = waiting.clone();
            if !postponed {
                s.snoozed_until_unix_ms = None;
            }
        });

        // Nightly overdue cutoff: stop waiting once the deadline passes,
        // regardless of busy/away state. A postpone pushes the cutoff past its end.
        if let Some(ov) = overdue {
            let deadline = match (deps.snooze_until)() {
                Some(until) => ov.deadline.max(until + SNOOZE_OVERDUE_GRACE),
                None => ov.deadline,
            };
            if (deps.now)() >= deadline {
                match ov.action {
                    OverdueAction::Force => return WatchOutcome::Ready { forced: true },
                    OverdueAction::Cancel => {
                        const REASON: &str =
                            "nightly arm overdue past its cutoff; cancelling, back to normal";
                        log_comment(&format!("[when-done] {REASON}"));
                        (deps.mutate_and_emit)(&mut |s| {
                            *s = ProtocolState::gave_up(action, REASON, waiting.clone());
                        });
                        return WatchOutcome::GiveUp;
                    }
                }
            }
        }

        // Runaway guard: if the busy signature is unchanged for too long, bail.
        // Not on a nightly arm: nobody is there to re-arm it, and staying armed
        // only keeps the PC on, which is what would happen without it anyway.
        // A postponed run is waiting on purpose, not stuck, so the limit counts
        // from the postpone's end (a postpone may be longer than the limit).
        if postponed {
            no_progress_since = (deps.now)();
        }
        let sig = Some(busy_map.clone());
        if sig != last_idle_signature {
            last_idle_signature = sig;
            no_progress_since = (deps.now)();
        } else if mode == ArmMode::Manual
            && (deps.now)().duration_since(no_progress_since) > NO_PROGRESS_LIMIT
        {
            const REASON: &str = "no progress in Watching for 12 h (sessions never went idle)";
            log_comment(&format!("[when-done] gave up: {REASON}; disarming"));
            (deps.mutate_and_emit)(&mut |s| {
                *s = ProtocolState::gave_up(action, REASON, waiting.clone());
            });
            return WatchOutcome::GiveUp;
        }

        // All live sessions idle? (Empty list counts as idle: nothing to wait on.)
        if ready_to_fire(deps, mode) {
            return WatchOutcome::Ready { forced: false };
        }
    }
}

/// Phase: CountingDown. 30s, decrement + emit each second. `forced` is set
/// when a nightly overdue cutoff forced entry into this phase; while true, the
/// nightly interrupt check below is skipped, since the whole point of forcing
/// was to stop waiting on the user/chats.
async fn countdown(deps: &EngineDeps, mode: ArmMode, forced: bool) -> Countdown {
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
        // A postpone interrupts even a forced countdown: the user said not now.
        if snoozed(deps) || (mode == ArmMode::Nightly && !forced && !ready_to_fire(deps, mode)) {
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
