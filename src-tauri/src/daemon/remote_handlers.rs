//! Chat/session HTTP+WS handlers for the remote-access server
//! (`remote_server.rs` owns the router, auth middleware, and pairing-file
//! helpers; this module is the per-route business logic for the session/chat
//! surface specifically). Push notifications, the voice/STT relay, device
//! pairing, and SPA static-asset serving live in their own sibling modules
//! (`remote_push.rs`, `remote_voice.rs`, `remote_pairing.rs` - split out in
//! ai_todo 319 - and `remote_static.rs` - ai_todo 514) since none of them
//! share state or helpers with the chat/session core.

use std::sync::Arc;

use axum::{
    extract::{
        ws::WebSocketUpgrade,
        Path as AxPath, Query, State,
    },
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;

use crate::daemon::device_registry::{DeviceKind, DeviceRegistry};
use crate::daemon::rpc::Transport;

use super::remote_server::RemoteCtx;
use super::remote_ws_pump::{pump_events, pump_global_events, pump_relayed_session_events};

// The TRANSPORT_TABLE allowlist, TransportMask and allowed() live in
// `remote_transport_table` (todo 934: the table's per-method rationale
// comments and its coupled tests were most of this file's regrowth).
// `allowed` alone is re-exported, because `machines/forward.rs` imports it
// from here and `remote_server.rs` picks it up through a glob. The table and
// the mask type have no code callers outside their own module - only doc
// comments name them - so re-exporting those two as well would be an unused
// import the compiler rightly flags.
pub(crate) use super::remote_transport_table::allowed;

// ── Handlers ─────────────────────────────────────────────────────────────────

/// Jarvis (todo 272) and its worker sub-sessions never reach the remote/phone
/// cockpit - Joe's binding design decision: Jarvis exists only in its own
/// dedicated desktop window (`ipc::window::open_jarvis_window`), and a worker
/// is meaningless outside its parent session's context. Shared by every
/// remote session-list surface below: the `GET /api/sessions` REST route, the
/// `POST /api/rpc {"method":"list_instances"}` allowlisted RPC (the one the
/// phone SPA's `HttpTransport` actually calls - see `http-transport.ts`), the
/// WebSocket global-stream's initial resync frame, and its live-forwarded
/// `instances_changed` notifications.
pub(super) fn strip_hidden_instances(instances: Vec<crate::types::Instance>) -> Vec<crate::types::Instance> {
    instances.into_iter().filter(|i| !i.jarvis && i.worker_of.is_none()).collect()
}

/// JSON-level counterpart of `strip_hidden_instances`, for call sites that
/// already hold a serialized instance array (the shared RPC router's dispatch
/// result, and forwarded notifier frames) rather than typed `Instance`s.
pub(super) fn strip_hidden_instances_json(arr: &mut Vec<serde_json::Value>) {
    arr.retain(|v| {
        let jarvis = v.get("jarvis").and_then(serde_json::Value::as_bool).unwrap_or(false);
        let is_worker = v.get("worker_of").map(|w| !w.is_null()).unwrap_or(false);
        !jarvis && !is_worker
    });
}

pub(super) async fn list_sessions(State(ctx): State<Arc<RemoteCtx>>) -> Response {
    Json(strip_hidden_instances(crate::daemon::machines::all_instances(&ctx.state))).into_response()
}

#[derive(Deserialize)]
pub(super) struct SendBody {
    text: String,
}

pub(super) async fn send_message(
    State(ctx): State<Arc<RemoteCtx>>,
    AxPath(id): AxPath<String>,
    Json(body): Json<SendBody>,
) -> Response {
    // Respawns the session first if its per-turn `claude -p` process already
    // exited since the last turn (the daemon-side equivalent of the desktop's
    // -32004 -> start_session(resume) -> retry dance - see
    // `lifecycle::send_message_with_respawn`). Without this a remote send into
    // an idle chat 404'd here instead of resuming it.

    // The phone's half of core.rs's mid-turn refusal (todo 873). Gated on a
    // live child: a session whose process already exited has a stale `busy` at
    // worst, and the respawn below is its way out. 409, not 500 - the phone's
    // transport re-stages that body into the held queue.
    if ctx.state.sessions.get(&id).is_some() {
        if let Err(e) = crate::daemon::lifecycle::refuse_if_busy(&ctx.state, &id) {
            return (StatusCode::CONFLICT, e.to_string()).into_response();
        }
    }
    // Set busy BEFORE the write, mirroring core.rs's desktop `send_message` RPC
    // (todo 525 root cause 1: a warm child can emit its first `stream_event`
    // before this fn resumes past the write's own `.await`). Without this the
    // guard above refused nothing that mattered: `busy` only became true once
    // the pump's `mark_turn_live` fired off the CLI's first live stdout line,
    // leaving the exact race todo 873 closed for desktop still open on the
    // phone's send path (todo 885).
    ctx.state.registry.set_awaiting(&id, None);
    ctx.state.registry.set_busy(&id, true);
    crate::sessions::chat_state::set_busy(&id, true);
    match crate::daemon::lifecycle::send_message_with_respawn(&ctx.state, &id, &body.text, false).await {
        Ok(()) => StatusCode::OK.into_response(),
        Err(crate::daemon::lifecycle::LifecycleError::NotFound(_)) => {
            ctx.state.registry.set_busy(&id, false);
            crate::sessions::chat_state::set_busy(&id, false);
            (StatusCode::NOT_FOUND, "no such session").into_response()
        }
        Err(e) => {
            ctx.state.registry.set_busy(&id, false);
            crate::sessions::chat_state::set_busy(&id, false);
            (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response()
        }
    }
}

pub(super) async fn cancel_turn(
    State(ctx): State<Arc<RemoteCtx>>,
    AxPath(id): AxPath<String>,
) -> Response {
    match crate::daemon::lifecycle::cancel_turn(&ctx.state.sessions, &id).await {
        Ok(()) => StatusCode::OK.into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

#[derive(Deserialize)]
pub(super) struct RpcBody {
    method: String,
    #[serde(default)]
    params: Option<serde_json::Value>,
}

/// Generic command dispatch: forwards an allowlisted daemon RPC method to the
/// shared router. This is how the phone runs the real SPA (its transport calls
/// commands by name). A throwaway ConnectionContext is fine because every
/// allowlisted method is request/response - streaming methods are excluded and
/// served by the WS endpoint instead.
pub(super) async fn rpc_dispatch(
    State(ctx): State<Arc<RemoteCtx>>,
    Json(body): Json<RpcBody>,
) -> Response {
    let transport = crate::daemon::rpc::TRANSPORT
        .try_with(|t| t.clone())
        .unwrap_or(Transport::Local);
    if !allowed(&body.method, &transport) {
        return (
            StatusCode::FORBIDDEN,
            format!("method not allowed remotely: {}", body.method),
        )
            .into_response();
    }
    let method = body.method.clone();
    let (tx, _rx) = tokio::sync::mpsc::channel(16);
    let conn = crate::daemon::rpc::ConnectionContext::new(tx);
    let req = crate::daemon::rpc::Request {
        jsonrpc: "2.0".into(),
        id: serde_json::json!(0),
        method: body.method,
        params: body.params,
    };
    let resp = ctx.router.dispatch(req, conn).await;
    match resp.error {
        Some(err) => (StatusCode::INTERNAL_SERVER_ERROR, Json(err)).into_response(),
        None => {
            let mut result = resp.result.unwrap_or(serde_json::Value::Null);
            // `list_instances` is the one SAFE_METHODS entry backed by the
            // shared daemon RPC router (also used by the desktop app, whose
            // own Jarvis window needs the UNFILTERED data - see
            // sessions-helpers.ts's isJarvisOrWorker doc), so it can't be
            // filtered centrally. Strip it here instead, remote-transport-only.
            if method == "list_instances" {
                if let Some(arr) = result.as_array_mut() {
                    strip_hidden_instances_json(arr);
                }
            }
            Json(result).into_response()
        }
    }
}

#[derive(Deserialize)]
pub(super) struct StreamQuery {
    pub(super) token: String,
}

pub(super) async fn stream_ws(
    State(ctx): State<Arc<RemoteCtx>>,
    AxPath(id): AxPath<String>,
    Query(q): Query<StreamQuery>,
    ws: WebSocketUpgrade,
) -> Response {
    let Some((kind, _machine_id)) = DeviceRegistry::resolve_token(&q.token, &ctx.app_data) else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    if let Some(session) = ctx.state.sessions.get(&id).map(|s| s.clone()) {
        let state = ctx.state.clone();
        return ws.on_upgrade(move |socket| pump_events(socket, state, id, session));
    }
    // Not a local session - maybe one mirrored in from a paired peer.
    let Some(owner) = ctx.state.mirror.owner_of(&id) else {
        return (StatusCode::NOT_FOUND, "no such session").into_response();
    };
    // Refuse a peer-to-peer relay chain: only a phone/browser or the desktop
    // app may ride a relay, never another peer daemon (see `machines::relay`'s
    // doc) - a peer already gets this session's events over its OWN mirror
    // link, forwarding them back out would loop.
    if matches!(kind, DeviceKind::Machine) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let Some(registry) = ctx.state.machines.get() else {
        return (StatusCode::NOT_FOUND, "no such session").into_response();
    };
    let Some(peer) = registry.peer(&owner) else {
        return (StatusCode::NOT_FOUND, "no such session").into_response();
    };
    let state = ctx.state.clone();
    ws.on_upgrade(move |socket| pump_relayed_session_events(socket, state, peer, id))
}

/// Not session-scoped: the remote (browser) equivalent of the internal
/// daemon<->app `subscribe_global` pipe link (see `daemon_link.rs`'s
/// `run_app_subscription`). Self-authenticates via `?token=` exactly like
/// `stream_ws`, since browsers cannot set the Authorization header on a WS
/// handshake.
pub(super) async fn global_stream_ws(
    State(ctx): State<Arc<RemoteCtx>>,
    Query(q): Query<StreamQuery>,
    ws: WebSocketUpgrade,
) -> Response {
    if !DeviceRegistry::validate_token(&q.token, &ctx.app_data) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let state = ctx.state.clone();
    ws.on_upgrade(move |socket| pump_global_events(socket, state))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_hidden_instances_json_drops_jarvis_and_workers() {
        let mut arr = vec![
            serde_json::json!({"session_id": "a", "jarvis": false, "worker_of": null}),
            serde_json::json!({"session_id": "b", "jarvis": true, "worker_of": null}),
            serde_json::json!({"session_id": "c", "jarvis": false, "worker_of": "a"}),
        ];
        strip_hidden_instances_json(&mut arr);
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["session_id"], "a");
    }
}
