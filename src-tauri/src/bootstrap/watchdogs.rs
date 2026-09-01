//! Webview boot/heartbeat watchdogs, extracted from `bootstrap.rs`
//! (ai_todo 552) - pure move, no behavior change.

use crate::state::AppState;
use tauri::Manager;

/// `frontend_alive` only ever latches true, so it can't see a WebView2
/// crash after boot; a stale heartbeat means the renderer died silently.
/// Also catches a paint-stall (JS alive, compositor stuck - Windows ghosts
/// the window, killing even native drag/close), gated on focus since
/// Chromium legitimately pauses rAF while occluded. Recovers the same way
/// tray's "Open Dashboard" does, escalating to a reload if that doesn't work.
pub(super) fn spawn_heartbeat_watchdog(app: &tauri::AppHandle) {
    let h = app.clone();
    let alive = app.state::<AppState>().frontend_alive.clone();
    let last_ping = app.state::<AppState>().last_frontend_ping.clone();
    let last_raf = app.state::<AppState>().last_frontend_raf.clone();
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
            if stale {
                reload_main(&h, &w);
                continue;
            }
            let raf_stale = w.is_focused().unwrap_or(false)
                && last_raf.lock().unwrap().1.elapsed() > std::time::Duration::from_secs(25);
            if !raf_stale {
                continue;
            }
            log::warn!("main webview focused but not presenting frames; trying show/focus kick");
            crate::ipc::window::surface_main(&w);
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
            let recovered = last_raf.lock().unwrap().1.elapsed() < std::time::Duration::from_secs(5);
            if !recovered {
                log::warn!("show/focus kick did not recover; reloading");
                reload_main(&h, &w);
            }
        }
    });
}

fn reload_main(h: &tauri::AppHandle, w: &tauri::WebviewWindow) {
    let url = boot_start_url();
    log::warn!("main webview heartbeat stale; reloading -> {url}");
    if let Ok(parsed) = url.parse::<tauri::Url>() {
        let _ = w.navigate(parsed);
    }
    if let Some(state) = h.try_state::<AppState>() {
        *state.pending_main_nav.lock().unwrap() = Some("dashboard".to_string());
    }
}

/// URL the main webview was originally loaded from. Mirrors what Tauri's
/// internal host serves for `WebviewUrl::App("index.html")` (the value in
/// `tauri.conf.json`). Used by the boot/heartbeat watchdogs to reload the
/// window if WebView2 ends up on an error page.
pub(super) fn boot_start_url() -> String {
    if cfg!(dev) {
        "http://localhost:1420/index.html".to_string()
    } else if cfg!(target_os = "macos") || cfg!(target_os = "ios") {
        "tauri://localhost/index.html".to_string()
    } else {
        "http://tauri.localhost/index.html".to_string()
    }
}
