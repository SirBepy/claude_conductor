//! Daemon-side shared state container. Owns the registry, session map,
//! settings cache, notifier, and pending request map. One `Arc<DaemonState>`
//! is constructed in `bin/cc_conductor_daemon.rs` and injected into the hook
//! server, RPC handlers, and detector loop.

use crate::channels::manager::Manager as ChannelsManager;
use crate::daemon::draft_store::DraftStore;
use crate::daemon::notifier::Notifier;
use crate::daemon::session::SessionMap;
use crate::daemon::settings_cache::SettingsCache;
use crate::sessions::registry::Registry;
use crate::daemon::push::PushManager;
use crate::storage::StorageManager;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};
use tokio::sync::{oneshot, Mutex, Notify};

pub type PendingMap = Arc<Mutex<HashMap<String, oneshot::Sender<Value>>>>;

/// A project's held commit lock (see `hooks_server::commit_lock`): which
/// session holds it, and when, so a stale lock (holder crashed before its
/// PostToolUse release hook could fire) can expire instead of deadlocking
/// every other session's commits forever.
struct CommitLock {
    session_id: String,
    acquired_at: Instant,
}

/// Safety net for a lock whose holder never released it (daemon killed
/// mid-commit, PostToolUse hook itself failed to fire). A real `git commit`
/// takes seconds; this is generous headroom, not the expected case.
const COMMIT_LOCK_TTL: Duration = Duration::from_secs(5 * 60);

pub struct DaemonState {
    pub sessions: SessionMap,
    pub registry: Arc<Registry>,
    pub settings: SettingsCache,
    pub notifier: Notifier,
    pub pending: PendingMap,
    pub channels: Arc<ChannelsManager>,
    /// Reliable-delivery store for prompts the app must surface (question cards).
    /// The lossy `notifier` broadcast can silently drop a frame under pipe
    /// backpressure, which left AskUserQuestion turns hung forever. Instead the
    /// daemon records each open prompt here (keyed by request id) and the app
    /// POLLS `list_pending_prompts` over the reliable RPC channel. Each value is
    /// `{ "id", "event", "payload" }` - `event` is the Tauri event the app emits,
    /// `payload` is its body. Inserted when the prompt opens, removed when it is
    /// answered or times out.
    pub pending_prompts: Arc<Mutex<HashMap<String, Value>>>,
    /// Signalled by the `shutdown_daemon` RPC so the main loop exits the
    /// process. `run_daemon_main` selects on `shutdown.notified()`.
    pub shutdown: Arc<Notify>,
    /// The daemon's OWN connection to the shared `companion.db`. The app owns
    /// the one-time JSONL->DB migration; the daemon only WRITES new rows (token
    /// records from `/refresh`, skill events from `/hooks/stop`). WAL +
    /// busy_timeout (set in `storage::db::open_db`) lets both processes touch the
    /// file concurrently. `None` if the DB failed to open at daemon startup, in
    /// which case the write paths fall back to a warn-and-skip (never a panic).
    /// A `std::sync::Mutex` because `rusqlite::Connection` is `!Sync`; every
    /// write locks briefly for a single synchronous INSERT and never holds the
    /// guard across an await.
    pub db: Option<Arc<std::sync::Mutex<StorageManager>>>,
    /// Web Push manager (ai_todo 119), set once at daemon startup via
    /// [`DaemonState::init_push`]. `None` in tests and until init runs, so every
    /// push path no-ops gracefully when absent.
    pub push: OnceLock<Arc<PushManager>>,
    /// Per-project commit mutex (keyed by `project_id`), enforced by the
    /// `PreToolUse`/`PostToolUse` Bash hooks in `hooks_server::commit_lock` so
    /// two concurrent `claude -p` sessions in the same project repo never run
    /// `git commit` at the same time - hit live 2026-07-21 as a patch-apply
    /// collision during partial-staging surgery. A plain `std::sync::Mutex`:
    /// every access is a quick check-and-set with no await held across it,
    /// same shape as `db` above.
    commit_locks: std::sync::Mutex<HashMap<String, CommitLock>>,
    /// Per-Jarvis-session wake queue (todo 272 chunk 3) - see
    /// `daemon::jarvis_wake` for the enqueue/drain contract. Public (not a
    /// `DaemonState` method wrapper) because the module's free functions read
    /// and write it directly, the same shape `sessions`/`registry` above use
    /// for their own daemon-wide consumers.
    pub jarvis_wakes: crate::daemon::jarvis_wake::WakeQueue,
    /// Per-session wake queue for the inter-agent repo coordination channel -
    /// see `daemon::repo_channel_wake` for the enqueue/drain contract. Its own
    /// `WakeQueue` type (todo 743): each queued line carries a sender id
    /// alongside the text, which `jarvis_wakes`'s plain-`String` queue doesn't
    /// need.
    pub repo_channel_wakes: crate::daemon::repo_channel_wake::WakeQueue,
    /// Cross-surface draft sync (composer text, AUQ partial answers, held
    /// messages) - see `draft_store.rs` module doc. In-memory only, never
    /// persisted; `held_count` on `Instance` is the separate broadcast signal.
    pub draft_store: DraftStore,
    /// Idempotency keys for `start_session` - see `daemon::start_tokens`. A
    /// dropped connection doesn't cancel a spawn, so a retry under the same
    /// placeholder id must resolve to the child that already booted.
    pub start_tokens: crate::daemon::start_tokens::StartTokens,
    /// Monotonic source for `question-requested` payloads' `seq` field.
    /// `pending_prompts` is a `HashMap` - iteration order isn't chronological,
    /// so this lets callers tell a genuinely newer question apart from a
    /// stale/ghost one for the same session.
    prompt_seq: AtomicU64,
}

impl DaemonState {
    pub fn new(
        sessions: SessionMap,
        settings: SettingsCache,
    ) -> Arc<Self> {
        Self::with_db(sessions, settings, None)
    }

    /// Constructor that threads in the daemon's `companion.db` handle.
    /// `run_daemon_main` opens the store once and passes it here; tests use
    /// [`DaemonState::new`] (no DB).
    pub fn with_db(
        sessions: SessionMap,
        settings: SettingsCache,
        db: Option<Arc<std::sync::Mutex<StorageManager>>>,
    ) -> Arc<Self> {
        Arc::new(Self {
            sessions,
            registry: Arc::new(Registry::new()),
            settings,
            notifier: Notifier::new(),
            pending: Arc::new(Mutex::new(HashMap::new())),
            channels: Arc::new(ChannelsManager::new()),
            pending_prompts: Arc::new(Mutex::new(HashMap::new())),
            shutdown: Arc::new(Notify::new()),
            db,
            push: OnceLock::new(),
            commit_locks: std::sync::Mutex::new(HashMap::new()),
            jarvis_wakes: crate::daemon::jarvis_wake::new_queue(),
            repo_channel_wakes: crate::daemon::repo_channel_wake::new_queue(),
            draft_store: DraftStore::new(),
            start_tokens: crate::daemon::start_tokens::StartTokens::new(),
            prompt_seq: AtomicU64::new(0),
        })
    }

    /// Next value in the `question-requested` ordering sequence (see `prompt_seq`).
    pub fn next_prompt_seq(&self) -> u64 {
        self.prompt_seq.fetch_add(1, Ordering::Relaxed)
    }

    /// Load the Web Push manager (VAPID key + persisted phone subscriptions
    /// under `app_data`) and install it. Idempotent: a second call is ignored.
    pub fn init_push(&self, app_data: std::path::PathBuf) {
        let _ = self.push.set(PushManager::load(app_data));
    }

    /// Fire a "Claude is blocked on you" push for a freshly-registered prompt.
    /// No-op if push isn't initialised. Resolves a human session name from the
    /// registry and spawns the (best-effort, idle-gated) send so the prompt
    /// relay path is never delayed by a network call.
    pub fn fire_blocked_prompt(&self, session_id: Option<&str>, prompt_id: &str) {
        let Some(pm) = self.push.get().cloned() else { return };
        let name = session_id
            .and_then(|sid| self.registry.get(sid))
            .map(|inst| {
                inst.name.clone().unwrap_or_else(|| {
                    inst.cwd
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_else(|| "a chat".into())
                })
            })
            .unwrap_or_else(|| "a chat".into());
        let sid = session_id.map(|s| s.to_string());
        let pid = prompt_id.to_string();
        tokio::spawn(async move {
            pm.maybe_notify_blocked(sid, name, pid).await;
        });
    }

    /// Record an open prompt for reliable poll-based delivery to the app.
    /// `event` is the Tauri event name the app should emit (e.g.
    /// `"question-requested"`); `payload` is its body.
    ///
    /// `durable` marks a fire-and-forget AskUserQuestion prompt: the asking
    /// turn ENDS the instant the card is posted (the hook returns immediately
    /// instead of blocking), so the `claude -p` child EOFs and the pump loop's
    /// `expire_prompts_for_session` would otherwise wipe the card before the
    /// user ever answered. Durable prompts are skipped by that expiry and are
    /// cleared ONLY by an explicit answer/skip (`respond_question` -> the
    /// ghost-tolerant `settle_prompt`).
    pub async fn add_prompt(&self, id: &str, event: &str, payload: Value, durable: bool) {
        self.pending_prompts.lock().await.insert(
            id.to_string(),
            serde_json::json!({ "id": id, "event": event, "payload": payload, "durable": durable }),
        );
    }

    /// Drop an open prompt once it has been answered or timed out.
    pub async fn remove_prompt(&self, id: &str) {
        self.pending_prompts.lock().await.remove(id);
    }

    /// Snapshot of all open prompts, for the app's `list_pending_prompts` poll.
    /// Sorted by `seq` (oldest first) - `pending_prompts` is a `HashMap`, whose
    /// own iteration order is not chronological.
    pub async fn list_prompts(&self) -> Vec<Value> {
        let mut prompts: Vec<Value> = self.pending_prompts.lock().await.values().cloned().collect();
        prompts.sort_by_key(|p| p["payload"]["seq"].as_u64().unwrap_or(u64::MAX));
        prompts
    }

    /// The session a recorded prompt belongs to, if it is still open.
    /// `respond_*` uses this to resolve the session BEFORE removing the record.
    pub async fn prompt_session_id(&self, id: &str) -> Option<String> {
        self.pending_prompts
            .lock()
            .await
            .get(id)
            .and_then(|v| v["payload"]["session_id"].as_str().map(str::to_string))
    }

    /// The recorded `event` kind for a still-open prompt (`"permission-requested"`
    /// or `"question-requested"`), if any. `daemon::methods::jarvis::respond_worker_prompt`
    /// uses this to route a Jarvis worker-prompt answer to the matching
    /// `respond_permission_inner`/`respond_question_inner` without the caller
    /// having to know (or be trusted about) which kind of prompt it's
    /// answering.
    pub async fn prompt_event(&self, id: &str) -> Option<String> {
        self.pending_prompts
            .lock()
            .await
            .get(id)
            .and_then(|v| v["event"].as_str().map(str::to_string))
    }

    /// Expire every open prompt belonging to `session_id`: drop the prompt
    /// records (so `list_pending_prompts` stops resurrecting their cards) and
    /// the pending oneshots (waking any still-blocked hook handler into its
    /// timeout branch). Publishes `question_expired` per question prompt.
    ///
    /// Called when a session's `claude -p` child hits EOF: the hook `curl`
    /// dies with the process, axum then drops the blocked handler future on
    /// client disconnect, and the handler's own post-await cleanup never runs
    /// - which used to leave ghost cards that, when answered, resolved into
    /// nothing and left the row on "Input Needed" forever. Returns how many
    /// prompts were expired.
    pub async fn expire_prompts_for_session(&self, session_id: &str) -> usize {
        // Each turn is a fresh `claude -p` child, so this EOF-triggered sweep
        // is also where the builtin AskUserQuestion redirect budget resets.
        self.registry.reset_builtin_ask_attempts(session_id);
        let expired: Vec<(String, bool)> = {
            let mut prompts = self.pending_prompts.lock().await;
            let ids: Vec<(String, bool)> = prompts
                .iter()
                // Skip durable (fire-and-forget AskUserQuestion) prompts: their
                // asking turn ends on purpose the moment the card is posted, so
                // the EOF that triggers this expiry is NORMAL, not a crash. They
                // outlive the turn and are cleared only by an explicit answer or
                // skip. Non-durable prompts (blocking permission/MCP-question
                // relays) still expire as before.
                .filter(|(_, v)| {
                    v["payload"]["session_id"].as_str() == Some(session_id)
                        && v["durable"].as_bool() != Some(true)
                })
                .map(|(id, v)| (id.clone(), v["event"].as_str() == Some("question-requested")))
                .collect();
            for (id, _) in &ids {
                prompts.remove(id);
            }
            ids
        };
        if expired.is_empty() {
            return 0;
        }
        let mut pending = self.pending.lock().await;
        for (id, is_question) in &expired {
            pending.remove(id);
            if *is_question {
                self.notifier.publish(
                    "question_expired",
                    serde_json::json!({ "session_id": session_id, "id": id }),
                );
            }
        }
        expired.len()
    }

    /// Try to acquire the commit lock for `project_id` on behalf of
    /// `session_id`. Succeeds (returns `true`) if the lock is free, expired
    /// (see [`COMMIT_LOCK_TTL`]), or already held by this SAME session
    /// (re-entrant safe - a retried commit in the same turn doesn't
    /// self-deadlock). Fails (`false`) only if a different, still-live
    /// session holds it.
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
    async fn state_constructs_with_empty_registry_and_pending() {
        let st = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        assert_eq!(st.registry.list().len(), 0);
        assert_eq!(st.pending.lock().await.len(), 0);
        assert_eq!(st.channels.list().len(), 0);
    }

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
    async fn next_prompt_seq_is_monotonic() {
        let st = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        let a = st.next_prompt_seq();
        let b = st.next_prompt_seq();
        let c = st.next_prompt_seq();
        assert!(a < b && b < c);
    }

    /// Regression: `list_prompts()` must sort by `seq`, not by `pending_prompts`'
    /// HashMap iteration order (which carries no chronological meaning).
    #[tokio::test]
    async fn list_prompts_sorts_by_seq_regardless_of_insertion_order() {
        let st = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        // Insert newest first, oldest last (opposite of insertion order).
        st.add_prompt("newer", "question-requested", serde_json::json!({"seq": 5}), true).await;
        st.add_prompt("older", "question-requested", serde_json::json!({"seq": 1}), true).await;
        let prompts = st.list_prompts().await;
        let ids: Vec<&str> = prompts.iter().map(|p| p["id"].as_str().unwrap()).collect();
        assert_eq!(ids, vec!["older", "newer"], "must be seq-ascending, not insertion order");
    }

    /// A `seq`-less prompt (permission requests) must sort after every question.
    #[tokio::test]
    async fn list_prompts_sorts_seqless_prompts_after_seq_ed_ones() {
        let st = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        st.add_prompt("no-seq", "permission-requested", serde_json::json!({}), false).await;
        st.add_prompt("has-seq", "question-requested", serde_json::json!({"seq": 1}), true).await;
        let prompts = st.list_prompts().await;
        let ids: Vec<&str> = prompts.iter().map(|p| p["id"].as_str().unwrap()).collect();
        assert_eq!(ids, vec!["has-seq", "no-seq"]);
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
