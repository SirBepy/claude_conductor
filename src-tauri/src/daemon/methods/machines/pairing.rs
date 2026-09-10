//! Pairing lifecycle: pair/unpair/label a peer machine, plus the receiving
//! side of an unpair a peer initiates against us. Split out of
//! `methods/machines.rs` (todo 914); the RPC registration and param structs
//! stay in the parent module, which deserializes params before calling in
//! here.

use std::sync::Arc;

use serde_json::{json, Value};

use super::pairing_url::{decide_reach, ReachDecision};
use super::PairMachineParams;
use crate::daemon::device_registry::DeviceRegistry;
use crate::daemon::machines::{self, peer_client, PeerMachine, PeerMachineView};
use crate::daemon::rpc::{ConnectionContext, RpcError, Transport};
use crate::daemon::state::DaemonState;

pub(super) async fn pair_machine(state: &Arc<DaemonState>, req: PairMachineParams) -> Result<Value, RpcError> {
    let registry = state.machines.get().ok_or_else(|| RpcError::internal("machine registry not initialised"))?;
    let mine = registry.self_machine().unwrap_or_else(|| registry.ensure_self());
    let app_data = registry.app_data().to_path_buf();

    let parsed = super::pairing_url::parse_pairing_url(&req.url).map_err(RpcError::invalid_params)?;
    // The URL a `conductor://` (iroh-only) link resolves to today is a
    // loopback proxy port that only lives for this process - never persisted,
    // unlike `parsed.direct_url` below, which IS what gets stored (`None` for
    // a conductor:// link, so a future reach still goes through iroh).
    let reach = match decide_reach(&parsed) {
        ReachDecision::Direct(url) => url,
        ReachDecision::Iroh(iroh_id) => {
            let dialer = state.iroh_dialer().await.map_err(RpcError::internal)?;
            let port = dialer.proxy_port(&iroh_id).await.map_err(RpcError::internal)?;
            format!("http://127.0.0.1:{port}")
        }
        ReachDecision::Neither => {
            return Err(RpcError::invalid_params("pairing url has neither a host nor an iroh id"))
        }
    };

    let health = peer_client::PeerClient::new(&reach, "")
        .health()
        .await
        .map_err(|e| RpcError::internal(format!("could not reach that machine: {e}")))?;
    let their = health
        .get("machine")
        .filter(|m| !m.is_null())
        .ok_or_else(|| RpcError::internal("that Conductor is too old to pair machines"))?;
    let their_machine_id = their
        .get("machine_id")
        .and_then(Value::as_str)
        .ok_or_else(|| RpcError::internal("that Conductor is too old to pair machines"))?
        .to_string();
    let their_label = their.get("label").and_then(Value::as_str).unwrap_or("Unnamed machine").to_string();
    let their_os = their.get("os").and_then(Value::as_str).unwrap_or_default().to_string();

    let (reverse_token, minted_device_id) =
        DeviceRegistry::add_machine_device(&their_label, &their_machine_id, &app_data).map_err(RpcError::internal)?;

    let body = json!({
        "pairing_code": parsed.code,
        "device_name": mine.label,
        "peer": {
            "machine_id": mine.machine_id,
            "label": mine.label,
            "os": mine.os,
            "iroh_id": mine.machine_id,
            "direct_url": req.my_url,
            "reverse_token": reverse_token,
        }
    });

    let resp = match peer_client::post_pairing_request(&reach, body).await {
        Ok(v) => v,
        Err(e) => {
            let _ = DeviceRegistry::revoke_device(&minted_device_id, &app_data);
            return Err(RpcError::internal(format!("pairing failed: {e}")));
        }
    };
    let device_token = match resp.get("device_token").and_then(Value::as_str) {
        Some(t) => t.to_string(),
        None => {
            let _ = DeviceRegistry::revoke_device(&minted_device_id, &app_data);
            return Err(RpcError::internal("peer's pairing response was missing device_token"));
        }
    };
    let their_iroh_id = resp
        .get("peer")
        .and_then(|p| p.get("iroh_id"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| Some(their_machine_id.clone()));

    // Re-pair from the same machine_id: replace the old entry, revoking its
    // stale reverse token so it can't linger valid forever.
    if let Some(old) = registry.peer(&their_machine_id) {
        if let Some(old_device_id) = old.reverse_device_id {
            let _ = DeviceRegistry::revoke_device(&old_device_id, &app_data);
        }
    }

    let peer = PeerMachine {
        machine_id: their_machine_id,
        label: their_label,
        os: their_os,
        iroh_id: their_iroh_id,
        direct_url: parsed.direct_url,
        token: device_token,
        reverse_device_id: Some(minted_device_id),
        added_at: machines::now_secs(),
    };
    registry.upsert_peer(peer.clone());
    crate::daemon::machines::MachineHub::sync_links(state);
    serde_json::to_value(PeerMachineView::from(&peer)).map_err(|e| RpcError::internal(e.to_string()))
}

pub(super) async fn unpair_machine(state: &Arc<DaemonState>, machine_id: &str) -> Result<Value, RpcError> {
    let registry = state.machines.get().ok_or_else(|| RpcError::internal("machine registry not initialised"))?;
    let app_data = registry.app_data().to_path_buf();
    let mine = registry.self_machine().unwrap_or_else(|| registry.ensure_self());

    let Some(removed) = registry.remove_peer(machine_id) else {
        return Ok(json!({ "removed": false }));
    };
    if let Some(device_id) = &removed.reverse_device_id {
        let _ = DeviceRegistry::revoke_device(device_id, &app_data);
    }
    // Best-effort: tell the peer to drop its copy too. An unreachable or
    // already-unpaired peer is not this call's problem to report.
    if let Ok(client) = peer_client::client_for(state, &removed).await {
        let _ = client.call("peer_unpaired", json!({ "machine_id": mine.machine_id })).await;
    }
    crate::daemon::machines::MachineHub::sync_links(state);
    Ok(json!({ "removed": true }))
}

pub(super) fn set_machine_label(state: &Arc<DaemonState>, label: &str) -> Result<Value, RpcError> {
    let trimmed = label.trim();
    if trimmed.is_empty() || trimmed.chars().count() > 40 {
        return Err(RpcError::invalid_params("label must be 1..=40 characters"));
    }
    let registry = state.machines.get().ok_or_else(|| RpcError::internal("machine registry not initialised"))?;
    registry.set_label(trimmed);
    let mine = registry.self_machine().unwrap_or_else(|| registry.ensure_self());
    serde_json::to_value(mine).map_err(|e| RpcError::internal(e.to_string()))
}

/// Removes the CALLER's own entry (`ctx.transport`), never a params-supplied
/// id - a peer can only ever unpair itself this way. Unknown ids are a no-op,
/// not an error (the peer may have already unpaired locally).
pub(super) async fn peer_unpaired(state: &Arc<DaemonState>, ctx: &ConnectionContext) -> Result<Value, RpcError> {
    let Transport::PeerMachine(machine_id) = &ctx.transport else {
        return Err(RpcError::invalid_params("peer_unpaired is only callable by a peer machine"));
    };
    let Some(registry) = state.machines.get() else {
        return Ok(json!({ "removed": false }));
    };
    let app_data = registry.app_data().to_path_buf();
    match registry.remove_peer(machine_id) {
        Some(removed) => {
            if let Some(device_id) = removed.reverse_device_id {
                let _ = DeviceRegistry::revoke_device(&device_id, &app_data);
            }
            crate::daemon::machines::MachineHub::sync_links(state);
            Ok(json!({ "removed": true }))
        }
        None => Ok(json!({ "removed": false })),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::rpc::Router;
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

    #[tokio::test]
    async fn set_machine_label_updates_self_machine() {
        let dir = tempdir().unwrap();
        let mut r = Router::new();
        super::super::register_machines(&mut r, state_with_machines(dir.path()));
        let resp = r
            .dispatch(
                crate::daemon::rpc::Request {
                    jsonrpc: "2.0".into(),
                    id: json!(1),
                    method: "set_machine_label".into(),
                    params: Some(json!({"label": "  Joe's Desktop  "})),
                },
                dummy_ctx(),
            )
            .await;
        assert!(resp.error.is_none(), "got {:?}", resp.error);
        assert_eq!(resp.result.unwrap()["label"], json!("Joe's Desktop"));
    }

    #[tokio::test]
    async fn set_machine_label_rejects_empty_label() {
        let dir = tempdir().unwrap();
        let mut r = Router::new();
        super::super::register_machines(&mut r, state_with_machines(dir.path()));
        let resp = r
            .dispatch(
                crate::daemon::rpc::Request {
                    jsonrpc: "2.0".into(),
                    id: json!(1),
                    method: "set_machine_label".into(),
                    params: Some(json!({"label": "   "})),
                },
                dummy_ctx(),
            )
            .await;
        assert_eq!(resp.error.unwrap().code, -32602);
    }

    #[tokio::test]
    async fn unpair_unknown_machine_id_returns_removed_false() {
        let dir = tempdir().unwrap();
        let mut r = Router::new();
        super::super::register_machines(&mut r, state_with_machines(dir.path()));
        let resp = r
            .dispatch(
                crate::daemon::rpc::Request {
                    jsonrpc: "2.0".into(),
                    id: json!(1),
                    method: "unpair_machine".into(),
                    params: Some(json!({"machine_id": "ghost"})),
                },
                dummy_ctx(),
            )
            .await;
        assert!(resp.error.is_none(), "got {:?}", resp.error);
        assert_eq!(resp.result, Some(json!({"removed": false})));
    }

    #[tokio::test]
    async fn unpair_known_machine_revokes_its_reverse_device() {
        let dir = tempdir().unwrap();
        let state = state_with_machines(dir.path());
        let (token, device_id) = DeviceRegistry::add_machine_device("Mac Mini", "mach-1", dir.path()).unwrap();
        state.machines.get().unwrap().upsert_peer(PeerMachine {
            machine_id: "mach-1".into(),
            label: "Mac Mini".into(),
            os: "macos".into(),
            iroh_id: None,
            direct_url: None,
            token: "dummy-outbound".into(),
            reverse_device_id: Some(device_id),
            added_at: 0,
        });
        assert!(DeviceRegistry::validate_token(&token, dir.path()));

        let mut r = Router::new();
        super::super::register_machines(&mut r, state.clone());
        let resp = r
            .dispatch(
                crate::daemon::rpc::Request {
                    jsonrpc: "2.0".into(),
                    id: json!(1),
                    method: "unpair_machine".into(),
                    params: Some(json!({"machine_id": "mach-1"})),
                },
                dummy_ctx(),
            )
            .await;
        assert_eq!(resp.result, Some(json!({"removed": true})));
        assert!(!DeviceRegistry::validate_token(&token, dir.path()));
        assert!(state.machines.get().unwrap().peer("mach-1").is_none());
    }

    #[tokio::test]
    async fn peer_unpaired_removes_the_callers_own_entry_from_transport() {
        let dir = tempdir().unwrap();
        let state = state_with_machines(dir.path());
        let (_, device_id) = DeviceRegistry::add_machine_device("Their Machine", "mach-caller", dir.path()).unwrap();
        state.machines.get().unwrap().upsert_peer(PeerMachine {
            machine_id: "mach-caller".into(),
            label: "Their Machine".into(),
            os: "macos".into(),
            iroh_id: None,
            direct_url: None,
            token: "tok".into(),
            reverse_device_id: Some(device_id),
            added_at: 0,
        });

        let mut r = Router::new();
        super::super::register_machines(&mut r, state.clone());
        let (tx, _rx) = tokio::sync::mpsc::channel(16);
        let ctx = crate::daemon::rpc::TRANSPORT
            .scope(Transport::PeerMachine("mach-caller".into()), async {
                ConnectionContext::new(tx)
            })
            .await;
        let resp = r
            .dispatch(
                crate::daemon::rpc::Request {
                    jsonrpc: "2.0".into(),
                    id: json!(1),
                    // A malicious/buggy params id must be ignored - only
                    // ctx.transport's own id is ever removed.
                    method: "peer_unpaired".into(),
                    params: Some(json!({"machine_id": "someone-else"})),
                },
                ctx,
            )
            .await;
        assert_eq!(resp.result, Some(json!({"removed": true})));
        assert!(state.machines.get().unwrap().peer("mach-caller").is_none());
    }

    #[tokio::test]
    async fn peer_unpaired_refuses_non_machine_transport() {
        let dir = tempdir().unwrap();
        let state = state_with_machines(dir.path());
        let mut r = Router::new();
        super::super::register_machines(&mut r, state);
        let resp = r
            .dispatch(
                crate::daemon::rpc::Request {
                    jsonrpc: "2.0".into(),
                    id: json!(1),
                    method: "peer_unpaired".into(),
                    params: None,
                },
                dummy_ctx(),
            )
            .await;
        assert_eq!(resp.error.unwrap().code, -32602);
    }
}
