//! Per-project commit mutex enforced by the `PreToolUse`/`PostToolUse` Bash
//! hooks in `hooks_server::commit_lock`, so two concurrent `claude -p`
//! sessions in the same project repo never run `git commit` at the same time
//! - hit live 2026-07-21 as a patch-apply collision during partial staging.

use super::*;
use std::time::{Duration, Instant};

/// A held commit lock: which session holds it, and when, so a
/// stale lock (holder crashed before its PostToolUse release hook could
/// fire) can expire instead of deadlocking every other session's commits
/// forever.
pub(super) struct CommitLock {
    pub(super) session_id: String,
    pub(super) acquired_at: Instant,
}

/// Safety net for a lock whose holder never released it (daemon killed
/// mid-commit, PostToolUse hook itself failed to fire). A real `git commit`
/// takes seconds; this is generous headroom, not the expected case.
const COMMIT_LOCK_TTL: Duration = Duration::from_secs(5 * 60);

impl DaemonState {
    /// Try to acquire the commit lock `key` on behalf of `session_id`. The key is the
    /// git dir of the tree being committed in (see `hooks_server::commit_lock`), or
    /// the project id when that cannot be resolved.
    /// Succeeds if free, expired (see [`COMMIT_LOCK_TTL`]), or already held by
    /// this same session (re-entrant, so a retried commit doesn't self-deadlock).
    /// Fails only if a different, still-live session holds it.
    pub fn try_acquire_commit_lock(&self, key: &str, session_id: &str) -> bool {
        self.try_acquire_commit_lock_with_ttl(key, session_id, COMMIT_LOCK_TTL)
    }

    fn try_acquire_commit_lock_with_ttl(&self, key: &str, session_id: &str, ttl: Duration) -> bool {
        let mut locks = self.commit_locks.lock().unwrap();
        if let Some(existing) = locks.get(key) {
            if existing.session_id != session_id && existing.acquired_at.elapsed() < ttl {
                return false;
            }
        }
        locks.insert(
            key.to_string(),
            CommitLock { session_id: session_id.to_string(), acquired_at: Instant::now() },
        );
        true
    }

    /// Release lock `key` IFF it is currently held by `session_id` - never clobbers a
    /// different session's lock (e.g. a late release racing a fresh acquire by
    /// someone else after this one expired).
    pub fn release_commit_lock(&self, key: &str, session_id: &str) {
        let mut locks = self.commit_locks.lock().unwrap();
        if locks.get(key).map(|l| l.session_id.as_str()) == Some(session_id) {
            locks.remove(key);
        }
    }

    /// Release every commit lock `session_id` still holds, returning how many. A
    /// session that has moved on (its next tool batch, its turn ending, its process
    /// exiting) has no `git commit` still running, so a lock it holds is a leak: the
    /// `PostToolUse` release never fires when another hook denied the call.
    pub fn release_commit_locks_held_by(&self, session_id: &str) -> usize {
        let mut locks = self.commit_locks.lock().unwrap();
        let before = locks.len();
        locks.retain(|_, l| l.session_id != session_id);
        before - locks.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::session::new_session_map;
    use crate::types::Settings;

    #[tokio::test]
    async fn commit_lock_free_project_acquires() {
        let st = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        assert!(st.try_acquire_commit_lock("proj-1", "sess-a"));
    }

    #[tokio::test]
    async fn commit_lock_blocks_a_different_session() {
        let st = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        assert!(st.try_acquire_commit_lock("proj-1", "sess-a"));
        assert!(!st.try_acquire_commit_lock("proj-1", "sess-b"), "held by sess-a");
    }

    #[tokio::test]
    async fn commit_lock_reacquire_by_same_session_is_reentrant() {
        let st = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        assert!(st.try_acquire_commit_lock("proj-1", "sess-a"));
        assert!(st.try_acquire_commit_lock("proj-1", "sess-a"), "same session must not self-deadlock");
    }

    #[tokio::test]
    async fn commit_lock_release_only_clears_own_holder() {
        let st = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        assert!(st.try_acquire_commit_lock("proj-1", "sess-a"));
        st.release_commit_lock("proj-1", "sess-b"); // not the holder - must be a no-op
        assert!(!st.try_acquire_commit_lock("proj-1", "sess-b"), "sess-a's lock must still stand");
        st.release_commit_lock("proj-1", "sess-a");
        assert!(st.try_acquire_commit_lock("proj-1", "sess-b"), "freed after the real holder released");
    }

    #[tokio::test]
    async fn releasing_everything_a_session_holds_leaves_other_sessions_locks() {
        let st = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        assert!(st.try_acquire_commit_lock("tree-1", "sess-a"));
        assert!(st.try_acquire_commit_lock("tree-2", "sess-a"));
        assert!(st.try_acquire_commit_lock("tree-3", "sess-b"));
        assert_eq!(st.release_commit_locks_held_by("sess-a"), 2);
        assert!(st.try_acquire_commit_lock("tree-1", "sess-c"));
        assert!(!st.try_acquire_commit_lock("tree-3", "sess-c"), "sess-b still holds its own");
        assert_eq!(st.release_commit_locks_held_by("sess-a"), 0);
    }

    #[tokio::test]
    async fn commit_lock_expires_after_ttl() {
        let st = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        assert!(st.try_acquire_commit_lock_with_ttl("proj-1", "sess-a", Duration::from_millis(20)));
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert!(
            st.try_acquire_commit_lock_with_ttl("proj-1", "sess-b", Duration::from_millis(20)),
            "a stale lock past its TTL must not deadlock other sessions"
        );
    }
}
