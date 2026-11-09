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

static CACHE: Mutex<Option<HashMap<String, (Instant, bool)>>> = Mutex::new(None);

/// The reserved key of Conductor's own server: a project entry must never
/// replace the one that carries `approval_prompt`.
const OWN_KEY: &str = "cc_conductor";

pub(crate) struct Resolved {
    pub servers: Map<String, Value>,
    /// One line per listed server that was left out, for the chat's notice.
    pub skipped: Vec<String>,
}

pub(crate) async fn servers_for(listed: &[ProjectMcpServer]) -> Resolved {
    let mut out = Resolved { servers: Map::new(), skipped: Vec::new() };
    for s in listed {
        if let Err(why) = check(s) {
            out.skipped.push(format!("{}: {why}", s.name));
            continue;
        }
        if !reachable(&s.url).await {
            out.skipped.push(format!("{}: unreachable, skipped", s.name));
            continue;
        }
        out.servers.insert(s.name.clone(), json!({"type": "http", "url": s.url}));
    }
    out
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

/// Any HTTP answer counts, a 401 included: it proves the server responds,
/// and sign-in state is the CLI's concern. Only a refused, timed-out or
/// silent connection fails.
async fn reachable(url: &str) -> bool {
    if let Some((at, ok)) = CACHE.lock().unwrap().as_ref().and_then(|c| c.get(url)) {
        if at.elapsed() < CACHE_TTL {
            return *ok;
        }
    }
    let ok = match reqwest::Client::builder().timeout(PROBE_TIMEOUT).build() {
        Ok(c) => c.get(url).send().await.is_ok(),
        Err(_) => false,
    };
    CACHE.lock().unwrap().get_or_insert_with(HashMap::new).insert(url.to_string(), (Instant::now(), ok));
    ok
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(name: &str, url: &str) -> ProjectMcpServer {
        ProjectMcpServer { name: name.into(), url: url.into() }
    }

    #[tokio::test]
    async fn a_reachable_server_is_written_as_an_http_entry() {
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/mcp", l.local_addr().unwrap());
        tokio::spawn(async move {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            loop {
                let (mut c, _) = l.accept().await.unwrap();
                // Reading first keeps close() from resetting the connection
                // over an unread request, which reqwest reports as an error.
                let _ = c.read(&mut [0u8; 1024]).await;
                let _ = c.write_all(b"HTTP/1.1 401 Unauthorized\r\ncontent-length: 0\r\nconnection: close\r\n\r\n").await;
            }
        });
        let r = servers_for(&[s("rodge", &url)]).await;
        assert_eq!(r.servers["rodge"], json!({"type": "http", "url": url}));
        assert!(r.skipped.is_empty());
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
        let r = servers_for(&[s("hang", &url)]).await;
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
        ])
        .await;
        assert!(r.servers.is_empty());
        assert_eq!(r.skipped.len(), 3);
    }
}
