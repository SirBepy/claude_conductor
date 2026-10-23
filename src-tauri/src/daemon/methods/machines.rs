//! Machine-identity RPCs: `list_machines` and `list_machine_projects` back the
//! desktop AND phone new-chat machine pickers, so both are `P` in
//! `remote_transport_table::TRANSPORT_TABLE` - never `M`, since a peer
//! machine already knows its own federation state and must not learn about
//! this daemon's OTHER peers. The pairing/unpairing/labeling mutators stay
//! desktop-pipe-only (absent from the table) except `peer_unpaired` - the one
//! peer-callable exception (mask `M` there), the OTHER side of an unpair.
//!
//! Split by concern into `machines/` submodules (todo 914): this file wires
//! `register_machines` and owns `list_machine_projects` (an RPC-registration
//! concern, not pairing); `machines/pairing.rs` holds the pairing lifecycle,
//! `machines/pairing_url.rs` the pure URL parsing it depends on, and
//! `machines/accounts.rs` the cross-machine new-chat account picker.

mod accounts;
mod pairing;
mod pairing_url;

use std::sync::Arc;

use serde::Deserialize;
use serde_json::{json, Value};

use crate::daemon::machines::forward::map_peer_err;
use crate::daemon::machines::PeerMachineView;
use crate::daemon::rpc::{Router, RpcError};
use crate::daemon::state::DaemonState;

pub fn register_machines(router: &mut Router, state: Arc<DaemonState>) {
    // New-chat account picker for a chat started on another machine, and the
    // save of its pick as that machine's project binding.
    accounts::register(router, state.clone());

    router.register("list_machines", {
        let state = state.clone();
        move |_params, _ctx| {
            let state = state.clone();
            async move {
                let mine = state.machines.get().and_then(|r| r.self_machine());
                let peers: Vec<PeerMachineView> = state
                    .machines
                    .get()
                    .map(|r| r.peers().iter().map(|p| r.view(p)).collect())
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

    // Desktop-pipe only (absent from the transport table): the switch that
    // limits a paired machine is never flippable by that machine, or by the
    // phone.
    router.register("set_machine_can_drive", {
        let state = state.clone();
        move |params, _ctx| {
            let state = state.clone();
            async move {
                let req: SetCanDriveParams = serde_json::from_value(params.unwrap_or(Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                let registry =
                    state.machines.get().ok_or_else(|| RpcError::internal("machine registry not initialised"))?;
                if !registry.set_can_drive(&req.machine_id, req.value) {
                    return Err(RpcError::invalid_params(format!("unknown machine: {}", req.machine_id)));
                }
                Ok(json!({ "ok": true }))
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

    // New-chat picker's cross-machine project list (D3): `{groups, stats}`,
    // the same two pieces the local picker is built from (icons, worktrees,
    // last activity, todo counts). `machine_id == self` builds them from this
    // daemon's own state; any other known machine forwards `new_session_bundle`
    // to it over `/api/rpc`, where that method answers a `PeerMachine` caller
    // with just this slim shape (see `registry/new_session_bundle.rs`), so the
    // peer's settings and accounts never cross the wire. `new_session_bundle`
    // is PM in `remote_transport_table::TRANSPORT_TABLE` precisely so that peer
    // accepts it.
    router.register("list_machine_projects", {
        let state = state.clone();
        move |params, _ctx| {
            let state = state.clone();
            async move {
                let req: MachineProjectsParams = serde_json::from_value(params.unwrap_or(Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                let self_id = state.machines.get().and_then(|r| r.self_machine()).map(|m| m.machine_id);
                if self_id.as_deref() == Some(req.machine_id.as_str()) {
                    return super::registry::new_session_bundle::project_list(&state).await;
                }
                let client = crate::daemon::machines::forward::resolve_peer_client(&state, &req.machine_id).await?;
                let bundle = client.call("new_session_bundle", Value::Null).await.map_err(map_peer_err)?;
                // Re-picked rather than passed through: this response goes on to
                // the phone, and a peer that answered with more than the slim
                // shape must not leak the rest onward.
                Ok(json!({ "groups": bundle["groups"], "stats": bundle["stats"] }))
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

#[derive(Debug, Deserialize)]
struct SetCanDriveParams {
    machine_id: String,
    value: bool,
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
    async fn list_machine_projects_self_returns_the_local_groups_and_stats() {
        let dir = tempdir().unwrap();
        // Not under the OS temp dir: the group list drops temp-dir projects as ephemeral.
        let proj_dir = tempfile::Builder::new().prefix("lmp-self-").tempdir_in(env!("CARGO_MANIFEST_DIR")).unwrap();
        std::fs::create_dir_all(proj_dir.path().join(".claude/todos")).unwrap();
        std::fs::write(proj_dir.path().join(".claude/todos/01-a.md"), "a").unwrap();
        let proj_path = proj_dir.path().to_string_lossy().into_owned();
        let mut settings = Settings::default();
        settings.projects.push(crate::types::ProjectConfig {
            id: "proj1".into(),
            path: std::path::PathBuf::from(&proj_path),
            name: "proj1".into(),
            avatar: crate::types::Avatar::Image(std::path::PathBuf::from("C:/secret/avatar.png")),
            automation: None,
            created_at: "2026-09-05T00:00:00Z".into(),
            last_active_at: None,
            whitelist: Default::default(),
            preferred_account_id: None,
            last_worktree_path: None,
            last_start_folder_rel: None,
            claude_ai_connectors: false,
            tracker: None,
            keep_running_in_gaming_mode: false,
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
        let out = resp.result.unwrap();
        let group = out["groups"].as_array().unwrap().iter().find(|g| g["id"] == json!("proj1")).expect("proj1 group");
        assert_eq!(group["avatar"]["kind"], json!("none"), "an image avatar's disk path never leaves the daemon");
        assert_eq!(out["stats"][&proj_path]["todoCount"], json!(1));
        assert!(out.get("settings").is_none() && out.get("accounts").is_none());
    }

    #[tokio::test]
    async fn list_machine_projects_forwards_new_session_bundle_and_keeps_only_groups_and_stats() {
        let dir = tempdir().unwrap();
        let peer_dir = tempdir().unwrap();

        // A peer that answers with MORE than the slim shape (an older build, or
        // a bug) must not have the extra fields relayed on to the phone.
        let mut b_router = Router::new();
        b_router.register("new_session_bundle", |_params, _ctx| async move {
            Ok(json!({
                "groups": [{"id": "peer-proj", "path": "C:/peer-proj", "worktrees": [{"path": "C:/peer-proj-wt"}]}],
                "stats": {"C:/peer-proj": {"mtime": 5, "todoCount": 3}},
                "settings": {"apiKey": "dummy-secret"},
                "accounts": [{"id": "acct"}],
            }))
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
        assert_eq!(
            resp.result.unwrap(),
            json!({
                "groups": [{"id": "peer-proj", "path": "C:/peer-proj", "worktrees": [{"path": "C:/peer-proj-wt"}]}],
                "stats": {"C:/peer-proj": {"mtime": 5, "todoCount": 3}},
            })
        );

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
