//! Shows a window only once the frontend reports it actually rendered, via
//! `frontend_ready`. A finished page load is not proof: it also fires on
//! WebView2's own "can't reach this page" error, which is how a window ends
//! up showing a browser error with no recovery short of an app restart.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Manager};

/// How long a freshly (re)loaded window gets to report ready before
/// it's judged stuck. Comfortably above a normal WebView2 cold boot.
const READY_TIMEOUT: Duration = Duration::from_secs(4);

/// Backoff before each retry, indexed by attempt number. Grows so a window
/// that is genuinely broken doesn't burn through all its retries in barely
/// more than `READY_TIMEOUT`. Its length is also `MAX_ATTEMPTS`.
const RETRY_BACKOFF: [Duration; 3] =
    [Duration::from_secs(4), Duration::from_secs(8), Duration::from_secs(12)];

const MAX_ATTEMPTS: u32 = RETRY_BACKOFF.len() as u32;

/// about:blank commits practically instantly; this just avoids racing `eval`
/// against a navigation that technically hasn't landed yet.
const ERROR_PANEL_EVAL_DELAY: Duration = Duration::from_millis(250);

struct Entry {
    shown: bool,
    attempts: u32,
    /// Set once per `watch()` call. Lets a task started by an earlier call
    /// recognize it has been superseded by a rebuild (a later `watch()` for
    /// the same label) and stop mutating a window it no longer owns.
    generation: u64,
}

fn registry() -> &'static Mutex<HashMap<String, Entry>> {
    static REGISTRY: OnceLock<Mutex<HashMap<String, Entry>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

fn next_generation() -> u64 {
    static NEXT: OnceLock<AtomicU64> = OnceLock::new();
    NEXT.get_or_init(|| AtomicU64::new(0)).fetch_add(1, Ordering::SeqCst)
}

/// What a heartbeat should do, decided without touching any window - kept
/// pure so the state machine is unit-testable without a real webview.
#[derive(Debug, PartialEq)]
enum HeartbeatOutcome {
    AlreadyShown,
    Show,
}

fn record_heartbeat(entry: &mut Entry) -> HeartbeatOutcome {
    if entry.shown {
        return HeartbeatOutcome::AlreadyShown;
    }
    entry.shown = true;
    HeartbeatOutcome::Show
}

/// What a missed-timeout tick should do. Same purity rationale as
/// `HeartbeatOutcome`.
#[derive(Debug, PartialEq)]
enum TimeoutOutcome {
    AlreadyShown,
    Retry(Duration),
    GiveUp,
}

fn record_timeout(entry: &mut Entry) -> TimeoutOutcome {
    if entry.shown {
        return TimeoutOutcome::AlreadyShown;
    }
    let Some(&backoff) = RETRY_BACKOFF.get(entry.attempts as usize) else {
        return TimeoutOutcome::GiveUp;
    };
    entry.attempts += 1;
    TimeoutOutcome::Retry(backoff)
}

/// `record_timeout` gated on `generation` still being current. `None` covers
/// both a genuinely destroyed window (entry removed by the `Destroyed`
/// handler `watch()` attaches) and a rebuilt one (entry replaced by a later
/// `watch()` call for the same label) - either way this caller is superseded.
fn timeout_outcome(
    reg: &mut HashMap<String, Entry>,
    label: &str,
    generation: u64,
) -> Option<TimeoutOutcome> {
    let entry = reg.get_mut(label)?;
    if entry.generation != generation {
        return None;
    }
    Some(record_timeout(entry))
}

/// Register `label` and start waiting for its heartbeat. Call exactly once,
/// right after `WebviewWindowBuilder::build()`, for every window. `url` is
/// the app-relative URL the window was built with (e.g.
/// `"index.html?chatswindow=1#sessions"`), reused verbatim on reload.
pub fn watch(app: &AppHandle, label: &str, url: &str) {
    let generation = next_generation();
    registry()
        .lock()
        .unwrap()
        .insert(label.to_string(), Entry { shown: false, attempts: 0, generation });
    if let Some(w) = app.get_webview_window(label) {
        let dead_label = label.to_string();
        w.on_window_event(move |event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                let mut reg = registry().lock().unwrap();
                if reg.get(&dead_label).is_some_and(|e| e.generation == generation) {
                    reg.remove(&dead_label);
                }
            }
        });
    }
    let app = app.clone();
    let label = label.to_string();
    let url = url.to_string();
    tauri::async_runtime::spawn(async move {
        run(app, label, url, generation).await;
    });
}

async fn run(app: AppHandle, label: String, url: String, generation: u64) {
    let mut wait = READY_TIMEOUT;
    loop {
        tokio::time::sleep(wait).await;
        let outcome = {
            let mut reg = registry().lock().unwrap();
            match timeout_outcome(&mut reg, &label, generation) {
                Some(outcome) => outcome,
                None => return,
            }
        };
        match outcome {
            TimeoutOutcome::AlreadyShown => return,
            TimeoutOutcome::Retry(backoff) => {
                reload(&app, &label, &url);
                wait = backoff;
            }
            TimeoutOutcome::GiveUp => {
                show_error_panel(&app, &label, &url, generation).await;
                return;
            }
        }
    }
}

fn reload(app: &AppHandle, label: &str, url: &str) {
    let Some(w) = app.get_webview_window(label) else { return };
    let full = app_url(url);
    log::warn!("{label}: no ready heartbeat; reloading -> {full}");
    if let Ok(parsed) = full.parse::<tauri::Url>() {
        let _ = w.navigate(parsed);
    }
}

/// Whether `show_error_panel` may act: current generation, not already
/// shown (a heartbeat could have landed just before `GiveUp`), and the
/// window still visible - a hide-to-tray close mid-retry must not resurface.
fn may_show_error_panel(entry: Option<&Entry>, generation: u64, window_visible: bool) -> bool {
    matches!(entry, Some(e) if e.generation == generation && !e.shown) && window_visible
}

async fn show_error_panel(app: &AppHandle, label: &str, url: &str, generation: u64) {
    let Some(w) = app.get_webview_window(label) else { return };
    let visible = w.is_visible().unwrap_or(true);
    if !may_show_error_panel(registry().lock().unwrap().get(label), generation, visible) {
        // Drop the panel rather than repaint a window the user closed and
        // force it back to front (visible=false), or one already superseded.
        return;
    }
    let full = app_url(url);
    log::error!("{label}: gave up after {MAX_ATTEMPTS} reload attempt(s) for {full}");
    if let Ok(blank) = "about:blank".parse::<tauri::Url>() {
        let _ = w.navigate(blank);
    }
    tokio::time::sleep(ERROR_PANEL_EVAL_DELAY).await;
    let html = error_panel_html(label, &full);
    let js = format!(
        "document.open();document.write({html});document.close();\
         document.getElementById('cc-retry').onclick=function(){{location.replace({target});}};",
        html = serde_json::to_string(&html).unwrap_or_default(),
        target = serde_json::to_string(&full).unwrap_or_default(),
    );
    let _ = w.eval(&js);
    let _ = w.show();
    let _ = w.set_focus();
}

/// Self-contained dark panel - no stylesheet dependency, since a failed
/// stylesheet load is exactly the kind of failure this reports. Colors match
/// `--color-background` (rgb(22, 21, 31)) used by every window builder here.
fn error_panel_html(label: &str, url: &str) -> String {
    format!(
        r#"<!doctype html><html><body style="margin:0;height:100vh;display:flex;
align-items:center;justify-content:center;background:rgb(22,21,31);
color:#e8e6f0;font:14px -apple-system,Segoe UI,sans-serif;">
<div style="max-width:440px;text-align:center;padding:24px;">
<div style="font-size:16px;font-weight:600;margin-bottom:12px;">This window failed to load</div>
<div style="opacity:0.65;margin-bottom:4px;">{label}</div>
<div style="opacity:0.65;margin-bottom:20px;word-break:break-all;">{url}</div>
<button id="cc-retry" style="background:#3a3654;color:#e8e6f0;border:1px solid #55507a;
border-radius:6px;padding:8px 20px;font-size:14px;cursor:pointer;">Retry</button>
</div></body></html>"#
    )
}

/// Origin Tauri serves `WebviewUrl::App(...)` paths under, mirroring
/// `bootstrap::watchdogs::boot_start_url` (kept separate since that one is
/// hardcoded to `index.html` and `pub(super)` to its own module).
fn origin() -> &'static str {
    if cfg!(dev) {
        "http://localhost:1420/"
    } else if cfg!(target_os = "macos") || cfg!(target_os = "ios") {
        "tauri://localhost/"
    } else {
        "http://tauri.localhost/"
    }
}

fn app_url(path: &str) -> String {
    format!("{}{}", origin(), path)
}

/// Frontend heartbeat: "I am alive and rendering", called as early in boot as
/// that's meaningful. Shows + focuses the window on the first call for a
/// registered label; a label never registered here or a heartbeat that
/// arrives after the window is already shown is a no-op.
pub fn mark_ready(app: &AppHandle, label: &str) {
    let outcome = {
        let mut reg = registry().lock().unwrap();
        let Some(entry) = reg.get_mut(label) else { return };
        record_heartbeat(entry)
    };
    if outcome == HeartbeatOutcome::Show {
        // `main` alone also drives two AppState flags formerly set from its
        // `on_page_load` "Finished" handler (ai_todo 786): a heartbeat can't
        // be a WebView2 error page, so it's the correct "opened" signal.
        if label == "main" {
            if let Some(state) = app.try_state::<crate::state::AppState>() {
                state.main_window_loaded.store(true, std::sync::atomic::Ordering::SeqCst);
                // Reset the paint-liveness baseline: otherwise it still holds
                // its boot-time default, the first `frontend_ping`'s
                // `raf_tick: 0` equals it, and the watchdog misfires on a
                // live window.

                *state.last_frontend_raf.lock().unwrap() = (0, std::time::Instant::now());
            }
        }
        if let Some(w) = app.get_webview_window(label) {
            let _ = w.show();
            let _ = w.set_focus();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh() -> Entry {
        Entry { shown: false, attempts: 0, generation: 0 }
    }

    #[test]
    fn heartbeat_before_timeout_shows_once() {
        let mut entry = fresh();
        assert_eq!(record_heartbeat(&mut entry), HeartbeatOutcome::Show);
        assert_eq!(record_heartbeat(&mut entry), HeartbeatOutcome::AlreadyShown);
    }

    #[test]
    fn late_heartbeat_after_shown_is_a_no_op() {
        let mut entry = Entry { shown: true, attempts: 0, generation: 0 };
        assert_eq!(record_heartbeat(&mut entry), HeartbeatOutcome::AlreadyShown);
    }

    #[test]
    fn no_heartbeat_retries_then_gives_up() {
        let mut entry = fresh();
        for expected_backoff in RETRY_BACKOFF {
            assert_eq!(record_timeout(&mut entry), TimeoutOutcome::Retry(expected_backoff));
        }
        assert_eq!(entry.attempts, MAX_ATTEMPTS);
        assert_eq!(record_timeout(&mut entry), TimeoutOutcome::GiveUp);
        // Still exhausted on a further tick, not a panic or a reset.
        assert_eq!(record_timeout(&mut entry), TimeoutOutcome::GiveUp);
    }

    #[test]
    fn heartbeat_between_retries_stops_further_timeouts() {
        let mut entry = fresh();
        assert_eq!(record_timeout(&mut entry), TimeoutOutcome::Retry(RETRY_BACKOFF[0]));
        assert_eq!(record_heartbeat(&mut entry), HeartbeatOutcome::Show);
        assert_eq!(record_timeout(&mut entry), TimeoutOutcome::AlreadyShown);
    }

    #[test]
    fn rebuild_during_watch_makes_the_stale_task_a_no_op() {
        let mut reg: HashMap<String, Entry> = HashMap::new();
        let label = "session-1";
        reg.insert(label.to_string(), Entry { shown: false, attempts: 0, generation: 1 });
        // A second `watch()` for the same label (window rebuilt) overwrites
        // the entry with a fresh generation, exactly as `watch()` does.
        reg.insert(label.to_string(), Entry { shown: false, attempts: 0, generation: 2 });
        // The first task's tick, still holding generation 1, must no-op.
        assert_eq!(timeout_outcome(&mut reg, label, 1), None);
        // The second (current) task still operates normally.
        assert_eq!(
            timeout_outcome(&mut reg, label, 2),
            Some(TimeoutOutcome::Retry(RETRY_BACKOFF[0]))
        );
    }

    #[test]
    fn destroyed_window_removes_its_entry_and_the_task_is_a_no_op() {
        let mut reg: HashMap<String, Entry> = HashMap::new();
        let label = "session-1";
        reg.insert(label.to_string(), Entry { shown: false, attempts: 0, generation: 1 });
        // What the `WindowEvent::Destroyed` handler does on genuine close.
        reg.remove(label);
        assert_eq!(timeout_outcome(&mut reg, label, 1), None);
    }

    #[test]
    fn hidden_window_after_giveup_drops_the_panel() {
        let entry = Entry { shown: false, attempts: MAX_ATTEMPTS, generation: 1 };
        // Visible window, current generation, never shown: may act.
        assert!(may_show_error_panel(Some(&entry), 1, true));
        // Hidden via hide-to-tray mid-retry: dropped, not resurrected.
        assert!(!may_show_error_panel(Some(&entry), 1, false));
        // Superseded by a rebuild.
        assert!(!may_show_error_panel(Some(&entry), 2, true));
        // Already shown by a heartbeat that landed just before GiveUp.
        let shown = Entry { shown: true, attempts: MAX_ATTEMPTS, generation: 1 };
        assert!(!may_show_error_panel(Some(&shown), 1, true));
        // Genuinely destroyed: no entry left at all.
        assert!(!may_show_error_panel(None, 1, true));
    }
}
