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
use iroh::{Endpoint, EndpointAddr, EndpointId, TransportAddr};
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

/// Upper bound on dialing the PC. Without one, a connect attempt made while
/// iroh still holds pre-sleep network state hangs the WebView request forever.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

/// Opening a stream is local bookkeeping and only waits when the peer's
/// concurrent-stream limit is used up - a busy connection, not a dead one, so
/// a timeout fails just this socket and never tears the connection down.
const OPEN_STREAM_TIMEOUT: Duration = Duration::from_secs(5);

const WATCHDOG_TICK: Duration = Duration::from_secs(2);

/// A wall-clock gap this much longer than one watchdog tick means the process
/// was frozen or the phone slept. `tokio::time` runs on CLOCK_MONOTONIC, which
/// stops during device suspend, so only the wall clock shows the gap.
const RESUME_GAP: Duration = Duration::from_secs(20);

/// How long `remote_known` waits on iroh's remote-state actor. It sits under the
/// connection lock, so a wedged actor must not stall every socket.
const REMOTE_INFO_TIMEOUT: Duration = Duration::from_millis(250);

/// Upper bound on one `Endpoint::network_change` call. iroh only enqueues a
/// message to its socket actor there, so it is fast unless that actor is wedged;
/// `connection()` runs it under the connection lock, up to twice per call (the
/// wake-up or closed-connection path, then the failed-dial path).
const NETWORK_CHANGE_TIMEOUT: Duration = Duration::from_millis(500);

/// Network-change notifications one `connection()` call can run under its lock.
const NETWORK_CHANGES_UNDER_LOCK: u128 = 2;

/// Longest the connection lock can be held by one `connection()` call, in ms:
/// every await it makes under the lock, plus one watchdog tick (the lock can be
/// released just after a tick) and the 1s that `now_secs` truncation can add.
/// `take_resume` stamps `last_alive` at the START of the call, so the next caller
/// or watchdog tick sees this whole duration as the gap since the previous check.
const fn max_lock_held_ms() -> u128 {
    NETWORK_CHANGES_UNDER_LOCK * NETWORK_CHANGE_TIMEOUT.as_millis()
        + REMOTE_INFO_TIMEOUT.as_millis()
        + CONNECT_TIMEOUT.as_millis()
        + WATCHDOG_TICK.as_millis()
        + 1_000
}

// If the lock-held time reached RESUME_GAP, every slow dial would read as a
// wake-up and tear down the connection it just made.
const _: () = assert!(max_lock_held_ms() < RESUME_GAP.as_millis());

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
        self.tunnel.endpoint.close().await;
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
    let endpoint = Endpoint::builder(presets::N0)
        .alpns(vec![ALPN.to_vec()])
        .bind()
        .await
        .map_err(|e| {
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
    // A bare EndpointAddr (id only, no direct addrs) makes each connect() go
    // through the N0 preset's pkarr lookup, matching the desktop's ticket.
    let tunnel = Arc::new(Tunnel::new(endpoint, remote_id.into()));
    running.insert(remote_id, RunningTunnel::spawn(listener, port, tunnel));
    Ok(port)
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
    endpoint: Endpoint,
    remote: EndpointAddr,
    conn: Mutex<Option<Connection>>,
    /// Wall-clock seconds of the last gap check. Starts at "now" so a fresh
    /// tunnel's first dial is not mistaken for a wake-up.
    last_alive: AtomicU64,
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
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
    fn new(endpoint: Endpoint, remote: EndpointAddr) -> Self {
        Self { endpoint, remote, conn: Mutex::new(None), last_alive: AtomicU64::new(now_secs()) }
    }

    /// Returns the length of the gap when the process was frozen or the phone
    /// slept since the previous call, `None` otherwise. The swap makes exactly
    /// one caller see each gap; callers hold the connection lock around it so
    /// the gap and the cached connection are handled together.
    fn take_resume(&self) -> Option<u64> {
        let now = now_secs();
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
    /// iroh actor cannot stretch the connection lock past `RESUME_GAP`.
    async fn network_change(&self) {
        if tokio::time::timeout(NETWORK_CHANGE_TIMEOUT, self.endpoint.network_change()).await.is_err() {
            warn!("network_change did not return within {}ms", NETWORK_CHANGE_TIMEOUT.as_millis());
        }
    }

    /// Whether iroh already holds state for the PC (a warm redial), as opposed
    /// to a cold lookup. Bounded: it waits on iroh's remote-state actor.
    async fn remote_known(&self) -> bool {
        tokio::time::timeout(REMOTE_INFO_TIMEOUT, self.endpoint.remote_info(self.remote.id))
            .await
            .ok()
            .flatten()
            .is_some()
    }

    /// The lock is held across the dial on purpose: a burst of WebView sockets
    /// on resume waits for one connect instead of racing several.
    async fn connection(&self) -> Result<Connection, BoxError> {
        let mut guard = self.conn.lock().await;
        // A cached connection that sat through a freeze can look open while
        // every byte on it disappears, so a gap is checked before it is
        // handed out, not left to the watchdog's next tick.
        let resumed = self.take_resume();
        if let Some(secs) = resumed {
            Self::drop_locked(&mut guard, &format!("resumed after {secs}s asleep (seen by connection())"));
            self.network_change().await;
        } else if let Some(conn) = guard.as_ref() {
            match conn.close_reason() {
                None => return Ok(conn.clone()),
                Some(reason) => {
                    info!("tunnel connection closed ({reason}), redialing");
                    // Measured on a Pixel 7 (2026-10-30): after the idle close,
                    // redials on the same iroh state timed out four times in a
                    // row (15s each) and the first success took 14s, while a
                    // fresh endpoint dialed in 272ms. iroh cannot see network
                    // changes on Android, so tell it before redialing.
                    self.network_change().await;
                }
            }
        }
        let warm = self.remote_known().await;
        let started = Instant::now();
        let conn = match tokio::time::timeout(CONNECT_TIMEOUT, self.endpoint.connect(self.remote.clone(), ALPN)).await {
            Ok(Ok(conn)) => conn,
            Ok(Err(e)) => {
                warn!("tunnel connect failed after {}ms warm={warm}: {e}", started.elapsed().as_millis());
                *guard = None;
                self.network_change().await;
                return Err(e.into());
            }
            Err(_) => {
                warn!("tunnel connect timed out after {}s warm={warm}", CONNECT_TIMEOUT.as_secs());
                *guard = None;
                self.network_change().await;
                return Err("tunnel connect timed out".into());
            }
        };
        let paths: Vec<(bool, TransportAddr)> =
            conn.paths().iter().map(|p| (p.is_selected(), p.remote_addr().clone())).collect();
        info!(
            "tunnel connected in {}ms warm={warm} paths=[{}] resumed={}",
            started.elapsed().as_millis(),
            path_summary(&paths),
            resumed.is_some()
        );
        *guard = Some(conn.clone());
        Ok(conn)
    }

    /// Drops the shared connection so the next stream redials. Also tells iroh
    /// the network may have changed: on Android it cannot detect that by itself
    /// (see `Endpoint::network_change`'s docs), so a Wi-Fi/LTE switch during
    /// sleep would otherwise keep it on stale sockets and relay state.
    async fn invalidate(&self, why: &str) {
        Self::drop_locked(&mut *self.conn.lock().await, why);
        self.network_change().await;
    }

    /// One watchdog tick. The lock is taken BEFORE the gap is consumed: if the
    /// gap were consumed first, a `connection()` call racing in would see no
    /// gap and hand out the dead connection, or the late drop would close a
    /// connection dialed after the gap.
    async fn watchdog_tick(&self) {
        let mut guard = self.conn.lock().await;
        if let Some(secs) = self.take_resume() {
            Self::drop_locked(&mut guard, &format!("resumed after {secs}s asleep"));
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
                    self.invalidate("could not open a stream").await;
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
async fn forward(tcp: TcpStream, tunnel: &Tunnel) -> Result<(), BoxError> {
    let (mut send, mut recv) = tunnel.open_stream().await?;
    let (mut tcp_read, mut tcp_write) = tokio::io::split(tcp);
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
        let running = RunningTunnel::spawn(listener, port, Arc::new(Tunnel::new(client, server)));
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

    /// The lock-held time of one `connection()` call must stay under the wake-up gap,
    /// or a slow dial reads as a wake-up. The const assert pins it at compile time;
    /// this names the figures when it fails and keeps a floor on the margin.
    #[test]
    fn worst_case_lock_held_stays_under_the_resume_gap() {
        let held = max_lock_held_ms();
        assert!(held < RESUME_GAP.as_millis(), "lock held up to {held}ms against a {}ms resume gap", RESUME_GAP.as_millis());
        assert!(held >= CONNECT_TIMEOUT.as_millis() + REMOTE_INFO_TIMEOUT.as_millis(), "every await under the lock is counted");
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
                let conn = incoming.await.expect("handshake");
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
        let tunnel = Arc::new(Tunnel::new(client, server));
        tokio::spawn(accept_loop(listener, tunnel.clone()));
        (tunnel, port)
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
        tunnel.invalidate("test").await;
        ping(port).await;
        assert_eq!(accepted.load(Ordering::SeqCst), 2);
    }
}
