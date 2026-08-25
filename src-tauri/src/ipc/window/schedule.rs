//! The `session-schedule` window: build/open. Split out of `window.rs` at
//! ai_todo 623.

use tauri::{AppHandle, Manager};

/// Build the schedule window (label `session-schedule`). Mirrors
/// `build_chats_window`: built hidden, shown + focused only once the
/// frontend reports it's actually alive (`ipc::ready`).
fn build_schedule_window(app: &AppHandle) -> Result<(), String> {
    const URL: &str = "index.html?schedulewindow=1#schedule";
    let window = tauri::WebviewWindowBuilder::new(
        app,
        "session-schedule",
        tauri::WebviewUrl::App(URL.into()),
    )
    .title("Schedule")
    .inner_size(480.0, 760.0)
    .min_inner_size(380.0, 520.0)
    .resizable(true)
    .visible(false)
    // Opaque app-dark background so the first composited frame is never the
    // desktop wallpaper. The window is built hidden and shown once ready, but
    // WebView2 can still paint a frame before `body{background}` (base.css) has
    // visually landed - most visible opening schedule first on a cold profile.
    // Matches --color-background (#16151f, void dark).
    .background_color(tauri::window::Color(22, 21, 31, 255))
    .build()
    .map_err(|e| e.to_string())?;
    super::attach_hide_to_tray(&window);
    crate::ipc::ready::watch(app, "session-schedule", URL);
    Ok(())
}

// `(async)` is load-bearing here, not a style choice: this command is reachable
// ONLY from a webview (the sidemenu's Schedule item and the chat view-more
// menu's "Scheduled"), and `session-schedule` is never pre-built at startup, so
// the `build_schedule_window` branch below runs on the very first open. As a
// plain sync command that build deadlocked the event loop and hard-froze the
// whole app - see the module doc.
#[tauri::command(async)]
pub fn open_schedule_window(app: AppHandle) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window("session-schedule") {
        let _ = existing.show();
        let _ = existing.unminimize();
        existing.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }
    build_schedule_window(&app)
}
