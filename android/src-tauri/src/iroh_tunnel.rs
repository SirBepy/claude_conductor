//! Iroh client half of the remote-access tunnel, serving a fixed loopback port.
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

/// Fixed, not ephemeral: the SPA's `rc_token` lives in this origin's
/// localStorage, so a rotating port would force a re-pair every launch.
pub const LOOPBACK_PORT: u16 = 27184;

/// Upper bound on dialing the PC. Without one, a connect attempt made while
/// iroh still holds pre-sleep network state hangs the WebView request forever.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

/// Opening a stream on a live connection is local bookkeeping, so anything
/// this slow means the connection is wedged.
const OPEN_STREAM_TIMEOUT: Duration = Duration::from_secs(5);

const WATCHDOG_TICK: Duration = Duration::from_secs(2);

/// A wall-clock gap this much longer than one watchdog tick means the process
/// was frozen or the phone slept. `tokio::time` runs on CLOCK_MONOTONIC, which
/// stops during device suspend, so only the wall clock shows the gap.
const RESUME_GAP: Duration = Duration::from_secs(20);

/// Holds the port once the tunnel is up, so a second `start_iroh_tunnel`
/// call short-circuits instead of binding twice or leaking a task.
#[derive(Default)]
pub struct IrohTunnelState(Mutex<Option<u16>>);

#[tauri::command]
pub async fn start_iroh_tunnel(
    state: tauri::State<'_, IrohTunnelState>,
    endpoint_id: String,
) -> Result<u16, String> {
    let mut running = state.0.lock().await;
    if let Some(port) = *running {
        return Ok(port);
    }

    let remote_id: EndpointId = endpoint_id.parse().map_err(|e| {
        let msg = format!("bad endpoint id: {e}");
        error!("{}", msg);
        msg
    })?;
    let endpoint = Endpoint::builder(presets::N0)
        .alpns(vec![ALPN.to_vec()])
        .bind()
        .await
        .map_err(|e| {
            let msg = format!("iroh bind failed: {e}");
            error!("{}", msg);
            msg
        })?;
    let listener = TcpListener::bind(("127.0.0.1", LOOPBACK_PORT))
        .await
        .map_err(|e| {
            let msg = format!("loopback bind failed at port {}: {}", LOOPBACK_PORT, e);
            error!("{}", msg);
            msg
        })?;

    info!("iroh tunnel listener successfully bound on 127.0.0.1:{}", LOOPBACK_PORT);
    // A bare EndpointAddr (id only, no direct addrs) makes each connect() go
    // through the N0 preset's pkarr lookup, matching the desktop's ticket.
    let tunnel = Arc::new(Tunnel::new(endpoint, remote_id.into()));
    tokio::spawn(resume_watchdog(tunnel.clone()));
    tokio::spawn(accept_loop(listener, tunnel));
    *running = Some(LOOPBACK_PORT);
    Ok(LOOPBACK_PORT)
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
                Ok(Err(e)) => {
                    warn!("open_bi failed: {e}");
                    last_err = e.into();
                }
                Err(_) => {
                    warn!("open_bi timed out");
                    last_err = "open_bi timed out".into();
                }
            }
            self.invalidate("could not open a stream").await;
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
