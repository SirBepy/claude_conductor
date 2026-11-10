//! A project's own HTTP MCP servers as `--mcp-config` entries.
//!
//! Chats run `--strict-mcp-config` (todo 867), so a repo's `.mcp.json` never
//! loads. A project instead lists servers in its settings, and each is probed
//! before it is written in: measured 2026-11-09 on CLI 2.1.316, a dead server
//! only comes up `failed`, but one that accepts the connection and never
//! answers delayed a turn's start by about 26s, so an unreachable server is
//! left out of the file rather than trusted to fail fast.

use crate::types::project::ProjectMcpServer;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

const PROBE_TIMEOUT: Duration = Duration::from_secs(2);
// A turn spawns a process, so without a cache every turn pays the probe.
const CACHE_TTL: Duration = Duration::from_secs(30);

static CACHE: Mutex<Option<HashMap<String, (Instant, Option<u16>)>>> = Mutex::new(None);

/// The reserved key of Conductor's own server: a project entry must never
/// replace the one that carries `approval_prompt`.
const OWN_KEY: &str = "cc_conductor";

pub(crate) struct Resolved {
    pub servers: Map<String, Value>,
    /// One line per listed server that was left out, for the chat's notice.
    pub skipped: Vec<String>,
}

/// `oauth_store` is the token file `mcp_oauth` reads; a server that answers
/// 401 without a stored sign-in is left out (it would only come up
/// `needs-auth`), and one with a sign-in gets its bearer header.
pub(crate) async fn servers_for(listed: &[ProjectMcpServer], oauth_store: Option<&std::path::Path>) -> Resolved {
    let mut out = Resolved { servers: Map::new(), skipped: Vec::new() };
    for s in listed {
        if let Err(why) = check(s) {
            out.skipped.push(format!("{}: {why}", s.name));
            continue;
        }
        let Some(status) = probe(&s.url).await else {
            out.skipped.push(format!("{}: unreachable, skipped", s.name));
            continue;
        };
        let token = match oauth_store {
            Some(p) => crate::daemon::mcp_oauth::access_token(p, &s.url).await,
            None => None,
        };
        let mut entry = json!({"type": "http", "url": s.url});
        match token {
            Some(t) => entry["headers"] = json!({"Authorization": format!("Bearer {t}")}),
            None if status == 401 => {
                out.skipped.push(format!("{}: needs sign-in, skipped", s.name));
                continue;
            }
            None => {}
        }
        out.servers.insert(s.name.clone(), entry);
    }
    out
}

// What each chat was last told, so a server that stays down is named once,
// not on every turn's spawn.
static ANNOUNCED: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);

/// Shows Joe a muted system line naming the listed servers left out of this
/// turn. Broadcast only: nothing is sent to the model, and nothing persists.
pub(crate) fn announce_skipped(session: &crate::daemon::session::Session, skipped: &[String]) {
    let line = (!skipped.is_empty()).then(|| format!("Project MCP: {}", skipped.join("; ")));
    {
        let mut seen = ANNOUNCED.lock().unwrap();
        let seen = seen.get_or_insert_with(HashMap::new);
        match &line {
            Some(l) if seen.get(&session.session_id) == Some(l) => return,
            Some(l) => seen.insert(session.session_id.clone(), l.clone()),
            None => seen.remove(&session.session_id),
        };
    }
    let Some(line) = line else { return };
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;
    crate::daemon::broadcast::publish(
        session,
        crate::types::chat::ChatEvent::UserMessage {
            content: vec![crate::types::chat::ContentBlock::Text { text: line }],
            timestamp: now_ms,
            remote_echo: true,
            is_meta: true,
            author_session_id: None,
        },
    );
}

fn check(s: &ProjectMcpServer) -> Result<(), &'static str> {
    if s.name == OWN_KEY {
        return Err("reserved name");
    }
    // The name becomes the tool prefix `mcp__<name>__`, so keep it one token.
    if s.name.is_empty() || !s.name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
        return Err("name must be letters, digits, - or _");
    }
    match s.url.parse::<reqwest::Url>() {
        Ok(u) if matches!(u.scheme(), "http" | "https") => Ok(()),
        _ => Err("url must be http or https"),
    }
}

/// The HTTP status of an unauthenticated POST, `None` for a refused, timed-out
/// or silent connection. Any answer proves the server responds. POST because
/// an MCP endpoint may take only POST (rodge's `/mcp` answers a GET 405 and
/// only a POST reaches its 401), and the body is never a call the server could act on.
async fn probe(url: &str) -> Option<u16> {
    if let Some((at, status)) = CACHE.lock().unwrap().as_ref().and_then(|c| c.get(url)) {
        if at.elapsed() < CACHE_TTL {
            return *status;
        }
    }
    let status = match reqwest::Client::builder().timeout(PROBE_TIMEOUT).build() {
        Ok(c) => c
            .post(url)
            .header("content-type", "application/json")
            .header("accept", "application/json, text/event-stream")
            .body(r#"{"jsonrpc":"2.0","id":0,"method":"ping"}"#)
            .send()
            .await
            .ok()
            .map(|r| r.status().as_u16()),
        Err(_) => None,
    };
    CACHE.lock().unwrap().get_or_insert_with(HashMap::new).insert(url.to_string(), (Instant::now(), status));
    status
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(name: &str, url: &str) -> ProjectMcpServer {
        ProjectMcpServer { name: name.into(), url: url.into() }
    }

    /// A server that answers every request with `status`, returning its MCP URL.
    async fn serve(status: &'static str) -> String {
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/mcp", l.local_addr().unwrap());
        tokio::spawn(async move {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            loop {
                let (mut c, _) = l.accept().await.unwrap();
                // Reading first keeps close() from resetting the connection
                // over an unread request, which reqwest reports as an error.
                let _ = c.read(&mut [0u8; 1024]).await;
                let _ = c.write_all(format!("HTTP/1.1 {status}\r\ncontent-length: 0\r\nconnection: close\r\n\r\n").as_bytes()).await;
            }
        });
        url
    }

    #[tokio::test]
    async fn an_open_server_is_written_as_a_plain_http_entry() {
        let url = serve("200 OK").await;
        let r = servers_for(&[s("open", &url)], None).await;
        assert_eq!(r.servers["open"], json!({"type": "http", "url": url}));
        assert!(r.skipped.is_empty());
    }

    #[tokio::test]
    async fn a_server_asking_for_auth_is_skipped_until_signed_in_then_gets_its_bearer_header() {
        let url = serve("401 Unauthorized").await;
        let dir = tempfile::tempdir().unwrap();
        let store = dir.path().join("mcp-oauth.json");
        let r = servers_for(&[s("rodge", &url)], Some(&store)).await;
        assert!(r.servers.is_empty());
        assert_eq!(r.skipped, vec!["rodge: needs sign-in, skipped".to_string()]);

        crate::daemon::mcp_oauth::seed_for_test(&store, &url, "tok");
        let r = servers_for(&[s("rodge", &url)], Some(&store)).await;
        assert_eq!(
            r.servers["rodge"],
            json!({"type": "http", "url": url, "headers": {"Authorization": "Bearer tok"}})
        );
    }

    #[tokio::test]
    async fn a_silent_server_is_skipped_within_the_probe_window() {
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/mcp", l.local_addr().unwrap());
        tokio::spawn(async move {
            let mut held = Vec::new();
            loop {
                held.push(l.accept().await.unwrap());
            }
        });
        let t = Instant::now();
        let r = servers_for(&[s("hang", &url)], None).await;
        assert!(r.servers.is_empty());
        assert_eq!(r.skipped, vec!["hang: unreachable, skipped".to_string()]);
        assert!(t.elapsed() < Duration::from_secs(4));
    }

    #[tokio::test]
    async fn the_conductor_key_and_bad_names_or_urls_never_reach_the_config() {
        let r = servers_for(&[
            s("cc_conductor", "http://127.0.0.1:1/mcp"),
            s("has space", "http://127.0.0.1:1/mcp"),
            s("ftp", "ftp://x/mcp"),
        ], None)
        .await;
        assert!(r.servers.is_empty());
        assert_eq!(r.skipped.len(), 3);
    }
}
