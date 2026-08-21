//! Persistent app-side client for the daemon. Multiplexes RPC calls + per
//! -session notification subscriptions over a single named pipe connection.
//! Uses `tokio::io::split` so reads and writes run concurrently without
//! contending on a single mutex.
//!
//! This file holds only the transport/connection plumbing (connect, the
//! multiplexed `call`, subscription bookkeeping, address construction,
//! `ensure_daemon`). The dozens of typed one-line RPC wrapper methods on
//! `PersistentClient` (e.g. `takeover_manual`, `schedule_fire_now`) live in
//! `methods.rs` - ai_todo 265.

use crate::daemon::frame::{read_frame, write_frame, FrameError};
use crate::daemon::health::PROTOCOL_VERSION;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use thiserror::Error;
use tokio::sync::{mpsc, oneshot, Mutex};

mod methods;

/// ai_todo 228 diagnostics: each successful `connect()` gets the next value so
/// "reader stopped" / "connection lost" log lines across a respawn cycle can be
/// paired up precisely instead of by timestamp proximity alone.
static NEXT_GENERATION: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Error)]
pub enum ClientError {
    #[error("io: {0}")]
    Io(#[from] io::Error),
    #[error("frame: {0}")]
    Frame(#[from] crate::daemon::frame::FrameError),
    #[error("handshake failed: {0}")]
    Handshake(String),
    #[error("rpc error: code={code} message={message}")]
    Rpc { code: i32, message: String },
    #[error("client closed")]
    Closed,
}

#[cfg(windows)]
type WriteHalf = tokio::io::WriteHalf<tokio::net::windows::named_pipe::NamedPipeClient>;
#[cfg(unix)]
type WriteHalf = tokio::io::WriteHalf<tokio::net::UnixStream>;

#[derive(Clone)]
pub struct PersistentClient {
    writer: Arc<Mutex<WriteHalf>>,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>>,
    subs: Arc<Mutex<HashMap<String, mpsc::Sender<Value>>>>,
    next_id: Arc<Mutex<u64>>,
    /// Flips to `true` when the reader task exits (pipe died). `call()` consults
    /// it so a request issued after the connection dropped fails fast instead of
    /// parking a `pending` sender no one will ever answer. See the reader task in
    /// `connect` for why a dead reader must wake every waiter (the "wedged pipe"
    /// bug: send/open/close hung + reconnect never fired until a full restart).
    closed: tokio::sync::watch::Receiver<bool>,
    /// ai_todo 228 diagnostics: see `NEXT_GENERATION`.
    pub generation: u64,
}

impl PersistentClient {
    /// Connect to the daemon at `addr`: a named-pipe name on Windows, a
    /// Unix-domain-socket path on mac/Linux. The handshake + reader-task plumbing
    /// is identical across platforms; only opening the stream differs.
    pub async fn connect(addr: &str) -> Result<Self, ClientError> {
        #[cfg(windows)]
        let mut pipe = {
            use tokio::net::windows::named_pipe::ClientOptions;
            ClientOptions::new().open(addr)?
        };
        #[cfg(unix)]
        let mut pipe = tokio::net::UnixStream::connect(addr).await?;
        // Handshake first on the unsplit pipe so it's synchronous.
        write_frame(&mut pipe, &json!({"protocol_version": PROTOCOL_VERSION})).await?;
        let resp = read_frame(&mut pipe).await?;
        if resp.get("handshake").and_then(Value::as_str) != Some("ok") {
            return Err(ClientError::Handshake(resp.to_string()));
        }
        let generation = NEXT_GENERATION.fetch_add(1, Ordering::Relaxed);
        log::info!("daemon: connected (generation {generation})");
        // Split into independent read/write halves.
        let (read_half, write_half) = tokio::io::split(pipe);
        let writer = Arc::new(Mutex::new(write_half));
        let pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>> = Arc::new(Mutex::new(HashMap::new()));
        let subs: Arc<Mutex<HashMap<String, mpsc::Sender<Value>>>> = Arc::new(Mutex::new(HashMap::new()));

        let pending_for_reader = Arc::clone(&pending);
        let subs_for_reader = Arc::clone(&subs);
        let (closed_tx, closed_rx) = tokio::sync::watch::channel(false);
        tokio::spawn(async move {
            let mut read_half = read_half;
            loop {
                let frame = match read_frame(&mut read_half).await {
                    Ok(f) => f,
                    Err(e) => {
                        // Log why the pipe reader stopped so recurring drops can be
                        // diagnosed. For io errors surface the ErrorKind (e.g.
                        // UnexpectedEof = clean daemon shutdown vs BrokenPipe/reset).
                        match &e {
                            FrameError::Io(io_err) => log::warn!(
                                "daemon pipe reader stopped (generation {generation}): io error kind={:?}: {io_err}",
                                io_err.kind()
                            ),
                            other => log::warn!("daemon pipe reader stopped (generation {generation}): {other}"),
                        }
                        break;
                    }
                };
                if frame.get("method").is_some() {
                    // Server-to-client notification.
                    // Only `chat_event` is session-scoped; route it to the
                    // per-session subscriber registered by `attach_session`.
                    // All other notifications (turn_sound, instances_changed,
                    // refresh_requested, etc.) are global — even when they carry
                    // a session_id as data — and must reach the global slot ("").
                    let method = frame.get("method").and_then(Value::as_str).unwrap_or("");
                    let session_id = if method == "chat_event" {
                        frame.pointer("/params/session_id")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string()
                    } else {
                        String::new()
                    };
                    let subs = subs_for_reader.lock().await;
                    if let Some(tx) = subs.get(&session_id) {
                        let started = std::time::Instant::now();
                        let send_result = tx.send(frame).await;
                        crate::daemon::rpc::log_if_slow(
                            started,
                            "reader dispatch",
                            format_args!("session={session_id:?} elapsed={:?}", started.elapsed()),
                        );
                        let _ = send_result;
                    }
                } else if let Some(id) = frame.get("id").and_then(Value::as_u64) {
                    let mut pending = pending_for_reader.lock().await;
                    if let Some(tx) = pending.remove(&id) {
                        let _ = tx.send(frame);
                    }
                }
            }
            // The pipe died. Wake every waiter so the connection can't wedge:
            //  - drop all `pending` oneshot senders -> in-flight `call()`s resolve
            //    to `Err(Closed)` instead of hanging forever;
            //  - drop all `subs` mpsc senders -> the global subscription's
            //    `rx.recv()` returns `None`, which is the signal `daemon_link`'s
            //    reconnect loop waits for to rebuild the connection;
            //  - flip `closed` so any `call()` racing in after this point fails
            //    fast rather than parking a sender no reader will ever answer.
            pending_for_reader.lock().await.clear();
            subs_for_reader.lock().await.clear();
            let _ = closed_tx.send(true);
        });

        Ok(Self {
            writer,
            pending,
            subs,
            next_id: Arc::new(Mutex::new(0)),
            closed: closed_rx,
            generation,
        })
    }

    // No in-place retry here (unlike relay.rs's is_retryable, todo 714): a
    // dropped connection rebuilds entirely via ensure_daemon, so a failed call
    // just errors up rather than retrying mid-request.
    pub async fn call(&self, method: &str, params: Value) -> Result<Value, ClientError> {
        // Clone the close-watch BEFORE the borrow so a reader that dies between
        // the borrow and the `select!` below still wakes us via `changed()`
        // (the clone's "seen" version is fixed here; any later flip is a change).
        let mut closed = self.closed.clone();
        if *closed.borrow() {
            return Err(ClientError::Closed);
        }
        let id = {
            let mut n = self.next_id.lock().await;
            *n += 1;
            *n
        };
        let req = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        let (tx, rx) = oneshot::channel();
        {
            let mut pending = self.pending.lock().await;
            pending.insert(id, tx);
        }
        {
            let mut w = self.writer.lock().await;
            if let Err(e) = write_frame(&mut *w, &req).await {
                self.pending.lock().await.remove(&id);
                return Err(e.into());
            }
        }
        // Wait for the reply, but bail the instant the connection closes so a
        // request issued just before the reader died can't hang forever.
        let resp = tokio::select! {
            r = rx => r.map_err(|_| ClientError::Closed)?,
            _ = closed.changed() => {
                self.pending.lock().await.remove(&id);
                return Err(ClientError::Closed);
            }
        };
        if let Some(err) = resp.get("error") {
            let code = err.get("code").and_then(Value::as_i64).unwrap_or(-1) as i32;
            let message = err.get("message").and_then(Value::as_str).unwrap_or("").to_string();
            return Err(ClientError::Rpc { code, message });
        }
        Ok(resp.get("result").cloned().unwrap_or(Value::Null))
    }

    pub async fn subscribe_global(&self) -> Result<mpsc::Receiver<Value>, ClientError> {
        let (tx, rx) = mpsc::channel(256);
        {
            let mut subs = self.subs.lock().await;
            // Empty-string key is the "no session_id" / global slot.
            subs.insert(String::new(), tx);
        }
        self.call("subscribe_global", json!({})).await?;
        Ok(rx)
    }

    pub async fn attach_session(&self, session_id: &str) -> Result<mpsc::Receiver<Value>, ClientError> {
        let (tx, rx) = mpsc::channel(256);
        {
            let mut subs = self.subs.lock().await;
            subs.insert(session_id.to_string(), tx);
        }
        // `delta: true` = this client understands the O(delta) `assistant_delta`
        // stream protocol (ai_todo 186). An older daemon ignores the extra
        // field and keeps sending full-text snapshots, which the frontend
        // still accepts - both skew directions stay compatible.
        self.call("attach_session", json!({"session_id": session_id, "delta": true})).await?;
        Ok(rx)
    }

    /// Stop receiving a session's events. Drops the local per-session sender so
    /// the app-side bridge pump's receiver closes and its task exits (instead of
    /// blocking forever on a receiver that never closes - ai_todo 66 #2), then
    /// tells the daemon to abort its relay task for this session. Idempotent.
    pub async fn detach_session(&self, session_id: &str) -> Result<(), ClientError> {
        {
            let mut subs = self.subs.lock().await;
            subs.remove(session_id);
        }
        self.call("detach_session", json!({"session_id": session_id})).await?;
        Ok(())
    }
}

/// Address for a given instance suffix directly (bypassing `instance_suffix()`
/// so callers can probe a DIFFERENT identity than the one this process would
/// otherwise use - see `ensure_daemon`'s production-attach probe). Delegates
/// to the daemon-side transport modules so exactly one place builds each
/// platform's address string (ai_todo 267).
fn daemon_addr_for_suffix(suffix: &str) -> String {
    #[cfg(windows)]
    {
        crate::daemon::transport_windows::pipe_name_for_suffix(suffix)
    }
    #[cfg(unix)]
    {
        crate::daemon::transport_unix::socket_path_for_suffix(suffix).to_string_lossy().into_owned()
    }
}

/// Address the app uses to reach the daemon: a named-pipe name on Windows, a
/// Unix-domain-socket path on mac/Linux. Must match the daemon's bind address.
pub fn daemon_addr_for_current_user() -> String {
    daemon_addr_for_suffix(&crate::daemon::instance::instance_suffix())
}

/// Try to connect to the daemon; if none is listening, spawn one detached
/// (`<exe> --daemon`) and poll the transport until it binds (~10s budget), then
/// connect. The daemon's lockfile prevents a duplicate if two apps race here.
///
/// Pre-spawn poll (2s): handles the simultaneous-launch race where the OS
/// auto-updater restarts the app and daemon at the exact same second. Without
/// this window, the app immediately spawns a redundant daemon that exits on the
/// lockfile, and the 10s post-spawn poll competes with the original daemon's
/// startup. The pre-spawn poll skips the redundant spawn if the original daemon
/// becomes ready within 2s.
pub async fn ensure_daemon() -> Result<PersistentClient, ClientError> {
    // Debug builds default to ATTACHING to whichever daemon is already
    // running (almost always the user's real installed app) instead of
    // spawning an isolated one. Most dev work never touches the daemon's own
    // Rust code - it's UI/app-side only - so this gives real live data with
    // zero duplication. `CC_DEV_OWN_DAEMON` opts back into an isolated `-dev`
    // daemon on purpose (testing an actual daemon-side change);
    // `CC_DAEMON_INSTANCE` (the test harness) always skips this attempt so a
    // test never accidentally attaches to a real running daemon.
    let want_own_daemon = std::env::var("CC_DEV_OWN_DAEMON").is_ok()
        || std::env::var("CC_DAEMON_INSTANCE").is_ok();
    if cfg!(debug_assertions) && !want_own_daemon {
        let prod_addr = daemon_addr_for_suffix("");
        if let Ok(c) = PersistentClient::connect(&prod_addr).await {
            crate::daemon::instance::mark_attached_to_existing();
            log::info!("dev: attached to the already-running daemon instead of spawning its own");
            return Ok(c);
        }
    }

    let addr = daemon_addr_for_current_user();
    if let Ok(c) = PersistentClient::connect(&addr).await {
        return Ok(c);
    }
    // Pre-spawn: wait up to 2s in case the daemon is already starting.
    for _ in 0..10 {
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        if let Ok(c) = PersistentClient::connect(&addr).await {
            return Ok(c);
        }
    }
    // Still nothing: spawn the daemon ourselves.
    match crate::daemon::spawn_self::spawn_detached_daemon() {
        Ok(pid) => log::info!("spawned daemon (pid {pid})"),
        Err(e) => log::error!("failed to spawn daemon: {e}"),
    }
    // Post-spawn poll: ~10s budget (heavier init paths can take a few seconds).
    for _ in 0..50 {
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        if let Ok(c) = PersistentClient::connect(&addr).await {
            return Ok(c);
        }
    }
    PersistentClient::connect(&addr).await
}

// The `persistent_client_health_against_real_daemon` test (exercises `connect`
// + the `health()` wrapper end-to-end against a spawned daemon) lives in
// `methods.rs` alongside `health()` - ai_todo 265.
