//! Loopback proxy that gives a signed-in project MCP server a fresh bearer on
//! every request (todo pc-1784).
//!
//! The chat's `claude` child reads its `--mcp-config` once at start, so a
//! bearer written into the file dies with its access token (1 h for rodge)
//! while the child keeps running. Instead the file names this proxy
//! (`http://127.0.0.1:<hook port>/mcp-proxy/<id>`) with no header at all, and
//! each request is forwarded to the real server with the token that
//! `mcp_oauth::access_token` hands back (refreshed under its single-flight
//! lock when near expiry). The token therefore never reaches the generated
//! config, a log line or a tool result.
//!
//! `<id>` is a random 128-bit value made per URL for this daemon run: the hook
//! server has no per-run secret on purpose (see `hooks_server/origin_guard.rs`),
//! so the id is what stops another local process from borrowing the sign-in,
//! and it can only reach a URL that was written into a config.

use axum::{
    body::{Body, Bytes},
    http::{header, HeaderMap, HeaderName, Method, StatusCode},
    response::{IntoResponse, Response},
};
use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;

/// `(id, upstream MCP url)`. A handful of entries, one per listed server.
static ROUTES: Mutex<Vec<(String, String)>> = Mutex::new(Vec::new());

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// What a request may carry upstream. Everything else, `authorization`
/// included, is dropped: a caller never picks the credential.
const FORWARD_REQUEST: &[&str] = &["accept", "content-type", "mcp-session-id", "mcp-protocol-version", "last-event-id"];
/// What comes back. `www-authenticate` is left out so the CLI never starts its
/// own sign-in against the proxy's address.
const FORWARD_RESPONSE: &[&str] = &["content-type", "mcp-session-id", "mcp-protocol-version", "retry-after"];

/// One pooled client. It follows a redirect only within the same host and port
/// (the probe follows redirects, so a trailing-slash 308 must still work), so the
/// bearer can never be sent to another origin.
fn client() -> Option<&'static reqwest::Client> {
    static CLIENT: std::sync::OnceLock<Option<reqwest::Client>> = std::sync::OnceLock::new();
    CLIENT
        .get_or_init(|| {
            let same_origin = reqwest::redirect::Policy::custom(|attempt| {
                let prev = attempt.previous().last();
                let same = prev.is_some_and(|p| {
                    p.scheme() == attempt.url().scheme()
                        && p.host_str() == attempt.url().host_str()
                        && p.port_or_known_default() == attempt.url().port_or_known_default()
                });
                if same && attempt.previous().len() < 5 {
                    attempt.follow()
                } else {
                    attempt.stop()
                }
            });
            reqwest::Client::builder().connect_timeout(CONNECT_TIMEOUT).redirect(same_origin).build().ok()
        })
        .as_ref()
}

/// The config URL for `upstream`, registering it on first use.
pub(crate) fn proxy_url(hook_port: u16, upstream: &str) -> String {
    let mut routes = ROUTES.lock().unwrap();
    let id = match routes.iter().find(|(_, u)| u == upstream) {
        Some((id, _)) => id.clone(),
        None => {
            let id = uuid::Uuid::new_v4().simple().to_string();
            routes.push((id.clone(), upstream.to_string()));
            id
        }
    };
    format!("http://127.0.0.1:{hook_port}/mcp-proxy/{id}")
}

fn upstream_of(id: &str) -> Option<String> {
    ROUTES.lock().unwrap().iter().find(|(i, _)| i == id).map(|(_, u)| u.clone())
}

fn plain(status: StatusCode, text: &'static str) -> Response {
    (status, text).into_response()
}

/// Forwards one request. `store` is the token file `mcp_oauth` reads.
pub(crate) async fn forward(store: Option<&Path>, id: &str, method: Method, headers: &HeaderMap, body: Bytes) -> Response {
    let Some(upstream) = upstream_of(id) else {
        return plain(StatusCode::NOT_FOUND, "unknown project MCP proxy id");
    };
    let token = match store {
        Some(p) => crate::daemon::mcp_oauth::access_token(p, &upstream).await,
        None => None,
    };
    let Some(token) = token else {
        // Nothing is sent upstream without a credential: the sign-in lapsed.
        return plain(StatusCode::UNAUTHORIZED, "project MCP sign-in expired, sign in again in Settings");
    };
    let client = match client() {
        Some(c) => c,
        None => return plain(StatusCode::BAD_GATEWAY, "proxy client failed"),
    };
    let mut req = client.request(method, &upstream).bearer_auth(token);
    if !body.is_empty() {
        req = req.body(body);
    }
    for name in FORWARD_REQUEST {
        if let Some(v) = headers.get(*name) {
            req = req.header(HeaderName::from_static(name), v);
        }
    }
    let res = match req.send().await {
        Ok(r) => r,
        Err(e) => {
            log::warn!("project mcp proxy: {upstream} unreachable: {}", e.without_url());
            return plain(StatusCode::BAD_GATEWAY, "project MCP server unreachable");
        }
    };
    let mut out = Response::builder().status(res.status());
    for name in FORWARD_RESPONSE {
        if let Some(v) = res.headers().get(*name) {
            out = out.header(HeaderName::from_static(name), v);
        }
    }
    // Chunked on purpose: an MCP reply can be an open event stream.
    let stream = futures_util::stream::unfold(res, |mut r| async move {
        match r.chunk().await {
            Ok(Some(b)) => Some((Ok::<Bytes, std::io::Error>(b), r)),
            Ok(None) => None,
            // A dropped upstream must abort the reply, not read as a clean end.
            Err(e) => Some((Err(std::io::Error::other(e.without_url().to_string())), r)),
        }
    });
    out.header(header::CACHE_CONTROL, "no-cache")
        .body(Body::from_stream(stream))
        .unwrap_or_else(|_| plain(StatusCode::BAD_GATEWAY, "proxy reply failed"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    /// An upstream that records the Authorization of every request and answers 200.
    async fn upstream(seen: Arc<Mutex<Vec<String>>>, hits: Arc<AtomicUsize>) -> String {
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/mcp", l.local_addr().unwrap());
        tokio::spawn(async move {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            loop {
                let (mut c, _) = l.accept().await.unwrap();
                let (seen, hits) = (seen.clone(), hits.clone());
                tokio::spawn(async move {
                    let mut buf = vec![0u8; 8192];
                    let n = c.read(&mut buf).await.unwrap_or(0);
                    let text = String::from_utf8_lossy(&buf[..n]).to_string();
                    let auth = text
                        .lines()
                        .find(|l| l.to_ascii_lowercase().starts_with("authorization:"))
                        .unwrap_or("")
                        .to_string();
                    seen.lock().unwrap().push(auth);
                    hits.fetch_add(1, Ordering::SeqCst);
                    let body = r#"{"ok":true}"#;
                    let _ = c
                        .write_all(format!("HTTP/1.1 200 OK\r\ncontent-type: application/json\r\nmcp-session-id: s1\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len()).as_bytes())
                        .await;
                });
            }
        });
        url
    }

    async fn body_text(r: Response) -> String {
        let b = axum::body::to_bytes(r.into_body(), 1 << 20).await.unwrap();
        String::from_utf8_lossy(&b).to_string()
    }

    #[test]
    fn a_url_keeps_one_id_for_the_run_and_the_config_url_has_no_secret_but_the_id() {
        let a = proxy_url(27182, "http://example.invalid/a");
        assert_eq!(a, proxy_url(27182, "http://example.invalid/a"));
        assert_ne!(a, proxy_url(27182, "http://example.invalid/b"));
        assert!(a.starts_with("http://127.0.0.1:27182/mcp-proxy/") && !a.contains("example.invalid"));
    }

    #[tokio::test]
    async fn every_request_carries_the_token_current_at_that_moment() {
        let (seen, hits) = (Arc::new(Mutex::new(Vec::new())), Arc::new(AtomicUsize::new(0)));
        let url = upstream(seen.clone(), hits).await;
        let dir = tempfile::tempdir().unwrap();
        let store = dir.path().join("mcp-oauth.json");
        let cfg = proxy_url(1, &url);
        let id = cfg.rsplit('/').next().unwrap().to_string();

        crate::daemon::mcp_oauth::seed_for_test(&store, &url, "first");
        let r = forward(Some(&store), &id, Method::POST, &HeaderMap::new(), Bytes::from_static(b"{}")).await;
        assert_eq!(r.status(), 200);
        assert_eq!(r.headers().get("mcp-session-id").unwrap(), "s1");
        assert_eq!(body_text(r).await, r#"{"ok":true}"#);

        // The same chat, later: the stored token changed (a refresh), the config did not.
        crate::daemon::mcp_oauth::seed_for_test(&store, &url, "second");
        forward(Some(&store), &id, Method::POST, &HeaderMap::new(), Bytes::from_static(b"{}")).await;

        let seen = seen.lock().unwrap().clone();
        assert!(seen[0].ends_with("Bearer first"), "{seen:?}");
        assert!(seen[1].ends_with("Bearer second"), "{seen:?}");
    }

    #[tokio::test]
    async fn a_caller_supplied_authorization_is_never_forwarded() {
        let (seen, hits) = (Arc::new(Mutex::new(Vec::new())), Arc::new(AtomicUsize::new(0)));
        let url = upstream(seen.clone(), hits).await;
        let dir = tempfile::tempdir().unwrap();
        let store = dir.path().join("mcp-oauth.json");
        crate::daemon::mcp_oauth::seed_for_test(&store, &url, "real");
        let id = proxy_url(1, &url).rsplit('/').next().unwrap().to_string();
        let mut h = HeaderMap::new();
        h.insert(header::AUTHORIZATION, "Bearer attacker".parse().unwrap());
        forward(Some(&store), &id, Method::POST, &h, Bytes::new()).await;
        let seen = seen.lock().unwrap().clone();
        assert_eq!(seen.len(), 1);
        assert!(seen[0].ends_with("Bearer real") && !seen[0].contains("attacker"), "{seen:?}");
    }

    #[tokio::test]
    async fn a_same_origin_redirect_is_followed_and_keeps_the_token_while_a_cross_origin_one_is_not_followed() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", l.local_addr().unwrap());
        let seen: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let seen2 = seen.clone();
        tokio::spawn(async move {
            loop {
                let (mut c, _) = l.accept().await.unwrap();
                let seen = seen2.clone();
                tokio::spawn(async move {
                    let mut buf = vec![0u8; 8192];
                    let n = c.read(&mut buf).await.unwrap_or(0);
                    let text = String::from_utf8_lossy(&buf[..n]).to_string();
                    let path = text.split_whitespace().nth(1).unwrap_or("").to_string();
                    let auth = text.lines().find(|l| l.to_ascii_lowercase().starts_with("authorization:")).unwrap_or("").to_string();
                    seen.lock().unwrap().push(format!("{path} {auth}"));
                    let reply = match path.as_str() {
                        "/mcp" => "HTTP/1.1 308 X\r\nlocation: /mcp/\r\ncontent-length: 0\r\nconnection: close\r\n\r\n".to_string(),
                        "/away" => "HTTP/1.1 302 X\r\nlocation: http://localhost:9/x\r\ncontent-length: 0\r\nconnection: close\r\n\r\n".to_string(),
                        _ => "HTTP/1.1 200 OK\r\ncontent-length: 0\r\nconnection: close\r\n\r\n".to_string(),
                    };
                    let _ = c.write_all(reply.as_bytes()).await;
                });
            }
        });
        let dir = tempfile::tempdir().unwrap();
        let store = dir.path().join("mcp-oauth.json");
        let (a, b) = (format!("{base}/mcp"), format!("{base}/away"));
        for u in [&a, &b] {
            crate::daemon::mcp_oauth::seed_for_test(&store, u, "tok");
        }
        let id = |u: &str| proxy_url(1, u).rsplit('/').next().unwrap().to_string();
        let r = forward(Some(&store), &id(&a), Method::GET, &HeaderMap::new(), Bytes::new()).await;
        assert_eq!(r.status(), 200);
        let r = forward(Some(&store), &id(&b), Method::GET, &HeaderMap::new(), Bytes::new()).await;
        assert_eq!(r.status(), 302, "a redirect off the origin is returned, never followed with the token");
        let seen = seen.lock().unwrap().clone();
        assert!(seen.iter().any(|s| s.starts_with("/mcp/ ") && s.ends_with("Bearer tok")), "{seen:?}");
    }

    #[tokio::test]
    async fn an_unknown_id_or_a_lapsed_sign_in_reaches_nothing_upstream() {
        let (seen, hits) = (Arc::new(Mutex::new(Vec::new())), Arc::new(AtomicUsize::new(0)));
        let url = upstream(seen, hits.clone()).await;
        let dir = tempfile::tempdir().unwrap();
        let store = dir.path().join("mcp-oauth.json");
        let r = forward(Some(&store), "nope", Method::POST, &HeaderMap::new(), Bytes::new()).await;
        assert_eq!(r.status(), 404);
        // Registered, but no sign-in in the store.
        let id = proxy_url(1, &url).rsplit('/').next().unwrap().to_string();
        let r = forward(Some(&store), &id, Method::POST, &HeaderMap::new(), Bytes::new()).await;
        assert_eq!(r.status(), 401);
        assert_eq!(hits.load(Ordering::SeqCst), 0);
    }
}
