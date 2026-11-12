//! The interactive sign-in: discovery, dynamic registration, and the PKCE
//! loopback callback that ends with an entry saved to the token file.

use super::store::{client, entry_from_token, load, save, Entry, REFRESH_LOCK};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rand::RngCore;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Duration;

const CALLBACK_WAIT: Duration = Duration::from_secs(300);
// A browser may open the callback port speculatively and send nothing; the
// real callback queues behind it, so one connection gets this long to speak.
const CALLBACK_READ_WAIT: Duration = Duration::from_secs(2);

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
                // Same lock as `access_token`'s refresh: load-insert-save must not
                // overwrite another server's rotated token written meanwhile.
                let _one_at_a_time = REFRESH_LOCK.lock().await;
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
        // A stray connection that stalls or resets (Windows reports a dropped
        // speculative connection as ECONNRESET) is skipped, never a failed sign-in.
        let Ok(Ok(n)) = tokio::time::timeout(CALLBACK_READ_WAIT, sock.read(&mut buf)).await else { continue };
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
    use super::super::signed_in;
    use super::super::test_support::{fake_server, tmp};
    use super::super::access_token;
    use super::*;
    use std::sync::atomic::AtomicUsize;
    use std::sync::Arc;

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
    async fn an_idle_connection_on_the_callback_port_does_not_block_the_real_callback() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let base = fake_server(Arc::new(AtomicUsize::new(0)), |_, _| (200, r#"{"access_token":"tok","expires_in":3600}"#.into())).await;
        let meta = Meta {
            authorization_endpoint: format!("{base}/authorize"),
            token_endpoint: format!("{base}/oauth/token"),
            registration_endpoint: format!("{base}/register"),
            scope: None,
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let c = client().unwrap();
        let done = tokio::spawn(async move {
            finish(listener, &c, &meta, "cid", "http://127.0.0.1/callback", "v", "st", "https://m.example/mcp").await
        });
        // Connects first and says nothing, like a browser's speculative connection.
        let _idle = tokio::net::TcpStream::connect(addr).await.unwrap();
        let mut real = tokio::net::TcpStream::connect(addr).await.unwrap();
        real.write_all(b"GET /callback?code=abc&state=st HTTP/1.1\r\nhost: x\r\n\r\n").await.unwrap();
        let entry = tokio::time::timeout(Duration::from_secs(10), done).await.expect("blocked behind the idle connection").unwrap().unwrap();
        assert_eq!(entry.access_token, "tok");
        let mut page = String::new();
        let _ = real.read_to_string(&mut page).await;
        assert!(page.contains("Signed in"), "got {page:?}");
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
