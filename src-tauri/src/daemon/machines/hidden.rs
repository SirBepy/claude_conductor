//! Hidden-chat state across paired machines. The machine that hosts a chat
//! owns its hidden flag: hiding a mirrored chat is forwarded to the host
//! (`methods::hidden_chats`), and each peer's own list is mirrored into
//! `MirrorState` by `peer_link` so every paired machine renders the chat
//! hidden. Hidden projects stay per machine: a cwd means a different
//! directory on each.

use std::sync::Arc;

use serde_json::{json, Value};

use super::peer_client;
use super::registry::PeerMachine;
use crate::daemon::state::DaemonState;
use crate::sessions::hidden_chats::{self, HiddenDelta, HiddenLists};

/// This daemon's own file. A registry-bearing daemon names its own app-data
/// dir, so a second in-process daemon (the federation tests) never shares the
/// process-global one; before the registry exists (early boot) the global
/// path applies.
pub(crate) fn local_lists(state: &DaemonState) -> HiddenLists {
    match state.machines.get() {
        Some(reg) => hidden_chats::list_in(reg.app_data()),
        None => hidden_chats::list(),
    }
}

pub(crate) fn update_local(state: &DaemonState, delta: &HiddenDelta) -> (HiddenLists, bool) {
    match state.machines.get() {
        Some(reg) => hidden_chats::update_in(reg.app_data(), delta),
        None => hidden_chats::update(delta),
    }
}

/// What every local client (desktop app, phone) sees: our own list plus the
/// ids each peer flags on chats that peer hosts. Peer ids for a chat we host
/// are ignored, so a peer can never hide one of our chats by naming it.
pub(crate) fn merged_lists(state: &DaemonState) -> HiddenLists {
    let mut lists = local_lists(state);
    for id in state.mirror.hidden_sessions() {
        if !lists.sessions.contains(&id) && !super::is_local_session(state, &id) {
            lists.sessions.push(id);
        }
    }
    lists
}

pub(crate) fn view(lists: &HiddenLists) -> Value {
    json!({"sessions": lists.sessions, "projects": lists.projects})
}

/// Tells local clients the merged list moved, when the peer-reported part
/// differs from `before`. Comparing the ownership-filtered result (not the
/// raw peer cache) is what ends the echo between two daemons that mirror each
/// other: the second hop changes nothing, so nothing is published.
pub(crate) fn publish_if_changed(state: &DaemonState, before: &[String]) {
    if state.mirror.hidden_sessions() != before {
        state.notifier.publish("hidden_chats_changed", view(&merged_lists(state)));
    }
}

/// Applies a peer's `hidden_chats_changed` frame to the mirror; any other
/// frame is ignored. Callers compare `MirrorState::hidden_sessions` before and
/// after to learn whether anything moved.
pub(super) fn apply_peer_frame(state: &DaemonState, machine_id: &str, txt: &str) {
    let Ok(frame) = serde_json::from_str::<Value>(txt) else { return };
    if frame.get("method").and_then(Value::as_str) != Some("hidden_chats_changed") {
        return;
    }
    if let Some(ids) = session_ids(frame.pointer("/params/sessions")) {
        state.mirror.set_hidden_sessions(machine_id, ids);
    }
}

fn session_ids(v: Option<&Value>) -> Option<Vec<String>> {
    Some(v?.as_array()?.iter().filter_map(|s| s.as_str().map(str::to_string)).collect())
}

/// The peer's list as of a (re)connect, since its socket only carries changes.
/// A failure keeps the last-known cache and leaves the next change frame to
/// catch up.
pub(super) async fn fetch_peer(state: &Arc<DaemonState>, peer: &PeerMachine) {
    let client = match peer_client::client_for(state, peer).await {
        Ok(c) => c,
        Err(e) => {
            log::debug!("peer_link: hidden chats fetch for {} unreachable: {e}", peer.machine_id);
            return;
        }
    };
    match client.call("get_hidden_chats", Value::Null).await {
        Ok(v) => {
            if let Some(ids) = session_ids(v.get("sessions")) {
                let before = state.mirror.hidden_sessions();
                state.mirror.set_hidden_sessions(&peer.machine_id, ids);
                publish_if_changed(state, &before);
            }
        }
        Err(e) => log::debug!("peer_link: get_hidden_chats for {} failed: {e}", peer.machine_id),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::device_registry::DeviceRegistry;
    use crate::daemon::machines::MachineHub;
    use crate::daemon::rpc::{ConnectionContext, Request, Router, TRANSPORT};
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::sessions::kinds::InstanceKind;
    use crate::sessions::registry::RegisterInput;
    use crate::types::Settings;
    use std::time::Duration;
    use tempfile::tempdir;

    fn router_for(state: &Arc<DaemonState>) -> Router {
        let mut router = Router::new();
        crate::daemon::methods::register_hidden_chats(&mut router, state.clone());
        router
    }

    async fn call(router: &Router, method: &str, params: Value) -> Value {
        let (tx, _rx) = tokio::sync::mpsc::channel(16);
        let req = Request { jsonrpc: "2.0".into(), id: json!(1), method: method.into(), params: Some(params) };
        let resp = router.dispatch(req, ConnectionContext::new(tx)).await;
        resp.result.unwrap_or_else(|| panic!("{method} failed: {:?}", resp.error))
    }

    fn register_chat(state: &DaemonState, id: &str) {
        let settings = std::sync::Mutex::new(Settings::default());
        state.registry.register(
            RegisterInput {
                session_id: id.into(),
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
    }

    fn sessions_of(v: &Value) -> Vec<String> {
        v["sessions"].as_array().unwrap().iter().map(|s| s.as_str().unwrap().to_string()).collect()
    }

    async fn wait_until(what: &str, mut ok: impl FnMut() -> bool) {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        while !ok() {
            assert!(tokio::time::Instant::now() < deadline, "timed out waiting for: {what}");
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    /// Two real daemons over loopback, A mirroring B. Hiding B's chat from A
    /// lands in B's file (the host owns the flag) and never in A's; a hide made
    /// on B shows on A; unhiding from A clears B's file. No `claude` spawns and
    /// neither fixed port is bound.
    #[tokio::test]
    async fn the_host_owns_the_hidden_flag_and_the_other_machine_mirrors_it() {
        let a_dir = tempdir().unwrap();
        let b_dir = tempdir().unwrap();
        let a_state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        let b_state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        register_chat(&b_state, "b-chat-1");
        register_chat(&b_state, "b-chat-2");

        let (_b_stt, b_port, b_serve) = crate::daemon::remote_server::spawn_on(
            b_state.clone(), b_dir.path().to_path_buf(), router_for(&b_state), 0,
        );
        let (_a_stt, _a_port, a_serve) = crate::daemon::remote_server::spawn_on(
            a_state.clone(), a_dir.path().to_path_buf(), Router::new(), 0,
        );
        let a_router = router_for(&a_state);
        let b_router = router_for(&b_state);
        let a_id = a_state.machines.get().unwrap().self_machine().unwrap().machine_id;
        let b_id = b_state.machines.get().unwrap().self_machine().unwrap().machine_id;
        let (token, _) = DeviceRegistry::add_machine_device("A", &a_id, b_dir.path()).unwrap();
        a_state.machines.get().unwrap().upsert_peer(PeerMachine {
            machine_id: b_id,
            label: "B".into(),
            os: "test".into(),
            iroh_id: None,
            direct_url: Some(format!("http://127.0.0.1:{b_port}")),
            token,
            reverse_device_id: None,
            added_at: 0,
            icon: None,
        });
        MachineHub::sync_links(&a_state);
        wait_until("B's chats in A's mirror", || a_state.mirror.instances().len() == 2).await;

        // Hide on A: forwarded to the host.
        call(&a_router, "update_hidden_chats", json!({"add": ["b-chat-1"]})).await;
        assert_eq!(hidden_chats::list_in(b_dir.path()).sessions, vec!["b-chat-1".to_string()]);
        assert!(hidden_chats::list_in(a_dir.path()).sessions.is_empty(), "the viewer never stores a flag it does not own");
        let seen = call(&a_router, "get_hidden_chats", Value::Null).await;
        assert_eq!(sessions_of(&seen), vec!["b-chat-1".to_string()]);

        // Hide on B directly: reaches A through the link, no call from A.
        call(&b_router, "update_hidden_chats", json!({"add": ["b-chat-2"]})).await;
        wait_until("A to learn B's own hide", || {
            a_state.mirror.hidden_sessions().contains(&"b-chat-2".to_string())
        })
        .await;
        let seen = sessions_of(&call(&a_router, "get_hidden_chats", Value::Null).await);
        assert!(seen.contains(&"b-chat-1".to_string()) && seen.contains(&"b-chat-2".to_string()), "got {seen:?}");

        // Unhide on A clears the host's flag.
        call(&a_router, "update_hidden_chats", json!({"remove": ["b-chat-1", "b-chat-2"]})).await;
        assert!(hidden_chats::list_in(b_dir.path()).sessions.is_empty());
        assert!(sessions_of(&call(&a_router, "get_hidden_chats", Value::Null).await).is_empty());

        b_serve.kill();
        a_serve.kill();
    }

    /// A delta naming chats on two hosts where the second is offline applies
    /// on neither: the live host's file stays empty and the call errors.
    #[tokio::test]
    async fn a_delta_with_an_offline_owner_applies_nowhere() {
        let a_dir = tempdir().unwrap();
        let b_dir = tempdir().unwrap();
        let a_state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        let b_state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        register_chat(&b_state, "b-chat-1");

        let (_b_stt, b_port, b_serve) = crate::daemon::remote_server::spawn_on(
            b_state.clone(), b_dir.path().to_path_buf(), router_for(&b_state), 0,
        );
        let (_a_stt, _a_port, a_serve) = crate::daemon::remote_server::spawn_on(
            a_state.clone(), a_dir.path().to_path_buf(), Router::new(), 0,
        );
        let a_router = router_for(&a_state);
        let a_id = a_state.machines.get().unwrap().self_machine().unwrap().machine_id;
        let b_id = b_state.machines.get().unwrap().self_machine().unwrap().machine_id;
        let (token, _) = DeviceRegistry::add_machine_device("A", &a_id, b_dir.path()).unwrap();
        a_state.machines.get().unwrap().upsert_peer(PeerMachine {
            machine_id: b_id,
            label: "B".into(),
            os: "test".into(),
            iroh_id: None,
            direct_url: Some(format!("http://127.0.0.1:{b_port}")),
            token,
            reverse_device_id: None,
            added_at: 0,
            icon: None,
        });
        // Sorts after B's id, so a first-failure loop would already have forwarded to B.
        let offline_id = "mach-zzz-offline";
        a_state.machines.get().unwrap().upsert_peer(PeerMachine {
            machine_id: offline_id.into(),
            label: "C".into(),
            os: "test".into(),
            iroh_id: None,
            direct_url: Some("http://127.0.0.1:1".into()),
            token: "dummy-unused".into(),
            reverse_device_id: None,
            added_at: 0,
            icon: None,
        });
        MachineHub::sync_links(&a_state);
        wait_until("B's chat in A's mirror", || a_state.mirror.instances().len() == 1).await;
        let mut c_row = a_state.mirror.instances()[0].clone();
        c_row.session_id = "c-chat".into();
        c_row.machine = None;
        a_state.mirror.set_instances(offline_id, "C", vec![c_row]);
        a_state.mirror.set_online(offline_id, false);

        let (tx, _rx) = tokio::sync::mpsc::channel(16);
        let req = Request {
            jsonrpc: "2.0".into(),
            id: json!(1),
            method: "update_hidden_chats".into(),
            params: Some(json!({"add": ["b-chat-1", "c-chat"]})),
        };
        let resp = a_router.dispatch(req, ConnectionContext::new(tx)).await;
        assert!(resp.error.is_some(), "an offline owner must fail the delta");
        assert!(hidden_chats::list_in(b_dir.path()).sessions.is_empty(), "the live host must not be half-applied");

        b_serve.kill();
        a_serve.kill();
    }

    #[tokio::test]
    async fn a_peer_can_only_hide_chats_this_daemon_hosts() {
        let dir = tempdir().unwrap();
        let state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        state.init_machines(dir.path().to_path_buf());
        register_chat(&state, "ours");
        let router = router_for(&state);

        let (tx, _rx) = tokio::sync::mpsc::channel(16);
        let req = Request {
            jsonrpc: "2.0".into(),
            id: json!(1),
            method: "update_hidden_chats".into(),
            params: Some(json!({"add": ["ours", "somebody-elses"], "add_projects": ["C:/their/path"]})),
        };
        let resp = TRANSPORT
            .scope(crate::daemon::rpc::Transport::PeerMachine("peer".into()), async {
                router.dispatch(req, ConnectionContext::new(tx)).await
            })
            .await;
        assert!(resp.error.is_none(), "{:?}", resp.error);
        let lists = hidden_chats::list_in(dir.path());
        assert_eq!(lists.sessions, vec!["ours".to_string()], "an id this daemon does not host is ignored");
        assert!(lists.projects.is_empty(), "a peer's project cwd is meaningless here");
    }
}
