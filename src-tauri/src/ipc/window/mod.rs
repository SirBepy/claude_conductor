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

/// In debug builds give a window the blue dev icon for its taskbar and Alt-Tab
/// entry; release builds do nothing. The exe's embedded icon is the production
/// orange one, so any window built without this call can be mistaken for the
/// installed app. Call it from every builder that leaves the window a taskbar
/// entry (the overlay sets `skip_taskbar`, so it has none); a test pins the
/// call sites.
pub(crate) fn apply_dev_window_icon(window: &tauri::WebviewWindow) {
    if !cfg!(debug_assertions) {
        return;
    }
    // Recolouring decodes and re-encodes a PNG, so do it once per process.
    static ICON: std::sync::OnceLock<Option<tauri::image::Image<'static>>> =
        std::sync::OnceLock::new();
    let icon = ICON.get_or_init(|| {
        tauri::image::Image::from_bytes(&crate::tray::icon_render::dev_window_icon())
            .map_err(|e| log::warn!("dev window icon did not decode: {e}"))
            .ok()
    });
    if let Some(icon) = icon {
        if let Err(e) = window.set_icon(icon.clone()) {
            log::warn!("set_icon failed for window {}: {e}", window.label());
        }
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
    apply_dev_window_icon(window);
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
/// it and routes it to `pending`. A window whose listeners are mounted gets
/// `event`/`payload`; one that is missing or still loading gets `pending`
/// stashed in `AppState.pending_main_nav` for its boot to drain through
/// `take_pending_nav`, since a webview cannot catch an event emitted before its
/// listeners mount.
fn surface_chats_with_nav(
    app: &AppHandle,
    event: &str,
    payload: impl serde::Serialize + Clone,
    pending: String,
) {
    let Some(state) = app.try_state::<crate::state::AppState>() else {
        let _ = chats::open_chats_window(app.clone());
        return;
    };
    let exists = app.get_webview_window(chats::CHATS_WINDOW_LABEL).is_some();
    match route_nav(&state.pending_main_nav, &state.chats_nav_ready, exists, pending) {
        NavRoute::EmitToLiveWindow => {
            let _ = chats::open_chats_window(app.clone());
            let _ = app.emit_to(chats::CHATS_WINDOW_LABEL, event, payload);
        }
        NavRoute::StashForBoot => {
            let _ = chats::open_chats_window(app.clone());
        }
    }
}

/// How a navigation request reaches the Chats window.
#[derive(Debug, PartialEq)]
enum NavRoute {
    EmitToLiveWindow,
    StashForBoot,
}

/// A window that does not exist yet, or exists but has not mounted its
/// `navigate-to-*` listeners, cannot catch an event, so its nav goes in the
/// stash instead (last request wins: the window only ever drains one).
/// `listeners_ready` flips inside `drain_pending_nav` under the same lock the
/// stash is written under, so a nav lands either in the stash before the boot
/// drain reads it or on a window already marked ready, never in the gap
/// between. Split out so that decision is testable: `AppHandle` is the `Wry`
/// runtime, and no mock app can stand in for it.
fn route_nav(
    slot: &std::sync::Mutex<Option<String>>,
    listeners_ready: &std::sync::atomic::AtomicBool,
    chats_window_exists: bool,
    pending: String,
) -> NavRoute {
    let mut guard = slot.lock().unwrap();
    if chats_window_exists && listeners_ready.load(Ordering::SeqCst) {
        return NavRoute::EmitToLiveWindow;
    }
    *guard = Some(pending);
    NavRoute::StashForBoot
}

/// The boot-time drain of the stash. The Chats window calls it right after
/// registering its `navigate-to-*` listeners, so reaching here is also the
/// signal that live emits are safe from now on.
pub(crate) fn drain_pending_nav(
    slot: &std::sync::Mutex<Option<String>>,
    listeners_ready: &std::sync::atomic::AtomicBool,
) -> Option<String> {
    let mut guard = slot.lock().unwrap();
    listeners_ready.store(true, Ordering::SeqCst);
    guard.take()
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

    #[test]
    fn a_nav_is_stashed_until_the_chats_window_has_mounted_its_listeners() {
        use super::{drain_pending_nav, route_nav, NavRoute};
        use std::sync::atomic::AtomicBool;

        let slot = std::sync::Mutex::new(None);
        let ready = AtomicBool::new(false);

        // No window yet.
        assert_eq!(route_nav(&slot, &ready, false, "settings-accounts".into()), NavRoute::StashForBoot);
        assert_eq!(slot.lock().unwrap().as_deref(), Some("settings-accounts"));

        // Window exists but is still loading: an emit would be lost.
        assert_eq!(route_nav(&slot, &ready, true, "account:a1".into()), NavRoute::StashForBoot);
        assert_eq!(slot.lock().unwrap().as_deref(), Some("account:a1"), "the later request replaces the earlier");

        // Boot drains the stash and marks the listeners live.
        assert_eq!(drain_pending_nav(&slot, &ready).as_deref(), Some("account:a1"));
        assert_eq!(drain_pending_nav(&slot, &ready), None, "drained once");

        // Now an emit reaches a listener, and nothing is stashed.
        assert_eq!(route_nav(&slot, &ready, true, "dashboard".into()), NavRoute::EmitToLiveWindow);
        assert!(slot.lock().unwrap().is_none());

        // A closed-and-rebuilt window is not ready again until its own boot.
        assert_eq!(route_nav(&slot, &ready, false, "dashboard".into()), NavRoute::StashForBoot);
    }

    #[test]
    fn a_reloaded_chats_window_is_not_ready_again_until_its_own_boot() {
        use super::{chats::nav_listeners_gone, drain_pending_nav, route_nav, NavRoute};
        use std::sync::atomic::AtomicBool;

        let slot = std::sync::Mutex::new(None);
        let ready = AtomicBool::new(false);
        drain_pending_nav(&slot, &ready);
        assert_eq!(route_nav(&slot, &ready, true, "a".into()), NavRoute::EmitToLiveWindow);

        // The window is navigated in place: the new page has no listeners yet.
        nav_listeners_gone(&ready);
        assert_eq!(route_nav(&slot, &ready, true, "b".into()), NavRoute::StashForBoot);
        assert_eq!(drain_pending_nav(&slot, &ready).as_deref(), Some("b"));
    }

    /// A real window cannot be built in `cargo test` (`AppHandle` is the `Wry`
    /// runtime), so pin the wiring in the source: every builder that gives a
    /// window a taskbar entry must call `apply_dev_window_icon`, or that window
    /// keeps the production orange icon in a dev build. The overlay is exempt
    /// because `skip_taskbar(true)` leaves it no taskbar or Alt-Tab entry.
    #[test]
    fn every_window_builder_with_a_taskbar_entry_applies_the_dev_icon() {
        let hide_to_tray = fn_body(include_str!("mod.rs"), "fn attach_hide_to_tray_with(");
        let detached = fn_body(include_str!("../chat/lifecycle.rs"), "pub async fn detach_window(");
        let jarvis = fn_body(include_str!("jarvis.rs"), "tauri::WebviewWindowBuilder::new(");
        for (name, body) in [
            ("attach_hide_to_tray_with (chats, code, file, preview, schedule)", hide_to_tray),
            ("detach_window (session-*)", detached),
            ("jarvis window", jarvis),
        ] {
            assert!(
                body.contains("apply_dev_window_icon("),
                "{name} never calls apply_dev_window_icon"
            );
        }
        assert!(
            include_str!("../overlay_window.rs").contains(".skip_taskbar(true)"),
            "the overlay is exempt from the dev icon only while it has no taskbar entry"
        );
    }

    #[test]
    fn the_dev_window_icon_decodes_as_a_tauri_image() {
        tauri::image::Image::from_bytes(&crate::tray::icon_render::dev_window_icon())
            .expect("a window icon set_icon would reject is silently dropped in a dev build");
    }

    /// `AppHandle` is the `Wry` runtime and no mock app can stand in for it, so
    /// the two in-place reload paths cannot be driven here. Pin their wiring in
    /// the source instead, the way the second-launch test does for `lib.rs`.
    fn fn_body<'a>(src: &'a str, sig: &str) -> &'a str {
        let start = src.find(sig).unwrap_or_else(|| panic!("{sig} not found"));
        let rest = &src[start..];
        &rest[..rest.find("\n}").expect("fn end")]
    }

    #[test]
    fn every_in_place_chats_reload_clears_the_nav_ready_flag_before_navigating() {
        let watchdog = fn_body(include_str!("../../bootstrap/watchdogs.rs"), "fn reload_chats(");
        let gate = fn_body(include_str!("../ready.rs"), "fn reload(");
        for (name, body) in [("watchdogs::reload_chats", watchdog), ("ready::reload", gate)] {
            let mark = body
                .find("mark_chats_nav_listeners_gone(")
                .unwrap_or_else(|| panic!("{name} never clears chats_nav_ready"));
            let navigate = body.find(".navigate(").unwrap_or_else(|| panic!("{name} no longer navigates"));
            assert!(mark < navigate, "{name} must clear the flag before navigating, or a fast boot's drain is overwritten");
        }
        assert!(
            gate.contains("CHATS_WINDOW_LABEL"),
            "ready::reload serves every window; only the chats window owns the flag"
        );
    }
}
