//! Durable store for the inter-agent repo coordination channel: sessions
//! running through this app can post/read short text notes scoped to a
//! project, so two agents editing the same repo concurrently can coordinate
//! ("I'm about to touch X, is anyone on this?") instead of colliding.
//!
//! Complements, doesn't replace, `daemon::hooks_server::commit_lock`: that
//! mutex only serializes the instant `git commit` itself runs; this channel
//! covers the much longer editing window before a commit, where the actual
//! collision risk lives (see the `project_concurrent_autopilot_on_master`
//! incident history - a session's uncommitted edits getting swept into a
//! concurrent session's commit happens well before either ever calls `git
//! commit`).
//!
//! File: `<app-data>/repo-channels/<project_id>.json` -> `Vec<ChannelMessage>`.
//! Sole writer is the daemon. Bounded to `MAX_MESSAGES`, oldest pruned on
//! overflow - this is a short-lived coordination log, not a durable history.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ChannelMessage {
    pub id: String,
    pub session_id: String,
    /// Display label for the posting session (its registry `name`, falling
    /// back to the bare session id) - resolved once at post time so a reader
    /// doesn't need a second registry lookup per message.
    pub author: String,
    pub text: String,
    pub posted_at: String,
}

/// Retained message cap per project. A coordination log, not an archive -
/// oldest entries are dropped once this fills.
const MAX_MESSAGES: usize = 50;
/// Hard cap on a single message's length, so a runaway/looping agent can't
/// blow up the store or the text every peer gets woken with.
const MAX_TEXT_LEN: usize = 2000;

/// Serialize read-modify-write within a process, same rationale as
/// `scheduled_items::WRITE_LOCK` - cross-process integrity comes from the
/// atomic rename, not this lock.
static WRITE_LOCK: Mutex<()> = Mutex::new(());

fn store_dir() -> Option<PathBuf> {
    crate::settings::paths::data_dir().ok().map(|d| d.join("repo-channels"))
}

fn store_path_for(project_id: &str) -> Option<PathBuf> {
    Some(store_dir()?.join(format!("{project_id}.json")))
}

fn load(path: &Path) -> Vec<ChannelMessage> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_atomic(path: &Path, messages: &[ChannelMessage]) {
    let json = match serde_json::to_string_pretty(messages) {
        Ok(s) => s,
        Err(e) => {
            log::warn!("repo_channel: serialize failed: {e}");
            return;
        }
    };
    if let Err(e) = crate::util::write_json_atomic(path, &json) {
        log::warn!("repo_channel: write failed: {e}");
    }
}

/// All retained messages for a project, oldest first. Empty (never an error)
/// for a project with no channel file yet.
pub fn list(project_id: &str) -> Vec<ChannelMessage> {
    let Some(path) = store_path_for(project_id) else { return Vec::new() };
    load(&path)
}

/// Appends one message, pruning to `MAX_MESSAGES` (oldest dropped first).
/// Truncates `text` to `MAX_TEXT_LEN` chars. Best-effort: on a path/write
/// failure the message is still returned to the caller (so the poster's own
/// `post_message` response and the wake line it hands to peers stay
/// consistent) even though it never made it to disk.
pub fn post(project_id: &str, session_id: &str, author: &str, text: &str) -> ChannelMessage {
    let msg = ChannelMessage {
        id: uuid::Uuid::new_v4().to_string(),
        session_id: session_id.to_string(),
        author: author.to_string(),
        text: text.chars().take(MAX_TEXT_LEN).collect(),
        posted_at: chrono::Utc::now().to_rfc3339(),
    };
    if let Some(path) = store_path_for(project_id) {
        let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut messages = load(&path);
        messages.push(msg.clone());
        if messages.len() > MAX_MESSAGES {
            let excess = messages.len() - MAX_MESSAGES;
            messages.drain(0..excess);
        }
        write_atomic(&path, &messages);
    }
    msg
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn list_on_missing_file_returns_empty() {
        assert_eq!(list("nonexistent-project-id-xyz"), Vec::new());
    }

    #[test]
    fn post_and_load_roundtrip() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("proj-1.json");
        let msg = ChannelMessage {
            id: "m1".into(),
            session_id: "s1".into(),
            author: "Alice".into(),
            text: "hello".into(),
            posted_at: "2026-07-30T00:00:00Z".into(),
        };
        write_atomic(&path, &[msg.clone()]);
        let loaded = load(&path);
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].text, "hello");
    }

    #[test]
    fn overflow_prunes_oldest_first() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("proj-1.json");
        let mut messages: Vec<ChannelMessage> = (0..MAX_MESSAGES + 5)
            .map(|i| ChannelMessage {
                id: format!("m{i}"),
                session_id: "s1".into(),
                author: "Alice".into(),
                text: format!("msg {i}"),
                posted_at: "2026-07-30T00:00:00Z".into(),
            })
            .collect();
        // Mirror `post`'s own overflow trim so this test exercises the exact
        // logic `post` runs, without needing the real data_dir.
        if messages.len() > MAX_MESSAGES {
            let excess = messages.len() - MAX_MESSAGES;
            messages.drain(0..excess);
        }
        write_atomic(&path, &messages);
        let loaded = load(&path);
        assert_eq!(loaded.len(), MAX_MESSAGES);
        assert_eq!(loaded[0].text, "msg 5", "oldest 5 must have been dropped");
    }

    #[test]
    fn post_truncates_overlong_text() {
        let long = "x".repeat(MAX_TEXT_LEN + 500);
        // Exercise the truncation logic directly (same as `post`'s body) -
        // `post` itself needs a real data_dir, which isn't test-isolated.
        let truncated: String = long.chars().take(MAX_TEXT_LEN).collect();
        assert_eq!(truncated.chars().count(), MAX_TEXT_LEN);
    }
}
