//! Heartbeat watchdog for the Chats window's webview.

use crate::ipc::window::{CHATS_WINDOW_LABEL, CHATS_WINDOW_URL};
use crate::state::AppState;
use std::time::Duration;
use tauri::Manager;

/// A ping older than this means the renderer stopped running JS.
const PING_STALE: Duration = Duration::from_secs(30);
/// A focused window whose paint counter has not moved for this long is
/// ghosted: JS alive, compositor stuck.
const RAF_STALE: Duration = Duration::from_secs(25);
/// How recent the counter must be after the show/focus kick to count as recovered.
const RAF_RECOVERED: Duration = Duration::from_secs(5);

/// What one watchdog tick should do. Kept pure so the escalation rules are
/// unit-testable without a real webview.
#[derive(Debug, PartialEq)]
enum Verdict {
    Healthy,
    /// JS stopped pinging: the renderer died silently.
    Reload,
    /// Focused but not painting: try show/focus first, reload only if that fails.
    KickThenReload,
}

fn verdict(
    alive: bool,
    visible: bool,
    focused: bool,
    ping_age: Option<Duration>,
    raf_age: Duration,
) -> Verdict {
    if !alive || !visible {
        return Verdict::Healthy;
    }
    if ping_age.is_some_and(|age| age > PING_STALE) {
        return Verdict::Reload;
    }
    if focused && raf_age > RAF_STALE {
        return Verdict::KickThenReload;
    }
    Verdict::Healthy
}

/// `frontend_alive` only ever latches true, so it can't see a WebView2
/// crash after boot; a stale heartbeat means the renderer died silently.
/// Also catches a paint-stall (JS alive, compositor stuck - Windows ghosts
/// the window, killing even native drag/close), gated on focus since
/// Chromium legitimately pauses rAF while occluded. Escalates from a
/// show/focus kick to a reload. Watches the Chats window only: it is the one
/// window whose frontend pings (`src/shared/window-roles.ts`), and the ping
/// timestamp is shared, so a second pinging window would mask a dead one.
pub(super) fn spawn_heartbeat_watchdog(app: &tauri::AppHandle) {
    let h = app.clone();
    let alive = app.state::<AppState>().frontend_alive.clone();
    let last_ping = app.state::<AppState>().last_frontend_ping.clone();
    let last_raf = app.state::<AppState>().last_frontend_raf.clone();
    tauri::async_runtime::spawn(async move {
        use std::sync::atomic::Ordering;
        loop {
            tokio::time::sleep(Duration::from_secs(15)).await;
            let Some(w) = h.get_webview_window(CHATS_WINDOW_LABEL) else { continue };
            let action = verdict(
                alive.load(Ordering::SeqCst),
                w.is_visible().unwrap_or(false),
                w.is_focused().unwrap_or(false),
                last_ping.lock().unwrap().map(|t| t.elapsed()),
                last_raf.lock().unwrap().1.elapsed(),
            );
            match action {
                Verdict::Healthy => {}
                Verdict::Reload => reload_chats(&w),
                Verdict::KickThenReload => {
                    log::warn!("chats webview focused but not presenting frames; trying show/focus kick");
                    crate::ipc::window::surface_chats(&w);
                    tokio::time::sleep(Duration::from_secs(5)).await;
                    let recovered = last_raf.lock().unwrap().1.elapsed() < RAF_RECOVERED;
                    if !recovered {
                        log::warn!("show/focus kick did not recover; reloading");
                        reload_chats(&w);
                    }
                }
            }
        }
    });
}

fn reload_chats(w: &tauri::WebviewWindow) {
    let url = crate::ipc::ready::app_url(CHATS_WINDOW_URL);
    log::warn!("chats webview heartbeat stale; reloading -> {url}");
    if let Ok(parsed) = url.parse::<tauri::Url>() {
        let _ = w.navigate(parsed);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FRESH: Duration = Duration::from_secs(1);

    #[test]
    fn a_live_visible_window_with_fresh_signals_is_healthy() {
        assert_eq!(verdict(true, true, true, Some(FRESH), FRESH), Verdict::Healthy);
    }

    #[test]
    fn a_stale_ping_reloads_even_when_unfocused() {
        let stale = PING_STALE + FRESH;
        assert_eq!(verdict(true, true, false, Some(stale), FRESH), Verdict::Reload);
    }

    #[test]
    fn no_ping_yet_is_not_a_stale_ping() {
        assert_eq!(verdict(true, true, true, None, FRESH), Verdict::Healthy);
    }

    #[test]
    fn a_frozen_paint_counter_kicks_only_while_focused() {
        let frozen = RAF_STALE + FRESH;
        assert_eq!(verdict(true, true, true, Some(FRESH), frozen), Verdict::KickThenReload);
        // Chromium pauses rAF for an occluded window, so unfocused is not a stall.
        assert_eq!(verdict(true, true, false, Some(FRESH), frozen), Verdict::Healthy);
    }

    #[test]
    fn a_hidden_or_not_yet_alive_window_is_never_judged() {
        let stale = PING_STALE + FRESH;
        assert_eq!(verdict(true, false, true, Some(stale), stale), Verdict::Healthy);
        assert_eq!(verdict(false, true, true, Some(stale), stale), Verdict::Healthy);
    }

    #[test]
    fn a_stale_ping_wins_over_a_frozen_paint_counter() {
        let stale = PING_STALE + FRESH;
        assert_eq!(verdict(true, true, true, Some(stale), stale), Verdict::Reload);
    }

    #[test]
    fn the_watched_window_is_the_one_whose_frontend_pings() {
        let ts = include_str!("../../../src/shared/window-roles.ts");
        assert!(
            ts.contains(&format!("CHATS_WINDOW_LABEL = \"{CHATS_WINDOW_LABEL}\"")),
            "frontend heartbeat label drifted from the watched window"
        );
    }
}
