//! HTTP client for one paired peer daemon's remote-access API. Mirrors
//! `remote_handlers::rpc_dispatch`'s shapes: a raw JSON value on success, a
//! bare `RpcError` body on a 500, and no JSON worth parsing on 401/403 (the
//! FORBIDDEN branch's body is plain text).

use std::time::Duration;

use serde_json::Value;

use crate::daemon::state::DaemonState;

use super::registry::PeerMachine;

const TIMEOUT: Duration = Duration::from_secs(10);

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
        .no_proxy()
        .build()
        .map_err(|e| PeerError::Protocol(e.to_string()))
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
            http: build_http().unwrap_or_else(|_| reqwest::Client::new()),
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
    /// (`code`/`message`/`data`), and 401/403 are checked BEFORE any JSON
    /// parse since the 403 branch's body is plain text, not JSON.
    pub async fn call(&self, method: &str, params: Value) -> Result<Value, PeerError> {
        let url = format!("{}/api/rpc", self.base_url);
        let body = serde_json::json!({ "method": method, "params": params });
        let resp = self
            .http
            .post(&url)
            .bearer_auth(&self.token)
            .json(&body)
            .send()
            .await
            .map_err(|e| PeerError::Unreachable(e.to_string()))?;
        let status = resp.status();
        if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
            return Err(PeerError::Unauthorized);
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

/// How to physically reach `peer`: `direct_url` if set (same-LAN/Tailscale
/// pairing); else, if an `iroh_id` is known, dial it and proxy through a
/// loopback port (`state.iroh_dialer`); else there's no way to reach it at all.
pub async fn reach_url(state: &DaemonState, peer: &PeerMachine) -> Result<String, PeerError> {
    if let Some(direct) = &peer.direct_url {
        return Ok(direct.clone());
    }
    let Some(iroh_id) = &peer.iroh_id else {
        return Err(PeerError::Unreachable("no direct URL and no iroh id".to_string()));
    };
    let dialer = state.iroh_dialer().await.map_err(PeerError::Unreachable)?;
    let port = dialer.proxy_port(iroh_id).await.map_err(PeerError::Unreachable)?;
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

    async fn spawn_rpc_server() -> (String, tokio::task::JoinHandle<()>) {
        let app = Router::new().route(
            "/api/rpc",
            post(|headers: axum::http::HeaderMap, Json(body): Json<Value>| async move {
                let auth = headers.get(AUTHORIZATION).and_then(|v| v.to_str().ok()).unwrap_or("");
                if auth != "Bearer good-token" {
                    return StatusCode::UNAUTHORIZED.into_response();
                }
                match body.get("method").and_then(Value::as_str).unwrap_or("") {
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

    /// `presets::Minimal`, no discovery: proves `reach_url`'s iroh-only
    /// branch resolves to a loopback proxy url without ever needing a real
    /// (network-touching) `presets::N0` bind.
    #[tokio::test]
    async fn reach_url_iroh_only_yields_a_loopback_url() {
        let state = state_fixture();
        let dial_endpoint =
            iroh::Endpoint::builder(iroh::endpoint::presets::Minimal).bind().await.expect("dial bind");
        state.set_iroh_dialer_for_test(std::sync::Arc::new(
            crate::daemon::machines::IrohDialer::with_endpoint(dial_endpoint),
        ));
        let fake_id = iroh::SecretKey::generate().public().to_string();
        let peer = peer_with(Some(&fake_id), None);
        let url = reach_url(&state, &peer).await.expect("iroh-only path must yield a loopback url");
        assert!(url.starts_with("http://127.0.0.1:"), "got {url}");
    }
}
