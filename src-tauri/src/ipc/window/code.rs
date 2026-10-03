//! The `session-code` window: Code mode popped out of the chat window. Same
//! exists-vs-build split as `preview.rs`.

use tauri::{AppHandle, Emitter, Manager};

const LABEL: &str = "session-code";

/// Open (or focus) Code mode's own window for `session_id`. An already-open
/// one is re-pointed at the session with `code-window-set-session`.
// `(async)`: can build `session-code` - see the module doc's deadlock rule.
#[tauri::command(async)]
pub fn open_code_window(app: AppHandle, session_id: String) -> Result<(), String> {
    crate::ipc::chat::attachments::validate_session_id(&session_id)?;
    if let Some(existing) = app.get_webview_window(LABEL) {
        super::activation::before_show(&app, LABEL);
        let _ = existing.show();
        let _ = existing.unminimize();
        existing.set_focus().map_err(|e| e.to_string())?;
        let _ = app.emit("code-window-set-session", serde_json::json!({ "sessionId": session_id }));
        return Ok(());
    }
    let url = format!("index.html?codewindow=1#code?session={session_id}");
    let window = tauri::WebviewWindowBuilder::new(&app, LABEL, tauri::WebviewUrl::App(url.clone().into()))
        .title(super::test_title("Code"))
        .inner_size(1280.0, 820.0)
        .min_inner_size(520.0, 360.0)
        .resizable(true)
        .visible(false)
        .background_color(tauri::window::Color(22, 21, 31, 255))
        .build()
        .map_err(|e| e.to_string())?;
    // The titlebar X hides rather than destroys (like every secondary window),
    // so the chat window learns Code mode is no longer popped from this event.
    super::attach_hide_to_tray_with(&window, |app| {
        let _ = app.emit("code-window-closed", serde_json::json!({}));
    });
    crate::ipc::ready::watch(&app, LABEL, &url);
    Ok(())
}

/// Hide Code mode's window (its dock-back path), if open.
#[tauri::command]
pub async fn close_code_window(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(LABEL) {
        win.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Bring one of the app's own windows to the front: the back pill in Code
/// mode's window raising the chat window it came from. Limited to the app's
/// window labels so a caller can't name anything else.
#[tauri::command]
pub async fn focus_app_window(app: AppHandle, label: String) -> Result<(), String> {
    if label != "main" && !label.starts_with("session-") {
        return Err(format!("not an app window: {label}"));
    }
    let win = app.get_webview_window(&label).ok_or_else(|| format!("no window {label}"))?;
    super::activation::before_show(&app, &label);
    let _ = win.show();
    let _ = win.unminimize();
    win.set_focus().map_err(|e| e.to_string())
}
