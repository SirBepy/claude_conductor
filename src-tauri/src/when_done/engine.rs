pub use super::protocol::{TerminalAction, ProtocolPhase, ProtocolState};
use super::actions::{auto_resolve_prompts, inject_close};
use super::idle::{
    all_sessions_idle, close_turn_complete, live_busy_map, live_session_ids, log_comment,
    next_countdown, waiting_on_ids,
};
use crate::state::AppState;
use std::future::Future;
use std::pin::Pin;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

/// A boxed, owned future the engine seams hand back. The phase machine awaits
/// these without caring whether the body is the real daemon client or a test
/// stub.
type BoxFut<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

const TICK_MS: u64 = 1000;
pub(super) const COUNTDOWN_SECS: u32 = 30;
const PER_SESSION_TIMEOUT: Duration = Duration::from_secs(180);
const NO_PROGRESS_LIMIT: Duration = Duration::from_secs(180);

/// Read the current ProtocolState under the lock, mutate it via `f`, store it,
/// and emit `when-done-state` with the new value. Returns the new state.
fn update_and_emit<F: FnOnce(&mut ProtocolState)>(
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
fn is_cancelled(app: &AppHandle) -> bool {
    let state = app.state::<AppState>();
    let inner = state.when_done.lock().unwrap();
    inner.state.phase == ProtocolPhase::Disarmed
}

/// The integration seams the phase machine drives, behind owned closures so the
/// production path can wire the real AppHandle + daemon client while a test wires
/// recording stubs. Every external effect run_engine performs (reading live
/// instances, resolving prompts, injecting /close, emitting state, checking
/// cancellation, firing the terminal action) goes through exactly one of these.
struct EngineDeps {
    /// Snapshot of the live (not-ended) `(session_id, busy)` pairs. Mirrors
    /// `live_busy_map` in production; a test can mutate its source between ticks.
    busy_map: Box<dyn Fn() -> Vec<(String, bool)> + Send>,
    /// Whether every live session is idle. Mirrors the inline
    /// `all_sessions_idle(&cached_instances)` check.
    all_idle: Box<dyn Fn() -> bool + Send>,
    /// Live (not-ended) session ids, in order. Mirrors `live_session_ids`.
    live_ids: Box<dyn Fn() -> Vec<String> + Send>,
    /// Auto-resolve every pending daemon prompt (permission/question). Async.
    auto_resolve: Box<dyn Fn() -> BoxFut<'static, ()> + Send>,
    /// Inject `/close` into one session; true on a successful send. Async.
    inject_close: Box<dyn Fn(String) -> BoxFut<'static, bool> + Send>,
    /// Mutate the stored ProtocolState and emit `when-done-state`. Mirrors
    /// `update_and_emit`; returns the new state.
    mutate_and_emit: Box<dyn Fn(&mut dyn FnMut(&mut ProtocolState)) -> ProtocolState + Send>,
    /// Whether cancel was requested (stored phase forced to Disarmed).
    is_cancelled: Box<dyn Fn() -> bool + Send>,
    /// Perform the terminal action (sleep/shutdown). Returns its Result so the
    /// caller logs a failure exactly as the production path does.
    terminal: Box<dyn Fn(TerminalAction) -> Result<(), String> + Send>,
}

impl EngineDeps {
    /// Wire the real production seams from an AppHandle. This is the only place
    /// that touches AppState / the daemon client / system_control, so the
    /// production behavior is identical to the pre-refactor inline body.
    fn production(app: AppHandle) -> Self {
        let app_busy = app.clone();
        let app_idle = app.clone();
        let app_ids = app.clone();
        let app_resolve = app.clone();
        let app_close = app.clone();
        let app_emit = app.clone();
        let app_cancel = app.clone();
        Self {
            busy_map: Box::new(move || live_busy_map(&app_busy)),
            all_idle: Box::new(move || {
                let state = app_idle.state::<AppState>();
                let guard = state.cached_instances.lock().unwrap();
                all_sessions_idle(&guard)
            }),
            live_ids: Box::new(move || live_session_ids(&app_ids)),
            auto_resolve: Box::new(move || {
                let app = app_resolve.clone();
                Box::pin(async move { auto_resolve_prompts(&app).await })
            }),
            inject_close: Box::new(move |session_id| {
                let app = app_close.clone();
                Box::pin(async move { inject_close(&app, &session_id).await })
            }),
            mutate_and_emit: Box::new(move |f| update_and_emit(&app_emit, f)),
            is_cancelled: Box::new(move || is_cancelled(&app_cancel)),
            terminal: Box::new(|action| match action {
                TerminalAction::Sleep => crate::system_control::sleep_pc(),
                TerminalAction::Shutdown => crate::system_control::shutdown_pc(),
            }),
        }
    }
}

/// The engine task. Thin production wiring: build the real seams, then run the
/// phase machine. All behavior lives in `run_engine_with_deps`.
pub(super) async fn run_engine(app: AppHandle, action: TerminalAction) {
    run_engine_with_deps(EngineDeps::production(app), action).await;
}

/// The phase machine: Watching -> Closing -> CountingDown -> Firing. Drives only
/// through `deps`, so it is identical for production and tests. Runs until the
/// action fires, the protocol is cancelled, or the runaway guard trips.
async fn run_engine_with_deps(deps: EngineDeps, action: TerminalAction) {
    // --- Phase: Watching. Wait for all sessions idle, auto-resolving prompts. ---
    let mut no_progress_since = Instant::now();
    let mut last_idle_signature: Option<Vec<(String, bool)>> = None;

    loop {
        if (deps.is_cancelled)() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(TICK_MS)).await;
        if (deps.is_cancelled)() {
            return;
        }

        (deps.auto_resolve)().await;

        let busy_map = (deps.busy_map)();
        let waiting: Vec<String> = waiting_on_ids(&busy_map);

        (deps.mutate_and_emit)(&mut |s| {
            s.phase = ProtocolPhase::Watching;
            s.waiting_on = waiting.clone();
        });

        // Runaway guard: if the busy signature is unchanged for too long, bail.
        let sig = Some(busy_map.clone());
        if sig != last_idle_signature {
            last_idle_signature = sig;
            no_progress_since = Instant::now();
        } else if no_progress_since.elapsed() > NO_PROGRESS_LIMIT {
            log_comment(
                "[when-done] aborted: no progress in Watching for 3 min (sessions never went idle); disarming",
            );
            (deps.mutate_and_emit)(&mut |s| {
                *s = ProtocolState::disarmed();
            });
            return;
        }

        // All live sessions idle? (Empty list counts as idle: nothing to wait on.)
        if (deps.all_idle)() {
            break;
        }
    }

    if (deps.is_cancelled)() {
        return;
    }

    // --- Phase: Closing. Inject /close into each live session, wait for each. ---
    let targets = (deps.live_ids)();
    (deps.mutate_and_emit)(&mut |s| {
        s.phase = ProtocolPhase::Closing;
        s.waiting_on = targets.clone();
    });

    for session_id in &targets {
        if (deps.is_cancelled)() {
            return;
        }
        let sent = (deps.inject_close)(session_id.clone()).await;
        if !sent {
            // Couldn't inject (gone or send failed): treat as done, drop it.
            (deps.mutate_and_emit)(&mut |s| {
                s.waiting_on.retain(|id| id != session_id);
            });
            continue;
        }

        // Wait for this close turn to complete: busy flips true then back to
        // false, OR the session disappears from the live list. Per-session
        // timeout of 180s.
        let started = Instant::now();
        let mut saw_busy = false;
        loop {
            if (deps.is_cancelled)() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(TICK_MS)).await;
            // Keep auto-resolving prompts during close turns (e.g. /close that
            // triggers a tool needing permission).
            (deps.auto_resolve)().await;

            let busy_map = (deps.busy_map)();
            let present = busy_map
                .iter()
                .find(|(id, _)| id == session_id)
                .map(|(_, busy)| *busy);
            if close_turn_complete(present, &mut saw_busy) {
                break;
            }

            if started.elapsed() > PER_SESSION_TIMEOUT {
                log_comment(&format!(
                    "[when-done] /close for session {session_id} timed out after 180s; proceeding"
                ));
                break;
            }
        }

        (deps.mutate_and_emit)(&mut |s| {
            s.waiting_on.retain(|id| id != session_id);
        });
    }

    if (deps.is_cancelled)() {
        return;
    }

    // --- Phase: CountingDown. 30s, decrement + emit each second. ---
    (deps.mutate_and_emit)(&mut |s| {
        s.phase = ProtocolPhase::CountingDown;
        s.countdown_remaining_secs = Some(COUNTDOWN_SECS);
        s.waiting_on.clear();
    });

    let mut remaining = COUNTDOWN_SECS;
    while let Some(next) = next_countdown(remaining) {
        if (deps.is_cancelled)() {
            return;
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
        if (deps.is_cancelled)() {
            return;
        }
        remaining = next;
        (deps.mutate_and_emit)(&mut |s| {
            s.countdown_remaining_secs = Some(remaining);
        });
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

#[cfg(test)]
#[path = "engine_tests.rs"]
mod tests;
