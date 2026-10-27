//! Claude's own Chrome: one persistent profile under app data, separate from
//! every profile Joe uses. Launched as an ordinary visible window rather than
//! headless, because Google's sign-in refuses headless browsers and because
//! Joe has to be able to see it to sign in or get past a CAPTCHA; he minimizes
//! it if it is in the way. Lazy start, idle shutdown, graceful close on
//! daemon exit.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

use crate::auth::cdp;

const IDLE_TIMEOUT: Duration = Duration::from_secs(20 * 60);
const STARTUP_TIMEOUT: Duration = Duration::from_secs(20);

pub struct Chrome {
    profile: PathBuf,
    running: Mutex<Option<Running>>,
    last_active: std::sync::Mutex<Instant>,
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
        }

        // A Chrome left open by a previous daemon still owns the profile lock,
        // so launching a second one would just hand off to it and exit.
        if let Some(port) = read_active_port(&self.profile) {
            if cdp_alive(port).await {
                log::info!("claude-browser: adopting running chrome on port {port}");
                *guard = Some(Running { child: None, port });
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

    pub async fn maybe_idle_shutdown(&self) {
        if self.last_active.lock().unwrap().elapsed() < IDLE_TIMEOUT {
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
/// Google's sign-in checks. The renderer-backgrounding flags keep a minimized
/// or covered window painting, or screenshots and timers stall.
fn launch_args(profile: &Path) -> Vec<String> {
    vec![
        format!("--user-data-dir={}", profile.display()),
        "--remote-debugging-port=0".to_string(),
        "--no-first-run".to_string(),
        "--no-default-browser-check".to_string(),
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
        assert!(args.iter().all(|a| !a.starts_with("--window-position")), "opens where Chrome puts it, on screen");
    }

    #[tokio::test]
    async fn idle_shutdown_is_a_noop_with_nothing_running() {
        let c = Chrome::new(tempfile::tempdir().unwrap().path().to_path_buf());
        *c.last_active.lock().unwrap() = Instant::now() - IDLE_TIMEOUT - Duration::from_secs(1);
        c.maybe_idle_shutdown().await;
        assert!(c.port_if_running().await.is_none());
    }
}
