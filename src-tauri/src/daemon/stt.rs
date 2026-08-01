//! STT sidecar supervisor: lazy-spawns and supervises the host-PC Python
//! `faster-whisper` speech-to-text sidecar (`stt-sidecar/server.py`), which
//! binds `127.0.0.1:27184`. Mirrors `lifecycle.rs` process handling:
//!   - lazy spawn on first `/ws/transcribe` connect (`ensure_running`),
//!   - connection tracking (`on_connect`/`on_disconnect`),
//!   - 5-min idle shutdown (`maybe_idle_shutdown`, driven by a 60s daemon tick),
//!   - graceful kill on daemon exit (`kill`).
//!
//! The sidecar is localhost-only, unauthenticated, host-PC-only; it owns its own
//! socket post-spawn and spawns no children. Windows spawns must never flash a
//! console, so every `Command` runs through `hide_console_tokio`.
//!
//! ai_todo 432: an orphaned sidecar from a previous daemon run can still hold
//! the port. `ensure_running` probes for it and ADOPTS a healthy responder
//! instead of spawning a doomed rival; a genuinely stuck port backs off
//! exponentially instead of crash-looping (see `probe_sidecar_alive`/`backoff_for`).

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

pub const SIDECAR_PORT: u16 = 27184;
const IDLE_TIMEOUT: Duration = Duration::from_secs(300);
// A spawn that dies this fast after launch is a bind race (port already
// held), not a normal crash - the signal that should drive backoff.
const FAST_FAIL_WINDOW: Duration = Duration::from_secs(3);
const MAX_BACKOFF: Duration = Duration::from_secs(60);
const GIVE_UP_THRESHOLD: usize = 8;

pub struct SttSupervisor {
    app_data: PathBuf,
    child: Mutex<Option<Child>>,
    active_conns: AtomicUsize,
    last_active: Mutex<Instant>,
    spawn_started: Mutex<Option<Instant>>,
    consecutive_failures: AtomicUsize,
    backoff_until: Mutex<Option<Instant>>,
    adopted: std::sync::atomic::AtomicBool,
}

/// Exponential backoff after consecutive fast spawn failures, capped so a
/// persistently-squatted port produces a bounded retry cadence (at most
/// once/60s) instead of the 267 spawns/day this todo was filed over.
fn backoff_for(consecutive_failures: usize) -> Duration {
    let secs = 2u64.saturating_pow(consecutive_failures.min(6) as u32);
    Duration::from_secs(secs.min(MAX_BACKOFF.as_secs()))
}

/// Health-probe an already-listening port via a real WS handshake, since the
/// sidecar exposes no HTTP endpoint - a bare TCP connect can't tell "our
/// sidecar" apart from any other process that happens to hold the port.
async fn probe_sidecar_alive() -> bool {
    probe_alive_on(SIDECAR_PORT).await
}

async fn probe_alive_on(port: u16) -> bool {
    let url = format!("ws://127.0.0.1:{port}");
    match tokio::time::timeout(Duration::from_millis(500), tokio_tungstenite::connect_async(&url))
        .await
    {
        Ok(Ok((mut ws, _))) => {
            let _ = ws.close(None).await;
            true
        }
        _ => false,
    }
}

impl SttSupervisor {
    pub fn new(app_data: PathBuf) -> Arc<Self> {
        // Seed a default hotword vocab so the sidecar biases toward the project's
        // jargon on first ever boot. Best-effort: a write failure just means an
        // empty hotword string (the sidecar tolerates a missing file).
        let vdir = app_data.join("voice");
        let _ = std::fs::create_dir_all(&vdir);
        let vfile = vdir.join("voice-vocab.json");
        if !vfile.exists() {
            let seed = serde_json::json!({ "terms": [
                "Tauri","Riverpod","tailscale","daemon","Anthropic","Phosphor",
                "Claude","Opus","Sonnet","companion","webview","vitest","Playwright"
            ]});
            let _ = std::fs::write(&vfile, serde_json::to_string_pretty(&seed).unwrap_or_default());
        }

        Arc::new(Self {
            app_data,
            child: Mutex::new(None),
            active_conns: AtomicUsize::new(0),
            last_active: Mutex::new(Instant::now()),
            spawn_started: Mutex::new(None),
            consecutive_failures: AtomicUsize::new(0),
            backoff_until: Mutex::new(None),
            adopted: std::sync::atomic::AtomicBool::new(false),
        })
    }

    fn sidecar_dir(&self) -> PathBuf {
        // Find the dir that actually holds `stt-sidecar/server.py`. Resolution
        // order (first hit wins) so it works for a dev run AND an installed app
        // whose exe is in Program Files while stt-sidecar/ lives in the repo:
        //   1. CC_STT_SIDECAR_DIR env var (explicit override).
        //   2. <app_data>/voice/sidecar-path.txt (a recorded path; lets the
        //      installed app point at the repo without bundling the venv).
        //   3. walk up from the exe (bundled next-to-exe, or dev target/debug).
        //   4. walk up from the working dir.
        let has = |d: &std::path::Path| d.join("server.py").exists();

        if let Ok(p) = std::env::var("CC_STT_SIDECAR_DIR") {
            let d = PathBuf::from(p.trim());
            if has(&d) {
                return d;
            }
        }

        let pathfile = self.app_data.join("voice").join("sidecar-path.txt");
        if let Ok(raw) = std::fs::read_to_string(&pathfile) {
            // Strip a possible UTF-8 BOM (editors/PowerShell add one) before trim.
            let d = PathBuf::from(raw.trim_start_matches('\u{feff}').trim());
            if has(&d) {
                return d;
            }
        }

        let walk_up = |start: Option<&std::path::Path>| -> Option<PathBuf> {
            let mut dir = start.map(|p| p.to_path_buf());
            for _ in 0..8 {
                let d = dir?;
                let cand = d.join("stt-sidecar");
                if has(&cand) {
                    return Some(cand);
                }
                dir = d.parent().map(|p| p.to_path_buf());
            }
            None
        };

        if let Ok(exe) = std::env::current_exe() {
            if let Some(found) = walk_up(exe.parent()) {
                return found;
            }
        }
        if let Ok(cwd) = std::env::current_dir() {
            if let Some(found) = walk_up(Some(cwd.as_path())) {
                return found;
            }
        }
        PathBuf::from("stt-sidecar")
    }

    pub async fn ensure_running(&self) -> Result<(), String> {
        let mut guard = self.child.lock().await;
        if let Some(c) = guard.as_mut() {
            match c.try_wait() {
                Ok(None) => return Ok(()), // still alive
                Ok(Some(status)) => {
                    // ai_todo 228: prior sessions repeatedly found sidecar-respawn
                    // clusters near unexplained daemon pipe drops, with zero
                    // diagnostic output either time. Surface the exit status so a
                    // future occurrence at least has a reason instead of silence.
                    log::warn!("stt-sidecar exited unexpectedly (status {status:?}); respawning");
                    let fast_fail = matches!(
                        *self.spawn_started.lock().await,
                        Some(t) if t.elapsed() < FAST_FAIL_WINDOW
                    );
                    *guard = None; // drop the reaped handle so it isn't re-detected next call
                    if fast_fail {
                        self.note_fast_failure().await;
                    } else {
                        self.consecutive_failures.store(0, Ordering::SeqCst);
                        *self.backoff_until.lock().await = None;
                    }
                }
                Err(e) => {
                    // Ambiguous liveness - don't trust it's gone. Kill explicitly
                    // before replacing the handle so a still-alive process can't
                    // linger holding the port and starve the next spawn attempt.
                    log::warn!("stt-sidecar liveness check failed ({e}); killing stale handle before respawning");
                    let _ = c.kill().await;
                    *guard = None;
                }
            }
        }

        // ai_todo 432: a previous daemon's sidecar can outlive it and still
        // hold the port. A healthy responder wins ADOPTION over a doomed
        // spawn attempt - this is the real-world case (267 spawns/day against
        // a perfectly healthy orphan).
        if probe_sidecar_alive().await {
            self.consecutive_failures.store(0, Ordering::SeqCst);
            *self.backoff_until.lock().await = None;
            // Log once per adoption, not once per WS connect that re-checks it.
            if !self.adopted.swap(true, Ordering::SeqCst) {
                log::info!("stt-sidecar: adopting existing healthy sidecar on port {SIDECAR_PORT}");
            }
            return Ok(());
        }
        self.adopted.store(false, Ordering::SeqCst);

        if let Some(until) = *self.backoff_until.lock().await {
            if Instant::now() < until {
                return Err(format!(
                    "stt-sidecar: backing off after repeated bind failures on port {SIDECAR_PORT}"
                ));
            }
        }

        let dir = self.sidecar_dir();
        if !dir.join("server.py").exists() {
            return Err(format!(
                "stt-sidecar not found at {dir:?} (set CC_STT_SIDECAR_DIR or write \
                 <app-data>/voice/sidecar-path.txt to point at the repo's stt-sidecar)"
            ));
        }
        let python = dir
            .join(".venv")
            .join(if cfg!(windows) { "Scripts/python.exe" } else { "bin/python" });
        log::info!("stt-sidecar dir resolved to {dir:?} (python: {})", python.exists());
        let mut cmd = Command::new(if python.exists() { python } else { PathBuf::from("python") });
        cmd.current_dir(&dir)
            .arg("server.py")
            .arg("--app-data")
            .arg(&self.app_data)
            .arg("--port")
            .arg(SIDECAR_PORT.to_string())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        crate::util::process::hide_console_tokio(&mut cmd);
        // Belt-and-suspenders orphan guard, mirrors lifecycle.rs: if the
        // daemon exits without reaching the explicit `kill()` shutdown path
        // (panic, forgotten call), dropping this handle still kills the child.
        cmd.kill_on_drop(true);
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("spawn stt-sidecar in {dir:?}: {e}"))?;
        *self.spawn_started.lock().await = Some(Instant::now());
        log::info!("stt-sidecar spawned (pid {:?})", child.id());
        // Drain stderr in the background so an early crash (e.g. a port-bind
        // race against a not-yet-exited previous instance) leaves a reason in
        // the log instead of vanishing into the piped-but-never-read handle.
        if let Some(stderr) = child.stderr.take() {
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    log::warn!("stt-sidecar stderr: {line}");
                }
            });
        }
        *guard = Some(child);
        Ok(())
    }

    /// Record a bind-race failure and set the next backoff deadline. Logs the
    /// backoff once per step, then once more at the give-up threshold - never
    /// once per call, which is what produced 267 spawns/day.
    async fn note_fast_failure(&self) {
        let n = self.consecutive_failures.fetch_add(1, Ordering::SeqCst) + 1;
        let wait = backoff_for(n);
        *self.backoff_until.lock().await = Some(Instant::now() + wait);
        if n == GIVE_UP_THRESHOLD {
            log::warn!(
                "stt-sidecar: {n} consecutive bind failures on port {SIDECAR_PORT}; giving up on \
                 fast retries, settling into a {wait:?} cadence"
            );
        } else if n < GIVE_UP_THRESHOLD {
            log::warn!("stt-sidecar: bind failure {n} in a row; backing off {wait:?}");
        }
    }

    pub fn on_connect(&self) {
        self.active_conns.fetch_add(1, Ordering::SeqCst);
    }

    pub async fn on_disconnect(&self) {
        self.active_conns.fetch_sub(1, Ordering::SeqCst);
        *self.last_active.lock().await = Instant::now();
    }

    pub async fn maybe_idle_shutdown(&self) {
        if self.active_conns.load(Ordering::SeqCst) > 0 {
            return;
        }
        if self.last_active.lock().await.elapsed() < IDLE_TIMEOUT {
            return;
        }
        self.kill().await;
    }

    pub async fn kill(&self) {
        if let Some(mut c) = self.child.lock().await.take() {
            let _ = c.kill().await;
            log::info!("stt-sidecar killed (idle/shutdown)");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ai_todo 432 regression: consecutive bind failures must back off
    // exponentially and cap at MAX_BACKOFF, never re-spawn at a flat rate.
    #[test]
    fn backoff_grows_then_caps() {
        assert_eq!(backoff_for(1), Duration::from_secs(2));
        assert_eq!(backoff_for(2), Duration::from_secs(4));
        assert_eq!(backoff_for(5), Duration::from_secs(32));
        assert_eq!(backoff_for(6), Duration::from_secs(60));
        assert_eq!(backoff_for(20), Duration::from_secs(60));
    }

    // A plain TCP listener that never speaks WebSocket must NOT be mistaken
    // for a healthy sidecar - otherwise a rogue port squatter gets "adopted".
    #[tokio::test]
    async fn probe_rejects_non_websocket_listener() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let _ = listener.accept().await; // accept and go silent, no WS handshake
        });
        assert!(!probe_alive_on(port).await);
    }

    #[tokio::test]
    async fn probe_rejects_closed_port() {
        // Port 1 is a reserved low port that is never listening in this test env.
        assert!(!probe_alive_on(1).await);
    }

    // ADVERSARIAL: a real WS-speaking server on a scratch port must be ADOPTED.
    #[tokio::test]
    async fn probe_accepts_real_websocket_server() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            if let Ok((stream, _)) = listener.accept().await {
                if let Ok(ws) = tokio_tungstenite::accept_async(stream).await {
                    // Hold the accepted socket open briefly so the client's
                    // close handshake (probe_alive_on calls ws.close()) has
                    // something to complete against.
                    let _ = ws;
                    tokio::time::sleep(Duration::from_millis(200)).await;
                }
            }
        });
        assert!(probe_alive_on(port).await);
    }

    // ADVERSARIAL: a listener that accepts the TCP connection then closes it
    // immediately (no WS upgrade response at all) must NOT be adopted.
    #[tokio::test]
    async fn probe_rejects_accept_then_close() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            if let Ok((stream, _)) = listener.accept().await {
                drop(stream); // accept, then slam the connection shut
            }
        });
        assert!(!probe_alive_on(port).await);
    }

    // ADVERSARIAL: a listener that speaks valid HTTP but never upgrades to
    // WebSocket (e.g. a stray HTTP server squatting the port) must NOT be
    // mistaken for the sidecar.
    #[tokio::test]
    async fn probe_rejects_plain_http_non_websocket() {
        use tokio::io::AsyncWriteExt;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            if let Ok((mut stream, _)) = listener.accept().await {
                let _ = stream
                    .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n")
                    .await;
                let _ = stream.shutdown().await;
            }
        });
        assert!(!probe_alive_on(port).await);
    }
}
