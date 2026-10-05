//! Builds the tray icon and its context menu; owns the render funnel.

use crate::tray::icon_render::{self as icon, IconCtx};
use crate::state::AppState;
use crate::types::{now_epoch_ms, AuthState, MuteChoice, Settings, TimedMute};
use anyhow::Result;
use std::sync::atomic::Ordering;
use tauri::image::Image;
use tauri::menu::{CheckMenuItemBuilder, Menu, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::tray::{TrayIconBuilder, TrayIconEvent, MouseButton, MouseButtonState};
use tauri::{AppHandle, Listener, Manager};

pub const TRAY_ID: &str = "main-tray";
const HOUR_SECS: u64 = 3600;

pub fn setup(app: &AppHandle) -> Result<()> {
    let initial_settings = app.state::<AppState>().settings.lock().unwrap().clone();
    let initial_update = app.state::<AppState>().update_state.lock().unwrap().clone();
    let menu = build_menu(app, &initial_settings, &initial_update)?;

    let idle_bytes = icon::render(&IconCtx { updating: false, in_meeting: false, dev: cfg!(debug_assertions) });
    let idle_icon = Image::from_bytes(&idle_bytes)?;

    let tray = TrayIconBuilder::with_id(TRAY_ID)
        .icon(idle_icon)
        .icon_as_template(false)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("Claude Conductor")
        .on_menu_event(|app, event| {
            log::info!("tray: menu event {:?}", event.id.as_ref());
            match event.id.as_ref() {
                "open" => crate::ipc::open_dashboard(app.clone()),
                "open-chats" => {
                    let h = app.clone();
                    tauri::async_runtime::spawn(async move {
                        let _ = crate::ipc::open_chats_window(h);
                    });
                }
                "show-overlay" => crate::ipc::show_overlay_from_menu(app),
                "open-jarvis" => {
                    let h = app.clone();
                    tauri::async_runtime::spawn(async move {
                        let _ = crate::ipc::open_jarvis_window(h).await;
                    });
                }
                "refresh" => {
                    let h = app.clone();
                    tauri::async_runtime::spawn(async move {
                        let _ = crate::scheduler::poll_once(&h, crate::scheduler::PollTrigger::Manual).await;
                    });
                }
                "stop-daemon" => {
                    // Explicit daemon stop. Window-close + Quit leave it running;
                    // this is the only tray control that takes it (and its
                    // sessions) down. No-op if no daemon is connected.
                    let h = app.clone();
                    tauri::async_runtime::spawn(async move {
                        let client_slot = h.state::<AppState>().daemon_client.clone();
                        let guard = client_slot.lock().await;
                        if let Some(client) = guard.as_ref() {
                            if let Err(e) = client.shutdown_daemon().await {
                                log::warn!("stop-daemon failed: {e}");
                            }
                        }
                    });
                }
                "quit" => {
                    // Chat turns run inside the detached daemon, which
                    // intentionally survives app close; nothing app-side to
                    // drain here.
                    app.exit(0);
                }
                "mute-forever" => select_mute(app.clone(), MuteChoice::Forever),
                "mute-1h" => select_mute(app.clone(), MuteChoice::Timed(HOUR_SECS)),
                "mute-3h" => select_mute(app.clone(), MuteChoice::Timed(3 * HOUR_SECS)),
                "mute-1d" => select_mute(app.clone(), MuteChoice::Timed(24 * HOUR_SECS)),
                "update-install" => {
                    crate::ipc::install_update(app.clone());
                }
                "update-download" => {
                    let h = app.clone();
                    tauri::async_runtime::spawn(async move {
                        let _ = crate::ipc::download_and_install_update(h).await;
                    });
                }
                _ => {}
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up, ..
            } = event {
                on_left_click(tray.app_handle().clone());
            }
        })
        .build(app);
    // Boot diagnostics: on 2026-08-06 the autostarted app ran healthily for 10
    // minutes with NO reachable entry point, and nothing said which link died.
    match &tray {
        Ok(_) => log::info!("tray: icon registered (id {TRAY_ID})"),
        Err(e) => log::error!("tray: icon FAILED to register: {e} - app is unreachable from the tray"),
    }
    let _tray = tray?;

    // Listener: settings-changed -> rebuild menu + re-render.
    {
        let h = app.clone();
        app.listen("settings-changed", move |_| {
            rebuild_menu_and_render(&h);
        });
    }

    // Listener: usage-updated -> re-render.
    {
        let h = app.clone();
        app.listen("usage-updated", move |_| {
            let h2 = h.clone();
            let _ = h.run_on_main_thread(move || render_tray_now(&h2));
        });
    }

    // Listener: meeting state changed -> re-render so the meeting dot
    // appears/clears as soon as the watcher flips.
    {
        let h = app.clone();
        app.listen("meeting://changed", move |_| {
            let h2 = h.clone();
            let _ = h.run_on_main_thread(move || render_tray_now(&h2));
        });
    }

    // Listener: update-state -> rebuild menu (badge label/items) + re-render badge.
    {
        let h = app.clone();
        app.listen("update-state", move |_| {
            rebuild_menu_and_render(&h);
        });
    }

    // Initial render from cached snapshot.
    render_tray_now(app);

    Ok(())
}

/// Left-click opens the chat window. The overlay it used to toggle moved to
/// the right-click menu, which offers it only while no widget host is drawing
/// our widget for us.
fn on_left_click(app: AppHandle) {
    let logged_in = matches!(
        *app.state::<AppState>().auth_state.lock().unwrap(),
        AuthState::LoggedIn
    );
    log::info!("tray: left-click received (logged_in={logged_in})");
    if !logged_in {
        // Not logged in, kick login. `start_login` exists in ipc.rs.
        tauri::async_runtime::spawn(async move {
            let _ = crate::ipc::start_login(app).await;
        });
        return;
    }
    let _ = crate::ipc::open_chats_window(app);
}

/// Rebuild the tray menu from current mute/update state and re-render the
/// icon, marshaled onto the main thread. Shared by the `settings-changed` and
/// `update-state` listeners, whose rebuild-and-render bodies were previously
/// byte-for-byte duplicated.
pub fn rebuild_menu_and_render(app: &AppHandle) {
    let h = app.clone();
    let _ = app.run_on_main_thread(move || {
        let settings = h.state::<AppState>().settings.lock().unwrap().clone();
        let update = h.state::<AppState>().update_state.lock().unwrap().clone();
        if let Ok(new_menu) = build_menu(&h, &settings, &update) {
            if let Some(tray) = h.tray_by_id(TRAY_ID) {
                let _ = tray.set_menu(Some(new_menu));
            }
        }
        render_tray_now(&h);
    });
}

pub fn render_tray_now(app: &AppHandle) {
    let state = app.state::<AppState>();
    let updating = {
        let s = state.update_state.lock().unwrap();
        matches!(s.get("state").and_then(|v| v.as_str()), Some("downloading") | Some("downloaded"))
    };
    let in_meeting = state.meeting_active.load(Ordering::Relaxed);
    let ctx = IconCtx { updating, in_meeting, dev: cfg!(debug_assertions) };

    let bytes = icon::render(&ctx);
    let Some(tray) = app.tray_by_id(TRAY_ID) else { return; };
    if let Ok(img) = Image::from_bytes(&bytes) {
        let _ = tray.set_icon(Some(img));
        #[cfg(target_os = "macos")]
        let _ = tray.set_icon_as_template(false);
    }
}

fn build_menu(app: &AppHandle, settings: &Settings, update: &serde_json::Value) -> Result<Menu<tauri::Wry>> {
    let choice = settings.mute_choice();
    let timed_check = |secs: u64| choice == Some(MuteChoice::Timed(secs));
    let mute = SubmenuBuilder::new(app, "Mute Notifications")
        .item(
            &CheckMenuItemBuilder::with_id("mute-forever", "Until I turn it back on")
                .checked(choice == Some(MuteChoice::Forever))
                .build(app)?,
        )
        .separator()
        .item(
            &CheckMenuItemBuilder::with_id("mute-1h", "1 hour")
                .checked(timed_check(HOUR_SECS))
                .build(app)?,
        )
        .item(
            &CheckMenuItemBuilder::with_id("mute-3h", "3 hours")
                .checked(timed_check(3 * HOUR_SECS))
                .build(app)?,
        )
        .item(
            &CheckMenuItemBuilder::with_id("mute-1d", "1 day")
                .checked(timed_check(24 * HOUR_SECS))
                .build(app)?,
        )
        .build()?;
    let mut builder = MenuBuilder::new(app)
        .item(&MenuItemBuilder::with_id("open", "Open Dashboard").build(app)?)
        .item(&MenuItemBuilder::with_id("open-chats", "Open Chats").build(app)?)
        .item(&MenuItemBuilder::with_id("open-jarvis", "Jarvis").build(app)?);
    // Hidden while a widget host draws our widget: that host owns the overlay
    // surface for as long as it stays connected.
    if !*app.state::<AppState>().widget_hosted.lock().unwrap() {
        builder = builder.item(&MenuItemBuilder::with_id("show-overlay", "Show overlay").build(app)?);
    }
    builder = builder
        .separator()
        .item(&MenuItemBuilder::with_id("refresh", "Refresh Now").build(app)?)
        .item(&mute);

    let state = update.get("state").and_then(|v| v.as_str()).unwrap_or("");
    let version = update.get("version").and_then(|v| v.as_str()).unwrap_or("");
    match state {
        "downloading" => {
            builder = builder.separator().item(
                &MenuItemBuilder::with_id("update-downloading", format!("Downloading update v{version}..."))
                    .enabled(false)
                    .build(app)?,
            );
        }
        "downloaded" => {
            builder = builder.separator().item(
                &MenuItemBuilder::with_id("update-install", format!("Install update v{version}"))
                    .build(app)?,
            );
        }
        "available" => {
            builder = builder.separator().item(
                &MenuItemBuilder::with_id("update-download", format!("Download update v{version}"))
                    .build(app)?,
            );
        }
        "error" => {
            builder = builder.separator().item(
                &MenuItemBuilder::with_id("update-error", "Update failed")
                    .enabled(false)
                    .build(app)?,
            );
        }
        _ => {}
    }

    let menu = builder
        .separator()
        .item(&MenuItemBuilder::with_id("stop-daemon", "Stop background daemon").build(app)?)
        .item(&MenuItemBuilder::with_id("quit", "Quit").build(app)?)
        .build()?;
    Ok(menu)
}

/// Picking the active choice again unmutes. A timed pick clears the persisted
/// `muteAll` flag, so the timer expiring returns to unmuted rather than to
/// "until I turn it back on".
fn select_mute(app: AppHandle, choice: MuteChoice) {
    use crate::settings::paths;
    use tauri::Emitter;
    let state = app.state::<AppState>();
    let (updated, deadline) = {
        let mut s = state.settings.lock().unwrap();
        let next = if s.mute_choice() == Some(choice) { None } else { Some(choice) };
        let forever = next == Some(MuteChoice::Forever);
        s.extra.insert("muteAll".into(), serde_json::Value::Bool(forever));
        s.timed_mute = match next {
            Some(MuteChoice::Timed(secs)) => Some(TimedMute {
                until_ms: now_epoch_ms() + (secs as i64) * 1000,
                secs,
            }),
            _ => None,
        };
        s.bump_generation();
        (s.clone(), s.timed_mute.map(|t| t.until_ms))
    };
    if let Ok(path) = paths::settings_file() {
        if let Err(e) = crate::settings::save(&path, &updated) {
            log::warn!("persist mute toggle failed: {e}");
        }
    }
    let _ = app.emit("settings-changed", &updated);
    if let Some(until_ms) = deadline {
        let h = app.clone();
        tauri::async_runtime::spawn(async move {
            let wait = (until_ms - now_epoch_ms()).max(0) as u64;
            tokio::time::sleep(std::time::Duration::from_millis(wait)).await;
            expire_timed_mute(&h, until_ms);
        });
    }
}

/// `until_ms` identifies the timer, so a timer superseded by a later pick
/// (or cleared by a manual unmute) finds a different deadline and does nothing.
fn expire_timed_mute(app: &AppHandle, until_ms: i64) {
    use crate::settings::paths;
    use tauri::Emitter;
    let state = app.state::<AppState>();
    let updated = {
        let mut s = state.settings.lock().unwrap();
        if s.timed_mute.map(|t| t.until_ms) != Some(until_ms) {
            return;
        }
        s.timed_mute = None;
        s.bump_generation();
        s.clone()
    };
    if let Ok(path) = paths::settings_file() {
        if let Err(e) = crate::settings::save(&path, &updated) {
            log::warn!("persist timed mute expiry failed: {e}");
        }
    }
    let _ = app.emit("settings-changed", &updated);
}
