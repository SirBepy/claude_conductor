//! Iroh client half of the remote-access tunnel, serving a fixed loopback port.
//! Inverts `src-tauri/src/daemon/iroh_tunnel.rs::forward`: the daemon splices a
//! QUIC bi-stream onto a fresh TCP connection, here it is the other way round.

use iroh::endpoint::presets;
use iroh::{Endpoint, EndpointAddr, EndpointId};
use log::{error, info};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Mutex;

/// Must match `src-tauri/src/daemon/iroh_tunnel.rs::ALPN` exactly.
const ALPN: &[u8] = b"conductor/remote/0";

/// Fixed, not ephemeral: the SPA's `rc_token` lives in this origin's
/// localStorage, so a rotating port would force a re-pair every launch.
pub const LOOPBACK_PORT: u16 = 27184;

/// Holds the port once the tunnel is up, so a second `start_iroh_tunnel`
/// call short-circuits instead of binding twice or leaking a task.
#[derive(Default)]
pub struct IrohTunnelState(Mutex<Option<u16>>);

#[tauri::command]
pub async fn start_iroh_tunnel(
    state: tauri::State<'_, IrohTunnelState>,
    endpoint_id: String,
) -> Result<u16, String> {
    let mut running = state.0.lock().await;
    if let Some(port) = *running {
        return Ok(port);
    }

    let remote_id: EndpointId = endpoint_id.parse().map_err(|e| {
        let msg = format!("bad endpoint id: {e}");
        error!("{}", msg);
        msg
    })?;
    let endpoint = Endpoint::builder(presets::N0)
        .alpns(vec![ALPN.to_vec()])
        .bind()
        .await
        .map_err(|e| {
            let msg = format!("iroh bind failed: {e}");
            error!("{}", msg);
            msg
        })?;
    let listener = TcpListener::bind(("127.0.0.1", LOOPBACK_PORT))
        .await
        .map_err(|e| {
            let msg = format!("loopback bind failed at port {}: {}", LOOPBACK_PORT, e);
            error!("{}", msg);
            msg
        })?;

    info!("iroh tunnel listener successfully bound on 127.0.0.1:{}", LOOPBACK_PORT);
    // A bare EndpointAddr (id only, no direct addrs) makes each connect() go
    // through the N0 preset's pkarr lookup, matching the desktop's ticket.
    tokio::spawn(accept_loop(listener, endpoint, remote_id.into()));
    *running = Some(LOOPBACK_PORT);
    Ok(LOOPBACK_PORT)
}

async fn accept_loop(listener: TcpListener, endpoint: Endpoint, remote: EndpointAddr) {
    loop {
        match listener.accept().await {
            Ok((tcp, _)) => {
                let endpoint = endpoint.clone();
                let remote = remote.clone();
                tokio::spawn(async move {
                    if let Err(e) = forward(tcp, endpoint, remote).await {
                        error!("tunnel forward error: {}", e);
                    }
                });
            }
            Err(e) => {
                error!("tunnel listener accept failed: {}", e);
                // Don't continue in a tight loop if accept keeps failing
                tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
            }
        }
    }
}

/// Splice one accepted TCP connection onto a fresh QUIC bi-stream.
async fn forward(
    tcp: TcpStream,
    endpoint: Endpoint,
    remote: EndpointAddr,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let conn = endpoint.connect(remote, ALPN).await?;
    let (mut send, mut recv) = conn.open_bi().await?;
    let (mut tcp_read, mut tcp_write) = tokio::io::split(tcp);
    let up = async {
        tokio::io::copy(&mut tcp_read, &mut send).await?;
        tokio::io::AsyncWriteExt::shutdown(&mut send).await
    };
    let down = async {
        tokio::io::copy(&mut recv, &mut tcp_write).await?;
        tokio::io::AsyncWriteExt::shutdown(&mut tcp_write).await
    };
    tokio::try_join!(up, down)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Pins the wire byte value, since src-tauri has its own copy of this
    /// constant in a separate cargo workspace with no shared crate.
    #[test]
    fn alpn_matches_desktop_copy() {
        assert_eq!(ALPN, b"conductor/remote/0");
    }

    /// `Minimal` + a full `EndpointAddr` means no relay and no address lookup,
    /// so this runs offline.
    #[tokio::test]
    async fn forwards_a_request_and_response_over_iroh() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let server = Endpoint::builder(presets::Minimal)
            .alpns(vec![ALPN.to_vec()])
            .bind()
            .await
            .expect("server bind");
        let server_addr = server.addr();
        // Keeps `conn` alive past the reply write, unlike a one-shot task -
        // dropping it early resets the stream before PONG reaches the client.
        tokio::spawn(async move {
            let incoming = server.accept().await.expect("incoming");
            let conn = incoming.await.expect("handshake");
            loop {
                let Ok((mut send, mut recv)) = conn.accept_bi().await else {
                    break;
                };
                let mut got = vec![0u8; 4];
                recv.read_exact(&mut got).await.expect("read");
                assert_eq!(&got, b"PING");
                send.write_all(b"PONG").await.expect("write");
                send.finish().expect("finish");
            }
        });

        let client = Endpoint::builder(presets::Minimal).bind().await.expect("client bind");

        let listener = TcpListener::bind(("127.0.0.1", 0)).await.expect("bind");
        let port = listener.local_addr().expect("addr").port();
        tokio::spawn(accept_loop(listener, client, server_addr));

        let mut sock = TcpStream::connect(("127.0.0.1", port)).await.expect("connect");
        sock.write_all(b"PING").await.expect("send");

        let mut reply = vec![0u8; 4];
        sock.read_exact(&mut reply).await.expect("read reply");
        assert_eq!(&reply, b"PONG", "the iroh peer's response must reach the loopback client");
    }
}
