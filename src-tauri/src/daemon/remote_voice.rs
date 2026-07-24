//! Voice/STT relay for the remote-access server. Split out of
//! `remote_handlers.rs` (ai_todo 319): this WS endpoint only touches
//! `ctx.stt` (`SttSupervisor`), unlike every other handler in that file which
//! reaches into `DaemonState.sessions`/`registry`.

use std::sync::Arc;

use axum::{
    extract::{
        ws::{WebSocket, WebSocketUpgrade},
        Query, State,
    },
    http::StatusCode,
    response::{IntoResponse, Response},
};

use crate::daemon::device_registry::DeviceRegistry;

use super::remote_handlers::StreamQuery;
use super::remote_server::RemoteCtx;

/// Authed entry to the voice transcription pipe. Self-authenticates via the
/// `?token=` query (browsers cannot set the Authorization header on a WS
/// handshake) exactly like `stream_ws`, ensures the Python STT sidecar is
/// running, then upgrades and dumb-relays frames browser<->sidecar.
pub(super) async fn transcribe_ws(
    State(ctx): State<Arc<RemoteCtx>>,
    Query(q): Query<StreamQuery>,
    ws: WebSocketUpgrade,
) -> Response {
    if !DeviceRegistry::validate_token(&q.token, &ctx.app_data) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    if let Err(e) = ctx.stt.ensure_running().await {
        log::error!("stt ensure_running: {e}");
        return (StatusCode::SERVICE_UNAVAILABLE, "voice engine unavailable").into_response();
    }
    let stt = ctx.stt.clone();
    ws.on_upgrade(move |socket| relay_transcribe(socket, stt))
}

/// Dumb bidirectional relay between the browser axum WebSocket and a
/// tokio-tungstenite client WS to the localhost STT sidecar. Binary PCM goes
/// up; JSON transcript frames come down. Closes when either side closes.
async fn relay_transcribe(browser: WebSocket, stt: Arc<crate::daemon::stt::SttSupervisor>) {
    use axum::extract::ws::Message as AxMsg;
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message as TgMsg;

    stt.on_connect();
    // Brief retry so the freshly-spawned sidecar has time to bind its socket.
    let url = format!("ws://127.0.0.1:{}", crate::daemon::stt::SIDECAR_PORT);
    let mut sidecar = None;
    for _ in 0..50 {
        if let Ok((s, _)) = tokio_tungstenite::connect_async(&url).await {
            sidecar = Some(s);
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    }
    let Some(sidecar) = sidecar else {
        let _ = browser;
        stt.on_disconnect().await;
        return;
    };

    let (mut b_tx, mut b_rx) = browser.split();
    let (mut s_tx, mut s_rx) = sidecar.split();

    // browser -> sidecar (binary PCM + text control)
    let up = async {
        while let Some(Ok(msg)) = b_rx.next().await {
            let out = match msg {
                AxMsg::Binary(b) => TgMsg::Binary(b),
                AxMsg::Text(t) => TgMsg::Text(t),
                AxMsg::Close(_) => break,
                _ => continue,
            };
            if s_tx.send(out).await.is_err() {
                break;
            }
        }
    };
    // sidecar -> browser (JSON results)
    let down = async {
        while let Some(Ok(msg)) = s_rx.next().await {
            let out = match msg {
                TgMsg::Text(t) => AxMsg::Text(t),
                TgMsg::Binary(b) => AxMsg::Binary(b),
                TgMsg::Close(_) => break,
                _ => continue,
            };
            if b_tx.send(out).await.is_err() {
                break;
            }
        }
    };
    tokio::select! { _ = up => {}, _ = down => {} }
    stt.on_disconnect().await;
}
