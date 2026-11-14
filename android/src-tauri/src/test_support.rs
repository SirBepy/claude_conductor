//! Helpers shared by the tunnel's test modules: an offline PING/PONG peer, a UDP
//! gate that can silence it, and a few loopback clients.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use iroh::endpoint::presets;
use iroh::{Endpoint, EndpointAddr, EndpointId};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use crate::forward::accept_loop;
use crate::iroh_tunnel::{Rebuild, Tunnel, ALPN};
use crate::journal::Journal;

pub(crate) fn id(seed: u8) -> EndpointId {
    iroh::SecretKey::from_bytes(&[seed; 32]).public()
}

/// Echo-style PING/PONG peer that counts accepted QUIC connections.
/// `Minimal` + a full `EndpointAddr` means no relay and no address lookup,
/// so this runs offline.
pub(crate) async fn pong_server() -> (EndpointAddr, Arc<AtomicUsize>) {
    let server = Endpoint::builder(presets::Minimal)
        .alpns(vec![ALPN.to_vec()])
        .bind()
        .await
        .expect("server bind");
    let addr = server.addr();
    let accepted = Arc::new(AtomicUsize::new(0));
    let counter = accepted.clone();
    tokio::spawn(async move {
        while let Some(incoming) = server.accept().await {
            let counter = counter.clone();
            // One task per dial, as the daemon does: a dial the client
            // abandoned mid-handshake would otherwise hold up every dial
            // behind it until its handshake times out.
            tokio::spawn(async move {
                let Ok(conn) = incoming.await else { return };
                counter.fetch_add(1, Ordering::SeqCst);
                // `conn` stays alive past the reply write: dropping it early
                // resets the stream before PONG lands.
                while let Ok((mut send, mut recv)) = conn.accept_bi().await {
                    tokio::spawn(async move {
                        let mut got = vec![0u8; 4];
                        recv.read_exact(&mut got).await.expect("read");
                        assert_eq!(&got, b"PING");
                        send.write_all(b"PONG").await.expect("write");
                        send.finish().expect("finish");
                    });
                }
            });
        }
    });
    (addr, accepted)
}

pub(crate) async fn tunnel_to(server: EndpointAddr) -> (Arc<Tunnel>, u16) {
    let client = Endpoint::builder(presets::Minimal).bind().await.expect("client bind");
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.expect("bind");
    let port = listener.local_addr().expect("addr").port();
    let tunnel = Arc::new(Tunnel::new(client, server, minimal_rebuild()));
    tokio::spawn(accept_loop(listener, tunnel.clone()));
    (tunnel, port)
}

pub(crate) fn minimal_rebuild() -> Rebuild {
    Box::new(|| Box::pin(async { Endpoint::builder(presets::Minimal).bind().await.map_err(|e| e.to_string()) }))
}

/// The UDP port the endpoint's socket is bound to. `ip_addrs()` lists one entry
/// per interface, all on that port, plus a public address learned from the
/// outside whose port is the NAT's mapping, not a port bound here (nothing
/// listens on it over loopback). The set is unordered, so taking the first
/// IPv4 entry picked the mapped one about half the time. The bound port is
/// the one most entries share.
pub(crate) fn local_v4_port(addr: &EndpointAddr) -> u16 {
    let mut seen: std::collections::HashMap<u16, usize> = Default::default();
    for a in addr.ip_addrs().filter(|a| a.is_ipv4()) {
        *seen.entry(a.port()).or_default() += 1;
    }
    let best = seen.values().max().copied().expect("server v4 addr");
    // With one entry per port there is no majority: prefer a private address.
    let ports: Vec<u16> = seen.iter().filter(|(_, n)| **n == best).map(|(p, _)| *p).collect();
    if let [only] = ports[..] {
        return only;
    }
    addr.ip_addrs()
        .find(|a| matches!(a, std::net::SocketAddr::V4(v) if v.ip().is_private() || v.ip().is_loopback()))
        .or_else(|| addr.ip_addrs().find(|a| a.is_ipv4()))
        .expect("server v4 addr")
        .port()
}

/// Forwards UDP between a loopback front port and `target`, dropping every
/// datagram while `open` is false: a PC nobody answers for, until opened.
///
/// Each client address gets its own socket towards `target`, like a NAT: the
/// abandoned endpoint keeps sending for a moment after the fresh one starts,
/// and with one shared return route the PC's replies would go to whichever
/// of the two spoke last.
pub(crate) async fn udp_gate(target: std::net::SocketAddr, open: Arc<std::sync::atomic::AtomicBool>) -> std::net::SocketAddr {
    let front = Arc::new(tokio::net::UdpSocket::bind(("127.0.0.1", 0)).await.expect("front"));
    let front_addr = front.local_addr().expect("addr");
    tokio::spawn(async move {
        let mut routes: std::collections::HashMap<std::net::SocketAddr, Arc<tokio::net::UdpSocket>> = Default::default();
        let mut buf = [0u8; 2048];
        loop {
            // On Windows a reply sent to a port that has just closed (the
            // abandoned endpoint) comes back as a connection-reset error on
            // the next receive. The socket is still good, so it is skipped.
            let Ok((n, from)) = front.recv_from(&mut buf).await else {
                tokio::task::yield_now().await;
                continue;
            };
            if !open.load(Ordering::SeqCst) {
                continue;
            }
            let back = match routes.get(&from) {
                Some(back) => back.clone(),
                None => {
                    let back = Arc::new(tokio::net::UdpSocket::bind(("127.0.0.1", 0)).await.expect("back"));
                    back.connect(target).await.expect("connect");
                    routes.insert(from, back.clone());
                    let (replies, front) = (back.clone(), front.clone());
                    tokio::spawn(async move {
                        let mut buf = [0u8; 2048];
                        loop {
                            match replies.recv(&mut buf).await {
                                Ok(n) => drop(front.send_to(&buf[..n], from).await),
                                Err(_) => tokio::task::yield_now().await,
                            }
                        }
                    });
                    back
                }
            };
            let _ = back.send(&buf[..n]).await;
        }
    });
    front_addr
}

pub(crate) async fn ping(port: u16) {
    let mut sock = TcpStream::connect(("127.0.0.1", port)).await.expect("connect");
    sock.write_all(b"PING").await.expect("send");
    let mut reply = vec![0u8; 4];
    sock.read_exact(&mut reply).await.expect("read reply");
    assert_eq!(&reply, b"PONG", "the iroh peer's response must reach the loopback client");
}

/// A tunnel on a loopback port with a journal of its own, so a test reads
/// only what it caused. `edit` can swap the clock or the rebuild closure.
pub(crate) async fn private_tunnel(client: Endpoint, server: EndpointAddr, rebuild: Rebuild, edit: impl FnOnce(&mut Tunnel)) -> (Arc<Tunnel>, u16, Arc<Journal>) {
    let journal = Arc::new(Journal::new());
    let mut tunnel = Tunnel::new(client, server, rebuild);
    tunnel.journal = journal.clone();
    edit(&mut tunnel);
    let tunnel = Arc::new(tunnel);
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.expect("bind");
    let port = listener.local_addr().expect("addr").port();
    tokio::spawn(accept_loop(listener, tunnel.clone()));
    (tunnel, port, journal)
}

/// Writes `chunks` (pausing between them) and reads until the server closes.
pub(crate) async fn raw_exchange(port: u16, chunks: &[&[u8]]) -> String {
    let mut sock = TcpStream::connect(("127.0.0.1", port)).await.expect("connect");
    for (i, chunk) in chunks.iter().enumerate() {
        if i > 0 {
            tokio::time::sleep(Duration::from_millis(150)).await;
        }
        sock.write_all(chunk).await.expect("send");
    }
    let mut out = Vec::new();
    tokio::time::timeout(Duration::from_secs(5), sock.read_to_end(&mut out)).await.expect("timed out").expect("read");
    String::from_utf8_lossy(&out).into_owned()
}

pub(crate) fn assert_journal_response(reply: &str) {
    assert!(reply.starts_with("HTTP/1.1 200 OK\r\n"), "{reply}");
    assert!(reply.contains("Content-Type: application/json\r\n"), "{reply}");
    assert!(reply.contains("Cache-Control: no-store\r\n"), "{reply}");
    let body = reply.split("\r\n\r\n").nth(1).expect("body");
    assert!(body.starts_with("{\"v\":1"), "{body}");
    assert!(reply.contains(&format!("Content-Length: {}\r\n", body.len())), "{reply}");
}
