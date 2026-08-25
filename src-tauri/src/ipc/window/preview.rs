//! The `session-preview` pop-out window: build/open/close. Split out of
//! `window.rs` at ai_todo 623.

use tauri::{AppHandle, Emitter, Manager};

/// Open (or focus) the preview pop-out window (todo 290), scoped to
/// `session_id`. Mirrors `open_chats_for_session`'s exists-vs-build split.
// `(async)`: can build `session-preview` - see the module doc's deadlock rule.
#[tauri::command(async)]
pub fn open_preview_window(app: AppHandle, session_id: String) -> Result<(), String> {
    crate::ipc::chat::attachments::validate_session_id(&session_id)?;
    let label = "session-preview";
    if let Some(existing) = app.get_webview_window(label) {
        let _ = existing.show();
        let _ = existing.unminimize();
        existing.set_focus().map_err(|e| e.to_string())?;
        let _ = app.emit(
            "preview-window-set-session",
            serde_json::json!({ "sessionId": session_id }),
        );
        return Ok(());
    }
    build_preview_window(&app, &session_id)
}

/// Build the preview pop-out window (label `session-preview`). Mirrors
/// `build_chats_window`: built hidden, shown + focused only once the
/// frontend reports it's actually alive (`ipc::ready`).
fn build_preview_window(app: &AppHandle, session_id: &str) -> Result<(), String> {
    let url = format!("index.html?previewwindow=1#preview?session={session_id}");
    let window = tauri::WebviewWindowBuilder::new(
        app,
        "session-preview",
        tauri::WebviewUrl::App(url.clone().into()),
    )
    .title(super::test_title("Preview"))
    .inner_size(900.0, 700.0)
    .min_inner_size(420.0, 320.0)
    .resizable(true)
    .visible(false)
    .background_color(tauri::window::Color(22, 21, 31, 255))
    .build()
    .map_err(|e| e.to_string())?;
    super::attach_hide_to_tray(&window);
    crate::ipc::ready::watch(app, "session-preview", &url);
    Ok(())
}

/// Close the preview pop-out window (todo 290's dock-back path), if open.
/// Command-based (not the JS window-close API), same shape as
/// `reattach_window`. Never builds, so stays a plain sync command.
#[tauri::command]
pub fn close_preview_window(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("session-preview") {
        win.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}
