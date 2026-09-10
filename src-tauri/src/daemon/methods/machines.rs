//! Machine-identity RPCs: `list_machines` (desktop + read-only), and the
//! pairing/unpairing/labeling mutators, desktop-pipe-only (absent from
//! `remote_handlers::TRANSPORT_TABLE`) except `peer_unpaired` - the one
//! peer-callable exception (mask `M` there), the OTHER side of an unpair.
//! `list_machine_projects` is also desktop-pipe-only: it's the new-chat
//! picker's own cross-machine fetch, not a method a peer daemon would call.
//!
//! Split by concern into `machines/` submodules (todo 914): this file wires
//! `register_machines` and owns `list_machine_projects` (an RPC-registration
//! concern, not pairing); `machines/pairing.rs` holds the pairing lifecycle,
//! `machines/pairing_url.rs` the pure URL parsing it depends on.

mod pairing;
mod pairing_url;

use std::sync::Arc;

use serde::Deserialize;
use serde_json::{json, Value};

use crate::daemon::machines::forward::map_peer_err;
use crate::daemon::machines::{peer_client, PeerMachineView};
use crate::daemon::rpc::{Router, RpcError};
use crate::daemon::state::DaemonState;

pub fn register_machines(router: &mut Router, state: Arc<DaemonState>) {
    router.register("list_machines", {
        let state = state.clone();
        move |_params, _ctx| {
            let state = state.clone();
            async move {
                let mine = state.machines.get().and_then(|r| r.self_machine());
                let peers: Vec<PeerMachineView> = state
                    .machines
                    .get()
                    .map(|r| r.peers().iter().map(PeerMachineView::from).collect())
                    .unwrap_or_default();
                Ok(json!({ "self": mine, "peers": peers }))
            }
        }
    });

    router.register("pair_machine", {
        let state = state.clone();
        move |params, _ctx| {
            let state = state.clone();
            async move {
                let req: PairMachineParams = serde_json::from_value(params.unwrap_or(Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                pairing::pair_machine(&state, req).await
            }
        }
    });

    router.register("unpair_machine", {
        let state = state.clone();
        move |params, _ctx| {
            let state = state.clone();
            async move {
                let req: UnpairMachineParams = serde_json::from_value(params.unwrap_or(Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                pairing::unpair_machine(&state, &req.machine_id).await
            }
        }
    });

    router.register("set_machine_label", {
        let state = state.clone();
        move |params, _ctx| {
            let state = state.clone();
            async move {
                let req: SetLabelParams = serde_json::from_value(params.unwrap_or(Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                pairing::set_machine_label(&state, &req.label)
            }
        }
    });

    router.register("peer_unpaired", {
        let state = state.clone();
        move |_params, ctx| {
            let state = state.clone();
            async move { pairing::peer_unpaired(&state, &ctx).await }
        }
    });

    // New-chat picker's cross-machine project list (D3): `machine_id == self`
    // (or no registry yet) mirrors `list_projects`'s own body exactly; any
    // other known machine forwards the SAME "list_projects" RPC to it over
    // `/api/rpc` and returns its result verbatim - `list_projects` is PM in
    // `remote_handlers::TRANSPORT_TABLE` precisely so that peer accepts it.
    router.register("list_machine_projects", {
        let state = state.clone();
        move |params, _ctx| {
            let state = state.clone();
            async move {
                let req: MachineProjectsParams = serde_json::from_value(params.unwrap_or(Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                let self_id = state.machines.get().and_then(|r| r.self_machine()).map(|m| m.machine_id);
                if self_id.as_deref() == Some(req.machine_id.as_str()) {
                    return Ok(json!(state.settings.snapshot().projects));
                }
                let registry =
                    state.machines.get().ok_or_else(|| RpcError::invalid_params("machine registry not initialised"))?;
                let peer = registry
                    .peer(&req.machine_id)
                    .ok_or_else(|| RpcError::invalid_params(format!("unknown machine: {}", req.machine_id)))?;
                if !state.mirror.is_online(&req.machine_id) {
                    return Err(RpcError {
                        code: crate::daemon::machines::forward::ERR_MACHINE_OFFLINE,
                        message: format!("{} is offline", peer.label),
                        data: None,
                    });
                }
                let client = peer_client::client_for(&state, &peer).await.map_err(map_peer_err)?;
                client.call("list_projects", Value::Null).await.map_err(map_peer_err)
            }
        }
    });
}

#[derive(Debug, Deserialize)]
struct MachineProjectsParams {
    machine_id: String,
}

#[derive(Debug, Deserialize)]
struct PairMachineParams {
    url: String,
    #[serde(default)]
    my_url: Option<String>,
}

#[derive(Debug, Deserialize)]
struct UnpairMachineParams {
    machine_id: String,
}

#[derive(Debug, Deserialize)]
struct SetLabelParams {
    label: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::device_registry::DeviceRegistry;
    use crate::daemon::machines::PeerMachine;
    use crate::daemon::rpc::ConnectionContext;
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::types::Settings;
    use tempfile::tempdir;

    fn dummy_ctx() -> ConnectionContext {
        let (tx, _rx) = tokio::sync::mpsc::channel(16);
        ConnectionContext::new(tx)
    }

    fn state_with_machines(dir: &std::path::Path) -> Arc<DaemonState> {
        let state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        state.init_machines(dir.to_path_buf());
        state.machines.get().unwrap().ensure_self();
        state
    }

    // ── list_machine_projects ───────────────────────────────────────────────

    #[tokio::test]
    async fn list_machine_projects_self_returns_the_local_snapshot() {
        let dir = tempdir().unwrap();
        let mut settings = Settings::default();
        settings.projects.push(crate::types::ProjectConfig {
            id: "proj1".into(),
            path: std::path::PathBuf::from("C:/proj1"),
            name: "proj1".into(),
            avatar: Default::default(),
            automation: None,
            created_at: "2026-09-05T00:00:00Z".into(),
            last_active_at: None,
            whitelist: Default::default(),
            preferred_account_id: None,
            last_worktree_path: None,
            last_start_folder_rel: None,
        });
        let state = DaemonState::new(new_session_map(), SettingsCache::new(settings));
        state.init_machines(dir.path().to_path_buf());
        let mine = state.machines.get().unwrap().ensure_self();

        let mut r = Router::new();
        register_machines(&mut r, state);
        let resp = r
            .dispatch(
                crate::daemon::rpc::Request {
                    jsonrpc: "2.0".into(),
                    id: json!(1),
                    method: "list_machine_projects".into(),
                    params: Some(json!({"machine_id": mine.machine_id})),
                },
                dummy_ctx(),
            )
            .await;
        assert!(resp.error.is_none(), "got {:?}", resp.error);
        let arr = resp.result.unwrap();
        assert_eq!(arr.as_array().unwrap().len(), 1);
        assert_eq!(arr[0]["id"], json!("proj1"));
    }

    #[tokio::test]
    async fn list_machine_projects_forwards_to_the_named_peer_and_returns_it_verbatim() {
        let dir = tempdir().unwrap();
        let peer_dir = tempdir().unwrap();

        let mut b_router = Router::new();
        b_router.register("list_projects", |_params, _ctx| async move {
            Ok(json!([{"id": "peer-proj", "root": "C:/peer-proj"}]))
        });
        let b_state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        let (_stt, b_port, b_serve) =
            crate::daemon::remote_server::spawn_on(b_state.clone(), peer_dir.path().to_path_buf(), b_router, 0);

        let state = state_with_machines(dir.path());
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
        // creates it first, same as every other machine-registry fixture.
        state.mirror.set_instances("mach-b", "B", vec![]);
        state.mirror.set_online("mach-b", true);

        let mut r = Router::new();
        register_machines(&mut r, state);
        let resp = r
            .dispatch(
                crate::daemon::rpc::Request {
                    jsonrpc: "2.0".into(),
                    id: json!(1),
                    method: "list_machine_projects".into(),
                    params: Some(json!({"machine_id": "mach-b"})),
                },
                dummy_ctx(),
            )
            .await;
        assert!(resp.error.is_none(), "got {:?}", resp.error);
        assert_eq!(resp.result.unwrap(), json!([{"id": "peer-proj", "root": "C:/peer-proj"}]));

        b_serve.kill();
    }

    #[tokio::test]
    async fn list_machine_projects_unknown_machine_is_invalid_params() {
        let dir = tempdir().unwrap();
        let state = state_with_machines(dir.path());
        let mut r = Router::new();
        register_machines(&mut r, state);
        let resp = r
            .dispatch(
                crate::daemon::rpc::Request {
                    jsonrpc: "2.0".into(),
                    id: json!(1),
                    method: "list_machine_projects".into(),
                    params: Some(json!({"machine_id": "ghost"})),
                },
                dummy_ctx(),
            )
            .await;
        assert_eq!(resp.error.unwrap().code, -32602);
    }
}
