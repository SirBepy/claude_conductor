//! Window and chat-window-opening commands, extracted from `misc.rs`
//! (ai_todo 101) and split into one file per window type (ai_todo 623):
//! `chats`, `schedule`, `jarvis`, `preview`, plus this file's shared helpers.
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
use tauri::{AppHandle, Emitter, Manager};

pub mod chats;
pub mod jarvis;
pub mod preview;
pub mod schedule;

// Glob re-exports (not a named shim - see the tauri::command gotcha) so
// pre-split callers (bootstrap.rs, tray::menu, state.rs) keep resolving via
// `ipc::window::*`; `generate_handler!` in lib.rs uses real paths instead.
pub use chats::*;
pub use jarvis::*;
pub use preview::*;
pub use schedule::*;

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
/// returns, well before its `ipc::ready` heartbeat gate fires. Calling
/// `surface_main` unconditionally in that window would force a still-loading,
/// unpainted webview visible - producing a blank white window that swallows
/// input until the user notices and re-triggers a show (ai_todo-095 ghost
/// dashboard bug). When not yet loaded, `ipc::ready::mark_ready` shows it once alive.
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
/// Built hidden and shown + focused only once the frontend reports it's
/// actually alive (`ipc::ready`) - not just page-load-finished, which can
/// be WebView2's own error page (ai_todo 786). `nav` queues a navigation.
pub fn build_main_window(app: &AppHandle, nav: Option<&str>) -> Result<(), String> {
    const URL: &str = "index.html";
    if let (Some(nav), Some(state)) = (nav, app.try_state::<crate::state::AppState>()) {
        *state.pending_main_nav.lock().unwrap() = Some(nav.to_string());
    }
    let window =
        tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::App(URL.into()))
            .title(test_title("Claude Conductor"))
            .inner_size(520.0, 720.0)
            // Config used minWidth only (no min height); 200 is a harmless floor
            // well below the 720 default. The builder needs both dimensions.
            .min_inner_size(360.0, 200.0)
            .resizable(true)
            .decorations(true)
            .visible(false)
            .build()
            .map_err(|e| {
                log::error!("build_main_window FAILED: {e}");
                e.to_string()
            })?;
    log::info!("build_main_window: built (hidden until ready heartbeat)");
    attach_hide_to_tray(&window);
    crate::ipc::ready::watch(app, "main", URL);
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
    /// `open_*` command across this split must be `#[tauri::command(async)]`.
    ///
    /// Scoped to `open_*` because that is exactly the set that surfaces or
    /// builds a window here; the `take_pending_*` drains touch no window and
    /// stay sync. Scans every file in the split (this one plus each window
    /// type's own file) since the check used to be a single-file scan before
    /// ai_todo 623.
    fn check_file(src: &str, checked: &mut usize) {
        let lines: Vec<&str> = src.lines().collect();
        let prefix = "pub fn open_";
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
            *checked += 1;
        }
    }

    #[test]
    fn every_open_command_runs_off_the_event_loop_thread() {
        let mut checked = 0;
        check_file(include_str!("mod.rs"), &mut checked);
        check_file(include_str!("chats.rs"), &mut checked);
        check_file(include_str!("schedule.rs"), &mut checked);
        check_file(include_str!("jarvis.rs"), &mut checked);
        check_file(include_str!("preview.rs"), &mut checked);
        assert!(checked >= 8, "expected to check every open_* command, only saw {checked}");
    }
}
