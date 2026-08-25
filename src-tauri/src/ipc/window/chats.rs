//! The `session-chats` window: build/open, per-session focus, and the
//! new-chat handoff. Split out of `window.rs` at ai_todo 623.

use tauri::{AppHandle, Manager};

/// Build the chats window (label `session-chats`). Built hidden so
/// tauri-plugin-window-state can restore the saved size + position before the
/// window is ever painted. Without this the window flashes briefly at the
/// inner_size default in the OS-default spot, then jumps to its remembered
/// geometry. Shown + focused only once the frontend reports it's actually
/// alive (`ipc::ready`) - a finished page load alone can be WebView2's own
/// error page.
fn build_chats_window(app: &AppHandle) -> Result<(), String> {
    const URL: &str = "index.html?chatswindow=1#sessions";
    let window = tauri::WebviewWindowBuilder::new(
        app,
        "session-chats",
        tauri::WebviewUrl::App(URL.into()),
    )
    .title(super::test_title("Claude Chats"))
    .inner_size(1280.0, 860.0)
    .min_inner_size(600.0, 400.0)
    .resizable(true)
    .visible(false)
    // Opaque app-dark background so the first composited frame is never the
    // desktop wallpaper (see build_schedule_window). Matches --color-background.
    .background_color(tauri::window::Color(22, 21, 31, 255))
    .build()
    .map_err(|e| e.to_string())?;
    super::attach_hide_to_tray(&window);
    crate::ipc::ready::watch(app, "session-chats", URL);
    Ok(())
}

// `(async)`: can build `session-chats` - see the module doc's deadlock rule.
// Masked in practice because `lib.rs`'s setup builds that window at startup and
// hide-to-tray keeps it alive, so the build branch below rarely runs.
#[tauri::command(async)]
pub fn open_chats_window(app: AppHandle) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window("session-chats") {
        let _ = existing.show();
        let _ = existing.unminimize();
        existing.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }
    build_chats_window(&app)
}

/// Open (or focus) the chats window and tell it to surface a specific session.
/// `mode` is "live" (select the running session) or "history" (open it
/// read-only in the History view). When the window already exists we emit
/// `chats-open-session` for its live listener; when it must be created fresh we
/// stash the request in `AppState.pending_chat_open` for the window to drain on
/// boot (the freshly-built webview can't reliably catch an event emitted before
/// its listener mounts).
// `(async)`: can build `session-chats` - see the module doc's deadlock rule.
#[tauri::command(async)]
pub fn open_chats_for_session(app: AppHandle, session_id: String, mode: String) -> Result<(), String> {
    use tauri::Emitter;
    if let Some(existing) = app.get_webview_window("session-chats") {
        let _ = existing.show();
        let _ = existing.unminimize();
        existing.set_focus().map_err(|e| e.to_string())?;
        let _ = app.emit(
            "chats-open-session",
            serde_json::json!({ "sessionId": session_id, "mode": mode }),
        );
        return Ok(());
    }
    if let Some(state) = app.try_state::<crate::state::AppState>() {
        if let Ok(mut pending) = state.pending_chat_open.lock() {
            *pending = Some((session_id, mode));
        }
    }
    build_chats_window(&app)
}

/// Drain the pending "open this session" request (set by `open_chats_for_session`
/// when it creates the window). Returns `(session_id, mode)` or null.
#[tauri::command]
pub fn take_pending_chat_open(app: AppHandle) -> Option<(String, String)> {
    let state = app.try_state::<crate::state::AppState>()?;
    let mut pending = state.pending_chat_open.lock().ok()?;
    pending.take()
}

/// Full session config for a new chat launched from the Chats-window "+"
/// (`open_chats_new_chat`). Carries every field the model/effort modal's
/// `SessionConfig` produces - `model`/`effort` plus `account_id`/`auto_accept`/
/// `remote`/`character_id` - through the pending-drain/live-event handoff so
/// none of them get silently dropped in favor of daemon-side defaults
/// (ai_todo 163; previously a lossy 4-field tuple).
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingNewChat {
    pub project_path: String,
    pub project_name: String,
    pub model: String,
    pub effort: String,
    pub account_id: Option<String>,
    pub auto_accept: Option<bool>,
    pub remote: Option<bool>,
    pub character_id: Option<String>,
}

/// Open (or focus) the chats window and tell it to start a new chat for a
/// project with the given model/effort/account/auto-accept/remote/character
/// config. When the window already exists we emit `chats-new-chat` for its
/// live listener; when it must be created fresh we stash the request in
/// `AppState.pending_new_chat` for the window to drain on boot.
// `(async)`: can build `session-chats` - see the module doc's deadlock rule.
#[tauri::command(async)]
pub fn open_chats_new_chat(
    app: AppHandle,
    project_path: String,
    project_name: String,
    model: String,
    effort: String,
    account_id: Option<String>,
    auto_accept: Option<bool>,
    remote: Option<bool>,
    character_id: Option<String>,
) -> Result<(), String> {
    use tauri::Emitter;
    let payload = PendingNewChat {
        project_path,
        project_name,
        model,
        effort,
        account_id,
        auto_accept,
        remote,
        character_id,
    };
    if let Some(existing) = app.get_webview_window("session-chats") {
        let _ = existing.show();
        let _ = existing.unminimize();
        existing.set_focus().map_err(|e| e.to_string())?;
        let _ = app.emit("chats-new-chat", &payload);
        return Ok(());
    }
    if let Some(state) = app.try_state::<crate::state::AppState>() {
        if let Ok(mut pending) = state.pending_new_chat.lock() {
            *pending = Some(payload);
        }
    }
    build_chats_window(&app)
}

/// Drain the pending "start a new chat" request (set by `open_chats_new_chat`
/// when it creates the window). Returns the full `PendingNewChat` config or null.
#[tauri::command]
pub fn take_pending_new_chat(app: AppHandle) -> Option<PendingNewChat> {
    let state = app.try_state::<crate::state::AppState>()?;
    let mut pending = state.pending_new_chat.lock().ok()?;
    pending.take()
}
