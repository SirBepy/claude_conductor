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
use tokio::sync::{oneshot, Mutex, Notify};

mod commit_lock;
mod prompts;

use commit_lock::CommitLock;

pub type PendingMap = Arc<Mutex<HashMap<String, oneshot::Sender<Value>>>>;

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
    async fn next_prompt_seq_is_monotonic() {
        let st = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        let a = st.next_prompt_seq();
        let b = st.next_prompt_seq();
        let c = st.next_prompt_seq();
        assert!(a < b && b < c);
    }
}
