//! One HTTP/1.1 POST over a bi-stream of the tunnel. The daemon's loopback
//! server sits at the other end of the stream (the tunnel splices bytes), so a
//! plain request with `Connection: close` is all the uploader needs, and no HTTP
//! client crate has to ride along into the APK.

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

/// Most response bytes read. The answers are a few hundred bytes of JSON; the cap
/// only stops a peer that never ends its reply.
const MAX_REPLY_BYTES: usize = 1024 * 1024;

#[derive(Debug, PartialEq)]
pub(crate) struct HttpReply {
    pub status: u16,
    pub body: Vec<u8>,
}

#[derive(Debug, PartialEq)]
pub(crate) enum HttpError {
    Io(String),
    Malformed(&'static str),
}

pub(crate) async fn post_json(
    send: &mut (impl AsyncWrite + Unpin),
    recv: &mut (impl AsyncRead + Unpin),
    path: &str,
    token: &str,
    body: &[u8],
) -> Result<HttpReply, HttpError> {
    // A token with a line break would add header lines of its own.
    if token.bytes().any(|b| b == b'\r' || b == b'\n') {
        return Err(HttpError::Malformed("the login holds a line break"));
    }
    let head = format!(
        "POST {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    send.write_all(head.as_bytes()).await.map_err(|e| HttpError::Io(e.to_string()))?;
    send.write_all(body).await.map_err(|e| HttpError::Io(e.to_string()))?;
    send.flush().await.map_err(|e| HttpError::Io(e.to_string()))?;
    let mut raw = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        let n = recv.read(&mut chunk).await.map_err(|e| HttpError::Io(e.to_string()))?;
        if n == 0 {
            break;
        }
        raw.extend_from_slice(&chunk[..n]);
        if raw.len() > MAX_REPLY_BYTES {
            return Err(HttpError::Malformed("reply too large"));
        }
    }
    parse_reply(&raw)
}

fn parse_reply(raw: &[u8]) -> Result<HttpReply, HttpError> {
    let split = raw.windows(4).position(|w| w == b"\r\n\r\n").ok_or(HttpError::Malformed("no header end"))?;
    let head = std::str::from_utf8(&raw[..split]).map_err(|_| HttpError::Malformed("header not utf-8"))?;
    let mut lines = head.split("\r\n");
    let status_line = lines.next().ok_or(HttpError::Malformed("no status line"))?;
    let status = status_line
        .split(' ')
        .nth(1)
        .and_then(|s| s.parse::<u16>().ok())
        .ok_or(HttpError::Malformed("bad status line"))?;
    let mut chunked = false;
    let mut length: Option<usize> = None;
    for line in lines {
        let Some((name, value)) = line.split_once(':') else { continue };
        let (name, value) = (name.trim().to_ascii_lowercase(), value.trim());
        if name == "transfer-encoding" && value.to_ascii_lowercase().contains("chunked") {
            chunked = true;
        } else if name == "content-length" {
            length = value.parse().ok();
        }
    }
    let rest = &raw[split + 4..];
    let body = if chunked {
        dechunk(rest)?
    } else {
        match length {
            // A body shorter than it promised means the stream dropped mid-reply.
            Some(n) if rest.len() < n => return Err(HttpError::Malformed("truncated body")),
            Some(n) => rest[..n].to_vec(),
            None => rest.to_vec(),
        }
    };
    Ok(HttpReply { status, body })
}

fn dechunk(mut rest: &[u8]) -> Result<Vec<u8>, HttpError> {
    let mut out = Vec::new();
    loop {
        let line_end = rest.windows(2).position(|w| w == b"\r\n").ok_or(HttpError::Malformed("chunk size line"))?;
        let size_text = std::str::from_utf8(&rest[..line_end]).map_err(|_| HttpError::Malformed("chunk size"))?;
        let size_text = size_text.split(';').next().unwrap_or("").trim();
        let size = usize::from_str_radix(size_text, 16).map_err(|_| HttpError::Malformed("chunk size"))?;
        rest = &rest[line_end + 2..];
        if size == 0 {
            return Ok(out);
        }
        if rest.len() < size + 2 {
            return Err(HttpError::Malformed("truncated chunk"));
        }
        out.extend_from_slice(&rest[..size]);
        rest = &rest[size + 2..];
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A server end that reads the request up to its body and answers `reply`.
    async fn serve(mut io: tokio::io::DuplexStream, reply: Vec<u8>) -> Vec<u8> {
        let mut got = Vec::new();
        let mut buf = [0u8; 1024];
        loop {
            let n = io.read(&mut buf).await.unwrap();
            got.extend_from_slice(&buf[..n]);
            if let Some(split) = got.windows(4).position(|w| w == b"\r\n\r\n") {
                let head = String::from_utf8_lossy(&got[..split]).to_string();
                let len: usize = head
                    .lines()
                    .find_map(|l| l.strip_prefix("Content-Length: "))
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(0);
                if got.len() >= split + 4 + len {
                    break;
                }
            }
        }
        io.write_all(&reply).await.unwrap();
        io.shutdown().await.unwrap();
        got
    }

    async fn exchange(reply: &[u8]) -> (Result<HttpReply, HttpError>, Vec<u8>) {
        let (client, server) = tokio::io::duplex(64 * 1024);
        let server = tokio::spawn(serve(server, reply.to_vec()));
        let (mut r, mut w) = tokio::io::split(client);
        let out = post_json(&mut w, &mut r, "/api/rpc", "tok", b"{\"a\":1}").await;
        (out, server.await.unwrap())
    }

    #[tokio::test]
    async fn the_request_carries_the_bearer_token_path_and_body() {
        let (out, sent) = exchange(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}").await;
        assert_eq!(out.unwrap(), HttpReply { status: 200, body: b"{}".to_vec() });
        let sent = String::from_utf8(sent).unwrap();
        assert!(sent.starts_with("POST /api/rpc HTTP/1.1\r\n"));
        assert!(sent.contains("Authorization: Bearer tok\r\n"));
        assert!(sent.contains("Content-Length: 7\r\n"));
        assert!(sent.ends_with("{\"a\":1}"));
    }

    #[tokio::test]
    async fn a_token_with_a_line_break_is_refused_before_anything_is_sent() {
        let (client, _server) = tokio::io::duplex(1024);
        let (mut r, mut w) = tokio::io::split(client);
        let out = post_json(&mut w, &mut r, "/api/rpc", "tok\r\nX-Evil: 1", b"{}").await;
        assert_eq!(out.unwrap_err(), HttpError::Malformed("the login holds a line break"));
    }

    #[tokio::test]
    async fn a_chunked_reply_is_joined() {
        let (out, _) = exchange(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n2\r\nde\r\n0\r\n\r\n").await;
        assert_eq!(out.unwrap().body, b"abcde");
    }

    #[tokio::test]
    async fn a_body_cut_short_is_an_error_not_a_shorter_answer() {
        let (out, _) = exchange(b"HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nabc").await;
        assert_eq!(out.unwrap_err(), HttpError::Malformed("truncated body"));
    }

    #[tokio::test]
    async fn an_error_status_is_returned_with_its_body() {
        let (out, _) = exchange(b"HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n").await;
        assert_eq!(out.unwrap().status, 401);
    }

    #[tokio::test]
    async fn a_stream_that_ends_before_any_header_is_malformed() {
        let (out, _) = exchange(b"").await;
        assert!(matches!(out, Err(HttpError::Malformed(_))));
    }
}
