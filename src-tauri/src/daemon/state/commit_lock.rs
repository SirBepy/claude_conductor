//! Per-project commit mutex enforced by the `PreToolUse`/`PostToolUse` Bash
//! hooks in `hooks_server::commit_lock`, so two concurrent `claude -p`
//! sessions in the same project repo never run `git commit` at the same time
//! - hit live 2026-07-21 as a patch-apply collision during partial staging.

use super::*;
use std::time::{Duration, Instant};

/// A project's held commit lock: which session holds it, and when, so a
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
    /// Try to acquire the commit lock for `project_id` on behalf of `session_id`.
    /// Succeeds if free, expired (see [`COMMIT_LOCK_TTL`]), or already held by
    /// this same session (re-entrant, so a retried commit doesn't self-deadlock).
    /// Fails only if a different, still-live session holds it.
    pub fn try_acquire_commit_lock(&self, project_id: &str, session_id: &str) -> bool {
        self.try_acquire_commit_lock_with_ttl(project_id, session_id, COMMIT_LOCK_TTL)
    }

    fn try_acquire_commit_lock_with_ttl(&self, project_id: &str, session_id: &str, ttl: Duration) -> bool {
        let mut locks = self.commit_locks.lock().unwrap();
        if let Some(existing) = locks.get(project_id) {
            if existing.session_id != session_id && existing.acquired_at.elapsed() < ttl {
                return false;
            }
        }
        locks.insert(
            project_id.to_string(),
            CommitLock { session_id: session_id.to_string(), acquired_at: Instant::now() },
        );
        true
    }

    /// Release `project_id`'s commit lock IFF it is currently held by
    /// `session_id` - never clobbers a different session's lock (e.g. a late
    /// release racing a fresh acquire by someone else after this one expired).
    pub fn release_commit_lock(&self, project_id: &str, session_id: &str) {
        let mut locks = self.commit_locks.lock().unwrap();
        if locks.get(project_id).map(|l| l.session_id.as_str()) == Some(session_id) {
            locks.remove(project_id);
        }
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
