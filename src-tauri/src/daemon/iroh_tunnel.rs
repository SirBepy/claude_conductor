//! iroh tunnel to the remote-access server - the Tailscale replacement.
//!
//! Each accepted QUIC bi-stream is spliced onto a fresh TCP connection to
//! `127.0.0.1:27183`, so auth and the never-public bind are both unchanged.

use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

use iroh::endpoint::presets;
use iroh::{Endpoint, EndpointId, SecretKey};

use crate::daemon::device_registry::DeviceRegistry;
use crate::daemon::remote_server::REMOTE_PORT;
use crate::util::to_hex;

/// ALPN for the forwarded remote-access stream. Bump the suffix on any wire
/// change so an old phone build fails the handshake instead of misparsing.
pub const ALPN: &[u8] = b"conductor/remote/0";

fn key_file(app_data: &Path) -> PathBuf {
    app_data.join("iroh-endpoint-key.txt")
}

/// Load the persisted endpoint secret, minting one on first run. The key is
/// what keeps the EndpointId stable across restarts; without it every daemon
/// launch would strand already-paired phones on a dead id.
fn load_or_create_secret(app_data: &Path) -> SecretKey {
    let path = key_file(app_data);
    if let Ok(text) = std::fs::read_to_string(&path) {
        match text.trim().parse::<SecretKey>() {
            Ok(key) => return key,
            Err(e) => log::warn!("iroh tunnel: unreadable key at {}: {e}; minting a new one", path.display()),
        }
    }
    let key = SecretKey::generate();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    // `SecretKey` has no `Display`, and `FromStr` requires 64 lowercase hex chars.
    if let Err(e) = std::fs::write(&path, to_hex(&key.to_bytes())) {
        log::warn!("iroh tunnel: could not persist key to {}: {e}; the endpoint id will change on restart", path.display());
    }
    key
}

/// Handle to the running tunnel. `endpoint_id` is `None` until the bind
/// completes (or forever, if the tunnel is disabled or the bind failed).
#[derive(Default)]
pub struct IrohTunnel {
    endpoint: RwLock<Option<Endpoint>>,
}

impl IrohTunnel {
    pub fn endpoint_id(&self) -> Option<EndpointId> {
        self.endpoint.read().ok()?.as_ref().map(|ep| ep.id())
    }

    /// The string a phone needs to dial this daemon. n0 address lookup resolves
    /// a bare endpoint id to its current addresses, so no host or port travels
    /// with it.
    pub fn ticket(&self) -> Option<String> {
        self.endpoint_id().map(|id| id.to_string())
    }
}

/// Start the tunnel. Best-effort like `remote_server::spawn`. Gated on the
/// remote-access toggle so a user who never enabled it publishes nothing to
/// n0's address-lookup service.
pub fn spawn(app_data: PathBuf) -> Arc<IrohTunnel> {
    let tunnel = Arc::new(IrohTunnel::default());
    if !DeviceRegistry::is_enabled(&app_data) {
        log::info!("iroh tunnel: remote access is disabled; not binding an endpoint");
        return tunnel;
    }
    let handle = tunnel.clone();
    tokio::spawn(async move {
        let secret = load_or_create_secret(&app_data);
        let endpoint = match Endpoint::builder(presets::N0)
            .secret_key(secret)
            .alpns(vec![ALPN.to_vec()])
            .bind()
            .await
        {
            Ok(ep) => ep,
            Err(e) => {
                log::warn!("iroh tunnel: bind failed: {e}; tunnel disabled this run");
                return;
            }
        };
        if let Ok(mut slot) = handle.endpoint.write() {
            *slot = Some(endpoint.clone());
        }
        match handle.ticket() {
            Some(t) => log::info!("iroh tunnel: listening as {t} -> 127.0.0.1:{REMOTE_PORT}"),
            None => log::warn!("iroh tunnel: bound but the endpoint id is unreadable"),
        }
        accept_loop(endpoint, REMOTE_PORT).await;
    });
    tunnel
}

/// `target_port` is always `REMOTE_PORT` in production; tests pass an ephemeral
/// port because 27183 belongs to the live daemon on a dev machine.
async fn accept_loop(endpoint: Endpoint, target_port: u16) {
    while let Some(incoming) = endpoint.accept().await {
        tokio::spawn(async move {
            let conn = match incoming.await {
                Ok(c) => c,
                Err(e) => {
                    log::debug!("iroh tunnel: handshake failed: {e}");
                    return;
                }
            };
            let remote = conn.remote_id();
            log::info!("iroh tunnel: connection from {remote}");
            loop {
                match conn.accept_bi().await {
                    Ok((send, recv)) => {
                        tokio::spawn(async move {
                            if let Err(e) = forward(send, recv, target_port).await {
                                log::debug!("iroh tunnel: stream ended: {e}");
                            }
                        });
                    }
                    Err(e) => {
                        log::debug!("iroh tunnel: connection from {remote} closed: {e}");
                        return;
                    }
                }
            }
        });
    }
    log::warn!("iroh tunnel: accept loop ended");
}

/// Splice one QUIC bi-stream onto a fresh loopback TCP connection.
async fn forward(
    mut send: iroh::endpoint::SendStream,
    mut recv: iroh::endpoint::RecvStream,
    target_port: u16,
) -> std::io::Result<()> {
    let tcp = tokio::net::TcpStream::connect(("127.0.0.1", target_port)).await?;
    let (mut tcp_read, mut tcp_write) = tokio::io::split(tcp);
    let up = async {
        tokio::io::copy(&mut recv, &mut tcp_write).await?;
        tokio::io::AsyncWriteExt::shutdown(&mut tcp_write).await
    };
    let down = async {
        tokio::io::copy(&mut tcp_read, &mut send).await?;
        tokio::io::AsyncWriteExt::shutdown(&mut send).await
    };
    tokio::try_join!(up, down)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secret_key_round_trips_through_disk() {
        let dir = tempfile::tempdir().expect("tempdir");
        let first = load_or_create_secret(dir.path());
        let second = load_or_create_secret(dir.path());
        assert_eq!(
            first.public(),
            second.public(),
            "endpoint id must survive a restart, else paired phones are stranded"
        );
    }

    #[test]
    fn corrupt_key_file_mints_a_fresh_one() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(key_file(dir.path()), "not-a-key").expect("write");
        let key = load_or_create_secret(dir.path());
        let reloaded = load_or_create_secret(dir.path());
        assert_eq!(key.public(), reloaded.public(), "the replacement key must persist");
    }

    /// Bytes written over iroh must reach the loopback TCP server and its reply
    /// must come back. `Minimal` + an explicit `EndpointAddr` means no relay and
    /// no address lookup, so this runs offline.
    #[tokio::test]
    async fn forwards_a_request_and_response_over_iroh() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.expect("bind");
        let port = listener.local_addr().expect("addr").port();
        tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.expect("accept");
            let mut got = vec![0u8; 4];
            sock.read_exact(&mut got).await.expect("read");
            assert_eq!(&got, b"PING");
            sock.write_all(b"PONG").await.expect("write");
            sock.shutdown().await.expect("shutdown");
        });

        let server = Endpoint::builder(presets::Minimal)
            .alpns(vec![ALPN.to_vec()])
            .bind()
            .await
            .expect("server bind");
        let server_addr = server.addr();
        tokio::spawn(accept_loop(server, port));

        let client = Endpoint::builder(presets::Minimal).bind().await.expect("client bind");
        let conn = client.connect(server_addr, ALPN).await.expect("connect");
        let (mut send, mut recv) = conn.open_bi().await.expect("open_bi");
        send.write_all(b"PING").await.expect("send");
        send.finish().expect("finish");

        let reply = recv.read_to_end(1024).await.expect("read reply");
        assert_eq!(&reply, b"PONG", "the loopback server's response must reach the iroh peer");
    }
}
