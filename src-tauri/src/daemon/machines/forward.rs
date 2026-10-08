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
/// `remote_transport_table::TRANSPORT_TABLE`'s `PM`/`M` set) but this daemon refuses
/// to relay it - the method has no forwarding story (e.g. it isn't
/// session-scoped in a way a peer accepts).
pub const ERR_NOT_FORWARDABLE: i32 = -32011;
/// The owning peer is not currently reachable - unregistered, or its mirror
/// link is down.
pub const ERR_MACHINE_OFFLINE: i32 = -32012;
/// The peer rejected our bearer token - re-pairing is the fix, not a retry.
pub const ERR_REPAIR_REQUIRED: i32 = -32013;

/// Methods whose session-identifying param is literally named `id` rather
/// than `session_id`. Still empty - NOT because `respond_permission`,
/// `respond_question`, and `confirm_question_rendered` identify a session
/// another way: all three key on a prompt id (`request_id`/`id`), which
/// names a prompt, not a session. The mirrored-prompt cache solves that the
/// other direction instead: every client sends `session_id` ALONGSIDE the
/// prompt id when answering or acking a mirrored chat's prompt, purely so
/// this forwarder can route it - `extract_session_id` above already reads
/// `params.session_id` generically, so all three forward correctly with no
/// further change here as long as `remote_transport_table::TRANSPORT_TABLE`
/// masks them `PM`/`M`. Kept as a named seam for a future method whose only
/// identifying param really is `id`, with no parallel `session_id` a client
/// could send instead.
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
    let client = match resolve_peer_client(state, &machine_id).await {
        Ok(c) => c,
        Err(e) => return Some(Err(e)),
    };
    Some(client.call(method, params_value).await.map_err(map_peer_err))
}

/// Registry lookup, online check, and `client_for`, the three steps every
/// forwarding path needs before actually calling a peer - shared by
/// `forward_one` above and `forward_send_message` below (the REST send route
/// isn't routed through the shared RPC router's forwarder seam, so it can't
/// reuse `forward_one` itself, only this common tail).
async fn resolve_peer_client(
    state: &Arc<DaemonState>,
    machine_id: &str,
) -> Result<super::peer_client::PeerClient, RpcError> {
    let Some(registry) = state.machines.get() else {
        return Err(RpcError {
            code: ERR_MACHINE_OFFLINE,
            message: "machine registry not initialised".into(),
            data: None,
        });
    };
    let Some(peer) = registry.peer(machine_id) else {
        return Err(RpcError { code: ERR_MACHINE_OFFLINE, message: "paired machine no longer known".into(), data: None });
    };
    if !state.mirror.is_online(machine_id) {
        return Err(RpcError { code: ERR_MACHINE_OFFLINE, message: format!("{} is offline", peer.label), data: None });
    }
    client_for(state, &peer).await.map_err(map_peer_err)
}

/// Forwards the REST `POST /api/sessions/:id/send` route (remote_handlers.rs)
/// to `machine_id`'s own `send_message` RPC: that endpoint is a dedicated
/// REST route, not an `/api/rpc` call, so it never passes through the shared
/// router's `forward_one` seam above and needs its own entry point - built on
/// the same `resolve_peer_client` tail so the client/offline/error-mapping
/// logic isn't duplicated between the two call sites.
pub(crate) async fn forward_send_message(
    state: &Arc<DaemonState>,
    machine_id: &str,
    session_id: &str,
    text: &str,
) -> Result<(), RpcError> {
    let client = resolve_peer_client(state, machine_id).await?;
    client
        .call("send_message", serde_json::json!({"session_id": session_id, "text": text}))
        .await
        .map_err(map_peer_err)?;
    Ok(())
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

    // ── Two-daemon end-to-end coverage for the G5 remask (remote_transport_table.rs) ──

    /// A prompt pending on B (with its owning session marked `awaiting`)
    /// reaches A's mirrored prompt cache purely through A's real `peer_link`
    /// over real loopback HTTP/WS - proving `list_pending_prompts`'s remask
    /// from `P` to `PM` is what makes the fetch succeed (it would 403 under
    /// the old mask, and the cache would stay empty forever).
    #[tokio::test]
    async fn prompt_pending_on_b_reaches_as_mirror_via_a_real_peer_link() {
        use crate::daemon::methods::register_responders;
        use crate::sessions::kinds::InstanceKind;
        use crate::sessions::registry::RegisterInput;

        let a_dir = tempdir().unwrap();
        let b_dir = tempdir().unwrap();

        let b_state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        let settings = std::sync::Mutex::new(Settings::default());
        b_state.registry.register(
            RegisterInput {
                session_id: "b-session-1".into(),
                cwd: std::path::PathBuf::from("C:/b-repo"),
                pid: 4242,
                kind: InstanceKind::Interactive,
                is_remote: false,
                transcript_path: None,
                started_at: "2026-09-05T00:00:00Z".into(),
            },
            &settings,
            "2026-09-05T00:00:00Z",
        );
        // awaiting != None is what makes A's link fetch prompts the instant
        // its first resync frame reports this row (`maybe_refresh_prompts_after_frame`).
        b_state.registry.set_awaiting("b-session-1", Some("question".into()));
        b_state.add_prompt("mirrored-1", "question-requested", json!({"session_id": "b-session-1"}), true).await;

        let mut b_router = Router::new();
        register_responders(&mut b_router, b_state.clone());
        let (_b_stt, b_port, b_serve) =
            crate::daemon::remote_server::spawn_on(b_state.clone(), b_dir.path().to_path_buf(), b_router, 0);
        let b_id = b_state.machines.get().unwrap().self_machine().unwrap().machine_id;

        let a_state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        a_state.init_machines(a_dir.path().to_path_buf());
        let a_id = a_state.machines.get().unwrap().ensure_self().machine_id;
        let (token, _device_id) = DeviceRegistry::add_machine_device("A", &a_id, b_dir.path()).unwrap();
        a_state.machines.get().unwrap().upsert_peer(PeerMachine {
            machine_id: b_id.clone(),
            label: "B".into(),
            os: "test".into(),
            iroh_id: None,
            direct_url: Some(format!("http://127.0.0.1:{b_port}")),
            token,
            reverse_device_id: None,
            added_at: 0,
        });

        crate::daemon::machines::MachineHub::sync_links(&a_state);

        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            if a_state.mirror.has_cached_prompts(&b_id) {
                break;
            }
            if tokio::time::Instant::now() >= deadline {
                panic!("B's prompt never reached A's mirror within 5s: {:?}", a_state.mirror.prompts());
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        let ids: Vec<String> =
            a_state.mirror.prompts().iter().map(|p| p["id"].as_str().unwrap().to_string()).collect();
        assert!(ids.contains(&"mirrored-1".to_string()), "expected mirrored-1 among {ids:?}");

        b_serve.kill();
    }

    /// `respond_question` dispatched on A for a session mirrored from B is
    /// forwarded over real loopback HTTP and resolves B's OWN live waiter -
    /// proving the remask (and the `session_id` every client now sends
    /// alongside `request_id`) actually delivers an answer end to end, not
    /// just that the RPC round-trips.
    #[tokio::test]
    async fn respond_question_dispatched_on_a_resolves_bs_real_waiter() {
        use crate::daemon::methods::register_responders;
        use tokio::sync::oneshot;

        let dir = tempdir().unwrap();
        let peer_dir = tempdir().unwrap();

        let b_state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        let (tx, rx) = oneshot::channel();
        b_state.pending.lock().await.insert("req-1".to_string(), tx);

        let mut b_router = Router::new();
        register_responders(&mut b_router, b_state.clone());
        let (_b_stt, b_port, b_serve) =
            crate::daemon::remote_server::spawn_on(b_state.clone(), peer_dir.path().to_path_buf(), b_router, 0);

        let (state, _peer) = state_with_machines_and_peer(dir.path(), peer_dir.path(), b_port, true).await;
        mirror_owned_session(&state, "b-session-1");

        let mut router = Router::new();
        install(state.clone(), &mut router);
        let resp = router
            .dispatch(
                Request {
                    jsonrpc: "2.0".into(),
                    id: json!(1),
                    method: "respond_question".into(),
                    params: Some(json!({
                        "request_id": "req-1",
                        "session_id": "b-session-1",
                        "answers": {"color": "blue"},
                        "skipped": false
                    })),
                },
                dummy_ctx(),
            )
            .await;
        assert!(resp.error.is_none(), "got {:?}", resp.error);

        let answer = tokio::time::timeout(std::time::Duration::from_secs(5), rx)
            .await
            .expect("B's waiter must resolve within 5s")
            .expect("B's responder dropped the sender");
        assert_eq!(answer, json!({"answers": {"color": "blue"}}));

        b_serve.kill();
    }

    /// `set_session_model` on A for a session mirrored from B is forwarded
    /// over real loopback HTTP, landing on B's stub with our params intact -
    /// before the remask this method hit `ERR_NOT_FORWARDABLE`.
    #[tokio::test]
    async fn set_session_model_forwards_to_the_mirrored_sessions_owner() {
        use crate::daemon::rpc::RpcError as RE;

        let dir = tempdir().unwrap();
        let peer_dir = tempdir().unwrap();

        let mut b_router = Router::new();
        b_router.register("set_session_model", |params, _ctx| async move {
            let model = params.and_then(|p| p.get("model").and_then(|m| m.as_str().map(str::to_string)));
            Err::<Value, RE>(RE { code: -32098, message: format!("stub saw: {model:?}"), data: None })
        });
        let b_state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        let (_b_stt, b_port, b_serve) =
            crate::daemon::remote_server::spawn_on(b_state.clone(), peer_dir.path().to_path_buf(), b_router, 0);

        let (state, _peer) = state_with_machines_and_peer(dir.path(), peer_dir.path(), b_port, true).await;
        mirror_owned_session(&state, "s1");

        let result =
            forward_one(&state, "set_session_model", Some(json!({"session_id": "s1", "model": "opus"})), &Transport::Local)
                .await;
        match result {
            Some(Err(e)) => {
                assert_eq!(e.code, -32098);
                assert!(e.message.contains("opus"), "peer must have received our params: {}", e.message);
            }
            other => panic!("expected the peer's stub error to round-trip, got {other:?}"),
        }
        b_serve.kill();
    }

    /// A real peer-bearer-token HTTP call hitting A's `/api/rpc` resolves to
    /// `Transport::PeerMachine` through the real auth middleware (not a
    /// scoped-in-test transport) and A's `list_pending_prompts` still excludes
    /// a prompt A itself mirrors from a THIRD machine - the one-hop rule
    /// exercised over the real HTTP boundary, not just at dispatch level.
    #[tokio::test]
    async fn peer_machine_caller_over_real_http_sees_local_prompts_only() {
        use crate::daemon::methods::register_responders;

        let a_dir = tempdir().unwrap();

        let a_state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        a_state.add_prompt("local-1", "question-requested", json!({"session_id": "s-local"}), true).await;
        // A prompt A itself mirrors from a third machine - must never be
        // echoed back to a peer calling list_pending_prompts ON us.
        a_state.mirror.set_instances("mach-c", "C", vec![]);
        a_state.mirror.set_prompts(
            "mach-c",
            vec![json!({"id": "mirrored-from-c", "event": "question-requested", "payload": {"session_id": "s-remote"}, "durable": true})],
        );

        let mut a_router = Router::new();
        register_responders(&mut a_router, a_state.clone());
        let (_a_stt, a_port, a_serve) =
            crate::daemon::remote_server::spawn_on(a_state.clone(), a_dir.path().to_path_buf(), a_router, 0);

        // A Machine-kind bearer token minted into A's OWN device registry,
        // same as a real pairing would - so A's auth_mw resolves the caller
        // as Transport::PeerMachine for real, not via a test-scoped transport.
        let (token, _device_id) = DeviceRegistry::add_machine_device("B", "mach-b", a_dir.path()).unwrap();
        let client = crate::daemon::machines::PeerClient::new(&format!("http://127.0.0.1:{a_port}"), &token);
        let result = client.call("list_pending_prompts", Value::Null).await.unwrap();
        let ids: Vec<&str> = result.as_array().unwrap().iter().map(|p| p["id"].as_str().unwrap()).collect();
        assert_eq!(ids, vec!["local-1"], "a peer caller must never see a prompt A mirrored from a third machine");

        a_serve.kill();
    }
}
