pub use super::protocol::{TerminalAction, ProtocolPhase, ProtocolState};
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

/// Path to the repo-root COMMENTS_FOR_BEPY.md. `CARGO_MANIFEST_DIR` is
/// `src-tauri/`, so the repo root is its parent. Compile-time embedded, which is
/// how the dev app (Joe's run mode) resolves it.
fn comments_path() -> std::path::PathBuf {
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("COMMENTS_FOR_BEPY.md")
}

/// Append a one-line entry to COMMENTS_FOR_BEPY.md, creating it with a header if
/// it does not exist. Best-effort: logs on failure, never panics.
fn log_comment(line: &str) {
    use std::io::Write;
    let path = comments_path();
    let exists = path.exists();
    let res = (|| -> std::io::Result<()> {
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)?;
        if !exists {
            writeln!(f, "# Comments for Bepy")?;
        }
        writeln!(f, "{line}")
    })();
    if let Err(e) = res {
        log::warn!("when_done: failed to append COMMENTS_FOR_BEPY.md: {e}");
    }
}

/// True when an instance counts as idle/done: not busy AND not self-reporting
/// background work. `awaiting == "working"` means the session's own background
/// subagents/tasks are still running and will re-invoke it - sleeping now would
/// kill that work, so it is NOT idle. A hung "working" session cannot block
/// forever: the Watching loop's no-progress guard (unchanged signature for
/// NO_PROGRESS_LIMIT) disarms the protocol, same as a hung busy turn. A session
/// left `awaiting == "question"` is handled separately by the prompt poll; if
/// it has no pending prompt entry we still treat it as idle.
/// `local_task_running` covers what `awaiting` cannot: it collapses a live CI
/// poller and a pending scheduled wake into the same `"waiting"`, and only the
/// poller dies when the machine sleeps.
fn instance_is_idle(i: &crate::types::Instance) -> bool {
    !i.busy && i.awaiting.as_deref() != Some("working") && !i.local_task_running
}

/// True when every live (not-ended) session is idle. An empty list (after
/// filtering out ended sessions) counts as idle: nothing left to wait on.
/// Pure mirror of the inline all-idle check in the Watching loop.
fn all_sessions_idle(instances: &[crate::types::Instance]) -> bool {
    instances
        .iter()
        .filter(|i| i.ended_at.is_none())
        .all(instance_is_idle)
}

/// Session ids still busy, from a `(session_id, busy)` snapshot. Returns exactly
/// the ids whose busy flag is true, in input order; empty when all idle. Pure
/// mirror of the inline `waiting` computation in the Watching loop.
fn waiting_on_ids(busy_map: &[(String, bool)]) -> Vec<String> {
    busy_map
        .iter()
        .filter(|(_, busy)| *busy)
        .map(|(id, _)| id.clone())
        .collect()
}

/// Pure countdown step: the value to emit next, or `None` when the countdown
/// has reached zero and the terminal action should fire. Mirrors the
/// `while remaining > 0 { remaining -= 1; ... }` loop's decision: a positive
/// `remaining` yields `Some(remaining - 1)`, zero yields `None`.
fn next_countdown(remaining: u32) -> Option<u32> {
    if remaining > 0 {
        Some(remaining - 1)
    } else {
        None
    }
}

/// Per-tick close-turn completion check. Given whether the target session is
/// still present in the live list (`Some(busy)`), or has vanished (`None`),
/// updates the `saw_busy` latch and returns true when the close turn is
/// complete: the session vanished, OR it went busy then back to idle. Pure
/// mirror of the inline match in the Closing wait loop (timeout handled by the
/// caller, which stays timing-bound).
fn close_turn_complete(present: Option<bool>, saw_busy: &mut bool) -> bool {
    match present {
        None => true, // session closed/vanished -> done.
        Some(busy) => {
            if busy {
                *saw_busy = true;
                false
            } else if *saw_busy {
                // ran a turn and is now idle again -> done.
                true
            } else {
                false
            }
        }
    }
}

/// Currently-live (not ended) session ids from the cached instance list.
fn live_session_ids(app: &AppHandle) -> Vec<String> {
    let state = app.state::<AppState>();
    let guard = state.cached_instances.lock().unwrap();
    guard
        .iter()
        .filter(|i| i.ended_at.is_none())
        .map(|i| i.session_id.clone())
        .collect()
}

/// Snapshot of (session_id, in-flight) for live sessions. "In-flight" is
/// `busy` OR `awaiting == "working"` (self-reported background subagents/tasks
/// that will re-invoke the session) - the same non-idle definition as
/// `instance_is_idle`, so the Watching loop's waiting list, its no-progress
/// guard, and the all-idle break all agree.
fn live_busy_map(app: &AppHandle) -> Vec<(String, bool)> {
    let state = app.state::<AppState>();
    let guard = state.cached_instances.lock().unwrap();
    guard
        .iter()
        .filter(|i| i.ended_at.is_none())
        .map(|i| (i.session_id.clone(), !instance_is_idle(i)))
        .collect()
}

/// Auto-resolve every pending prompt: allow permissions as-is, answer questions
/// with the first/default option. Logs each auto-answer to COMMENTS_FOR_BEPY.md.
async fn auto_resolve_prompts(app: &AppHandle) {
    let state = app.state::<AppState>();
    let prompts = {
        let guard = state.daemon_client.lock().await;
        match guard.as_ref() {
            Some(c) => c.list_pending_prompts().await.ok(),
            None => None,
        }
    };
    let Some(prompts) = prompts else { return };
    let Some(arr) = prompts.as_array() else { return };

    for p in arr {
        let event = p.get("event").and_then(|v| v.as_str()).unwrap_or("");
        let payload = match p.get("payload") {
            Some(v) => v,
            None => continue,
        };
        let request_id = match payload.get("id").and_then(|v| v.as_str()) {
            Some(id) => id.to_string(),
            None => continue,
        };
        let guard = state.daemon_client.lock().await;
        let Some(client) = guard.as_ref() else { return };

        match event {
            "permission-requested" => {
                // Approve as-is: hand back the original tool input as updatedInput.
                let input = payload
                    .get("input")
                    .cloned()
                    .unwrap_or_else(|| serde_json::json!({}));
                let tool = payload
                    .get("tool_name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("?");
                if let Err(e) = client
                    .respond_permission(&request_id, true, Some(input), None)
                    .await
                {
                    log::warn!("when_done: auto-allow permission failed: {e}");
                } else {
                    log_comment(&format!(
                        "[when-done] auto-approved permission for tool '{tool}' (id {request_id})"
                    ));
                }
            }
            "question-requested" => {
                let questions = payload.get("questions");
                let answers = default_question_answers(questions);
                if let Err(e) = client.respond_question(&request_id, answers.clone(), false).await {
                    log::warn!("when_done: auto-answer question failed: {e}");
                } else {
                    log_comment(&format!(
                        "[when-done] auto-answered question with default option(s) (id {request_id})"
                    ));
                }
            }
            _ => {}
        }
    }
}

/// Build the `{ question_text: first_option_label }` answers map for a question
/// payload. Mirrors what the frontend posts to `respond_question`.
fn default_question_answers(questions: Option<&serde_json::Value>) -> serde_json::Value {
    let mut map = serde_json::Map::new();
    if let Some(arr) = questions.and_then(|q| q.as_array()) {
        for q in arr {
            let qtext = q.get("question").and_then(|v| v.as_str()).unwrap_or("");
            if qtext.is_empty() {
                continue;
            }
            let first_label = q
                .get("options")
                .and_then(|o| o.as_array())
                .and_then(|opts| opts.first())
                .and_then(|opt| opt.get("label"))
                .and_then(|l| l.as_str())
                .unwrap_or("");
            map.insert(qtext.to_string(), serde_json::Value::String(first_label.to_string()));
        }
    }
    serde_json::Value::Object(map)
}

/// Inject `/close` into a single session via the daemon.
async fn inject_close(app: &AppHandle, session_id: &str) -> bool {
    let state = app.state::<AppState>();
    let guard = state.daemon_client.lock().await;
    let Some(client) = guard.as_ref() else {
        return false;
    };
    match client.send_message(session_id, "/close").await {
        Ok(()) => true,
        Err(e) => {
            log::warn!("when_done: send /close to {session_id} failed: {e}");
            false
        }
    }
}

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
