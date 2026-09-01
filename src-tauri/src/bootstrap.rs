//! Tauri `.setup()` callback and its startup-only helpers, one function per
//! independent background concern (migrations, spawned loops/watchers,
//! backfills). Extracted from `lib.rs` (ai_todo 515, following the earlier
//! `run()` extraction, ai_todo 266) - pure move, no behavior change.

mod migrations;
mod watchdogs;

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
    migrations::run_sqlite_startup_migration(&handle);

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

    watchdogs::spawn_heartbeat_watchdog(&handle);
    trigger_auto_login_if_needed(&handle);
    Ok(())
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
        // `AppState.db` is a bare `Mutex`, not an `Arc`, so the handle (which is
        // `Clone + Send`) is what crosses into the blocking thread; the state is
        // looked up on the far side.
        let backfill_handle = h.clone();
        let read_handle = h.clone();
        match tauri::async_runtime::spawn_blocking(move || {
            let state = backfill_handle.state::<AppState>();
            let mut mgr = state.db.lock().unwrap_or_else(|e| e.into_inner());
            crate::tokens::backfill_all(mgr.conn_mut())
        })
        .await
        {
            Ok(Ok(r)) => {
                log::info!(
                    "startup backfill: {} new, {} skipped (sub: {} new, {} skipped)",
                    r.processed, r.skipped, r.sub_processed, r.sub_skipped
                );
                let history = tauri::async_runtime::spawn_blocking(move || {
                    let state = read_handle.state::<AppState>();
                    let mgr = state.db.lock().unwrap_or_else(|e| e.into_inner());
                    crate::storage::token_store::get_token_records(mgr.conn(), 0).unwrap_or_default()
                })
                .await
                .unwrap_or_default();
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
        migrations::migrate_hook_install_if_needed(&handle);
    });
}

/// Spawn the one-time character-avatar backfill (see
/// `backfill_project_characters_if_needed`).
fn spawn_character_backfill_migration(app: &tauri::AppHandle) {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        migrations::backfill_project_characters_if_needed(&handle);
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
