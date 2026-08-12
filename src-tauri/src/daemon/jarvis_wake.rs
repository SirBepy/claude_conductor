//! Jarvis wake queue (todo 272 chunk 3): the ONE sanctioned way anything
//! writes into the Jarvis singleton's stdin outside its own direct user
//! turns. Worker turn-terminal states, worker prompts blocked on Joe, and
//! Joe messaging a worker directly all `enqueue` a one-line note and call
//! `drain`, which coalesces everything still queued into a single
//! `is_meta`-marked injected turn the instant Jarvis is idle - never mid-turn,
//! since the daemon has no turn queue and writing into a busy child's stdin is
//! undefined behavior (the same rule `methods::jarvis::send_to_session`
//! enforces for worker targets).
//!
//! Keyed by jarvis session id rather than a bare singleton: todo 272 only
//! ever populates one key (`Settings.jarvis_session_id`), but nothing here
//! assumes there is exactly one, so a future multi-Jarvis daemon doesn't need
//! a data-shape change.

use crate::daemon::lifecycle;
use crate::daemon::state::DaemonState;
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};

pub type WakeQueue = Mutex<HashMap<String, VecDeque<String>>>;

pub fn new_queue() -> WakeQueue {
    Mutex::new(HashMap::new())
}

/// Queue one wake line for `jarvis_session_id`. Delivery-agnostic - callers
/// pair this with a `drain` call right after so a wake fires as soon as
/// possible, but `drain` alone is what actually decides when it's safe to
/// write into Jarvis's stdin.
pub fn enqueue(state: &Arc<DaemonState>, jarvis_session_id: &str, line: String) {
    state
        .jarvis_wakes
        .lock()
        .unwrap()
        .entry(jarvis_session_id.to_string())
        .or_default()
        .push_back(line);
}

/// Deliver everything queued for `jarvis_session_id` as ONE coalesced,
/// newline-joined, `is_meta`-marked message, IFF the session is a still-live
/// registry entry and isn't mid-turn. Otherwise a no-op that leaves the queue
/// standing for the next drain trigger (the next worker terminal state, or
/// Jarvis's own turn ending - see `pump.rs`'s drain-on-jarvis-idle hook).
///
/// On a send failure the drained lines are pushed back onto the front of the
/// queue (in original order) so a transient respawn failure doesn't silently
/// lose a wake - the next trigger retries the same coalesced batch.
pub async fn drain(state: &Arc<DaemonState>, jarvis_session_id: &str) {
    let Some(inst) = state.registry.get(jarvis_session_id) else { return };
    if inst.ended_at.is_some() || inst.busy {
        return;
    }
    let lines: Vec<String> = {
        let mut queues = state.jarvis_wakes.lock().unwrap();
        match queues.get_mut(jarvis_session_id) {
            Some(pending) if !pending.is_empty() => pending.drain(..).collect(),
            _ => return,
        }
    };
    let combined = lines.join("\n");
    match lifecycle::send_message_with_respawn(state, jarvis_session_id, &combined, true).await {
        Ok(()) => {
            state.registry.set_awaiting(jarvis_session_id, None);
            state.registry.set_busy_from_wake(jarvis_session_id);
            crate::sessions::chat_state::set_busy(jarvis_session_id, true);
            state.notifier.publish(
                "instances_changed",
                serde_json::json!({"instances": state.registry.list()}),
            );
        }
        Err(e) => {
            log::warn!("jarvis_wake: failed to deliver wake to {jarvis_session_id}: {e}");
            let mut queues = state.jarvis_wakes.lock().unwrap();
            let pending = queues.entry(jarvis_session_id.to_string()).or_default();
            for line in lines.into_iter().rev() {
                pending.push_front(line);
            }
        }
    }
}

/// Same as [`drain`], but dispatched as a detached `tokio::spawn` task
/// instead of awaited inline. Required for callers living inside
/// `pump::run_stdout_pump`: that task is itself spawned from inside
/// `lifecycle::spawn_session`, so an inline `.await` on a path that can loop
/// back into `spawn_session` (via `send_message_with_respawn`'s respawn
/// branch, when Jarvis's per-turn process has already exited) makes
/// `run_stdout_pump`'s future structurally embed `spawn_session`'s own future
/// in its state machine - a cycle the compiler's `Send` auto-trait inference
/// can't resolve ("future cannot be sent between threads safely"). Detaching
/// via `tokio::spawn` breaks that cycle. RPC/hook-server callers (which never
/// run inside the pump) can call `drain` directly.
pub fn spawn_drain(state: &Arc<DaemonState>, jarvis_session_id: &str) {
    let state = state.clone();
    let jarvis_session_id = jarvis_session_id.to_string();
    tokio::spawn(async move {
        drain(&state, &jarvis_session_id).await;
    });
}

/// Terminal `awaiting` values worth interrupting Jarvis's `fleet_status` poll
/// for. "working" (background tasks still running) is deliberately excluded -
/// the worker isn't actually stopped yet, so there's nothing new to report.
fn is_wake_worthy(awaiting: Option<&str>) -> bool {
    matches!(awaiting, Some("done") | Some("question") | Some("waiting"))
}

/// Decides + formats the one-line wake `pump.rs` enqueues when a session's
/// turn goes terminal (called right after `registry::set_awaiting_if_gen`).
/// Pulled out of the pump loop into a pure function so it's unit-testable
/// without a live `ChildStdin` - `pump.rs` has no existing test scaffold for
/// that reason (see its "Real send_message requires a live ChildStdin"
/// comment in `lifecycle.rs`'s tests). Returns `None` (nothing to enqueue)
/// when `worker_of` is unset (an ordinary session, or Jarvis itself - workers
/// are the only sessions this wake applies to) or `awaiting` isn't
/// [`is_wake_worthy`]. Returns `Some((jarvis_session_id, wake_line))`
/// otherwise, ready to hand straight to `enqueue` + `spawn_drain`.
pub fn worker_terminal_wake(
    worker_of: Option<&str>,
    session_id: &str,
    display_name: &str,
    awaiting: Option<&str>,
) -> Option<(String, String)> {
    let jarvis_id = worker_of?;
    if !is_wake_worthy(awaiting) {
        return None;
    }
    Some((
        jarvis_id.to_string(),
        format!("[fleet] worker \"{display_name}\" ({session_id}) -> {}", awaiting.unwrap_or("")),
    ))
}

/// Shared by every hook-server prompt endpoint that already calls
/// `DaemonState::fire_blocked_prompt`: if the prompt's owning session is one
/// of a Jarvis's workers, wake that Jarvis too. `kind` is an optional,
/// purely cosmetic label (tool name, or "question") folded into the wake
/// line when the caller has one handy.
pub async fn wake_on_worker_blocked(
    state: &Arc<DaemonState>,
    session_id: Option<&str>,
    request_id: &str,
    kind: Option<&str>,
) {
    let Some(sid) = session_id else { return };
    let Some(inst) = state.registry.get(sid) else { return };
    let Some(jarvis_id) = inst.worker_of.clone() else { return };
    let display_name = inst.name.clone().unwrap_or_else(|| sid.to_string());
    let suffix = kind.map(|k| format!(" ({k})")).unwrap_or_default();
    enqueue(
        state,
        &jarvis_id,
        format!("[fleet] worker \"{display_name}\" ({sid}) blocked on prompt {request_id}{suffix}"),
    );
    drain(state, &jarvis_id).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::types::Settings;

    fn test_state() -> Arc<DaemonState> {
        DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()))
    }

    #[test]
    fn enqueue_coalesces_multiple_lines_for_one_drain() {
        let state = test_state();
        enqueue(&state, "jv-1", "line one".into());
        enqueue(&state, "jv-1", "line two".into());
        let queues = state.jarvis_wakes.lock().unwrap();
        let pending = queues.get("jv-1").expect("queue exists");
        assert_eq!(pending.len(), 2, "both lines queued for the same coalesced send");
        assert_eq!(pending.iter().cloned().collect::<Vec<_>>(), vec!["line one", "line two"]);
    }

    #[tokio::test]
    async fn drain_no_ops_when_jarvis_is_busy() {
        // No live ChildStdin exists in this test, so a successful drain would
        // panic trying to write to it - which is exactly why the busy guard
        // must short-circuit before ever reaching send_message_with_respawn.
        let state = test_state();
        state.registry.upsert_interactive("jv-1", std::path::Path::new("."), "proj-1", "2026-07-27T00:00:00Z");
        state.registry.set_busy("jv-1", true);
        enqueue(&state, "jv-1", "worker done".into());

        drain(&state, "jv-1").await;

        let queues = state.jarvis_wakes.lock().unwrap();
        assert_eq!(
            queues.get("jv-1").map(|q| q.len()).unwrap_or(0),
            1,
            "busy jarvis must leave the queue standing for the next drain trigger"
        );
    }

    #[tokio::test]
    async fn drain_no_ops_when_jarvis_session_unknown() {
        let state = test_state();
        enqueue(&state, "ghost-jarvis", "worker done".into());
        // Must not panic / must not attempt a respawn for an id the registry
        // has never heard of.
        drain(&state, "ghost-jarvis").await;
        let queues = state.jarvis_wakes.lock().unwrap();
        assert_eq!(queues.get("ghost-jarvis").map(|q| q.len()).unwrap_or(0), 1);
    }

    #[tokio::test]
    async fn wake_on_worker_blocked_no_ops_for_non_worker_session() {
        let state = test_state();
        state.registry.upsert_interactive("s1", std::path::Path::new("."), "proj-1", "2026-07-27T00:00:00Z");
        // s1 has no worker_of set - an ordinary session's blocked prompt must
        // never enqueue a Jarvis wake.
        wake_on_worker_blocked(&state, Some("s1"), "req-1", Some("Bash")).await;
        let queues = state.jarvis_wakes.lock().unwrap();
        assert!(queues.is_empty(), "no wake should be queued for a non-worker session");
    }

    #[tokio::test]
    async fn wake_on_worker_blocked_enqueues_for_a_worker_session() {
        let state = test_state();
        state.registry.upsert_interactive("jv-1", std::path::Path::new("."), "proj-1", "2026-07-27T00:00:00Z");
        state.registry.set_busy("jv-1", true); // keep drain a no-op so we can inspect the queue
        state.registry.upsert_interactive("w1", std::path::Path::new("."), "proj-1", "2026-07-27T00:00:00Z");
        state.registry.set_worker_of("w1", Some("jv-1".to_string()));

        wake_on_worker_blocked(&state, Some("w1"), "req-1", Some("Bash")).await;

        let queues = state.jarvis_wakes.lock().unwrap();
        let pending = queues.get("jv-1").expect("wake queued for jv-1");
        assert_eq!(pending.len(), 1);
        assert!(pending[0].contains("blocked on prompt req-1"), "{}", pending[0]);
        assert!(pending[0].contains("(Bash)"), "{}", pending[0]);
    }

    #[test]
    fn worker_terminal_wake_fires_for_done_question_and_waiting() {
        for state in ["done", "question", "waiting"] {
            let (jarvis_id, line) = worker_terminal_wake(Some("jv-1"), "w1", "Fixer", Some(state))
                .unwrap_or_else(|| panic!("must enqueue a wake for awaiting={state:?}"));
            assert_eq!(jarvis_id, "jv-1");
            assert!(line.contains("worker \"Fixer\" (w1)"), "{line}");
            assert!(line.ends_with(state), "{line}");
        }
    }

    #[test]
    fn worker_terminal_wake_skips_working() {
        // A worker still running background tasks has nothing new to report -
        // must not enqueue (and must not spawn_drain, which pump.rs skips
        // entirely on a None return).
        assert_eq!(worker_terminal_wake(Some("jv-1"), "w1", "Fixer", Some("working")), None);
    }

    #[test]
    fn worker_terminal_wake_skips_non_worker_sessions() {
        // No worker_of at all (an ordinary session, or Jarvis itself) - never
        // a wake, even for an otherwise wake-worthy awaiting value.
        assert_eq!(worker_terminal_wake(None, "s1", "Some Chat", Some("done")), None);
    }
}
