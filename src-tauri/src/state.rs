//! Runtime app state shared across Tauri commands and background tasks.

use crate::types::{AuthState, Settings, UsageSnapshot};
use std::sync::{Arc, Mutex};
use std::sync::atomic::AtomicBool;

pub struct AppState {
    /// Legacy/default single-account snapshot. Milestone 03: this stays the
    /// read path for existing single-account consumers (tray, dashboard IPC)
    /// - it's populated either by the legacy single-cookie poll, or (once
    /// accounts are registered) mirrors the default account's own entry in
    /// `current_usage_by_account`. Real per-account reads should use
    /// `current_usage_by_account` instead; this field is retired once every
    /// consumer is migrated (milestones 05/06).
    pub current_usage: Mutex<Option<UsageSnapshot>>,
    /// Per-account usage snapshots (multi-account milestone 03), keyed by
    /// `Account.id`. Populated only once an account has a stored web cookie;
    /// empty while every account is still on the legacy `session.txt` path.
    pub current_usage_by_account: Mutex<std::collections::HashMap<String, UsageSnapshot>>,
    pub settings: Mutex<Settings>,
    /// Legacy/default auth state - see `current_usage`'s doc comment for the
    /// same single-vs-per-account split.
    pub auth_state: Mutex<AuthState>,
    /// Per-account auth state (multi-account milestone 03), keyed by
    /// `Account.id`.
    pub auth_state_by_account: Mutex<std::collections::HashMap<String, AuthState>>,
    pub audio_stream: crate::notifications::audio::AudioStreamCtrl,
    pub audio: crate::notifications::audio::AudioCtx,
    pub preview: crate::notifications::audio::PreviewCtx,
    /// Daemon-owned instance list, mirrored locally. Refreshed from
    /// `instances_changed` notifications. App-side reads consult this cache;
    /// writes go through `daemon_client` (Phase 5 wires the writers).
    pub cached_instances: Arc<Mutex<Vec<crate::types::Instance>>>,
    /// Daemon-owned channel list, mirrored locally. Refreshed from
    /// `channels_changed` notifications. Replaces the app-owned `channels`
    /// Manager for read paths now that the daemon owns channel processes.
    pub cached_channels: Arc<Mutex<Vec<serde_json::Value>>>,
    /// session_id -> the `channel_epoch` a live `attach_session` pump task is
    /// subscribed at, so a daemon-internal respawn can be detected. Daemon
    /// chat mode only.
    pub attached_sessions: Arc<Mutex<std::collections::HashMap<String, u64>>>,
    /// Connected persistent client to the daemon. `None` until startup wiring
    /// in `lib.rs` connects and subscribes.
    pub daemon_client: Arc<tokio::sync::Mutex<Option<crate::daemon_client::PersistentClient>>>,
    pub hook_registration_pending: Mutex<bool>,
    pub update_state: Mutex<serde_json::Value>,
    pub should_quit: Arc<AtomicBool>,
    /// Set to true the first time the webview JS sends `frontend_ready`.
    /// Watchdog spawned in lib.rs reloads the main window if this never flips
    /// (covers WebView2 showing a "can't reach this page" error when the
    /// dev/prod start URL fails at boot, e.g. autostart racing with the network).
    pub frontend_alive: Arc<AtomicBool>,
    /// Set to true only once the main dashboard window's `on_page_load`
    /// "Finished" event has fired for the first time (see
    /// `ipc::window::build_main_window`). Every show-path that surfaces an
    /// *already-built* `main` window (`ipc::window::open_dashboard` and its
    /// siblings) must check this before calling `surface_main` - a window
    /// that exists but is still mid-navigation paints blank/white and
    /// swallows input if forced visible early. `build_main_window`'s own
    /// `on_page_load` handler is unaffected: it shows the window itself once
    /// this flips, so callers that find it still `false` simply skip the
    /// show and let that handler do it.
    pub main_window_loaded: Arc<AtomicBool>,
    /// A pending "open this session in the chats window" request, set when the
    /// chats window is created fresh from the main window's "Open in chats" CTA.
    /// The chats window drains it on boot via `take_pending_chat_open`. Holds
    /// `(session_id, mode)` where mode is "live" or "history".
    pub pending_chat_open: Mutex<Option<(String, String)>>,
    /// A pending "start a new chat in the chats window" request, set when the
    /// chats window is created fresh from the project-detail "+" button.
    /// The chats window drains it on boot via `take_pending_new_chat`. Holds
    /// the full `ipc::window::PendingNewChat` (model/effort plus
    /// account_id/auto_accept/remote/character_id - ai_todo 163).
    pub pending_new_chat: Mutex<Option<crate::ipc::window::PendingNewChat>>,
    /// A pending main-window navigation queued while `frontend_alive` was false
    /// (webview still loading). Drained by `frontend_ready` once JS is running.
    /// Value is "dashboard" or "project:{cwd}".
    pub pending_main_nav: Mutex<Option<String>>,
    /// True while the meeting watcher detects an active meeting (camera/mic in
    /// use, or an allowlisted meeting app producing audio). Read by
    /// `notifications::rules::fire` and the tray tooltip. Always false on
    /// non-Windows. Written by `crate::meeting::start`.
    pub meeting_active: Arc<AtomicBool>,
    /// Slugs for which a `news::summarizer::generate_for_slug` call is currently
    /// running. Guards against double-spawning when the eager backfill and the
    /// lazy IPC path race on the same new post.
    pub news_inflight: Arc<Mutex<std::collections::HashSet<String>>>,
    /// State + task handle for the "do-X-when-all-sessions-idle" protocol
    /// (sleep/shutdown when every session goes idle). At most one armed at a
    /// time; arming aborts any prior task. See `crate::when_done`.
    pub when_done: Arc<Mutex<crate::when_done::WhenDoneInner>>,
    /// Consolidated SQLite store (usage snapshots now; token + skill datasets
    /// wired in slice 2b). Behind a `Mutex` because `rusqlite::Connection` is
    /// `!Sync`; every store/retention call borrows the connection briefly.
    pub db: Mutex<crate::storage::StorageManager>,
    /// In-progress add-account wizard runs, keyed by a random session id.
    /// Never persisted (see `accounts::wizard::WizardSession`).
    pub account_wizard_sessions: Mutex<std::collections::HashMap<String, crate::accounts::WizardSession>>,
}

impl AppState {
    pub fn new(settings: Settings, auth_state: AuthState) -> anyhow::Result<Self> {
        let audio_stream = crate::notifications::audio::AudioStreamCtrl::init(
            settings.audio_output_device.as_deref(),
        );
        let audio = crate::notifications::audio::AudioCtx::new(audio_stream.handle_arc());
        let preview = crate::notifications::audio::PreviewCtx::new(audio_stream.handle_arc());
        let db_path = crate::settings::paths::companion_db()?;
        let db = crate::storage::StorageManager::open(&db_path)?;
        Ok(Self {
            current_usage: Mutex::new(None),
            current_usage_by_account: Mutex::new(std::collections::HashMap::new()),
            settings: Mutex::new(settings),
            auth_state: Mutex::new(auth_state),
            auth_state_by_account: Mutex::new(std::collections::HashMap::new()),
            audio_stream,
            audio,
            preview,
            cached_instances: Arc::new(Mutex::new(Vec::new())),
            cached_channels: Arc::new(Mutex::new(Vec::new())),
            attached_sessions: Arc::new(Mutex::new(std::collections::HashMap::new())),
            daemon_client: Arc::new(tokio::sync::Mutex::new(None)),
            hook_registration_pending: Mutex::new(false),
            update_state: Mutex::new(serde_json::json!({ "state": "idle" })),
            should_quit: Arc::new(AtomicBool::new(false)),
            frontend_alive: Arc::new(AtomicBool::new(false)),
            main_window_loaded: Arc::new(AtomicBool::new(false)),
            pending_chat_open: Mutex::new(None),
            pending_new_chat: Mutex::new(None),
            pending_main_nav: Mutex::new(None),
            meeting_active: Arc::new(AtomicBool::new(false)),
            news_inflight: Arc::new(Mutex::new(std::collections::HashSet::new())),
            when_done: Arc::new(Mutex::new(crate::when_done::WhenDoneInner::default())),
            db: Mutex::new(db),
            account_wizard_sessions: Mutex::new(std::collections::HashMap::new()),
        })
    }
}
