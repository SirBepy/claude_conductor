//! Tauri `.setup()` callback and its startup-only helpers, one function per
//! independent background concern (migrations, spawned loops/watchers,
//! backfills). Extracted from `lib.rs` (ai_todo 515, following the earlier
//! `run()` extraction, ai_todo 266) - pure move, no behavior change.

use crate::settings::paths;
use crate::state::AppState;
use tauri::{Emitter, Listener, Manager};

/// Tauri `.setup()` callback: activation policy, tray, one-time debug-only
/// chats-window auto-open, then every startup migration/background
/// loop/watcher in the app's original startup order.
pub(crate) fn setup_app(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    log::info!("claude-conductor started");
    #[cfg(target_os = "macos")]
    {
        let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);
    }
    crate::tray::setup(app.handle())?;

    // Debug (`cargo tauri dev`) builds auto-open the chats window on
    // launch - the tray-icon left-click opens the account overlay, not
    // this window (see tray/menu.rs's on_left_click), so without this a
    // dev instance stays invisible until someone finds the right-click
    // menu item. Prod is untouched: it still starts tray-only.
    if cfg!(debug_assertions) {
        let _ = crate::ipc::open_chats_window(app.handle().clone());
    }

    // The main dashboard window is built lazily on first open (see
    // `build_main_window`), NOT eagerly here - an eager startup window
    // flashes a white ghost frame on Windows (ai_todo 143). Usage
    // polling runs in the backend `scheduler::spawn` loop and does not
    // need this window.

    let handle = app.handle().clone();

    // One-time legacy import into SQLite for all three datasets. Each
    // importer renames its source to `.bak` on success, so the on-disk
    // presence of the source file is itself the idempotency gate (no
    // separate flag). The APP owns this migration for ALL datasets
    // (it controls startup order); the daemon only writes new rows.
    run_sqlite_startup_migration(&handle);

    spawn_attachment_gc();
    sync_autostart_on_boot(&handle);
    watch_autostart_setting_changes(&handle);
    spawn_auto_update_loop(&handle);

    // Re-apply the phone remote-access reverse proxy if the user left it
    // on. Best-effort + off-thread: a missing/disconnected tailscale just
    // logs a warning, never blocks or panics startup.
    reapply_remote_access_on_boot(&handle);

    crate::ipc::remote_access::start_tailscale_watcher(handle.clone());
    crate::scheduler::spawn(handle.clone());
    crate::news::spawn_poll_loop(handle.clone());
    crate::slash::watcher::spawn(handle.clone());
    crate::meeting::start(handle.clone());

    spawn_audio_device_follow(&handle);
    spawn_token_backfill(&handle);
    spawn_hook_install_migration(&handle);
    spawn_character_backfill_migration(&handle);
    spawn_daemon_subscription(&handle);

    // (Main-window hide-to-tray lives in `build_main_window`; the window
    // is built lazily on first open, so there is nothing to wire here.)

    // Windows session-end guard. Owns its own hidden window + message
    // pump on a dedicated thread so a PC shutdown is never left waiting
    // on a wedged event loop. See `shutdown_guard` for the full why.
    crate::shutdown_guard::arm(handle.clone());

    spawn_boot_watchdog(&handle);
    spawn_heartbeat_watchdog(&handle);
    trigger_auto_login_if_needed(&handle);
    Ok(())
}

/// Import `history.jsonl`/`token-history.json`/`skill-usage` legacy files
/// into SQLite, then run a one-time startup prune under the current
/// retention policies (subsequent prunes run on each scheduler poll tick).
fn run_sqlite_startup_migration(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();
    let mgr = state.db.lock().unwrap();
    let conn = mgr.conn();

    // Usage (history.jsonl -> usage_snapshots).
    if let Ok(history_path) = paths::history_file() {
        if history_path.exists() {
            match crate::storage::migration::import_usage_jsonl(conn, &history_path) {
                Ok(stats) => log::info!(
                    "storage: imported usage history into SQLite (imported={}, skipped={})",
                    stats.imported,
                    stats.skipped,
                ),
                Err(e) => log::error!("storage: usage history import failed: {e:#}"),
            }
        }
    }

    // Tokens (token-history.json array -> token_records).
    if let Ok(token_path) = paths::token_history_file() {
        if token_path.exists() {
            match crate::storage::migration::import_token_history_json(conn, &token_path) {
                Ok(stats) => log::info!(
                    "storage: imported token history into SQLite (imported={}, skipped={})",
                    stats.imported,
                    stats.skipped,
                ),
                Err(e) => log::error!("storage: token history import failed: {e:#}"),
            }
        }
    }

    // Skills (skill-usage/events-*.jsonl -> skill_events). The
    // importer renames each daily file to `.bak`; a dir with no
    // remaining events-*.jsonl is a clean no-op on later launches.
    if let Ok(skill_dir) = paths::skill_usage_dir() {
        let has_events = std::fs::read_dir(&skill_dir)
            .map(|entries| {
                entries.flatten().any(|e| {
                    e.file_name()
                        .to_str()
                        .map(|n| n.starts_with("events-") && n.ends_with(".jsonl"))
                        .unwrap_or(false)
                })
            })
            .unwrap_or(false);
        if has_events {
            match crate::storage::migration::import_skill_events_dir(conn, &skill_dir) {
                Ok(stats) => log::info!(
                    "storage: imported skill events into SQLite (imported={}, skipped={})",
                    stats.imported,
                    stats.skipped,
                ),
                Err(e) => log::error!("storage: skill events import failed: {e:#}"),
            }
        }
    }

    // One-time startup prune of all three datasets under the
    // user-configured retention policies (subsequent prunes run on
    // each scheduler poll tick).
    let policies = state.settings.lock().unwrap().retention;
    match crate::storage::prune_all(conn, &policies) {
        Ok(deleted) => {
            if deleted > 0 {
                log::info!("storage: startup prune removed {deleted} row(s)");
            }
        }
        Err(e) => log::warn!("storage: startup prune failed: {e:#}"),
    }
}

/// Schedule chat-attachments GC: run once on startup, then every 24h.
/// Removes pasted-image directories whose mtime is older than 30 days.
fn spawn_attachment_gc() {
    tauri::async_runtime::spawn(async move {
        loop {
            crate::ipc::chat::gc_attachments().await;
            tokio::time::sleep(std::time::Duration::from_secs(24 * 3600)).await;
        }
    });
}

/// Apply the persisted `autostart` setting to the OS autostart entry once
/// at boot (`watch_autostart_setting_changes` keeps it in sync afterward).
fn sync_autostart_on_boot(app: &tauri::AppHandle) {
    use tauri_plugin_autostart::ManagerExt;
    let autostart_mgr = app.autolaunch();
    let state = app.state::<AppState>();
    let desired = state.settings.lock().unwrap().autostart;
    let _ = if desired {
        autostart_mgr.enable()
    } else {
        autostart_mgr.disable()
    };
}

/// Keep the OS autostart entry in sync with the `autostart` setting for the
/// rest of the app's lifetime.
fn watch_autostart_setting_changes(app: &tauri::AppHandle) {
    let h = app.clone();
    app.listen("settings-changed", move |event| {
        use tauri_plugin_autostart::ManagerExt;
        let Ok(settings) = serde_json::from_str::<crate::types::Settings>(event.payload()) else { return; };
        let mgr = h.autolaunch();
        let _ = if settings.autostart { mgr.enable() } else { mgr.disable() };
    });
}

/// Spawn the background release-poll loop (see `auto_update_loop`).
fn spawn_auto_update_loop(app: &tauri::AppHandle) {
    let h = app.clone();
    tauri::async_runtime::spawn(auto_update_loop(h));
}

/// Re-apply the phone remote-access reverse proxy if the user left it on.
fn reapply_remote_access_on_boot(app: &tauri::AppHandle) {
    let enabled = app
        .state::<AppState>()
        .settings
        .lock()
        .unwrap()
        .remote_access_enabled;
    crate::ipc::remote_access::reapply_on_boot(enabled);
}

/// Make a "System default" audio-output preference follow live OS
/// default-device changes. Opt-in watcher from the kit; reads the current
/// pref and re-binds the held stream when the OS default shifts while no
/// explicit device is selected.
fn spawn_audio_device_follow(app: &tauri::AppHandle) {
    let pref_app = app.clone();
    let reinit_app = app.clone();
    tauri_kit_audio::spawn_default_follow(
        move || {
            pref_app
                .state::<AppState>()
                .settings
                .lock()
                .unwrap()
                .audio_output_device
                .clone()
        },
        move |dev| {
            reinit_app
                .state::<AppState>()
                .audio_stream
                .reinit(dev.as_deref());
        },
    );
}

/// Auto-backfill token history once, off the main thread. Keeps the stats
/// page populated on first launch / after new sessions.
fn spawn_token_backfill(app: &tauri::AppHandle) {
    let h = app.clone();
    tauri::async_runtime::spawn(async move {
        let Ok(path) = paths::token_history_file() else { return };
        let path_clone = path.clone();
        match tauri::async_runtime::spawn_blocking(move || {
            crate::tokens::backfill_all(&path_clone)
        })
        .await
        {
            Ok(Ok(r)) => {
                log::info!(
                    "startup backfill: {} new, {} skipped (sub: {} new, {} skipped)",
                    r.processed, r.skipped, r.sub_processed, r.sub_skipped
                );
                let history = crate::tokens::load_history(&path);
                let _ = h.emit("token-history-updated", history);
            }
            Ok(Err(e)) => log::warn!("startup backfill failed: {e:?}"),
            Err(e) => log::warn!("startup backfill join error: {e}"),
        }
    });
}

/// Spawn the one-time hook-install migration (see `migrate_hook_install_if_needed`).
fn spawn_hook_install_migration(app: &tauri::AppHandle) {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        migrate_hook_install_if_needed(&handle);
    });
}

/// Spawn the one-time character-avatar backfill (see
/// `backfill_project_characters_if_needed`).
fn spawn_character_backfill_migration(app: &tauri::AppHandle) {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        backfill_project_characters_if_needed(&handle);
    });
}

/// Daemon notification subscription. Replaces the old app-side hook
/// server: the daemon now binds port 27182 and owns the registry; the app
/// subscribes for `instances_changed`, permission/question relays,
/// token-history updates, etc.
fn spawn_daemon_subscription(app: &tauri::AppHandle) {
    let app_handle = app.clone();
    tauri::async_runtime::spawn(crate::daemon_link::run_app_subscription(app_handle));
}

/// Webview boot watchdog. If `frontend_ready` IPC never fires within ~6s,
/// force-navigate the main window back to the start URL. Covers: WebView2
/// showing "localhost refused to connect" when the start URL was
/// unreachable at boot (autostart racing a slow vite dev server, or just
/// no network when something upstream needed it). Retries every 5s for up
/// to 2 minutes.
fn spawn_boot_watchdog(app: &tauri::AppHandle) {
    let h = app.clone();
    let alive = app.state::<AppState>().frontend_alive.clone();
    tauri::async_runtime::spawn(async move {
        use std::sync::atomic::Ordering;
        tokio::time::sleep(std::time::Duration::from_secs(6)).await;
        // Bound by wall-clock (~2 min from boot). The main window is
        // lazy, so it usually does not exist here; only act when it
        // does - an unopened dashboard is not a stalled one.
        let mut ticks = 0u32;
        let mut acted = false;
        while !alive.load(Ordering::SeqCst) && ticks < 24 {
            ticks += 1;
            if let Some(w) = h.get_webview_window("main") {
                acted = true;
                let url = boot_start_url();
                log::warn!(
                    "main webview not ready (tick {ticks}); reloading -> {url}"
                );
                if let Ok(parsed) = url.parse::<tauri::Url>() {
                    let _ = w.navigate(parsed);
                }
            }
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        }
        if alive.load(Ordering::SeqCst) {
            if acted {
                log::info!("main webview recovered after {ticks} reload tick(s)");
            }
        } else if acted {
            log::error!("main webview never reported ready; giving up");
        }
    });
}

/// `frontend_alive` only ever latches true, so it can't see a WebView2
/// crash after boot; a stale heartbeat means the renderer died silently.
/// Recovers the same way tray's "Open Dashboard" does.
fn spawn_heartbeat_watchdog(app: &tauri::AppHandle) {
    let h = app.clone();
    let alive = app.state::<AppState>().frontend_alive.clone();
    let last_ping = app.state::<AppState>().last_frontend_ping.clone();
    tauri::async_runtime::spawn(async move {
        use std::sync::atomic::Ordering;
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(15)).await;
            let Some(w) = h.get_webview_window("main") else { continue };
            if !alive.load(Ordering::SeqCst) || !w.is_visible().unwrap_or(false) {
                continue;
            }
            let stale = last_ping
                .lock()
                .unwrap()
                .is_some_and(|t| t.elapsed() > std::time::Duration::from_secs(30));
            if !stale {
                continue;
            }
            let url = boot_start_url();
            log::warn!("main webview heartbeat stale; reloading -> {url}");
            if let Ok(parsed) = url.parse::<tauri::Url>() {
                let _ = w.navigate(parsed);
            }
            if let Some(state) = h.try_state::<AppState>() {
                *state.pending_main_nav.lock().unwrap() = Some("dashboard".to_string());
            }
        }
    });
}

/// Auto-trigger login if no session on first launch.
fn trigger_auto_login_if_needed(app: &tauri::AppHandle) {
    use crate::types::AuthState;
    let needs_login = matches!(
        *app.state::<AppState>().auth_state.lock().unwrap(),
        AuthState::NeedsLogin
    );
    if needs_login {
        let h = app.clone();
        tauri::async_runtime::spawn(async move {
            {
                *h.state::<AppState>().auth_state.lock().unwrap() = AuthState::InProgress;
            }
            let _ = h.emit("auth-progress", serde_json::json!({"stage": "starting"}));
            match crate::auth::run(h.clone()).await {
                Ok(()) => {
                    *h.state::<AppState>().auth_state.lock().unwrap() = AuthState::LoggedIn;
                    let _ = crate::scheduler::poll_once(&h, crate::scheduler::PollTrigger::Scheduled).await;
                }
                Err(e) => {
                    *h.state::<AppState>().auth_state.lock().unwrap() = AuthState::NeedsLogin;
                    log::error!("auto-login failed: {e}");
                }
            }
        });
    }
}

/// URL the main webview was originally loaded from. Mirrors what Tauri's
/// internal host serves for `WebviewUrl::App("index.html")` (the value in
/// `tauri.conf.json`). Used by the boot/heartbeat watchdogs to reload the
/// window if WebView2 ends up on an error page.
fn boot_start_url() -> String {
    if cfg!(dev) {
        "http://localhost:1420/index.html".to_string()
    } else if cfg!(target_os = "macos") || cfg!(target_os = "ios") {
        "tauri://localhost/index.html".to_string()
    } else {
        "http://tauri.localhost/index.html".to_string()
    }
}

/// Re-writes `~/.claude/settings.json` if the user already accepted hook
/// registration but on an older installer version. Heals the v1 entry
/// whose `matcher: "aiusage-taskbar"` field silently suppressed every
/// SessionStart/SessionEnd firing.
fn migrate_hook_install_if_needed(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();
    let (should_run, port) = {
        let s = state.settings.lock().unwrap();
        let stale = s.hooks_registered
            && s.hook_install_version < crate::hooks::CURRENT_INSTALL_VERSION;
        (stale, s.hook_port)
    };
    if !should_run { return; }
    let Some(port) = port else { return };
    if let Err(e) = crate::hooks::install(crate::hooks::HookConfig { port }) {
        log::warn!("hook install migration failed: {e}");
        return;
    }
    let snapshot = {
        let mut g = state.settings.lock().unwrap();
        g.hook_install_version = crate::hooks::CURRENT_INSTALL_VERSION;
        g.clone()
    };
    if let Ok(path) = paths::settings_file() {
        let _ = crate::settings::save(&path, &snapshot);
    }
    let _ = app.emit("settings-changed", snapshot);
    log::info!(
        "hook install migrated to v{}",
        crate::hooks::CURRENT_INSTALL_VERSION
    );
}

/// Migration v2: characters are now per-SESSION, not per-project. Convert any
/// `Avatar::Character` entries back to `Avatar::None` so projects no longer
/// carry a character assignment. `Avatar::Emoji` and `Avatar::Image` are left
/// untouched. Guarded by `Settings.extra["characterBackfillVersion"]` so it
/// runs once per install.
fn backfill_project_characters_if_needed(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();
    let needs = {
        let s = state.settings.lock().unwrap();
        let cur = s
            .extra
            .get("characterBackfillVersion")
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as u32;
        cur < crate::characters::assign::CURRENT_BACKFILL_VERSION
    };
    if !needs {
        return;
    }
    let snapshot = {
        let mut g = state.settings.lock().unwrap();
        let mut cleared = 0usize;
        for proj in &mut g.projects {
            if matches!(proj.avatar, crate::types::Avatar::Character(_)) {
                proj.avatar = crate::types::Avatar::None;
                cleared += 1;
            }
        }
        g.extra.insert(
            "characterBackfillVersion".into(),
            serde_json::json!(crate::characters::assign::CURRENT_BACKFILL_VERSION),
        );
        log::info!("character migration v2: cleared character avatar from {cleared} project(s)");
        g.clone()
    };
    if let Ok(path) = paths::settings_file() {
        let _ = crate::settings::save(&path, &snapshot);
    }
    let _ = app.emit("settings-changed", snapshot);
}

/// Background loop that polls for new releases every 6h, doing nothing or
/// auto-installing depending on the current `autoUpdate` setting. Lives for the
/// app lifetime so toggling the setting from the UI takes effect on the next
/// tick (no restart required).
#[cfg(not(dev))]
async fn auto_update_loop(app: tauri::AppHandle) {
    use crate::types::AutoUpdateMode;
    // Brief warmup so we don't hammer the network before the first usage poll.
    tokio::time::sleep(std::time::Duration::from_secs(30)).await;
    let mut did_startup_check = false;
    loop {
        let mode = app.state::<AppState>().settings.lock().unwrap().auto_update;
        match mode {
            AutoUpdateMode::Never => {}
            AutoUpdateMode::OnStartup => {
                if !did_startup_check {
                    let _ = crate::ipc::update::run_update_check(&app, false).await;
                }
            }
            AutoUpdateMode::Immediate => {
                let _ = crate::ipc::update::run_update_check(&app, true).await;
            }
        }
        did_startup_check = true;
        tokio::time::sleep(std::time::Duration::from_secs(6 * 3600)).await;
    }
}

#[cfg(dev)]
async fn auto_update_loop(_app: tauri::AppHandle) {
    // Updater is disabled in dev builds; loop body is a no-op.
}
