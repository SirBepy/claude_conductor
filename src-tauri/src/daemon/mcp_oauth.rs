//! OAuth client for a project's HTTP MCP server (rodge's `/mcp` is the first).
//!
//! The chat's `claude` child has no interactive `/mcp` to sign in with, so
//! Conductor completes the flow itself (discovery, dynamic client
//! registration, PKCE S256 on a loopback redirect) and hands the child a
//! bearer header. Tokens sit in `<data_dir>/mcp-oauth.json`, plain like the
//! other session files in that folder.
//!
//! Rodge rotates the refresh token on every use and revokes the whole grant
//! when an old one is replayed, so a refresh runs under one lock and saves the
//! new pair before anyone uses it; a waiter re-reads the file and finds the
//! fresh token instead of refreshing again.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

const HTTP_TIMEOUT: Duration = Duration::from_secs(10);
const CALLBACK_WAIT: Duration = Duration::from_secs(300);
// Refresh a little early so a token never expires between the check and the
// child's first request.
const EXPIRY_SLACK_SECS: i64 = 60;

static REFRESH_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
struct Entry {
    client_id: String,
    token_endpoint: String,
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    /// Unix seconds.
    #[serde(default)]
    expires_at: i64,
}

type Store = HashMap<String, Entry>;

pub(crate) fn store_path() -> Option<PathBuf> {
    crate::settings::paths::data_dir().ok().map(|d| d.join("mcp-oauth.json"))
}

fn load(path: &Path) -> Store {
    std::fs::read_to_string(path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

fn save(path: &Path, store: &Store) -> Result<(), String> {
    let body = serde_json::to_string(store).map_err(|e| e.to_string())?;
    crate::util::write_json_atomic(path, &body).map_err(|e| e.to_string())
}

fn now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder().timeout(HTTP_TIMEOUT).build().map_err(|e| e.to_string())
}

/// Whether a usable sign-in exists for `mcp_url`: a refresh token can always
/// be exchanged, so an expired access token alone still counts.
pub(crate) fn signed_in(path: &Path, mcp_url: &str) -> bool {
    load(path).get(mcp_url).is_some_and(|e| e.refresh_token.is_some() || e.expires_at > now())
}

/// A bearer token for `mcp_url`, refreshed when near expiry. `None` when the
/// user never signed in, or the grant was refused (which also signs them out).
pub(crate) async fn access_token(path: &Path, mcp_url: &str) -> Option<String> {
    let fresh = |e: &Entry| e.expires_at - now() > EXPIRY_SLACK_SECS;
    let entry = load(path).get(mcp_url).cloned()?;
    if fresh(&entry) {
        return Some(entry.access_token);
    }
    let _one_at_a_time = REFRESH_LOCK.lock().await;
    // Another caller may have refreshed while this one waited.
    let entry = load(path).get(mcp_url).cloned()?;
    if fresh(&entry) {
        return Some(entry.access_token);
    }
    let refresh = entry.refresh_token.clone()?;
    let res = client().ok()?
        .post(&entry.token_endpoint)
        .form(&[
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh.as_str()),
            ("client_id", entry.client_id.as_str()),
            ("resource", mcp_url),
        ])
        .send()
        .await;
    let res = match res {
        Ok(r) => r,
        Err(e) => {
            log::warn!("mcp oauth: refresh for {mcp_url} failed to reach the server: {e}");
            return None;
        }
    };
    let status = res.status();
    let body: Value = res.json().await.unwrap_or(Value::Null);
    let mut store = load(path);
    if status.is_success() {
        let updated = entry_from_token(&entry.client_id, &entry.token_endpoint, &body, entry.refresh_token.clone())?;
        let token = updated.access_token.clone();
        store.insert(mcp_url.to_string(), updated);
        save(path, &store).ok()?;
        return Some(token);
    }
    // A refused grant (revoked, expired, replayed) is final: keep nothing
    // that would be retried every turn.
    if status.as_u16() == 400 || status.as_u16() == 401 {
        log::warn!("mcp oauth: refresh for {mcp_url} refused ({status}); signed out");
        store.remove(mcp_url);
        let _ = save(path, &store);
    }
    None
}

fn entry_from_token(client_id: &str, token_endpoint: &str, body: &Value, old_refresh: Option<String>) -> Option<Entry> {
    let access = body.get("access_token")?.as_str()?.to_string();
    let expires_in = body.get("expires_in").and_then(Value::as_i64).unwrap_or(3600);
    Some(Entry {
        client_id: client_id.to_string(),
        token_endpoint: token_endpoint.to_string(),
        access_token: access,
        refresh_token: body.get("refresh_token").and_then(Value::as_str).map(str::to_string).or(old_refresh),
        expires_at: now() + expires_in,
    })
}

#[cfg(test)]
pub(crate) fn seed_for_test(path: &Path, mcp_url: &str, token: &str) {
    let mut store = load(path);
    store.insert(
        mcp_url.to_string(),
        Entry { client_id: "c".into(), token_endpoint: String::new(), access_token: token.into(), refresh_token: None, expires_at: now() + 3600 },
    );
    save(path, &store).unwrap();
}

pub(crate) fn challenge_for(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

fn random_token() -> String {
    let mut b = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut b);
    URL_SAFE_NO_PAD.encode(b)
}

struct Meta {
    authorization_endpoint: String,
    token_endpoint: String,
    registration_endpoint: String,
    /// The resource's `scopes_supported`, space-joined; rodge's tools need them asked for.
    scope: Option<String>,
}

async fn get_json(c: &reqwest::Client, url: &str) -> Option<Value> {
    let r = c.get(url).send().await.ok()?;
    if !r.status().is_success() {
        return None;
    }
    r.json().await.ok()
}

/// RFC 9728 then RFC 8414: the protected resource names its authorization
/// server, and that server publishes its endpoints. A server with no
/// protected-resource document is taken to be its own authorization server.
async fn discover(c: &reqwest::Client, mcp_url: &str) -> Result<Meta, String> {
    let u: reqwest::Url = mcp_url.parse().map_err(|_| "bad url".to_string())?;
    let origin = u.origin().ascii_serialization();
    let prm = match get_json(c, &format!("{origin}/.well-known/oauth-protected-resource{}", u.path().trim_end_matches('/'))).await {
        Some(v) => Some(v),
        None => get_json(c, &format!("{origin}/.well-known/oauth-protected-resource")).await,
    };
    let scope = prm
        .as_ref()
        .and_then(|v| v.get("scopes_supported")?.as_array().cloned())
        .map(|a| a.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(" "))
        .filter(|s| !s.is_empty());
    let as_base = prm
        .as_ref()
        .and_then(|v| v.get("authorization_servers")?.get(0)?.as_str().map(|s| s.trim_end_matches('/').to_string()))
        .unwrap_or(origin);
    let meta = get_json(c, &format!("{as_base}/.well-known/oauth-authorization-server"))
        .await
        .ok_or("the server publishes no OAuth metadata")?;
    let field = |k: &str| meta.get(k).and_then(Value::as_str).map(str::to_string).ok_or(format!("OAuth metadata has no {k}"));
    Ok(Meta {
        authorization_endpoint: field("authorization_endpoint")?,
        token_endpoint: field("token_endpoint")?,
        registration_endpoint: field("registration_endpoint")?,
        scope,
    })
}

/// Starts a sign-in and returns the URL to open in a browser. The callback is
/// awaited in the background; the result shows up in `signed_in`.
pub(crate) async fn begin_sign_in(path: PathBuf, mcp_url: String) -> Result<String, String> {
    let c = client()?;
    let meta = discover(&c, &mcp_url).await?;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.map_err(|e| e.to_string())?;
    let redirect = format!("http://127.0.0.1:{}/callback", listener.local_addr().map_err(|e| e.to_string())?.port());
    // Registered per sign-in with the real port: rodge's stateless client ids
    // bind the redirect URIs they were registered with.
    let reg: Value = c
        .post(&meta.registration_endpoint)
        .json(&serde_json::json!({
            "client_name": "Claude Conductor",
            "redirect_uris": [redirect],
            "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"],
            "token_endpoint_auth_method": "none",
        }))
        .send()
        .await
        .map_err(|e| format!("registration failed: {e}"))?
        .json()
        .await
        .map_err(|e| format!("registration reply unreadable: {e}"))?;
    let client_id = reg.get("client_id").and_then(Value::as_str).ok_or("registration returned no client_id")?.to_string();
    let verifier = random_token();
    let state = random_token();
    let mut auth: reqwest::Url = meta.authorization_endpoint.parse().map_err(|_| "bad authorization endpoint".to_string())?;
    auth.query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", &client_id)
        .append_pair("redirect_uri", &redirect)
        .append_pair("code_challenge", &challenge_for(&verifier))
        .append_pair("code_challenge_method", "S256")
        .append_pair("state", &state)
        .append_pair("resource", &mcp_url);
    if let Some(scope) = &meta.scope {
        auth.query_pairs_mut().append_pair("scope", scope);
    }
    tokio::spawn(async move {
        match tokio::time::timeout(CALLBACK_WAIT, finish(listener, &c, &meta, &client_id, &redirect, &verifier, &state, &mcp_url)).await {
            Ok(Ok(entry)) => {
                let mut store = load(&path);
                store.insert(mcp_url.clone(), entry);
                if let Err(e) = save(&path, &store) {
                    log::warn!("mcp oauth: could not save the token for {mcp_url}: {e}");
                }
            }
            Ok(Err(e)) => log::warn!("mcp oauth: sign-in for {mcp_url} failed: {e}"),
            Err(_) => log::warn!("mcp oauth: sign-in for {mcp_url} timed out waiting for the browser"),
        }
    });
    Ok(auth.to_string())
}

#[allow(clippy::too_many_arguments)]
async fn finish(
    listener: tokio::net::TcpListener,
    c: &reqwest::Client,
    meta: &Meta,
    client_id: &str,
    redirect: &str,
    verifier: &str,
    state: &str,
    mcp_url: &str,
) -> Result<Entry, String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    // A stray local request (a favicon, a port scan) must not end the wait:
    // only a callback carrying this sign-in's state does.
    let code = loop {
        let (mut sock, _) = listener.accept().await.map_err(|e| e.to_string())?;
        let mut buf = vec![0u8; 4096];
        let n = sock.read(&mut buf).await.map_err(|e| e.to_string())?;
        let got = parse_callback(&String::from_utf8_lossy(&buf[..n]), state);
        let page = if got.is_some() { "Signed in. You can close this tab and return to Conductor." } else { "Not the sign-in callback." };
        let _ = sock
            .write_all(format!("HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{page}", page.len()).as_bytes())
            .await;
        if let Some(code) = got {
            break code;
        }
    };
    let res = c
        .post(&meta.token_endpoint)
        .form(&[
            ("grant_type", "authorization_code"),
            ("code", code.as_str()),
            ("redirect_uri", redirect),
            ("client_id", client_id),
            ("code_verifier", verifier),
            ("resource", mcp_url),
        ])
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("token endpoint answered {}", res.status()));
    }
    let body: Value = res.json().await.map_err(|e| e.to_string())?;
    entry_from_token(client_id, &meta.token_endpoint, &body, None).ok_or_else(|| "token reply had no access_token".to_string())
}

/// The authorization code from a raw HTTP request line, only when `state`
/// matches and no `error` came back.
fn parse_callback(request: &str, state: &str) -> Option<String> {
    let target = request.lines().next()?.split_whitespace().nth(1)?;
    let url: reqwest::Url = format!("http://127.0.0.1{target}").parse().ok()?;
    if url.path() != "/callback" {
        return None;
    }
    let q: HashMap<_, _> = url.query_pairs().collect();
    if q.contains_key("error") || q.get("state").map(|s| s.as_ref()) != Some(state) {
        return None;
    }
    q.get("code").map(|c| c.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    /// A throwaway HTTP server: `handler(path, body)` returns (status, json).
    async fn fake_server(
        hits: Arc<AtomicUsize>,
        handler: impl Fn(&str, &str) -> (u16, String) + Send + Sync + 'static,
    ) -> String {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", l.local_addr().unwrap());
        let handler = Arc::new(handler);
        tokio::spawn(async move {
            loop {
                let (mut s, _) = l.accept().await.unwrap();
                let (hits, handler) = (hits.clone(), handler.clone());
                tokio::spawn(async move {
                    let mut data = Vec::new();
                    let mut buf = [0u8; 2048];
                    loop {
                        let n = s.read(&mut buf).await.unwrap_or(0);
                        data.extend_from_slice(&buf[..n]);
                        let text = String::from_utf8_lossy(&data).to_string();
                        if let Some(i) = text.find("\r\n\r\n") {
                            let len = text[..i]
                                .lines()
                                .find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap_or(0)))
                                .unwrap_or(0);
                            if data.len() >= i + 4 + len || n == 0 {
                                break;
                            }
                        } else if n == 0 {
                            break;
                        }
                    }
                    let text = String::from_utf8_lossy(&data).to_string();
                    let path = text.lines().next().unwrap_or("").split_whitespace().nth(1).unwrap_or("").to_string();
                    let body = text.split("\r\n\r\n").nth(1).unwrap_or("").to_string();
                    if path == "/oauth/token" {
                        hits.fetch_add(1, Ordering::SeqCst);
                        tokio::time::sleep(Duration::from_millis(200)).await;
                    }
                    let (status, reply) = handler(&path, &body);
                    let _ = s
                        .write_all(format!("HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{reply}", reply.len()).as_bytes())
                        .await;
                });
            }
        });
        base
    }

    fn tmp() -> (tempfile::TempDir, PathBuf) {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("mcp-oauth.json");
        (d, p)
    }

    #[test]
    fn pkce_challenge_matches_the_rfc_7636_vector() {
        assert_eq!(
            challenge_for("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn a_callback_counts_only_with_the_matching_state_and_no_error() {
        let req = |q: &str| format!("GET /callback?{q} HTTP/1.1\r\nhost: x\r\n\r\n");
        assert_eq!(parse_callback(&req("code=abc&state=s1"), "s1"), Some("abc".into()));
        assert_eq!(parse_callback(&req("code=abc&state=other"), "s1"), None);
        assert_eq!(parse_callback(&req("error=access_denied&state=s1"), "s1"), None);
        assert_eq!(parse_callback("GET /favicon.ico HTTP/1.1\r\n\r\n", "s1"), None);
    }

    #[tokio::test]
    async fn two_callers_with_an_expired_token_refresh_once_and_both_get_the_new_token() {
        let hits = Arc::new(AtomicUsize::new(0));
        let base = fake_server(hits.clone(), |_, _| {
            (200, r#"{"access_token":"new-a","refresh_token":"new-r","expires_in":3600}"#.into())
        })
        .await;
        let (_d, path) = tmp();
        let mut store = Store::new();
        store.insert(
            "https://m.example/mcp".into(),
            Entry { client_id: "c".into(), token_endpoint: format!("{base}/oauth/token"), access_token: "old".into(), refresh_token: Some("old-r".into()), expires_at: 1 },
        );
        save(&path, &store).unwrap();
        let (a, b) = tokio::join!(access_token(&path, "https://m.example/mcp"), access_token(&path, "https://m.example/mcp"));
        assert_eq!((a.as_deref(), b.as_deref()), (Some("new-a"), Some("new-a")));
        assert_eq!(hits.load(Ordering::SeqCst), 1, "a second refresh would replay the rotated token and revoke the grant");
        assert_eq!(load(&path)["https://m.example/mcp"].refresh_token.as_deref(), Some("new-r"));
    }

    #[tokio::test]
    async fn a_refused_refresh_signs_the_server_out() {
        let base = fake_server(Arc::new(AtomicUsize::new(0)), |_, _| (400, r#"{"error":"invalid_grant"}"#.into())).await;
        let (_d, path) = tmp();
        let mut store = Store::new();
        store.insert(
            "u".into(),
            Entry { client_id: "c".into(), token_endpoint: format!("{base}/oauth/token"), access_token: "old".into(), refresh_token: Some("r".into()), expires_at: 1 },
        );
        save(&path, &store).unwrap();
        assert_eq!(access_token(&path, "u").await, None);
        assert!(!signed_in(&path, "u"));
    }

    /// Against a real rodge dev server (`MCP_LIVE_URL`, e.g. http://localhost:5173/mcp):
    /// discovery, registration and an authorize request that rodge accepts. The
    /// consent click is a person's, so this stops at the authorize response.
    /// Run: cargo test --lib -- --ignored live_rodge_accepts
    #[tokio::test]
    #[ignore]
    async fn live_rodge_accepts_discovery_registration_and_the_authorize_request() {
        let url = std::env::var("MCP_LIVE_URL").unwrap_or_else(|_| "http://localhost:5173/mcp".into());
        let (_d, path) = tmp();
        let auth = begin_sign_in(path, url).await.expect("discovery and registration");
        let res = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap()
            .get(&auth)
            .send()
            .await
            .unwrap();
        let status = res.status().as_u16();
        let location = res.headers().get("location").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
        println!("authorize -> {status} {location}");
        assert!(status < 400, "rodge refused the authorize request: {status} {location}");
        assert!(!location.contains("error="), "rodge redirected with an error: {location}");
    }

    #[tokio::test]
    async fn sign_in_discovers_registers_and_stores_the_token_from_the_callback() {
        let hits = Arc::new(AtomicUsize::new(0));
        // The handler needs its own base URL, which exists only after bind.
        let base_cell: Arc<std::sync::OnceLock<String>> = Arc::new(std::sync::OnceLock::new());
        let cell = base_cell.clone();
        let base = fake_server(hits, move |path, body| {
            let base = cell.get().cloned().unwrap_or_default();
            match path {
                p if p.starts_with("/.well-known/oauth-protected-resource") => (
                    200,
                    format!(r#"{{"resource":"{base}/mcp","authorization_servers":["{base}"],"scopes_supported":["mail.read","drafts.write"]}}"#),
                ),
                "/.well-known/oauth-authorization-server" => (
                    200,
                    format!(r#"{{"authorization_endpoint":"{base}/oauth/authorize","token_endpoint":"{base}/oauth/token","registration_endpoint":"{base}/oauth/register"}}"#),
                ),
                "/oauth/register" => {
                    assert!(body.contains("127.0.0.1"), "the redirect URI is registered");
                    (201, r#"{"client_id":"cid"}"#.into())
                }
                "/oauth/token" => {
                    assert!(body.contains("code=the-code") && body.contains("code_verifier="), "{body}");
                    (200, r#"{"access_token":"tok","refresh_token":"ref","expires_in":3600}"#.into())
                }
                _ => (404, "{}".into()),
            }
        })
        .await;
        base_cell.set(base.clone()).unwrap();
        let (_d, path) = tmp();
        let mcp = format!("{base}/mcp");
        let auth = begin_sign_in(path.clone(), mcp.clone()).await.unwrap();
        let auth: reqwest::Url = auth.parse().unwrap();
        let q: HashMap<_, _> = auth.query_pairs().into_owned().collect();
        assert_eq!(q["code_challenge_method"], "S256");
        assert_eq!(q["resource"], mcp);
        assert_eq!(q["scope"], "mail.read drafts.write");
        // The browser's redirect back to the loopback listener.
        reqwest::get(format!("{}?code=the-code&state={}", q["redirect_uri"], q["state"])).await.unwrap();
        for _ in 0..50 {
            if signed_in(&path, &mcp) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert_eq!(access_token(&path, &mcp).await.as_deref(), Some("tok"));
    }
}
