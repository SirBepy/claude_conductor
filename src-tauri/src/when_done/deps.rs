//! The integration boundary `run_engine_with_deps` drives, plus the production
//! wiring that plugs the real AppHandle / daemon client / system_control into
//! it. Split out of engine.rs (todo 1032): this seam is what tests replace, not
//! part of the phase machine itself.

use super::actions::auto_resolve_prompts;
use super::engine::{is_cancelled, update_and_emit};
use super::idle::{all_sessions_idle, live_busy_map, waiting_on_ids};
use super::protocol::{ProtocolState, TerminalAction};
use super::scope::ArmScope;
use crate::state::AppState;
use std::future::Future;
use std::sync::{Arc, Mutex};
use std::pin::Pin;
use std::time::Instant;
use tauri::{AppHandle, Manager};

/// A boxed, owned future the engine seams hand back. The phase machine awaits
/// these without caring whether the body is the real daemon client or a test
/// stub.
pub(super) type BoxFut<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// The integration seams the phase machine drives, behind owned closures so the
/// production path can wire the real AppHandle + daemon client while a test wires
/// recording stubs. Every external effect run_engine performs (reading live
/// instances, resolving prompts, emitting state, checking cancellation, firing
/// the terminal action) goes through exactly one of these.
pub(super) struct EngineDeps {
    /// Snapshot of the live (not-ended) `(session_id, busy)` pairs. Mirrors
    /// `live_busy_map` in production; a test can mutate its source between ticks.
    pub(super) busy_map: Box<dyn Fn() -> Vec<(String, bool)> + Send + Sync>,
    /// Whether every live session is idle. Mirrors the inline
    /// `all_sessions_idle(&cached_instances)` check.
    pub(super) all_idle: Box<dyn Fn() -> bool + Send + Sync>,
    /// Auto-resolve the pending daemon prompts (permission/question) of the
    /// sessions busy at arm time. Async.
    pub(super) auto_resolve: Box<dyn Fn() -> BoxFut<'static, ()> + Send + Sync>,
    /// Mutate the stored ProtocolState and emit `when-done-state`. Mirrors
    /// `update_and_emit`; returns the new state.
    pub(super) mutate_and_emit:
        Box<dyn Fn(&mut dyn FnMut(&mut ProtocolState)) -> ProtocolState + Send + Sync>,
    /// Whether cancel was requested (stored phase forced to Disarmed).
    pub(super) is_cancelled: Box<dyn Fn() -> bool + Send + Sync>,
    /// Perform the terminal action (sleep/shutdown). Returns its Result so the
    /// caller logs a failure exactly as the production path does.
    pub(super) terminal: Box<dyn Fn(TerminalAction) -> Result<(), String> + Send + Sync>,
    /// Seconds since the last keyboard/mouse input anywhere in the session.
    pub(super) user_idle_secs: Box<dyn Fn() -> u64 + Send + Sync>,
    /// Current time, for the Watching loop's no-progress runaway guard
    /// (todo 894). Mirrors `std::time::Instant::now`; a test can drive a
    /// synthetic clock through this seam instead of waiting out the real
    /// `NO_PROGRESS_LIMIT` wall-clock duration.
    pub(super) now: Box<dyn Fn() -> Instant + Send + Sync>,
}

impl EngineDeps {
    /// Wire the real production seams from an AppHandle. This is the only place
    /// that touches AppState / the daemon client / system_control, so the
    /// production behavior is identical to the pre-refactor inline body.
    pub(super) fn production(app: AppHandle) -> Self {
        let app_busy = app.clone();
        let app_idle = app.clone();
        let app_resolve = app.clone();
        let app_emit = app.clone();
        let app_cancel = app.clone();
        // Built at arm time (production() runs from run_engine), then widened
        // each tick by `admitted_busy_map` as armed chats start children.
        let at_arm = live_busy_map(&app);
        let live: Vec<String> = at_arm.iter().map(|(id, _)| id.clone()).collect();
        let scope = Arc::new(Mutex::new(ArmScope::new(&live, &waiting_on_ids(&at_arm))));
        let scope_busy = scope.clone();
        let scope_idle = scope.clone();
        Self {
            busy_map: Box::new(move || admitted_busy_map(&scope_busy, live_busy_map(&app_busy))),
            all_idle: Box::new(move || {
                let busy = admitted_busy_map(&scope_idle, live_busy_map(&app_idle));
                let state = app_idle.state::<AppState>();
                let guard = state.cached_instances.lock().unwrap();
                let counted: Vec<_> =
                    guard.iter().filter(|i| busy.iter().any(|(id, _)| id == &i.session_id)).cloned().collect();
                all_sessions_idle(&counted)
            }),
            auto_resolve: Box::new(move || {
                let app = app_resolve.clone();
                let armed = scope.lock().unwrap_or_else(|e| e.into_inner()).armed().clone();
                Box::pin(async move { auto_resolve_prompts(&app, &armed).await })
            }),
            mutate_and_emit: Box::new(move |f| update_and_emit(&app_emit, f)),
            is_cancelled: Box::new(move || is_cancelled(&app_cancel)),
            terminal: Box::new(|action| {
                let dry_run = dry_run_enabled(std::env::var("CC_WHEN_DONE_DRY_RUN").ok().as_deref());
                run_terminal_action(action, dry_run)
            }),
            user_idle_secs: Box::new(crate::daemon::idle::idle_secs),
            now: Box::new(Instant::now),
        }
    }
}

/// The live busy map minus every chat the arm scope ignores, after admitting
/// any chat an armed chat started since the last tick.
pub(super) fn admitted_busy_map(scope: &Mutex<ArmScope>, live: Vec<(String, bool)>) -> Vec<(String, bool)> {
    admitted_with(scope, live, crate::sessions::chat_config::parent_of)
}

pub(super) fn admitted_with(
    scope: &Mutex<ArmScope>,
    live: Vec<(String, bool)>,
    parent_of: impl Fn(&str) -> Option<String>,
) -> Vec<(String, bool)> {
    let mut scope = scope.lock().unwrap_or_else(|e| e.into_inner());
    let ids: Vec<String> = live.iter().map(|(id, _)| id.clone()).collect();
    scope.admit(&ids, parent_of);
    live.into_iter().filter(|(id, _)| !scope.is_ignored(id)).collect()
}

/// Whether `CC_WHEN_DONE_DRY_RUN` is enabled, given its raw value (`None` when
/// the var is unset). Factored out of the production env read so a test can
/// exercise the switch without mutating process environment, which is shared
/// across parallel test threads (todo 888).
pub(super) fn dry_run_enabled(raw: Option<&str>) -> bool {
    raw.is_some_and(|v| !v.is_empty())
}

/// Perform (or, in dry-run, log and skip) the terminal action. Lets the live
/// "fires with such a session open" check in todo 888's Decided run end to
/// end without actually sleeping/shutting down this machine: every other step
/// of the Firing path (the state mutation + `when-done-state` emit in
/// `run_engine_with_deps`) runs exactly as it would for a real fire, only this
/// last seam is swapped.
pub(super) fn run_terminal_action(action: TerminalAction, dry_run: bool) -> Result<(), String> {
    if dry_run {
        let verb = match action {
            TerminalAction::Sleep => "sleep",
            TerminalAction::Shutdown => "shutdown",
        };
        log::warn!("when_done: dry-run, would {verb}");
        return Ok(());
    }
    match action {
        TerminalAction::Sleep => crate::system_control::sleep_pc(),
        TerminalAction::Shutdown => crate::system_control::shutdown_pc(),
    }
}

#[cfg(test)]
#[path = "deps_tests.rs"]
mod tests;
