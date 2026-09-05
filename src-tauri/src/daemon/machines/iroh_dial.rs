//! Dials a paired peer's iroh endpoint and exposes it as a local loopback TCP
//! proxy port, so every existing peer-client codepath (which only knows how
//! to speak `http://host:port`) can reach an iroh-only peer unchanged.
//! Inverts `daemon::iroh_tunnel`'s accept side the same way
//! `android/src-tauri/src/iroh_tunnel.rs` does for the phone: one loopback
//! `TcpListener` per remote id, each accepted connection spliced onto a fresh
//! QUIC bi-stream.

use std::collections::HashMap;
use std::sync::Mutex;

use iroh::endpoint::presets;
use iroh::{Endpoint, EndpointAddr, EndpointId};
use tokio::net::{TcpListener, TcpStream};

use super::super::iroh_tunnel::ALPN;

pub struct IrohDialer {
    endpoint: Endpoint,
    /// One loopback proxy port per iroh id dialed so far - `proxy_port` reuses
    /// an existing entry instead of binding a second listener (and leaking its
    /// accept loop) for a peer already being proxied.
    proxies: Mutex<HashMap<String, u16>>,
}

impl IrohDialer {
    /// Binds an ephemeral-key endpoint on the production preset (n0 relay +
    /// address lookup, since a bare iroh id carries no direct addresses).
    pub async fn new() -> Result<Self, String> {
        let endpoint = Endpoint::builder(presets::N0)
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
        Self { endpoint, proxies: Mutex::new(HashMap::new()) }
    }

    #[cfg(not(test))]
    fn with_endpoint(endpoint: Endpoint) -> Self {
        Self { endpoint, proxies: Mutex::new(HashMap::new()) }
    }

    /// Idempotent: the first call for a given iroh id binds a fresh
    /// `127.0.0.1:0` listener and spawns its accept loop; every later call
    /// for the same id returns the same port. A bare `EndpointId` (no direct
    /// addrs) means `connect` falls back to the endpoint's address lookup
    /// service, matching the android dialer's own bare-id ticket.
    pub async fn proxy_port(&self, iroh_id: &str) -> Result<u16, String> {
        let remote: EndpointId = iroh_id.parse().map_err(|e| format!("bad iroh id: {e}"))?;
        self.dial_and_proxy(iroh_id, EndpointAddr::from(remote)).await
    }

    /// Test seam: `presets::Minimal` has no discovery, so an offline test
    /// supplies a full `EndpointAddr` (direct addrs included) instead of a
    /// bare id string.
    #[cfg(test)]
    pub async fn proxy_port_for_addr(&self, addr: EndpointAddr) -> Result<u16, String> {
        let key = addr.id.to_string();
        self.dial_and_proxy(&key, addr).await
    }

    async fn dial_and_proxy(&self, key: &str, addr: EndpointAddr) -> Result<u16, String> {
        if let Some(port) = self.proxies.lock().unwrap_or_else(|e| e.into_inner()).get(key) {
            return Ok(*port);
        }
        let listener =
            TcpListener::bind(("127.0.0.1", 0)).await.map_err(|e| format!("proxy bind failed: {e}"))?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        // Two concurrent first-callers for the same id could each reach this
        // point; keep whichever wins the map insert below and let the loser's
        // freshly-bound listener just sit unaccepted (nobody will ever dial
        // its port, since `proxy_port` only ever hands out the winner's).
        let mut guard = self.proxies.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(existing) = guard.get(key) {
            return Ok(*existing);
        }
        guard.insert(key.to_string(), port);
        drop(guard);
        let endpoint = self.endpoint.clone();
        tokio::spawn(accept_loop(listener, endpoint, addr));
        Ok(port)
    }
}

async fn accept_loop(listener: TcpListener, endpoint: Endpoint, remote: EndpointAddr) {
    loop {
        match listener.accept().await {
            Ok((tcp, _)) => {
                let endpoint = endpoint.clone();
                let remote = remote.clone();
                tokio::spawn(async move {
                    if let Err(e) = forward(tcp, endpoint, remote).await {
                        log::debug!("iroh dialer: proxied connection ended: {e}");
                    }
                });
            }
            Err(e) => {
                log::warn!("iroh dialer: proxy accept failed: {e}");
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            }
        }
    }
}

/// Splice one accepted local TCP connection onto a fresh QUIC bi-stream -
/// inverse of `iroh_tunnel::forward`, matching
/// `android/src-tauri/src/iroh_tunnel.rs::forward`.
async fn forward(tcp: TcpStream, endpoint: Endpoint, remote: EndpointAddr) -> std::io::Result<()> {
    let conn = endpoint
        .connect(remote, ALPN)
        .await
        .map_err(|e| std::io::Error::other(e.to_string()))?;
    let (mut send, mut recv) = conn.open_bi().await.map_err(|e| std::io::Error::other(e.to_string()))?;
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
    use axum::{routing::get, Json, Router};
    use tokio::net::{TcpListener as TokioTcpListener, TcpStream as TokioTcpStream};

    /// Copies `iroh_tunnel::accept_loop`/`forward`'s splice (desktop's own
    /// ACCEPT side, which is private to that module) but targets an
    /// arbitrary local port instead of `resolve_port()`'s fixed 27183, so the
    /// test can point it at a throwaway axum server.
    async fn accept_and_splice_to(endpoint: Endpoint, target_port: u16) {
        while let Some(incoming) = endpoint.accept().await {
            tokio::spawn(async move {
                let Ok(conn) = incoming.await else { return };
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
}
