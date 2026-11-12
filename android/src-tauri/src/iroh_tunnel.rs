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
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Mutex;

type BoxError = Box<dyn std::error::Error + Send + Sync>;

/// Must match `src-tauri/src/daemon/iroh_tunnel.rs::ALPN` exactly.
const ALPN: &[u8] = b"conductor/remote/0";

/// Each paired PC gets its own loopback origin, so a different endpoint (a
/// stranger's QR) never serves a page at the origin holding another PC's
/// `rc_token`. The port is a function of the endpoint id, never ephemeral:
/// the token lives in that origin's localStorage, so a rotating port would
/// force a re-pair every launch.
const DERIVED_PORT_BASE: u16 = 27200;
const DERIVED_PORT_SPAN: u16 = 1000;
/// Bind attempts before giving up; each one the next port in the range.
const PORT_PROBES: u16 = 8;

/// The single fixed port every PC used before per-endpoint ports. The shell
/// asks for it (`legacy`) only for the PC paired back then, so that PC's
/// `rc_token` survives the upgrade without a re-pair.
pub const LEGACY_LOOPBACK_PORT: u16 = 27184;

/// The first port tried for `id`. Only two bytes feed it, but hashing every
/// byte would move each already-paired PC to a new origin and drop its
/// rc_token (a forced re-pair), while the 1000-port span leaves collision
/// grinding cheap either way.
pub fn derived_port(id: &EndpointId) -> u16 {
    let b = id.as_bytes();
    DERIVED_PORT_BASE + u16::from_le_bytes([b[0], b[1]]) % DERIVED_PORT_SPAN
}

/// Ports to try, in order: a collision moves to the next port in the range,
/// so a given id lands on the same port whenever the same ports are free.
fn port_candidates(id: &EndpointId, legacy: bool) -> Vec<u16> {
    // The legacy PC's rc_token lives only in the 27184 origin, so a failed
    // bind there must surface as an error: a derived port would silently
    // present a fresh origin with no token.
    if legacy {
        return vec![LEGACY_LOOPBACK_PORT];
    }
    let first = derived_port(id) - DERIVED_PORT_BASE;
    (0..PORT_PROBES).map(|i| DERIVED_PORT_BASE + (first + i) % DERIVED_PORT_SPAN).collect()
}

/// Loopback ports with a live tunnel behind them, read by the shell's
/// navigation guard: no other loopback port is a page the app may load.
static LIVE_PORTS: std::sync::LazyLock<std::sync::RwLock<std::collections::HashSet<u16>>> =
    std::sync::LazyLock::new(Default::default);

pub fn is_tunnel_port(port: u16) -> bool {
    LIVE_PORTS.read().is_ok_and(|ports| ports.contains(&port))
}

#[cfg(test)]
pub fn mark_live_for_test(port: u16) {
    LIVE_PORTS.write().expect("live ports").insert(port);
}

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

/// Most bytes `forward` buffers from a socket while it waits for a stream.
const EARLY_BUFFER_CAP: usize = 256 * 1024;

const WATCHDOG_TICK: Duration = Duration::from_secs(2);

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
    tunnel: Arc<Tunnel>,
    tasks: [tokio::task::AbortHandle; 2],
}

impl RunningTunnel {
    fn spawn(listener: TcpListener, port: u16, tunnel: Arc<Tunnel>) -> Self {
        let watchdog = tokio::spawn(resume_watchdog(tunnel.clone())).abort_handle();
        let accept = tokio::spawn(accept_loop(listener, tunnel.clone())).abort_handle();
        if let Ok(mut ports) = LIVE_PORTS.write() {
            ports.insert(port);
        }
        Self { port, tunnel, tasks: [watchdog, accept] }
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
    let candidates = port_candidates(&remote_id, legacy.unwrap_or(false));
    // A candidate held by an old tunnel is freed first, so the new PC still
    // lands on its own deterministic port and keeps that origin's token.
    if running.values().any(|old| candidates.contains(&old.port)) {
        shut_down_all(&mut running).await;
    }
    let (listener, port) = bind_loopback(&candidates).await?;
    shut_down_all(&mut running).await;

    info!("iroh tunnel listener successfully bound on 127.0.0.1:{}", port);
    // A bare EndpointAddr (id only, no direct addrs) makes the first connect() go
    // through the N0 preset's pkarr lookup, matching the desktop's ticket; later
    // dials add the relay the PC was last reached on (`Tunnel::dial_addr`).
    let tunnel = Arc::new(Tunnel::new(endpoint, remote_id.into(), Box::new(|| Box::pin(bind_endpoint()))));
    running.insert(remote_id, RunningTunnel::spawn(listener, port, tunnel));
    Ok(port)
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

/// Binds the first free port of `candidates`.
async fn bind_loopback(candidates: &[u16]) -> Result<(TcpListener, u16), String> {
    let mut last = String::from("no candidate ports");
    for &port in candidates {
        match TcpListener::bind(("127.0.0.1", port)).await {
            Ok(l) => return Ok((l, port)),
            Err(e) => {
                warn!("loopback bind failed at port {port}: {e}");
                last = format!("loopback bind failed at port {port}: {e}");
            }
        }
    }
    error!("{}", last);
    Err(last)
}

/// The shared QUIC connection to the PC, dialed lazily and redialed whenever
/// it closes or gets invalidated.
struct Tunnel {
    /// Swapped by `rebind`; read through `endpoint()` so no guard is held across an await.
    endpoint: std::sync::Mutex<Endpoint>,
    rebuild: Rebuild,
    remote: EndpointAddr,
    conn: Mutex<Slot>,
    /// Wall-clock seconds of the last gap check. Starts at "now" so a fresh
    /// tunnel's first dial is not mistaken for a wake-up.
    last_alive: AtomicU64,
    /// Injectable so tests can move the wall clock; `SystemTime::now` in production.
    clock: Clock,
    /// The relay the PC was last reached through. The phone dials a bare endpoint
    /// id, so a fresh endpoint would otherwise wait on n0's address lookup before
    /// it could start the handshake.
    relay_hint: std::sync::Mutex<Option<RelayUrl>>,
}

type Clock = Arc<dyn Fn() -> SystemTime + Send + Sync>;

/// What the connection lock guards: the cached connection, the last failed
/// dial, and whether the next dial must start on a fresh endpoint. The failure
/// is kept so every caller that queued on the lock while that dial ran gets its
/// error at once instead of running a full dial of its own.
#[derive(Default)]
struct Slot {
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
type Rebuild = Box<dyn Fn() -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Endpoint, String>> + Send>> + Send + Sync>;

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
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
    fn new(endpoint: Endpoint, remote: EndpointAddr, rebuild: Rebuild) -> Self {
        Self {
            endpoint: std::sync::Mutex::new(endpoint),
            rebuild,
            remote,
            conn: Mutex::new(Slot::default()),
            last_alive: AtomicU64::new(now_secs()),
            clock: Arc::new(SystemTime::now),
            relay_hint: std::sync::Mutex::new(None),
        }
    }

    fn wall_secs(&self) -> u64 {
        (self.clock)().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
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
                true
            }
            Ok(Err(e)) => {
                warn!("rebind failed after {}ms: {e}", started.elapsed().as_millis());
                false
            }
            Err(_) => {
                warn!("rebind timed out after {}s", REBIND_TIMEOUT.as_secs());
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
    fn drop_locked(guard: &mut Option<Connection>, why: &str) {
        if let Some(conn) = guard.take() {
            info!("dropping tunnel connection: {why}");
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
            Self::drop_locked(&mut slot.conn, &format!("resumed after {secs}s asleep (seen by connection())"));
            slot.needs_fresh_endpoint = true;
        } else if let Some(conn) = slot.conn.as_ref() {
            match conn.close_reason() {
                None => return Ok(conn.clone()),
                Some(reason) => {
                    info!("tunnel connection closed ({reason}), redialing");
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
                    last_err = "tunnel connect slept".into();
                }
                Dialed::Failed(e) => {
                    warn!("tunnel connect {attempt}/{DIAL_ATTEMPTS} failed after {}ms warm={warm}: {e}", started.elapsed().as_millis());
                    last_err = e;
                }
                Dialed::TimedOut => {
                    warn!("tunnel connect {attempt}/{DIAL_ATTEMPTS} timed out after {}s warm={warm}", timeout.as_secs());
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
            Self::drop_locked(&mut slot.conn, why);
            slot.needs_fresh_endpoint = true;
        }
        self.network_change().await;
    }

    /// One watchdog tick. The lock is taken BEFORE the gap is consumed: if the
    /// gap were consumed first, a `connection()` call racing in would see no
    /// gap and hand out the dead connection, or the late drop would close a
    /// connection dialed after the gap.
    async fn watchdog_tick(&self) {
        let mut guard = self.conn.lock().await;
        if let Some(secs) = self.take_resume() {
            Self::drop_locked(&mut guard.conn, &format!("resumed after {secs}s asleep"));
            guard.needs_fresh_endpoint = true;
            drop(guard);
            self.network_change().await;
        }
    }

    async fn open_stream(&self) -> Result<(SendStream, RecvStream), BoxError> {
        let mut last_err: BoxError = "no attempt made".into();
        for _ in 0..2 {
            let conn = self.connection().await?;
            match tokio::time::timeout(OPEN_STREAM_TIMEOUT, conn.open_bi()).await {
                Ok(Ok(streams)) => return Ok(streams),
                // A connection-level error: this connection is gone for every
                // stream, so redial once.
                Ok(Err(e)) => {
                    warn!("open_bi failed: {e}");
                    last_err = e.into();
                    self.invalidate(conn.stable_id(), "could not open a stream").await;
                }
                Err(_) => {
                    warn!("open_bi timed out: stream limit reached");
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
    loop {
        tokio::time::sleep(WATCHDOG_TICK).await;
        tunnel.watchdog_tick().await;
    }
}

async fn accept_loop(listener: TcpListener, tunnel: Arc<Tunnel>) {
    loop {
        match listener.accept().await {
            Ok((tcp, _)) => {
                let tunnel = tunnel.clone();
                tokio::spawn(async move {
                    if let Err(e) = forward(tcp, &tunnel).await {
                        error!("tunnel forward error: {}", e);
                    }
                });
            }
            Err(e) => {
                error!("tunnel listener accept failed: {}", e);
                // Don't continue in a tight loop if accept keeps failing
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        }
    }
}

/// Splice one accepted TCP connection onto a bi-stream of the shared connection.
/// While the stream is being opened (possibly behind a long dial) the socket is
/// watched: a peer that already closed it, such as a request the page aborted,
/// must not stay parked until the dial ends. Bytes it sent meanwhile are kept
/// and written first.
async fn forward(tcp: TcpStream, tunnel: &Tunnel) -> Result<(), BoxError> {
    use tokio::io::AsyncReadExt;
    let (mut tcp_read, mut tcp_write) = tokio::io::split(tcp);
    let mut early: Vec<u8> = Vec::new();
    let (mut send, mut recv) = {
        let open = tunnel.open_stream();
        tokio::pin!(open);
        let mut chunk = [0u8; 8192];
        loop {
            // Past the cap reading stops (TCP backpressure holds the rest)
            // and only the stream result is awaited.
            let can_read = early.len() < EARLY_BUFFER_CAP;
            tokio::select! {
                opened = &mut open => break opened?,
                read = tcp_read.read(&mut chunk), if can_read => match read {
                    Ok(0) | Err(_) => return Ok(()),
                    Ok(n) => early.extend_from_slice(&chunk[..n]),
                },
            }
        }
    };
    if !early.is_empty() {
        send.write_all(&early).await?;
    }
    let up = async {
        tokio::io::copy(&mut tcp_read, &mut send).await?;
        tokio::io::AsyncWriteExt::shutdown(&mut send).await
    };
    let down = async {
        tokio::io::copy(&mut recv, &mut tcp_write).await?;
        tokio::io::AsyncWriteExt::shutdown(&mut tcp_write).await
    };
    tokio::try_join!(up, down)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// Pins the wire byte value, since src-tauri has its own copy of this
    /// constant in a separate cargo workspace with no shared crate.
    #[test]
    fn alpn_matches_desktop_copy() {
        assert_eq!(ALPN, b"conductor/remote/0");
    }

    fn id(seed: u8) -> EndpointId {
        iroh::SecretKey::from_bytes(&[seed; 32]).public()
    }

    #[test]
    fn each_endpoint_id_gets_its_own_stable_port_in_range() {
        let (a, b) = (id(1), id(2));
        assert_eq!(derived_port(&a), derived_port(&a), "same id, same port across launches");
        assert_ne!(derived_port(&a), derived_port(&b), "these two ids must not share an origin");
        for p in [derived_port(&a), derived_port(&b)] {
            assert!((DERIVED_PORT_BASE..DERIVED_PORT_BASE + DERIVED_PORT_SPAN).contains(&p));
            assert_ne!(p, LEGACY_LOOPBACK_PORT);
        }
    }

    #[tokio::test]
    async fn shutdown_frees_the_port_and_revokes_navigation() {
        let (server, _) = pong_server().await;
        let client = Endpoint::builder(presets::Minimal).bind().await.expect("client bind");
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let running = RunningTunnel::spawn(listener, port, Arc::new(Tunnel::new(client, server, minimal_rebuild())));
        assert!(is_tunnel_port(port));
        running.shutdown().await;
        assert!(!is_tunnel_port(port));
        let mut rebound = false;
        for _ in 0..50 {
            if TcpListener::bind(("127.0.0.1", port)).await.is_ok() {
                rebound = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(rebound, "old listener still holds the port");
    }

    #[test]
    fn collisions_probe_forward_deterministically_and_legacy_binds_only_the_old_port() {
        let a = id(3);
        let c = port_candidates(&a, false);
        assert_eq!(c.len(), PORT_PROBES as usize);
        assert_eq!(c[0], derived_port(&a));
        assert_eq!(c, port_candidates(&a, false));
        // No derived fallback: it would be a fresh origin without the token.
        assert_eq!(port_candidates(&a, true), vec![LEGACY_LOOPBACK_PORT]);
    }

    #[tokio::test]
    async fn a_taken_port_falls_through_to_the_next_candidate() {
        let held = TcpListener::bind(("127.0.0.1", 0)).await.expect("bind");
        let taken = held.local_addr().expect("addr").port();
        let free = TcpListener::bind(("127.0.0.1", 0)).await.expect("bind");
        let next = free.local_addr().expect("addr").port();
        drop(free);
        let (_l, port) = bind_loopback(&[taken, next]).await.expect("falls through");
        assert_eq!(port, next);
    }

    #[test]
    fn only_a_long_wall_clock_gap_counts_as_a_resume() {
        let t0 = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000);
        assert!(!is_resume_gap(t0, t0 + WATCHDOG_TICK));
        assert!(!is_resume_gap(t0, t0 + RESUME_GAP));
        assert!(is_resume_gap(t0, t0 + RESUME_GAP + Duration::from_secs(1)));
        // A wall clock stepped backwards is not a resume.
        assert!(!is_resume_gap(t0, t0 - Duration::from_secs(60)));
    }

    /// Echo-style PING/PONG peer that counts accepted QUIC connections.
    /// `Minimal` + a full `EndpointAddr` means no relay and no address lookup,
    /// so this runs offline.
    async fn pong_server() -> (EndpointAddr, Arc<AtomicUsize>) {
        let server = Endpoint::builder(presets::Minimal)
            .alpns(vec![ALPN.to_vec()])
            .bind()
            .await
            .expect("server bind");
        let addr = server.addr();
        let accepted = Arc::new(AtomicUsize::new(0));
        let counter = accepted.clone();
        tokio::spawn(async move {
            while let Some(incoming) = server.accept().await {
                // A dial the client abandoned (its endpoint closed mid-handshake)
                // must not end the accept loop for the dials that follow.
                let Ok(conn) = incoming.await else { continue };
                counter.fetch_add(1, Ordering::SeqCst);
                // Keeps `conn` alive past the reply write, unlike a one-shot
                // task - dropping it early resets the stream before PONG lands.
                tokio::spawn(async move {
                    while let Ok((mut send, mut recv)) = conn.accept_bi().await {
                        tokio::spawn(async move {
                            let mut got = vec![0u8; 4];
                            recv.read_exact(&mut got).await.expect("read");
                            assert_eq!(&got, b"PING");
                            send.write_all(b"PONG").await.expect("write");
                            send.finish().expect("finish");
                        });
                    }
                });
            }
        });
        (addr, accepted)
    }

    async fn tunnel_to(server: EndpointAddr) -> (Arc<Tunnel>, u16) {
        let client = Endpoint::builder(presets::Minimal).bind().await.expect("client bind");
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let tunnel = Arc::new(Tunnel::new(client, server, minimal_rebuild()));
        tokio::spawn(accept_loop(listener, tunnel.clone()));
        (tunnel, port)
    }

    fn minimal_rebuild() -> Rebuild {
        Box::new(|| Box::pin(async { Endpoint::builder(presets::Minimal).bind().await.map_err(|e| e.to_string()) }))
    }

    /// A dead endpoint fails the first dial at once. The retry must run on a
    /// freshly bound one, or a flapped relay path keeps timing out until the
    /// tunnel is rebuilt by hand.
    #[tokio::test]
    async fn a_failed_dial_is_retried_on_a_freshly_bound_endpoint() {
        let (server, accepted) = pong_server().await;
        let dead = Endpoint::builder(presets::Minimal).bind().await.expect("client bind");
        dead.close().await;
        let rebinds = Arc::new(AtomicUsize::new(0));
        let counter = rebinds.clone();
        let rebuild: Rebuild = Box::new(move || {
            counter.fetch_add(1, Ordering::SeqCst);
            Box::pin(async { Endpoint::builder(presets::Minimal).bind().await.map_err(|e| e.to_string()) })
        });
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let tunnel = Arc::new(Tunnel::new(dead, server, rebuild));
        tokio::spawn(accept_loop(listener, tunnel.clone()));
        ping(port).await;
        assert_eq!(rebinds.load(Ordering::SeqCst), 1, "one rebind for the one failed dial");
        assert_eq!(accepted.load(Ordering::SeqCst), 1);
    }

    /// With every attempt failing, the caller gets an error rather than a hang,
    /// and the call binds exactly one replacement endpoint: the retry stays on it
    /// instead of throwing away a relay connection that is already warming up.
    #[tokio::test]
    async fn every_dial_failing_surfaces_an_error_after_exactly_one_rebind() {
        let (server, _) = pong_server().await;
        let dead = Endpoint::builder(presets::Minimal).bind().await.expect("client bind");
        dead.close().await;
        let rebinds = Arc::new(AtomicUsize::new(0));
        let counter = rebinds.clone();
        // The replacement is closed too, so attempt 2 fails as well.
        let rebuild: Rebuild = Box::new(move || {
            counter.fetch_add(1, Ordering::SeqCst);
            Box::pin(async {
                let e = Endpoint::builder(presets::Minimal).bind().await.map_err(|e| e.to_string())?;
                e.close().await;
                Ok(e)
            })
        });
        let tunnel = Tunnel::new(dead, server, rebuild);
        assert!(tunnel.connection().await.is_err());
        assert_eq!(rebinds.load(Ordering::SeqCst), 1);
    }

    /// A tunnel whose every dial fails, counting rebinds.
    fn dead_tunnel(server: EndpointAddr, dead: Endpoint, rebinds: Arc<AtomicUsize>) -> Arc<Tunnel> {
        let rebuild: Rebuild = Box::new(move || {
            rebinds.fetch_add(1, Ordering::SeqCst);
            Box::pin(async {
                let e = Endpoint::builder(presets::Minimal).bind().await.map_err(|e| e.to_string())?;
                e.close().await;
                Ok(e)
            })
        });
        Arc::new(Tunnel::new(dead, server, rebuild))
    }

    /// Sockets queued behind a failed dial share its failure: one dial-and-rebind
    /// cycle in total, not one per queued socket.
    #[tokio::test]
    async fn callers_queued_behind_a_failed_dial_share_its_failure() {
        let (server, _) = pong_server().await;
        let dead = Endpoint::builder(presets::Minimal).bind().await.expect("client bind");
        dead.close().await;
        let rebinds = Arc::new(AtomicUsize::new(0));
        let tunnel = dead_tunnel(server, dead, rebinds.clone());
        let (a, b, c, d, e) = tokio::join!(
            tunnel.connection(),
            tunnel.connection(),
            tunnel.connection(),
            tunnel.connection(),
            tunnel.connection()
        );
        for r in [a, b, c, d, e] {
            assert!(r.is_err());
        }
        assert_eq!(rebinds.load(Ordering::SeqCst), 1, "one cycle for all five callers");
    }

    /// A caller arriving after the failure finished is not served the stale error;
    /// its dial starts on a fresh endpoint, because the failed call left the old
    /// one suspect.
    #[tokio::test]
    async fn a_caller_arriving_after_a_failure_dials_again() {
        let (server, _) = pong_server().await;
        let dead = Endpoint::builder(presets::Minimal).bind().await.expect("client bind");
        dead.close().await;
        let rebinds = Arc::new(AtomicUsize::new(0));
        let tunnel = dead_tunnel(server, dead, rebinds.clone());
        assert!(tunnel.connection().await.is_err());
        let after_first = rebinds.load(Ordering::SeqCst);
        assert!(tunnel.connection().await.is_err());
        assert_eq!(rebinds.load(Ordering::SeqCst), after_first + 1, "a later call must dial for itself, on a fresh endpoint");
    }

    #[test]
    fn stop_gap_reports_only_a_long_forward_step_of_the_wall_clock() {
        let t0 = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000);
        assert_eq!(stop_gap(t0, t0 + STOP_TICK), None, "two ticks 250ms apart");
        assert_eq!(stop_gap(t0, t0 + Duration::from_secs(6)), Some(Duration::from_secs(6)));
        assert_eq!(stop_gap(t0, t0 - Duration::from_secs(60)), None, "a clock stepping backwards");
    }

    #[test]
    fn the_dial_address_carries_the_remembered_relay_only_when_there_is_one() {
        let remote = EndpointAddr::new(id(7));
        assert_eq!(build_dial_addr(&remote, None), remote, "no hint dials the bare address");
        let relay: RelayUrl = "https://relay.example.com./".parse().unwrap();
        let hinted = build_dial_addr(&remote, Some(relay.clone()));
        assert_eq!(hinted.id, remote.id);
        assert!(hinted.relay_urls().any(|u| *u == relay), "{hinted:?}");
        assert_eq!(relay_of(&[(true, TransportAddr::Relay(relay.clone()))]), Some(relay));
        assert_eq!(relay_of(&[(true, TransportAddr::Ip("10.0.0.1:1".parse().unwrap()))]), None);
    }

    /// A relay hint that leads nowhere must not strand a dial whose direct
    /// address is good. Only checked here with `Minimal` endpoints (no relay
    /// transport), so it shows the hint does no harm, not that iroh falls back
    /// to its address lookup, which needs a relay and DNS.
    #[tokio::test]
    async fn a_wrong_relay_hint_does_not_stop_a_dial_with_a_good_direct_address() {
        let (server, accepted) = pong_server().await;
        let (tunnel, port) = tunnel_to(server).await;
        *tunnel.relay_hint.lock().unwrap() = Some("https://wrong-relay.invalid./".parse().unwrap());
        ping(port).await;
        assert_eq!(accepted.load(Ordering::SeqCst), 1);
    }

    /// Forwards UDP between a loopback front port and `target`, dropping every
    /// datagram while `open` is false: a PC nobody answers for, until opened.
    async fn udp_gate(target: std::net::SocketAddr, open: Arc<std::sync::atomic::AtomicBool>) -> std::net::SocketAddr {
        let front = tokio::net::UdpSocket::bind(("127.0.0.1", 0)).await.expect("front");
        let back = tokio::net::UdpSocket::bind(("127.0.0.1", 0)).await.expect("back");
        back.connect(target).await.expect("connect");
        let front_addr = front.local_addr().expect("addr");
        tokio::spawn(async move {
            let mut client = None;
            let (mut a, mut b) = ([0u8; 2048], [0u8; 2048]);
            loop {
                tokio::select! {
                    Ok((n, from)) = front.recv_from(&mut a) => {
                        client = Some(from);
                        if open.load(Ordering::SeqCst) {
                            let _ = back.send(&a[..n]).await;
                        }
                    }
                    Ok(n) = back.recv(&mut b) => {
                        if let (true, Some(to)) = (open.load(Ordering::SeqCst), client) {
                            let _ = front.send_to(&b[..n], to).await;
                        }
                    }
                }
            }
        });
        front_addr
    }

    /// A dial the phone slept through is abandoned when the wall clock shows it,
    /// not when the (monotonic, paused during sleep) attempt timeout runs out.
    #[tokio::test]
    async fn a_dial_that_slept_is_abandoned_at_once_and_restarted_on_a_fresh_endpoint() {
        use std::sync::atomic::AtomicBool;
        let (server, accepted) = pong_server().await;
        let port = server.ip_addrs().find(|a| a.is_ipv4()).expect("server v4 addr").port();
        let open = Arc::new(AtomicBool::new(false));
        let front = udp_gate(std::net::SocketAddr::from(([127, 0, 0, 1], port)), open.clone()).await;
        let remote = EndpointAddr::new(server.id).with_ip_addr(front);
        let offset = Arc::new(AtomicU64::new(0));
        let o = offset.clone();
        let ran_at: Arc<std::sync::Mutex<Option<Instant>>> = Default::default();
        let (gate, ran) = (open.clone(), ran_at.clone());
        let rebuild: Rebuild = Box::new(move || {
            // The PC answers again once the fresh endpoint exists.
            gate.store(true, Ordering::SeqCst);
            *ran.lock().unwrap() = Some(Instant::now());
            Box::pin(async { Endpoint::builder(presets::Minimal).bind().await.map_err(|e| e.to_string()) })
        });
        let client = Endpoint::builder(presets::Minimal).bind().await.expect("client bind");
        let mut tunnel = Tunnel::new(client, remote, rebuild);
        tunnel.clock = Arc::new(move || SystemTime::now() + Duration::from_secs(o.load(Ordering::SeqCst)));
        let tunnel = Arc::new(tunnel);
        let first_id = tunnel.endpoint().id();
        let t = tunnel.clone();
        let call = tokio::spawn(async move { t.connection().await.map(|c| c.stable_id()) });
        tokio::time::sleep(Duration::from_millis(400)).await;
        assert!(ran_at.lock().unwrap().is_none(), "the dial is still waiting on the silent PC");
        let jumped = Instant::now();
        offset.store(3600, Ordering::SeqCst);
        let mut ran_after = None;
        while jumped.elapsed() < Duration::from_secs(3) {
            if let Some(at) = *ran_at.lock().unwrap() {
                ran_after = Some(at - jumped);
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let ran_after = ran_after.expect("the rebuild never ran after the clock jump");
        assert!(ran_after < Duration::from_millis(1500), "restart took {ran_after:?}, the attempt timeout is {ATTEMPT_TIMEOUT:?}");
        tokio::time::timeout(Duration::from_secs(8), call).await.expect("dial finished").expect("join").expect("connected");
        // The server counts a connection a moment after the client sees it open.
        for _ in 0..50 {
            if accepted.load(Ordering::SeqCst) >= 1 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(accepted.load(Ordering::SeqCst) >= 1, "the PC never saw the connection");
        assert_ne!(tunnel.endpoint().id(), first_id, "the dial that followed the stop ran on the fresh endpoint");
        assert_eq!(tunnel.take_resume(), None, "the stop was consumed by the dial, nobody reports it again");
    }

    /// A rebuild closure that binds a working endpoint and counts its runs.
    fn counting_rebuild(counter: Arc<AtomicUsize>) -> Rebuild {
        Box::new(move || {
            counter.fetch_add(1, Ordering::SeqCst);
            Box::pin(async { Endpoint::builder(presets::Minimal).bind().await.map_err(|e| e.to_string()) })
        })
    }

    /// Time spent inside `connection()` must never read as a wake-up: a dial that
    /// slept leaves `last_alive` far in the past, and the next caller would close
    /// the connection that dial just made.
    #[tokio::test]
    async fn time_spent_in_a_dial_never_reads_as_a_wake_up_afterwards() {
        let (server, accepted) = pong_server().await;
        let dead = Endpoint::builder(presets::Minimal).bind().await.expect("client bind");
        dead.close().await;
        let handle: Arc<std::sync::OnceLock<Arc<Tunnel>>> = Arc::new(std::sync::OnceLock::new());
        let h = handle.clone();
        let rebuild: Rebuild = Box::new(move || {
            if let Some(t) = h.get() {
                t.last_alive.store(now_secs() - RESUME_GAP.as_secs() - 10, Ordering::SeqCst);
            }
            Box::pin(async { Endpoint::builder(presets::Minimal).bind().await.map_err(|e| e.to_string()) })
        });
        let tunnel = Arc::new(Tunnel::new(dead, server, rebuild));
        handle.set(tunnel.clone()).ok().expect("set once");
        let first = tunnel.connection().await.expect("attempt 2 succeeds on the rebuilt endpoint");
        let second = tunnel.connection().await.expect("cached");
        assert_eq!(first.stable_id(), second.stable_id());
        assert_eq!(accepted.load(Ordering::SeqCst), 1, "the connection the slow dial made must be reused");
    }

    /// After a connection is lost the redial binds a fresh endpoint BEFORE any
    /// dial on the old one, which is likely still holding pre-sleep relay state.
    #[tokio::test]
    async fn a_lost_connection_is_redialed_on_a_fresh_endpoint_first() {
        let (server, accepted) = pong_server().await;
        let client = Endpoint::builder(presets::Minimal).bind().await.expect("client bind");
        let rebinds = Arc::new(AtomicUsize::new(0));
        let tunnel = Tunnel::new(client, server, counting_rebuild(rebinds.clone()));
        tunnel.connection().await.expect("first dial");
        assert_eq!(rebinds.load(Ordering::SeqCst), 0, "the endpoint a tunnel is created with is already fresh");
        let id_before = tunnel.endpoint().id();
        stale(&tunnel);
        tunnel.connection().await.expect("redial");
        assert_eq!(rebinds.load(Ordering::SeqCst), 1, "one rebind, before the dial");
        assert_ne!(tunnel.endpoint().id(), id_before, "the redial runs on the fresh endpoint");
        assert_eq!(accepted.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn the_first_ever_dial_binds_no_new_endpoint() {
        let (server, _) = pong_server().await;
        let client = Endpoint::builder(presets::Minimal).bind().await.expect("client bind");
        let rebinds = Arc::new(AtomicUsize::new(0));
        let tunnel = Tunnel::new(client, server, counting_rebuild(rebinds.clone()));
        tunnel.connection().await.expect("first dial");
        assert_eq!(rebinds.load(Ordering::SeqCst), 0);
    }

    /// A rebind that fails leaves the old endpoint dialing, never a dead tunnel.
    #[tokio::test]
    async fn a_failed_rebind_falls_back_to_the_old_endpoint() {
        let (server, accepted) = pong_server().await;
        let client = Endpoint::builder(presets::Minimal).bind().await.expect("client bind");
        let rebinds = Arc::new(AtomicUsize::new(0));
        let counter = rebinds.clone();
        let rebuild: Rebuild = Box::new(move || {
            counter.fetch_add(1, Ordering::SeqCst);
            Box::pin(async { Err("no sockets".to_string()) })
        });
        let tunnel = Tunnel::new(client, server, rebuild);
        tunnel.connection().await.expect("first dial");
        stale(&tunnel);
        tunnel.connection().await.expect("redial on the old endpoint");
        assert_eq!(rebinds.load(Ordering::SeqCst), 1);
        assert_eq!(accepted.load(Ordering::SeqCst), 2);
    }

    /// A socket the WebView already closed must not stay parked behind the
    /// connection lock while a dial runs.
    #[tokio::test]
    async fn a_socket_closed_while_waiting_for_the_stream_ends_its_forward_task() {
        let (server, _) = pong_server().await;
        let (tunnel, _) = tunnel_to(server).await;
        let held = tunnel.conn.lock().await;
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let mut client = TcpStream::connect(("127.0.0.1", port)).await.expect("connect");
        let (served, _) = listener.accept().await.expect("accept");
        let t = tunnel.clone();
        let task = tokio::spawn(async move { forward(served, &t).await });
        client.write_all(b"PI").await.expect("send");
        tokio::time::sleep(Duration::from_millis(100)).await;
        drop(client);
        let ended = tokio::time::timeout(Duration::from_secs(2), task).await;
        assert!(ended.is_ok(), "forward still parked on the held lock after the peer closed");
        drop(held);
    }

    /// Bytes sent before the stream opens are written first once it does.
    #[tokio::test]
    async fn bytes_written_before_the_stream_opens_still_arrive() {
        let (server, _) = pong_server().await;
        let (tunnel, port) = tunnel_to(server).await;
        let held = tunnel.conn.lock().await;
        let mut sock = TcpStream::connect(("127.0.0.1", port)).await.expect("connect");
        sock.write_all(b"PING").await.expect("send");
        tokio::time::sleep(Duration::from_millis(200)).await;
        drop(held);
        let mut reply = vec![0u8; 4];
        tokio::time::timeout(Duration::from_secs(10), sock.read_exact(&mut reply)).await.expect("timed out").expect("read");
        assert_eq!(&reply, b"PONG");
    }

    async fn ping(port: u16) {
        let mut sock = TcpStream::connect(("127.0.0.1", port)).await.expect("connect");
        sock.write_all(b"PING").await.expect("send");
        let mut reply = vec![0u8; 4];
        sock.read_exact(&mut reply).await.expect("read reply");
        assert_eq!(&reply, b"PONG", "the iroh peer's response must reach the loopback client");
    }

    #[tokio::test]
    async fn forwards_a_request_and_response_over_iroh() {
        let (server, _) = pong_server().await;
        let (_tunnel, port) = tunnel_to(server).await;
        ping(port).await;
    }

    #[tokio::test]
    async fn loopback_sockets_share_one_quic_connection() {
        let (server, accepted) = pong_server().await;
        let (_tunnel, port) = tunnel_to(server).await;
        ping(port).await;
        ping(port).await;
        ping(port).await;
        assert_eq!(accepted.load(Ordering::SeqCst), 1);
    }

    fn stale(tunnel: &Tunnel) {
        tunnel.last_alive.store(now_secs() - RESUME_GAP.as_secs() - 10, Ordering::SeqCst);
    }

    #[tokio::test]
    async fn take_resume_fires_once_per_gap() {
        let (server, _) = pong_server().await;
        let (tunnel, _) = tunnel_to(server).await;
        assert_eq!(tunnel.take_resume(), None, "a fresh tunnel is not a wake-up");
        stale(&tunnel);
        let gap = tunnel.take_resume().expect("a stale last_alive is a gap");
        assert!(gap >= RESUME_GAP.as_secs() + 10);
        assert_eq!(tunnel.take_resume(), None, "the gap is consumed by the first caller");
    }

    #[tokio::test]
    async fn a_stale_last_alive_makes_the_next_request_redial_instead_of_reusing() {
        let (server, accepted) = pong_server().await;
        let (tunnel, port) = tunnel_to(server).await;
        ping(port).await;
        assert_eq!(accepted.load(Ordering::SeqCst), 1);
        stale(&tunnel);
        ping(port).await;
        assert_eq!(accepted.load(Ordering::SeqCst), 2, "the cached connection must not outlive a wake-up");
        ping(port).await;
        assert_eq!(accepted.load(Ordering::SeqCst), 2, "the redialed connection is reused afterwards");
    }

    /// The deterministic half of the race fix: while another task holds the
    /// connection lock (a dial in progress), a watchdog tick must not consume
    /// the gap, or the dial's result could be closed by a late drop.
    #[tokio::test]
    async fn watchdog_tick_waits_for_the_lock_before_consuming_the_gap() {
        let (server, _) = pong_server().await;
        let (tunnel, _) = tunnel_to(server).await;
        stale(&tunnel);
        let held = tunnel.conn.lock().await;
        let blocked = tokio::time::timeout(Duration::from_millis(100), tunnel.watchdog_tick()).await;
        assert!(blocked.is_err(), "the tick must wait for the lock");
        assert!(tunnel.last_alive.load(Ordering::SeqCst) < now_secs() - RESUME_GAP.as_secs(), "gap consumed too early");
        drop(held);
        tunnel.watchdog_tick().await;
        assert!(tunnel.last_alive.load(Ordering::SeqCst) >= now_secs() - 1, "gap consumed once the lock is free");
    }

    #[tokio::test]
    async fn a_watchdog_tick_racing_a_request_never_closes_the_fresh_connection() {
        let (server, accepted) = pong_server().await;
        let (tunnel, port) = tunnel_to(server).await;
        ping(port).await;
        stale(&tunnel);
        tokio::join!(ping(port), tunnel.watchdog_tick());
        ping(port).await;
        assert_eq!(accepted.load(Ordering::SeqCst), 2, "one redial for the one wake-up, then reuse");
    }

    #[test]
    fn path_summary_marks_the_selected_path_and_names_each_kind() {
        let ip: std::net::SocketAddr = "192.168.1.5:4000".parse().unwrap();
        let relay: iroh::RelayUrl = "https://relay.example.com./".parse().unwrap();
        let summary = path_summary(&[(true, TransportAddr::Ip(ip)), (false, TransportAddr::Relay(relay))]);
        assert!(summary.starts_with("*ip:192.168.1.5:4000"), "{summary}");
        assert!(summary.contains(",relay:"), "{summary}");
        assert_eq!(path_summary(&[]), "");
    }

    #[tokio::test]
    async fn remote_known_flips_after_the_first_dial() {
        let (server, _) = pong_server().await;
        let (tunnel, port) = tunnel_to(server).await;
        assert!(!tunnel.remote_known().await, "no state before the first dial");
        ping(port).await;
        assert!(tunnel.remote_known().await, "iroh keeps the remote after a dial");
    }

    #[tokio::test]
    async fn an_invalidated_connection_is_redialed() {
        let (server, accepted) = pong_server().await;
        let (tunnel, port) = tunnel_to(server).await;
        ping(port).await;
        let current = tunnel.connection().await.expect("cached");
        tunnel.invalidate(current.stable_id(), "test").await;
        ping(port).await;
        assert_eq!(accepted.load(Ordering::SeqCst), 2);
    }

    /// A failure reported against an old connection must not close the one a
    /// racing task has already redialed.
    #[tokio::test]
    async fn invalidating_a_superseded_connection_keeps_the_fresh_one() {
        let (server, accepted) = pong_server().await;
        let (tunnel, port) = tunnel_to(server).await;
        let first = tunnel.connection().await.expect("first dial");
        stale(&tunnel);
        let second = tunnel.connection().await.expect("redial after a wake-up");
        assert_ne!(first.stable_id(), second.stable_id());
        assert_eq!(accepted.load(Ordering::SeqCst), 2);
        tunnel.invalidate(first.stable_id(), "late failure of the old connection").await;
        ping(port).await;
        assert_eq!(accepted.load(Ordering::SeqCst), 2, "the fresh connection must be reused");
        assert!(second.close_reason().is_none());
    }
}
