//! The common turn-taking lifecycle RPCs: start/send/cancel/end a session.

use super::{err_to_rpc, SessionIdOnly};
use crate::daemon::lifecycle::{self, LifecycleError, StartSessionParams};
use crate::daemon::machines::forward::map_peer_err;
use crate::daemon::rpc::{Router, RpcError};
use crate::daemon::state::DaemonState;
use crate::types::EndReason;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

/// `start_session`'s `machine_id` branch (D3): forwards to that peer's own
/// `start_session` with `machine_id` stripped (the peer has no use for it -
/// it always spawns locally) and returns its result verbatim. The mirror
/// delivers the new row via the peer's own `instances_changed` broadcast, so
/// no local publish is needed here.
async fn forward_start_session(
    state: &Arc<DaemonState>,
    machine_id: &str,
    mut params_value: Value,
) -> Result<Value, RpcError> {
    let registry = state
        .machines
        .get()
        .ok_or_else(|| RpcError::invalid_params("machine registry not initialised"))?;
    let peer = registry
        .peer(machine_id)
        .ok_or_else(|| RpcError::invalid_params(format!("unknown machine: {machine_id}")))?;
    if !state.mirror.is_online(machine_id) {
        return Err(RpcError {
            code: crate::daemon::machines::forward::ERR_MACHINE_OFFLINE,
            message: format!("{} is offline", peer.label),
            data: None,
        });
    }
    if let Some(obj) = params_value.as_object_mut() {
        obj.remove("machine_id");
    }
    let client = crate::daemon::machines::client_for(&peer).map_err(map_peer_err)?;
    client.call("start_session", params_value).await.map_err(map_peer_err)
}

#[derive(Debug, Deserialize)]
struct SendMessageParams {
    session_id: String,
    text: String,
}

pub fn register_core(router: &mut Router, state: Arc<DaemonState>) {
    let map = state.sessions.clone();
    {
        let state = state.clone();
        router.register("start_session", move |params, ctx| {
            let state = state.clone();
            async move {
                let params_value = params.unwrap_or(Value::Null);
                // Multi-machine federation: a `machine_id` naming a DIFFERENT
                // machine than us means "spawn this chat over there" - forward
                // whole-cloth rather than falling through to the local spawn
                // path below. Absent, or naming ourselves (no registry, or a
                // registry that just hasn't minted a self id yet, both count
                // as "must be us" since a real peer id can never match None),
                // means the existing local behavior, unchanged.
                let requested_machine =
                    params_value.get("machine_id").and_then(Value::as_str).map(str::to_string);
                if let Some(target) = requested_machine {
                    let self_id = state.machines.get().and_then(|r| r.self_machine()).map(|m| m.machine_id);
                    if self_id.as_deref() != Some(target.as_str()) {
                        return forward_start_session(&state, &target, params_value).await;
                    }
                }
                // Persist before the RPC returns, not via a client follow-up call -
                // a network-latency caller's own send_message can otherwise race
                // ahead of it (same pattern move_session_to_account guards against).
                let auto_accept = params_value.get("auto_accept").and_then(Value::as_bool).unwrap_or(false);
                // Idempotency key: the placeholder id is the one value that
                // survives the caller's retry (`daemon::start_tokens`). Absent
                // for channels, schedules and resumes - those spawn as before.
                let token = params_value
                    .get("placeholder_id")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let p: StartSessionParams = serde_json::from_value(params_value)
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                let cwd = p.cwd.clone();
                let model = p.model.clone();
                let effort = p.effort.clone();
                // Point of truth for the "Remote" sidebar segment: this RPC is the
                // one path the phone cockpit's new-chat/composer flow spawns
                // through (see remote_handlers.rs), so ctx.remote is set exactly
                // when the request actually arrived over that surface.
                let is_remote = ctx.remote;
                // Held across the spawn, so a racing retry waits for it.
                let mut claim = match token.as_deref() {
                    Some(t) => Some(state.start_tokens.claim(t).await),
                    None => None,
                };
                let already = claim.as_ref().and_then(|c| c.existing()).map(str::to_string);
                // A recorded id whose child is gone is not reusable.
                if let Some(sid) = already.filter(|sid| state.sessions.contains_key(sid)) {
                    log::info!(
                        "daemon: start_session token {} already spawned {sid}; returning it",
                        token.as_deref().unwrap_or("")
                    );
                    return Ok(json!({"session_id": sid}));
                }
                let session = lifecycle::spawn_session(&state, p).await.map_err(err_to_rpc)?;
                let sid = session.session_id.clone();
                if let Some(c) = claim.as_mut() {
                    c.record(&sid);
                }
                let account_id = session.account_id.clone();
                let now = chrono::Utc::now().to_rfc3339();
                crate::daemon::session_registration::register_new_session(
                    &state, &sid, &cwd, &model, &effort, &account_id, &now, auto_accept, None, is_remote,
                );
                // Deliberately NOT set_busy(true) here: no turn is in flight yet
                // (claude emits nothing until its first stdin message, so the
                // pump can never clear a busy set now). The caller's follow-up
                // send_message sets busy the moment a real turn starts. Setting
                // it at spawn left a started-but-never-messaged session busy
                // forever, deferring scheduled messages into it until they went
                // Missed and spinning the sidebar indefinitely (ai_todo 212).
                crate::daemon::machines::publish_instances_changed(&state);
                crate::sessions::persistence::save_snapshot_default(&state.registry);
                Ok(json!({"session_id": sid}))
            }
        });
    }
    {
        let map = map.clone();
        let state = state.clone();
        router.register("send_message", move |params, _ctx| {
            let map = map.clone();
            let state = state.clone();
            async move {
                let p: SendMessageParams = serde_json::from_value(params.unwrap_or(Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                let session = map.get(&p.session_id)
                    .ok_or_else(|| err_to_rpc(LifecycleError::NotFound(p.session_id.clone())))?
                    .clone();
                // Refusing beats writing into a live child (todo 873): the bump
                // below would strand the running turn's own result line on the
                // old gen, latching `busy` until the 20-minute watchdog. After
                // the map lookup, so a dead child still gets its -32004 respawn.
                lifecycle::refuse_if_busy(&state, &p.session_id).map_err(err_to_rpc)?;
                // Bump turn_gen (set_busy) BEFORE the write - a warm child can
                // emit its first stream_event before this fn resumes past the
                // write's own .await (todo 525 root cause 1).
                let gen_before = state.registry.current_turn_gen(&p.session_id);
                state.registry.set_awaiting(&p.session_id, None);
                state.registry.set_busy(&p.session_id, true);
                log::info!(
                    "daemon: send_message {}: turn_gen {gen_before} -> {} before stdin write",
                    p.session_id,
                    state.registry.current_turn_gen(&p.session_id)
                );
                crate::sessions::chat_state::set_busy(&p.session_id, true);
                if let Err(e) = lifecycle::send_message(&session, &p.text, false).await {
                    state.registry.set_busy(&p.session_id, false);
                    crate::sessions::chat_state::set_busy(&p.session_id, false);
                    return Err(err_to_rpc(e));
                }
                crate::daemon::machines::publish_instances_changed(&state);
                // Jarvis wake (todo 272 chunk 3): the desktop's user-facing send
                // path (`ipc/chat/run.rs`); the phone has its own REST route
                // (`remote_handlers::send_message`), and Jarvis's `send_to_session`
                // bypasses this RPC entirely, so a hit here is Joe, never Jarvis.
                // Tell Jarvis when Joe messages one of its workers directly so it
                // doesn't keep orchestrating a fleet member Joe just took over.
                if let Some(inst) = state.registry.get(&p.session_id) {
                    if let Some(jarvis_id) = inst.worker_of.clone() {
                        let display_name = inst.name.clone().unwrap_or_else(|| p.session_id.clone());
                        crate::daemon::jarvis_wake::enqueue(
                            &state,
                            &jarvis_id,
                            format!("[fleet] Joe messaged worker \"{display_name}\" directly"),
                        );
                        crate::daemon::jarvis_wake::drain(&state, &jarvis_id).await;
                    }
                }
                Ok(json!({"ok": true}))
            }
        });
    }
    {
        let map = map.clone();
        let state = state.clone();
        router.register("cancel_turn", move |params, _ctx| {
            let map = map.clone();
            let state = state.clone();
            async move {
                let p: SessionIdOnly = serde_json::from_value(params.unwrap_or(Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                lifecycle::cancel_turn(&map, &p.session_id).await.map_err(err_to_rpc)?;
                // No force-clear here (todo 873): the interrupt is cooperative,
                // so only the child's own trailing result line - via pump.rs's
                // gen-matched set_busy_false_if_gen - should end the turn. An
                // eager clear let a racing send_message write into the still-live child.
                // The interrupted turn's verdict (an AUQ's "question", a prior
                // turn's "waiting") is dead with the cancel - clear it so the
                // sidebar doesn't keep flagging a question nobody is asking.
                state.registry.set_awaiting(&p.session_id, None);
                // Settle any AskUserQuestion/permission prompt still open for this
                // session (e.g. the user hit Skip on the question card, which now
                // routes through this same interrupt instead of answering the
                // hook). Drops the blocked hook oneshot(s) - so a still-alive hook
                // process resolves rather than hanging up to the 3600s prompt
                // ceiling - and clears the prompt record so `list_pending_prompts`
                // stops resurrecting the card. Mirrors the EOF-triggered "ghost
                // prompt" cleanup in `lifecycle.rs`'s pump loop; a no-op when
                // nothing is open for this session (the common Stop-turn case).
                state.expire_prompts_for_session(&p.session_id).await;
                crate::daemon::machines::publish_instances_changed(&state);
                Ok(json!({"ok": true}))
            }
        });
    }
    {
        let map = map.clone();
        let state = state.clone();
        router.register("end_session", move |params, _ctx| {
            let map = map.clone();
            let state = state.clone();
            async move {
                let p: SessionIdOnly = serde_json::from_value(params.unwrap_or(Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                lifecycle::end_session(&map, &p.session_id).await.map_err(err_to_rpc)?;
                let now = chrono::Utc::now().to_rfc3339();
                state.registry.mark_ended(&p.session_id, EndReason::Manual, &now);
                crate::daemon::machines::publish_instances_changed(&state);
                crate::sessions::persistence::save_snapshot_default(&state.registry);
                Ok(json!({"ok": true}))
            }
        });
    }
}

#[cfg(test)]
mod machine_target_tests {
    use super::*;
    use crate::daemon::device_registry::DeviceRegistry;
    use crate::daemon::machines::registry::PeerMachine;
    use crate::daemon::rpc::{ConnectionContext, Request};
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use serde_json::json;
    use tempfile::tempdir;

    fn dummy_ctx() -> ConnectionContext {
        let (tx, _rx) = tokio::sync::mpsc::channel(16);
        ConnectionContext::new(tx)
    }

    fn start_session_params(extra: serde_json::Value) -> Value {
        let mut base = json!({
            "cwd": "Z:\\does\\not\\exist",
            "model": "opus",
            "effort": "high",
            "resume_id": null,
        });
        if let (Some(base_obj), Some(extra_obj)) = (base.as_object_mut(), extra.as_object()) {
            for (k, v) in extra_obj {
                base_obj.insert(k.clone(), v.clone());
            }
        }
        base
    }

    #[tokio::test]
    async fn start_session_with_machine_id_equal_to_self_runs_locally() {
        let dir = tempdir().unwrap();
        let state = DaemonState::new(new_session_map(), crate::daemon::settings_cache::SettingsCache::new(crate::types::Settings::default()));
        state.init_machines(dir.path().to_path_buf());
        let mine = state.machines.get().unwrap().ensure_self();

        let mut router = Router::new();
        register_core(&mut router, state.clone());
        let resp = router
            .dispatch(
                Request {
                    jsonrpc: "2.0".into(),
                    id: json!(1),
                    method: "start_session".into(),
                    params: Some(start_session_params(json!({"machine_id": mine.machine_id}))),
                },
                dummy_ctx(),
            )
            .await;
        // Reaches spawn_session's own validation (CwdMissing -> invalid_params),
        // proving this ran the LOCAL spawn path rather than forwarding.
        assert_eq!(resp.error.unwrap().code, -32602);
    }

    #[tokio::test]
    async fn start_session_with_a_different_machine_id_forwards_and_strips_it() {
        use crate::daemon::rpc::RpcError as RE;

        let dir = tempdir().unwrap();
        let peer_dir = tempdir().unwrap();

        // Peer daemon's stub start_session: records whether `machine_id` made
        // it through (it must not) and returns a fake session id.
        let mut b_router = Router::new();
        b_router.register("start_session", |params, _ctx| async move {
            let has_machine_id = params.as_ref().and_then(|p| p.get("machine_id")).is_some();
            if has_machine_id {
                return Err::<Value, RE>(RE::invalid_params("machine_id must not be forwarded"));
            }
            Ok(json!({"session_id": "peer-spawned-1"}))
        });
        let b_state = DaemonState::new(new_session_map(), SettingsCache::new(crate::types::Settings::default()));
        let (_stt, b_port, b_serve) =
            crate::daemon::remote_server::spawn_on(b_state.clone(), peer_dir.path().to_path_buf(), b_router, 0);

        let state = DaemonState::new(new_session_map(), SettingsCache::new(crate::types::Settings::default()));
        state.init_machines(dir.path().to_path_buf());
        state.machines.get().unwrap().ensure_self();
        let (token, _device_id) = DeviceRegistry::add_machine_device("A", "mach-a", peer_dir.path()).unwrap();
        state.machines.get().unwrap().upsert_peer(PeerMachine {
            machine_id: "mach-b".into(),
            label: "B".into(),
            os: "test".into(),
            iroh_id: None,
            direct_url: Some(format!("http://127.0.0.1:{b_port}")),
            token,
            reverse_device_id: None,
            added_at: 0,
        });
        // set_online only flips an EXISTING entry's flag - set_instances
        // creates it first.
        state.mirror.set_instances("mach-b", "B", vec![]);
        state.mirror.set_online("mach-b", true);

        let mut router = Router::new();
        register_core(&mut router, state.clone());
        let resp = router
            .dispatch(
                Request {
                    jsonrpc: "2.0".into(),
                    id: json!(1),
                    method: "start_session".into(),
                    params: Some(start_session_params(json!({"machine_id": "mach-b"}))),
                },
                dummy_ctx(),
            )
            .await;
        assert!(resp.error.is_none(), "expected the peer's result, got {:?}", resp.error);
        assert_eq!(resp.result.unwrap()["session_id"], json!("peer-spawned-1"));
        assert_eq!(state.sessions.len(), 0, "must not have spawned anything locally");

        b_serve.kill();
    }
}
