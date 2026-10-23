//! HTTP client for one paired peer daemon's remote-access API. Mirrors
//! `remote_handlers::rpc_dispatch`'s shapes: a raw JSON value on success, a
//! bare `RpcError` body on a 500, and no JSON worth parsing on 401/403 (the
//! FORBIDDEN branch's body is plain text).

use std::time::Duration;

use serde_json::Value;

use crate::daemon::state::DaemonState;

use super::registry::PeerMachine;

/// Ceiling for one request once the path to the peer is up. The cold iroh dial
/// is NOT inside this: `reach_url` completes it first
/// (`IrohDialer::connected_proxy_port`, bounded by `iroh_dial::DIAL_TIMEOUT`),
/// because the dial runs inside the loopback proxy after reqwest's TCP connect
/// and would otherwise be charged to the request, which is how a first call
/// after idle used to die at 10s.
const TIMEOUT: Duration = Duration::from_secs(10);

/// A pooled loopback socket holds one QUIC stream open. Kept below
/// `iroh_tunnel::QUIC_IDLE_TIMEOUT` so reqwest drops an idle socket before the
/// tunnel behind it can die, instead of reusing one whose stream is gone.
const POOL_IDLE_TIMEOUT: Duration = Duration::from_secs(20);

/// Pause before the single retry of a call that provably never reached the peer.
const RETRY_PAUSE: Duration = Duration::from_millis(250);

/// Header the loopback iroh proxy puts on the 502 it answers when it could not
/// open a stream to the peer (`iroh_dial`). The proxy generates that response
/// itself before forwarding a single request byte, so seeing it proves the
/// request never reached the peer.
pub(super) const TUNNEL_FAILED_HEADER: &str = "x-conductor-tunnel-failed";

/// JSON-RPC "method not found": the closest standard code for a peer that
/// refuses a method for this transport.
const METHOD_REFUSED: i64 = -32601;

#[derive(Debug)]
pub enum PeerError {
    Unreachable(String),
    Unauthorized,
    Rejected { code: i64, message: String },
    Protocol(String),
}

impl std::fmt::Display for PeerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PeerError::Unreachable(msg) => write!(f, "peer unreachable: {msg}"),
            PeerError::Unauthorized => write!(f, "peer rejected our token"),
            PeerError::Rejected { code, message } => write!(f, "peer refused ({code}): {message}"),
            PeerError::Protocol(msg) => write!(f, "peer protocol error: {msg}"),
        }
    }
}

impl std::error::Error for PeerError {}

fn build_http() -> Result<reqwest::Client, PeerError> {
    reqwest::Client::builder()
        .timeout(TIMEOUT)
        .pool_idle_timeout(POOL_IDLE_TIMEOUT)
        .no_proxy()
        .build()
        .map_err(|e| PeerError::Protocol(e.to_string()))
}

/// One process-wide client so repeated calls to a peer reuse a pooled
/// connection. `client_for` makes a new `PeerClient` per call, and over iroh
/// each fresh TCP connection to the loopback proxy costs a new QUIC handshake.
/// The pool is keyed by host:port, so peers never share a connection.
fn shared_http() -> &'static reqwest::Client {
    static HTTP: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    HTTP.get_or_init(|| build_http().unwrap_or_else(|_| reqwest::Client::new()))
}

pub struct PeerClient {
    base_url: String,
    token: String,
    http: reqwest::Client,
}

impl PeerClient {
    /// `token` is a bearer for `/api/rpc` only - `/api/health` is public and
    /// ignores it, so an empty token is fine for a health-only probe.
    pub fn new(base_url: &str, token: &str) -> Self {
        Self {
            base_url: base_url.trim_end_matches('/').to_string(),
            token: token.to_string(),
            http: shared_http().clone(),
        }
    }

    pub async fn health(&self) -> Result<Value, PeerError> {
        let url = format!("{}/api/health", self.base_url);
        let resp = self.http.get(&url).send().await.map_err(|e| PeerError::Unreachable(e.to_string()))?;
        if !resp.status().is_success() {
            return Err(PeerError::Protocol(format!("health returned {}", resp.status())));
        }
        resp.json::<Value>().await.map_err(|e| PeerError::Protocol(e.to_string()))
    }

    /// POST `/api/rpc {method, params}`. Mirrors `rpc_dispatch`: success is
    /// the raw result value (no wrapper), a 500 body is an `RpcError`
    /// (`code`/`message`/`data`), and 401/403/503 are checked BEFORE any
    /// JSON parse since those bodies are plain text or empty, not JSON.
    ///
    /// Retried once, and only when `call_once` proves the request never
    /// reached the peer: the calls routed through here include
    /// `send_message`, `start_session` and `spawn_chat`, which must never be
    /// delivered twice.
    pub async fn call(&self, method: &str, params: Value) -> Result<Value, PeerError> {
        match self.call_once(method, &params).await {
            Attempt::Answered(result) => result,
            Attempt::NotSent(first) => {
                log::debug!("peer_client: {method} not sent ({first}); retrying once");
                tokio::time::sleep(RETRY_PAUSE).await;
                match self.call_once(method, &params).await {
                    Attempt::Answered(result) => result,
                    Attempt::NotSent(second) => Err(second),
                }
            }
        }
    }

    async fn call_once(&self, method: &str, params: &Value) -> Attempt {
        let url = format!("{}/api/rpc", self.base_url);
        let body = serde_json::json!({ "method": method, "params": params });
        let resp = match self.http.post(&url).bearer_auth(&self.token).json(&body).send().await {
            Ok(resp) => resp,
            // `is_connect()` is true only for a failure inside reqwest's
            // connector (TCP connect refused or unreachable): no connection
            // existed, so no request byte was written. Every other send error
            // is deliberately NOT retried - a timeout, a reset, or hyper's
            // "connection closed before message completed" can all fire after
            // the peer already read (and acted on) the request, and reqwest
            // gives no way to tell those apart from the case where it did not.
            Err(e) if e.is_connect() => return Attempt::NotSent(PeerError::Unreachable(e.to_string())),
            Err(e) => return Attempt::Answered(Err(PeerError::Unreachable(e.to_string()))),
        };
        let status = resp.status();
        if status == reqwest::StatusCode::BAD_GATEWAY && resp.headers().contains_key(TUNNEL_FAILED_HEADER) {
            let why = resp.text().await.unwrap_or_default();
            return Attempt::NotSent(PeerError::Unreachable(format!("tunnel to that machine failed: {why}")));
        }
        Attempt::Answered(Self::read_reply(method, status, resp).await)
    }

    async fn read_reply(
        method: &str,
        status: reqwest::StatusCode,
        resp: reqwest::Response,
    ) -> Result<Value, PeerError> {
        if status == reqwest::StatusCode::UNAUTHORIZED {
            return Err(PeerError::Unauthorized);
        }
        // 403 is the peer refusing this METHOD for a paired machine (its
        // transport table), not our token: calling it "re-pair required" sent
        // the reader chasing a pairing that was fine.
        if status == reqwest::StatusCode::FORBIDDEN {
            let why = resp.text().await.unwrap_or_default();
            return Err(PeerError::Rejected {
                code: METHOD_REFUSED,
                message: format!("that machine does not accept `{method}` from a paired machine{}", if why.is_empty() { String::new() } else { format!(": {why}") }),
            });
        }
        // The peer's remote-access switch is off; its body is empty, not JSON.
        if status == reqwest::StatusCode::SERVICE_UNAVAILABLE {
            return Err(PeerError::Unreachable("remote access is switched off on that machine".into()));
        }
        let value: Value = resp.json().await.map_err(|e| PeerError::Protocol(e.to_string()))?;
        if !status.is_success() {
            let code = value.get("code").and_then(Value::as_i64).unwrap_or(0);
            let message = value
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("peer rpc error")
                .to_string();
            return Err(PeerError::Rejected { code, message });
        }
        Ok(value)
    }
}

/// Outcome of one POST: `NotSent` is the only state `call` may retry.
enum Attempt {
    Answered(Result<Value, PeerError>),
    NotSent(PeerError),
}

/// One-shot, unauthenticated POST to a peer's public `/api/pair` - the
/// outbound half of the pairing handshake, before any bearer token exists.
/// Reads the body as text first since a rejected pairing code returns a
/// plain string, not JSON (see `remote_pairing::pair_device`).
pub async fn post_pairing_request(base_url: &str, body: Value) -> Result<Value, PeerError> {
    let http = build_http()?;
    let url = format!("{}/api/pair", base_url.trim_end_matches('/'));
    let resp = http.post(&url).json(&body).send().await.map_err(|e| PeerError::Unreachable(e.to_string()))?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| PeerError::Protocol(e.to_string()))?;
    if !status.is_success() {
        return Err(PeerError::Protocol(format!("pair request failed ({status}): {text}")));
    }
    serde_json::from_str(&text).map_err(|e| PeerError::Protocol(format!("invalid pair response: {e}")))
}

/// How to physically reach `peer`: `direct_url` if set (a hand-given address
/// at pairing); else, if an `iroh_id` is known, dial it and proxy through a
/// loopback port (`state.iroh_dialer`); else there's no way to reach it at all.
pub async fn reach_url(state: &DaemonState, peer: &PeerMachine) -> Result<String, PeerError> {
    if let Some(direct) = &peer.direct_url {
        return Ok(direct.clone());
    }
    let Some(iroh_id) = &peer.iroh_id else {
        return Err(PeerError::Unreachable("no direct URL and no iroh id".to_string()));
    };
    let dialer = state.iroh_dialer().await.map_err(PeerError::Unreachable)?;
    // Returns only once the tunnel is up, so the cold dial is charged here and
    // not to the first request's `TIMEOUT` (or a WebSocket handshake).
    let port = dialer.connected_proxy_port(iroh_id).await.map_err(PeerError::Unreachable)?;
    Ok(format!("http://127.0.0.1:{port}"))
}

pub async fn client_for(state: &DaemonState, peer: &PeerMachine) -> Result<PeerClient, PeerError> {
    let url = reach_url(state, peer).await?;
    Ok(PeerClient::new(&url, &peer.token))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        http::{header::AUTHORIZATION, StatusCode},
        response::IntoResponse,
        routing::post,
        Json, Router,
    };
    use tokio::net::TcpListener;

    #[test]
    fn every_peer_client_shares_one_http_client() {
        assert!(std::ptr::eq(shared_http(), shared_http()));
        // Distinct peers still get a usable client; sharing is by pool, not by peer.
        let _a = PeerClient::new("http://127.0.0.1:1", "a");
        let _b = PeerClient::new("http://127.0.0.1:2", "b");
    }

    async fn spawn_rpc_server() -> (String, tokio::task::JoinHandle<()>) {
        let app = Router::new().route(
            "/api/rpc",
            post(|headers: axum::http::HeaderMap, Json(body): Json<Value>| async move {
                let auth = headers.get(AUTHORIZATION).and_then(|v| v.to_str().ok()).unwrap_or("");
                if auth != "Bearer good-token" {
                    return StatusCode::UNAUTHORIZED.into_response();
                }
                match body.get("method").and_then(Value::as_str).unwrap_or("") {
                    "desktop_only" => (StatusCode::FORBIDDEN, "method not allowed over remote").into_response(),
                    "switched_off" => StatusCode::SERVICE_UNAVAILABLE.into_response(),
                    "boom" => (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        Json(serde_json::json!({"code": -32000, "message": "boom failed", "data": null})),
                    )
                        .into_response(),
                    method => (StatusCode::OK, Json(serde_json::json!({"echoed": method}))).into_response(),
                }
            }),
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let handle = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        (format!("http://{addr}"), handle)
    }

    #[tokio::test]
    async fn call_round_trips_a_result() {
        let (base, handle) = spawn_rpc_server().await;
        let client = PeerClient::new(&base, "good-token");
        let result = client.call("echo", serde_json::json!({})).await.unwrap();
        assert_eq!(result["echoed"], serde_json::json!("echo"));
        handle.abort();
    }

    #[tokio::test]
    async fn call_maps_401_to_unauthorized() {
        let (base, handle) = spawn_rpc_server().await;
        let client = PeerClient::new(&base, "wrong-token");
        let err = client.call("echo", serde_json::json!({})).await.unwrap_err();
        assert!(matches!(err, PeerError::Unauthorized));
        handle.abort();
    }

    #[tokio::test]
    async fn call_maps_403_to_a_method_refusal_not_a_token_problem() {
        let (base, handle) = spawn_rpc_server().await;
        let client = PeerClient::new(&base, "good-token");
        match client.call("desktop_only", serde_json::json!({})).await.unwrap_err() {
            PeerError::Rejected { code, message } => {
                assert_eq!(code, METHOD_REFUSED);
                assert!(message.contains("desktop_only"), "got {message}");
            }
            other => panic!("expected Rejected, got {other:?}"),
        }
        handle.abort();
    }

    #[tokio::test]
    async fn call_maps_503_to_remote_access_switched_off() {
        let (base, handle) = spawn_rpc_server().await;
        let client = PeerClient::new(&base, "good-token");
        match client.call("switched_off", serde_json::json!({})).await.unwrap_err() {
            PeerError::Unreachable(msg) => assert!(msg.contains("switched off"), "got {msg}"),
            other => panic!("expected Unreachable, got {other:?}"),
        }
        handle.abort();
    }

    #[tokio::test]
    async fn call_maps_rpc_error_body_to_rejected() {
        let (base, handle) = spawn_rpc_server().await;
        let client = PeerClient::new(&base, "good-token");
        let err = client.call("boom", serde_json::json!({})).await.unwrap_err();
        match err {
            PeerError::Rejected { code, message } => {
                assert_eq!(code, -32000);
                assert_eq!(message, "boom failed");
            }
            other => panic!("expected Rejected, got {other:?}"),
        }
        handle.abort();
    }

    /// Scripted peer on a raw TCP listener, one closure per accepted
    /// connection, so a test controls exactly what the client sees and whether
    /// the request was read before the connection ended.
    mod scripted {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio::net::{TcpListener, TcpStream};

        #[derive(Default)]
        pub struct Seen {
            pub connections: AtomicUsize,
            pub requests_read: AtomicUsize,
        }

        /// Reads one HTTP request (headers plus a content-length body) and counts it.
        pub async fn read_request(sock: &mut TcpStream, seen: &Seen) {
            let mut buf = Vec::new();
            let mut chunk = [0u8; 1024];
            loop {
                let n = sock.read(&mut chunk).await.unwrap_or(0);
                if n == 0 {
                    return;
                }
                buf.extend_from_slice(&chunk[..n]);
                let Some(head_end) = buf.windows(4).position(|w| w == b"\r\n\r\n") else { continue };
                let head = String::from_utf8_lossy(&buf[..head_end]).to_ascii_lowercase();
                let len = head
                    .lines()
                    .find_map(|l| l.strip_prefix("content-length:"))
                    .and_then(|v| v.trim().parse::<usize>().ok())
                    .unwrap_or(0);
                if buf.len() >= head_end + 4 + len {
                    seen.requests_read.fetch_add(1, Ordering::SeqCst);
                    return;
                }
            }
        }

        pub async fn reply(sock: &mut TcpStream, status: &str, extra_header: &str, body: &str) {
            let head = format!(
                "HTTP/1.1 {status}\r\n{extra_header}content-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                body.len()
            );
            let _ = sock.write_all(head.as_bytes()).await;
            let _ = sock.write_all(body.as_bytes()).await;
            let _ = sock.shutdown().await;
            // Answering without having read the request and then closing would
            // reset the connection and the client would never see the response;
            // the real proxy drains the same way (`iroh_dial::reply_tunnel_failed`).
            let mut rest = Vec::new();
            let _ = tokio::time::timeout(std::time::Duration::from_secs(1), sock.read_to_end(&mut rest)).await;
        }

        /// `script(n, socket, seen)` runs for the n-th accepted connection (0-based).
        pub async fn serve<F, Fut>(script: F) -> (String, Arc<Seen>)
        where
            F: Fn(usize, TcpStream, Arc<Seen>) -> Fut + Send + Sync + 'static,
            Fut: std::future::Future<Output = ()> + Send + 'static,
        {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let base = format!("http://{}", listener.local_addr().unwrap());
            let seen = Arc::new(Seen::default());
            let seen_loop = seen.clone();
            tokio::spawn(async move {
                while let Ok((sock, _)) = listener.accept().await {
                    let n = seen_loop.connections.fetch_add(1, Ordering::SeqCst);
                    tokio::spawn(script(n, sock, seen_loop.clone()));
                }
            });
            (base, seen)
        }
    }

    /// The iroh proxy's own 502 proves nothing was forwarded, so the call is
    /// resent once, and the peer sees the request exactly once.
    #[tokio::test]
    async fn call_retries_once_after_a_tunnel_failed_502() {
        let (base, seen) = scripted::serve(|n, mut sock, seen| async move {
            if n == 0 {
                scripted::reply(&mut sock, "502 Bad Gateway", &format!("{TUNNEL_FAILED_HEADER}: 1\r\n"), "dial timed out").await;
            } else {
                scripted::read_request(&mut sock, &seen).await;
                scripted::reply(&mut sock, "200 OK", "", r#"{"echoed":"send_message"}"#).await;
            }
        })
        .await;
        let result = PeerClient::new(&base, "t").call("send_message", serde_json::json!({})).await.unwrap();
        assert_eq!(result["echoed"], "send_message");
        assert_eq!(seen.requests_read.load(std::sync::atomic::Ordering::SeqCst), 1, "delivered exactly once");
    }

    /// A tunnel 502 on both attempts is reported, not looped.
    #[tokio::test]
    async fn call_gives_up_after_the_single_retry() {
        let (base, seen) = scripted::serve(|_n, mut sock, _seen| async move {
            scripted::reply(&mut sock, "502 Bad Gateway", &format!("{TUNNEL_FAILED_HEADER}: 1\r\n"), "still down").await;
        })
        .await;
        match PeerClient::new(&base, "t").call("echo", serde_json::json!({})).await.unwrap_err() {
            PeerError::Unreachable(msg) => assert!(msg.contains("still down"), "{msg}"),
            other => panic!("expected Unreachable, got {other:?}"),
        }
        assert_eq!(seen.connections.load(std::sync::atomic::Ordering::SeqCst), 2, "first try plus one retry");
    }

    /// A plain 502 (any other gateway) says nothing about whether the request
    /// was forwarded, so it is an answer, never retried.
    #[tokio::test]
    async fn call_does_not_retry_an_unmarked_502() {
        let (base, seen) = scripted::serve(|_n, mut sock, seen| async move {
            scripted::read_request(&mut sock, &seen).await;
            scripted::reply(&mut sock, "502 Bad Gateway", "", r#"{"code":-1,"message":"upstream"}"#).await;
        })
        .await;
        assert!(PeerClient::new(&base, "t").call("send_message", serde_json::json!({})).await.is_err());
        assert_eq!(seen.requests_read.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    /// The peer read the request and then died without answering. It may have
    /// acted on it, so a resend could deliver a message twice: never retried.
    #[tokio::test]
    async fn call_never_retries_a_request_the_peer_already_read() {
        let (base, seen) = scripted::serve(|_n, mut sock, seen| async move {
            scripted::read_request(&mut sock, &seen).await;
            drop(sock);
        })
        .await;
        let err = PeerClient::new(&base, "t").call("send_message", serde_json::json!({"text": "hi"})).await.unwrap_err();
        assert!(matches!(err, PeerError::Unreachable(_)), "{err:?}");
        tokio::time::sleep(RETRY_PAUSE * 3).await;
        assert_eq!(seen.requests_read.load(std::sync::atomic::Ordering::SeqCst), 1, "delivered once, not twice");
        assert_eq!(seen.connections.load(std::sync::atomic::Ordering::SeqCst), 1, "no second connection was opened");
    }

    /// A refused connect wrote nothing, so it is the one reqwest error class
    /// the retry treats as unsent.
    #[tokio::test]
    async fn a_refused_connect_counts_as_not_sent() {
        let closed = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", closed.local_addr().unwrap());
        drop(closed);
        let client = PeerClient::new(&base, "t");
        assert!(matches!(client.call_once("echo", &serde_json::json!({})).await, Attempt::NotSent(_)));
    }

    fn state_fixture() -> std::sync::Arc<DaemonState> {
        DaemonState::new(crate::daemon::session::new_session_map(), crate::daemon::settings_cache::SettingsCache::new(crate::types::Settings::default()))
    }

    fn peer_with(iroh_id: Option<&str>, direct_url: Option<&str>) -> PeerMachine {
        PeerMachine {
            machine_id: "id".into(),
            label: "Mac".into(),
            os: "macos".into(),
            iroh_id: iroh_id.map(str::to_string),
            direct_url: direct_url.map(str::to_string),
            token: "tok".into(),
            reverse_device_id: None,
            added_at: 0,
        }
    }

    #[tokio::test]
    async fn reach_url_errs_with_neither_direct_url_nor_iroh_id() {
        let state = state_fixture();
        let peer = peer_with(None, None);
        assert!(matches!(reach_url(&state, &peer).await, Err(PeerError::Unreachable(_))));
    }

    #[tokio::test]
    async fn reach_url_prefers_direct_url_over_iroh() {
        let state = state_fixture();
        let peer = peer_with(Some("deadbeef"), Some("http://127.0.0.1:9999"));
        // direct_url must win without ever touching the iroh dialer (which
        // would hang trying to resolve a fake id if this fell through).
        let url = reach_url(&state, &peer).await.expect("direct_url path must not error");
        assert_eq!(url, "http://127.0.0.1:9999");
    }

    /// `presets::Minimal` + `MemoryLookup`, no discovery server: `reach_url`'s
    /// iroh-only branch hands out a loopback proxy url only once the tunnel to
    /// the peer is up, so the first request on it never pays for the dial.
    #[tokio::test]
    async fn reach_url_iroh_only_yields_a_loopback_url_with_the_tunnel_already_up() {
        use iroh::address_lookup::MemoryLookup;
        use iroh::endpoint::presets::Minimal;

        let accept_endpoint = iroh::Endpoint::builder(Minimal)
            .alpns(vec![crate::daemon::iroh_tunnel::ALPN.to_vec()])
            .bind()
            .await
            .expect("accept bind");
        let accept_addr = accept_endpoint.addr();
        let accepted = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counter = accepted.clone();
        tokio::spawn(async move {
            while let Some(incoming) = accept_endpoint.accept().await {
                counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                tokio::spawn(async move {
                    // Hold the connection open; this test never opens a stream.
                    let Ok(conn) = incoming.await else { return };
                    conn.closed().await;
                });
            }
        });

        let lookup = MemoryLookup::new();
        lookup.add_endpoint_info(accept_addr.clone());
        let dial_endpoint = iroh::Endpoint::builder(Minimal).address_lookup(lookup).bind().await.expect("dial bind");
        let state = state_fixture();
        state.set_iroh_dialer_for_test(std::sync::Arc::new(
            crate::daemon::machines::IrohDialer::with_endpoint(dial_endpoint),
        ));
        let peer = peer_with(Some(&accept_addr.id.to_string()), None);
        let url = reach_url(&state, &peer).await.expect("iroh-only path must yield a loopback url");
        assert!(url.starts_with("http://127.0.0.1:"), "got {url}");
        assert_eq!(accepted.load(std::sync::atomic::Ordering::SeqCst), 1, "the dial finished before the url was returned");
    }

    /// An id nobody answers for is an error from `reach_url` itself, within the
    /// dial bound, instead of a url whose first request then hangs.
    #[tokio::test]
    async fn reach_url_iroh_only_errs_when_the_peer_cannot_be_dialed() {
        let state = state_fixture();
        let dial_endpoint =
            iroh::Endpoint::builder(iroh::endpoint::presets::Minimal).bind().await.expect("dial bind");
        state.set_iroh_dialer_for_test(std::sync::Arc::new(
            crate::daemon::machines::IrohDialer::with_endpoint(dial_endpoint)
                .with_dial_timeout(Duration::from_secs(1)),
        ));
        let fake_id = iroh::SecretKey::generate().public().to_string();
        let peer = peer_with(Some(&fake_id), None);
        match reach_url(&state, &peer).await {
            Err(PeerError::Unreachable(msg)) => assert!(msg.contains("could not reach that machine"), "{msg}"),
            other => panic!("expected Unreachable, got {other:?}"),
        }
    }
}
