//! Claude's own Chrome: one persistent profile under app data, separate from
//! every profile Joe uses. Launched headed but parked off-screen rather than
//! headless, because Google's sign-in refuses headless browsers and because
//! "Show Claude's browser" has to bring up this same window, with its live
//! tabs, so Joe can get past a CAPTCHA. Lazy start, idle shutdown, graceful
//! close on daemon exit.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

use crate::auth::cdp;

const IDLE_TIMEOUT: Duration = Duration::from_secs(20 * 60);
const STARTUP_TIMEOUT: Duration = Duration::from_secs(20);
const CDP_TIMEOUT: Duration = Duration::from_secs(10);
/// Far enough off every monitor layout that no part of the window shows.
const PARKED_XY: i64 = -32000;
const SHOWN_BOUNDS: (i64, i64, i64, i64) = (80, 60, 1280, 900);

pub struct Chrome {
    profile: PathBuf,
    running: Mutex<Option<Running>>,
    last_active: std::sync::Mutex<Instant>,
    /// True while Joe has the window on screen; idle shutdown never closes a
    /// browser he may be typing into.
    shown: AtomicBool,
}

struct Running {
    /// `None` when adopted from a previous daemon run that left it open.
    child: Option<Child>,
    port: u16,
}

impl Chrome {
    pub fn new(profile: PathBuf) -> Self {
        Self {
            profile,
            running: Mutex::new(None),
            last_active: std::sync::Mutex::new(Instant::now()),
            shown: AtomicBool::new(false),
        }
    }

    pub fn touch(&self) {
        *self.last_active.lock().unwrap() = Instant::now();
    }

    /// The CDP port of a live browser, starting one if needed.
    pub async fn ensure_running(&self) -> Result<u16, String> {
        self.touch();
        let mut guard = self.running.lock().await;
        if let Some(r) = guard.as_ref() {
            if cdp_alive(r.port).await {
                return Ok(r.port);
            }
            log::warn!("claude-browser: chrome on port {} stopped answering; relaunching", r.port);
            if let Some(mut c) = guard.take().and_then(|r| r.child) {
                let _ = c.kill().await;
            }
            self.shown.store(false, Ordering::SeqCst);
        }

        // A Chrome left open by a previous daemon still owns the profile lock,
        // so launching a second one would just hand off to it and exit.
        if let Some(port) = read_active_port(&self.profile) {
            if cdp_alive(port).await {
                log::info!("claude-browser: adopting running chrome on port {port}");
                *guard = Some(Running { child: None, port });
                // The previous daemon's `shown` flag died with it; read the
                // window's real position so idle shutdown doesn't close a
                // window still on Joe's screen. A failed lookup leaves it false.
                if let Some(on_screen) = window_on_screen(port).await {
                    self.shown.store(on_screen, Ordering::SeqCst);
                }
                return Ok(port);
            }
        }

        let bin = crate::auth::login_flow::find_browser()
            .ok_or_else(|| "no Chrome or Edge install found on this machine".to_string())?;
        std::fs::create_dir_all(&self.profile)
            .map_err(|e| format!("create profile dir {}: {e}", self.profile.display()))?;
        let _ = std::fs::remove_file(self.profile.join("DevToolsActivePort"));

        let mut cmd = Command::new(&bin);
        cmd.args(launch_args(&self.profile))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        let child = cmd.spawn().map_err(|e| format!("launch {}: {e}", bin.display()))?;
        crate::util::process::guard_orphan_tree(&child);
        log::info!("claude-browser: launched {} (pid {:?})", bin.display(), child.id());

        let deadline = Instant::now() + STARTUP_TIMEOUT;
        loop {
            if let Some(port) = read_active_port(&self.profile) {
                if cdp_alive(port).await {
                    *guard = Some(Running { child: Some(child), port });
                    self.shown.store(false, Ordering::SeqCst);
                    return Ok(port);
                }
            }
            if Instant::now() >= deadline {
                return Err("Chrome started but never opened its debugging port".to_string());
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    }

    /// Port of the live browser without starting one.
    pub async fn port_if_running(&self) -> Option<u16> {
        self.running.lock().await.as_ref().map(|r| r.port)
    }

    pub fn is_shown(&self) -> bool {
        self.shown.load(Ordering::SeqCst)
    }

    /// Moves the window on screen (`true`) or back off it (`false`). Showing
    /// starts the browser if it isn't running, so the Settings button also
    /// works for the first manual sign-in.
    pub async fn set_shown(&self, shown: bool) -> Result<(), String> {
        let port = if shown {
            self.ensure_running().await?
        } else {
            match self.port_if_running().await {
                Some(p) => p,
                None => return Ok(()),
            }
        };
        let http = format!("http://127.0.0.1:{port}");
        let ws = cdp::browser_ws_url(&http).await.map_err(|e| e.to_string())?;
        let target = first_page_target(&http, &ws).await?;
        let win = cdp::call(&ws, "Browser.getWindowForTarget", json!({ "targetId": target }), CDP_TIMEOUT)
            .await
            .map_err(|e| e.to_string())?;
        let window_id = win["windowId"].clone();
        // Position can't change while minimized, so restore the state first.
        let _ = cdp::call(
            &ws,
            "Browser.setWindowBounds",
            json!({ "windowId": window_id, "bounds": { "windowState": "normal" } }),
            CDP_TIMEOUT,
        )
        .await;
        let (left, top, width, height) = if shown {
            SHOWN_BOUNDS
        } else {
            (PARKED_XY, PARKED_XY, SHOWN_BOUNDS.2, SHOWN_BOUNDS.3)
        };
        cdp::call(
            &ws,
            "Browser.setWindowBounds",
            json!({ "windowId": window_id, "bounds": { "left": left, "top": top, "width": width, "height": height } }),
            CDP_TIMEOUT,
        )
        .await
        .map_err(|e| e.to_string())?;
        if shown {
            let _ = cdp::call(&ws, "Target.activateTarget", json!({ "targetId": target }), CDP_TIMEOUT).await;
        }
        self.shown.store(shown, Ordering::SeqCst);
        self.touch();
        Ok(())
    }

    pub async fn maybe_idle_shutdown(&self) {
        if self.is_shown() || self.last_active.lock().unwrap().elapsed() < IDLE_TIMEOUT {
            return;
        }
        if self.port_if_running().await.is_some() {
            log::info!("claude-browser: idle for {}m, closing", IDLE_TIMEOUT.as_secs() / 60);
            self.shutdown().await;
        }
    }

    /// Asks Chrome to close itself so the profile is flushed cleanly, then
    /// kills whatever is left.
    pub async fn shutdown(&self) {
        let Some(mut running) = self.running.lock().await.take() else {
            return;
        };
        self.shown.store(false, Ordering::SeqCst);
        let http = format!("http://127.0.0.1:{}", running.port);
        if let Ok(ws) = cdp::browser_ws_url(&http).await {
            let _ = cdp::call(&ws, "Browser.close", json!({}), Duration::from_secs(3)).await;
        }
        if let Some(child) = running.child.as_mut() {
            if tokio::time::timeout(Duration::from_secs(5), child.wait()).await.is_err() {
                let _ = child.kill().await;
            }
        }
    }
}

/// Plain user-facing Chrome flags plus a debugging port. Deliberately no
/// `--enable-automation` or `--headless`: either one flips the signals
/// Google's sign-in checks. The renderer-backgrounding flags keep an
/// off-screen window painting, or screenshots and timers stall.
fn launch_args(profile: &Path) -> Vec<String> {
    vec![
        format!("--user-data-dir={}", profile.display()),
        "--remote-debugging-port=0".to_string(),
        "--no-first-run".to_string(),
        "--no-default-browser-check".to_string(),
        format!("--window-position={PARKED_XY},{PARKED_XY}"),
        format!("--window-size={},{}", SHOWN_BOUNDS.2, SHOWN_BOUNDS.3),
        "--disable-backgrounding-occluded-windows".to_string(),
        "--disable-renderer-backgrounding".to_string(),
        "--disable-background-timer-throttling".to_string(),
        "--disable-features=CalculateNativeWinOcclusion".to_string(),
        "about:blank".to_string(),
    ]
}

fn read_active_port(profile: &Path) -> Option<u16> {
    parse_active_port(&std::fs::read_to_string(profile.join("DevToolsActivePort")).ok()?)
}

/// Chrome writes the chosen port on the first line of `DevToolsActivePort`.
fn parse_active_port(raw: &str) -> Option<u16> {
    raw.lines().next()?.trim().parse::<u16>().ok().filter(|p| *p != 0)
}

async fn cdp_alive(port: u16) -> bool {
    let Ok(client) = reqwest::Client::builder().timeout(Duration::from_secs(2)).build() else {
        return false;
    };
    match client.get(format!("http://127.0.0.1:{port}/json/version")).send().await {
        Ok(r) if r.status().is_success() => r
            .json::<Value>()
            .await
            .map(|v| v.get("webSocketDebuggerUrl").is_some())
            .unwrap_or(false),
        _ => false,
    }
}

/// Whether a `Browser.getWindowForTarget` result sits on a screen rather than
/// at the parking spot. Chrome may nudge the parked position a little, so
/// "far negative on both axes" means parked. `None` when bounds are absent.
fn bounds_on_screen(win: &Value) -> Option<bool> {
    let left = win["bounds"]["left"].as_i64()?;
    let top = win["bounds"]["top"].as_i64()?;
    Some(!(left <= PARKED_XY / 2 && top <= PARKED_XY / 2))
}

/// Reads the live window's position over CDP; `None` if any step fails.
async fn window_on_screen(port: u16) -> Option<bool> {
    let http = format!("http://127.0.0.1:{port}");
    let ws = cdp::browser_ws_url(&http).await.ok()?;
    let target = first_page_target(&http, &ws).await.ok()?;
    let win = cdp::call(&ws, "Browser.getWindowForTarget", json!({ "targetId": target }), CDP_TIMEOUT)
        .await
        .ok()?;
    bounds_on_screen(&win)
}

/// A page target to anchor window calls on, opening a blank tab if every tab
/// was closed.
async fn first_page_target(http: &str, browser_ws: &str) -> Result<String, String> {
    let list: Value = reqwest::get(format!("{http}/json/list"))
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    if let Some(id) = list
        .as_array()
        .and_then(|a| a.iter().find(|t| t["type"] == "page"))
        .and_then(|t| t["id"].as_str())
    {
        return Ok(id.to_string());
    }
    let created = cdp::call(browser_ws, "Target.createTarget", json!({ "url": "about:blank" }), CDP_TIMEOUT)
        .await
        .map_err(|e| e.to_string())?;
    created["targetId"]
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| "Chrome returned no target id".to_string())
}

#[cfg(test)]
pub(super) mod tests_support {
    pub const SHOWN_LEFT: i64 = super::SHOWN_BOUNDS.0;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn active_port_reads_the_first_line() {
        assert_eq!(parse_active_port("53127\n/devtools/browser/abc\n"), Some(53127));
        assert_eq!(parse_active_port("0\n/x"), None, "port 0 means not bound yet");
        assert_eq!(parse_active_port(""), None);
        assert_eq!(parse_active_port("garbage"), None);
    }

    /// Either flag makes Google's sign-in refuse the browser outright.
    #[test]
    fn launch_args_never_mark_the_browser_as_automated() {
        let args = launch_args(Path::new("C:/p"));
        assert!(args.iter().all(|a| !a.contains("enable-automation") && !a.contains("headless")));
        assert!(args.contains(&"--user-data-dir=C:/p".to_string()));
        assert!(args.contains(&"--remote-debugging-port=0".to_string()));
        assert!(args.iter().any(|a| a == "--window-position=-32000,-32000"), "starts off-screen");
    }

    #[test]
    fn parked_bounds_read_as_hidden_and_visible_bounds_as_shown() {
        let parked = json!({ "windowId": 1, "bounds": { "left": PARKED_XY, "top": PARKED_XY } });
        assert_eq!(bounds_on_screen(&parked), Some(false));
        let shown = json!({ "windowId": 1, "bounds": { "left": SHOWN_BOUNDS.0, "top": SHOWN_BOUNDS.1 } });
        assert_eq!(bounds_on_screen(&shown), Some(true));
        // A monitor left of the primary has a negative left but a normal top.
        let left_monitor = json!({ "bounds": { "left": -1500, "top": 40 } });
        assert_eq!(bounds_on_screen(&left_monitor), Some(true));
        assert_eq!(bounds_on_screen(&json!({})), None, "no bounds: unknown, not shown");
    }

    #[tokio::test]
    async fn idle_shutdown_is_a_noop_with_nothing_running() {
        let c = Chrome::new(tempfile::tempdir().unwrap().path().to_path_buf());
        *c.last_active.lock().unwrap() = Instant::now() - IDLE_TIMEOUT - Duration::from_secs(1);
        c.maybe_idle_shutdown().await;
        assert!(c.port_if_running().await.is_none());
    }

    #[tokio::test]
    async fn hiding_a_browser_that_never_started_does_not_launch_one() {
        let c = Chrome::new(tempfile::tempdir().unwrap().path().to_path_buf());
        c.set_shown(false).await.unwrap();
        assert!(c.port_if_running().await.is_none());
        assert!(!c.is_shown());
    }
}
