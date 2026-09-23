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
        super::activation::before_show(&app, label);
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
    attach_dock_back_on_close(&window, session_id);
    crate::ipc::ready::watch(app, "session-preview", &url);
    Ok(())
}

/// Hide-to-tray on close like `attach_hide_to_tray`, plus the event that tells
/// the docked rail its pop-out is gone (Joe, 2026-09-23: the titlebar X puts
/// the preview back in the chat window). Without the event the frontend's
/// `cc_preview_panel_popped:<id>` flag outlives the window, and the rail then
/// refuses to show in BOTH places - preview becomes unreachable.
///
/// Fires for `close_preview_window`'s programmatic close too. That is fine:
/// the rail re-derives its open state from storage, which the pop-out writes
/// before asking for the close.
fn attach_dock_back_on_close(window: &tauri::WebviewWindow, session_id: &str) {
    let w = window.clone();
    let sid = session_id.to_string();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            let app = w.app_handle();
            let quitting = app
                .try_state::<crate::state::AppState>()
                .map(|s| s.should_quit.load(std::sync::atomic::Ordering::SeqCst))
                .unwrap_or(false);
            if quitting {
                return;
            }
            api.prevent_close();
            let _ = w.hide();
            let _ = app.emit(
                "preview-window-docked",
                serde_json::json!({ "sessionId": sid }),
            );
            super::activation::sync(app);
        }
    });
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
