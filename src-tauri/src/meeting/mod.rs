//! Meeting detection: polls Windows for camera/mic use and meeting-app audio.
//! When a meeting is active and the `pauseInMeeting` setting is on (default),
//! `notifications::rules::fire` suppresses sound/voice pings and the tray
//! tooltip shows a "notifications paused" line.
//!
//! Ported from tauri_kit_meeting, slimmed to a single `meeting_active` flag
//! stored on `AppState` (no separate plugin / query command).

pub mod signal;
#[cfg(windows)]
mod windows_source;

pub use signal::{compute_in_meeting, SignalSource, Sources};

use crate::state::AppState;
use serde::Serialize;
use std::sync::atomic::Ordering;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

/// How often the watcher samples the OS signals when the feature is enabled.
const POLL_INTERVAL: Duration = Duration::from_secs(3);

/// How often the watcher checks back in while neither consumer needs a live
/// signal (see `detection_wanted`). No registry/COM/process work happens on
/// these ticks, so this can be much longer than `POLL_INTERVAL`.
const IDLE_POLL_INTERVAL: Duration = Duration::from_secs(15);

/// Built-in meeting-app process names, matched against active audio sessions.
pub fn default_meeting_apps() -> Vec<String> {
    [
        "Teams.exe",
        "ms-teams.exe",
        "Zoom.exe",
        "CptHost.exe",
        "Discord.exe",
        "slack.exe",
        "Webex.exe",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

/// Payload emitted on `meeting://changed` (transitions only).
#[derive(Clone, Copy, Debug, Serialize)]
pub struct MeetingState {
    pub active: bool,
    pub sources: Sources,
}

/// Apply or remove screen-capture exclusion on all app windows in this process.
/// Uses `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)` when `exclude` is true,
/// restores `WDA_NONE` otherwise. No-op on non-Windows.
pub fn apply_capture_affinity(exclude: bool) {
    #[cfg(windows)]
    {
        use windows::Win32::Foundation::{BOOL, HWND, LPARAM};
        use windows::Win32::UI::WindowsAndMessaging::{
            EnumWindows, GetWindowThreadProcessId, SetWindowDisplayAffinity,
            WINDOW_DISPLAY_AFFINITY,
        };
        // WDA_NONE = 0, WDA_EXCLUDEFROMCAPTURE = 0x11 (Win10 2004+)
        let affinity = if exclude {
            WINDOW_DISPLAY_AFFINITY(0x11)
        } else {
            WINDOW_DISPLAY_AFFINITY(0)
        };
        let own_pid = std::process::id();

        struct Ctx {
            pid: u32,
            affinity: WINDOW_DISPLAY_AFFINITY,
        }

        unsafe extern "system" fn each(hwnd: HWND, lparam: LPARAM) -> BOOL {
            let ctx = unsafe { &*(lparam.0 as *const Ctx) };
            let mut wpid: u32 = 0;
            let _ = GetWindowThreadProcessId(hwnd, Some(&mut wpid));
            if wpid == ctx.pid {
                let _ = SetWindowDisplayAffinity(hwnd, ctx.affinity);
            }
            BOOL(1)
        }

        let ctx = Ctx { pid: own_pid, affinity };
        unsafe {
            let _ = EnumWindows(Some(each), LPARAM(&ctx as *const Ctx as isize));
        }
    }
}

/// The OS signal reader for this platform. Both the app's watcher (`start`) and
/// the daemon's `MeetingMonitor` read through it: they are separate processes,
/// and `AppState.meeting_active` is invisible from the daemon.
pub fn platform_source() -> Box<dyn SignalSource> {
    #[cfg(windows)]
    {
        Box::new(windows_source::WindowsSignalSource::default())
    }
    #[cfg(not(windows))]
    {
        Box::new(NoopSource)
    }
}

/// Spawn the background meeting watcher. Polls every 3s; on each active/inactive
/// transition it updates `AppState.meeting_active`, emits `meeting://changed`
/// (so the tray tooltip re-renders), and logs the edge. On non-Windows the
/// signal source always reports false, so `meeting_active` stays off.
pub fn start(app: AppHandle) {
    let source = platform_source();
    let apps = default_meeting_apps();

    std::thread::spawn(move || {
        let mut last: Option<bool> = None;
        // Last capture-exclusion state we actually pushed to the windows. Starts
        // `false` because a freshly-created window is WDA_NONE by default, so we
        // only ever touch a HWND when this needs to change (the common
        // `hideInMeeting=false` config therefore does zero window work).
        let mut applied_exclude = false;
        loop {
            if !detection_wanted(&app) {
                // Neither `hideInMeeting` (window capture-hiding) nor
                // `pauseInMeeting` (notification suppression, on by default)
                // currently consumes a live signal, so skip every
                // registry/COM/process call below. Collapse to "not in a
                // meeting" once, so nothing is left showing a stale "active"
                // from before the toggle, then idle at a longer beat instead
                // of the normal 3s poll.
                if last != Some(false) {
                    last = Some(false);
                    if let Some(state) = app.try_state::<AppState>() {
                        state.meeting_active.store(false, Ordering::Relaxed);
                    }
                    let _ = app.emit(
                        "meeting://changed",
                        MeetingState { active: false, sources: Sources::default() },
                    );
                    if applied_exclude {
                        applied_exclude = false;
                        let _ = app.run_on_main_thread(move || apply_capture_affinity(false));
                    }
                }
                std::thread::sleep(IDLE_POLL_INTERVAL);
                continue;
            }

            let sources = Sources {
                camera: source.camera_in_use(),
                mic: source.mic_in_use(),
                audio: source.meeting_app_audio_active(&apps),
            };
            let active = compute_in_meeting(sources);

            if let Some(state) = app.try_state::<AppState>() {
                state.meeting_active.store(active, Ordering::Relaxed);
            }

            if last != Some(active) {
                last = Some(active);
                let _ = app.emit("meeting://changed", MeetingState { active, sources });
                log::info!("meeting: active={active} sources={sources:?}");
                let hide = app
                    .try_state::<AppState>()
                    .and_then(|s| s.settings.lock().ok().map(|g| g.hide_in_meeting()))
                    .unwrap_or(false);
                let want_exclude = active && hide;
                if want_exclude != applied_exclude {
                    applied_exclude = want_exclude;
                    // `SetWindowDisplayAffinity` is a USER32 call against windows
                    // owned by the MAIN thread. Calling it from this watcher
                    // thread marshals a synchronous inter-thread window message;
                    // if it lands while the main thread is inside WebView2 window
                    // creation (opening the dashboard/chats window) the two can
                    // wedge, freezing every window and the tray. Marshal it onto
                    // the main event loop so the HWND is only ever touched by its
                    // owning thread.
                    let _ = app.run_on_main_thread(move || {
                        apply_capture_affinity(want_exclude);
                    });
                }
            }
            std::thread::sleep(POLL_INTERVAL);
        }
    });
}

/// Whether anything currently consumes a live `meeting_active` signal:
/// `hideInMeeting` (window capture-affinity hiding) or `pauseInMeeting`
/// (notification suppression - see `notifications::rules::fire` and
/// `ipc::characters::play_character_slot`), which defaults to on. Reads
/// straight from the already-loaded `AppState.settings` lock - no disk I/O -
/// so this check is effectively free next to the registry/COM/process calls
/// it gates. Fails open (returns true) if state isn't available yet, matching
/// `pauseInMeeting`'s own on-by-default behavior.
fn detection_wanted(app: &AppHandle) -> bool {
    app.try_state::<AppState>()
        .and_then(|s| {
            s.settings.lock().ok().map(|g| g.hide_in_meeting() || g.pause_notifications_in_meeting())
        })
        .unwrap_or(true)
}

#[cfg(not(windows))]
struct NoopSource;
#[cfg(not(windows))]
impl SignalSource for NoopSource {
    fn camera_in_use(&self) -> bool {
        false
    }
    fn mic_in_use(&self) -> bool {
        false
    }
    fn meeting_app_audio_active(&self, _allow: &[String]) -> bool {
        false
    }
}
