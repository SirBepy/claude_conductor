//! Iroh client half of the remote-access tunnel, serving a per-PC loopback port.
//! Inverts `src-tauri/src/daemon/iroh_tunnel.rs::forward`: the daemon splices a
//! QUIC bi-stream onto a fresh TCP connection, here it is the other way round.
//!
//! Every loopback TCP connection rides its own bi-stream on ONE shared QUIC
//! connection. The daemon side already loops `accept_bi` per connection, so
//! no change is needed there.

use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};

use iroh::endpoint::{presets, Connection, RecvStream, SendStream, VarInt};
use iroh::{Endpoint, EndpointAddr, EndpointId};
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
        return Ok(live.port);
    }
    for (old_id, old) in running.drain() {
        info!("shutting down tunnel to {old_id} on port {}", old.port);
        old.shutdown().await;
    }

    let endpoint = Endpoint::builder(presets::N0)
        .alpns(vec![ALPN.to_vec()])
        .bind()
        .await
        .map_err(|e| {
            let msg = format!("iroh bind failed: {e}");
            error!("{}", msg);
            msg
        })?;
    let (listener, port) = bind_loopback(&port_candidates(&remote_id, legacy.unwrap_or(false))).await?;

    info!("iroh tunnel listener successfully bound on 127.0.0.1:{}", port);
    // A bare EndpointAddr (id only, no direct addrs) makes each connect() go
    // through the N0 preset's pkarr lookup, matching the desktop's ticket.
    let tunnel = Arc::new(Tunnel::new(endpoint, remote_id.into()));
    running.insert(remote_id, RunningTunnel::spawn(listener, port, tunnel));
    Ok(port)
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
}

impl Tunnel {
    fn new(endpoint: Endpoint, remote: EndpointAddr) -> Self {
        Self { endpoint, remote, conn: Mutex::new(None) }
    }

    /// The lock is held across the dial on purpose: a burst of WebView sockets
    /// on resume waits for one connect instead of racing several.
    async fn connection(&self) -> Result<Connection, BoxError> {
        let mut guard = self.conn.lock().await;
        if let Some(conn) = guard.as_ref() {
            match conn.close_reason() {
                None => return Ok(conn.clone()),
                Some(reason) => info!("tunnel connection closed ({reason}), redialing"),
            }
        }
        let started = Instant::now();
        let conn = match tokio::time::timeout(CONNECT_TIMEOUT, self.endpoint.connect(self.remote.clone(), ALPN)).await {
            Ok(Ok(conn)) => conn,
            Ok(Err(e)) => {
                warn!("tunnel connect failed after {}ms: {e}", started.elapsed().as_millis());
                *guard = None;
                return Err(e.into());
            }
            Err(_) => {
                warn!("tunnel connect timed out after {}s", CONNECT_TIMEOUT.as_secs());
                *guard = None;
                return Err("tunnel connect timed out".into());
            }
        };
        info!("tunnel connected in {}ms", started.elapsed().as_millis());
        *guard = Some(conn.clone());
        Ok(conn)
    }

    /// Drops the shared connection so the next stream redials. Also tells iroh
    /// the network may have changed: on Android it cannot detect that by itself
    /// (see `Endpoint::network_change`'s docs), so a Wi-Fi/LTE switch during
    /// sleep would otherwise keep it on stale sockets and relay state.
    async fn invalidate(&self, why: &str) {
        if let Some(conn) = self.conn.lock().await.take() {
            info!("dropping tunnel connection: {why}");
            conn.close(VarInt::from_u32(0), why.as_bytes());
        }
        self.endpoint.network_change().await;
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
    let mut last = SystemTime::now();
    loop {
        tokio::time::sleep(WATCHDOG_TICK).await;
        let now = SystemTime::now();
        if is_resume_gap(last, now) {
            let secs = now.duration_since(last).map(|d| d.as_secs()).unwrap_or(0);
            tunnel.invalidate(&format!("resumed after {secs}s asleep")).await;
        }
        last = now;
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
