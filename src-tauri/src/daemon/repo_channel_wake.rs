//! Repo-channel wake queue: the delivery half of the inter-agent coordination
//! channel (`sessions::repo_channel` + `daemon::methods::channel`). Mirrors
//! `daemon::jarvis_wake` exactly - queue-and-drain, a single coalesced
//! `is_meta` injected turn, delivered only once the target session is idle
//! (the daemon has no turn queue; writing into a busy child's stdin is
//! undefined behavior) - but keyed by ANY live session id, not just a Jarvis
//! singleton, since every session (not only Jarvis workers) can now receive a
//! coordination nudge.

use crate::daemon::lifecycle;
use crate::daemon::state::DaemonState;
use std::sync::Arc;

/// Queue one wake line for `target_session_id`. Delivery-agnostic - callers
/// pair this with [`spawn_drain`] right after so a wake fires as soon as
/// possible, but `drain` alone decides when it's actually safe to write into
/// the target's stdin.
pub fn enqueue(state: &Arc<DaemonState>, target_session_id: &str, line: String) {
    state
        .repo_channel_wakes
        .lock()
        .unwrap()
        .entry(target_session_id.to_string())
        .or_default()
        .push_back(line);
}

/// Deliver everything queued for `target_session_id` as ONE coalesced,
/// newline-joined, `is_meta`-marked message, IFF the session is a still-live
/// registry entry and isn't mid-turn. Otherwise a no-op that leaves the queue
/// standing for the next drain trigger (the next `post_message` call, or this
/// session's own turn ending - see `pump.rs`'s unconditional drain-on-idle
/// call).
///
/// On a send failure the drained lines are pushed back onto the front of the
/// queue (in original order) so a transient respawn failure doesn't silently
/// lose a wake - the next trigger retries the same coalesced batch.
pub async fn drain(state: &Arc<DaemonState>, target_session_id: &str) {
    let Some(inst) = state.registry.get(target_session_id) else { return };
    if inst.ended_at.is_some() || inst.busy {
        return;
    }
    let lines: Vec<String> = {
        let mut queues = state.repo_channel_wakes.lock().unwrap();
        match queues.get_mut(target_session_id) {
            Some(pending) if !pending.is_empty() => pending.drain(..).collect(),
            _ => return,
        }
    };
    let combined = lines.join("\n");
    match lifecycle::send_message_with_respawn(state, target_session_id, &combined, true).await {
        Ok(()) => {
            state.registry.set_awaiting(target_session_id, None);
            state.registry.set_busy(target_session_id, true);
            state.notifier.publish(
                "instances_changed",
                serde_json::json!({"instances": state.registry.list()}),
            );
        }
        Err(e) => {
            log::warn!("repo_channel_wake: failed to deliver wake to {target_session_id}: {e}");
            let mut queues = state.repo_channel_wakes.lock().unwrap();
            let pending = queues.entry(target_session_id.to_string()).or_default();
            for line in lines.into_iter().rev() {
                pending.push_front(line);
            }
        }
    }
}

/// Same as [`drain`], but dispatched as a detached `tokio::spawn` task
/// instead of awaited inline - required for the callsite inside
/// `pump::run_stdout_pump` (see `jarvis_wake::spawn_drain`'s doc for the
/// Send-cycle this avoids; identical reasoning applies here since `drain` can
/// loop back into `spawn_session` on a respawn). RPC/hook-server callers
/// (`daemon::methods::channel::post_message`, never inside the pump) also use
/// this form so posting a message never blocks on delivering it.
pub fn spawn_drain(state: &Arc<DaemonState>, target_session_id: &str) {
    let state = state.clone();
    let target_session_id = target_session_id.to_string();
    tokio::spawn(async move {
        drain(&state, &target_session_id).await;
    });
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
        enqueue(&state, "s1", "line one".into());
        enqueue(&state, "s1", "line two".into());
        let queues = state.repo_channel_wakes.lock().unwrap();
        let pending = queues.get("s1").expect("queue exists");
        assert_eq!(pending.len(), 2);
        assert_eq!(pending.iter().cloned().collect::<Vec<_>>(), vec!["line one", "line two"]);
    }

    #[tokio::test]
    async fn drain_no_ops_when_target_is_busy() {
        // No live ChildStdin exists in this test, so a successful drain would
        // panic trying to write to it - exactly why the busy guard must
        // short-circuit before ever reaching send_message_with_respawn.
        let state = test_state();
        state.registry.upsert_interactive("s1", std::path::Path::new("."), "proj-1", "2026-07-30T00:00:00Z");
        state.registry.set_busy("s1", true);
        enqueue(&state, "s1", "peer note".into());

        drain(&state, "s1").await;

        let queues = state.repo_channel_wakes.lock().unwrap();
        assert_eq!(
            queues.get("s1").map(|q| q.len()).unwrap_or(0),
            1,
            "busy target must leave the queue standing for the next drain trigger"
        );
    }

    #[tokio::test]
    async fn drain_no_ops_when_target_session_unknown() {
        let state = test_state();
        enqueue(&state, "ghost", "peer note".into());
        drain(&state, "ghost").await;
        let queues = state.repo_channel_wakes.lock().unwrap();
        assert_eq!(queues.get("ghost").map(|q| q.len()).unwrap_or(0), 1);
    }
}
