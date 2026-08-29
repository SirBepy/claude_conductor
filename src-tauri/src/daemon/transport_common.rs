//! Transport-neutral connection handler. The per-platform transports (named
//! pipe on Windows, Unix-domain socket on mac/Linux) only differ in how they
//! accept a connection; once a stream exists the handshake + request/notification
//! loop is identical, so it lives here generic over any `AsyncRead + AsyncWrite`.

use crate::daemon::frame::{read_frame, write_frame, FrameError};
use crate::daemon::handshake::{verify_handshake, HandshakeError};
use crate::daemon::rpc::{ConnectionContext, Message, Router};
use serde_json::{json, Value};
use std::io;
use tokio::io::{AsyncRead, AsyncWrite};

pub async fn serve_connection<S>(mut stream: S, router: Router) -> Result<(), FrameError>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    // 1. Handshake.
    let first = read_frame(&mut stream).await?;
    match verify_handshake(&first) {
        Err(HandshakeError::MissingField) => {
            let err = json!({
                "jsonrpc": "2.0", "id": null,
                "error": {"code": -32600, "message": "handshake missing protocol_version"}
            });
            write_frame(&mut stream, &err).await?;
            return Ok(());
        }
        Err(HandshakeError::VersionMismatch { client, daemon }) => {
            let err = json!({
                "jsonrpc": "2.0", "id": null,
                "error": {
                    "code": -32600,
                    "message": format!("protocol version mismatch: client {client}, daemon {daemon}")
                }
            });
            write_frame(&mut stream, &err).await?;
            return Ok(());
        }
        Ok(()) => {}
    }
    let hs_ok = json!({
        "handshake": "ok",
        "daemon_version": crate::daemon::health::DAEMON_VERSION,
        "protocol_version": crate::daemon::health::PROTOCOL_VERSION,
    });
    write_frame(&mut stream, &hs_ok).await?;

    // Per-connection outbound queue + context for attach_session subscriptions.
    let (tx, mut rx) = tokio::sync::mpsc::channel::<Value>(256);
    let ctx = ConnectionContext::new(tx);

    // 2. Request + notification loop, a stream half each. They must NOT share a
    // `select!`: `read_frame` is two `read_exact` calls, so cancelling it
    // mid-frame discards consumed bytes, and a frame's length and payload arrive
    // as separate writes - the reader parks between them constantly (todo 228).
    let (mut read_half, mut write_half) = tokio::io::split(stream);

    let writer = async {
        while let Some(notif) = rx.recv().await {
            // Dequeued: this frame is off the queue regardless of whether the
            // write below succeeds, so decrement before timing the write.
            ctx.outbound_depth.fetch_sub(1, std::sync::atomic::Ordering::Relaxed);
            let started = std::time::Instant::now();
            let write_result = write_frame(&mut write_half, &notif).await;
            crate::daemon::rpc::log_if_slow(
                started,
                "outbound send",
                format_args!(
                    "conn={} elapsed={:?} queue_depth={}",
                    ctx.conn_id,
                    started.elapsed(),
                    ctx.outbound_depth.load(std::sync::atomic::Ordering::Relaxed)
                ),
            );
            write_result?;
        }
        Ok::<(), FrameError>(())
    };

    let reader = async {
        loop {
            let frame = match read_frame(&mut read_half).await {
                Ok(f) => f,
                Err(FrameError::Io(e)) if e.kind() == io::ErrorKind::UnexpectedEof
                    || e.kind() == io::ErrorKind::BrokenPipe => return Ok(()),
                Err(e) => return Err(e),
            };
            let msg: Message = match serde_json::from_value(frame) {
                Ok(m) => m,
                Err(e) => {
                    // Through the outbound queue, never the stream: `writer`
                    // owns the write half now.
                    let err = json!({
                        "jsonrpc": "2.0", "id": null,
                        "error": {"code": -32700, "message": format!("parse error: {e}")}
                    });
                    let _ = ctx.send_outbound(err).await;
                    continue;
                }
            };
            match msg {
                Message::Request(req) => {
                    // Dispatch concurrently, response through the same outbound
                    // queue notifications use. Awaiting inline head-of-line
                    // blocked the connection: one slow handler stalled every
                    // other RPC and notification on it for seconds.
                    let router = router.clone();
                    let req_ctx = ctx.clone();
                    let out = ctx.clone();
                    tokio::spawn(async move {
                        let resp = router.dispatch(req, req_ctx).await;
                        match serde_json::to_value(resp) {
                            // Send fails only when the connection is already
                            // gone; the response has nowhere to go either way.
                            Ok(v) => { let _ = out.send_outbound(v).await; }
                            Err(e) => log::warn!("daemon: response serialize failed: {e}"),
                        }
                    });
                }
                Message::Notification(_) | Message::Response(_) => {
                    // Inbound notifications + stray responses are ignored.
                }
            }
        }
    };

    let exit_result: Result<(), FrameError> = tokio::select! {
        r = writer => r,
        r = reader => r,
    };

    // Cleanup: abort all per-session subscription tasks on disconnect.
    let mut subs = ctx.subscriptions.lock().await;
    for (_, handle) in subs.drain() {
        handle.abort();
    }
    drop(subs);

    exit_result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::health::PROTOCOL_VERSION;
    use std::time::Duration;
    use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt};

    /// One method that starts a notification firehose on the calling connection,
    /// so a test can park the reader mid-frame while frames stream the other way.
    fn firehose_router() -> Router {
        let mut router = Router::new();
        router.register("firehose", |_params, ctx: ConnectionContext| async move {
            tokio::spawn(async move {
                loop {
                    if ctx.send_outbound(json!({"method": "tick", "params": {}})).await.is_err() {
                        return;
                    }
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
            });
            Ok(json!({"ok": true}))
        });
        router
    }

    async fn handshake<S: AsyncRead + AsyncWrite + Unpin>(client: &mut S) {
        write_frame(client, &json!({"protocol_version": PROTOCOL_VERSION})).await.unwrap();
        let resp = read_frame(client).await.unwrap();
        assert_eq!(resp.get("handshake").and_then(Value::as_str), Some("ok"));
    }

    /// Read frames until one carries `id`, skipping the firehose notifications.
    async fn read_response_with_id<S: AsyncRead + Unpin>(client: &mut S, id: u64) -> Value {
        for _ in 0..500 {
            let frame = read_frame(client).await.expect("connection died before the response");
            if frame.get("id").and_then(Value::as_u64) == Some(id) {
                return frame;
            }
        }
        panic!("never saw a response for id {id}");
    }

    /// todo 228: a request whose 4-byte length arrives well before its payload
    /// must still be read correctly while notifications stream outbound. The
    /// pre-fix `select!` cancelled `read_frame` between the two and the
    /// connection died with `TooLarge`.
    #[tokio::test]
    async fn split_frame_survives_concurrent_outbound_notifications() {
        let (server, mut client) = tokio::io::duplex(64 * 1024);
        tokio::spawn(serve_connection(server, firehose_router()));

        handshake(&mut client).await;

        // Start the notification stream.
        write_frame(&mut client, &json!({"jsonrpc": "2.0", "id": 1, "method": "firehose"}))
            .await
            .unwrap();
        read_response_with_id(&mut client, 1).await;

        // Split the next request across the boundary the old code desynced on.
        let payload = serde_json::to_vec(&json!({"jsonrpc": "2.0", "id": 2, "method": "firehose"})).unwrap();
        client.write_all(&(payload.len() as u32).to_be_bytes()).await.unwrap();
        client.flush().await.unwrap();
        tokio::time::sleep(Duration::from_millis(120)).await;
        client.write_all(&payload).await.unwrap();
        client.flush().await.unwrap();

        let resp = read_response_with_id(&mut client, 2).await;
        assert!(resp.get("result").is_some(), "expected a result, got {resp}");
    }
}
