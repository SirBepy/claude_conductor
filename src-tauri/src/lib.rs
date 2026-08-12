mod bootstrap;
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

/// Initialize logging for the detached daemon process. The daemon is spawned
/// detached with no console, so without an explicit file target its log output
/// goes nowhere - which is why an unexpected daemon exit leaves no trail. Writes
/// to `<app-data>/daemon.log` (append). `RUST_LOG` overrides the default `info`
/// level. Best-effort: falls back to stderr if the file can't be opened, never
/// panics. Safe to call once at daemon startup.
/// Write every panic to `<app-data>/<file_name>` before the process dies.
/// Bypasses the `log` facade: a panic inside the logger would deadlock on it.
fn install_panic_hook(file_name: &str, tag: &'static str) {
    let Ok(path) = paths::data_dir().map(|dir| dir.join(file_name)) else { return };
    let orig = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        use std::io::Write;
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
            let ts = chrono::Utc::now().to_rfc3339();
            let thread = std::thread::current();
            let who = thread.name().unwrap_or("<unnamed>");
            let _ = writeln!(f, "[{ts} ERROR claude_conductor_lib] {tag} PANIC on thread '{who}': {info}");
            let _ = f.flush();
        }
        orig(info);
    }));
}

fn init_daemon_file_logger() {
    let log_path = paths::data_dir().ok().map(|dir| dir.join("daemon.log"));
    install_panic_hook("daemon.log", "daemon");

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
    // `panic = "abort"` means ONE panic anywhere kills the app instantly, and
    // until now silently: the 2026-08-05 aborts left no log, only a WER record.
    install_panic_hook("crash.log", "app");
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
            // Relaunching is the fallback when the tray is unreachable; no line
            // here means the handoff never fired.
            log::info!("single-instance: second launch handed off, surfacing dashboard");
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
            ipc::get_chat_state,
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
            ipc::restart_jarvis_session,
            ipc::clear_jarvis_context,
            ipc::freeze_session,
            ipc::unfreeze_session,
            ipc::simulate_rate_limit,
            ipc::load_history,
            ipc::load_history_page,
            ipc::load_event_detail,
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
            ipc::write_temp_html,
            ipc::reveal_file_in_explorer,
            ipc::get_git_info,
            ipc::get_git_dirty,
            ipc::get_recent_branches,
            ipc::get_commit_sync,
            ipc::get_range_files,
            ipc::get_file_diff,
            context_status::commands::session_live_cwd,
            context_status::commands::context_status,
            ipc::count_ai_todos,
            ipc::list_ai_todos,
            ipc::list_project_servers,
            ipc::respond_permission,
            ipc::respond_question,
            ipc::list_pending_prompts,
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
            ipc::frontend_ping,
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
        .setup(bootstrap::setup_app)
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|_app_handle, _event| {});
}
