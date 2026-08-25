//! Inter-agent coordination tools: `list_peers` (who else is active in this
//! session's project right now), `post_message` (a short note to every OTHER
//! live session in the project, or to caller-named target ids only, see
//! `repo_channel_wake::resolve_targets`), `read_messages` (messages this
//! session hasn't read yet, see `sessions::repo_channel::list_unread`).
//! Unlike the Jarvis fleet tools, these are
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
use crate::settings::identity;
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

/// Human-readable caption for a posting session: a self-reported turn title
/// (`registry.set_name`), NOT a stable identity (todo 733) - two sessions can
/// pick the same title, and it changes mid-run. `short_id` below is what
/// actually correlates two messages from the same session.
fn caption(state: &Arc<DaemonState>, session_id: &str) -> String {
    state
        .registry
        .get(session_id)
        .and_then(|i| i.name)
        .unwrap_or_else(|| session_id.to_string())
}

/// First 4 chars of the session id (a UUIDv4, see `lifecycle::spawn`) - short
/// enough to sit inline in a caption, still enough entropy that two peers in
/// one project collide only by chance. NOT unique on its own; the full
/// `session_id` on `ChannelMessage` remains the actual correlation key.
fn short_id(session_id: &str) -> &str {
    let end = session_id.char_indices().nth(4).map(|(i, _)| i).unwrap_or(session_id.len());
    &session_id[..end]
}

/// The caption a human reads, suffixed with the sender's `short_id` so two
/// messages from the same session can be told apart from two sessions that
/// happened to pick the same turn title (todo 733) - "Title + short stable
/// id", the interim shown until a real avatar surface exists (todo 756).
pub(super) fn display_name(state: &Arc<DaemonState>, session_id: &str) -> String {
    format!("{} ({})", caption(state, session_id), short_id(session_id))
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
            // Worktrees share a project_id with the main checkout (todo 717),
            // so a peer's file claims can be about a different tree entirely.
            let worktree = identity::find_repo_root(&i.cwd).unwrap_or_else(|| i.cwd.clone());
            let branch = identity::current_branch(&worktree);
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
                "worktree": worktree,
                "branch": branch,
            })
        })
        .collect();
    Ok(json!({"peers": peers}))
}

/// `read_messages` tool: messages this session hasn't read yet for its
/// project (see `sessions::repo_channel::list_unread` for the cursor), not
/// the full retained history - repeat calls don't redeliver the same note.
pub(crate) fn read_messages(state: &Arc<DaemonState>, session_id: &str) -> Result<Value, String> {
    let project_id = caller_project(state, session_id)?;
    let messages = repo_channel::list_unread(&project_id, session_id);
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
        // No `[repo-channel] {author}: ` wrapper (todo 743): the sender's
        // identity rides as `author_session_id`, not text a hook could parse.
        repo_channel_wake::enqueue(state, target_id, session_id, msg.text.clone());
        repo_channel_wake::spawn_drain(state, target_id);
        notified += 1;
    }
    // `delivered` (todo 717): a bare `notified: 0` read as "no peers exist"
    // and got reported to the dev as fact. It only ever means the note is a
    // dead drop for a future reader.
    Ok(json!({
        "ok": true,
        "message": msg,
        "notified": notified,
        "delivered": notified > 0,
    }))
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

    /// Test-only mirror of `post_message`'s wiring with `repo_channel::post_at`
    /// substituted for `repo_channel::post`, so notify/deliver bookkeeping is
    /// exercised against a tempdir instead of real app data (todo 757), same
    /// as the retitle test below.
    fn post_message_at(
        state: &Arc<DaemonState>,
        session_id: &str,
        text: &str,
        target: Option<&[String]>,
        path: &std::path::Path,
    ) -> Result<Value, String> {
        let author = display_name(state, session_id);
        let targets = repo_channel_wake::resolve_targets(state, session_id, target)?;
        let msg = repo_channel::post_at(Some(path), session_id, &author, text);

        let mut notified = 0usize;
        for target_id in &targets {
            repo_channel_wake::enqueue(state, target_id, session_id, msg.text.clone());
            repo_channel_wake::spawn_drain(state, target_id);
            notified += 1;
        }
        Ok(json!({
            "ok": true,
            "message": msg,
            "notified": notified,
            "delivered": notified > 0,
        }))
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
    fn list_peers_reports_each_peers_worktree_and_branch() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        std::fs::create_dir_all(repo.join(".git")).unwrap();
        std::fs::write(repo.join(".git").join("HEAD"), "ref: refs/heads/master\n").unwrap();
        let worktree = repo.join(".claude").join("worktrees").join("feature-x");
        std::fs::create_dir_all(worktree.join("src")).unwrap();
        let gitdir = repo.join(".git").join("worktrees").join("feature-x");
        std::fs::create_dir_all(&gitdir).unwrap();
        std::fs::write(worktree.join(".git"), format!("gitdir: {}\n", gitdir.to_string_lossy())).unwrap();
        std::fs::write(gitdir.join("HEAD"), "ref: refs/heads/feature-x\n").unwrap();

        let state = test_state();
        state.registry.upsert_interactive("s1", &repo, "proj-1", "2026-07-30T00:00:00Z");
        // A nested cwd, so the reported worktree must be the tree root.
        state.registry.upsert_interactive("s2", &worktree.join("src"), "proj-1", "2026-07-30T00:00:00Z");

        let v = list_peers(&state, "s1").unwrap();
        let peers = v["peers"].as_array().unwrap();
        assert_eq!(peers.len(), 1);
        assert_eq!(peers[0]["branch"], "feature-x", "peer's own tree branch, not the caller's");
        assert_eq!(
            std::path::PathBuf::from(peers[0]["worktree"].as_str().unwrap()),
            worktree
        );
        // 503's provenance must survive the addition.
        assert_eq!(peers[0]["session_id"], "s2");
        assert!(peers[0].get("pid").is_some());
        assert!(peers[0].get("kind").is_some());
        assert!(peers[0].get("cwd").is_some());
    }

    #[test]
    fn display_name_survives_a_title_change_via_the_stable_session_id() {
        // Todo 733: the caption (turn title) is not a stable identity - it
        // changes as the session works. The short id suffix must not.
        let state = test_state();
        state.registry.upsert_interactive("s1", std::path::Path::new("."), "proj-1", "2026-07-30T00:00:00Z");
        state.registry.set_name("s1", "Building 675 waiting chip".to_string());
        let before = display_name(&state, "s1");

        state.registry.set_name("s1", "Fixing the retitle bug".to_string());
        let after = display_name(&state, "s1");

        assert_ne!(before, after, "caption itself must reflect the retitle");
        assert_eq!(
            short_id("s1"),
            short_id("s1"),
            "short_id is a pure function of session_id, unaffected by set_name"
        );
        assert!(before.ends_with(&format!("({})", short_id("s1"))));
        assert!(after.ends_with(&format!("({})", short_id("s1"))));
    }

    #[test]
    fn post_message_correlates_two_posts_across_a_title_change() {
        // Acceptance test: session_id must match though author differs after
        // a retitle. Uses `repo_channel::post_at`/`list_at` + a tempdir, not
        // `post_message`'s real `%APPDATA%` path (not overridable), or
        // `history.len()` drifts on every repeated run (todo 733).
        let state = test_state();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("proj-733-retitle.json");
        state.registry.upsert_interactive("s1", std::path::Path::new("."), "proj-733-retitle", "2026-07-30T00:00:00Z");
        state.registry.set_name("s1", "Building 675 waiting chip".to_string());

        repo_channel::post_at(Some(&path), "s1", &display_name(&state, "s1"), "about to edit foo.ts");
        state.registry.set_name("s1", "Now doing something else entirely".to_string());
        repo_channel::post_at(Some(&path), "s1", &display_name(&state, "s1"), "done with foo.ts");

        let history = repo_channel::list_at(&path);
        assert_eq!(history.len(), 2);
        assert_eq!(history[0].session_id, history[1].session_id, "same sender, must correlate");
        assert_ne!(history[0].author, history[1].author, "caption changed with the retitle");
        assert!(history[0].author.contains(short_id("s1")), "short id must survive into the caption");
        assert!(history[1].author.contains(short_id("s1")));
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
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("proj-1.json");
        state.registry.upsert_interactive("s1", std::path::Path::new("."), "proj-1", "2026-07-30T00:00:00Z");
        state.registry.upsert_interactive("s2", std::path::Path::new("."), "proj-1", "2026-07-30T00:00:00Z");
        state.registry.set_busy("s2", true);

        let long = "x".repeat(3000); // exceeds repo_channel::MAX_TEXT_LEN (2000)
        let v = post_message_at(&state, "s1", &long, None, &path).unwrap();
        assert_eq!(v["notified"], 1);

        let queues = state.repo_channel_wakes.lock().unwrap();
        let pending = queues.get("s2").expect("wake queued for s2");
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].text.chars().count(), 2000, "wake line must be truncated");
        assert_eq!(pending[0].author_session_id, "s1");
    }

    #[tokio::test]
    async fn post_message_wake_line_carries_no_envelope_text() {
        // Todo 743: identity rides as `author_session_id`, never as
        // `"[repo-channel] {author}: "` text a receiving hook could misparse.
        let state = test_state();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("proj-743.json");
        state.registry.upsert_interactive("s1", std::path::Path::new("."), "proj-743", "2026-07-30T00:00:00Z");
        state.registry.upsert_interactive("s2", std::path::Path::new("."), "proj-743", "2026-07-30T00:00:00Z");
        state.registry.set_busy("s2", true);

        post_message_at(&state, "s1", "touching pump.rs, anyone on this?", None, &path).unwrap();

        let queues = state.repo_channel_wakes.lock().unwrap();
        let pending = queues.get("s2").expect("wake queued for s2");
        assert_eq!(pending[0].text, "touching pump.rs, anyone on this?");
        assert_eq!(pending[0].author_session_id, "s1");
    }

    #[tokio::test]
    async fn post_message_notifies_only_other_live_project_peers() {
        // post_message's wake delivery goes through `spawn_drain`, which calls
        // `tokio::spawn` internally - that requires a live Tokio runtime
        // context, hence `#[tokio::test]` here (plain `#[test]` would panic
        // with "no reactor running").
        let state = test_state();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("proj-1.json");
        state.registry.upsert_interactive("s1", std::path::Path::new("."), "proj-1", "2026-07-30T00:00:00Z");
        state.registry.upsert_interactive("s2", std::path::Path::new("."), "proj-1", "2026-07-30T00:00:00Z");
        state.registry.upsert_interactive("s3", std::path::Path::new("."), "proj-2", "2026-07-30T00:00:00Z");

        let v = post_message_at(&state, "s1", "touching pending-pane.ts, anyone on this?", None, &path).unwrap();
        assert_eq!(v["ok"], true);
        assert_eq!(v["notified"], 1, "only s2 shares proj-1 with the poster");
        assert_eq!(v["delivered"], true);
    }

    #[tokio::test]
    async fn post_message_to_an_empty_project_reports_not_delivered() {
        let state = test_state();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("proj-lonely.json");
        state.registry.upsert_interactive("lonely", std::path::Path::new("."), "proj-lonely", "2026-07-30T00:00:00Z");

        let v = post_message_at(&state, "lonely", "anyone here?", None, &path).unwrap();
        assert_eq!(v["notified"], 0);
        assert_eq!(
            v["delivered"], false,
            "a dead drop must be distinguishable from a real broadcast"
        );
    }

    #[tokio::test]
    async fn post_message_with_a_target_wakes_only_that_peer() {
        let state = test_state();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("proj-1.json");
        state.registry.upsert_interactive("s1", std::path::Path::new("."), "proj-1", "2026-07-30T00:00:00Z");
        state.registry.upsert_interactive("s2", std::path::Path::new("."), "proj-1", "2026-07-30T00:00:00Z");
        state.registry.upsert_interactive("s3", std::path::Path::new("."), "proj-1", "2026-07-30T00:00:00Z");

        let target = vec!["s3".to_string()];
        let v = post_message_at(&state, "s1", "for s3 only", Some(&target), &path).unwrap();
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
        // Its own tempdir path: other tests here post to proj-1, so sharing
        // one would flake.
        let state = test_state();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("proj-post-guard.json");
        state.registry.upsert_interactive("g1", std::path::Path::new("."), "proj-post-guard", "2026-07-30T00:00:00Z");

        let before = repo_channel::list_at(&path).len();
        let target = vec!["typo".to_string()];
        let r = post_message_at(&state, "g1", "secret coordination note", Some(&target), &path);
        assert!(r.is_err(), "an unknown target must fail the call");

        // Persisting before validating leaked the text into durable history that
        // every project member can read, while still returning Err to the caller.
        assert_eq!(
            repo_channel::list_at(&path).len(),
            before,
            "a rejected post must not append to channel history"
        );
    }
}
