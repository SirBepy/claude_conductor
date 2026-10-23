//! The common turn-taking lifecycle RPCs: start/send/cancel/end a session.

use super::{err_to_rpc, SessionIdOnly};
use crate::daemon::lifecycle::{self, LifecycleError, StartSessionParams};
use crate::daemon::machines::forward::map_peer_err;
use crate::daemon::methods::pr_review::is_known_cwd;
use crate::daemon::rpc::{Router, RpcError, Transport};
use crate::daemon::state::DaemonState;
use crate::types::EndReason;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

/// An account refusal from the host, prefixed with the host's name: the
/// caller's picker listed that machine's accounts, so "account X not found"
/// alone would read as a problem on this machine.
fn name_host_on_account_refusal(e: crate::daemon::machines::PeerError, host_label: &str) -> RpcError {
    match e {
        crate::daemon::machines::PeerError::Rejected { code, message } if message.starts_with("account ") => {
            RpcError { code: code as i32, message: format!("{host_label}: {message}"), data: None }
        }
        other => map_peer_err(other),
    }
}

/// `start_session`'s `machine_id` branch (D3): forwards to that peer's own
/// `start_session` with `machine_id` stripped (the peer has no use for it -
/// it always spawns locally) and returns its result verbatim. `account_id`
/// is passed through untouched: the new-chat picker listed the HOST's
/// accounts for a peer target (`list_machine_accounts`), so the id is the
/// host's own and the host's normal account resolution is the authority. The
/// mirror
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
    crate::daemon::machines::forward::require_online(state, &peer).await?;
    if let Some(obj) = params_value.as_object_mut() {
        obj.remove("machine_id");
    }
    let client = crate::daemon::machines::client_for(state, &peer).await.map_err(map_peer_err)?;
    let result = client
        .call("start_session", params_value)
        .await
        .map_err(|e| name_host_on_account_refusal(e, &peer.label))?;
    // The peer's own `instances_changed` broadcast can take up to one
    // mirror-link cycle to report the chat it just spawned for us, so a
    // caller's immediate follow-up `attach_session`/`send_message` would
    // find no mirrored row yet. Record the id as pending-owned right away so
    // `MirrorState::owner_of` resolves it before that first frame arrives.
    if let Some(sid) = result.get("session_id").and_then(Value::as_str) {
        state.mirror.record_pending(sid, machine_id);
    }
    Ok(result)
}

/// Refuses a `start_session` that would spawn a peer-hosted chat on THIS
/// machine: its transcript and folder live on the host, so a local resume (or
/// a fork of it) can only fail, or worse start a second diverging copy. Hosted
/// there means `machines::mirrored_owner` (local registry first, then the
/// live mirror, then the persisted ownership record).
fn refuse_peer_hosted(state: &DaemonState, p: &StartSessionParams) -> Option<RpcError> {
    for id in [p.resume_id.as_deref(), p.new_session_id.as_deref()].into_iter().flatten() {
        let Some(machine_id) = crate::daemon::machines::mirrored_owner(state, id) else { continue };
        let label = state
            .machines
            .get()
            .and_then(|r| r.peer(&machine_id))
            .map(|peer| peer.label)
            .unwrap_or(machine_id);
        return Some(RpcError {
            code: crate::daemon::machines::forward::ERR_NOT_FORWARDABLE,
            message: format!("chat {id} is hosted on {label}; it cannot be started on this machine"),
            data: None,
        });
    }
    None
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
                // After the `machine_id` forward above, so a start aimed at the
                // host still reaches it; this only stops a LOCAL spawn.
                if let Some(refusal) = refuse_peer_hosted(&state, &p) {
                    return Err(refusal);
                }
                // A phone or peer may only start agents inside a registered
                // project (or one of its worktrees), not in `C:\` or the home
                // folder; `create_project_folder` is their way to add one. The
                // desktop and daemon-internal spawns (Local) are unrestricted.
                // Checked before the idempotency claim so a refusal records nothing.
                if !matches!(ctx.transport, Transport::Local)
                    && !is_known_cwd(&state, &p.cwd.to_string_lossy())
                {
                    return Err(RpcError::invalid_params("unknown cwd".to_string()));
                }
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
        router.register("send_message", move |params, ctx| {
            let map = map.clone();
            let state = state.clone();
            async move {
                let p: SendMessageParams = serde_json::from_value(params.unwrap_or(Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                let live = map.get(&p.session_id).map(|s| s.clone());
                // A paired machine cannot do the desktop's -32004 dance: that
                // respawns on the CALLER's daemon, resuming the chat on the
                // wrong machine. So for a peer, this host revives its own idle
                // chat (cwd/model/effort/account from its registry, never the
                // caller's) and delivers the message, as its REST send route does.
                // Only for a chat this registry knows: an unknown id must stay a
                // plain NotFound, not seed busy/chat-state entries for it.
                let respawn_for_peer = live.is_none()
                    && matches!(ctx.transport, Transport::PeerMachine(_))
                    && state.registry.get(&p.session_id).is_some();
                if live.is_none() && !respawn_for_peer {
                    return Err(err_to_rpc(LifecycleError::NotFound(p.session_id.clone())));
                }
                // Refusing beats writing into a live child (todo 873): the bump
                // below would strand the running turn's own result line on the
                // old gen, latching `busy` until the 20-minute watchdog. After
                // the map lookup, so a dead child still gets its -32004 respawn.
                if live.is_some() {
                    lifecycle::refuse_if_busy(&state, &p.session_id).map_err(err_to_rpc)?;
                }
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
                let sent = match &live {
                    Some(session) => lifecycle::send_message(session, &p.text, false).await,
                    None => lifecycle::send_message_with_respawn(&state, &p.session_id, &p.text, false).await,
                };
                if let Err(e) = sent {
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
                // Every subagent still running dies with the turn, and nothing
                // in the transcript says so - the tool results it was waiting
                // on just never arrive. Record them here, while the live set is
                // still the set that died; the next UserPromptSubmit names them
                // (`hooks_server::subagents`).
                state.record_subagents_killed_by_interrupt(&p.session_id);
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
                // Same reasoning one level down (todo 933): a `write_plan` step
                // comment is keyed by step TEXT alone, so one still unclaimed
                // when its turn dies would be delivered against whatever
                // unrelated step a LATER turn happens to give the same text.
                // `pump::exit` already clears them on EOF, but the interrupt is
                // cooperative and keeps the child alive, so stdout never closes
                // and that teardown never runs for a cancelled turn.
                state.clear_step_comments(&p.session_id).await;
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
mod interrupt_cleanup_contract {
    /// `cancel_turn` interrupts cooperatively and keeps the child process
    /// alive, so stdout never hits EOF and `pump::exit` - the only other
    /// caller of `clear_step_comments` - never runs for an interrupted turn.
    /// A comment queued against step text a LATER turn happens to reuse would
    /// then be delivered against that unrelated step. Nothing in the type
    /// system ties the two teardown sites together, so the handler body is
    /// asserted directly, the same shape as the notifier-event registration
    /// contract guard.
    #[test]
    fn cancel_turn_clears_queued_step_comments() {
        let src = include_str!("core.rs");
        let after_register = src
            .split_once("router.register(\"cancel_turn\"")
            .expect("cancel_turn handler is registered in this file")
            .1;
        let handler_body = after_register
            .split_once("router.register(")
            .map(|(body, _)| body)
            .unwrap_or(after_register);
        assert!(
            handler_body.contains("clear_step_comments"),
            "cancel_turn must clear queued step comments, beside its \
             expire_prompts_for_session call"
        );
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

    async fn start_session_as(state: &Arc<DaemonState>, transport: Transport, cwd: &str) -> crate::daemon::rpc::Response {
        let mut router = Router::new();
        register_core(&mut router, state.clone());
        let req = Request {
            jsonrpc: "2.0".into(),
            id: json!(1),
            method: "start_session".into(),
            params: Some(start_session_params(json!({"cwd": cwd}))),
        };
        // The ctx must be built INSIDE the scope: `ConnectionContext::new`
        // reads the task-local when it runs, not when the future is polled.
        crate::daemon::rpc::TRANSPORT
            .scope(transport, async { router.dispatch(req, dummy_ctx()).await })
            .await
    }

    #[tokio::test]
    async fn remote_start_session_is_limited_to_registered_projects() {
        let state = DaemonState::new(new_session_map(), SettingsCache::new(crate::types::Settings::default()));
        let project = "Z:\\does\\not\\exist";
        state.settings.upsert_project_for_cwd(std::path::Path::new(project), "2026-10-20T00:00:00Z");

        for transport in [Transport::Phone, Transport::PeerMachine("m".into())] {
            let refused = start_session_as(&state, transport.clone(), "C:\\").await;
            let err = refused.error.expect("unknown cwd must be refused remotely");
            assert_eq!(err.message, "unknown cwd", "{transport:?}");

            // Known project: passes the gate and fails later (cwd does not
            // exist on disk, so nothing is spawned).
            let known = start_session_as(&state, transport.clone(), project).await;
            assert_ne!(known.error.expect("cwd is absent on disk").message, "unknown cwd", "{transport:?}");
        }

        // Desktop is unchanged: no project gate.
        let local = start_session_as(&state, Transport::Local, "C:\\does\\not\\exist\\either").await;
        assert_ne!(local.error.expect("cwd absent").message, "unknown cwd");
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
    async fn start_session_with_a_different_machine_id_strips_the_machine_but_keeps_the_account() {
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
            // The id was picked from THIS peer's own account list, so it must
            // arrive untouched; a missing or rewritten id would start the chat
            // on the peer's default account instead of the one picked.
            let account = params.as_ref().and_then(|p| p.get("account_id")).and_then(Value::as_str);
            if account != Some("acct-on-b") {
                return Err::<Value, RE>(RE::invalid_params(format!("account {account:?} was not the picked one")));
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
                    params: Some(start_session_params(json!({"machine_id": "mach-b", "account_id": "acct-on-b"}))),
                },
                dummy_ctx(),
            )
            .await;
        assert!(resp.error.is_none(), "expected the peer's result, got {:?}", resp.error);
        assert_eq!(resp.result.unwrap()["session_id"], json!("peer-spawned-1"));
        assert_eq!(state.sessions.len(), 0, "must not have spawned anything locally");
        // The pending-owner map must resolve the forwarded id as "on
        // mach-b" immediately, before any instances_changed frame from the
        // peer could possibly have reported it.
        assert_eq!(state.mirror.owner_of("peer-spawned-1").as_deref(), Some("mach-b"));

        b_serve.kill();
    }

    /// The first chat started on a machine after both sat idle: the mirror
    /// still says offline (the link backs off after its socket dropped), but
    /// the peer answers, so the spawn is forwarded instead of refused.
    #[tokio::test]
    async fn start_session_on_an_offline_marked_but_reachable_machine_still_forwards() {
        use crate::daemon::rpc::RpcError as RE;

        let (dir, peer_dir) = (tempdir().unwrap(), tempdir().unwrap());
        let mut b_router = Router::new();
        b_router.register("start_session", |_params, _ctx| async move {
            Ok::<Value, RE>(json!({"session_id": "peer-spawned-2"}))
        });
        let b_state = DaemonState::new(new_session_map(), SettingsCache::new(crate::types::Settings::default()));
        let (_stt, b_port, b_serve) =
            crate::daemon::remote_server::spawn_on(b_state.clone(), peer_dir.path().to_path_buf(), b_router, 0);
        let state = state_paired_to_b(dir.path(), peer_dir.path(), b_port, vec![]);
        state.mirror.set_online("mach-b", false);

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
        assert!(resp.error.is_none(), "a reachable peer must not be refused as offline: {:?}", resp.error);
        assert_eq!(resp.result.unwrap()["session_id"], json!("peer-spawned-2"));
        assert!(state.mirror.is_online("mach-b"));
        b_serve.kill();
    }

    /// A host that refuses the picked account says so with ITS name on it, so
    /// the caller does not read "account X not found" as a local problem.
    #[tokio::test]
    async fn an_account_the_host_does_not_have_is_reported_with_the_hosts_name() {
        use crate::daemon::rpc::RpcError as RE;

        let (dir, peer_dir) = (tempdir().unwrap(), tempdir().unwrap());
        let mut b_router = Router::new();
        b_router.register("start_session", |_params, _ctx| async move {
            Err::<Value, RE>(RE::invalid_params("account stale-id not found in the registry"))
        });
        let b_state = DaemonState::new(new_session_map(), SettingsCache::new(crate::types::Settings::default()));
        let (_stt, b_port, b_serve) =
            crate::daemon::remote_server::spawn_on(b_state.clone(), peer_dir.path().to_path_buf(), b_router, 0);
        let state = state_paired_to_b(dir.path(), peer_dir.path(), b_port, vec![]);

        let mut router = Router::new();
        register_core(&mut router, state.clone());
        let resp = router
            .dispatch(
                Request {
                    jsonrpc: "2.0".into(),
                    id: json!(1),
                    method: "start_session".into(),
                    params: Some(start_session_params(json!({"machine_id": "mach-b", "account_id": "stale-id"}))),
                },
                dummy_ctx(),
            )
            .await;
        let err = resp.error.expect("the host refused the account");
        assert_eq!(err.message, "B: account stale-id not found in the registry");
        b_serve.kill();
    }

    /// A state paired to `mach-b` at `b_port`, online, with `mirrored` rows.
    fn state_paired_to_b(
        app_dir: &std::path::Path,
        b_data_dir: &std::path::Path,
        b_port: u16,
        mirrored: Vec<crate::types::Instance>,
    ) -> Arc<DaemonState> {
        let state = DaemonState::new(new_session_map(), SettingsCache::new(crate::types::Settings::default()));
        state.init_machines(app_dir.to_path_buf());
        state.machines.get().unwrap().ensure_self();
        let (token, _device_id) = DeviceRegistry::add_machine_device("A", "mach-a", b_data_dir).unwrap();
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
        state.mirror.set_instances("mach-b", "B", mirrored);
        state.mirror.set_online("mach-b", true);
        state
    }

    fn fresh_state() -> Arc<DaemonState> {
        DaemonState::new(new_session_map(), SettingsCache::new(crate::types::Settings::default()))
    }

    /// The reported bug: a chat hosted on the peer whose `claude` child exited
    /// used to come back as the peer's raw -32004, which the desktop read as
    /// "respawn locally". Now the HOST revives its own idle chat from its own
    /// registry. A real `claude` cannot be spawned in a unit test, so the host's
    /// registered folder is deliberately missing: reaching `CwdMissing` is only
    /// possible by getting past the NotFound branch into `spawn_session` with
    /// the HOST's recorded cwd (the caller never sends one).
    #[tokio::test]
    async fn forwarded_send_makes_the_host_respawn_its_own_idle_chat() {
        let dir = tempdir().unwrap();
        let peer_dir = tempdir().unwrap();
        let sid = uuid::Uuid::new_v4().to_string();

        let b_state = fresh_state();
        b_state.registry.upsert_interactive(
            &sid,
            std::path::Path::new("Z:\\host-only-folder"),
            "proj",
            "2026-10-23T00:00:00Z",
        );
        let row = b_state.registry.get(&sid).unwrap();
        let mut b_router = Router::new();
        register_core(&mut b_router, b_state.clone());
        let (_stt, b_port, b_serve) =
            crate::daemon::remote_server::spawn_on(b_state.clone(), peer_dir.path().to_path_buf(), b_router, 0);

        let state = state_paired_to_b(dir.path(), peer_dir.path(), b_port, vec![row]);
        let mut router = Router::new();
        crate::daemon::machines::forward::install(state.clone(), &mut router);
        let resp = router
            .dispatch(
                Request {
                    jsonrpc: "2.0".into(),
                    id: json!(1),
                    method: "send_message".into(),
                    params: Some(json!({"session_id": sid, "text": "hi"})),
                },
                dummy_ctx(),
            )
            .await;
        let err = resp.error.expect("the host cannot really spawn here");
        assert_eq!(err.code, -32602, "{err:?}");
        assert!(err.message.contains("cwd does not exist"), "{}", err.message);
        assert!(err.message.contains("host-only-folder"), "must be the HOST's recorded folder: {}", err.message);
        b_serve.kill();
    }

    async fn send_as(state: &Arc<DaemonState>, transport: Transport, sid: &str) -> crate::daemon::rpc::Response {
        let mut router = Router::new();
        register_core(&mut router, state.clone());
        crate::daemon::rpc::TRANSPORT
            .scope(transport, async {
                router
                    .dispatch(
                        Request {
                            jsonrpc: "2.0".into(),
                            id: json!(1),
                            method: "send_message".into(),
                            params: Some(json!({"session_id": sid, "text": "hi"})),
                        },
                        dummy_ctx(),
                    )
                    .await
            })
            .await
    }

    /// Control for the test above: only a PEER gets the host-side respawn. A
    /// local caller keeps today's -32004 so the desktop's own respawn-and-reattach
    /// dance (`ipc/chat/run.rs`) still runs for chats hosted here.
    #[tokio::test]
    async fn local_send_to_a_dead_child_still_answers_not_found() {
        let state = fresh_state();
        let sid = uuid::Uuid::new_v4().to_string();
        state.registry.upsert_interactive(&sid, std::path::Path::new("Z:\\gone"), "proj", "2026-10-23T00:00:00Z");
        let resp = send_as(&state, Transport::Local, &sid).await;
        assert_eq!(resp.error.expect("no live child").code, -32004);
    }

    /// A peer asking this host to message an id it never registered is a plain
    /// NotFound, not a respawn attempt (and seeds no busy/chat-state entry).
    #[tokio::test]
    async fn peer_send_for_an_unknown_id_is_not_found() {
        let state = fresh_state();
        let sid = uuid::Uuid::new_v4().to_string();
        let resp = send_as(&state, Transport::PeerMachine("mach-a".into()), &sid).await;
        assert_eq!(resp.error.expect("unknown id").code, -32004);
    }

    async fn start_resume(state: &Arc<DaemonState>, params: serde_json::Value) -> crate::daemon::rpc::Response {
        let mut router = Router::new();
        register_core(&mut router, state.clone());
        router
            .dispatch(
                Request { jsonrpc: "2.0".into(), id: json!(1), method: "start_session".into(), params: Some(params) },
                dummy_ctx(),
            )
            .await
    }

    fn row_for(sid: &str, cwd: &std::path::Path) -> crate::types::Instance {
        let s = fresh_state();
        s.registry.upsert_interactive(sid, cwd, "proj", "2026-10-23T00:00:00Z");
        s.registry.get(sid).unwrap()
    }

    /// A resume (or a fork) of a chat the peer hosts must never spawn here.
    /// The cwd EXISTS in this fixture, so without the guard the call gets past
    /// the folder check and fails somewhere else (accounts), not on ownership.
    #[tokio::test]
    async fn start_session_never_spawns_a_peer_hosted_chat_locally() {
        let dir = tempdir().unwrap();
        let peer_dir = tempdir().unwrap();
        let cwd = tempdir().unwrap();
        let sid = uuid::Uuid::new_v4().to_string();
        let state = state_paired_to_b(dir.path(), peer_dir.path(), 0, vec![row_for(&sid, cwd.path())]);

        let resume = start_resume(
            &state,
            start_session_params(json!({"cwd": cwd.path().to_string_lossy(), "resume_id": sid})),
        )
        .await;
        let err = resume.error.expect("a peer-hosted chat must be refused");
        assert_eq!(err.code, crate::daemon::machines::forward::ERR_NOT_FORWARDABLE);
        assert!(err.message.contains("hosted on B"), "{}", err.message);

        let fork = start_resume(
            &state,
            start_session_params(json!({
                "cwd": cwd.path().to_string_lossy(), "resume_id": sid, "fork": true,
                "new_session_id": uuid::Uuid::new_v4().to_string(),
            })),
        )
        .await;
        assert_eq!(
            fork.error.expect("fork of a peer chat refused").code,
            crate::daemon::machines::forward::ERR_NOT_FORWARDABLE
        );
        assert_eq!(state.sessions.len(), 0, "nothing may have been spawned locally");
    }

    /// The same refusal holds right after a restart, when the live mirror is
    /// empty and only the persisted ownership record knows the chat is the peer's.
    #[tokio::test]
    async fn start_session_refuses_a_chat_only_the_ownership_record_places_on_a_peer() {
        let dir = tempdir().unwrap();
        let peer_dir = tempdir().unwrap();
        let cwd = tempdir().unwrap();
        let sid = uuid::Uuid::new_v4().to_string();
        // First run: the peer is paired and reports the chat, which persists it.
        let first = state_paired_to_b(dir.path(), peer_dir.path(), 0, vec![row_for(&sid, cwd.path())]);
        drop(first);

        // A fresh daemon on the same data dir: peer still paired, mirror empty.
        let restarted = fresh_state();
        restarted.init_machines(dir.path().to_path_buf());
        assert!(restarted.mirror.owner_of(&sid).is_none(), "the live mirror is empty after a restart");
        let resp = start_resume(
            &restarted,
            start_session_params(json!({"cwd": cwd.path().to_string_lossy(), "resume_id": sid})),
        )
        .await;
        assert_eq!(resp.error.expect("refused").code, crate::daemon::machines::forward::ERR_NOT_FORWARDABLE);
        assert_eq!(restarted.sessions.len(), 0);
    }
}
