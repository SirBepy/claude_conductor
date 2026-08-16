//! The singleton `session-jarvis` window: get-or-spawn plus build. Split out
//! of `window.rs` at ai_todo 623.

use std::sync::Arc;
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Manager};

/// Get-or-focus the singleton Jarvis window (todo 272). Fixed label
/// `session-jarvis` regardless of which real session id backs it - unlike
/// `detach_window`'s per-session `session-<id>` label, there is only ever one
/// Jarvis window. By design (Joe's binding decision) Jarvis lives ONLY in
/// this dedicated window: it never appears in the Chats sidebar (see
/// `sessions/sidebar.ts`'s jarvis/worker_of filter) or the phone cockpit
/// (`daemon/remote_handlers.rs`).
///
/// If the window doesn't exist yet, get-or-spawns the singleton session via
/// the daemon's `ensure_jarvis_session` RPC (`daemon/methods/jarvis.rs`, todo
/// 272 chunk 1), then builds the window pointed at that real session id -
/// same `index.html#detached?session=<id>` URL shape `chat::lifecycle::detach_window`
/// uses for an ordinary popped-out chat.
///
/// A true `async fn` (every OTHER command in this split is a sync `fn` tagged
/// `#[tauri::command(async)]` instead - see the module doc). This one
/// genuinely needs to `.await` the daemon RPC before it knows which session
/// id to build the window for, and a sync fn body cannot `.await`. Tauri
/// already dispatches an `async fn` command off the main/event-loop thread on
/// its own (no `(async)` modifier needed), so `WebviewWindowBuilder::build()`
/// below is exactly as deadlock-safe as `detach_window`'s - the module doc
/// calls that fn out by name as "the same rule expressed as a true `async
/// fn`". The guard test only scans literal `pub fn open_*` lines, so this fn
/// is intentionally exempt from it.
#[tauri::command]
pub async fn open_jarvis_window(app: AppHandle) -> Result<(), String> {
    let label = "session-jarvis";
    if let Some(existing) = app.get_webview_window(label) {
        let _ = existing.show();
        let _ = existing.unminimize();
        existing.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }

    let session_id = {
        let state = app.state::<crate::state::AppState>();
        let guard = state.daemon_client.lock().await;
        let result = match guard.as_ref() {
            None => Err("daemon client not connected".to_string()),
            Some(client) => client.ensure_jarvis_session().await.map_err(|e| e.to_string()),
        };
        drop(guard);
        match result {
            Ok(id) => id,
            Err(e) => {
                // Both callers (tray menu item, sidebar nav item) previously
                // discarded this error entirely - a failed spawn (most
                // commonly `NoDefault`: no default account set with 2+
                // accounts registered) looked identical to a dead click.
                // Surface it as a native dialog so it fails loudly instead,
                // regardless of which caller triggered it or whether any
                // webview is even focused (the tray path has none).
                use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
                app.dialog()
                    .message(&e)
                    .title("Couldn't open Jarvis")
                    .kind(MessageDialogKind::Error)
                    .show(|_| {});
                return Err(e);
            }
        }
    };

    use std::sync::atomic::AtomicBool;
    use tauri::webview::PageLoadEvent;
    let url = format!("index.html#detached?session={}", session_id);
    let shown = Arc::new(AtomicBool::new(false));
    tauri::WebviewWindowBuilder::new(&app, label, tauri::WebviewUrl::App(url.into()))
        .title(super::test_title("Jarvis"))
        .inner_size(800.0, 600.0)
        .visible(false)
        .on_page_load(move |w, payload| {
            if payload.event() == PageLoadEvent::Finished && !shown.swap(true, Ordering::SeqCst) {
                let _ = w.show();
                let _ = w.set_focus();
            }
        })
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}
