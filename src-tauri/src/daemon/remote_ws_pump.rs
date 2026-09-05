//! WebSocket event-pump group split out of `remote_handlers.rs` (ai_todo 554):
//! the global and per-session live-event forwarders, plus the respawn-wait
//! helper they share. `remote_handlers.rs` still owns route wiring
//! (`stream_ws` / `global_stream_ws`) and calls into `pump_events` /
//! `pump_global_events` here.

use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket};
use tokio::sync::broadcast::error::RecvError;

use crate::daemon::machines::registry::PeerMachine;
use crate::daemon::session::Session;
use crate::daemon::state::DaemonState;

use super::remote_handlers::{strip_hidden_instances, strip_hidden_instances_json};

/// How often `pump_global_events` sends an app-level heartbeat text frame.
/// Browsers never surface native WS ping/pong to JS (`onclose` does not fire
/// on a half-open/zombie socket - e.g. after the phone's screen was off long
/// enough for the OS to freeze the connection without a clean FIN), so
/// http-transport.ts's watchdog needs a text frame it can time against to
/// detect a silently-dead connection instead.
const GLOBAL_HEARTBEAT_INTERVAL: std::time::Duration = std::time::Duration::from_secs(15);

/// Frames buffered while the host was asleep and older than this are dropped
/// rather than forwarded - see the `turn_sound` staleness check below.
const TURN_SOUND_STALE_MS: i64 = 15_000;

/// Builds the same `instances_changed` frame shape the notifier publishes on
/// every registry mutation (see e.g. `daemon::methods::registry`), so a
/// freshly (re)connected client gets an immediate full resync instead of
/// waiting for the next mutation.
fn instances_changed_frame(state: &DaemonState) -> String {
    serde_json::json!({
        "jsonrpc": "2.0",
        "method": "instances_changed",
        "params": {"instances": strip_hidden_instances(crate::daemon::machines::all_instances(state))},
    })
    .to_string()
}

/// Forwards every daemon-wide notifier event to a global (not
/// session-scoped) WebSocket client verbatim - no per-event filtering -
/// because every notifier event (`instances_changed`, `channels_changed`,
/// `project_created`, `scheduled_items_changed`, `scheduled_item_fired`,
/// `permission_request`, `question_request`, `question_expired`,
/// `turn_sound`, `refresh_requested`, `usage_poll_requested`, `notify_requested`, `quit_requested`,
/// `skill_usage_changed`, `session_character_assigned`,
/// `token_history_updated` - see the `notifier.publish` call sites across
/// `daemon/`) mirrors data already exposed by an allowlisted `/api/rpc`
/// method (`list_instances`, `list_pending_prompts`, `get_token_history`,
/// `list_session_characters`, ...), so nothing here is more sensitive than
/// what a paired remote client can already read over REST.
/// A widget host announcing whether it is currently rendering our widget
/// itself. Returns `None` for every other client frame, all of which stay
/// ignored - this is the only inbound method this socket understands.
fn parse_host_overlay(txt: &str) -> Option<bool> {
    let v: serde_json::Value = serde_json::from_str(txt).ok()?;
    if v.get("method").and_then(serde_json::Value::as_str)? != "host_overlay" {
        return None;
    }
    v.pointer("/params/hosted").and_then(serde_json::Value::as_bool)
}

pub(super) async fn pump_global_events(mut socket: WebSocket, state: Arc<DaemonState>) {
    // Heal a client that just (re)connected: send a full snapshot before any
    // future mutation, mirroring `fetch_and_reseed_instances` on the
    // desktop app-side link.
    if socket
        .send(Message::Text(instances_changed_frame(&state)))
        .await
        .is_err()
    {
        return;
    }

    let mut rx = state.notifier.subscribe();
    let mut heartbeat = tokio::time::interval(GLOBAL_HEARTBEAT_INTERVAL);
    heartbeat.tick().await; // consume the immediate first tick (right after the snapshot)
    // Per connection, so an unrelated client closing clears nothing.
    let mut hosting = false;

    loop {
        tokio::select! {
            recv = rx.recv() => match recv {
                Ok(mut frame) => {
                    // The notifier fans out every daemon-wide event verbatim
                    // (see this fn's doc), but `instances_changed` specifically
                    // must never carry Jarvis/worker sessions to a remote
                    // client - the initial resync frame above already strips
                    // them; do the same for every live one, or a later
                    // unrelated registry mutation anywhere in the daemon would
                    // re-leak the full unfiltered list within seconds.
                    if frame.get("method").and_then(serde_json::Value::as_str) == Some("instances_changed") {
                        if let Some(arr) = frame.pointer_mut("/params/instances").and_then(serde_json::Value::as_array_mut) {
                            strip_hidden_instances_json(arr);
                        }
                    }
                    // A suspended host doesn't cleanly close this socket, so `turn_sound`
                    // frames pile up in the broadcast buffer and blast out all at once on
                    // wake. Dropping ones older than the cutoff is intentional (user wants
                    // "missed while asleep" to mean missed), not a bug - every other event
                    // type still forwards unconditionally.
                    if frame.get("method").and_then(serde_json::Value::as_str) == Some("turn_sound") {
                        let fired_at_ms = frame.pointer("/params/fired_at_ms").and_then(serde_json::Value::as_i64);
                        let age_ms = fired_at_ms.map(|t| chrono::Utc::now().timestamp_millis() - t);
                        if age_ms.is_some_and(|age| age > TURN_SOUND_STALE_MS) {
                            continue;
                        }
                    }
                    let txt = match serde_json::to_string(&frame) {
                        Ok(t) => t,
                        Err(_) => continue,
                    };
                    if socket.send(Message::Text(txt)).await.is_err() {
                        break; // client gone
                    }
                }
                Err(RecvError::Lagged(_)) => continue, // dropped frames under load; keep going
                Err(RecvError::Closed) => break, // notifier sender dropped (daemon shutting down)
            },
            incoming = socket.recv() => match incoming {
                Some(Ok(Message::Text(t))) => {
                    if let Some(h) = parse_host_overlay(&t) {
                        hosting = h;
                        state.notifier.publish("widget_host_changed", serde_json::json!({"hosted": h}));
                    }
                }
                Some(Ok(_)) => {} // ignore every other client->server frame
                _ => break,       // client closed or errored
            },
            _ = heartbeat.tick() => {
                let hb = serde_json::json!({"jsonrpc": "2.0", "method": "heartbeat", "params": {}}).to_string();
                if socket.send(Message::Text(hb)).await.is_err() {
                    break;
                }
            }
        }
    }
    // Covers the host quitting, crashing and being killed alike, so a hosting
    // claim can never outlive the socket that made it.
    if hosting {
        state.notifier.publish("widget_host_changed", serde_json::json!({"hosted": false}));
    }
}

/// How long `pump_events` keeps polling the SessionMap for a respawn after its
/// broadcast channel closes, before giving up and closing the socket (falling
/// back to the client's own reconnect-with-backoff in http-transport.ts).
/// Bounded so a browser tab left open on a session that has genuinely ended
/// doesn't poll the daemon forever.
const RESPAWN_POLL_INTERVAL: std::time::Duration = std::time::Duration::from_millis(500);
const RESPAWN_MAX_WAIT: std::time::Duration = std::time::Duration::from_secs(120);

/// Forward a session's live ChatEvent broadcast to the WebSocket client until
/// either side closes. Mirrors what the desktop Tauri event stream delivers, so
/// a phone client sees the same turns stream in real time.
///
/// The per-turn `claude -p` process exits at the end of every turn (see
/// `daemon::lifecycle::spawn_session`'s pump-exit handling), which drops this
/// session's broadcast sender and closes `rx`. A naive close-on-`Closed` here
/// would strand this window on the client's 1s-30s exponential WS reconnect
/// backoff - exactly the window in which a sibling window's message can
/// respawn the session and get silently missed here (the bug this whole
/// change fixes). Instead, poll the SessionMap for the respawn and resubscribe
/// to the NEW session's channel on the SAME socket.
pub(super) async fn pump_events(mut socket: WebSocket, state: Arc<DaemonState>, session_id: String, session: Arc<Session>) {
    let mut rx = crate::daemon::broadcast::subscribe(&session);
    // Mid-turn attach resync (ai_todo 186): the stream now carries O(delta)
    // `assistant_delta` chunks, so a client joining mid-turn has no way to
    // recover the text already streamed. Send the accumulated block as one
    // `snapshot: true` frame first; any deltas already queued in `rx` carry a
    // `seq` at or below the snapshot's and are dropped client-side. (The PWA
    // client is served by this same daemon, so it always speaks the delta
    // protocol - no legacy conversion needed here, unlike `attach_session`.)
    // (Bound separately: an `if let` scrutinee would hold the MutexGuard
    // across the `.await`, making the future non-Send.)
    let resync = session.streaming.lock().unwrap().snapshot_event();
    if let Some(snap) = resync {
        if let Ok(txt) = serde_json::to_string(&snap) {
            if socket.send(Message::Text(txt)).await.is_err() {
                return; // client gone
            }
        }
    }
    loop {
        tokio::select! {
            recv = rx.recv() => match recv {
                Ok(ev) => {
                    let txt = match serde_json::to_string(&ev) {
                        Ok(t) => t,
                        Err(_) => continue,
                    };
                    if socket.send(Message::Text(txt)).await.is_err() {
                        break; // client gone
                    }
                }
                Err(RecvError::Lagged(n)) => {
                    // Dropped frames under load. Deltas don't compose across a
                    // gap, so resync the streamed text with a snapshot frame
                    // before continuing (a delta client drops anything its
                    // accumulator already covers).
                    log::warn!("remote stream lagged for {session_id}: dropped {n} chat events");
                    // Non-delta events (finalized messages, tool calls,
                    // notifications) are gone for good - tell the client to
                    // force a transcript re-read.
                    let lagged = crate::types::chat::ChatEvent::EventsLagged {
                        timestamp: chrono::Utc::now().timestamp_millis(),
                    };
                    if let Ok(txt) = serde_json::to_string(&lagged) {
                        if socket.send(Message::Text(txt)).await.is_err() {
                            break;
                        }
                    }
                    // Look the session up fresh: after a respawn+resubscribe
                    // (`wait_for_respawn` below) the captured `session` is the
                    // OLD object and its accumulator would be stale.
                    let snap = state
                        .sessions
                        .get(&session_id)
                        .map(|s| s.clone())
                        .and_then(|s| s.streaming.lock().unwrap().snapshot_event());
                    if let Some(snap) = snap {
                        if let Ok(txt) = serde_json::to_string(&snap) {
                            if socket.send(Message::Text(txt)).await.is_err() {
                                break;
                            }
                        }
                    }
                    continue;
                }
                Err(RecvError::Closed) => {
                    match wait_for_respawn(&state, &session_id, &mut socket).await {
                        Some(new_rx) => rx = new_rx,
                        None => break, // client disconnected, or no respawn within RESPAWN_MAX_WAIT
                    }
                }
            },
            incoming = socket.recv() => match incoming {
                Some(Ok(_)) => {}      // ignore client->server frames for now
                _ => break,            // client closed or errored
            },
        }
    }
}

/// Forwards a MIRRORED session's live events to a phone/browser WS client:
/// `machines::relay::relay_session_frames` reads the owning peer's own
/// `pump_events` stream (same raw `ChatEvent` JSON this fn's `Ok(ev)` arm
/// serializes above), so every frame is forwarded verbatim - no reshaping,
/// unlike `attach_session`'s desktop-pipe relay which wraps each frame in the
/// `chat_event` notification envelope for that transport instead.
pub(super) async fn pump_relayed_session_events(
    mut socket: WebSocket,
    state: Arc<DaemonState>,
    peer: PeerMachine,
    session_id: String,
) {
    let (tx, mut rx) = tokio::sync::mpsc::channel::<String>(64);
    let _producer_guard = crate::daemon::machines::relay::AbortOnDrop(tokio::spawn(
        crate::daemon::machines::relay::relay_session_frames(state, peer, session_id, tx),
    ));
    loop {
        tokio::select! {
            frame = rx.recv() => match frame {
                Some(txt) => {
                    if socket.send(Message::Text(txt)).await.is_err() {
                        break; // client gone
                    }
                }
                None => break, // relay gave up (peer unpaired, or unreachable for good)
            },
            incoming = socket.recv() => match incoming {
                Some(Ok(_)) => {}      // ignore client->server frames
                _ => break,            // client closed or errored
            },
        }
    }
}

/// Poll the SessionMap for `session_id` to come back live, up to
/// `RESPAWN_MAX_WAIT`, while still watching `socket` so a client-initiated
/// close is honored immediately instead of waiting out the poll.
async fn wait_for_respawn(
    state: &Arc<DaemonState>,
    session_id: &str,
    socket: &mut WebSocket,
) -> Option<tokio::sync::broadcast::Receiver<crate::types::chat::ChatEvent>> {
    let deadline = tokio::time::Instant::now() + RESPAWN_MAX_WAIT;
    loop {
        if let Some(session) = state.sessions.get(session_id).map(|s| s.clone()) {
            return Some(crate::daemon::broadcast::subscribe(&session));
        }
        if tokio::time::Instant::now() >= deadline {
            return None;
        }
        tokio::select! {
            _ = tokio::time::sleep(RESPAWN_POLL_INTERVAL) => continue,
            incoming = socket.recv() => match incoming {
                Some(Ok(_)) => continue, // ignore client frames while waiting
                _ => return None,        // client closed or errored
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::types::Settings;

    #[test]
    fn instances_changed_frame_matches_notifier_shape() {
        let state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        let frame = instances_changed_frame(&state);
        let v: serde_json::Value = serde_json::from_str(&frame).expect("valid json frame");
        assert_eq!(v["jsonrpc"], "2.0");
        assert_eq!(v["method"], "instances_changed");
        assert!(v["params"]["instances"].is_array(), "params.instances should be an array: {v}");
        assert_eq!(v["params"]["instances"].as_array().unwrap().len(), 0);
    }
}
