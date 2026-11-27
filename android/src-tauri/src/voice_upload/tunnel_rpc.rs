//! `Rpc` over the shared iroh tunnel: one bi-stream per call, carrying one HTTP
//! POST to the daemon's `/api/rpc`. The call goes through `Tunnel::open_stream`,
//! so it shares the page's connection (and its redial and sleep handling) instead
//! of opening a second path to the PC.

use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};

use super::engine::{Auth, BoxFut, Rpc, RpcFailure, Source};
use super::http::{post_json, HttpError};
use crate::iroh_tunnel::Tunnel;
use crate::quiet_watch::StreamGauge;

/// The whole call, request out to answer in. A chunk is at most 256 KiB, so even
/// at 16 KB/s it finishes well inside this; a call that takes longer is a dead
/// path, and giving up frees the connection's watchdog to judge it.
const CALL_TIMEOUT: Duration = Duration::from_secs(45);

/// The running tunnel and the port its page is served on (the token's origin).
pub(crate) type Lookup = Arc<dyn Fn() -> BoxFut<'static, Option<(u16, Arc<Tunnel>)>> + Send + Sync>;

pub(crate) struct TunnelRpc {
    lookup: Lookup,
    source: Arc<dyn Source>,
}

impl TunnelRpc {
    pub fn new(lookup: Lookup, source: Arc<dyn Source>) -> Self {
        Self { lookup, source }
    }

    async fn call_inner(&self, method: &str, params: Value) -> Result<Value, RpcFailure> {
        let Some((port, tunnel)) = (self.lookup)().await else {
            return Err(RpcFailure::Offline("no tunnel to a PC yet".into()));
        };
        let auth = match self.source.auth().await {
            Ok(Some(a)) => a,
            Ok(None) => return Err(RpcFailure::Unauthorized),
            Err(e) => return Err(RpcFailure::Offline(format!("cannot read the login: {e}"))),
        };
        if !token_fits(&auth, port) {
            // The token belongs to another PC's origin; never send it here.
            return Err(RpcFailure::Unauthorized);
        }
        let body = json!({ "method": method, "params": params }).to_string();
        let work = async {
            let (mut send, mut recv) = tunnel.open_stream().await.map_err(|e| RpcFailure::Offline(e.to_string()))?;
            // Counted like a page request: the watchdog only judges a connection
            // someone is waiting on, and this call is waiting on it.
            let _open = StreamGauge::new(&tunnel.open_streams);
            post_json(&mut send, &mut recv, "/api/rpc", &auth.token, body.as_bytes())
                .await
                .map_err(|e| match e {
                    HttpError::Io(m) => RpcFailure::Offline(m),
                    HttpError::Malformed(m) => RpcFailure::Offline(format!("bad reply: {m}")),
                })
        };
        let reply = match tokio::time::timeout(CALL_TIMEOUT, work).await {
            Ok(r) => r?,
            Err(_) => return Err(RpcFailure::Offline("the PC did not answer in time".into())),
        };
        interpret(reply.status, &reply.body)
    }
}

/// A token is only sent to the origin it was captured on.
pub(crate) fn token_fits(auth: &Auth, port: u16) -> bool {
    auth.port == port && !auth.token.is_empty()
}

/// The daemon's answer as the uploader needs it: a result, or why not.
pub(crate) fn interpret(status: u16, body: &[u8]) -> Result<Value, RpcFailure> {
    match status {
        200 => serde_json::from_slice(body).map_err(|e| RpcFailure::Server(format!("unreadable result: {e}"))),
        401 => Err(RpcFailure::Unauthorized),
        // Remote access is switched off (or the PC is shedding load): later.
        503 => Err(RpcFailure::Offline("the PC is not accepting phones right now".into())),
        // An older PC without the method refuses it as not allowed remotely.
        403 => Err(RpcFailure::Server("this PC's Conductor does not take voice uploads yet".into())),
        _ => {
            let err: Value = serde_json::from_slice(body).unwrap_or(Value::Null);
            let message = err["message"].as_str().unwrap_or("").to_string();
            match err["code"].as_i64() {
                // invalid params: this recording will never be accepted as sent.
                Some(-32602) => Err(RpcFailure::Rejected(message)),
                // invalid request (the PC saw no device for this login): not the recording's
                // fault, so it is retried later instead of failed for good.
                Some(-32600) => Err(RpcFailure::Server(format!("the PC refused the request: {message}"))),
                // method not found: an older PC.
                Some(-32601) => Err(RpcFailure::Server("this PC's Conductor does not take voice uploads yet".into())),
                _ => Err(RpcFailure::Server(format!("the PC answered {status}: {message}"))),
            }
        }
    }
}

impl Rpc for TunnelRpc {
    fn call(&self, method: &str, params: Value) -> BoxFut<'_, Result<Value, RpcFailure>> {
        let method = method.to_string();
        Box::pin(async move { self.call_inner(&method, params).await })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::*;
    use iroh::endpoint::presets;
    use iroh::Endpoint;

    /// A stand-in login; it only has to be recognisable in the request the fake PC saw.
    const FAKE_LOGIN: &str = "login-for-the-test";
    use std::sync::Mutex;
    struct FixedAuth(Option<Auth>);

    impl Source for FixedAuth {
        fn claim(&self) -> BoxFut<'_, Result<Vec<super::super::engine::Job>, String>> {
            Box::pin(async { Ok(vec![]) })
        }
        fn mark(&self, _: &str, _: super::super::engine::Mark) -> BoxFut<'_, Result<(), String>> {
            Box::pin(async { Ok(()) })
        }
        fn auth(&self) -> BoxFut<'_, Result<Option<Auth>, String>> {
            let a = self.0.clone();
            Box::pin(async move { Ok(a) })
        }
    }

    #[test]
    fn a_token_only_fits_the_origin_it_came_from() {
        let auth = Auth { port: 40_001, token: "t".into() };
        assert!(token_fits(&auth, 40_001));
        assert!(!token_fits(&auth, 40_002));
        assert!(!token_fits(&Auth { port: 1, token: String::new() }, 1));
    }

    #[test]
    fn the_daemons_answers_map_to_retry_or_reject() {
        assert_eq!(interpret(200, br#"{"status":"complete"}"#).unwrap()["status"], "complete");
        assert_eq!(interpret(401, b"").unwrap_err(), RpcFailure::Unauthorized);
        assert!(matches!(interpret(503, b""), Err(RpcFailure::Offline(_))));
        assert!(matches!(interpret(403, b"method not allowed remotely: x"), Err(RpcFailure::Server(_))));
        let bad = br#"{"code":-32602,"message":"sha256 must be 64 lowercase hex characters"}"#;
        assert_eq!(interpret(500, bad).unwrap_err(), RpcFailure::Rejected("sha256 must be 64 lowercase hex characters".into()));
        // No device behind the login is the PC's state, not the recording's: retried, never failed.
        assert!(matches!(interpret(500, br#"{"code":-32600,"message":"no device"}"#), Err(RpcFailure::Server(_))));
        assert!(matches!(interpret(500, br#"{"code":-32601,"message":"method not found"}"#), Err(RpcFailure::Server(_))));
        assert!(matches!(interpret(500, br#"{"code":-32603,"message":"disk full"}"#), Err(RpcFailure::Server(_))));
        assert!(matches!(interpret(502, b"<html>"), Err(RpcFailure::Server(_))));
    }

    /// A PC end that answers every request with `reply` and records what it read.
    async fn http_server(reply: &'static str, seen: Arc<Mutex<Vec<String>>>) -> iroh::EndpointAddr {
        let server = Endpoint::builder(presets::Minimal).alpns(vec![crate::iroh_tunnel::ALPN.to_vec()]).bind().await.expect("bind");
        let addr = server.addr();
        tokio::spawn(async move {
            while let Some(incoming) = server.accept().await {
                let seen = seen.clone();
                tokio::spawn(async move {
                    let Ok(conn) = incoming.await else { return };
                    while let Ok((mut send, mut recv)) = conn.accept_bi().await {
                        let seen = seen.clone();
                        tokio::spawn(async move {
                            let mut got = Vec::new();
                            let mut buf = [0u8; 4096];
                            loop {
                                let n = tokio::io::AsyncReadExt::read(&mut recv, &mut buf).await.unwrap_or(0);
                                if n == 0 {
                                    break;
                                }
                                got.extend_from_slice(&buf[..n]);
                                if got.windows(4).any(|w| w == b"\r\n\r\n") && got.ends_with(b"}") {
                                    break;
                                }
                            }
                            seen.lock().unwrap().push(String::from_utf8_lossy(&got).into_owned());
                            send.write_all(reply.as_bytes()).await.expect("write");
                            send.finish().expect("finish");
                            tokio::time::sleep(Duration::from_secs(1)).await;
                        });
                    }
                });
            }
        });
        addr
    }

    fn lookup(tunnel: Arc<Tunnel>, port: u16) -> Lookup {
        Arc::new(move || {
            let t = tunnel.clone();
            Box::pin(async move { Some((port, t)) })
        })
    }

    #[tokio::test]
    async fn a_call_rides_a_tunnel_stream_as_a_bearer_authed_rpc_post() {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let addr = http_server("HTTP/1.1 200 OK\r\nContent-Length: 21\r\n\r\n{\"status\":\"complete\"}", seen.clone()).await;
        let (tunnel, port) = tunnel_to(addr).await;
        let rpc = TunnelRpc::new(lookup(tunnel.clone(), port), Arc::new(FixedAuth(Some(Auth { port, token: FAKE_LOGIN.into() }))));
        let out = rpc.call("voice_upload_begin", json!({"recording_id": "r1"})).await.unwrap();
        assert_eq!(out["status"], "complete");
        let got = seen.lock().unwrap().clone();
        assert_eq!(got.len(), 1);
        assert!(got[0].starts_with("POST /api/rpc HTTP/1.1\r\n"), "{}", got[0]);
        assert!(got[0].contains(&format!("Authorization: Bearer {FAKE_LOGIN}\r\n")));
        assert!(got[0].contains("\"method\":\"voice_upload_begin\""));
        assert_eq!(tunnel.open_streams.load(std::sync::atomic::Ordering::SeqCst), 0, "the call's stream count is released");
    }

    #[tokio::test]
    async fn a_token_for_another_origin_is_never_sent() {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let addr = http_server("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}", seen.clone()).await;
        let (tunnel, port) = tunnel_to(addr).await;
        let rpc = TunnelRpc::new(lookup(tunnel, port), Arc::new(FixedAuth(Some(Auth { port: port.wrapping_add(1), token: FAKE_LOGIN.into() }))));
        assert_eq!(rpc.call("voice_upload_begin", json!({})).await.unwrap_err(), RpcFailure::Unauthorized);
        assert!(seen.lock().unwrap().is_empty(), "nothing reached the PC");
    }

    #[tokio::test]
    async fn no_login_and_no_tunnel_are_distinct_waits() {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let addr = http_server("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}", seen).await;
        let (tunnel, port) = tunnel_to(addr).await;
        let no_login = TunnelRpc::new(lookup(tunnel, port), Arc::new(FixedAuth(None)));
        assert_eq!(no_login.call("m", json!({})).await.unwrap_err(), RpcFailure::Unauthorized);
        let no_tunnel: Lookup = Arc::new(|| Box::pin(async { None }));
        let rpc = TunnelRpc::new(no_tunnel, Arc::new(FixedAuth(None)));
        assert!(matches!(rpc.call("m", json!({})).await, Err(RpcFailure::Offline(_))));
    }
}
