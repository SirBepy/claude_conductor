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

    // 2. Request + notification loop. `biased` drains outbound first so
    // notification latency stays low even under inbound load.
    let exit_result: Result<(), FrameError> = loop {
        tokio::select! {
            biased;
            Some(notif) = rx.recv() => {
                // Dequeued: this frame is off the queue regardless of whether the
                // write below succeeds, so decrement before timing the write.
                ctx.outbound_depth.fetch_sub(1, std::sync::atomic::Ordering::Relaxed);
                let started = std::time::Instant::now();
                let write_result = write_frame(&mut stream, &notif).await;
                let elapsed = started.elapsed();
                if elapsed >= crate::daemon::rpc::SLOW_SEND_THRESHOLD {
                    log::warn!(
                        "outbound send slow: conn={} elapsed={elapsed:?} queue_depth={}",
                        ctx.conn_id,
                        ctx.outbound_depth.load(std::sync::atomic::Ordering::Relaxed)
                    );
                }
                if let Err(e) = write_result {
                    break Err(e);
                }
            }
            frame_result = read_frame(&mut stream) => {
                let frame = match frame_result {
                    Ok(f) => f,
                    Err(FrameError::Io(e)) if e.kind() == io::ErrorKind::UnexpectedEof
                        || e.kind() == io::ErrorKind::BrokenPipe => break Ok(()),
                    Err(e) => break Err(e),
                };
                let msg: Message = match serde_json::from_value(frame) {
                    Ok(m) => m,
                    Err(e) => {
                        let err = json!({
                            "jsonrpc": "2.0", "id": null,
                            "error": {"code": -32700, "message": format!("parse error: {e}")}
                        });
                        if let Err(e) = write_frame(&mut stream, &err).await {
                            break Err(e);
                        }
                        continue;
                    }
                };
                match msg {
                    Message::Request(req) => {
                        // Dispatch concurrently and route the response through the
                        // same outbound queue notifications use, so the write half
                        // keeps a single owner. Awaiting dispatch inline here
                        // head-of-line blocked the whole connection: one slow
                        // handler (start_session spawning claude.exe, a heavy
                        // send_message) stalled every other RPC and all
                        // notifications on this connection for seconds. Handlers
                        // already run concurrently across connections, so this
                        // adds no new concurrency class.
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
        }
    };

    // Cleanup: abort all per-session subscription tasks on disconnect.
    let mut subs = ctx.subscriptions.lock().await;
    for (_, handle) in subs.drain() {
        handle.abort();
    }
    drop(subs);

    exit_result
}
