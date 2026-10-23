//! Dials a paired peer's iroh endpoint and exposes it as a local loopback TCP
//! proxy port, so every existing peer-client codepath (which only knows how
//! to speak `http://host:port`) can reach an iroh-only peer unchanged.
//! Inverts `daemon::iroh_tunnel`'s accept side the same way
//! `android/src-tauri/src/iroh_tunnel.rs` does for the phone: one loopback
//! `TcpListener` per remote id, each accepted connection spliced onto a fresh
//! QUIC bi-stream of ONE cached QUIC connection to that peer.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use iroh::endpoint::{presets, Connection, RecvStream, SendStream};
use iroh::{Endpoint, EndpointAddr, EndpointId};
use tokio::io::AsyncWriteExt;
use tokio::net::{TcpListener, TcpStream};

use super::super::iroh_tunnel::{quic_transport_config, ALPN};
use super::peer_client::TUNNEL_FAILED_HEADER;

/// Upper bound on one cold dial. iroh gives up on its own after about this
/// long ("timed out" in daemon.log, roughly every 34s); this is the backstop so
/// a stuck dial can never park a caller (or the dial lock) forever.
pub(super) const DIAL_TIMEOUT: Duration = Duration::from_secs(30);

/// How long the proxy lets a client finish sending after it has answered a
/// failed dial, so closing does not RST the 502 away.
const DRAIN_AFTER_REPLY: Duration = Duration::from_secs(2);

pub struct IrohDialer {
    endpoint: Endpoint,
    /// One loopback proxy (port + cached QUIC connection) per iroh id dialed so
    /// far - `dial_and_proxy` reuses an existing entry instead of binding a
    /// second listener (and leaking its accept loop) for a peer already being
    /// proxied.
    links: Mutex<HashMap<String, Arc<PeerLink>>>,
    dial_timeout: Duration,
}

/// One peer's loopback proxy: its port, and the single QUIC connection every
/// accepted TCP connection opens a stream on. A QUIC handshake plus address
/// lookup after idle is the slow part of reaching a peer (up to
/// `DIAL_TIMEOUT`), so it happens once, not once per HTTP request.
struct PeerLink {
    endpoint: Endpoint,
    remote: EndpointAddr,
    port: u16,
    dial_timeout: Duration,
    slot: tokio::sync::Mutex<Slot>,
    /// Count of dials that have finished, success or failure, incremented under
    /// `slot`. A caller that queued on the lock compares it with what it read
    /// before queueing to learn that someone else's dial completed while it waited.
    dials: AtomicU64,
}

#[derive(Default)]
struct Slot {
    conn: Option<Connection>,
    /// Outcome of the most recent dial when it failed, handed to callers that
    /// were queued behind it so N waiters do not each sit out their own
    /// `DIAL_TIMEOUT` against a peer that is down.
    last_err: Option<String>,
}

impl PeerLink {
    /// The cached connection if it is still open (and not the `stale` one the
    /// caller just saw fail), else a fresh dial. The lock is held across the
    /// dial on purpose: concurrent callers share the one in-flight dial.
    async fn live_connection(&self, stale: Option<usize>) -> Result<Connection, String> {
        let seen = self.dials.load(Ordering::Acquire);
        let mut slot = self.slot.lock().await;
        if let Some(conn) = &slot.conn {
            if conn.close_reason().is_none() && Some(conn.stable_id()) != stale {
                return Ok(conn.clone());
            }
        }
        if self.dials.load(Ordering::Acquire) != seen {
            if let Some(err) = &slot.last_err {
                return Err(err.clone());
            }
        }
        let outcome = self.dial().await;
        match &outcome {
            Ok(conn) => {
                slot.conn = Some(conn.clone());
                slot.last_err = None;
            }
            Err(e) => {
                slot.conn = None;
                slot.last_err = Some(e.clone());
            }
        }
        self.dials.fetch_add(1, Ordering::Release);
        outcome
    }

    async fn dial(&self) -> Result<Connection, String> {
        let connecting = self.endpoint.connect(self.remote.clone(), ALPN);
        let outcome = match tokio::time::timeout(self.dial_timeout, connecting).await {
            Ok(Ok(conn)) => return Ok(conn),
            Ok(Err(e)) => e.to_string(),
            Err(_) => format!("no answer within {}s", self.dial_timeout.as_secs()),
        };
        // Warn, not debug: a peer that can never be dialed otherwise
        // leaves no trace at the default log level, only a silent
        // "Failed to load" in the UI.
        log::warn!("iroh dialer: connect to {} failed: {outcome}", self.remote.id);
        Err(format!("could not reach that machine over iroh: {outcome}"))
    }

    async fn ensure_connected(&self) -> Result<(), String> {
        self.live_connection(None).await.map(|_| ())
    }

    /// One new bi-stream on the cached connection. If opening fails the
    /// connection died since it was cached, so redial exactly once and try
    /// again; a second failure is reported, not looped.
    async fn open_stream(&self) -> Result<(SendStream, RecvStream), String> {
        let conn = self.live_connection(None).await?;
        let first = match conn.open_bi().await {
            Ok(pair) => return Ok(pair),
            Err(e) => e,
        };
        log::debug!("iroh dialer: cached connection to {} unusable ({first}); redialing", self.remote.id);
        let fresh = self.live_connection(Some(conn.stable_id())).await?;
        fresh.open_bi().await.map_err(|e| format!("could not open a stream to that machine: {e}"))
    }
}

impl IrohDialer {
    /// Binds an ephemeral-key endpoint on the production preset (n0 relay +
    /// address lookup, since a bare iroh id carries no direct addresses).
    pub async fn new() -> Result<Self, String> {
        let endpoint = Endpoint::builder(presets::N0)
            .transport_config(quic_transport_config())
            .alpns(vec![ALPN.to_vec()])
            .bind()
            .await
            .map_err(|e| format!("iroh dialer bind failed: {e}"))?;
        Ok(Self::with_endpoint(endpoint))
    }

    /// Test seam: `presets::Minimal` has no relay/discovery, so a test builds
    /// its own endpoint and hands it in here rather than going through `new`.
    #[cfg(test)]
    pub fn with_endpoint(endpoint: Endpoint) -> Self {
        Self { endpoint, links: Mutex::new(HashMap::new()), dial_timeout: DIAL_TIMEOUT }
    }

    #[cfg(not(test))]
    fn with_endpoint(endpoint: Endpoint) -> Self {
        Self { endpoint, links: Mutex::new(HashMap::new()), dial_timeout: DIAL_TIMEOUT }
    }

    /// Idempotent: the first call for a given iroh id binds a fresh
    /// `127.0.0.1:0` listener and spawns its accept loop; every later call
    /// for the same id returns the same port. A bare `EndpointId` (no direct
    /// addrs) means `connect` falls back to the endpoint's address lookup
    /// service, matching the android dialer's own bare-id ticket. Returns only
    /// once the QUIC connection to the peer is up (bounded by `DIAL_TIMEOUT`),
    /// so the caller's first request on that port never pays for the cold dial.
    pub async fn connected_proxy_port(&self, iroh_id: &str) -> Result<u16, String> {
        let remote: EndpointId = iroh_id.parse().map_err(|e| format!("bad iroh id: {e}"))?;
        let link = self.dial_and_proxy(iroh_id, EndpointAddr::from(remote)).await?;
        link.ensure_connected().await?;
        Ok(link.port)
    }

    /// Test seam: `presets::Minimal` has no discovery, so an offline test
    /// supplies a full `EndpointAddr` (direct addrs included) instead of a
    /// bare id string.
    #[cfg(test)]
    pub async fn proxy_port_for_addr(&self, addr: EndpointAddr) -> Result<u16, String> {
        let key = addr.id.to_string();
        Ok(self.dial_and_proxy(&key, addr).await?.port)
    }

    #[cfg(test)]
    pub(crate) fn with_dial_timeout(mut self, timeout: Duration) -> Self {
        self.dial_timeout = timeout;
        self
    }

    async fn dial_and_proxy(&self, key: &str, addr: EndpointAddr) -> Result<Arc<PeerLink>, String> {
        if let Some(link) = self.links.lock().unwrap_or_else(|e| e.into_inner()).get(key) {
            return Ok(link.clone());
        }
        let listener =
            TcpListener::bind(("127.0.0.1", 0)).await.map_err(|e| format!("proxy bind failed: {e}"))?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        // Two concurrent first-callers for the same id could each reach this
        // point; keep whichever wins the map insert below and let the loser's
        // freshly-bound listener just sit unaccepted (nobody will ever dial
        // its port, since callers only ever get the winner's).
        let mut guard = self.links.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(existing) = guard.get(key) {
            return Ok(existing.clone());
        }
        let link = Arc::new(PeerLink {
            endpoint: self.endpoint.clone(),
            remote: addr,
            port,
            dial_timeout: self.dial_timeout,
            slot: tokio::sync::Mutex::new(Slot::default()),
            dials: AtomicU64::new(0),
        });
        guard.insert(key.to_string(), link.clone());
        drop(guard);
        tokio::spawn(accept_loop(listener, link.clone()));
        Ok(link)
    }
}

async fn accept_loop(listener: TcpListener, link: Arc<PeerLink>) {
    loop {
        match listener.accept().await {
            Ok((tcp, _)) => {
                let link = link.clone();
                tokio::spawn(async move {
                    if let Err(e) = forward(tcp, &link).await {
                        log::debug!("iroh dialer: proxied connection ended: {e}");
                    }
                });
            }
            Err(e) => {
                log::warn!("iroh dialer: proxy accept failed: {e}");
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        }
    }
}

/// Splice one accepted local TCP connection onto a fresh QUIC bi-stream -
/// inverse of `iroh_tunnel::forward`, matching
/// `android/src-tauri/src/iroh_tunnel.rs::forward`.
async fn forward(tcp: TcpStream, link: &PeerLink) -> std::io::Result<()> {
    let (mut send, mut recv) = match link.open_stream().await {
        Ok(pair) => pair,
        Err(e) => {
            reply_tunnel_failed(tcp, &e).await;
            return Err(std::io::Error::other(e));
        }
    };
    let (mut tcp_read, mut tcp_write) = tokio::io::split(tcp);
    let up = async {
        tokio::io::copy(&mut tcp_read, &mut send).await?;
        send.shutdown().await
    };
    let down = async {
        tokio::io::copy(&mut recv, &mut tcp_write).await?;
        tcp_write.shutdown().await
    };
    tokio::try_join!(up, down)?;
    Ok(())
}

/// Answers an accepted connection with a 502 marked `TUNNEL_FAILED_HEADER`
/// instead of a bare close. No byte of the client's request was forwarded
/// anywhere, which is what lets `PeerClient::call` retry it safely; a bare
/// close would look the same as a peer that read the request and then died.
async fn reply_tunnel_failed(tcp: TcpStream, why: &str) {
    let head = format!(
        "HTTP/1.1 502 Bad Gateway\r\n{TUNNEL_FAILED_HEADER}: 1\r\ncontent-type: text/plain\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
        why.len()
    );
    let (mut read, mut write) = tokio::io::split(tcp);
    if write.write_all(head.as_bytes()).await.is_err() || write.write_all(why.as_bytes()).await.is_err() {
        return;
    }
    let _ = write.shutdown().await;
    // The client's request is still unread; closing now would reset the
    // connection and can discard the response before the client reads it.
    let _ = tokio::time::timeout(DRAIN_AFTER_REPLY, tokio::io::copy(&mut read, &mut tokio::io::sink())).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{routing::get, Json, Router};
    use tokio::net::{TcpListener as TokioTcpListener, TcpStream as TokioTcpStream};

    /// Copies `iroh_tunnel::accept_loop`/`forward`'s splice (desktop's own
    /// ACCEPT side, which is private to that module) but targets an
    /// arbitrary local port instead of `resolve_port()`'s fixed 27183, so the
    /// test can point it at a throwaway axum server.
    async fn accept_and_splice_to(endpoint: Endpoint, target_port: u16) {
        accept_and_splice_counting(endpoint, target_port, Arc::default()).await
    }

    /// QUIC connections the accept side has completed a handshake with, and a
    /// handle on each so a test can close one from the server end.
    #[derive(Default)]
    struct Accepted {
        count: std::sync::atomic::AtomicUsize,
        conns: Mutex<Vec<Connection>>,
    }

    async fn accept_and_splice_counting(endpoint: Endpoint, target_port: u16, accepted: Arc<Accepted>) {
        while let Some(incoming) = endpoint.accept().await {
            let accepted = accepted.clone();
            tokio::spawn(async move {
                let Ok(conn) = incoming.await else { return };
                accepted.count.fetch_add(1, Ordering::SeqCst);
                accepted.conns.lock().unwrap().push(conn.clone());
                loop {
                    match conn.accept_bi().await {
                        Ok((mut send, mut recv)) => {
                            tokio::spawn(async move {
                                let Ok(tcp) = TokioTcpStream::connect(("127.0.0.1", target_port)).await else {
                                    return;
                                };
                                let (mut tcp_read, mut tcp_write) = tokio::io::split(tcp);
                                let up = async {
                                    tokio::io::copy(&mut recv, &mut tcp_write).await?;
                                    tokio::io::AsyncWriteExt::shutdown(&mut tcp_write).await
                                };
                                let down = async {
                                    tokio::io::copy(&mut tcp_read, &mut send).await?;
                                    tokio::io::AsyncWriteExt::shutdown(&mut send).await
                                };
                                let _ = tokio::try_join!(up, down);
                            });
                        }
                        Err(_) => return,
                    }
                }
            });
        }
    }

    async fn spawn_health_server() -> (u16, tokio::task::JoinHandle<()>) {
        let app = Router::new().route("/api/health", get(|| async { Json(serde_json::json!({"ok": true})) }));
        let listener = TokioTcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        (port, handle)
    }

    #[tokio::test]
    async fn proxies_a_request_through_iroh_to_a_local_server() {
        let (health_port, health_handle) = spawn_health_server().await;

        let accept_endpoint =
            Endpoint::builder(presets::Minimal).alpns(vec![ALPN.to_vec()]).bind().await.expect("accept bind");
        let accept_addr = accept_endpoint.addr();
        tokio::spawn(accept_and_splice_to(accept_endpoint, health_port));

        let dial_endpoint = Endpoint::builder(presets::Minimal).bind().await.expect("dial bind");
        let dialer = IrohDialer::with_endpoint(dial_endpoint);
        let proxy_port = dialer.proxy_port_for_addr(accept_addr).await.expect("proxy_port_for_addr");

        let resp = reqwest::get(format!("http://127.0.0.1:{proxy_port}/api/health"))
            .await
            .expect("proxied request");
        let body: serde_json::Value = resp.json().await.expect("json body");
        assert_eq!(body, serde_json::json!({"ok": true}));

        health_handle.abort();
    }

    #[tokio::test]
    async fn proxy_port_is_idempotent_and_survives_a_client_disconnect() {
        let (health_port, health_handle) = spawn_health_server().await;

        let accept_endpoint =
            Endpoint::builder(presets::Minimal).alpns(vec![ALPN.to_vec()]).bind().await.expect("accept bind");
        let accept_addr = accept_endpoint.addr();
        tokio::spawn(accept_and_splice_to(accept_endpoint, health_port));

        let dial_endpoint = Endpoint::builder(presets::Minimal).bind().await.expect("dial bind");
        let dialer = IrohDialer::with_endpoint(dial_endpoint);
        let first = dialer.proxy_port_for_addr(accept_addr.clone()).await.expect("first proxy_port_for_addr");
        let second = dialer.proxy_port_for_addr(accept_addr).await.expect("second proxy_port_for_addr");
        assert_eq!(first, second, "the same iroh id must reuse the same proxy port");

        for _ in 0..2 {
            let resp = reqwest::get(format!("http://127.0.0.1:{first}/api/health"))
                .await
                .expect("proxied request");
            assert_eq!(resp.status(), reqwest::StatusCode::OK);
        }

        health_handle.abort();
    }

    async fn dialer_and_counting_server() -> (IrohDialer, EndpointAddr, Arc<Accepted>) {
        let (health_port, _handle) = spawn_health_server().await;
        let accept_endpoint =
            Endpoint::builder(presets::Minimal).alpns(vec![ALPN.to_vec()]).bind().await.expect("accept bind");
        let addr = accept_endpoint.addr();
        let accepted = Arc::new(Accepted::default());
        tokio::spawn(accept_and_splice_counting(accept_endpoint, health_port, accepted.clone()));
        let dial_endpoint = Endpoint::builder(presets::Minimal).bind().await.expect("dial bind");
        (IrohDialer::with_endpoint(dial_endpoint), addr, accepted)
    }

    /// Never reuses a TCP connection, so every GET is a fresh accept on the
    /// proxy port (what a pooled client does after its idle sockets expire).
    fn fresh_connection_client() -> reqwest::Client {
        reqwest::Client::builder().pool_max_idle_per_host(0).no_proxy().build().unwrap()
    }

    async fn health_status(client: &reqwest::Client, port: u16) -> reqwest::StatusCode {
        client.get(format!("http://127.0.0.1:{port}/api/health")).send().await.expect("proxied request").status()
    }

    fn only_link(dialer: &IrohDialer) -> Arc<PeerLink> {
        dialer.links.lock().unwrap().values().next().expect("one link").clone()
    }

    /// Before connection reuse every accepted TCP connection ran its own QUIC
    /// handshake, so each request after idle paid a full cold dial.
    #[tokio::test]
    async fn tcp_connections_share_one_quic_connection() {
        let (dialer, addr, accepted) = dialer_and_counting_server().await;
        let port = dialer.proxy_port_for_addr(addr).await.expect("proxy port");
        let client = fresh_connection_client();
        for _ in 0..3 {
            assert_eq!(health_status(&client, port).await, reqwest::StatusCode::OK);
        }
        assert_eq!(accepted.count.load(Ordering::SeqCst), 1, "three TCP connections, one QUIC handshake");
    }

    /// Concurrent first requests must also share the in-flight dial rather than
    /// each starting their own.
    #[tokio::test]
    async fn concurrent_first_requests_share_one_dial() {
        let (dialer, addr, accepted) = dialer_and_counting_server().await;
        let port = dialer.proxy_port_for_addr(addr).await.expect("proxy port");
        let client = fresh_connection_client();
        let all = futures_util::future::join_all((0..5).map(|_| health_status(&client, port))).await;
        assert!(all.iter().all(|s| *s == reqwest::StatusCode::OK), "{all:?}");
        assert_eq!(accepted.count.load(Ordering::SeqCst), 1);
        assert_eq!(only_link(&dialer).dials.load(Ordering::SeqCst), 1);
    }

    /// The server (or a sleeping peer) closing the connection leaves a dead
    /// entry in the cache; the next requests must redial once and share that
    /// redial, not fail and not dial per request.
    #[tokio::test]
    async fn a_closed_cached_connection_is_redialed_once() {
        let (dialer, addr, accepted) = dialer_and_counting_server().await;
        let port = dialer.proxy_port_for_addr(addr).await.expect("proxy port");
        let client = fresh_connection_client();
        assert_eq!(health_status(&client, port).await, reqwest::StatusCode::OK);

        let server_side = accepted.conns.lock().unwrap()[0].clone();
        server_side.close(iroh::endpoint::VarInt::from_u32(0), b"test");
        for _ in 0..2 {
            assert_eq!(health_status(&client, port).await, reqwest::StatusCode::OK);
        }
        assert_eq!(accepted.count.load(Ordering::SeqCst), 2, "one original dial plus exactly one redial");
    }

    /// A bare id string resolves through the endpoint's address lookup, the way
    /// the production n0 preset resolves a paired machine, and the port
    /// `connected_proxy_port` returns already has its tunnel up.
    #[tokio::test]
    async fn connected_proxy_port_dials_before_returning() {
        use iroh::address_lookup::MemoryLookup;

        let (health_port, _handle) = spawn_health_server().await;
        let accept_endpoint =
            Endpoint::builder(presets::Minimal).alpns(vec![ALPN.to_vec()]).bind().await.expect("accept bind");
        let addr = accept_endpoint.addr();
        let accepted = Arc::new(Accepted::default());
        tokio::spawn(accept_and_splice_counting(accept_endpoint, health_port, accepted.clone()));

        let lookup = MemoryLookup::new();
        lookup.add_endpoint_info(addr.clone());
        let dial_endpoint =
            Endpoint::builder(presets::Minimal).address_lookup(lookup).bind().await.expect("dial bind");
        let dialer = IrohDialer::with_endpoint(dial_endpoint);

        let port = dialer.connected_proxy_port(&addr.id.to_string()).await.expect("connected port");
        assert_eq!(accepted.count.load(Ordering::SeqCst), 1, "the dial happened before any request");
        assert_eq!(health_status(&fresh_connection_client(), port).await, reqwest::StatusCode::OK);
        assert_eq!(accepted.count.load(Ordering::SeqCst), 1);
    }

    fn undialable_addr() -> EndpointAddr {
        EndpointAddr::from(iroh::SecretKey::generate().public())
    }

    #[tokio::test]
    async fn connected_proxy_port_reports_a_peer_that_cannot_be_dialed() {
        let dial_endpoint = Endpoint::builder(presets::Minimal).bind().await.expect("dial bind");
        let dialer = IrohDialer::with_endpoint(dial_endpoint).with_dial_timeout(Duration::from_secs(1));
        let id = undialable_addr().id.to_string();
        let started = std::time::Instant::now();
        let err = dialer.connected_proxy_port(&id).await.expect_err("nobody is listening");
        assert!(err.contains("could not reach that machine"), "{err}");
        assert!(started.elapsed() < Duration::from_secs(5), "dial must be bounded, took {:?}", started.elapsed());
    }

    /// A proxy that cannot open a stream must say so with a 502 carrying the
    /// tunnel marker: `PeerClient::call` retries only on that proof that no
    /// request byte went anywhere, and a bare close would be indistinguishable
    /// from a peer that read the request and died.
    #[tokio::test]
    async fn a_failed_dial_answers_a_marked_502_not_a_bare_close() {
        let dial_endpoint = Endpoint::builder(presets::Minimal).bind().await.expect("dial bind");
        let dialer = IrohDialer::with_endpoint(dial_endpoint).with_dial_timeout(Duration::from_secs(1));
        let port = dialer.proxy_port_for_addr(undialable_addr()).await.expect("proxy port");
        let resp = fresh_connection_client()
            .get(format!("http://127.0.0.1:{port}/api/health"))
            .send()
            .await
            .expect("a response, not a reset");
        assert_eq!(resp.status(), reqwest::StatusCode::BAD_GATEWAY);
        assert!(resp.headers().contains_key(TUNNEL_FAILED_HEADER));
        assert!(resp.text().await.unwrap().contains("could not reach that machine"));
    }

    /// Requests queued behind one failing dial take its failure instead of each
    /// sitting out their own timeout against a peer that is down.
    #[tokio::test]
    async fn requests_queued_behind_a_failing_dial_share_its_failure() {
        let dial_endpoint = Endpoint::builder(presets::Minimal).bind().await.expect("dial bind");
        let dialer = IrohDialer::with_endpoint(dial_endpoint).with_dial_timeout(Duration::from_millis(800));
        let port = dialer.proxy_port_for_addr(undialable_addr()).await.expect("proxy port");
        let client = fresh_connection_client();
        let started = std::time::Instant::now();
        let all = futures_util::future::join_all((0..4).map(|_| health_status(&client, port))).await;
        assert!(all.iter().all(|s| *s == reqwest::StatusCode::BAD_GATEWAY), "{all:?}");
        assert_eq!(only_link(&dialer).dials.load(Ordering::SeqCst), 1, "one dial for all four callers");
        assert!(started.elapsed() < Duration::from_secs(3), "took {:?}", started.elapsed());
    }

    /// Manual reachability probe over the REAL n0 relay + DNS discovery, which
    /// the offline tests above never touch: dials `CC_DIAL_IROH_ID` from a fresh
    /// dialer and GETs its `/api/health`. Run with
    /// `CC_DIAL_IROH_ID=<id> cargo test --lib live_dial_health_probe -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore]
    async fn live_dial_health_probe() {
        let Ok(id) = std::env::var("CC_DIAL_IROH_ID") else {
            eprintln!("CC_DIAL_IROH_ID not set; nothing to probe");
            return;
        };
        let dialer = IrohDialer::new().await.expect("dialer bind");
        let port = dialer.connected_proxy_port(&id).await.expect("proxy port");
        let started = std::time::Instant::now();
        let health = super::super::peer_client::PeerClient::new(&format!("http://127.0.0.1:{port}"), "")
            .health()
            .await;
        eprintln!("live_dial {id}: {:?} after {:?}", health, started.elapsed());
        assert!(health.is_ok(), "could not reach {id} over iroh");
    }
}
