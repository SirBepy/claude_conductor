//! iroh tunnel to the remote-access server: how a phone or a paired machine
//! reaches this daemon from anywhere, peer-to-peer, with no port forwarding.
//!
//! Each accepted QUIC bi-stream is spliced onto a fresh TCP connection to
//! `127.0.0.1:27183`, so auth and the never-public bind are both unchanged.

use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

use iroh::endpoint::presets;
use iroh::{Endpoint, EndpointId, SecretKey};

use crate::daemon::device_registry::DeviceRegistry;
use crate::daemon::remote_server::resolve_port;
use crate::util::{secret_store, to_hex};

/// ALPN for the forwarded remote-access stream. Bump the suffix on any wire
/// change so an old phone build fails the handshake instead of misparsing.
pub const ALPN: &[u8] = b"conductor/remote/0";

/// Instance-scoped like `interactive_sessions_file`: a non-default instance
/// (test daemon, or a dev daemon serving a phone directly) must mint its own
/// endpoint identity, never share the production daemon's key file.
fn key_file(app_data: &Path) -> PathBuf {
    let suffix = crate::daemon::instance::instance_suffix();
    if suffix.is_empty() {
        app_data.join("iroh-endpoint-key.txt")
    } else {
        app_data.join(format!("iroh-endpoint-key{suffix}.txt"))
    }
}

/// Read and parse the persisted secret without ever creating or writing one.
/// Shared by `load_or_create_secret` and `endpoint_id_from_disk`, whose caller
/// (the app process) must never race the daemon's key creation.
fn read_secret(path: &Path) -> Option<SecretKey> {
    let text = std::fs::read_to_string(path).ok()?;
    secret_store::unprotect(text.trim()).ok()?.parse::<SecretKey>().ok()
}

/// Whoever reads this file can impersonate the daemon's endpoint id, so it
/// goes through `secret_store` like every other stored secret.
fn write_secret(path: &Path, key: &SecretKey) -> anyhow::Result<()> {
    // `SecretKey` has no `Display`, and `FromStr` requires 64 lowercase hex chars.
    let stored = secret_store::protect(&to_hex(&key.to_bytes()))?;
    crate::util::write_json_atomic(path, &stored)?;
    Ok(())
}

/// The public id of the daemon's persisted endpoint key, or `None` if the key
/// file doesn't exist yet or is unparseable. Read-only: this runs in the app
/// process, which must never create the key (that stays `load_or_create_secret`'s
/// job in the daemon process).
pub fn endpoint_id_from_disk(app_data: &Path) -> Option<EndpointId> {
    read_secret(&key_file(app_data)).map(|s| s.public())
}

/// Load the persisted endpoint secret, minting one on first run. The key is
/// what keeps the EndpointId stable across restarts; without it every daemon
/// launch would strand already-paired phones on a dead id.
pub(crate) fn load_or_create_secret(app_data: &Path) -> SecretKey {
    let path = key_file(app_data);
    if let Some(key) = read_secret(&path) {
        let legacy = std::fs::read_to_string(&path).is_ok_and(|t| secret_store::needs_migration(t.trim()));
        if legacy {
            if let Err(e) = write_secret(&path, &key) {
                log::warn!("iroh tunnel: could not wrap legacy plaintext key at {}: {e}", path.display());
            }
        }
        return key;
    }
    if path.exists() {
        // A wrapped key that will not unwrap (another Windows user, a copied
        // profile) may still be recoverable, so it is set aside, never
        // overwritten: restoring the .unreadable file restores the old id.
        let aside = secret_store::set_aside_unreadable(&path);
        log::warn!(
            "iroh tunnel: unreadable key at {}; minting a new one (old file {})",
            path.display(),
            match aside {
                Some(a) => format!("kept as {}", a.display()),
                None => "could not be set aside".to_string(),
            },
        );
    }
    let key = SecretKey::generate();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Err(e) = write_secret(&path, &key) {
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

/// How often the tunnel re-reads the remote-access switch. The switch lives in
/// `remote-devices.json`, written by the app process, so polling a small file
/// is what lets the toggle take effect without a daemon restart.
const SWITCH_POLL: std::time::Duration = std::time::Duration::from_secs(2);

/// After a failed bind, wait this long before retrying so an offline machine
/// doesn't log a bind warning every poll.
const BIND_RETRY: std::time::Duration = std::time::Duration::from_secs(60);

/// Start the tunnel. Best-effort like `remote_server::spawn`. Bound only while
/// the remote-access switch is on, so a user who never enabled it publishes
/// nothing to n0's address-lookup service; flipping it binds or closes the
/// endpoint within `SWITCH_POLL`.
pub fn spawn(app_data: PathBuf) -> Arc<IrohTunnel> {
    let tunnel = Arc::new(IrohTunnel::default());
    // Two daemons must never both advertise a tunnel for the same user, so a
    // non-default instance (dev daemon serving a phone directly) skips this
    // entirely; only the default instance's remote server gets tunneled.
    if !crate::daemon::instance::instance_suffix().is_empty() {
        log::info!("iroh tunnel: non-default daemon instance; not advertising a tunnel");
        return tunnel;
    }
    // Minted up front, even while switched off, so the app process can show a
    // pairing link (`endpoint_id_from_disk`) the moment the user flips the
    // switch on instead of waiting for the bind. A local file, nothing published.
    let secret = load_or_create_secret(&app_data);
    let handle = tunnel.clone();
    tokio::spawn(async move {
        let target_port = resolve_port();
        let mut announced_off = false;
        loop {
            let enabled = DeviceRegistry::is_enabled(&app_data);
            let bound = handle.endpoint.read().ok().and_then(|slot| slot.clone());
            match (enabled, bound) {
                (true, None) => {
                    announced_off = false;
                    match bind(secret.clone()).await {
                        Ok(endpoint) => {
                            if let Ok(mut slot) = handle.endpoint.write() {
                                *slot = Some(endpoint.clone());
                            }
                            log::info!("iroh tunnel: listening as {} -> 127.0.0.1:{target_port}", endpoint.id());
                            tokio::spawn(accept_loop(endpoint, target_port, Limits::default()));
                        }
                        Err(e) => {
                            log::warn!("iroh tunnel: bind failed: {e}; retrying in {}s", BIND_RETRY.as_secs());
                            tokio::time::sleep(BIND_RETRY).await;
                        }
                    }
                }
                (false, Some(endpoint)) => {
                    if let Ok(mut slot) = handle.endpoint.write() {
                        *slot = None;
                    }
                    // Ends `accept_loop` (accept() yields None) and drops every
                    // live phone/peer connection with it.
                    endpoint.close().await;
                    log::info!("iroh tunnel: remote access switched off; endpoint closed");
                }
                (false, None) if !announced_off => {
                    announced_off = true;
                    log::info!("iroh tunnel: remote access is off; not binding an endpoint");
                }
                _ => {}
            }
            tokio::time::sleep(SWITCH_POLL).await;
        }
    });
    tunnel
}

async fn bind(secret: SecretKey) -> Result<Endpoint, String> {
    Endpoint::builder(presets::N0)
        .secret_key(secret)
        .alpns(vec![ALPN.to_vec()])
        .bind()
        .await
        .map_err(|e| e.to_string())
}

/// Caps on what one iroh endpoint will carry. Anyone holding the endpoint id
/// can dial in, and every stream becomes a TCP connection plus a task on the
/// same four-worker runtime as the chat pumps, so an unbounded flood would
/// starve running chats. The caps count connections and open streams, never
/// request rate: a phone legitimately holds a few long-lived WebSocket streams
/// (global feed, a chat) for hours.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Limits {
    pub max_connections: usize,
    pub max_streams_per_connection: usize,
    /// A connection with no open stream for this long is closed. QUIC's own
    /// idle timeout never fires on a peer that keeps answering keep-alives.
    pub idle_without_streams: std::time::Duration,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_connections: 32,
            max_streams_per_connection: 64,
            idle_without_streams: std::time::Duration::from_secs(30 * 60),
        }
    }
}

/// Bounds a handshake that never completes, which would otherwise hold a
/// connection permit forever.
const HANDSHAKE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

/// QUIC application error code sent when a stream is refused for being over the cap.
const STREAM_REFUSED: u32 = 1;

/// `target_port` is always `REMOTE_PORT` in production; tests pass an ephemeral
/// port because 27183 belongs to the live daemon on a dev machine.
async fn accept_loop(endpoint: Endpoint, target_port: u16, limits: Limits) {
    let connections = Arc::new(tokio::sync::Semaphore::new(limits.max_connections));
    while let Some(incoming) = endpoint.accept().await {
        // Taken before the handshake so half-open attempts count too.
        let Ok(permit) = connections.clone().try_acquire_owned() else {
            log::warn!("iroh tunnel: connection cap ({}) reached; refusing a dial", limits.max_connections);
            incoming.refuse();
            continue;
        };
        tokio::spawn(async move {
            let _permit = permit;
            let conn = match tokio::time::timeout(HANDSHAKE_TIMEOUT, incoming).await {
                Ok(Ok(c)) => c,
                Ok(Err(e)) => {
                    log::debug!("iroh tunnel: handshake failed: {e}");
                    return;
                }
                Err(_) => {
                    log::debug!("iroh tunnel: handshake timed out");
                    return;
                }
            };
            let remote = conn.remote_id();
            log::info!("iroh tunnel: connection from {remote}");
            serve_connection(conn, target_port, limits).await;
            log::debug!("iroh tunnel: connection from {remote} done");
        });
    }
    log::info!("iroh tunnel: accept loop ended");
}

async fn serve_connection(conn: iroh::endpoint::Connection, target_port: u16, limits: Limits) {
    let streams = Arc::new(tokio::sync::Semaphore::new(limits.max_streams_per_connection));
    // Woken when a forwarded stream ends, so the idle clock re-arms even though
    // the loop is parked in `accept_bi`.
    let stream_ended = Arc::new(tokio::sync::Notify::new());
    let mut idle_since = Some(tokio::time::Instant::now());
    loop {
        // The idle clock only runs while no stream is open: a live WebSocket
        // stream keeps the connection, a bare connection does not.
        if streams.available_permits() == limits.max_streams_per_connection {
            idle_since.get_or_insert_with(tokio::time::Instant::now);
        } else {
            idle_since = None;
        }
        let deadline = async {
            match idle_since {
                Some(t) => tokio::time::sleep_until(t + limits.idle_without_streams).await,
                None => std::future::pending::<()>().await,
            }
        };
        let accepted = tokio::select! {
            r = conn.accept_bi() => r,
            _ = stream_ended.notified() => continue,
            _ = deadline => {
                log::info!("iroh tunnel: closing a connection with no streams");
                conn.close(iroh::endpoint::VarInt::from_u32(0), b"idle");
                return;
            }
        };
        let (mut send, mut recv) = match accepted {
            Ok(pair) => pair,
            Err(e) => {
                log::debug!("iroh tunnel: connection closed: {e}");
                return;
            }
        };
        let Ok(permit) = streams.clone().try_acquire_owned() else {
            log::warn!("iroh tunnel: stream cap ({}) reached; refusing a stream", limits.max_streams_per_connection);
            let code = iroh::endpoint::VarInt::from_u32(STREAM_REFUSED);
            let _ = send.reset(code);
            let _ = recv.stop(code);
            continue;
        };
        let stream_ended = stream_ended.clone();
        tokio::spawn(async move {
            if let Err(e) = forward(send, recv, target_port).await {
                log::debug!("iroh tunnel: stream ended: {e}");
            }
            // Released before the wake so the loop sees the freed slot.
            drop(permit);
            stream_ended.notify_one();
        });
    }
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

    /// Pins the wire byte value, since android/src-tauri has its own copy of this
    /// constant in a separate cargo workspace with no shared crate.
    #[test]
    fn alpn_matches_android_copy() {
        assert_eq!(ALPN, b"conductor/remote/0");
    }

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
    fn key_is_wrapped_on_disk_and_legacy_plaintext_migrates_in_place() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = key_file(dir.path());
        let fresh = load_or_create_secret(dir.path());
        let on_disk = std::fs::read_to_string(&path).expect("read");
        assert_eq!(secret_store::is_protected(&on_disk), secret_store::WRAPS_AT_REST);
        if secret_store::WRAPS_AT_REST {
            assert!(!on_disk.contains(&to_hex(&fresh.to_bytes())), "the raw key must not sit on disk");
        }

        std::fs::write(&path, to_hex(&fresh.to_bytes())).expect("write legacy");
        let migrated = load_or_create_secret(dir.path());
        assert_eq!(migrated.public(), fresh.public(), "migration must keep the endpoint id");
        let on_disk = std::fs::read_to_string(&path).expect("read");
        assert_eq!(secret_store::is_protected(&on_disk), secret_store::WRAPS_AT_REST);
        assert_eq!(endpoint_id_from_disk(dir.path()), Some(fresh.public()));
    }

    #[test]
    fn corrupt_key_file_mints_a_fresh_one() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(key_file(dir.path()), "not-a-key").expect("write");
        let key = load_or_create_secret(dir.path());
        let reloaded = load_or_create_secret(dir.path());
        assert_eq!(key.public(), reloaded.public(), "the replacement key must persist");
    }

    #[test]
    fn a_wrapped_key_that_will_not_unwrap_is_set_aside_not_overwritten() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = key_file(dir.path());
        let foreign = format!("{}not-decryptable-here", secret_store::PREFIX);
        std::fs::write(&path, &foreign).expect("write");
        load_or_create_secret(dir.path());
        let aside = std::fs::read_to_string(path.with_extension("unreadable")).expect("old file kept");
        assert_eq!(aside, foreign, "the unreadable key must survive for recovery");
    }

    #[test]
    fn a_second_unreadable_key_does_not_overwrite_the_first_aside() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = key_file(dir.path());
        let first = format!("{}first-blob", secret_store::PREFIX);
        let second = format!("{}second-blob", secret_store::PREFIX);
        std::fs::write(&path, &first).expect("write");
        load_or_create_secret(dir.path());
        std::fs::write(&path, &second).expect("write");
        load_or_create_secret(dir.path());
        let blobs: Vec<String> = std::fs::read_dir(dir.path())
            .expect("read_dir")
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains("unreadable"))
            .map(|e| std::fs::read_to_string(e.path()).expect("read"))
            .collect();
        assert!(blobs.contains(&first) && blobs.contains(&second), "both set-aside blobs must survive: {blobs:?}");
    }

    #[test]
    fn endpoint_id_from_disk_none_when_key_file_missing() {
        let dir = tempfile::tempdir().expect("tempdir");
        assert!(endpoint_id_from_disk(dir.path()).is_none());
        assert!(!key_file(dir.path()).exists(), "reading must never create the key");
    }

    #[test]
    fn endpoint_id_from_disk_none_for_corrupt_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(key_file(dir.path()), "not-a-key").expect("write");
        assert!(endpoint_id_from_disk(dir.path()).is_none());
    }

    #[test]
    fn endpoint_id_from_disk_matches_the_secret_it_reads() {
        let dir = tempfile::tempdir().expect("tempdir");
        let secret = load_or_create_secret(dir.path());
        let id = endpoint_id_from_disk(dir.path()).expect("key file now exists");
        assert_eq!(id, secret.public(), "must derive the same id the daemon would bind with");
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
        tokio::spawn(accept_loop(server, port, Limits::default()));

        let client = Endpoint::builder(presets::Minimal).bind().await.expect("client bind");
        let conn = client.connect(server_addr, ALPN).await.expect("connect");
        let (mut send, mut recv) = conn.open_bi().await.expect("open_bi");
        send.write_all(b"PING").await.expect("send");
        send.finish().expect("finish");

        let reply = recv.read_to_end(1024).await.expect("read reply");
        assert_eq!(&reply, b"PONG", "the loopback server's response must reach the iroh peer");
    }

    /// Loopback TCP server that echoes 4-byte chunks and holds each socket open,
    /// so a forwarded stream stays live (and keeps its permit) until the test
    /// drops the client side.
    async fn holding_echo_server() -> u16 {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.expect("bind");
        let port = listener.local_addr().expect("addr").port();
        tokio::spawn(async move {
            while let Ok((mut sock, _)) = listener.accept().await {
                tokio::spawn(async move {
                    let mut buf = [0u8; 4];
                    while sock.read_exact(&mut buf).await.is_ok() {
                        if sock.write_all(&buf).await.is_err() {
                            break;
                        }
                    }
                });
            }
        });
        port
    }

    async fn tunnel_pair(limits: Limits) -> (Endpoint, iroh::EndpointAddr) {
        let port = holding_echo_server().await;
        let server = Endpoint::builder(presets::Minimal)
            .alpns(vec![ALPN.to_vec()])
            .bind()
            .await
            .expect("server bind");
        let addr = server.addr();
        tokio::spawn(accept_loop(server, port, limits));
        let client = Endpoint::builder(presets::Minimal).bind().await.expect("client bind");
        (client, addr)
    }

    /// Opens a stream and proves it is forwarded by echoing 4 bytes. Returns
    /// the halves so the caller keeps the stream (and its server-side permit) alive.
    async fn open_live_stream(
        conn: &iroh::endpoint::Connection,
    ) -> Result<(iroh::endpoint::SendStream, iroh::endpoint::RecvStream), String> {
        let (mut send, mut recv) = conn.open_bi().await.map_err(|e| e.to_string())?;
        send.write_all(b"PING").await.map_err(|e| e.to_string())?;
        let mut got = [0u8; 4];
        recv.read_exact(&mut got).await.map_err(|e| e.to_string())?;
        assert_eq!(&got, b"PING");
        Ok((send, recv))
    }

    /// The N+1th concurrent stream on one connection is reset, a freed slot is
    /// reusable, and the earlier streams are unaffected.
    #[tokio::test]
    async fn refuses_the_stream_past_the_per_connection_cap() {
        let limits = Limits { max_streams_per_connection: 2, ..Limits::default() };
        let (client, addr) = tunnel_pair(limits).await;
        let conn = client.connect(addr, ALPN).await.expect("connect");

        let first = open_live_stream(&conn).await.expect("stream 1");
        let second = open_live_stream(&conn).await.expect("stream 2");
        assert!(open_live_stream(&conn).await.is_err(), "the 3rd concurrent stream must be refused");

        drop(first);
        // The server frees the permit once the dropped stream's forward ends;
        // poll instead of sleeping a fixed time.
        let mut reopened = None;
        for _ in 0..50 {
            if let Ok(s) = open_live_stream(&conn).await {
                reopened = Some(s);
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        assert!(reopened.is_some(), "a freed slot must be reusable");
        drop(second);
    }

    #[tokio::test]
    async fn refuses_the_connection_past_the_connection_cap() {
        let limits = Limits { max_connections: 1, ..Limits::default() };
        let (client, addr) = tunnel_pair(limits).await;
        let first = client.connect(addr.clone(), ALPN).await.expect("connect 1");
        let _live = open_live_stream(&first).await.expect("first connection is served");

        let second = tokio::time::timeout(std::time::Duration::from_secs(10), client.connect(addr, ALPN)).await;
        assert!(
            matches!(second, Ok(Err(_))),
            "the 2nd concurrent connection must be refused, got ok={}",
            matches!(second, Ok(Ok(_)))
        );
    }

    #[tokio::test]
    async fn closes_a_connection_that_never_opens_a_stream() {
        let limits = Limits { idle_without_streams: std::time::Duration::from_millis(300), ..Limits::default() };
        let (client, addr) = tunnel_pair(limits).await;
        let conn = client.connect(addr, ALPN).await.expect("connect");
        let closed = tokio::time::timeout(std::time::Duration::from_secs(10), conn.closed()).await;
        assert!(closed.is_ok(), "an idle, stream-less connection must be closed by the server");
    }

    /// The idle clock re-arms when the last stream ends, not only at connect.
    #[tokio::test]
    async fn closes_a_connection_idle_after_its_last_stream_ends() {
        let limits = Limits { idle_without_streams: std::time::Duration::from_millis(500), ..Limits::default() };
        let (client, addr) = tunnel_pair(limits).await;
        let conn = client.connect(addr, ALPN).await.expect("connect");
        let (send, recv) = open_live_stream(&conn).await.expect("stream");
        drop((send, recv));
        let closed = tokio::time::timeout(std::time::Duration::from_secs(10), conn.closed()).await;
        assert!(closed.is_ok(), "a connection whose last stream ended must still hit the idle timeout");
    }
}
