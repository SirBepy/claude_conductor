//! Peer-forwarding seam for the shared RPC router (see `rpc::Router::set_forwarder`):
//! when a request's session id resolves to a session mirrored from a paired
//! peer machine, this forwards the call to that peer instead of the local
//! handler failing "no such session". Installed once at daemon startup via
//! [`install`].

use std::sync::Arc;

use serde_json::Value;

use crate::daemon::remote_handlers::allowed;
use crate::daemon::rpc::{ConnectionContext, ForwardFuture, Router, RpcError, Transport};
use crate::daemon::state::DaemonState;

use super::peer_client::{client_for, PeerError};

/// The mirrored session's owning machine understood the method (per
/// `remote_handlers::TRANSPORT_TABLE`'s `PM`/`M` set) but this daemon refuses
/// to relay it - the method has no forwarding story (e.g. it isn't
/// session-scoped in a way a peer accepts).
pub const ERR_NOT_FORWARDABLE: i32 = -32011;
/// The owning peer is not currently reachable - unregistered, or its mirror
/// link is down.
pub const ERR_MACHINE_OFFLINE: i32 = -32012;
/// The peer rejected our bearer token - re-pairing is the fix, not a retry.
pub const ERR_REPAIR_REQUIRED: i32 = -32013;

/// Methods whose session-identifying param is literally named `id` rather
/// than `session_id`. Empty today: every current `PM`/`M` method in
/// `remote_handlers::TRANSPORT_TABLE` keys on `session_id` (verified by
/// reading each handler under `daemon/methods/`) - `confirm_question_rendered`'s
/// `id` is a prompt id, not a session id, and that method is phone-only
/// anyway. Kept as a named seam for the first future method that does.
const ID_PARAM_METHODS: &[&str] = &[];

/// Extracts the session id a request targets, if any: `params.session_id`,
/// or `params.id` for the small allowlist above. Any other shape (no
/// identifying param, e.g. `start_session`'s `cwd`, or `respond_permission`'s
/// `request_id`) is not a call this seam forwards - see `install`'s doc.
fn extract_session_id(method: &str, params: &Value) -> Option<String> {
    if let Some(s) = params.get("session_id").and_then(Value::as_str) {
        return Some(s.to_string());
    }
    if ID_PARAM_METHODS.contains(&method) {
        return params.get("id").and_then(Value::as_str).map(str::to_string);
    }
    None
}

/// Maps a `PeerClient` failure to the RPC error a caller on THIS daemon sees.
/// `Rejected` passes the peer's own code/message through unchanged - it
/// already reflects the peer's real handler error, no reason to mask it.
pub(crate) fn map_peer_err(e: PeerError) -> RpcError {
    match e {
        PeerError::Unauthorized => RpcError {
            code: ERR_REPAIR_REQUIRED,
            message: "peer rejected our token; re-pair required".into(),
            data: None,
        },
        PeerError::Unreachable(msg) => {
            RpcError { code: ERR_MACHINE_OFFLINE, message: format!("machine unreachable: {msg}"), data: None }
        }
        PeerError::Rejected { code, message } => RpcError { code: code as i32, message, data: None },
        PeerError::Protocol(msg) => RpcError::internal(msg),
    }
}

/// Installs the mirrored-session forwarder on `router`. Never forwards a
/// request that itself arrived FROM a peer (`Transport::PeerMachine`) -
/// that's always about OUR own local sessions, and forwarding it again would
/// loop. Every other request whose `session_id`/`id` resolves to a mirrored
/// row (`state.mirror.owner_of`) is forwarded if the method is one the
/// owning peer accepts (`remote_handlers::allowed` against
/// `Transport::PeerMachine`, the same allowlist a real peer request is
/// checked against) - a `None` from `extract_session_id` or a local
/// `owner_of` miss falls through to the normal local handler unchanged.
pub fn install(state: Arc<DaemonState>, router: &mut Router) {
    router.set_forwarder(Arc::new(move |method: &str, params: Option<Value>, ctx: &ConnectionContext| {
        let state = state.clone();
        let method = method.to_string();
        let transport = ctx.transport.clone();
        let fut: ForwardFuture = Box::pin(async move { forward_one(&state, &method, params, &transport).await });
        fut
    }));
}

async fn forward_one(
    state: &Arc<DaemonState>,
    method: &str,
    params: Option<Value>,
    transport: &Transport,
) -> Option<Result<Value, RpcError>> {
    if matches!(transport, Transport::PeerMachine(_)) {
        return None;
    }
    let params_value = params.unwrap_or(Value::Null);
    let session_id = extract_session_id(method, &params_value)?;
    let machine_id = state.mirror.owner_of(&session_id)?;

    if !allowed(method, &Transport::PeerMachine(machine_id.clone())) {
        return Some(Err(RpcError {
            code: ERR_NOT_FORWARDABLE,
            message: "method is not available for a session hosted on another machine".into(),
            data: None,
        }));
    }
    let Some(registry) = state.machines.get() else {
        return Some(Err(RpcError {
            code: ERR_MACHINE_OFFLINE,
            message: "machine registry not initialised".into(),
            data: None,
        }));
    };
    let Some(peer) = registry.peer(&machine_id) else {
        return Some(Err(RpcError { code: ERR_MACHINE_OFFLINE, message: "paired machine no longer known".into(), data: None }));
    };
    if !state.mirror.is_online(&machine_id) {
        return Some(Err(RpcError { code: ERR_MACHINE_OFFLINE, message: format!("{} is offline", peer.label), data: None }));
    }
    let client = match client_for(&peer) {
        Ok(c) => c,
        Err(e) => return Some(Err(map_peer_err(e))),
    };
    Some(client.call(method, params_value).await.map_err(map_peer_err))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::device_registry::DeviceRegistry;
    use crate::daemon::machines::registry::PeerMachine;
    use crate::daemon::rpc::{ConnectionContext, Request};
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::types::Settings;
    use serde_json::json;
    use tempfile::tempdir;

    fn dummy_ctx() -> ConnectionContext {
        let (tx, _rx) = tokio::sync::mpsc::channel(16);
        ConnectionContext::new(tx)
    }

    async fn state_with_machines_and_peer(
        dir: &std::path::Path,
        peer_dir: &std::path::Path,
        b_port: u16,
        online: bool,
    ) -> (Arc<DaemonState>, PeerMachine) {
        let state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        state.init_machines(dir.to_path_buf());
        state.machines.get().unwrap().ensure_self();
        let (token, _device_id) = DeviceRegistry::add_machine_device("B", "mach-b", peer_dir).unwrap();
        let peer = PeerMachine {
            machine_id: "mach-b".into(),
            label: "B".into(),
            os: "test".into(),
            iroh_id: None,
            direct_url: Some(format!("http://127.0.0.1:{b_port}")),
            token,
            reverse_device_id: None,
            added_at: 0,
        };
        state.machines.get().unwrap().upsert_peer(peer.clone());
        state.mirror.set_instances("mach-b", "B", vec![]);
        state.mirror.set_online("mach-b", online);
        (state, peer)
    }

    fn mirror_owned_session(state: &Arc<DaemonState>, session_id: &str) {
        use crate::sessions::kinds::InstanceKind;
        let mut inst = crate::types::Instance {
            session_id: session_id.into(),
            pid: 0,
            cwd: std::path::PathBuf::from("C:/x"),
            project_id: "proj".into(),
            kind: InstanceKind::Interactive,
            is_remote: false,
            started_at: "2026-09-05T00:00:00Z".into(),
            transcript_path: None,
            bridge_session_id: None,
            name: None,
            ended_at: None,
            end_reason: None,
            busy: false,
            model: String::new(),
            effort: String::new(),
            awaiting: None,
            last_notified_awaiting: None,
            autopilot: false,
            jarvis: false,
            worker_of: None,
            closing: false,
            turn_gen: 0,
            last_event_at: None,
            channel_epoch: 0,
            account_id: None,
            rate_limited_resets_at: None,
            rate_limited_type: None,
            frozen: false,
            frozen_needs_continue: false,
            auto_frozen: false,
            held_count: 0,
            local_task_running: false,
            successor_of: None,
            machine: None,
        };
        inst.session_id = session_id.into();
        state.mirror.set_instances("mach-b", "B", vec![inst]);
        state.mirror.set_online("mach-b", true);
    }

    #[tokio::test]
    async fn local_session_falls_through_to_none() {
        let dir = tempdir().unwrap();
        let peer_dir = tempdir().unwrap();
        let (state, _peer) = state_with_machines_and_peer(dir.path(), peer_dir.path(), 0, true).await;
        let result = forward_one(&state, "send_message", Some(json!({"session_id": "unmirrored"})), &Transport::Local).await;
        assert!(result.is_none());
    }

    #[tokio::test]
    async fn peer_machine_transport_never_forwards() {
        let dir = tempdir().unwrap();
        let peer_dir = tempdir().unwrap();
        let (state, _peer) = state_with_machines_and_peer(dir.path(), peer_dir.path(), 0, true).await;
        mirror_owned_session(&state, "s1");
        let result = forward_one(
            &state,
            "send_message",
            Some(json!({"session_id": "s1"})),
            &Transport::PeerMachine("someone-else".into()),
        )
        .await;
        assert!(result.is_none(), "a peer's own request must never be re-forwarded");
    }

    #[tokio::test]
    async fn non_forwardable_method_is_rejected() {
        let dir = tempdir().unwrap();
        let peer_dir = tempdir().unwrap();
        let (state, _peer) = state_with_machines_and_peer(dir.path(), peer_dir.path(), 0, true).await;
        mirror_owned_session(&state, "s1");
        // freeze_session/unfreeze_session/get_settings etc are phone-only (P),
        // not machine-callable - any P-only method proves the rejection path.
        let result = forward_one(&state, "get_settings", Some(json!({"session_id": "s1"})), &Transport::Local).await;
        match result {
            Some(Err(e)) => assert_eq!(e.code, ERR_NOT_FORWARDABLE),
            other => panic!("expected Some(Err(ERR_NOT_FORWARDABLE)), got {other:?}"),
        }
    }

    #[tokio::test]
    async fn offline_peer_is_rejected() {
        let dir = tempdir().unwrap();
        let peer_dir = tempdir().unwrap();
        let (state, _peer) = state_with_machines_and_peer(dir.path(), peer_dir.path(), 0, false).await;
        mirror_owned_session(&state, "s1");
        state.mirror.set_online("mach-b", false);
        let result = forward_one(&state, "send_message", Some(json!({"session_id": "s1", "text": "hi"})), &Transport::Local).await;
        match result {
            Some(Err(e)) => assert_eq!(e.code, ERR_MACHINE_OFFLINE),
            other => panic!("expected Some(Err(ERR_MACHINE_OFFLINE)), got {other:?}"),
        }
    }

    #[tokio::test]
    async fn forwardable_method_lands_on_the_peer() {
        use crate::daemon::rpc::RpcError as RE;

        let dir = tempdir().unwrap();
        let peer_dir = tempdir().unwrap();

        // Peer daemon's own router: register a stub send_message that records
        // the call and errors distinctively, so a round trip is provable
        // without depending on real session/turn machinery.
        let mut b_router = Router::new();
        b_router.register("send_message", |params, _ctx| async move {
            let text = params.and_then(|p| p.get("text").and_then(|t| t.as_str().map(str::to_string)));
            Err::<Value, RE>(RE { code: -32099, message: format!("stub saw: {text:?}"), data: None })
        });
        let b_state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        let (_stt, b_port, b_serve) =
            crate::daemon::remote_server::spawn_on(b_state.clone(), peer_dir.path().to_path_buf(), b_router, 0);

        let (state, _peer) = state_with_machines_and_peer(dir.path(), peer_dir.path(), b_port, true).await;
        mirror_owned_session(&state, "s1");

        let result =
            forward_one(&state, "send_message", Some(json!({"session_id": "s1", "text": "hello"})), &Transport::Local)
                .await;
        match result {
            Some(Err(e)) => {
                assert_eq!(e.code, -32099);
                assert!(e.message.contains("hello"), "peer must have received our params: {}", e.message);
            }
            other => panic!("expected the peer's stub error to round-trip, got {other:?}"),
        }
        b_serve.kill();
    }

    #[tokio::test]
    async fn installed_forwarder_short_circuits_dispatch_for_a_mirrored_session() {
        let dir = tempdir().unwrap();
        let peer_dir = tempdir().unwrap();
        let (state, _peer) = state_with_machines_and_peer(dir.path(), peer_dir.path(), 0, false).await;
        mirror_owned_session(&state, "s1");

        let mut router = Router::new();
        install(state.clone(), &mut router);
        let resp = router
            .dispatch(
                Request {
                    jsonrpc: "2.0".into(),
                    id: json!(1),
                    method: "send_message".into(),
                    params: Some(json!({"session_id": "s1", "text": "hi"})),
                },
                dummy_ctx(),
            )
            .await;
        // Offline peer -> forwarder returns Some(Err(..)), never falls through
        // to "method not found" (there is no local send_message handler here).
        assert_eq!(resp.error.unwrap().code, ERR_MACHINE_OFFLINE);
    }

    #[tokio::test]
    async fn installed_forwarder_falls_through_for_an_unmirrored_session() {
        let dir = tempdir().unwrap();
        let peer_dir = tempdir().unwrap();
        let (state, _peer) = state_with_machines_and_peer(dir.path(), peer_dir.path(), 0, true).await;

        let mut router = Router::new();
        router.register("echo", |params, _ctx| async move { Ok(params.unwrap_or(Value::Null)) });
        install(state, &mut router);
        let resp = router
            .dispatch(
                Request { jsonrpc: "2.0".into(), id: json!(1), method: "echo".into(), params: Some(json!("hi")) },
                dummy_ctx(),
            )
            .await;
        assert_eq!(resp.result, Some(json!("hi")));
    }
}
