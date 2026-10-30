//! Claude's own Chrome: one persistent profile under app data, separate from
//! every profile Joe uses. Launched as an ordinary visible window rather than
//! headless, because Google's sign-in refuses headless browsers and because
//! Joe has to be able to see it to sign in or get past a CAPTCHA; he minimizes
//! it if it is in the way. Lazy start, idle shutdown (skipped while a window is
//! not minimized, since Claude's tool calls are the only activity the timer
//! sees and Joe signing in by hand makes none), graceful close on daemon exit.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

use crate::auth::cdp;

const IDLE_TIMEOUT: Duration = Duration::from_secs(20 * 60);
const STARTUP_TIMEOUT: Duration = Duration::from_secs(20);
const CDP_TIMEOUT: Duration = Duration::from_secs(5);
/// Where a window parked off-screen sits (Windows keeps minimized and hidden
/// windows near -32000), so anything this far out is not reachable by Joe.
const OFFSCREEN_EDGE: i64 = -30_000;
/// Where an off-screen window is brought back to.
const ONSCREEN_ORIGIN: i64 = 100;

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
                // A Chrome from an older build can still be parked off-screen,
                // where Joe could never reach it to sign in.
                if let Err(e) = bring_offscreen_windows_back(port).await {
                    log::warn!("claude-browser: could not check the adopted window position: {e}");
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
        let Some(port) = self.port_if_running().await else { return };
        // Joe signing in or clearing a CAPTCHA makes no tool call, so a window
        // he has not minimized counts as activity. A browser that cannot be
        // asked is closed as before.
        match browser_windows(port).await {
            Ok(windows) if windows.iter().any(WindowInfo::in_use) => {
                self.touch();
                return;
            }
            Ok(_) => {}
            Err(e) => log::warn!("claude-browser: could not read the window state before the idle close: {e}"),
        }
        log::info!("claude-browser: idle for {}m, closing", IDLE_TIMEOUT.as_secs() / 60);
        self.shutdown().await;
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

/// One browser window as `Browser.getWindowForTarget` reports it.
#[derive(Debug, PartialEq)]
struct WindowInfo {
    id: i64,
    /// `normal`, `minimized`, `maximized` or `fullscreen`.
    state: String,
    left: i64,
    top: i64,
}

impl WindowInfo {
    fn parse(v: &Value) -> Option<Self> {
        let bounds = v.get("bounds")?;
        Some(Self {
            id: v.get("windowId")?.as_i64()?,
            state: bounds.get("windowState").and_then(Value::as_str).unwrap_or("normal").to_string(),
            left: bounds.get("left").and_then(Value::as_i64).unwrap_or(0),
            top: bounds.get("top").and_then(Value::as_i64).unwrap_or(0),
        })
    }

    /// Joe can see it, so he may be using it. A minimized window is the one he
    /// has put out of his way.
    fn in_use(&self) -> bool {
        self.state != "minimized"
    }

    /// Visible state but positioned where no screen shows it. A minimized
    /// window also reports far-off coordinates, which are not a problem.
    fn stranded_offscreen(&self) -> bool {
        self.in_use() && (self.left <= OFFSCREEN_EDGE || self.top <= OFFSCREEN_EDGE)
    }
}

/// Every window of the browser on `port`, one entry per window however many
/// tabs it holds.
async fn browser_windows(port: u16) -> Result<Vec<WindowInfo>, String> {
    let ws = cdp::browser_ws_url(&format!("http://127.0.0.1:{port}")).await.map_err(|e| e.to_string())?;
    let targets = cdp::call(&ws, "Target.getTargets", json!({}), CDP_TIMEOUT).await.map_err(|e| e.to_string())?;
    let mut windows: Vec<WindowInfo> = Vec::new();
    for target in targets["targetInfos"].as_array().into_iter().flatten() {
        let (Some("page"), Some(id)) = (target["type"].as_str(), target["targetId"].as_str()) else { continue };
        let reply = cdp::call(&ws, "Browser.getWindowForTarget", json!({ "targetId": id }), CDP_TIMEOUT)
            .await
            .map_err(|e| e.to_string())?;
        if let Some(window) = WindowInfo::parse(&reply) {
            if !windows.iter().any(|w| w.id == window.id) {
                windows.push(window);
            }
        }
    }
    Ok(windows)
}

/// Moves each visible window that sits off-screen back to a reachable corner.
async fn bring_offscreen_windows_back(port: u16) -> Result<(), String> {
    let stranded: Vec<_> = browser_windows(port).await?.into_iter().filter(WindowInfo::stranded_offscreen).collect();
    if stranded.is_empty() {
        return Ok(());
    }
    let ws = cdp::browser_ws_url(&format!("http://127.0.0.1:{port}")).await.map_err(|e| e.to_string())?;
    for window in stranded {
        log::info!("claude-browser: window {} was off-screen at ({}, {}); moving it back", window.id, window.left, window.top);
        let bounds = json!({ "left": ONSCREEN_ORIGIN, "top": ONSCREEN_ORIGIN, "windowState": "normal" });
        cdp::call(&ws, "Browser.setWindowBounds", json!({ "windowId": window.id, "bounds": bounds }), CDP_TIMEOUT)
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(())
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
    use std::sync::Arc;

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

    /// A stand-in for Chrome's DevTools endpoint: `/json/version` plus a
    /// browser-level websocket that answers the few methods this module uses
    /// and records every call, so no real Chrome is launched.
    struct FakeChrome {
        port: u16,
        calls: Arc<std::sync::Mutex<Vec<(String, Value)>>>,
    }

    impl FakeChrome {
        /// `window_state` and `(left, top)` describe the one window it reports.
        async fn start(window_state: &str, left: i64, top: i64) -> Self {
            use axum::extract::ws::{Message, WebSocketUpgrade};
            use axum::routing::get;

            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = listener.local_addr().unwrap().port();
            let calls: Arc<std::sync::Mutex<Vec<(String, Value)>>> = Arc::default();
            let bounds = json!({ "left": left, "top": top, "width": 800, "height": 600, "windowState": window_state });
            let recorded = calls.clone();
            let app = axum::Router::new()
                .route(
                    "/json/version",
                    get(move || async move {
                        axum::Json(json!({ "webSocketDebuggerUrl": format!("ws://127.0.0.1:{port}/devtools/browser/fake") }))
                    }),
                )
                .route(
                    "/devtools/browser/fake",
                    get(move |ws: WebSocketUpgrade| async move {
                        ws.on_upgrade(move |mut socket| async move {
                            while let Some(Ok(Message::Text(text))) = socket.recv().await {
                                let req: Value = serde_json::from_str(&text).unwrap();
                                let method = req["method"].as_str().unwrap_or_default().to_string();
                                recorded.lock().unwrap().push((method.clone(), req["params"].clone()));
                                let result = match method.as_str() {
                                    "Target.getTargets" => json!({ "targetInfos": [
                                        { "targetId": "t1", "type": "page" },
                                        { "targetId": "sw", "type": "service_worker" },
                                    ] }),
                                    "Browser.getWindowForTarget" => json!({ "windowId": 7, "bounds": bounds }),
                                    _ => json!({}),
                                };
                                let reply = json!({ "id": req["id"], "result": result });
                                if socket.send(Message::Text(reply.to_string())).await.is_err() {
                                    break;
                                }
                            }
                        })
                    }),
                );
            tokio::spawn(async move {
                let _ = axum::serve(listener, app).await;
            });
            Self { port, calls }
        }

        fn methods(&self) -> Vec<String> {
            self.calls.lock().unwrap().iter().map(|(m, _)| m.clone()).collect()
        }

        /// A `Chrome` that already holds this fake as its running browser and
        /// has sat idle past the timeout.
        async fn idle_chrome(&self) -> Chrome {
            let c = Chrome::new(tempfile::tempdir().unwrap().path().to_path_buf());
            *c.running.lock().await = Some(Running { child: None, port: self.port });
            *c.last_active.lock().unwrap() = Instant::now() - IDLE_TIMEOUT - Duration::from_secs(1);
            c
        }
    }

    /// Joe signing in by hand makes no tool call, so a window he has not
    /// minimized keeps the browser open and restarts the idle clock.
    #[tokio::test]
    async fn idle_shutdown_leaves_a_window_the_user_is_using_open() {
        let fake = FakeChrome::start("normal", 100, 100).await;
        let c = fake.idle_chrome().await;

        c.maybe_idle_shutdown().await;

        assert_eq!(c.port_if_running().await, Some(fake.port), "still running");
        assert!(!fake.methods().contains(&"Browser.close".to_string()), "got {:?}", fake.methods());
        assert!(c.last_active.lock().unwrap().elapsed() < IDLE_TIMEOUT, "the idle clock restarts");
    }

    #[tokio::test]
    async fn idle_shutdown_closes_a_minimized_browser() {
        let fake = FakeChrome::start("minimized", -32000, -32000).await;
        let c = fake.idle_chrome().await;

        c.maybe_idle_shutdown().await;

        assert!(c.port_if_running().await.is_none());
        assert!(fake.methods().contains(&"Browser.close".to_string()), "got {:?}", fake.methods());
    }

    #[tokio::test]
    async fn idle_shutdown_leaves_a_recently_used_browser_alone() {
        let fake = FakeChrome::start("minimized", -32000, -32000).await;
        let c = fake.idle_chrome().await;
        c.touch();

        c.maybe_idle_shutdown().await;

        assert_eq!(c.port_if_running().await, Some(fake.port));
        assert!(fake.methods().is_empty(), "no CDP traffic before the timeout");
    }

    /// Adopting a Chrome that an older build parked off-screen moves its window
    /// to where Joe can reach it.
    #[tokio::test]
    async fn adopting_an_offscreen_window_moves_it_back_on_screen() {
        let fake = FakeChrome::start("normal", -32000, -32000).await;
        let profile = tempfile::tempdir().unwrap();
        std::fs::write(
            profile.path().join("DevToolsActivePort"),
            format!("{}\n/devtools/browser/fake\n", fake.port),
        )
        .unwrap();
        let c = Chrome::new(profile.path().to_path_buf());

        assert_eq!(c.ensure_running().await, Ok(fake.port));

        let calls = fake.calls.lock().unwrap().clone();
        let (_, params) = calls
            .iter()
            .find(|(m, _)| m == "Browser.setWindowBounds")
            .unwrap_or_else(|| panic!("no setWindowBounds in {:?}", fake.methods()));
        assert_eq!(params["windowId"], json!(7));
        assert_eq!(params["bounds"]["left"], json!(ONSCREEN_ORIGIN));
        assert_eq!(params["bounds"]["top"], json!(ONSCREEN_ORIGIN));
        assert_eq!(params["bounds"]["windowState"], json!("normal"));
    }

    /// A minimized window also reports -32000, and a visible one on screen
    /// needs nothing: neither is moved.
    #[tokio::test]
    async fn adopting_a_minimized_or_visible_window_moves_nothing() {
        for (state, left, top) in [("minimized", -32000, -32000), ("normal", 40, 60)] {
            let fake = FakeChrome::start(state, left, top).await;
            let profile = tempfile::tempdir().unwrap();
            std::fs::write(profile.path().join("DevToolsActivePort"), format!("{}\n/x\n", fake.port)).unwrap();
            let c = Chrome::new(profile.path().to_path_buf());

            assert_eq!(c.ensure_running().await, Ok(fake.port));

            assert!(!fake.methods().contains(&"Browser.setWindowBounds".to_string()), "{state}: {:?}", fake.methods());
        }
    }

    #[test]
    fn a_window_reply_reads_its_state_and_position() {
        let w = WindowInfo::parse(&json!({
            "windowId": 3,
            "bounds": { "left": -32000, "top": -32000, "windowState": "normal" }
        }))
        .unwrap();
        assert_eq!(w, WindowInfo { id: 3, state: "normal".into(), left: -32000, top: -32000 });
        assert!(w.in_use() && w.stranded_offscreen());
        let minimized = WindowInfo { state: "minimized".into(), ..w };
        assert!(!minimized.in_use() && !minimized.stranded_offscreen());
        assert_eq!(WindowInfo::parse(&json!({ "bounds": {} })), None, "no window id");
    }
}
