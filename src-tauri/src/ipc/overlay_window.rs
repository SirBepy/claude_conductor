//! Multi-account milestone 06: floating overlay window. Extracted from
//! `window.rs` (ai_todo 175). Small always-on-top frameless window listing
//! every registered account's usage (5h + 7d, safe pace), toggled by a tray
//! left-click. Label `session-overlay` deliberately matches the existing
//! `session-*` capability wildcard (`capabilities/default.json`) that already
//! covers the chats window, so this window needs no capabilities edit.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::settings::{self, paths};

const OVERLAY_LABEL: &str = "session-overlay";
const OVERLAY_WIDTH: f64 = 320.0;
const OVERLAY_HEIGHT: f64 = 420.0;

/// How long a hidden overlay window is left resident (WebView2 renderer and
/// all) before being torn down outright. Recreated lazily on the next toggle
/// (`build_overlay_window` is cheap and the position is persisted via
/// `overlayX`/`overlayY`), so this trades a beat of rebuild latency on the
/// first re-open after 10 idle minutes for not keeping a renderer resident
/// forever after a single first open.
const OVERLAY_IDLE_TIMEOUT: Duration = Duration::from_secs(10 * 60);

/// Bumped on every show/hide toggle. `schedule_overlay_destroy` captures the
/// generation at spawn time; when its sleep elapses it only destroys the
/// window if the generation is still the same one it captured - i.e. nothing
/// re-toggled the overlay in the meantime. This is the cancellation mechanism
/// for a timer with no `AbortHandle` threaded through `toggle_overlay_window`.
static OVERLAY_GEN: AtomicU64 = AtomicU64::new(0);

/// Where the overlay's top-left corner should land given the tray icon's
/// screen rect and the overlay's own size: right-aligned with the icon,
/// sitting just above it (icons live in the Windows taskbar, at the bottom
/// of the screen, so "above" is the only direction that doesn't run off
/// screen for the common case). Pure — no monitor/window query — so it's
/// unit-testable; callers clamp to onscreen space is a future refinement
/// (not needed for a single-monitor primary-corner tray, which is Joe's
/// setup and the common case).
pub fn overlay_position(icon_x: f64, icon_y: f64, icon_w: f64, icon_h: f64, win_w: f64, win_h: f64) -> (f64, f64) {
    let _ = icon_h; // icon height doesn't affect placement (we sit above the icon, not beside it)
    let x = icon_x + icon_w - win_w;
    let y = icon_y - win_h;
    (x.max(0.0), y.max(0.0))
}

fn rect_physical(rect: &tauri::Rect) -> (f64, f64, f64, f64) {
    let (x, y) = match rect.position {
        tauri::Position::Physical(p) => (p.x as f64, p.y as f64),
        tauri::Position::Logical(p) => (p.x, p.y),
    };
    let (w, h) = match rect.size {
        tauri::Size::Physical(s) => (s.width as f64, s.height as f64),
        tauri::Size::Logical(s) => (s.width, s.height),
    };
    (x, y, w, h)
}

/// Build the overlay window fresh, positioned near the tray icon. Built
/// hidden and shown only once the frontend reports it's actually alive
/// (`ipc::ready`), visible here too since the window is otherwise
/// transparent (a flash would paint white, not "nothing").
fn build_overlay_window(app: &AppHandle, icon_rect: tauri::Rect) -> Result<(), String> {
    // Reopen where the user last parked it (persisted in settings by
    // save_overlay_position after a drag/flick). First-ever open, or if the
    // saved spot is gone, falls back to sitting above the tray icon.
    let (x, y) = persisted_overlay_pos(app)
        .unwrap_or_else(|| {
            let (ix, iy, iw, ih) = rect_physical(&icon_rect);
            overlay_position(ix, iy, iw, ih, OVERLAY_WIDTH, OVERLAY_HEIGHT)
        });
    let builder = tauri::WebviewWindowBuilder::new(
        app,
        OVERLAY_LABEL,
        tauri::WebviewUrl::App("overlay.html".into()),
    )
    .title(crate::ipc::window::test_title("Claude usage"))
    .inner_size(OVERLAY_WIDTH, OVERLAY_HEIGHT)
    .position(x, y)
    // Not user-resizable — the frontend sizes it to hug its content
    // (resizeOverlayToContent); set_size works regardless of this flag. This
    // stops the user grabbing an (invisible, frameless) edge to resize it.
    .resizable(false)
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .shadow(false);
    // `transparent` needs the macos-private-api feature on macOS; degrade to an
    // opaque overlay there rather than pulling in the private API.
    #[cfg(not(target_os = "macos"))]
    let builder = builder.transparent(true);
    let window = builder
    .visible(false)
    .build()
    .map_err(|e| e.to_string())?;
    // No hide-on-blur: the overlay is a persistent, draggable panel toggled
    // only by the tray icon (show on click, hide on next click — see
    // toggle_overlay_window). Hiding it the instant focus moves elsewhere is
    // exactly the "vanishes when I click anything" behaviour we're removing.
    let _ = window;
    crate::ipc::ready::watch(app, OVERLAY_LABEL, "overlay.html");
    Ok(())
}

/// The overlay's last parked top-left, in physical pixels, persisted to
/// settings by `save_overlay_position`. `None` until the user first moves it.
fn persisted_overlay_pos(app: &AppHandle) -> Option<(f64, f64)> {
    let state = app.try_state::<crate::state::AppState>()?;
    let s = state.settings.lock().ok()?;
    let x = s.extra.get("overlayX")?.as_f64()?;
    let y = s.extra.get("overlayY")?.as_f64()?;
    Some((x, y))
}

/// Persist the overlay's dragged/flicked position (physical px) so it reopens
/// in the same spot across restarts. Kept separate from `save_settings` so a
/// drag doesn't round-trip the whole settings blob; still emits
/// `settings-changed` so every window's cached settings stay coherent (else a
/// later full save from the main window would clobber the position).
#[tauri::command]
pub async fn save_overlay_position(
    x: f64,
    y: f64,
    state: State<'_, crate::state::AppState>,
    app: AppHandle,
) -> Result<(), String> {
    let updated = {
        let mut s = state.settings.lock().unwrap();
        s.extra.insert("overlayX".into(), serde_json::json!(x));
        s.extra.insert("overlayY".into(), serde_json::json!(y));
        s.clone()
    };
    let path = paths::settings_file().map_err(|e| e.to_string())?;
    settings::save(&path, &updated).map_err(|e| e.to_string())?;
    let _ = app.emit("settings-changed", updated);
    Ok(())
}

/// Tray left-click handler: show the overlay near the icon if hidden, hide
/// it if already visible (repeat-click closes, mirroring most tray flyouts).
/// Builds the window lazily on first use.
pub fn toggle_overlay_window(app: &AppHandle, icon_rect: tauri::Rect) {
    if let Some(w) = app.get_webview_window(OVERLAY_LABEL) {
        if w.is_visible().unwrap_or(false) {
            let _ = w.hide();
            schedule_overlay_destroy(app);
        } else {
            // Reopen exactly where the user left it: a hidden window keeps its
            // position, so just show it. No re-anchoring to the tray (that was
            // the old behaviour, before drag/flick + position persistence).
            // Bump the generation first so any destroy-timer left over from
            // the last hide sees a stale value and no-ops instead of tearing
            // down the window we just showed.
            OVERLAY_GEN.fetch_add(1, Ordering::SeqCst);
            let _ = w.show();
            let _ = w.set_focus();
        }
        return;
    }
    if let Err(e) = build_overlay_window(app, icon_rect) {
        log::error!("build_overlay_window failed: {e} - tray click produced no window");
    } else {
        log::info!("overlay: built on tray click");
    }
}

/// After the overlay is hidden, destroy it outright if it's still hidden
/// `OVERLAY_IDLE_TIMEOUT` later - see `OVERLAY_GEN` for how a re-show/re-hide
/// before then cancels this. Destroying (vs just hiding) frees the WebView2
/// renderer; the next toggle rebuilds the window lazily like a cold first
/// open.
fn schedule_overlay_destroy(app: &AppHandle) {
    let my_gen = OVERLAY_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(OVERLAY_IDLE_TIMEOUT).await;
        if OVERLAY_GEN.load(Ordering::SeqCst) != my_gen {
            return; // shown and/or hidden again since - this timer is stale
        }
        if let Some(w) = handle.get_webview_window(OVERLAY_LABEL) {
            if !w.is_visible().unwrap_or(true) {
                let _ = w.close();
            }
        }
    });
}

#[cfg(test)]
mod overlay_position_tests {
    use super::overlay_position;

    #[test]
    fn right_aligns_with_the_icon_and_sits_above_it() {
        // Icon near the bottom-right corner of a 1920x1080 screen.
        let (x, y) = overlay_position(1880.0, 1040.0, 24.0, 24.0, 320.0, 420.0);
        assert_eq!(x, 1880.0 + 24.0 - 320.0);
        assert_eq!(y, 1040.0 - 420.0);
    }

    #[test]
    fn clamps_to_the_top_left_when_it_would_go_offscreen() {
        // A tiny icon near the top-left corner: naive placement goes negative.
        let (x, y) = overlay_position(5.0, 5.0, 16.0, 16.0, 320.0, 420.0);
        assert_eq!(x, 0.0);
        assert_eq!(y, 0.0);
    }
}
