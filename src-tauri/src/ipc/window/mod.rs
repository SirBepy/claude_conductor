//! Window and chat-window-opening commands, extracted from `misc.rs`
//! (ai_todo 101) and split into one file per window type (ai_todo 623):
//! `chats`, `code`, `schedule`, `jarvis`, `preview`, plus this file's shared helpers.
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
//! run outside a webview callback and were never at risk. The one direct call
//! that WAS at risk is `lib.rs`'s single-instance callback, which runs inside a
//! WM_COPYDATA window proc and so defers `open_dashboard` to a blocking-pool
//! thread instead.
//!
//! `ipc::chat::lifecycle::detach_window` is the same rule expressed as a true
//! `async fn`; it has always worked for exactly this reason.

use std::sync::atomic::Ordering;
use tauri::{AppHandle, Emitter, Manager};

pub mod activation;
pub mod chats;
pub mod code;
pub mod file;
pub mod jarvis;
pub mod preview;
pub mod schedule;
mod webview_visibility;

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
    activation::before_show(w.app_handle(), w.label());
    let _ = w.show();
    let _ = w.unminimize();
    let _ = w.set_focus();
}

/// What closing a window does.
#[derive(Debug, PartialEq)]
enum ClosePolicy {
    HideToTray,
    Destroy,
}

/// The Files window holds tabs and mounted editors (each with a disk poll) that
/// are meant to live only as long as the window, so closing it destroys it and
/// the next open builds a fresh one. Every other window keeps its state hidden.
fn close_policy(label: &str) -> ClosePolicy {
    if label == file::LABEL {
        ClosePolicy::Destroy
    } else {
        ClosePolicy::HideToTray
    }
}

/// Hide-to-tray on close instead of destroying, except where `close_policy`
/// says otherwise. A destroyed window means every reopen is a cold webview
/// boot; a hidden one reopens instantly with its state intact. Real quit (tray
/// menu) sets should_quit and passes.
fn attach_hide_to_tray(window: &tauri::WebviewWindow) {
    attach_hide_to_tray_with(window, |_| {});
}

/// `attach_hide_to_tray` with one extra step, run after the hide and before
/// `activation::sync`. The preview pop-out is the only window that needs it
/// (it emits `preview-window-docked` there), and before todo 942 it carried a
/// full second copy of the should_quit/prevent_close/hide/sync body to get it -
/// so a fix to the guard or the sync had two homes and nothing named the
/// second. `on_hidden` takes the handle rather than borrowing one from the
/// closure's environment, so the caller needs no clone of its own.
fn attach_hide_to_tray_with(
    window: &tauri::WebviewWindow,
    on_hidden: impl Fn(&AppHandle) + Send + 'static,
) {
    webview_visibility::attach(window);
    let w = window.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            // Let the close through; `ipc::ready::watch`'s handler already syncs
            // the dock on CloseRequested and Destroyed.
            if close_policy(w.label()) == ClosePolicy::Destroy {
                return;
            }
            let app = w.app_handle();
            let quitting = app
                .try_state::<crate::state::AppState>()
                .map(|s| s.should_quit.load(Ordering::SeqCst))
                .unwrap_or(false);
            if quitting {
                return;
            }
            api.prevent_close();
            let _ = w.hide();
            on_hidden(app);
            activation::sync(app);
        }
    });
}

/// Shared body for the `open_dashboard*` commands below. The Chats window is
/// the app's one desktop window (Home, Schedule and Settings are screens inside
/// it, reached from its rail), so every "open the dashboard" request surfaces
/// it and routes it to `pending`. A live window gets `event`/`payload`; a window
/// that must be built first gets `pending` stashed in `AppState.pending_main_nav`
/// for its boot to drain through `take_pending_nav`, since a freshly built
/// webview cannot reliably catch an event emitted before its listeners mount.
fn surface_chats_with_nav(
    app: &AppHandle,
    event: &str,
    payload: impl serde::Serialize + Clone,
    pending: String,
) {
    if app.get_webview_window("session-chats").is_some() {
        let _ = chats::open_chats_window(app.clone());
        let _ = app.emit_to("session-chats", event, payload);
    } else {
        if let Some(state) = app.try_state::<crate::state::AppState>() {
            *state.pending_main_nav.lock().unwrap() = Some(pending);
        }
        let _ = chats::open_chats_window(app.clone());
    }
}

// `(async)`: can build `session-chats` - see the module doc's deadlock rule.
/// Surfaces the app (the tray's "Open Claude Conductor" calls
/// `open_chats_window` directly; this serves a second launch).
#[tauri::command(async)]
pub fn open_dashboard(app: AppHandle) {
    let _ = chats::open_chats_window(app);
}

/// Surfaces the chats window on a project's dashboard page. Called from the
/// main window's Home project rows; the page itself lives in the chats window
/// (`src/views/sessions/project-dashboard/dashboard-page.ts`).
// `(async)`: can build `session-chats` - see the module doc's deadlock rule.
#[tauri::command(async)]
pub fn open_dashboard_project(app: AppHandle, cwd: String) -> Result<(), String> {
    chats::open_chats_for_session(app, cwd, "project".to_string())
}

/// Surfaces the app on the accounts settings page. Called from the chat model
/// picker's "Add account" link. The settings view used to be kept out of the
/// chats window's router because that trapped users with no way back to the
/// chat view (0.2.6/0.2.7); the window's rail is that way back now.
// `(async)`: can build `session-chats` - see the module doc's deadlock rule.
#[tauri::command(async)]
pub fn open_dashboard_settings_accounts(app: AppHandle) {
    surface_chats_with_nav(
        &app,
        "navigate-to-settings-accounts",
        (),
        "settings-accounts".to_string(),
    );
}

/// Surfaces the app focused on a specific account's dashboard view. Called from
/// an overlay card click (overlay.ts). Emits `navigate-to-account` if the
/// window is live, else queues `account:<id>` for `take_pending_nav`.
// `(async)`: can build `session-chats` - see the module doc's deadlock rule.
// Called from the overlay webview, so this one is a live deadlock path
// whenever the chats window hasn't been built yet.
#[tauri::command(async)]
pub fn open_dashboard_account(app: AppHandle, account_id: String) {
    let pending = format!("account:{account_id}");
    surface_chats_with_nav(&app, "navigate-to-account", account_id, pending);
}

/// No caller builds this window any more: the Chats window is the app's one
/// desktop window and the dashboard is a screen inside it. Kept until the
/// `main` label's remaining watchdog and ready-gate hooks are removed with it.
///
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
            // Windows gets a custom in-webview title bar (window-titlebar.ts) instead
            // of the native one - see the same comment on chats.rs's builder. macOS/
            // Linux keep native decorations; nothing changes there.
            .decorations(!cfg!(target_os = "windows"))
            .visible(false)
            .build()
            .map_err(|e| {
                log::error!("build_main_window FAILED: {e}");
                e.to_string()
            })?;
    log::info!("build_main_window: built (hidden until ready heartbeat)");
    restore_degenerate_size(&window);
    attach_hide_to_tray(&window);
    crate::ipc::ready::watch(app, "main", URL);
    Ok(())
}

/// `tauri_plugin_window_state` restores a persisted size on `on_window_ready`,
/// which fires inside `WebviewWindowBuilder::build()` above - so by the time
/// `build()` returns here, the window may already be sitting at whatever size
/// was last saved. If that size ever got shrunk down near the 360x200 resize
/// floor (a stray drag, a snap, anything), it stays saved and gets restored
/// at that same unusable size on every future open forever - the window ends
/// up showing little more than its title bar, with no way to tell it apart
/// from a broken launch short of manually resizing it back up. Snap anything
/// below a sane floor back to the designed default instead of trusting the
/// restored state blindly.
fn restore_degenerate_size(window: &tauri::WebviewWindow) {
    let Ok(scale) = window.scale_factor() else { return };
    let Ok(size) = window.inner_size() else { return };
    let logical = size.to_logical::<f64>(scale);
    if is_degenerate_size(logical.width, logical.height) {
        log::warn!(
            "build_main_window: restored size {}x{} below usable floor, resetting to default",
            logical.width,
            logical.height
        );
        let _ = window.set_size(tauri::Size::Logical(tauri::LogicalSize::new(520.0, 720.0)));
    }
}

/// Pure predicate behind `restore_degenerate_size`, split out so the floor
/// itself is unit-testable without a real window - same split as
/// `ready.rs`'s `record_heartbeat`/`record_timeout`.
fn is_degenerate_size(width: f64, height: f64) -> bool {
    const MIN_USABLE_WIDTH: f64 = 400.0;
    const MIN_USABLE_HEIGHT: f64 = 300.0;
    width < MIN_USABLE_WIDTH || height < MIN_USABLE_HEIGHT
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

    /// The single-instance callback is the one non-IPC caller that runs in a
    /// context where `build()` cannot return: inside the plugin's WM_COPYDATA
    /// window proc, mid cross-process SendMessageW (see the comment in
    /// `lib.rs`). Calling `open_dashboard` inline there froze the app on the
    /// first relaunch after every reboot, so the call must stay deferred.
    #[test]
    fn second_launch_handoff_builds_the_dashboard_off_the_window_proc() {
        let src = include_str!("../../lib.rs");
        let start = src
            .find("tauri_plugin_single_instance::init(")
            .expect("single-instance plugin registration not found in lib.rs");
        let body = &src[start..start + src[start..].find("}));").expect("callback end")];
        let call = body
            .find("open_dashboard(")
            .expect("second-launch handoff no longer surfaces the dashboard");
        let deferred = body[..call].rfind("spawn_blocking(");
        assert!(
            deferred.is_some_and(|d| !body[d..call].contains(';')),
            "the single-instance callback must call open_dashboard inside \
             tauri::async_runtime::spawn_blocking, never inline - building a \
             window from the WM_COPYDATA window proc freezes the app"
        );
    }

    use super::{close_policy, is_degenerate_size, ClosePolicy};

    #[test]
    fn only_the_files_window_is_destroyed_on_close() {
        assert_eq!(close_policy("session-file"), ClosePolicy::Destroy);
        for label in ["main", "session-chats", "session-code", "session-schedule", "session-jarvis", "overlay", "session-file-2"] {
            assert_eq!(close_policy(label), ClosePolicy::HideToTray, "{label}");
        }
    }

    #[test]
    fn below_floor_on_either_axis_is_degenerate() {
        assert!(is_degenerate_size(360.0, 200.0), "at the resize floor - the reported bug shape");
        assert!(is_degenerate_size(399.0, 720.0), "width alone below floor");
        assert!(is_degenerate_size(520.0, 299.0), "height alone below floor");
    }

    #[test]
    fn at_or_above_floor_is_not_degenerate() {
        assert!(!is_degenerate_size(400.0, 300.0), "exactly at the floor");
        assert!(!is_degenerate_size(520.0, 720.0), "the designed default");
    }
}
