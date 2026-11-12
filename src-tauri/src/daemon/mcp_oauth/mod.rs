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
//!
//! `store` holds the token file and the refresh; `sign_in` holds the
//! interactive flow that adds an entry to it.

mod sign_in;
mod store;

pub(crate) use sign_in::begin_sign_in;
#[cfg(test)]
pub(crate) use store::seed_for_test;
pub(crate) use store::{access_token, signed_in, store_path};

#[cfg(test)]
mod test_support {
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::Duration;

    /// A throwaway HTTP server: `handler(path, body)` returns (status, json).
    pub(super) async fn fake_server(
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

    pub(super) fn tmp() -> (tempfile::TempDir, PathBuf) {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("mcp-oauth.json");
        (d, p)
    }
}
