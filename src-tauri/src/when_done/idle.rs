//! Pure idle/countdown decisions plus the live-instance snapshots they read.
//! Nothing here awaits or mutates another session; the engine loop owns timing
//! and `actions.rs` owns actuation.

use crate::state::AppState;
use tauri::{AppHandle, Manager};

/// Path to the repo-root COMMENTS_FOR_BEPY.md. `CARGO_MANIFEST_DIR` is
/// `src-tauri/`, so the repo root is its parent. Compile-time embedded, which is
/// how the dev app (Joe's run mode) resolves it.
///
/// Under `cfg(test)` this redirects to a scratch file in the system temp dir
/// instead: the real file is tracked in git and shared with other sessions'
/// WIP, and a test exercising an abort path (todo 894) must not append to it.
fn comments_path() -> std::path::PathBuf {
    #[cfg(test)]
    {
        return std::env::temp_dir().join("when_done_test_COMMENTS_FOR_BEPY.md");
    }
    #[cfg(not(test))]
    {
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("COMMENTS_FOR_BEPY.md")
    }
}

/// Append a one-line entry to COMMENTS_FOR_BEPY.md, creating it with a header if
/// it does not exist. Best-effort: logs on failure, never panics.
pub(super) fn log_comment(line: &str) {
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
pub(super) fn instance_is_idle(i: &crate::types::Instance) -> bool {
    !i.busy && i.awaiting.as_deref() != Some("working") && !i.local_task_running
}

/// True when every live (not-ended) session is idle. An empty list (after
/// filtering out ended sessions) counts as idle: nothing left to wait on.
/// Pure mirror of the inline all-idle check in the Watching loop.
pub(super) fn all_sessions_idle(instances: &[crate::types::Instance]) -> bool {
    instances
        .iter()
        .filter(|i| holds_this_machine_awake(i))
        .all(instance_is_idle)
}

/// A live session hosted on THIS machine. A row mirrored from a paired peer
/// (`machine` set) keeps running when this machine sleeps, so it never holds
/// the countdown back.
pub(super) fn holds_this_machine_awake(i: &crate::types::Instance) -> bool {
    i.ended_at.is_none() && i.machine.is_none()
}

/// Session ids still busy, from a `(session_id, busy)` snapshot. Returns exactly
/// the ids whose busy flag is true, in input order; empty when all idle. Pure
/// mirror of the inline `waiting` computation in the Watching loop.
pub(super) fn waiting_on_ids(busy_map: &[(String, bool)]) -> Vec<String> {
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
pub(super) fn next_countdown(remaining: u32) -> Option<u32> {
    if remaining > 0 {
        Some(remaining - 1)
    } else {
        None
    }
}

/// Snapshot of (session_id, in-flight) for live sessions. "In-flight" is
/// `busy` OR `awaiting == "working"` (self-reported background subagents/tasks
/// that will re-invoke the session) - the same non-idle definition as
/// `instance_is_idle`, so the Watching loop's waiting list, its no-progress
/// guard, and the all-idle break all agree.
pub(super) fn live_busy_map(app: &AppHandle) -> Vec<(String, bool)> {
    let state = app.state::<AppState>();
    let guard = state.cached_instances.lock().unwrap();
    guard
        .iter()
        .filter(|i| holds_this_machine_awake(i))
        .map(|i| (i.session_id.clone(), !instance_is_idle(i)))
        .collect()
}

#[cfg(test)]
#[path = "idle_tests.rs"]
mod tests;
