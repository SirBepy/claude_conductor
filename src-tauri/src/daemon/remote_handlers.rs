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

/// Jarvis worker sub-sessions (todo 272) never reach a remote client: a worker
/// is meaningless outside its parent session's context. The Jarvis row itself
/// reaches the phone, which opens it from its sidemenu the way desktop opens
/// its Jarvis window, and the phone's chat list then hides it client-side
/// (`isJarvisOrWorker`), same as desktop. A paired peer machine gets neither:
/// a mirrored Jarvis would leak into that machine's listings
/// (`methods/channel/peers.rs::visible_for_peers`). Shared by every remote
/// session-list surface below: the `GET /api/sessions` REST route, the
/// `POST /api/rpc {"method":"list_instances"}` allowlisted RPC (the one the
/// phone SPA's `HttpTransport` actually calls - see `http-transport.ts`), the
/// WebSocket global-stream's initial resync frame, and its live-forwarded
/// `instances_changed` notifications.
pub(super) fn strip_hidden_instances(
    instances: Vec<crate::types::Instance>,
    keep_jarvis: bool,
) -> Vec<crate::types::Instance> {
    instances
        .into_iter()
        .filter(|i| (keep_jarvis || !i.jarvis) && i.worker_of.is_none())
        .collect()
}

/// JSON-level counterpart of `strip_hidden_instances`, for call sites that
/// already hold a serialized instance array (the shared RPC router's dispatch
/// result, and forwarded notifier frames) rather than typed `Instance`s.
pub(super) fn strip_hidden_instances_json(arr: &mut Vec<serde_json::Value>, keep_jarvis: bool) {
    arr.retain(|v| {
        let jarvis = v.get("jarvis").and_then(serde_json::Value::as_bool).unwrap_or(false);
        let is_worker = v.get("worker_of").map(|w| !w.is_null()).unwrap_or(false);
        (keep_jarvis || !jarvis) && !is_worker
    });
}

/// The `keep_jarvis` argument for `strip_hidden_instances` on a request
/// served under `transport`: only the phone gets the Jarvis row.
pub(super) fn keeps_jarvis(transport: &Transport) -> bool {
    matches!(transport, Transport::Phone)
}

fn current_transport() -> Transport {
    crate::daemon::rpc::TRANSPORT
        .try_with(|t| t.clone())
        .unwrap_or(Transport::Local)
}

pub(super) async fn list_sessions(State(ctx): State<Arc<RemoteCtx>>) -> Response {
    let keep = keeps_jarvis(&current_transport());
    Json(strip_hidden_instances(crate::daemon::machines::all_instances(&ctx.state), keep)).into_response()
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
    // A session not in this daemon's own registry may still be a mirrored
    // row owned by a paired peer - forward to that peer's own send_message
    // RPC instead of falling through to the local 404 below. Never forwards
    // a request that itself arrived FROM a peer (`Transport::PeerMachine`):
    // that would always be about OUR own sessions, and re-forwarding it would
    // loop, same guard `machines/forward.rs::forward_one` applies.
    if ctx.state.sessions.get(&id).is_none() {
        if let Some(machine_id) = ctx.state.mirror.owner_of(&id) {
            if matches!(current_transport(), Transport::PeerMachine(_)) {
                return (StatusCode::FORBIDDEN, "a peer machine's own request is never re-forwarded").into_response();
            }
            return match crate::daemon::machines::forward::forward_send_message(&ctx.state, &machine_id, &id, &body.text)
                .await
            {
                Ok(()) => StatusCode::OK.into_response(),
                Err(e) => {
                    use crate::daemon::machines::forward::{ERR_MACHINE_OFFLINE, ERR_NOT_FORWARDABLE, ERR_REPAIR_REQUIRED};
                    let status = match e.code {
                        ERR_MACHINE_OFFLINE | ERR_REPAIR_REQUIRED => StatusCode::SERVICE_UNAVAILABLE,
                        ERR_NOT_FORWARDABLE => StatusCode::BAD_REQUEST,
                        _ => StatusCode::INTERNAL_SERVER_ERROR,
                    };
                    (status, e.message).into_response()
                }
            };
        }
    }
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
                    strip_hidden_instances_json(arr, keeps_jarvis(&transport));
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
    // The upgraded socket runs outside auth_mw's TRANSPORT scope, so the
    // device kind is resolved here from the query token instead.
    let Some((kind, _machine_id)) = DeviceRegistry::resolve_token(&q.token, &ctx.app_data) else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    let keep_jarvis = matches!(kind, DeviceKind::Phone);
    let state = ctx.state.clone();
    ws.on_upgrade(move |socket| pump_global_events(socket, state, keep_jarvis))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rows() -> Vec<serde_json::Value> {
        vec![
            serde_json::json!({"session_id": "a", "jarvis": false, "worker_of": null}),
            serde_json::json!({"session_id": "b", "jarvis": true, "worker_of": null}),
            serde_json::json!({"session_id": "c", "jarvis": false, "worker_of": "a"}),
        ]
    }

    fn ids(arr: &[serde_json::Value]) -> Vec<&str> {
        arr.iter().map(|v| v["session_id"].as_str().unwrap()).collect()
    }

    #[test]
    fn strip_hidden_instances_json_keeps_jarvis_for_the_phone_but_never_workers() {
        let mut arr = rows();
        strip_hidden_instances_json(&mut arr, keeps_jarvis(&Transport::Phone));
        assert_eq!(ids(&arr), ["a", "b"]);
    }

    #[test]
    fn strip_hidden_instances_json_drops_jarvis_and_workers_for_a_peer_machine() {
        let mut arr = rows();
        strip_hidden_instances_json(&mut arr, keeps_jarvis(&Transport::PeerMachine("m".into())));
        assert_eq!(ids(&arr), ["a"]);
    }

    /// Two real daemons over real loopback HTTP: the REST `POST
    /// /api/sessions/:id/send` route on A for an id mirrored from B forwards
    /// to B's own `send_message` RPC instead of 404ing - before this, the
    /// route only ever consulted `ctx.state.sessions` (local-only).
    #[tokio::test]
    async fn send_message_forwards_to_the_mirrored_sessions_owner() {
        use crate::daemon::machines::registry::PeerMachine;
        use crate::daemon::rpc::Router;
        use crate::daemon::session::new_session_map;
        use crate::daemon::settings_cache::SettingsCache;
        use crate::daemon::state::DaemonState;
        use crate::sessions::kinds::InstanceKind;
        use crate::sessions::registry::RegisterInput;
        use crate::types::Settings;
        use tempfile::tempdir;

        let dir = tempdir().unwrap();
        let peer_dir = tempdir().unwrap();

        // B: a stub send_message that records what text it was asked to send.
        let seen = std::sync::Arc::new(tokio::sync::Mutex::new(None::<String>));
        let seen_for_stub = seen.clone();
        let mut b_router = Router::new();
        b_router.register("send_message", move |params, _ctx| {
            let seen = seen_for_stub.clone();
            async move {
                let text = params.and_then(|p| p.get("text").and_then(|t| t.as_str().map(str::to_string)));
                *seen.lock().await = text;
                Ok(serde_json::json!({"ok": true}))
            }
        });
        let b_state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        let (_b_stt, b_port, b_serve) =
            crate::daemon::remote_server::spawn_on(b_state.clone(), peer_dir.path().to_path_buf(), b_router, 0);

        // A: paired to B, with session "s1" mirrored from it.
        let a_state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        a_state.init_machines(dir.path().to_path_buf());
        a_state.machines.get().unwrap().ensure_self();
        let (token, _device_id) = DeviceRegistry::add_machine_device("A", "mach-a", peer_dir.path()).unwrap();
        a_state.machines.get().unwrap().upsert_peer(PeerMachine {
            machine_id: "mach-b".into(),
            label: "B".into(),
            os: "test".into(),
            iroh_id: None,
            direct_url: Some(format!("http://127.0.0.1:{b_port}")),
            token,
            reverse_device_id: None,
            added_at: 0,
        });
        let settings = std::sync::Mutex::new(Settings::default());
        a_state.registry.register(
            RegisterInput {
                session_id: "scratch".into(),
                cwd: std::path::PathBuf::from("C:/x"),
                pid: 0,
                kind: InstanceKind::Interactive,
                is_remote: false,
                transcript_path: None,
                started_at: "2026-09-05T00:00:00Z".into(),
            },
            &settings,
            "2026-09-05T00:00:00Z",
        );
        let mut inst = a_state.registry.get("scratch").unwrap();
        inst.session_id = "s1".into();
        a_state.mirror.set_instances("mach-b", "B", vec![inst]);
        a_state.mirror.set_online("mach-b", true);

        let a_stt = crate::daemon::stt::SttSupervisor::new(dir.path().to_path_buf());
        let ctx = Arc::new(RemoteCtx {
            state: a_state,
            app_data: dir.path().to_path_buf(),
            router: Router::new(),
            stt: a_stt,
        });
        let resp =
            send_message(State(ctx), AxPath("s1".to_string()), Json(SendBody { text: "hello".into() })).await;
        assert_eq!(resp.status(), StatusCode::OK, "forwarded send must report success");
        assert_eq!(seen.lock().await.as_deref(), Some("hello"), "B's stub must have received our text");

        b_serve.kill();
    }

    /// A request whose `Transport` is itself `PeerMachine` must never be
    /// re-forwarded (same loop guard `machines/forward.rs::forward_one`
    /// applies) - proven here by scoping `TRANSPORT` the way `auth_mw` would
    /// for an incoming peer call, then asserting the REST route refuses
    /// rather than forwarding B's own request back out.
    #[tokio::test]
    async fn send_message_never_reforwards_a_peers_own_request() {
        use crate::daemon::machines::registry::PeerMachine;
        use crate::daemon::rpc::{Router, TRANSPORT};
        use crate::daemon::session::new_session_map;
        use crate::daemon::settings_cache::SettingsCache;
        use crate::daemon::state::DaemonState;
        use crate::sessions::kinds::InstanceKind;
        use crate::sessions::registry::RegisterInput;
        use crate::types::Settings;
        use tempfile::tempdir;

        let dir = tempdir().unwrap();

        let a_state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        a_state.init_machines(dir.path().to_path_buf());
        a_state.machines.get().unwrap().ensure_self();
        a_state.machines.get().unwrap().upsert_peer(PeerMachine {
            machine_id: "mach-b".into(),
            label: "B".into(),
            os: "test".into(),
            iroh_id: None,
            direct_url: Some("http://127.0.0.1:1".into()), // never dialed in this test
            token: "tok".into(),
            reverse_device_id: None,
            added_at: 0,
        });
        let settings = std::sync::Mutex::new(Settings::default());
        a_state.registry.register(
            RegisterInput {
                session_id: "scratch".into(),
                cwd: std::path::PathBuf::from("C:/x"),
                pid: 0,
                kind: InstanceKind::Interactive,
                is_remote: false,
                transcript_path: None,
                started_at: "2026-09-05T00:00:00Z".into(),
            },
            &settings,
            "2026-09-05T00:00:00Z",
        );
        let mut inst = a_state.registry.get("scratch").unwrap();
        inst.session_id = "s1".into();
        a_state.mirror.set_instances("mach-b", "B", vec![inst]);
        a_state.mirror.set_online("mach-b", true);

        let a_stt = crate::daemon::stt::SttSupervisor::new(dir.path().to_path_buf());
        let ctx = Arc::new(RemoteCtx {
            state: a_state,
            app_data: dir.path().to_path_buf(),
            router: Router::new(),
            stt: a_stt,
        });
        let resp = TRANSPORT
            .scope(Transport::PeerMachine("someone-else".into()), send_message(
                State(ctx),
                AxPath("s1".to_string()),
                Json(SendBody { text: "hi".into() }),
            ))
            .await;
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);
    }
}
