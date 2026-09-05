//! Shared connect-and-forward loop for relaying one mirrored session's live
//! chat-event stream in from its owning peer's per-session WebSocket
//! (`GET /api/sessions/:id/stream`, served by `remote_ws_pump::pump_events`
//! on the peer). Desktop's `attach_session` wraps each relayed frame into the
//! local `chat_event` notification envelope; the phone path
//! (`remote_ws_pump::pump_relayed_session_events`) forwards frames verbatim -
//! `pump_events` already emits the raw `ChatEvent` JSON shape the phone
//! transport expects, so no reshaping is needed on that path.

use std::sync::Arc;
use std::time::Duration;

use futures_util::StreamExt;
use tokio::sync::mpsc::Sender;
use tokio_tungstenite::tungstenite::Message;

use crate::daemon::state::DaemonState;

use super::peer_client;
use super::registry::PeerMachine;

/// Backoff between reconnect attempts - matches `peer_link`'s reconnect
/// floor (a same-LAN peer blipping should recover fast).
const RELAY_RETRY: Duration = Duration::from_secs(3);
/// The peer's per-session stream has no heartbeat (unlike its global stream's
/// 15s ping), so a genuinely silent-but-alive socket would otherwise park
/// `stream.next()` forever. Bounding the wait lets a closed `tx` (the
/// consumer gave up) be noticed even mid-silence instead of only on the next
/// frame.
const READ_IDLE_CHECK: Duration = Duration::from_secs(10);

fn to_session_stream_url(base_url: &str, session_id: &str, token: &str) -> String {
    let ws_base = if let Some(rest) = base_url.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = base_url.strip_prefix("http://") {
        format!("ws://{rest}")
    } else {
        base_url.to_string()
    };
    format!("{}/api/sessions/{}/stream?token={}", ws_base.trim_end_matches('/'), session_id, token)
}

/// Connects to `peer`'s per-session stream for `session_id` and forwards
/// every text frame verbatim onto `tx`, reconnecting every [`RELAY_RETRY`]
/// while `peer.machine_id` is still a registered peer. Returns (stops
/// reconnecting for good) once `tx`'s receiver is dropped - the consumer
/// gave up - or the peer is unpaired mid-relay.
pub async fn relay_session_frames(state: Arc<DaemonState>, peer: PeerMachine, session_id: String, tx: Sender<String>) {
    loop {
        let still_paired = state.machines.get().map(|r| r.peer(&peer.machine_id).is_some()).unwrap_or(false);
        if !still_paired || tx.is_closed() {
            return;
        }
        let base_url = match peer_client::reach_url(&peer) {
            Ok(u) => u,
            Err(_) => {
                tokio::time::sleep(RELAY_RETRY).await;
                continue;
            }
        };
        let ws_url = to_session_stream_url(&base_url, &session_id, &peer.token);
        if let Ok((mut stream, _resp)) = tokio_tungstenite::connect_async(&ws_url).await {
            loop {
                match tokio::time::timeout(READ_IDLE_CHECK, stream.next()).await {
                    Ok(Some(Ok(Message::Text(txt)))) => {
                        if tx.send(txt).await.is_err() {
                            return; // consumer gone; stop relaying entirely
                        }
                    }
                    Ok(Some(Ok(_))) => {} // ping/pong/binary: ignore
                    Ok(Some(Err(_))) | Ok(None) => break, // socket errored/closed: reconnect below
                    Err(_) => {
                        // idle timeout: just a liveness check, not a hangup
                        if tx.is_closed() {
                            return;
                        }
                    }
                }
            }
        }
        tokio::time::sleep(RELAY_RETRY).await;
    }
}

/// Aborts the wrapped task when dropped - the standard way to tie a spawned
/// child task's lifetime to a scope, since Tokio cancellation (an aborted
/// outer task, or one whose future is simply dropped) runs every live
/// local's `Drop` impl but does not itself reach into a `JoinHandle` it holds.
/// Both relay call sites spawn `relay_session_frames` as a child of their own
/// consumer loop and wrap its handle in this, so the producer dies the
/// instant the consumer stops draining frames - not just on the process's
/// own natural loop exit.
pub struct AbortOnDrop(pub tokio::task::JoinHandle<()>);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn to_session_stream_url_rewrites_http_to_ws() {
        assert_eq!(
            to_session_stream_url("http://127.0.0.1:27291", "s1", "tok"),
            "ws://127.0.0.1:27291/api/sessions/s1/stream?token=tok"
        );
    }

    #[test]
    fn to_session_stream_url_rewrites_https_to_wss() {
        assert_eq!(
            to_session_stream_url("https://example.tailnet.ts.net", "s1", "tok"),
            "wss://example.tailnet.ts.net/api/sessions/s1/stream?token=tok"
        );
    }
}
