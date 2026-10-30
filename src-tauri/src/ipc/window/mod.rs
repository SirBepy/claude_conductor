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
/// Home screen's project rows; the page itself lives in the chats window
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

    use super::{close_policy, ClosePolicy};

    #[test]
    fn only_the_files_window_is_destroyed_on_close() {
        assert_eq!(close_policy("session-file"), ClosePolicy::Destroy);
        for label in ["session-chats", "session-code", "session-schedule", "session-jarvis", "overlay", "session-file-2"] {
            assert_eq!(close_policy(label), ClosePolicy::HideToTray, "{label}");
        }
    }
}
