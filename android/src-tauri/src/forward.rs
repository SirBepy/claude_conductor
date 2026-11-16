//! The loopback side of the tunnel: accepting the page's sockets, answering the
//! journal requests locally and splicing everything else onto a bi-stream of
//! the shared QUIC connection.

use std::sync::Arc;
use std::time::Duration;

use log::{error, warn};
use tokio::net::{TcpListener, TcpStream};

use crate::iroh_tunnel::{ms_of, BoxError, Tunnel};
use crate::quiet_watch::StreamGauge;

/// Most bytes `forward` buffers from a socket while it waits for a stream.
const EARLY_BUFFER_CAP: usize = 256 * 1024;

/// The journal request line the main loopback port answers itself when it is the
/// first request on a fresh connection. The page does not rely on that: the
/// WebView reuses idle keep-alive connections that are already spliced to a
/// stream to the PC, so a fetch on one of those reaches the PC, not this check.
/// The page reads the dedicated journal port (`bind_journal_listener`) instead.
const JOURNAL_REQUEST_PREFIX: &[u8] = b"GET /__tunnel/journal HTTP/1.";

/// Most bytes `forward` reads before it decides whether a request is the journal's.
const REQUEST_HEAD_CAP: usize = 256;

/// A client silent this long before its request line is complete is dropped.
const REQUEST_HEAD_TIMEOUT: Duration = Duration::from_secs(10);

pub(crate) async fn accept_loop(listener: TcpListener, tunnel: Arc<Tunnel>) {
    loop {
        match listener.accept().await {
            Ok((tcp, _)) => {
                let tunnel = tunnel.clone();
                tokio::spawn(async move {
                    if let Err(e) = forward(tcp, &tunnel).await {
                        error!("tunnel forward error: {}", e);
                    }
                });
            }
            Err(e) => {
                error!("tunnel listener accept failed: {}", e);
                // Don't continue in a tight loop if accept keeps failing
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        }
    }
}

/// Most request bytes the journal port reads before it answers anyway.
const JOURNAL_PORT_HEAD_CAP: usize = 8 * 1024;

/// A journal-port client that has not finished its request head by now is dropped.
pub(crate) const JOURNAL_PORT_HEAD_TIMEOUT: Duration = Duration::from_secs(5);

pub(crate) async fn journal_accept_loop(listener: TcpListener, tunnel: Arc<Tunnel>, main_port: u16) {
    loop {
        match listener.accept().await {
            Ok((tcp, _)) => {
                let tunnel = tunnel.clone();
                tokio::spawn(async move {
                    if let Err(e) = serve_journal(tcp, &tunnel, main_port).await {
                        warn!("journal port reply failed: {e}");
                    }
                });
            }
            Err(e) => {
                error!("journal listener accept failed: {}", e);
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        }
    }
}

/// Answers every connection with the journal and closes. The origin header names
/// the tunnel's own page (`main_port`) only, so no other site can read it.
/// Never dials the PC.
async fn serve_journal(tcp: TcpStream, tunnel: &Tunnel, main_port: u16) -> Result<(), BoxError> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let (mut read, mut write) = tokio::io::split(tcp);
    let deadline = tokio::time::Instant::now() + JOURNAL_PORT_HEAD_TIMEOUT;
    let mut head: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 1024];
    while head.len() < JOURNAL_PORT_HEAD_CAP && !head.windows(4).any(|w| w == b"\r\n\r\n") {
        match tokio::time::timeout_at(deadline, read.read(&mut chunk)).await {
            Ok(Ok(n)) if n > 0 => head.extend_from_slice(&chunk[..n]),
            _ => return Ok(()),
        }
    }
    let body = tunnel.journal.snapshot_json(ms_of((tunnel.clock)()));
    let reply = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nAccess-Control-Allow-Origin: http://127.0.0.1:{main_port}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    write.write_all(reply.as_bytes()).await?;
    write.shutdown().await?;
    Ok(())
}

enum RequestHead {
    Journal,
    Forward,
    /// The peer closed, errored or stayed silent past `REQUEST_HEAD_TIMEOUT`.
    Closed,
}

/// Reads into `early` until it is known whether the request is the journal's:
/// the first line is complete, `REQUEST_HEAD_CAP` bytes arrived, or the bytes
/// can no longer be the start of the journal request line. The last rule keeps a
/// client that speaks a non-HTTP protocol, or waits for a reply after a short
/// write, from being held until the timeout. Every byte read stays in `early`.
async fn read_request_head(tcp_read: &mut (impl tokio::io::AsyncRead + Unpin), early: &mut Vec<u8>) -> RequestHead {
    use tokio::io::AsyncReadExt;
    let deadline = tokio::time::Instant::now() + REQUEST_HEAD_TIMEOUT;
    let mut chunk = [0u8; 512];
    loop {
        let line_end = early.iter().position(|b| *b == b'\n');
        let n = JOURNAL_REQUEST_PREFIX.len();
        let could_be_journal = if early.len() <= n { JOURNAL_REQUEST_PREFIX.starts_with(&early[..]) } else { early.starts_with(JOURNAL_REQUEST_PREFIX) };
        if !could_be_journal {
            return RequestHead::Forward;
        }
        if line_end.is_some() || early.len() >= REQUEST_HEAD_CAP {
            let line = &early[..line_end.unwrap_or(early.len())];
            let line = line.strip_suffix(b"\r").unwrap_or(line);
            // `HTTP/1.` plus exactly one version digit.
            let is_journal = line.len() == n + 1 && line.starts_with(JOURNAL_REQUEST_PREFIX) && line[n].is_ascii_digit();
            return if is_journal { RequestHead::Journal } else { RequestHead::Forward };
        }
        match tokio::time::timeout_at(deadline, tcp_read.read(&mut chunk)).await {
            Ok(Ok(read)) if read > 0 => early.extend_from_slice(&chunk[..read]),
            _ => return RequestHead::Closed,
        }
    }
}

/// Splice one accepted TCP connection onto a bi-stream of the shared connection.
/// While the stream is being opened (possibly behind a long dial) the socket is
/// watched: a peer that already closed it, such as a request the page aborted,
/// must not stay parked until the dial ends. Bytes it sent meanwhile are kept
/// and written first.
async fn forward(tcp: TcpStream, tunnel: &Tunnel) -> Result<(), BoxError> {
    use tokio::io::AsyncReadExt;
    let (mut tcp_read, mut tcp_write) = tokio::io::split(tcp);
    let mut early: Vec<u8> = Vec::new();
    // A journal request that opens a fresh connection is answered here, before any
    // dial: it must be readable exactly when the PC is unreachable, and reading it
    // must not start a connect. A request on a reused keep-alive connection never
    // gets here, which is why the page reads the dedicated journal port instead.
    match read_request_head(&mut tcp_read, &mut early).await {
        RequestHead::Closed => return Ok(()),
        RequestHead::Journal => {
            let body = tunnel.journal.snapshot_json(ms_of((tunnel.clock)()));
            let head = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            tokio::io::AsyncWriteExt::write_all(&mut tcp_write, head.as_bytes()).await?;
            tokio::io::AsyncWriteExt::write_all(&mut tcp_write, body.as_bytes()).await?;
            tokio::io::AsyncWriteExt::shutdown(&mut tcp_write).await?;
            // Unread request bytes at close would reset the socket and could
            // cut the response off, so the rest of the request is read out.
            let mut sink = [0u8; 1024];
            while let Ok(Ok(n)) = tokio::time::timeout(Duration::from_secs(1), tcp_read.read(&mut sink)).await {
                if n == 0 {
                    break;
                }
            }
            return Ok(());
        }
        RequestHead::Forward => {}
    }
    let (mut send, mut recv) = {
        let open = tunnel.open_stream();
        tokio::pin!(open);
        let mut chunk = [0u8; 8192];
        loop {
            // Past the cap reading stops (TCP backpressure holds the rest)
            // and only the stream result is awaited.
            let can_read = early.len() < EARLY_BUFFER_CAP;
            tokio::select! {
                opened = &mut open => break opened?,
                read = tcp_read.read(&mut chunk), if can_read => match read {
                    Ok(0) | Err(_) => return Ok(()),
                    Ok(n) => early.extend_from_slice(&chunk[..n]),
                },
            }
        }
    };
    let _open = StreamGauge::new(&tunnel.open_streams);
    if !early.is_empty() {
        send.write_all(&early).await?;
    }
    let up = async {
        tokio::io::copy(&mut tcp_read, &mut send).await?;
        tokio::io::AsyncWriteExt::shutdown(&mut send).await
    };
    let down = async {
        // The first answer byte is timed: a request nobody answers within
        // `slow_stream_after` is journaled with the connection's counters, which
        // say whether the PC's datagrams still arrive and whether it
        // acknowledges what this side sends (`Tunnel::note_slow_stream`).
        let mut first = [0u8; 8192];
        let n = tokio::select! {
            read = tokio::io::AsyncReadExt::read(&mut recv, &mut first) => read?,
            () = tokio::time::sleep(tunnel.slow_stream_after) => {
                tunnel.note_slow_stream().await;
                tokio::io::AsyncReadExt::read(&mut recv, &mut first).await?
            }
        };
        if n > 0 {
            tokio::io::AsyncWriteExt::write_all(&mut tcp_write, &first[..n]).await?;
            tokio::io::copy(&mut recv, &mut tcp_write).await?;
        }
        tokio::io::AsyncWriteExt::shutdown(&mut tcp_write).await
    };
    tokio::try_join!(up, down)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::iroh_tunnel::{Rebuild, ALPN};
    use crate::test_support::*;
    use iroh::endpoint::{presets, VarInt};
    use iroh::Endpoint;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// A socket the WebView already closed must not stay parked behind the
    /// connection lock while a dial runs.
    #[tokio::test]
    async fn a_socket_closed_while_waiting_for_the_stream_ends_its_forward_task() {
        let (server, _) = pong_server().await;
        let (tunnel, _) = tunnel_to(server).await;
        let held = tunnel.conn.lock().await;
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let mut client = TcpStream::connect(("127.0.0.1", port)).await.expect("connect");
        let (served, _) = listener.accept().await.expect("accept");
        let t = tunnel.clone();
        let task = tokio::spawn(async move { forward(served, &t).await });
        client.write_all(b"PI").await.expect("send");
        tokio::time::sleep(Duration::from_millis(100)).await;
        drop(client);
        let ended = tokio::time::timeout(Duration::from_secs(2), task).await;
        assert!(ended.is_ok(), "forward still parked on the held lock after the peer closed");
        drop(held);
    }

    /// Bytes sent before the stream opens are written first once it does.
    #[tokio::test]
    async fn bytes_written_before_the_stream_opens_still_arrive() {
        let (server, _) = pong_server().await;
        let (tunnel, port) = tunnel_to(server).await;
        let held = tunnel.conn.lock().await;
        let mut sock = TcpStream::connect(("127.0.0.1", port)).await.expect("connect");
        sock.write_all(b"PING").await.expect("send");
        tokio::time::sleep(Duration::from_millis(200)).await;
        drop(held);
        let mut reply = vec![0u8; 4];
        tokio::time::timeout(Duration::from_secs(10), sock.read_exact(&mut reply)).await.expect("timed out").expect("read");
        assert_eq!(&reply, b"PONG");
    }

    /// A request the PC never answers leaves a `stream_slow` line carrying the
    /// connection's counters, and a late answer still reaches the page whole.
    #[tokio::test]
    async fn a_request_unanswered_past_the_slow_mark_is_journaled_with_counters_and_still_answered_later() {
        let server = Endpoint::builder(presets::Minimal).alpns(vec![ALPN.to_vec()]).bind().await.expect("server bind");
        let addr = server.addr();
        tokio::spawn(async move {
            while let Some(incoming) = server.accept().await {
                tokio::spawn(async move {
                    let Ok(conn) = incoming.await else { return };
                    while let Ok((mut send, mut recv)) = conn.accept_bi().await {
                        tokio::spawn(async move {
                            let mut got = vec![0u8; 4];
                            recv.read_exact(&mut got).await.expect("read");
                            tokio::time::sleep(Duration::from_millis(900)).await;
                            send.write_all(b"PONG").await.expect("write");
                            send.finish().expect("finish");
                            // Keeps the stream's connection alive past the write.
                            tokio::time::sleep(Duration::from_secs(2)).await;
                        });
                    }
                });
            }
        });
        let client = Endpoint::builder(presets::Minimal).bind().await.expect("client bind");
        let (_tunnel, port, journal) = private_tunnel(client, addr, minimal_rebuild(), |t| t.slow_stream_after = Duration::from_millis(300)).await;
        let mut sock = TcpStream::connect(("127.0.0.1", port)).await.expect("connect");
        sock.write_all(b"PING").await.expect("send");
        let mut reply = vec![0u8; 4];
        tokio::time::timeout(Duration::from_secs(10), sock.read_exact(&mut reply)).await.expect("timed out").expect("read");
        assert_eq!(&reply, b"PONG", "the slow answer must still arrive intact");
        let json = journal.snapshot_json(0);
        assert_eq!(json.matches("\"k\":\"stream_slow\"").count(), 1, "{json}");
        assert!(json.contains("open=1 rx=") && json.contains(" sent=") && json.contains(" acked="), "{json}");
    }

    /// An answer inside the slow mark leaves no line.
    #[tokio::test]
    async fn a_prompt_answer_leaves_no_slow_line() {
        let (server, _) = pong_server().await;
        let client = Endpoint::builder(presets::Minimal).bind().await.expect("client bind");
        let (_tunnel, port, journal) = private_tunnel(client, server, minimal_rebuild(), |_| {}).await;
        ping(port).await;
        assert!(!journal.snapshot_json(0).contains("stream_slow"));
    }

    #[tokio::test]
    async fn forwards_a_request_and_response_over_iroh() {
        let (server, _) = pong_server().await;
        let (_tunnel, port) = tunnel_to(server).await;
        ping(port).await;
    }

    /// Reading the journal works while the PC is unreachable and never dials.
    #[tokio::test]
    async fn the_journal_is_served_from_the_loopback_port_without_any_dial() {
        let (server, accepted) = pong_server().await;
        let client = Endpoint::builder(presets::Minimal).bind().await.expect("client bind");
        let (_tunnel, port, _) = private_tunnel(client, server, minimal_rebuild(), |_| {}).await;
        assert_journal_response(&raw_exchange(port, &[b"GET /__tunnel/journal HTTP/1.1\r\nHost: x\r\n\r\n"]).await);
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(accepted.load(Ordering::SeqCst), 0, "reading the journal must not reach the PC");
    }

    #[tokio::test]
    async fn the_journal_is_served_when_every_dial_fails_and_triggers_none() {
        let (server, _) = pong_server().await;
        let dead = Endpoint::builder(presets::Minimal).bind().await.expect("client bind");
        dead.close().await;
        let rebinds = Arc::new(AtomicUsize::new(0));
        let counter = rebinds.clone();
        let rebuild: Rebuild = Box::new(move || {
            counter.fetch_add(1, Ordering::SeqCst);
            Box::pin(async { Err("no sockets".to_string()) })
        });
        let (_tunnel, port, _) = private_tunnel(dead, server, rebuild, |_| {}).await;
        assert_journal_response(&raw_exchange(port, &[b"GET /__tunnel/journal HTTP/1.0\r\n\r\n"]).await);
        assert_eq!(rebinds.load(Ordering::SeqCst), 0, "a dial would have rebound");
    }

    #[tokio::test]
    async fn a_journal_request_line_split_across_two_writes_is_still_recognised() {
        let (server, accepted) = pong_server().await;
        let client = Endpoint::builder(presets::Minimal).bind().await.expect("client bind");
        let (_tunnel, port, _) = private_tunnel(client, server, minimal_rebuild(), |_| {}).await;
        assert_journal_response(&raw_exchange(port, &[b"GET /__tun", b"nel/journal HTTP/1.1\r\n\r\n"]).await);
        assert_eq!(accepted.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn a_request_that_only_resembles_the_journal_is_forwarded() {
        let (server, accepted) = pong_server().await;
        let client = Endpoint::builder(presets::Minimal).bind().await.expect("client bind");
        let (_tunnel, port, _) = private_tunnel(client, server, minimal_rebuild(), |_| {}).await;
        let mut sock = TcpStream::connect(("127.0.0.1", port)).await.expect("connect");
        // Not the journal path, and only four bytes: the PC's stub replies after exactly "PING".
        sock.write_all(b"PING").await.expect("send");
        let mut reply = vec![0u8; 4];
        tokio::time::timeout(Duration::from_secs(10), sock.read_exact(&mut reply)).await.expect("timed out").expect("read");
        assert_eq!(&reply, b"PONG");
        assert_eq!(accepted.load(Ordering::SeqCst), 1);
    }

    /// Why the journal has a port of its own: the WebView reuses a keep-alive
    /// connection that is already spliced to a stream to the PC, and the tunnel
    /// only looks at the first request of a connection. A journal request that
    /// rides such a connection is not answered locally.
    #[tokio::test]
    async fn a_journal_request_on_a_reused_main_port_connection_is_not_answered_locally() {
        let (server, accepted) = pong_server().await;
        let (_tunnel, port) = tunnel_to(server).await;
        let mut sock = TcpStream::connect(("127.0.0.1", port)).await.expect("connect");
        sock.write_all(b"PING").await.expect("send");
        let mut reply = vec![0u8; 4];
        sock.read_exact(&mut reply).await.expect("read reply");
        assert_eq!(&reply, b"PONG");
        // The second request on the same connection; a write error is fine, the splice may be closed.
        let _ = sock.write_all(b"GET /__tunnel/journal HTTP/1.1\r\nHost: x\r\n\r\n").await;
        let mut rest = Vec::new();
        let _ = tokio::time::timeout(Duration::from_secs(2), sock.read_to_end(&mut rest)).await;
        let rest = String::from_utf8_lossy(&rest);
        assert!(!rest.contains("\"v\":1") && !rest.contains("HTTP/1.1 200"), "answered locally: {rest}");
        assert_eq!(accepted.load(Ordering::SeqCst), 1, "only the first request dialed the PC; the second rode its stream");
    }

    #[tokio::test]
    async fn the_stream_gauge_is_one_while_a_request_is_in_flight_and_zero_after_the_socket_closes() {
        let (server, _) = pong_server().await;
        let (tunnel, port) = tunnel_to(server).await;
        assert_eq!(tunnel.open_streams.load(Ordering::SeqCst), 0);
        let mut sock = TcpStream::connect(("127.0.0.1", port)).await.expect("connect");
        sock.write_all(b"PING").await.expect("send");
        let mut reply = vec![0u8; 4];
        sock.read_exact(&mut reply).await.expect("read");
        assert_eq!(tunnel.open_streams.load(Ordering::SeqCst), 1, "the socket is still open");
        drop(sock);
        for _ in 0..100 {
            if tunnel.open_streams.load(Ordering::SeqCst) == 0 {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("the gauge stayed above zero after the socket closed");
    }

    /// A forward that ends in an error releases its stream too.
    #[tokio::test]
    async fn the_stream_gauge_returns_to_zero_when_the_forward_ends_by_error() {
        let server = Endpoint::builder(presets::Minimal).alpns(vec![ALPN.to_vec()]).bind().await.expect("server bind");
        let addr = server.addr();
        tokio::spawn(async move {
            while let Some(incoming) = server.accept().await {
                tokio::spawn(async move {
                    let Ok(conn) = incoming.await else { return };
                    while let Ok((mut send, _recv)) = conn.accept_bi().await {
                        send.reset(VarInt::from_u32(7)).ok();
                    }
                });
            }
        });
        let client = Endpoint::builder(presets::Minimal).bind().await.expect("client bind");
        let tunnel = Arc::new(Tunnel::new(client, addr, minimal_rebuild()));
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let mut sock = TcpStream::connect(("127.0.0.1", port)).await.expect("connect");
        let (served, _) = listener.accept().await.expect("accept");
        sock.write_all(b"PING").await.expect("send");
        let result = tokio::time::timeout(Duration::from_secs(10), forward(served, &tunnel)).await.expect("forward finished");
        assert!(result.is_err(), "the PC reset the stream, so the forward errors");
        assert_eq!(tunnel.open_streams.load(Ordering::SeqCst), 0);
        drop(sock);
    }
}
