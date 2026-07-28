//! Window and chat-window-opening commands. Extracted from `misc.rs`
//! (ai_todo 101). Owns the `session-chats` window lifecycle plus the
//! dashboard-surfacing and pending-open handoff commands.
//!
//! # Every command that can reach a `build_*_window` MUST be `#[tauri::command(async)]`
//!
//! Tauri runs a plain `#[tauri::command] fn` on the main/event-loop thread -
//! for a webview-initiated call, that means *inside* the calling window's
//! WebView2 IPC callback. `WebviewWindowBuilder::build()` blocks until the
//! event loop has created the new webview, so building from there deadlocks
//! the event loop against itself: no window ever appears and the entire app
//! (tray, dashboard, chats) is permanently frozen, only killable.
//!
//! `#[tauri::command(async)]` on a sync fn runs the body on the async runtime
//! instead ("sync_threadpool"), so `build()` dispatches to a *free* event loop
//! and returns normally. It keeps the plain-fn signature, so the direct Rust
//! call sites (`lib.rs`'s setup, `tray::menu`) are unaffected - those already
//! run outside a webview callback and were never at risk.
//!
//! `ipc::chat::lifecycle::detach_window` is the same rule expressed as a true
//! `async fn`; it has always worked for exactly this reason.

use std::sync::atomic::Ordering;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};

/// In debug builds (`cargo tauri dev`) prefix a window title with "Test - " so
/// the dev/test build is unmistakable next to a real install. Release builds
/// (`cargo tauri build`) return the title unchanged.
pub(crate) fn test_title(base: &str) -> String {
    if cfg!(debug_assertions) {
        format!("Test - {base}")
    } else {
        base.to_string()
    }
}

/// Show + focus an already-built main window.
pub fn surface_main(w: &tauri::WebviewWindow) {
    let _ = w.show();
    let _ = w.unminimize();
    let _ = w.set_focus();
}

/// Whether the main window's webview has actually finished its first
/// navigation (see `AppState::main_window_loaded`). Fails open (`true`) if
/// state isn't available, matching the existing `frontend_alive` fallback
/// pattern below - state is only ever missing during early startup, before
/// any window could exist to show.
fn main_window_loaded(app: &AppHandle) -> bool {
    app.try_state::<crate::state::AppState>()
        .map(|s| s.main_window_loaded.load(Ordering::SeqCst))
        .unwrap_or(true)
}

/// Show + focus `w` only if its webview has finished loading at least once.
/// Guards every "window already exists" branch below: a `main` window that
/// was just built (see `build_main_window`) exists as soon as `.build()`
/// returns, well before its `on_page_load` "Finished" event fires. Calling
/// `surface_main` unconditionally in that window would force a still-loading,
/// unpainted webview visible - producing a blank white window that swallows
/// input until the user notices and re-triggers a show (ai_todo-095 ghost
/// dashboard bug). When not yet loaded, this is a no-op: `build_main_window`'s
/// own `on_page_load` handler shows the window itself once loading finishes.
fn surface_main_if_ready(app: &AppHandle, w: &tauri::WebviewWindow) {
    if main_window_loaded(app) {
        surface_main(w);
    }
}

/// Hide-to-tray on close instead of destroying. A destroyed window means every
/// reopen is a cold webview boot; a hidden one reopens instantly with its state
/// intact. Real quit (tray menu) sets should_quit and passes.
fn attach_hide_to_tray(window: &tauri::WebviewWindow) {
    let w = window.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            let quitting = w
                .app_handle()
                .try_state::<crate::state::AppState>()
                .map(|s| s.should_quit.load(Ordering::SeqCst))
                .unwrap_or(false);
            if quitting {
                return;
            }
            api.prevent_close();
            let _ = w.hide();
        }
    });
}

/// Shared body for every `open_dashboard*` command below: surface `main` and
/// emit `event`/`payload` to it if the webview is already alive, queue
/// `pending` into `AppState.pending_main_nav` for `frontend_ready` to drain if
/// it's still loading, or lazily build `main` with `pending` queued if it
/// doesn't exist yet. Collapses the four near-identical surface-or-build
/// blocks that used to be copy-pasted across these commands (ai_todo 311) -
/// each one differed only in `event`/`payload`/`pending`. Does NOT change the
/// `surface_main_if_ready` guard (ai_todo-095) or the `frontend_alive` /
/// `pending_main_nav` cold-boot queue path (`frontend_ready` in `misc.rs`).
fn surface_main_with_nav(
    app: &AppHandle,
    event: &str,
    payload: impl serde::Serialize + Clone,
    pending: String,
) {
    if let Some(w) = app.get_webview_window("main") {
        surface_main_if_ready(app, &w);
        let alive = app
            .try_state::<crate::state::AppState>()
            .map(|s| s.frontend_alive.load(Ordering::SeqCst))
            .unwrap_or(true);
        if alive {
            let _ = w.emit(event, payload);
        } else if let Some(state) = app.try_state::<crate::state::AppState>() {
            // Webview is still loading; queue for frontend_ready to drain.
            *state.pending_main_nav.lock().unwrap() = Some(pending);
        }
    } else {
        // Not built yet (main is lazy - see build_main_window). Build it with
        // the nav queued for frontend_ready to drain once the SPA mounts.
        let _ = build_main_window(app, Some(&pending));
    }
}

// `(async)`: lazily builds `main` - see the module doc's deadlock rule.
#[tauri::command(async)]
pub fn open_dashboard(app: AppHandle) {
    surface_main_with_nav(&app, "navigate-to-dashboard", (), "dashboard".to_string());
}

/// Surfaces the main dashboard window and tells it to navigate to a specific
/// project's detail page. Called from the chats window's per-chat menu so the
/// user can jump to a project's dashboard view without leaving the chat
/// window's process (it stays open in the background).
// `(async)`: lazily builds `main` - see the module doc's deadlock rule.
#[tauri::command(async)]
pub fn open_dashboard_project(app: AppHandle, cwd: String) {
    let pending = format!("project:{cwd}");
    surface_main_with_nav(&app, "navigate-to-project", cwd, pending);
}

/// Surfaces the main dashboard window and tells it to navigate to the
/// accounts settings page. Called from the chats window's "Add account" link
/// (model-effort-modal) so the account picker never routes the settings view
/// into the chats window's own router - that trapped users there with no way
/// back to the chat view (regression introduced in 0.2.6/0.2.7).
// `(async)`: lazily builds `main` - see the module doc's deadlock rule.
#[tauri::command(async)]
pub fn open_dashboard_settings_accounts(app: AppHandle) {
    surface_main_with_nav(
        &app,
        "navigate-to-settings-accounts",
        (),
        "settings-accounts".to_string(),
    );
}

/// Surfaces the main dashboard window and focuses it on a specific account.
/// Called from an overlay card click (overlay.ts) so tapping an account in the
/// floating overlay jumps straight to that account's dashboard view. Mirrors
/// `open_dashboard_project`: emit `navigate-to-account` if the webview is live,
/// else queue `account:<id>` for `frontend_ready` to drain on cold boot.
// `(async)`: lazily builds `main` - see the module doc's deadlock rule. Called
// from the overlay webview, so this one is a live deadlock path whenever the
// dashboard window hasn't been built yet.
#[tauri::command(async)]
pub fn open_dashboard_account(app: AppHandle, account_id: String) {
    let pending = format!("account:{account_id}");
    surface_main_with_nav(&app, "navigate-to-account", account_id, pending);
}

/// Build the main dashboard window (label `main`) lazily, on first open, rather
/// than eagerly at startup. An eagerly-created window (whether via
/// `tauri.conf.json app.windows` or in `setup()`) is the process's first window
/// and Windows briefly shows + activates it while WebView2 initialises its
/// controller, painting a white "ghost"/flash frame even with `visible(false)`
/// - and that internal show cannot be intercepted (ai_todo 143). Building it
/// on demand, after the desktop has settled, sidesteps the whole problem (the
/// chats window has never had the bug for the same reason). Usage polling does
/// NOT depend on this window: `scheduler::spawn` runs an independent backend
/// poll loop, so the dashboard webview is purely UI.
///
/// Built hidden and shown + focused only after the page finishes loading (via
/// `on_page_load`), so the first open shows the rendered dashboard, never a
/// white webview-boot frame. `nav` queues a navigation (e.g. `"project:<cwd>"`)
/// for `frontend_ready` to drain once the SPA mounts; pass `None` for the
/// default dashboard view.
pub fn build_main_window(app: &AppHandle, nav: Option<&str>) -> Result<(), String> {
    use std::sync::atomic::AtomicBool;
    use tauri::webview::PageLoadEvent;
    if let (Some(nav), Some(state)) = (nav, app.try_state::<crate::state::AppState>()) {
        *state.pending_main_nav.lock().unwrap() = Some(nav.to_string());
    }
    let shown = Arc::new(AtomicBool::new(false));
    let window =
        tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::App("index.html".into()))
            .title(test_title("Claude Conductor"))
            .inner_size(520.0, 720.0)
            // Config used minWidth only (no min height); 200 is a harmless floor
            // well below the 720 default. The builder needs both dimensions.
            .min_inner_size(360.0, 200.0)
            .resizable(true)
            .decorations(true)
            .visible(false)
            .on_page_load(move |w, payload| {
                if payload.event() == PageLoadEvent::Finished && !shown.swap(true, Ordering::SeqCst)
                {
                    if let Some(state) = w.app_handle().try_state::<crate::state::AppState>() {
                        state.main_window_loaded.store(true, Ordering::SeqCst);
                    }
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            })
            .build()
            .map_err(|e| e.to_string())?;
    attach_hide_to_tray(&window);
    Ok(())
}

/// Build the chats window (label `session-chats`). Built hidden so
/// tauri-plugin-window-state can restore the saved size + position before the
/// window is ever painted. Without this the window flashes briefly at the
/// inner_size default in the OS-default spot, then jumps to its remembered
/// geometry. Shown + focused only after the page finishes loading (via
/// `on_page_load`) to avoid the white flash while WebView2 initialises.
fn build_chats_window(app: &AppHandle) -> Result<(), String> {
    use std::sync::atomic::AtomicBool;
    use tauri::webview::PageLoadEvent;
    let shown = Arc::new(AtomicBool::new(false));
    let window = tauri::WebviewWindowBuilder::new(
        app,
        "session-chats",
        tauri::WebviewUrl::App("index.html?chatswindow=1#sessions".into()),
    )
    .title(test_title("Claude Chats"))
    .inner_size(1280.0, 860.0)
    .min_inner_size(600.0, 400.0)
    .resizable(true)
    .visible(false)
    // Opaque app-dark background so the first composited frame is never the
    // desktop wallpaper (see build_schedule_window). Matches --color-background.
    .background_color(tauri::window::Color(22, 21, 31, 255))
    .on_page_load(move |w, payload| {
        if payload.event() == PageLoadEvent::Finished && !shown.swap(true, Ordering::SeqCst) {
            let _ = w.show();
            let _ = w.set_focus();
        }
    })
    .build()
    .map_err(|e| e.to_string())?;
    attach_hide_to_tray(&window);
    Ok(())
}

/// Build the schedule window (label `session-schedule`). Mirrors
/// `build_chats_window`: built hidden, shown + focused only after the page
/// finishes loading (via `on_page_load`) to avoid the white flash while
/// WebView2 initialises.
fn build_schedule_window(app: &AppHandle) -> Result<(), String> {
    use std::sync::atomic::AtomicBool;
    use tauri::webview::PageLoadEvent;
    let shown = Arc::new(AtomicBool::new(false));
    let window = tauri::WebviewWindowBuilder::new(
        app,
        "session-schedule",
        tauri::WebviewUrl::App("index.html?schedulewindow=1#schedule".into()),
    )
    .title("Schedule")
    .inner_size(480.0, 760.0)
    .min_inner_size(380.0, 520.0)
    .resizable(true)
    .visible(false)
    // Opaque app-dark background so the first composited frame is never the
    // desktop wallpaper. The window is built hidden and shown on page-load, but
    // WebView2 can still paint a frame before `body{background}` (base.css) has
    // visually landed - most visible opening schedule first on a cold profile.
    // Matches --color-background (#16151f, void dark).
    .background_color(tauri::window::Color(22, 21, 31, 255))
    .on_page_load(move |w, payload| {
        if payload.event() == PageLoadEvent::Finished && !shown.swap(true, Ordering::SeqCst) {
            let _ = w.show();
            let _ = w.set_focus();
        }
    })
    .build()
    .map_err(|e| e.to_string())?;
    attach_hide_to_tray(&window);
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
/// A true `async fn` (every OTHER command in this file is a sync `fn` tagged
/// `#[tauri::command(async)]` instead - see the module doc). This one
/// genuinely needs to `.await` the daemon RPC before it knows which session
/// id to build the window for, and a sync fn body cannot `.await`. Tauri
/// already dispatches an `async fn` command off the main/event-loop thread on
/// its own (no `(async)` modifier needed), so `WebviewWindowBuilder::build()`
/// below is exactly as deadlock-safe as `detach_window`'s - the module doc
/// calls that fn out by name as "the same rule expressed as a true `async
/// fn`". The guard test at the bottom of this file only scans literal
/// `pub fn open_*` lines, so this fn is intentionally exempt from it.
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
        .title(test_title("Jarvis"))
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

#[cfg(test)]
mod tests {
    /// Guards the module doc's deadlock rule. A plain `#[tauri::command]` that
    /// reaches `WebviewWindowBuilder::build()` runs on the event-loop thread
    /// inside the calling window's WebView2 IPC callback and hard-freezes the
    /// entire app - `open_schedule_window` shipped that way and the Schedule
    /// window could never be opened at all. Nothing in a normal build, clippy
    /// run, or unit test observes that (it's a runtime deadlock, and only on a
    /// webview-initiated call), so assert the annotation itself: every
    /// `open_*` command in this file must be `#[tauri::command(async)]`.
    ///
    /// Scoped to `open_*` because that is exactly the set that surfaces or
    /// builds a window here; the `take_pending_*` drains touch no window and
    /// stay sync.
    #[test]
    fn every_open_command_runs_off_the_event_loop_thread() {
        let src = include_str!("window.rs");
        let lines: Vec<&str> = src.lines().collect();
        let prefix = "pub fn open_";
        let mut checked = 0;
        for (i, line) in lines.iter().enumerate() {
            if !line.starts_with(prefix) {
                continue;
            }
            let name = line.trim_end_matches(" {");
            let attr = lines[..i]
                .iter()
                .rev()
                .find(|l| l.starts_with("#[tauri::command"))
                .copied()
                .unwrap_or("<none>");
            assert_eq!(
                attr, "#[tauri::command(async)]",
                "`{name}` can surface or build a window, so it must be \
                 #[tauri::command(async)] - a plain sync command deadlocks the \
                 event loop and freezes the whole app (see the module doc). \
                 Found: {attr}"
            );
            checked += 1;
        }
        assert!(checked >= 8, "expected to check every open_* command, only saw {checked}");
    }
}

