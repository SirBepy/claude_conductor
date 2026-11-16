//! Iroh client half of the remote-access tunnel, serving a per-PC loopback port.
//! Inverts `src-tauri/src/daemon/iroh_tunnel.rs::forward`: the daemon splices a
//! QUIC bi-stream onto a fresh TCP connection, here it is the other way round.
//!
//! Every loopback TCP connection rides its own bi-stream on ONE shared QUIC
//! connection. The daemon side already loops `accept_bi` per connection, so
//! no change is needed there.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use iroh::endpoint::{presets, Connection, RecvStream, SendStream, VarInt};
use iroh::{Endpoint, EndpointAddr, EndpointId, RelayUrl, TransportAddr};
use log::{error, info, warn};
use tokio::net::TcpListener;
use tokio::sync::Mutex;

use crate::forward::{accept_loop, journal_accept_loop};
use crate::journal::{self, Journal};
use crate::quiet_watch::{read_traffic, QuietVerdict, QuietWatch, Traffic, QUIET_DEAD, QUIET_NUDGE, UPLINK_DEAD, UPLINK_NUDGE};
use crate::tunnel_ports::{bind_journal_listener, bind_loopback, port_candidates, LIVE_PORTS};

pub(crate) type BoxError = Box<dyn std::error::Error + Send + Sync>;

/// Must match `src-tauri/src/daemon/iroh_tunnel.rs::ALPN` exactly.
pub(crate) const ALPN: &[u8] = b"conductor/remote/0";

/// Upper bound on the FIRST dial attempt of a `connection()` call. Without one,
/// a connect made while iroh still holds pre-sleep network state hangs the
/// WebView request forever. Short on purpose: a Pixel 7 measured a fresh endpoint
/// dialing in 272ms while a stale one burned 15s per try. A call that follows a
/// lost connection binds a fresh endpoint before this attempt, so a slow one
/// here means a slow link, not stale state.
const ATTEMPT_TIMEOUT: Duration = Duration::from_secs(6);

/// Upper bound on the SECOND attempt. It runs on the same endpoint as the first
/// one, which by then has its relay connection and address lookup under way, so
/// it only needs time. On a slow link a cold dial needs more than
/// `ATTEMPT_TIMEOUT`, and abandoning every attempt at that mark never connects.
const RETRY_ATTEMPT_TIMEOUT: Duration = Duration::from_secs(12);

/// Dials per `connection()` call.
const DIAL_ATTEMPTS: u32 = 2;

/// Upper bound on binding a replacement endpoint. Binding is local socket
/// setup, so only a wedged runtime reaches this; the call then dials the old
/// endpoint instead.
const REBIND_TIMEOUT: Duration = Duration::from_secs(3);

/// Opening a stream is local bookkeeping and only waits when the peer's
/// concurrent-stream limit is used up - a busy connection, not a dead one, so
/// a timeout fails just this socket and never tears the connection down.
const OPEN_STREAM_TIMEOUT: Duration = Duration::from_secs(5);


pub(crate) const WATCHDOG_TICK: Duration = Duration::from_secs(2);

/// A forwarded request still unanswered after this long is journaled as
/// `stream_slow` with the connection's counters. Below the page's 15s silence
/// limit so the line exists for every request that ends in a "silence" failure.
const SLOW_STREAM: Duration = Duration::from_secs(5);

/// How much later than `WATCHDOG_TICK` a tick may arrive on the wall clock
/// before it is journaled as late; scheduler jitter stays far below it.
const TICK_LATE_SLACK: Duration = Duration::from_secs(3);

/// A wall-clock gap this much longer than one watchdog tick means the process
/// was frozen or the phone slept. `tokio::time` runs on CLOCK_MONOTONIC, which
/// stops during device suspend, so only the wall clock shows the gap.
/// `connection()` stamps `last_alive` on every exit, so time spent inside a dial
/// never counts toward this gap; only time between calls does.
const RESUME_GAP: Duration = Duration::from_secs(20);

/// How often a dial in flight checks the wall clock for a stopped process.
const STOP_TICK: Duration = Duration::from_millis(250);

/// Wall-clock distance between two consecutive `STOP_TICK`s that means the
/// process was stopped. Far above scheduler jitter, far below what a user waits.
const STOP_GAP: Duration = Duration::from_secs(5);

/// A dial that sleeps restarts on a fresh endpoint; this bounds the restarts per
/// call so a wall clock that keeps jumping cannot loop forever.
const MAX_SLEEP_RESTARTS: u32 = 2;

/// How long `remote_known` waits on iroh's remote-state actor. It sits under the
/// connection lock, so a wedged actor must not stall every socket.
const REMOTE_INFO_TIMEOUT: Duration = Duration::from_millis(250);

/// Upper bound on one `Endpoint::network_change` call. iroh only enqueues a
/// message to its socket actor there, so it is fast unless that actor is wedged;
/// `connection()` runs it under the connection lock, and a stall must not hold
/// every socket behind it.
const NETWORK_CHANGE_TIMEOUT: Duration = Duration::from_millis(500);

/// A running tunnel plus what is needed to stop it.
struct RunningTunnel {
    port: u16,
    /// The dedicated journal port, when it could be bound. Never in `LIVE_PORTS`:
    /// it serves JSON only, never a page the app may navigate to.
    journal_port: Option<u16>,
    tunnel: Arc<Tunnel>,
    tasks: Vec<tokio::task::AbortHandle>,
}

impl RunningTunnel {
    #[cfg(test)]
    fn spawn(listener: TcpListener, port: u16, tunnel: Arc<Tunnel>) -> Self {
        Self::spawn_with_journal(listener, port, tunnel, None)
    }

    fn spawn_with_journal(listener: TcpListener, port: u16, tunnel: Arc<Tunnel>, journal_listener: Option<TcpListener>) -> Self {
        let watchdog = tokio::spawn(resume_watchdog(tunnel.clone())).abort_handle();
        let accept = tokio::spawn(accept_loop(listener, tunnel.clone())).abort_handle();
        let mut tasks = vec![watchdog, accept];
        let mut journal_port = None;
        if let Some(journal_listener) = journal_listener {
            journal_port = journal_listener.local_addr().ok().map(|a| a.port());
            tasks.push(tokio::spawn(journal_accept_loop(journal_listener, tunnel.clone(), port)).abort_handle());
        }
        if let Ok(mut ports) = LIVE_PORTS.write() {
            ports.insert(port);
        }
        Self { port, journal_port, tunnel, tasks }
    }

    /// Whether `port` is one of this tunnel's two loopback ports.
    fn holds_port(&self, port: u16) -> bool {
        self.port == port || self.journal_port == Some(port)
    }

    /// Aborting the accept task drops the listener, freeing the port; removing
    /// it from `LIVE_PORTS` makes the navigation guard refuse the old origin.
    async fn shutdown(self) {
        if let Ok(mut ports) = LIVE_PORTS.write() {
            ports.remove(&self.port);
        }
        for task in &self.tasks {
            task.abort();
        }
        self.tunnel.endpoint().close().await;
    }
}

/// One running tunnel per endpoint id, keyed by id so a call for a second PC
/// never gets the first PC's port back. Only the PC currently being connected
/// keeps a tunnel: switching PCs shuts the others down.
#[derive(Default)]
pub struct IrohTunnelState(Mutex<std::collections::HashMap<EndpointId, RunningTunnel>>);

#[tauri::command]
pub async fn start_iroh_tunnel(
    state: tauri::State<'_, IrohTunnelState>,
    endpoint_id: String,
    legacy: Option<bool>,
) -> Result<u16, String> {
    let remote_id: EndpointId = endpoint_id.parse().map_err(|e| {
        let msg = format!("bad endpoint id: {e}");
        error!("{}", msg);
        msg
    })?;
    let mut running = state.0.lock().await;
    if let Some(live) = running.get(&remote_id) {
        // Logged so a reopen can be told apart in logcat: this line means the
        // shell reloaded in a live process, "listener successfully bound"
        // means a fresh one.
        info!("start_iroh_tunnel: reusing live tunnel on port {}", live.port);
        return Ok(live.port);
    }
    // The old PC's tunnel stays up until the new one is bound, so a failed
    // switch leaves the phone on a working tunnel instead of none.
    let bind_started = Instant::now();
    let endpoint = bind_endpoint().await.map_err(|e| {
        let msg = format!("iroh bind failed: {e}");
        error!("{}", msg);
        msg
    })?;
    info!("iroh bound in {}ms", bind_started.elapsed().as_millis());
    journal::global().record(
        ms_of(SystemTime::now()),
        "bind",
        &format!("id={} ms={}", short_id(&endpoint.id()), bind_started.elapsed().as_millis()),
    );
    let candidates = port_candidates(&remote_id, legacy.unwrap_or(false));
    // A candidate held by an old tunnel is freed first, so the new PC still
    // lands on its own deterministic port and keeps that origin's token.
    if running.values().any(|old| candidates.iter().any(|c| old.holds_port(*c))) {
        shut_down_all(&mut running).await;
    }
    let (listener, port) = bind_loopback(&candidates).await?;
    shut_down_all(&mut running).await;

    info!("iroh tunnel listener successfully bound on 127.0.0.1:{}", port);
    // A bare EndpointAddr (id only, no direct addrs) makes the first connect() go
    // through the N0 preset's pkarr lookup, matching the desktop's ticket; later
    // dials add the relay the PC was last reached on (`Tunnel::dial_addr`).
    let tunnel = Arc::new(Tunnel::new(endpoint, remote_id.into(), Box::new(|| Box::pin(bind_endpoint()))));
    let journal_listener = bind_journal_listener(port, &tunnel).await;
    running.insert(remote_id, RunningTunnel::spawn_with_journal(listener, port, tunnel, journal_listener));
    Ok(port)
}

/// Dials the PC through the running tunnel for `endpoint_id` and returns the
/// milliseconds it took, so the shell can tell a reachable PC from a dead one
/// before it navigates the WebView (a failed page load has no retry).
#[tauri::command]
pub async fn probe_iroh_tunnel(state: tauri::State<'_, IrohTunnelState>, endpoint_id: String) -> Result<u64, String> {
    probe_in(&state, &endpoint_id).await
}

async fn probe_in(state: &IrohTunnelState, endpoint_id: &str) -> Result<u64, String> {
    let remote_id: EndpointId = endpoint_id.parse().map_err(|e| format!("bad endpoint id: {e}"))?;
    // Cloned out so the state lock is not held across the dial.
    let tunnel = state.0.lock().await.get(&remote_id).map(|running| running.tunnel.clone());
    let tunnel = tunnel.ok_or_else(|| "no tunnel for this PC".to_string())?;
    let started = Instant::now();
    tunnel.connection().await.map_err(|e| e.to_string())?;
    Ok(started.elapsed().as_millis() as u64)
}

async fn bind_endpoint() -> Result<Endpoint, String> {
    Endpoint::builder(presets::N0).alpns(vec![ALPN.to_vec()]).bind().await.map_err(|e| e.to_string())
}

async fn shut_down_all(running: &mut std::collections::HashMap<EndpointId, RunningTunnel>) {
    for (old_id, old) in running.drain() {
        info!("shutting down tunnel to {old_id} on port {}", old.port);
        old.shutdown().await;
    }
}

/// The shared QUIC connection to the PC, dialed lazily and redialed whenever
/// it closes or gets invalidated.
pub(crate) struct Tunnel {
    /// Swapped by `rebind`; read through `endpoint()` so no guard is held across an await.
    endpoint: std::sync::Mutex<Endpoint>,
    rebuild: Rebuild,
    remote: EndpointAddr,
    pub(crate) conn: Mutex<Slot>,
    /// Wall-clock seconds of the last gap check. Starts at "now" so a fresh
    /// tunnel's first dial is not mistaken for a wake-up.
    last_alive: AtomicU64,
    /// Injectable so tests can move the wall clock; `SystemTime::now` in production.
    pub(crate) clock: Clock,
    /// The relay the PC was last reached through. The phone dials a bare endpoint
    /// id, so a fresh endpoint would otherwise wait on n0's address lookup before
    /// it could start the handshake.
    relay_hint: std::sync::Mutex<Option<RelayUrl>>,
    /// The process-wide journal (`journal::global`); a field so a test can read a private one.
    pub(crate) journal: Arc<Journal>,
    /// Forwarded streams open right now; the received-traffic watch only judges a connection somebody is waiting on.
    pub(crate) open_streams: std::sync::atomic::AtomicUsize,
    /// Written by the watchdog tick alone; a std mutex held for one step, never across an await.
    quiet: std::sync::Mutex<QuietWatch>,
    /// How long a forwarded request may wait for its first answer byte before
    /// it is journaled as slow; a field so a test need not wait the real time.
    pub(crate) slow_stream_after: Duration,
}

pub(crate) type Clock = Arc<dyn Fn() -> SystemTime + Send + Sync>;

/// What the connection lock guards: the cached connection, the last failed
/// dial, and whether the next dial must start on a fresh endpoint. The failure
/// is kept so every caller that queued on the lock while that dial ran gets its
/// error at once instead of running a full dial of its own.
#[derive(Default)]
pub(crate) struct Slot {
    conn: Option<Connection>,
    failure: Option<(Instant, String)>,
    /// Set when a connection existed and is gone (wake-up, close, invalidation)
    /// or a call failed: the endpoint may hold dead relay state. Cleared on success.
    needs_fresh_endpoint: bool,
}

/// How one dial attempt ended.
enum Dialed {
    Connected(Connection),
    Failed(BoxError),
    TimedOut,
    /// The process was stopped for this many seconds while the attempt ran.
    Slept(u64),
}

/// Binds a replacement endpoint. A parameter, not a hard-coded `bind_endpoint`,
/// so tests rebind offline (`presets::Minimal`).
pub(crate) type Rebuild = Box<dyn Fn() -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Endpoint, String>> + Send>> + Send + Sync>;

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

pub(crate) fn ms_of(t: SystemTime) -> u64 {
    t.duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// The first 8 hex characters of an endpoint id: enough for a PC log line to be
/// matched to this phone, never the whole id.
fn short_id(id: &EndpointId) -> String {
    id.as_bytes()[..4].iter().map(|b| format!("{b:02x}")).collect()
}

/// `relay`, `direct` or `none` for the path QUIC sends on; never an address.
fn selected_path_kind(paths: &[(bool, TransportAddr)]) -> &'static str {
    match paths.iter().find(|(selected, _)| *selected) {
        Some((_, TransportAddr::Relay(_))) => "relay",
        Some((_, TransportAddr::Ip(_))) => "direct",
        _ => "none",
    }
}

/// The address to dial: the PC's own, plus the relay it was last reached on.
/// iroh still runs its address lookup next to an app-supplied address
/// (`remote_state.rs::handle_msg_resolve_remote` inserts it as `Source::App` and
/// then triggers the lookup), so a stale hint cannot strand the dial.
fn build_dial_addr(remote: &EndpointAddr, hint: Option<RelayUrl>) -> EndpointAddr {
    match hint {
        Some(url) => remote.clone().with_relay_url(url),
        None => remote.clone(),
    }
}

/// The relay among a connection's paths, if any.
fn relay_of(paths: &[(bool, TransportAddr)]) -> Option<RelayUrl> {
    paths.iter().find_map(|(_, addr)| match addr {
        TransportAddr::Relay(url) => Some(url.clone()),
        _ => None,
    })
}

/// The wall-clock distance between two consecutive ticks when it exceeds `STOP_GAP`.
/// A clock stepping backwards is not a stop.
fn stop_gap(prev: SystemTime, now: SystemTime) -> Option<Duration> {
    now.duration_since(prev).ok().filter(|gap| *gap > STOP_GAP)
}

/// Resolves with the stopped seconds once two consecutive wall-clock reads
/// `STOP_TICK` apart are more than `STOP_GAP` apart. Needs no lock, so a dial
/// that slept is noticed while the connection lock is still held by it.
async fn watch_for_stop(clock: Clock) -> u64 {
    let mut prev = clock();
    loop {
        tokio::time::sleep(STOP_TICK).await;
        let now = clock();
        if let Some(gap) = stop_gap(prev, now) {
            return gap.as_secs();
        }
        prev = now;
    }
}

/// `*` marks the path QUIC currently sends on. Takes owned data because a
/// live `Path` borrows its connection and cannot be built in a test.
fn path_summary(paths: &[(bool, TransportAddr)]) -> String {
    paths
        .iter()
        .map(|(selected, addr)| format!("{}{addr}", if *selected { "*" } else { "" }))
        .collect::<Vec<_>>()
        .join(",")
}

impl Tunnel {
    pub(crate) fn new(endpoint: Endpoint, remote: EndpointAddr, rebuild: Rebuild) -> Self {
        Self {
            endpoint: std::sync::Mutex::new(endpoint),
            rebuild,
            remote,
            conn: Mutex::new(Slot::default()),
            last_alive: AtomicU64::new(now_secs()),
            clock: Arc::new(SystemTime::now),
            relay_hint: std::sync::Mutex::new(None),
            journal: journal::global(),
            open_streams: std::sync::atomic::AtomicUsize::new(0),
            quiet: std::sync::Mutex::new(QuietWatch::default()),
            slow_stream_after: SLOW_STREAM,
        }
    }

    fn wall_secs(&self) -> u64 {
        (self.clock)().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
    }

    /// Journal entry stamped by the tunnel's own (injectable) wall clock.
    pub(crate) fn note(&self, kind: &str, detail: &str) {
        self.journal.record(ms_of((self.clock)()), kind, detail);
    }

    fn dial_addr(&self) -> EndpointAddr {
        let hint = self.relay_hint.lock().unwrap_or_else(|p| p.into_inner()).clone();
        build_dial_addr(&self.remote, hint)
    }

    fn endpoint(&self) -> Endpoint {
        self.endpoint.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }

    /// Replaces the endpoint with a freshly bound one. A stale endpoint keeps
    /// timing out against the PC after the relay path flaps (Pixel 7, 2026-10-30:
    /// four 15s timeouts, then a 14s dial, against 272ms on a fresh endpoint), and
    /// `network_change` alone did not cure it. The old one closes in the background
    /// so its shutdown never counts against the connection lock.
    /// Returns whether a fresh endpoint is now in place.
    async fn rebind(&self) -> bool {
        let started = Instant::now();
        match tokio::time::timeout(REBIND_TIMEOUT, (self.rebuild)()).await {
            Ok(Ok(fresh)) => {
                let old = std::mem::replace(&mut *self.endpoint.lock().unwrap_or_else(|p| p.into_inner()), fresh);
                tokio::spawn(async move { old.close().await });
                info!("rebound a fresh iroh endpoint in {}ms", started.elapsed().as_millis());
                self.note("rebind", &format!("ok id={} ms={}", short_id(&self.endpoint().id()), started.elapsed().as_millis()));
                true
            }
            Ok(Err(e)) => {
                warn!("rebind failed after {}ms: {e}", started.elapsed().as_millis());
                self.note("rebind", &format!("fail {e}"));
                false
            }
            Err(_) => {
                warn!("rebind timed out after {}s", REBIND_TIMEOUT.as_secs());
                self.note("rebind", &format!("fail timed out after {}s", REBIND_TIMEOUT.as_secs()));
                false
            }
        }
    }

    /// Returns the length of the gap when the process was frozen or the phone
    /// slept since the previous call, `None` otherwise. The swap makes exactly
    /// one caller see each gap; callers hold the connection lock around it so
    /// the gap and the cached connection are handled together.
    fn take_resume(&self) -> Option<u64> {
        let now = self.wall_secs();
        let prev = self.last_alive.swap(now, Ordering::SeqCst);
        is_resume_gap(UNIX_EPOCH + Duration::from_secs(prev), UNIX_EPOCH + Duration::from_secs(now))
            .then(|| now.saturating_sub(prev))
    }

    /// Closes and clears the cached connection. Takes the guard's contents, not
    /// `invalidate`: the connection mutex is not reentrant.
    fn drop_locked(&self, guard: &mut Option<Connection>, why: &str) {
        if let Some(conn) = guard.take() {
            info!("dropping tunnel connection: {why}");
            self.note("drop", why);
            conn.close(VarInt::from_u32(0), why.as_bytes());
        }
    }

    /// `Endpoint::network_change` bounded by `NETWORK_CHANGE_TIMEOUT`, so a stalled
    /// iroh actor cannot hold the connection lock for long.
    async fn network_change(&self) {
        if tokio::time::timeout(NETWORK_CHANGE_TIMEOUT, self.endpoint().network_change()).await.is_err() {
            warn!("network_change did not return within {}ms", NETWORK_CHANGE_TIMEOUT.as_millis());
        }
    }

    /// Whether iroh already holds state for the PC (a warm redial), as opposed
    /// to a cold lookup. Bounded: it waits on iroh's remote-state actor.
    async fn remote_known(&self) -> bool {
        tokio::time::timeout(REMOTE_INFO_TIMEOUT, self.endpoint().remote_info(self.remote.id))
            .await
            .ok()
            .flatten()
            .is_some()
    }

    /// The lock is held across the dial on purpose: a burst of WebView sockets
    /// on resume waits for one connect instead of racing several. `last_alive` is
    /// stamped on every exit, so whatever time the call took (or slept through)
    /// is never seen by the next caller as a gap.
    async fn connection(&self) -> Result<Connection, BoxError> {
        let waiting_since = Instant::now();
        let mut slot = self.conn.lock().await;
        let result = self.connection_locked(&mut slot, waiting_since).await;
        self.last_alive.store(self.wall_secs(), Ordering::SeqCst);
        result
    }

    async fn connection_locked(&self, slot: &mut Slot, waiting_since: Instant) -> Result<Connection, BoxError> {
        // A dial that failed while this caller was queued already answered for
        // it: dialing again would only repeat the same wait and bind yet another
        // endpoint.
        if let Some((failed_at, msg)) = &slot.failure {
            if *failed_at >= waiting_since {
                return Err(msg.clone().into());
            }
        }
        // A cached connection that sat through a freeze can look open while
        // every byte on it disappears, so a gap is checked before it is
        // handed out, not left to the watchdog's next tick.
        let resumed = self.take_resume();
        if let Some(secs) = resumed {
            self.note("resume", &format!("secs={secs} by=connection"));
            self.drop_locked(&mut slot.conn, &format!("resumed after {secs}s asleep (seen by connection())"));
            slot.needs_fresh_endpoint = true;
        } else if let Some(conn) = slot.conn.as_ref() {
            match conn.close_reason() {
                None => return Ok(conn.clone()),
                Some(reason) => {
                    info!("tunnel connection closed ({reason}), redialing");
                    self.note("closed", &reason.to_string());
                    slot.needs_fresh_endpoint = true;
                }
            }
        }
        // Measured on a Pixel 7 (2026-10-30): redials on the same iroh state timed
        // out four times in a row (15s each) and the first success took 14s, while
        // a fresh endpoint dialed in 272ms. So a lost connection is redialed on a
        // fresh endpoint first; the old one is only the fallback, where
        // `network_change` is the best that can be done for it (iroh cannot see
        // network changes on Android).
        let mut rebound = false;
        if slot.needs_fresh_endpoint {
            rebound = true;
            if !self.rebind().await {
                self.network_change().await;
            }
        }
        let warm = self.remote_known().await;
        let started = Instant::now();
        let hint = self.relay_hint.lock().unwrap_or_else(|p| p.into_inner()).is_some();
        let mut dialed = None;
        let mut last_err: BoxError = "no dial attempted".into();
        let mut sleeps = 0;
        let mut attempt = 1;
        while attempt <= DIAL_ATTEMPTS {
            let timeout = if attempt == 1 { ATTEMPT_TIMEOUT } else { RETRY_ATTEMPT_TIMEOUT };
            match self.dial_attempt(timeout).await {
                Dialed::Connected(conn) => {
                    dialed = Some(conn);
                    break;
                }
                Dialed::Slept(secs) if sleeps < MAX_SLEEP_RESTARTS => {
                    info!("dial slept {secs}s, restarting on a fresh endpoint");
                    self.note("slept", &format!("secs={secs}"));
                    // This stop is the wake-up; nobody else reports it again.
                    self.last_alive.store(self.wall_secs(), Ordering::SeqCst);
                    sleeps += 1;
                    rebound = true;
                    if !self.rebind().await {
                        self.network_change().await;
                    }
                    continue;
                }
                Dialed::Slept(secs) => {
                    warn!("tunnel connect {attempt}/{DIAL_ATTEMPTS} slept {secs}s again, giving up on it");
                    self.note("slept", &format!("secs={secs}"));
                    self.note("dial_fail", &format!("attempt={attempt} slept"));
                    last_err = "tunnel connect slept".into();
                }
                Dialed::Failed(e) => {
                    warn!("tunnel connect {attempt}/{DIAL_ATTEMPTS} failed after {}ms warm={warm}: {e}", started.elapsed().as_millis());
                    self.note("dial_fail", &format!("attempt={attempt} {e}"));
                    last_err = e;
                }
                Dialed::TimedOut => {
                    warn!("tunnel connect {attempt}/{DIAL_ATTEMPTS} timed out after {}s warm={warm}", timeout.as_secs());
                    self.note("dial_fail", &format!("attempt={attempt} timed out"));
                    last_err = "tunnel connect timed out".into();
                }
            }
            // One rebind per call: the retry stays on the endpoint the first
            // attempt warmed up (relay connection, address lookup under way).
            if attempt < DIAL_ATTEMPTS && !rebound {
                rebound = true;
                self.rebind().await;
            }
            attempt += 1;
        }
        let Some(conn) = dialed else {
            slot.conn = None;
            slot.needs_fresh_endpoint = true;
            // Stamped after the last await so every caller queued during this
            // dial counts as having waited through it.
            slot.failure = Some((Instant::now(), last_err.to_string()));
            return Err(last_err);
        };
        let paths: Vec<(bool, TransportAddr)> =
            conn.paths().iter().map(|p| (p.is_selected(), p.remote_addr().clone())).collect();
        if let Some(url) = relay_of(&paths) {
            *self.relay_hint.lock().unwrap_or_else(|p| p.into_inner()) = Some(url);
        }
        info!(
            "tunnel connected in {}ms warm={warm} hint={hint} paths=[{}] resumed={}",
            started.elapsed().as_millis(),
            path_summary(&paths),
            resumed.is_some()
        );
        self.note(
            "dial_ok",
            &format!(
                "ms={} attempt={attempt} warm={warm} hint={hint} resumed={} path={}",
                started.elapsed().as_millis(),
                resumed.is_some(),
                selected_path_kind(&paths)
            ),
        );
        slot.conn = Some(conn.clone());
        slot.failure = None;
        slot.needs_fresh_endpoint = false;
        Ok(conn)
    }

    /// One dial on the current endpoint, abandoned at once if the process stops
    /// meanwhile: the monotonic clock behind the timeout does not run while the
    /// phone sleeps, so without the wall-clock watch a stale attempt would
    /// outlive the whole sleep.
    async fn dial_attempt(&self, timeout: Duration) -> Dialed {
        let endpoint = self.endpoint();
        let addr = self.dial_addr();
        tokio::select! {
            dialed = tokio::time::timeout(timeout, endpoint.connect(addr, ALPN)) => match dialed {
                Ok(Ok(conn)) => Dialed::Connected(conn),
                Ok(Err(e)) => Dialed::Failed(e.into()),
                Err(_) => Dialed::TimedOut,
            },
            secs = watch_for_stop(self.clock.clone()) => Dialed::Slept(secs),
        }
    }

    /// Drops the shared connection so the next stream redials, but only when it
    /// is still the one that failed (`failed`, a `stable_id`): another task may
    /// have redialed already, and closing that fresh connection would kill every
    /// stream on it. Also tells iroh the network may have changed: on Android it
    /// cannot detect that by itself (see `Endpoint::network_change`'s docs), so a
    /// Wi-Fi/LTE switch during sleep would otherwise keep it on stale sockets and
    /// relay state.
    async fn invalidate(&self, failed: usize, why: &str) {
        {
            let mut slot = self.conn.lock().await;
            if slot.conn.as_ref().map(Connection::stable_id) != Some(failed) {
                return;
            }
            self.drop_locked(&mut slot.conn, why);
            slot.needs_fresh_endpoint = true;
        }
        self.network_change().await;
    }

    /// Notes a watchdog tick that arrived much later than its period on the wall
    /// clock: the one line that tells a frozen or suspended process from an awake
    /// one. Needs no lock, and `prev` moves to the new tick either way.
    fn check_tick_late(&self, prev: &mut SystemTime) {
        let now = (self.clock)();
        if let Ok(gap) = now.duration_since(*prev) {
            if gap > WATCHDOG_TICK + TICK_LATE_SLACK {
                self.note("tick_late", &format!("late_ms={}", (gap - WATCHDOG_TICK).as_millis()));
            }
        }
        *prev = now;
    }

    /// One watchdog tick. The lock is taken BEFORE the gap is consumed: if the
    /// gap were consumed first, a `connection()` call racing in would see no
    /// gap and hand out the dead connection, or the late drop would close a
    /// connection dialed after the gap.
    async fn watchdog_tick(&self) {
        self.watchdog_tick_with(&read_traffic).await;
    }

    /// `read` returns a connection's counters (all paths, relay included:
    /// `ConnectionStats` sums every path), a parameter so a test can control it.
    async fn watchdog_tick_with(&self, read: &(dyn Fn(&Connection) -> Traffic + Sync)) {
        let mut guard = self.conn.lock().await;
        if let Some(secs) = self.take_resume() {
            self.note("resume", &format!("secs={secs} by=watchdog"));
            self.drop_locked(&mut guard.conn, &format!("resumed after {secs}s asleep"));
            guard.needs_fresh_endpoint = true;
            drop(guard);
            *self.quiet.lock().unwrap_or_else(|p| p.into_inner()) = QuietWatch::default();
            self.network_change().await;
            return;
        }
        // Only a cached, open connection is judged. The lock is released before
        // the counter is read, so nothing here waits on iroh while holding it.
        let conn = guard.conn.as_ref().filter(|c| c.close_reason().is_none()).cloned();
        drop(guard);
        let Some(conn) = conn else {
            *self.quiet.lock().unwrap_or_else(|p| p.into_inner()) = QuietWatch::default();
            return;
        };
        let traffic = read(&conn);
        let streams = self.open_streams.load(Ordering::SeqCst);
        let verdicts = self.quiet.lock().unwrap_or_else(|p| p.into_inner()).step(conn.stable_id(), traffic, streams);
        // `Drop` from either watch wins; a nudge is the same call to iroh whichever
        // watch asked, journaled under the watch's own name.
        if verdicts.downlink == QuietVerdict::Drop {
            self.drop_dead(&conn, "dead", &format!("secs={}", QUIET_DEAD.as_secs()), &format!("no packets for {}s", QUIET_DEAD.as_secs())).await;
        } else if verdicts.uplink == QuietVerdict::Drop {
            let detail = self.uplink_detail(&conn, UPLINK_DEAD, traffic);
            self.drop_dead(&conn, "uplink_dead", &detail, &format!("nothing acknowledged for {}s", UPLINK_DEAD.as_secs())).await;
        } else if verdicts.downlink == QuietVerdict::Nudge {
            self.note("quiet", &format!("secs={}", QUIET_NUDGE.as_secs()));
            self.network_change().await;
        } else if verdicts.uplink == QuietVerdict::Nudge {
            self.note("unacked", &self.uplink_detail(&conn, UPLINK_NUDGE, traffic));
            self.network_change().await;
        }
    }

    /// The journal detail of an uplink verdict. `paths` names every path of the
    /// connection with `*` on the one QUIC sends on: a direct address there,
    /// beside a relay, is the path that swallowed the requests.
    fn uplink_detail(&self, conn: &Connection, after: Duration, traffic: Traffic) -> String {
        let paths: Vec<(bool, TransportAddr)> =
            conn.paths().iter().map(|p| (p.is_selected(), p.remote_addr().clone())).collect();
        format!(
            "secs={} sent={} acked={} rx={} paths=[{}]",
            after.as_secs(),
            traffic.sent,
            traffic.acked,
            traffic.rx,
            path_summary(&paths)
        )
    }

    /// Drops `conn` as dead and arms a fresh-endpoint redial. Re-checked under
    /// the lock: a request may have redialed since the counters were read, and
    /// that fresh connection must stay.
    async fn drop_dead(&self, conn: &Connection, kind: &str, detail: &str, why: &str) {
        let mut guard = self.conn.lock().await;
        if guard.conn.as_ref().map(Connection::stable_id) == Some(conn.stable_id()) {
            self.note(kind, detail);
            self.drop_locked(&mut guard.conn, why);
            guard.needs_fresh_endpoint = true;
        }
        drop(guard);
        *self.quiet.lock().unwrap_or_else(|p| p.into_inner()) = QuietWatch::default();
    }

    /// Journals one request that has gone unanswered for `slow_stream_after`:
    /// the connection's counters (datagrams received, ack-eliciting frames sent,
    /// ACKs received) and the packets QUIC counts lost. Datagrams moving with ACKs flat
    /// is an uplink that swallows requests; everything moving means the PC got
    /// them and has not answered. Never waits for the connection lock: a dial in
    /// progress is itself the reason, and is said so.
    pub(crate) async fn note_slow_stream(&self) {
        let open = self.open_streams.load(Ordering::SeqCst);
        let conn = match self.conn.try_lock() {
            Ok(slot) => slot.conn.clone(),
            Err(_) => {
                self.note("stream_slow", &format!("after={}s open={open} dialing", self.slow_stream_after.as_secs()));
                return;
            }
        };
        let detail = match conn {
            Some(conn) if conn.close_reason().is_none() => {
                let t = read_traffic(&conn);
                let lost = conn.stats().lost_packets;
                format!(
                    "after={}s open={open} rx={} sent={} acked={} lost={lost}",
                    self.slow_stream_after.as_secs(),
                    t.rx,
                    t.sent,
                    t.acked
                )
            }
            _ => format!("after={}s open={open} no_connection", self.slow_stream_after.as_secs()),
        };
        self.note("stream_slow", &detail);
    }

    pub(crate) async fn open_stream(&self) -> Result<(SendStream, RecvStream), BoxError> {
        let mut last_err: BoxError = "no attempt made".into();
        for _ in 0..2 {
            let conn = self.connection().await?;
            match tokio::time::timeout(OPEN_STREAM_TIMEOUT, conn.open_bi()).await {
                Ok(Ok(streams)) => return Ok(streams),
                // A connection-level error: this connection is gone for every
                // stream, so redial once.
                Ok(Err(e)) => {
                    warn!("open_bi failed: {e}");
                    self.note("stream_fail", &format!("open_bi {e}"));
                    last_err = e.into();
                    self.invalidate(conn.stable_id(), "could not open a stream").await;
                }
                Err(_) => {
                    warn!("open_bi timed out: stream limit reached");
                    self.note("stream_fail", "open_bi timed out");
                    return Err("open_bi timed out".into());
                }
            }
        }
        Err(last_err)
    }
}

fn is_resume_gap(prev: SystemTime, now: SystemTime) -> bool {
    now.duration_since(prev).is_ok_and(|gap| gap > RESUME_GAP)
}

/// A connection that sat through a freeze or sleep may look open while every
/// byte sent on it disappears until the idle timeout. Dropping it on resume
/// makes the WebView's first requests redial instead of hanging.
async fn resume_watchdog(tunnel: Arc<Tunnel>) {
    let mut prev = (tunnel.clock)();
    loop {
        tokio::time::sleep(WATCHDOG_TICK).await;
        tunnel.check_tick_late(&mut prev);
        tunnel.watchdog_tick().await;
    }
}

#[cfg(test)]
mod tests;
