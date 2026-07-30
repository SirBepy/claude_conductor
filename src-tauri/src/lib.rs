pub mod accounts;
pub mod channels;
pub mod characters;
pub mod context_status;
pub mod daemon;
pub mod daemon_client;
mod daemon_link;
pub mod files;
pub mod chat;
pub mod auth;
pub mod hooks;
pub mod mcp;
pub mod news;
pub mod notifications;
pub mod history;
pub mod ipc;
pub mod meeting;
pub mod scheduler;
pub mod scraping;
pub mod sessions;
pub mod settings;
pub mod shutdown_guard;
pub mod skill_usage;
pub mod slash;
pub mod state;
pub mod storage;
pub mod system_control;
pub mod tokens;
pub mod tray;
pub mod types;
pub mod util;
pub mod when_done;

use crate::settings::paths;
use crate::state::AppState;
use crate::types::AuthState;
use crate::auth::session;
use tauri::Emitter;
use tauri::Manager;

/// Initialize logging for the detached daemon process. The daemon is spawned
/// detached with no console, so without an explicit file target its log output
/// goes nowhere - which is why an unexpected daemon exit leaves no trail. Writes
/// to `<app-data>/daemon.log` (append). `RUST_LOG` overrides the default `info`
/// level. Best-effort: falls back to stderr if the file can't be opened, never
/// panics. Safe to call once at daemon startup.
fn init_daemon_file_logger() {
    let log_path = paths::data_dir().ok().map(|dir| dir.join("daemon.log"));

    // Panic hook: writes directly to the log file instead of going through the
    // logger (avoids a potential mutex deadlock if the panic happened inside the
    // logger). This is the only reliable way to capture daemon panics given that
    // stderr is discarded for the detached, console-less process.
    if let Some(path) = log_path.clone() {
        let orig = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            use std::io::Write;
            if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
                let ts = chrono::Utc::now().to_rfc3339();
                let _ = writeln!(f, "[{ts} ERROR claude_conductor_lib] daemon PANIC: {info}");
                let _ = f.flush();
            }
            orig(info);
        }));
    }

    let file = log_path.and_then(|path| {
        std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .ok()
    });
    let mut builder =
        env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"));
    if let Some(file) = file {
        builder.target(env_logger::Target::Pipe(Box::new(file)));
    }
    let _ = builder.try_init();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // One-shot recovery of pre-rename user data (claude-usage-tauri ->
    // claude-conductor). Runs before any data access in either mode so the
    // daemon and GUI both see migrated settings/history/characters.
    paths::migrate_legacy_data_dir();

    // Daemon mode: when launched as `<exe> --daemon`, run the daemon and exit
    // before constructing the Tauri app (no window, no single-instance plugin).
    if std::env::args().any(|a| a == "--daemon") {
        init_daemon_file_logger();
        log::info!("daemon process starting (--daemon mode)");
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(4)
            .enable_all()
            .build()
            .expect("daemon tokio runtime");
        if let Err(e) = rt.block_on(crate::daemon::run_daemon_main()) {
            log::error!("daemon exited with error: {e}");
            eprintln!("daemon exited with error: {e}");
            std::process::exit(1);
        }
        log::info!("daemon process exiting cleanly");
        return;
    }
    let _ = paths::ensure_data_dir();
    match crate::characters::bundled::ensure_bundled() {
        Ok(n) if n > 0 => log::info!("characters: copied {n} bundled character(s) into app-data"),
        Ok(_) => {}
        Err(e) => log::warn!("characters: bundled copy failed: {e:#}"),
    }
    let settings_path = paths::settings_file().expect("settings path");
    let session_path = paths::session_file().expect("session path");
    let loaded_settings = settings::load(&settings_path);
    let auth = if session::load(&session_path).is_some() {
        AuthState::LoggedIn
    } else {
        AuthState::NeedsLogin
    };

    // The companion SQLite store is critical (usage history lives there); a
    // failure to open it is unrecoverable, so surface it loudly and abort.
    let state = AppState::new(loaded_settings, auth)
        .expect("failed to open companion database (companion.db)");

    #[cfg_attr(debug_assertions, allow(unused_mut))]
    let mut builder = tauri::Builder::default();

    // Release-only: prevent a second instance from launching. In dev,
    // the predev script already kills any running instance, and we want
    // `cargo tauri dev` to proceed even if a prod build is installed.
    #[cfg(not(debug_assertions))]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // Surface the dashboard on a second launch, building it if the user
            // has not opened it yet this session (main is lazy - ai_todo 143).
            crate::ipc::open_dashboard(app.clone());
        }));
    }

    builder
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .level_for("claude_conductor_lib", log::LevelFilter::Debug)
                .build(),
        )
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![]),
        ))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_clipboard::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(
            // Restore position/size/maximized but never visibility: the default
            // flags include VISIBLE, which causes the window to appear before
            // WebView2 has loaded index.html (white screen on startup when the
            // previous session quit with the window open).
            //
            // `session-overlay` persists its own position via
            // settings.extra.overlayX/Y (see ipc::save_overlay_position), and
            // the ephemeral `session-<id>` detached-chat windows (opened/closed
            // constantly, one per session) have no geometry worth remembering -
            // both would just be redundant tracked-window churn. Exclude the
            // whole `session-` prefix EXCEPT `session-chats`, the persistent
            // Chats window, which relies on window-state to restore its size
            // before first paint (see `ipc::window::build_chats_window`).
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::POSITION
                        | tauri_plugin_window_state::StateFlags::MAXIMIZED,
                )
                // `with_denylist(&["session-overlay"])` used to sit alongside
                // this filter, but the filter already rejects "session-overlay"
                // (fails both the "== session-chats" and "!starts_with(session-)"
                // arms) and both gates are checked at the same on_window_ready
                // call in tauri-plugin-window-state, which covers restore AND
                // the on_window_event listener that drives every later save -
                // so the denylist entry never excluded anything the filter
                // didn't already exclude (ai_todo 194).
                .with_filter(|label| label == "session-chats" || !label.starts_with("session-"))
                .build(),
        )
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            ipc::get_current_usage,
            ipc::get_usage_map,
            ipc::get_auth_state_map,
            ipc::get_history,
            ipc::get_settings,
            ipc::save_settings,
            ipc::auth_status,
            ipc::open_dashboard,
            ipc::open_dashboard_project,
            ipc::open_dashboard_settings_accounts,
            ipc::save_overlay_position,
            ipc::open_dashboard_account,
            ipc::open_chats_window,
            ipc::open_schedule_window,
            ipc::open_jarvis_window,
            ipc::open_chats_for_session,
            ipc::take_pending_chat_open,
            ipc::open_chats_new_chat,
            ipc::take_pending_new_chat,
            ipc::get_session_config,
            ipc::list_auto_accept,
            ipc::quit_app,
            ipc::logout,
            ipc::poll_now,
            ipc::start_login,
            ipc::read_log_file,
            ipc::get_token_history,
            ipc::get_active_sessions,
            ipc::backfill_transcripts,
            ipc::check_paths_exist,
            ipc::open_in_explorer,
            ipc::open_in_vscode,
            ipc::piper_status,
            ipc::piper_install_voice,
            ipc::piper_speak_preview,
            ipc::play_sound_preview,
            ipc::list_audio_output_devices,
            ipc::copy_logs,
            ipc::get_platform,
            ipc::get_app_version,
            ipc::get_version_info,
            ipc::pick_folder,
            ipc::create_folder,
            ipc::open_external,
            ipc::check_for_updates,
            ipc::download_and_install_update,
            ipc::install_update,
            ipc::get_update_state,
            ipc::list_projects,
            ipc::get_project,
            ipc::ensure_project,
            ipc::update_project,
            ipc::delete_project,
            ipc::set_projects_sort_by,
            ipc::spawn_channel,
            ipc::stop_channel,
            ipc::restart_channel,
            ipc::show_terminal,
            ipc::hide_terminal,
            ipc::list_channels,
            ipc::detect_obsidian_vaults,
            ipc::import_legacy_obsidian_config,
            ipc::confirm_legacy_obsidian_import,
            ipc::list_instances,
            ipc::list_instances_for_project,
            ipc::is_daemon_connected,
            ipc::phone_link,
            ipc::instance_token_stats,
            ipc::chat_drain,
            ipc::chat_drains,
            ipc::get_hook_registration_state,
            ipc::register_hooks_globally,
            ipc::skip_hook_registration,
            ipc::list_project_groups,
            ipc::project_last_activity_at,
            ipc::list_worktree_details,
            ipc::create_worktree,
            ipc::remove_worktree,
            ipc::list_claude_md_scopes,
            ipc::get_project_tech,
            ipc::get_project_icon,
            ipc::list_characters,
            ipc::assign_character,
            ipc::play_character_slot,
            ipc::character_asset_url,
            ipc::preview_character_file,
            ipc::stop_character_preview,
            ipc::get_characters_dir,
            ipc::invalidate_characters_cache,
            ipc::ensure_session_character,
            ipc::set_session_character,
            ipc::reroll_session_character,
            ipc::list_session_characters,
            ipc::get_project_whitelist,
            ipc::set_project_whitelist,
            ipc::get_default_whitelist,
            ipc::set_default_whitelist,
            ipc::resolve_whitelist_characters,
            ipc::start_session,
            ipc::send_message,
            ipc::set_session_effort,
            ipc::set_session_model,
            ipc::set_auto_accept,
            ipc::cancel_turn,
            ipc::clear_session,
            ipc::paste_image,
            ipc::paste_attachment,
            ipc::paste_attachment_from_path,
            ipc::read_attachment,
            ipc::takeover_manual,
            ipc::move_session_to_account,
            ipc::simulate_rate_limit,
            ipc::load_history,
            ipc::load_history_page,
            ipc::list_history,
            ipc::watch_session_transcript,
            ipc::unwatch_session_transcript,
            ipc::register_historical_session,
            ipc::detach_window,
            ipc::reattach_window,
            ipc::open_session_in_terminal,
            ipc::open_terminal_in_directory,
            ipc::open_in_editor,
            ipc::read_image_file,
            ipc::read_text_file,
            ipc::write_text_file,
            ipc::write_temp_image,
            ipc::reveal_file_in_explorer,
            ipc::get_git_info,
            ipc::get_git_dirty,
            ipc::get_recent_branches,
            ipc::get_commit_sync,
            ipc::get_range_files,
            ipc::get_file_diff,
            ipc::session_live_cwd,
            ipc::context_status,
            ipc::count_ai_todos,
            ipc::list_ai_todos,
            ipc::list_project_servers,
            ipc::respond_permission,
            ipc::respond_question,
            ipc::list_news,
            ipc::refresh_news,
            ipc::mark_news_read,
            ipc::mark_all_news_read,
            ipc::generate_news_summary,
            ipc::list_slash_commands,
            ipc::list_project_files,
            ipc::read_file_as_base64,
            ipc::get_skill_usage_week,
            ipc::get_skill_usage_detail,
            ipc::list_installed_skills,
            ipc::frontend_ready,
            ipc::fetch_available_models,
            ipc::probe_models_availability,
            ipc::get_storage_info,
            ipc::set_retention_policy,
            ipc::clear_dataset,
            ipc::set_remote_access_enabled,
            ipc::remote_access_status,
            ipc::regenerate_remote_token,
            ipc::remote_access_qr,
            ipc::generate_pairing_url,
            ipc::get_remote_access_token,
            ipc::list_remote_devices,
            ipc::revoke_remote_device,
            ipc::set_remote_kill_switch,
            ipc::get_remote_kill_switch,
            ipc::add_account_create,
            ipc::add_account_start_cli_login,
            ipc::add_account_check_login,
            ipc::add_account_capture_cookie,
            ipc::add_account_cancel,
            ipc::add_account_finalize,
            ipc::list_accounts,
            ipc::remove_account,
            ipc::logout_account,
            ipc::update_account,
            ipc::set_default_account,
            ipc::get_terminal_identity,
            ipc::get_account_identity,
            ipc::reauth_account,
            ipc::recapture_account_cookie,
            ipc::get_accounts_setup_prompt_state,
            ipc::dismiss_accounts_setup_prompt,
            ipc::schedule_list,
            ipc::schedule_create,
            ipc::schedule_update,
            ipc::schedule_delete,
            ipc::schedule_fire_now,
            ipc::schedule_list_external,
            ipc::push_preview,
            ipc::list_previews,
            ipc::get_preview,
            when_done::arm_when_done,
            when_done::cancel_when_done,
            when_done::get_when_done_state,
        ])
        .setup(setup_app)
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|_app_handle, _event| {});
}

/// Tauri `.setup()` callback: activation policy, tray, one-time debug-only
/// chats-window auto-open, legacy SQLite import + retention prune, and every
/// startup background loop/watcher (attachment GC, autostart sync, updater,
/// remote-access reapply, scheduler/news/slash/meeting spawns, audio-device
/// follow, token backfill, hook/character migrations, daemon subscription,
/// shutdown guard, webview boot watchdog, auto-login). Extracted out of
/// `run()`'s builder chain so `run()` isn't dominated by one ~300-line closure
/// (ai_todo 266) - pure extraction, no behavior change.
fn setup_app(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
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
        let _ = ipc::open_chats_window(app.handle().clone());
    }

    // The main dashboard window is built lazily on first open (see
    // `build_main_window`), NOT eagerly here - an eager startup window
    // flashes a white ghost frame on Windows (ai_todo 143). Usage
    // polling runs in the backend `scheduler::spawn` loop and does not
    // need this window.


    // One-time legacy import into SQLite for all three datasets. Each
    // importer renames its source to `.bak` on success, so the on-disk
    // presence of the source file is itself the idempotency gate (no
    // separate flag). The APP owns this migration for ALL datasets
    // (it controls startup order); the daemon only writes new rows.
    {
        use tauri::Manager;
        let state = app.state::<crate::state::AppState>();
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

    // Schedule chat-attachments GC: run once on startup, then every 24h.
    // Removes pasted-image directories whose mtime is older than 30 days.
    tauri::async_runtime::spawn(async move {
        loop {
            crate::ipc::chat::gc_attachments().await;
            tokio::time::sleep(std::time::Duration::from_secs(24 * 3600)).await;
        }
    });
    {
        use tauri_plugin_autostart::ManagerExt;
        let autostart_mgr = app.autolaunch();
        let state = app.state::<crate::state::AppState>();
        let desired = state.settings.lock().unwrap().autostart;
        let _ = if desired {
            autostart_mgr.enable()
        } else {
            autostart_mgr.disable()
        };
    }
    {
        use tauri::Listener;
        let h = app.handle().clone();
        app.listen("settings-changed", move |event| {
            use tauri_plugin_autostart::ManagerExt;
            let Ok(settings) = serde_json::from_str::<crate::types::Settings>(event.payload()) else { return; };
            let mgr = h.autolaunch();
            let _ = if settings.autostart { mgr.enable() } else { mgr.disable() };
        });
    }
    {
        let h = app.handle().clone();
        tauri::async_runtime::spawn(auto_update_loop(h));
    }
    // Re-apply the phone remote-access reverse proxy if the user left it
    // on. Best-effort + off-thread: a missing/disconnected tailscale just
    // logs a warning, never blocks or panics startup.
    {
        let enabled = app
            .state::<crate::state::AppState>()
            .settings
            .lock()
            .unwrap()
            .remote_access_enabled;
        crate::ipc::remote_access::reapply_on_boot(enabled);
    }
    crate::ipc::remote_access::start_tailscale_watcher(app.handle().clone());
    crate::scheduler::spawn(app.handle().clone());
    crate::news::spawn_poll_loop(app.handle().clone());
    crate::slash::watcher::spawn(app.handle().clone());
    crate::meeting::start(app.handle().clone());

    // Make a "System default" audio-output preference follow live OS
    // default-device changes. Opt-in watcher from the kit; reads the
    // current pref and re-binds the held stream when the OS default
    // shifts while no explicit device is selected.
    {
        use tauri::Manager;
        let pref_app = app.handle().clone();
        let reinit_app = app.handle().clone();
        tauri_kit_audio::spawn_default_follow(
            move || {
                pref_app
                    .state::<crate::state::AppState>()
                    .settings
                    .lock()
                    .unwrap()
                    .audio_output_device
                    .clone()
            },
            move |dev| {
                reinit_app
                    .state::<crate::state::AppState>()
                    .audio_stream
                    .reinit(dev.as_deref());
            },
        );
    }

    // Auto-backfill token history once, off the main thread. Keeps
    // the stats page populated on first launch / after new sessions.
    {
        let h = app.handle().clone();
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
    {
        let handle = app.handle().clone();
        tauri::async_runtime::spawn(async move {
            migrate_hook_install_if_needed(&handle);
        });
    }
    {
        let handle = app.handle().clone();
        tauri::async_runtime::spawn(async move {
            backfill_project_characters_if_needed(&handle);
        });
    }
    // Daemon notification subscription. Replaces the old app-side
    // hook server: the daemon now binds port 27182 and owns the
    // registry; the app subscribes for `instances_changed`,
    // permission/question relays, token-history updates, etc.
    {
        let app_handle = app.handle().clone();
        tauri::async_runtime::spawn(crate::daemon_link::run_app_subscription(app_handle));
    }
    // (Main-window hide-to-tray lives in `build_main_window`; the window
    // is built lazily on first open, so there is nothing to wire here.)

    // Windows session-end guard. Owns its own hidden window + message
    // pump on a dedicated thread so a PC shutdown is never left waiting
    // on a wedged event loop. See `shutdown_guard` for the full why.
    crate::shutdown_guard::arm(app.handle().clone());

    // Webview boot watchdog. If `frontend_ready` IPC never fires
    // within ~6s, force-navigate the main window back to the start
    // URL. Covers: WebView2 showing "localhost refused to connect"
    // when the start URL was unreachable at boot (autostart racing
    // a slow vite dev server, or just no network when something
    // upstream needed it). Retries every 5s for up to 2 minutes.
    {
        let h = app.handle().clone();
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
    // Auto-trigger login if no session on first launch.
    {
        use crate::state::AppState;
        use crate::types::AuthState;
        let needs_login = matches!(
            *app.state::<AppState>().auth_state.lock().unwrap(),
            AuthState::NeedsLogin
        );
        if needs_login {
            let h = app.handle().clone();
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
    Ok(())
}

/// URL the main webview was originally loaded from. Mirrors what Tauri's
/// internal host serves for `WebviewUrl::App("index.html")` (the value in
/// `tauri.conf.json`). Used by the boot watchdog to reload the window if
/// WebView2 ends up on an error page.
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
    use tauri::{Emitter, Manager};
    let state = app.state::<crate::state::AppState>();
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
    use tauri::{Emitter, Manager};
    let state = app.state::<crate::state::AppState>();
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
    use tauri::Manager;
    // Brief warmup so we don't hammer the network before the first usage poll.
    tokio::time::sleep(std::time::Duration::from_secs(30)).await;
    let mut did_startup_check = false;
    loop {
        let mode = app.state::<crate::state::AppState>().settings.lock().unwrap().auto_update;
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
