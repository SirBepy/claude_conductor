//! `start_session`'s machine routing and remote-project gate, driven through the router.

use super::core::register_core;
use super::start_session::bind_remote_resume_account;
use crate::daemon::device_registry::DeviceRegistry;
use crate::daemon::lifecycle::StartSessionParams;
use crate::daemon::machines::registry::PeerMachine;
use crate::daemon::rpc::{ConnectionContext, Request, Router, Transport};
use crate::daemon::session::new_session_map;
use crate::daemon::settings_cache::SettingsCache;
use crate::daemon::state::DaemonState;
use serde_json::{json, Value};
use std::sync::Arc;
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

#[test]
fn a_remote_resume_keeps_the_registry_account_and_a_local_one_keeps_its_own() {
    let state = DaemonState::new(new_session_map(), SettingsCache::new(crate::types::Settings::default()));
    state.registry.upsert_interactive("chat-1", std::path::Path::new("C:/x"), "proj", "2026-10-22T00:00:00Z");
    assert!(state.registry.set_account("chat-1", "acct-home"));
    let params = |resume: &str, account: Option<&str>| StartSessionParams {
        cwd: "C:/x".into(),
        model: "opus".into(),
        effort: "high".into(),
        resume_id: Some(resume.into()),
        account_id: account.map(str::to_string),
        fork: false,
        new_session_id: None,
    };

    let mut peer = params("chat-1", None);
    bind_remote_resume_account(&state, &Transport::PeerMachine("m".into()), &mut peer);
    assert_eq!(peer.account_id.as_deref(), Some("acct-home"));

    let mut phone = params("chat-1", Some("acct-other"));
    bind_remote_resume_account(&state, &Transport::Phone, &mut phone);
    assert_eq!(phone.account_id.as_deref(), Some("acct-home"));

    let mut local = params("chat-1", Some("acct-other"));
    bind_remote_resume_account(&state, &Transport::Local, &mut local);
    assert_eq!(local.account_id.as_deref(), Some("acct-other"));

    let mut unknown = params("chat-unknown", None);
    bind_remote_resume_account(&state, &Transport::PeerMachine("m".into()), &mut unknown);
    assert_eq!(unknown.account_id, None);

    state.registry.upsert_interactive("chat-unbound", std::path::Path::new("C:/x"), "proj", "2026-10-22T00:00:00Z");
    let mut unbound = params("chat-unbound", Some("acct-picked"));
    bind_remote_resume_account(&state, &Transport::Phone, &mut unbound);
    assert_eq!(unbound.account_id.as_deref(), Some("acct-picked"));
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
        icon: None,
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
        icon: None,
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

/// The cap gate on the desktop's send RPC: a chat on an out-of-credit
/// API-credit account answers API_CREDIT_BLOCKED (carrying the reason), not
/// the -32004 that would send the desktop into a respawn, and latches no busy.
#[tokio::test]
async fn send_on_a_blocked_api_credit_account_is_refused_with_its_reason() {
    let state = fresh_state();
    let sid = uuid::Uuid::new_v4().to_string();
    state.registry.upsert_interactive(&sid, std::path::Path::new("Z:\\gone"), "proj", "2026-10-26T00:00:00Z");
    state.registry.set_account(&sid, "api-1");
    crate::daemon::api_credit::store(&state, crate::accounts::ApiCreditStatus {
        account_id: "api-1".into(),
        blocked: true,
        block_reason: Some("Console spend limit $200 reached, resets 2026-11-01".into()),
        ..Default::default()
    });

    let err = send_as(&state, Transport::Local, &sid).await.error.expect("blocked");
    assert_eq!(err.code, crate::daemon::lifecycle::API_CREDIT_BLOCKED_CODE);
    assert!(err.message.starts_with("API_CREDIT_BLOCKED: Console spend limit $200 reached"), "{}", err.message);
    assert_eq!(err.data.unwrap()["block_reason"], "Console spend limit $200 reached, resets 2026-11-01");
    assert!(!state.registry.get(&sid).unwrap().busy, "a refused send must not latch busy");
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
