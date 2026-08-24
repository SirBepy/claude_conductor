//! `attach_session`/`detach_session` - subscribe/unsubscribe a client
//! connection to a session's live chat-event stream.

use super::{err_to_rpc, SessionIdOnly};
use crate::daemon::lifecycle::LifecycleError;
use crate::daemon::rpc::{Router, RpcError};
use crate::daemon::state::DaemonState;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

#[derive(Debug, Deserialize)]
struct AttachSessionParams {
    session_id: String,
    /// True = the client understands the O(delta) `assistant_delta` stream
    /// protocol (ai_todo 186). Legacy clients (older app builds) omit it and
    /// get each delta converted back into a full-text streaming
    /// `AssistantMessage` snapshot from the session's shared accumulator -
    /// the exact pre-delta wire shape.
    #[serde(default)]
    delta: bool,
}

pub fn register_attach(router: &mut Router, state: Arc<DaemonState>) {
    let map = state.sessions.clone();
    {
        let map = map.clone();
        router.register("attach_session", move |params, ctx| {
            let map = map.clone();
            async move {
                let p: AttachSessionParams = serde_json::from_value(params.unwrap_or(Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                let session = map.get(&p.session_id)
                    .ok_or_else(|| err_to_rpc(LifecycleError::NotFound(p.session_id.clone())))?
                    .clone();
                let mut rx = crate::daemon::broadcast::subscribe(&session);
                // Mid-turn attach resync (ai_todo 186): the stream carries
                // O(delta) chunks, so a client joining mid-turn can't recover
                // the text already streamed. Send the accumulated block first
                // (subscribe happened above, so deltas racing in behind this
                // snapshot carry a covered `seq` and are dropped client-side).
                // Legacy clients get the old full-text streaming snapshot.
                let resync = {
                    let s = session.streaming.lock().unwrap();
                    if p.delta { s.snapshot_event() } else { s.legacy_snapshot_event() }
                };
                let delta_capable = p.delta;
                let outbound = ctx.clone();
                let session_id_for_task = p.session_id.clone();
                let session_for_task = Arc::clone(&session);
                let handle = tokio::spawn(async move {
                    let frame = |ev: &crate::types::chat::ChatEvent| {
                        json!({
                            "jsonrpc": "2.0",
                            "method": "chat_event",
                            "params": {
                                "session_id": session_id_for_task,
                                "event": ev,
                            }
                        })
                    };
                    if let Some(snap) = resync {
                        if outbound.send_outbound(frame(&snap)).await.is_err() {
                            return;
                        }
                    }
                    loop {
                        match rx.recv().await {
                            Ok(ev) => {
                                let ev = match ev {
                                    // Legacy client: convert each delta into the
                                    // full-text streaming snapshot it expects. The
                                    // shared accumulator may already be ahead of
                                    // this rx position; a fuller idempotent
                                    // snapshot early is harmless. Empty (turn just
                                    // ended) -> skip; the finalized message is
                                    // next in the queue anyway.
                                    crate::types::chat::ChatEvent::AssistantDelta { .. } if !delta_capable => {
                                        match session_for_task.streaming.lock().unwrap().legacy_snapshot_event() {
                                            Some(snap) => snap,
                                            None => continue,
                                        }
                                    }
                                    other => other,
                                };
                                if outbound.send_outbound(frame(&ev)).await.is_err() {
                                    break;
                                }
                            }
                            Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                            Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                                log::warn!(
                                    "attach forwarding lagged for {session_id_for_task}: dropped {n} chat events"
                                );
                                // Non-delta events (finalized messages, tool
                                // calls, notifications) are gone for good -
                                // tell the client to force a transcript re-read.
                                let lagged = crate::types::chat::ChatEvent::EventsLagged {
                                    timestamp: chrono::Utc::now().timestamp_millis(),
                                };
                                if outbound.send_outbound(frame(&lagged)).await.is_err() {
                                    break;
                                }
                                // Deltas don't compose across a gap: resync the
                                // streamed text before continuing. (Legacy clients
                                // self-heal - their next converted delta reads the
                                // full accumulator anyway.)
                                if delta_capable {
                                    let snap = session_for_task.streaming.lock().unwrap().snapshot_event();
                                    if let Some(snap) = snap {
                                        if outbound.send_outbound(frame(&snap)).await.is_err() {
                                            break;
                                        }
                                    }
                                }
                                continue;
                            }
                        }
                    }
                });
                let mut subs = ctx.subscriptions.lock().await;
                if let Some(old) = subs.insert(p.session_id.clone(), handle.abort_handle()) {
                    old.abort();
                }
                Ok(json!({"ok": true}))
            }
        });
    }
    router.register("detach_session", move |params, ctx| {
        async move {
            let p: SessionIdOnly = serde_json::from_value(params.unwrap_or(Value::Null))
                .map_err(|e| RpcError::invalid_params(e.to_string()))?;
            let mut subs = ctx.subscriptions.lock().await;
            if let Some(handle) = subs.remove(&p.session_id) {
                handle.abort();
            }
            Ok(json!({"ok": true}))
        }
    });
}
