//! Inter-agent coordination tools: `list_peers` (who else is active in this
//! session's project right now), `post_message` (a short note to every OTHER
//! live session in the project, or to caller-named target ids only, see
//! `repo_channel_wake::resolve_targets`), `read_messages` (recent history for
//! this project). Unlike the Jarvis fleet tools, these are
//! advertised UNCONDITIONALLY in `mcp::server`'s `tools/list` - any session
//! should be able to coordinate, not just a Jarvis worker - so there's no
//! privileged-caller re-validation here, just "does `session_id` resolve to a
//! live registry entry", the same trust level as any other MCP tool call
//! riding that session's own `CC_SESSION_ID` env.
//!
//! Complements, doesn't replace, `hooks_server::commit_lock`: that mutex only
//! serializes the instant `git commit` itself runs; this channel covers the
//! much longer editing window before a commit, where the actual collision
//! risk lives.

use crate::daemon::repo_channel_wake;
use crate::daemon::state::DaemonState;
use crate::sessions::repo_channel;
use serde_json::{json, Value};
use std::sync::Arc;

/// Resolves the calling session's own `project_id`, straight off the
/// registry entry created at session start - no separate `cwd` argument is
/// ever taken from the caller, so a confused/compromised turn can't query or
/// post into a repo it isn't actually running in.
pub(super) fn caller_project(state: &Arc<DaemonState>, session_id: &str) -> Result<String, String> {
    state
        .registry
        .get(session_id)
        .map(|i| i.project_id)
        .ok_or_else(|| format!("unknown session: {session_id}"))
}

pub(super) fn display_name(state: &Arc<DaemonState>, session_id: &str) -> String {
    state
        .registry
        .get(session_id)
        .and_then(|i| i.name)
        .unwrap_or_else(|| session_id.to_string())
}

/// `list_peers` tool: every OTHER still-live session sharing this project,
/// with enough state (busy/awaiting) to judge whether it's safe to interrupt.
pub(crate) fn list_peers(state: &Arc<DaemonState>, session_id: &str) -> Result<Value, String> {
    let project_id = caller_project(state, session_id)?;
    let peers: Vec<Value> = state
        .registry
        .by_project(&project_id)
        .into_iter()
        .filter(|i| i.session_id != session_id && i.ended_at.is_none())
        .map(|i| {
            json!({
                "session_id": i.session_id,
                "name": i.name,
                "busy": i.busy,
                "awaiting": i.awaiting,
                // Provenance (todo 503): lets a caller judge how much trust
                // a peer's claims deserve. `kind` is spawn origin, NOT
                // `is_remote` (that's transport) - never conflate the two.
                "pid": i.pid,
                "kind": i.kind,
                "cwd": i.cwd,
            })
        })
        .collect();
    Ok(json!({"peers": peers}))
}

/// `read_messages` tool: recent coordination-channel history for this
/// project (see `sessions::repo_channel` for retention/ordering).
pub(crate) fn read_messages(state: &Arc<DaemonState>, session_id: &str) -> Result<Value, String> {
    let project_id = caller_project(state, session_id)?;
    let messages = repo_channel::list(&project_id);
    Ok(json!({"messages": messages}))
}

/// `post_message` tool: appends `text` to this project's channel, then wakes
/// either every OTHER live session in the project or, if `target` names ids,
/// only those (see `repo_channel_wake::resolve_targets` for the security
/// rule) - fire-and-forget, never blocks the caller's own turn on delivery.
pub(crate) fn post_message(
    state: &Arc<DaemonState>,
    session_id: &str,
    text: &str,
    target: Option<&[String]>,
) -> Result<Value, String> {
    if text.trim().is_empty() {
        return Err("message text is empty".to_string());
    }
    let project_id = caller_project(state, session_id)?;
    let author = display_name(state, session_id);

    // Resolve BEFORE persisting: a rejected target used to still leave the text
    // in durable channel history, readable by every project member.
    let targets = repo_channel_wake::resolve_targets(state, session_id, target)?;
    let msg = repo_channel::post(&project_id, session_id, &author, text);

    let mut notified = 0usize;
    for target_id in &targets {
        // `msg.text` (already truncated to MAX_TEXT_LEN by `repo_channel::post`
        // above), NOT the raw `text` argument - otherwise the length cap only
        // ever applied to the persisted JSON history, and an unbounded string
        // still landed as a real injected turn in every peer's live session.
        repo_channel_wake::enqueue(
            state,
            target_id,
            format!("[repo-channel] {author}: {}", msg.text),
        );
        repo_channel_wake::spawn_drain(state, target_id);
        notified += 1;
    }
    Ok(json!({"ok": true, "message": msg, "notified": notified}))
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
    fn list_peers_rejects_unknown_caller() {
        let state = test_state();
        let r = list_peers(&state, "ghost");
        assert_eq!(r, Err("unknown session: ghost".to_string()));
    }

    #[test]
    fn list_peers_excludes_self_and_ended_sessions() {
        let state = test_state();
        state.registry.upsert_interactive("s1", std::path::Path::new("."), "proj-1", "2026-07-30T00:00:00Z");
        state.registry.upsert_interactive("s2", std::path::Path::new("."), "proj-1", "2026-07-30T00:00:00Z");
        state.registry.upsert_interactive("s3", std::path::Path::new("."), "proj-1", "2026-07-30T00:00:00Z");
        state.registry.mark_ended("s3", crate::types::EndReason::Manual, "2026-07-30T00:00:01Z");

        let v = list_peers(&state, "s1").unwrap();
        let peers = v["peers"].as_array().unwrap();
        assert_eq!(peers.len(), 1, "only s2 should show up: not self (s1), not ended (s3)");
        assert_eq!(peers[0]["session_id"], "s2");
    }

    #[test]
    fn list_peers_excludes_sessions_in_other_projects() {
        let state = test_state();
        state.registry.upsert_interactive("s1", std::path::Path::new("."), "proj-1", "2026-07-30T00:00:00Z");
        state.registry.upsert_interactive("s2", std::path::Path::new("."), "proj-2", "2026-07-30T00:00:00Z");

        let v = list_peers(&state, "s1").unwrap();
        assert_eq!(v["peers"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn post_message_rejects_empty_text() {
        let state = test_state();
        state.registry.upsert_interactive("s1", std::path::Path::new("."), "proj-1", "2026-07-30T00:00:00Z");
        let r = post_message(&state, "s1", "   ", None);
        assert!(r.is_err());
    }

    #[test]
    fn post_message_rejects_unknown_caller() {
        let state = test_state();
        let r = post_message(&state, "ghost", "hello", None);
        assert_eq!(r, Err("unknown session: ghost".to_string()));
    }

    #[tokio::test]
    async fn post_message_wake_line_uses_truncated_text_not_raw() {
        // Regression: the wake line handed to peers must be built from the
        // returned message's (already-truncated) text, not the caller's raw
        // argument - otherwise MAX_TEXT_LEN only ever capped the persisted
        // JSON history while an unbounded string still landed as a real
        // injected turn in every peer's live session. `post_message` always
        // calls `spawn_drain` (a synchronous `tokio::spawn`) for each
        // notified peer, so this needs a live runtime (`#[tokio::test]`)
        // even though the peer being marked busy makes the spawned task
        // itself a guaranteed no-op - the enqueue this test asserts on
        // happens synchronously, before that task is ever dispatched.
        let state = test_state();
        state.registry.upsert_interactive("s1", std::path::Path::new("."), "proj-1", "2026-07-30T00:00:00Z");
        state.registry.upsert_interactive("s2", std::path::Path::new("."), "proj-1", "2026-07-30T00:00:00Z");
        state.registry.set_busy("s2", true);

        let long = "x".repeat(3000); // exceeds repo_channel::MAX_TEXT_LEN (2000)
        let v = post_message(&state, "s1", &long, None).unwrap();
        assert_eq!(v["notified"], 1);

        let queues = state.repo_channel_wakes.lock().unwrap();
        let pending = queues.get("s2").expect("wake queued for s2");
        assert_eq!(pending.len(), 1);
        // "[repo-channel] {author}: " prefix + at most 2000 chars of text.
        assert!(pending[0].len() < 3000, "wake line must be truncated, was {} bytes", pending[0].len());
    }

    #[tokio::test]
    async fn post_message_notifies_only_other_live_project_peers() {
        // post_message's wake delivery goes through `spawn_drain`, which calls
        // `tokio::spawn` internally - that requires a live Tokio runtime
        // context, hence `#[tokio::test]` here (plain `#[test]` would panic
        // with "no reactor running").
        let state = test_state();
        state.registry.upsert_interactive("s1", std::path::Path::new("."), "proj-1", "2026-07-30T00:00:00Z");
        state.registry.upsert_interactive("s2", std::path::Path::new("."), "proj-1", "2026-07-30T00:00:00Z");
        state.registry.upsert_interactive("s3", std::path::Path::new("."), "proj-2", "2026-07-30T00:00:00Z");

        let v = post_message(&state, "s1", "touching pending-pane.ts, anyone on this?", None).unwrap();
        assert_eq!(v["ok"], true);
        assert_eq!(v["notified"], 1, "only s2 shares proj-1 with the poster");
    }

    #[tokio::test]
    async fn post_message_with_a_target_wakes_only_that_peer() {
        let state = test_state();
        state.registry.upsert_interactive("s1", std::path::Path::new("."), "proj-1", "2026-07-30T00:00:00Z");
        state.registry.upsert_interactive("s2", std::path::Path::new("."), "proj-1", "2026-07-30T00:00:00Z");
        state.registry.upsert_interactive("s3", std::path::Path::new("."), "proj-1", "2026-07-30T00:00:00Z");

        let target = vec!["s3".to_string()];
        let v = post_message(&state, "s1", "for s3 only", Some(&target)).unwrap();
        assert_eq!(v["notified"], 1);

        let queues = state.repo_channel_wakes.lock().unwrap();
        assert!(queues.get("s3").is_some(), "targeted peer must be woken");
        assert!(queues.get("s2").is_none(), "untargeted peer must not be woken");
    }

    #[test]
    fn post_message_with_an_unknown_target_errors_without_broadcasting() {
        let state = test_state();
        state.registry.upsert_interactive("s1", std::path::Path::new("."), "proj-1", "2026-07-30T00:00:00Z");
        state.registry.upsert_interactive("s2", std::path::Path::new("."), "proj-1", "2026-07-30T00:00:00Z");

        let target = vec!["typo".to_string()];
        let r = post_message(&state, "s1", "hello", Some(&target));
        assert_eq!(r, Err("unknown target session: typo".to_string()));

        let queues = state.repo_channel_wakes.lock().unwrap();
        assert!(queues.get("s2").is_none(), "a bad target must never fall back to broadcast");
    }

    #[test]
    fn post_message_with_a_bad_target_leaves_no_trace_in_history() {
        // Its own project id: `repo_channel::list` is process-global and the
        // other tests here post to proj-1, so sharing one would flake.
        let state = test_state();
        let proj = "proj-post-guard";
        state.registry.upsert_interactive("g1", std::path::Path::new("."), proj, "2026-07-30T00:00:00Z");

        let before = repo_channel::list(proj).len();
        let target = vec!["typo".to_string()];
        let r = post_message(&state, "g1", "secret coordination note", Some(&target));
        assert!(r.is_err(), "an unknown target must fail the call");

        // Persisting before validating leaked the text into durable history that
        // every project member can read, while still returning Err to the caller.
        assert_eq!(
            repo_channel::list(proj).len(),
            before,
            "a rejected post must not append to channel history"
        );
    }
}
