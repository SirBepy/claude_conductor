//! Repo-channel wake queue: the delivery half of the inter-agent coordination
//! channel (`sessions::repo_channel` + `daemon::methods::channel`). Mirrors
//! `daemon::jarvis_wake` exactly - queue-and-drain, a single coalesced
//! `is_meta` injected turn, delivered only once the target session is idle
//! (the daemon has no turn queue; writing into a busy child's stdin is
//! undefined behavior) - but keyed by ANY live session id, not just a Jarvis
//! singleton, since every session (not only Jarvis workers) can now receive a
//! coordination nudge.
//!
//! This is a SEPARATE queue from `jarvis_wakes`, not a shared one, so in
//! principle a session with entries pending in both could receive two
//! separate injected turns at the same idle moment instead of one coalesced
//! message. Not reachable today: `jarvis_wakes` is only ever keyed by the
//! Jarvis singleton's own session id (populated by wake-on-worker-blocked /
//! worker-terminal-wake, which always target the ORCHESTRATOR, never a
//! worker), and the singleton runs in its own dedicated `jarvis-home`
//! directory/project - it never shares a `project_id` with the sessions
//! `post_message` can target, so it can never actually be enqueued into both
//! queues at once. If a future feature ever let Jarvis participate as an
//! ordinary repo-channel peer, this invariant would need re-checking (either
//! merge the two queues, or drain both from one call site).

use crate::daemon::lifecycle;
use crate::daemon::state::DaemonState;
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// Held between a wake being queued and it being delivered. `drain` already
/// coalesces whatever is queued at delivery time, but with no window a peer
/// that replies fast gets one solo wake per post; 3s swallows a burst of
/// back-to-back coordination notes without stalling an urgent one (todo 698).
pub const IDLE_COALESCE_WINDOW: Duration = Duration::from_secs(3);

/// Cap on queued-but-undelivered lines per target session. Unlike
/// `jarvis_wake` (whose queue only ever fills from a bounded set of worker
/// terminal-state events), this queue is fed by `post_message`, which any
/// live peer can call at will - a target that never goes idle (or a peer that
/// posts in a tight loop) must not grow this queue without bound. Oldest
/// lines are dropped first: a stale coordination note is worse than useless
/// once several newer ones have queued up behind it.
const MAX_QUEUED_LINES: usize = 50;

/// One queued wake line paired with the sender's session id (todo 743), so a
/// drained batch can still attribute the coalesced wire message to a sender
/// after `drain` joins multiple lines together.
#[derive(Debug, Clone)]
pub struct QueuedLine {
    pub author_session_id: String,
    pub text: String,
}

/// Own type rather than reusing `jarvis_wake::WakeQueue` (todo 743): this
/// queue carries a sender id per line, jarvis's doesn't.
pub type WakeQueue = Mutex<HashMap<String, VecDeque<QueuedLine>>>;

pub fn new_queue() -> WakeQueue {
    Mutex::new(HashMap::new())
}

/// Queue one wake line for `target_session_id`, dropping the oldest queued
/// line first if this would exceed [`MAX_QUEUED_LINES`]. Delivery-agnostic -
/// callers pair this with [`spawn_drain`] right after so a wake fires as soon
/// as possible, but `drain` alone decides when it's actually safe to write
/// into the target's stdin.
pub fn enqueue(state: &Arc<DaemonState>, target_session_id: &str, author_session_id: &str, text: String) {
    let mut queues = state.repo_channel_wakes.lock().unwrap();
    let pending = queues.entry(target_session_id.to_string()).or_default();
    if pending.len() >= MAX_QUEUED_LINES {
        pending.pop_front();
    }
    pending.push_back(QueuedLine { author_session_id: author_session_id.to_string(), text });
}

/// Delivers everything queued for `target_session_id` if idle, else a no-op
/// that leaves the queue for the next trigger. Same-sender lines still
/// coalesce into one message; distinct senders each get their own message
/// (todo 766). Undelivered lines are pushed back to the queue on failure.
pub async fn drain(state: &Arc<DaemonState>, target_session_id: &str) {
    drain_with(state, target_session_id, |text, author| async move {
        lifecycle::send_message_with_respawn_meta_and_author(state, target_session_id, &text, &author).await
    })
    .await;
}

/// [`drain`] with the child-stdin write injected, so the queue/coalescing
/// logic is exercisable without a live session. `send` is `Fn`, not
/// `FnOnce`: a multi-sender batch calls it once per sender group.
async fn drain_with<F, Fut, E>(state: &Arc<DaemonState>, target_session_id: &str, send: F)
where
    F: Fn(String, String) -> Fut,
    Fut: std::future::Future<Output = Result<(), E>>,
    E: std::fmt::Display,
{
    let Some(inst) = state.registry.get(target_session_id) else { return };
    if inst.ended_at.is_some() || inst.busy {
        return;
    }
    let lines: Vec<QueuedLine> = {
        let mut queues = state.repo_channel_wakes.lock().unwrap();
        match queues.get_mut(target_session_id) {
            Some(pending) if !pending.is_empty() => pending.drain(..).collect(),
            _ => return,
        }
    };
    // First-appearance order; one message per sender, not one sentinel for
    // the whole batch (todo 766).
    let mut groups: Vec<(String, Vec<&str>)> = Vec::new();
    for line in &lines {
        match groups.iter_mut().find(|(author, _)| *author == line.author_session_id) {
            Some((_, texts)) => texts.push(line.text.as_str()),
            None => groups.push((line.author_session_id.clone(), vec![line.text.as_str()])),
        }
    }
    let mut delivered: HashSet<String> = HashSet::new();
    let mut failed = false;
    for (author, texts) in groups {
        let combined = texts.join("\n");
        match send(combined, author.clone()).await {
            Ok(()) => {
                delivered.insert(author);
            }
            Err(e) => {
                log::warn!("repo_channel_wake: failed to deliver wake to {target_session_id}: {e}");
                failed = true;
                break;
            }
        }
    }
    if !delivered.is_empty() {
        state.registry.set_awaiting(target_session_id, None);
        state.registry.set_busy_from_wake(target_session_id);
        crate::sessions::chat_state::set_busy(target_session_id, true);
        state.notifier.publish(
            "instances_changed",
            serde_json::json!({"instances": state.registry.list()}),
        );
    }
    if failed {
        let mut queues = state.repo_channel_wakes.lock().unwrap();
        let pending = queues.entry(target_session_id.to_string()).or_default();
        for line in lines.into_iter().rev() {
            if !delivered.contains(&line.author_session_id) {
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
///
/// Waits out [`IDLE_COALESCE_WINDOW`] first: without it a peer that is already
/// idle takes one full injected turn per post, which is what todo 698 measured
/// at ~20k wasted tokens over seven near-identical wakes.
pub fn spawn_drain(state: &Arc<DaemonState>, target_session_id: &str) {
    let state = state.clone();
    let target_session_id = target_session_id.to_string();
    tokio::spawn(async move {
        tokio::time::sleep(IDLE_COALESCE_WINDOW).await;
        drain(&state, &target_session_id).await;
    });
}

/// Resolve `post_message`'s caller-supplied `target` to the ids to wake;
/// `None`/empty broadcasts to the sender's live project peers as before.
/// SECURITY: naming an id is a capability to wake it, so an unknown, ended,
/// self or cross-project id errors out instead of falling back to broadcast.
pub fn resolve_targets(
    state: &Arc<DaemonState>,
    sender_session_id: &str,
    targets: Option<&[String]>,
) -> Result<Vec<String>, String> {
    let sender = state
        .registry
        .get(sender_session_id)
        .ok_or_else(|| format!("unknown session: {sender_session_id}"))?;
    let named: &[String] = match targets {
        Some(t) if !t.is_empty() => t,
        _ => {
            return Ok(state
                .registry
                .by_project(&sender.project_id)
                .into_iter()
                .filter(|i| i.session_id != sender_session_id && i.ended_at.is_none())
                .map(|i| i.session_id)
                .collect())
        }
    };
    let mut resolved: Vec<String> = Vec::with_capacity(named.len());
    for raw in named {
        let id = raw.trim();
        if id == sender_session_id {
            return Err("cannot target your own session".to_string());
        }
        let inst = state
            .registry
            .get(id)
            .ok_or_else(|| format!("unknown target session: {id}"))?;
        if inst.ended_at.is_some() {
            return Err(format!("target session has already ended: {id}"));
        }
        if inst.project_id != sender.project_id {
            return Err(format!("target session is in another project: {id}"));
        }
        if !resolved.iter().any(|seen| seen == id) {
            resolved.push(id.to_string());
        }
    }
    Ok(resolved)
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
        enqueue(&state, "s1", "peer-1", "line one".into());
        enqueue(&state, "s1", "peer-1", "line two".into());
        let queues = state.repo_channel_wakes.lock().unwrap();
        let pending = queues.get("s1").expect("queue exists");
        assert_eq!(pending.len(), 2);
        assert_eq!(
            pending.iter().map(|l| l.text.as_str()).collect::<Vec<_>>(),
            vec!["line one", "line two"]
        );
    }

    #[test]
    fn enqueue_caps_queue_depth_dropping_oldest_first() {
        // A target that never goes idle (or a peer posting in a tight loop)
        // must not grow this queue without bound.
        let state = test_state();
        for i in 0..MAX_QUEUED_LINES + 10 {
            enqueue(&state, "s1", "peer-1", format!("line {i}"));
        }
        let queues = state.repo_channel_wakes.lock().unwrap();
        let pending = queues.get("s1").expect("queue exists");
        assert_eq!(pending.len(), MAX_QUEUED_LINES);
        assert_eq!(pending[0].text, "line 10", "oldest 10 must have been dropped");
        assert_eq!(pending[MAX_QUEUED_LINES - 1].text, format!("line {}", MAX_QUEUED_LINES + 9));
    }

    #[tokio::test]
    async fn drain_no_ops_when_target_is_busy() {
        // No live ChildStdin exists in this test, so a successful drain would
        // panic trying to write to it - exactly why the busy guard must
        // short-circuit before ever reaching send_message_with_respawn.
        let state = test_state();
        state.registry.upsert_interactive("s1", std::path::Path::new("."), "proj-1", "2026-07-30T00:00:00Z");
        state.registry.set_busy("s1", true);
        enqueue(&state, "s1", "peer-1", "peer note".into());

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
        enqueue(&state, "ghost", "peer-1", "peer note".into());
        drain(&state, "ghost").await;
        let queues = state.repo_channel_wakes.lock().unwrap();
        assert_eq!(queues.get("ghost").map(|q| q.len()).unwrap_or(0), 1);
    }

    fn live(state: &Arc<DaemonState>, id: &str, project: &str) {
        state.registry.upsert_interactive(id, std::path::Path::new("."), project, "2026-07-30T00:00:00Z");
    }

    #[tokio::test(start_paused = true)]
    async fn near_simultaneous_idle_posts_coalesce_into_one_wake() {
        // The content assertion is the proof, not the count: without the
        // window the first drain fires immediately and delivers "first" alone.
        let state = test_state();
        live(&state, "s1", "proj-1");
        let sent: Arc<std::sync::Mutex<Vec<(String, String)>>> = Arc::new(std::sync::Mutex::new(Vec::new()));

        // Mirrors spawn_drain's body with the child-stdin write recorded instead.
        let wake = |state: Arc<DaemonState>, sent: Arc<std::sync::Mutex<Vec<(String, String)>>>| async move {
            tokio::time::sleep(IDLE_COALESCE_WINDOW).await;
            drain_with(&state, "s1", |text, author| {
                let sent = sent.clone();
                async move {
                    sent.lock().unwrap().push((text, author));
                    Ok::<(), String>(())
                }
            })
            .await;
        };

        enqueue(&state, "s1", "peer-a", "first".into());
        let h1 = tokio::spawn(wake(state.clone(), sent.clone()));
        tokio::time::sleep(Duration::from_millis(500)).await;
        enqueue(&state, "s1", "peer-a", "second".into());
        let h2 = tokio::spawn(wake(state.clone(), sent.clone()));
        h1.await.unwrap();
        h2.await.unwrap();

        let sent = sent.lock().unwrap();
        assert_eq!(sent.len(), 1, "two same-sender posts inside the window must produce one wake");
        assert_eq!(sent[0].0, "first\nsecond");
        assert_eq!(sent[0].1, "peer-a");
    }

    #[tokio::test(start_paused = true)]
    async fn near_simultaneous_idle_posts_from_distinct_senders_attribute_separately() {
        let state = test_state();
        live(&state, "s1", "proj-1");
        let sent: Arc<std::sync::Mutex<Vec<(String, String)>>> = Arc::new(std::sync::Mutex::new(Vec::new()));

        let wake = |state: Arc<DaemonState>, sent: Arc<std::sync::Mutex<Vec<(String, String)>>>| async move {
            tokio::time::sleep(IDLE_COALESCE_WINDOW).await;
            drain_with(&state, "s1", |text, author| {
                let sent = sent.clone();
                async move {
                    sent.lock().unwrap().push((text, author));
                    Ok::<(), String>(())
                }
            })
            .await;
        };

        enqueue(&state, "s1", "peer-a", "first".into());
        let h1 = tokio::spawn(wake(state.clone(), sent.clone()));
        tokio::time::sleep(Duration::from_millis(500)).await;
        enqueue(&state, "s1", "peer-b", "second".into());
        let h2 = tokio::spawn(wake(state.clone(), sent.clone()));
        h1.await.unwrap();
        h2.await.unwrap();

        let sent = sent.lock().unwrap();
        assert_eq!(sent.len(), 2, "distinct senders must not collapse into one wake");
        assert_eq!(sent[0], ("first".to_string(), "peer-a".to_string()));
        assert_eq!(sent[1], ("second".to_string(), "peer-b".to_string()));
    }

    #[test]
    fn resolve_targets_without_a_target_broadcasts_to_live_project_peers() {
        let state = test_state();
        live(&state, "s1", "proj-1");
        live(&state, "s2", "proj-1");
        live(&state, "s3", "proj-1");
        live(&state, "s4", "proj-2");
        state.registry.mark_ended("s3", crate::types::EndReason::Manual, "2026-07-30T00:00:01Z");

        let mut ids = resolve_targets(&state, "s1", None).unwrap();
        ids.sort();
        assert_eq!(ids, vec!["s2"], "not self, not ended, not another project");
        assert_eq!(resolve_targets(&state, "s1", Some(&[])).unwrap(), vec!["s2".to_string()]);
    }

    #[test]
    fn resolve_targets_returns_only_the_named_session() {
        let state = test_state();
        live(&state, "s1", "proj-1");
        live(&state, "s2", "proj-1");
        live(&state, "s3", "proj-1");

        let ids = resolve_targets(&state, "s1", Some(&["s3".to_string()])).unwrap();
        assert_eq!(ids, vec!["s3".to_string()], "s2 must not be woken");
    }

    #[test]
    fn resolve_targets_rejects_an_unknown_id() {
        let state = test_state();
        live(&state, "s1", "proj-1");
        live(&state, "s2", "proj-1");
        let r = resolve_targets(&state, "s1", Some(&["typo".to_string()]));
        assert_eq!(r, Err("unknown target session: typo".to_string()));
    }

    #[test]
    fn resolve_targets_rejects_an_ended_id() {
        let state = test_state();
        live(&state, "s1", "proj-1");
        live(&state, "s2", "proj-1");
        state.registry.mark_ended("s2", crate::types::EndReason::Manual, "2026-07-30T00:00:01Z");
        let r = resolve_targets(&state, "s1", Some(&["s2".to_string()]));
        assert_eq!(r, Err("target session has already ended: s2".to_string()));
    }

    #[test]
    fn resolve_targets_rejects_a_cross_project_id() {
        let state = test_state();
        live(&state, "s1", "proj-1");
        live(&state, "s9", "proj-2");
        let r = resolve_targets(&state, "s1", Some(&["s9".to_string()]));
        assert_eq!(r, Err("target session is in another project: s9".to_string()));
    }

    #[test]
    fn resolve_targets_rejects_targeting_yourself() {
        let state = test_state();
        live(&state, "s1", "proj-1");
        let r = resolve_targets(&state, "s1", Some(&["s1".to_string()]));
        assert_eq!(r, Err("cannot target your own session".to_string()));
    }

    #[test]
    fn resolve_targets_rejects_an_unknown_sender() {
        let state = test_state();
        let r = resolve_targets(&state, "ghost", None);
        assert_eq!(r, Err("unknown session: ghost".to_string()));
    }

    #[test]
    fn resolve_targets_dedupes_a_repeated_id() {
        let state = test_state();
        live(&state, "s1", "proj-1");
        live(&state, "s2", "proj-1");
        let ids = resolve_targets(&state, "s1", Some(&["s2".to_string(), " s2 ".to_string()])).unwrap();
        assert_eq!(ids, vec!["s2".to_string()]);
    }
}
