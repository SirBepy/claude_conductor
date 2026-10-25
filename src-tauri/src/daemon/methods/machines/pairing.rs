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
use crate::daemon::machines::{self, peer_client, PeerMachine};
use crate::daemon::rpc::{ConnectionContext, RpcError, Transport};
use crate::daemon::state::DaemonState;

pub(super) async fn pair_machine(state: &Arc<DaemonState>, req: PairMachineParams) -> Result<Value, RpcError> {
    let registry = state.machines.get().ok_or_else(|| RpcError::internal("machine registry not initialised"))?;
    let mine = registry.self_machine().unwrap_or_else(|| registry.ensure_self());
    let app_data = registry.app_data().to_path_buf();
    // One paste pairs both directions, so the other machine will dial back
    // here at once; with this side switched off every one of those calls
    // would 503 and the pairing would look broken from the far end.
    if !DeviceRegistry::is_enabled(&app_data) {
        return Err(RpcError::invalid_params(
            "remote access is off on this machine - turn it on in Settings > Remote access first, so the other machine can reach back",
        ));
    }

    let parsed = super::pairing_url::parse_pairing_url(&req.url).map_err(RpcError::invalid_params)?;
    // The URL a `conductor://` (iroh-only) link resolves to today is a
    // loopback proxy port that only lives for this process - never persisted,
    // unlike `parsed.direct_url` below, which IS what gets stored (`None` for
    // a conductor:// link, so a future reach still goes through iroh).
    let reach = match decide_reach(&parsed) {
        ReachDecision::Direct(url) => url,
        ReachDecision::Iroh(iroh_id) => {
            let dialer = state.iroh_dialer().await.map_err(RpcError::internal)?;
            // Dialed up front so a cold iroh dial (up to DIAL_TIMEOUT) is not
            // charged to the health call's 10s request timeout below.
            let port = dialer
                .connected_proxy_port(&iroh_id)
                .await
                .map_err(|e| RpcError::internal(format!("could not reach that machine: {e}")))?;
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
    let their_icon = their
        .get("icon")
        .and_then(Value::as_str)
        .and_then(|i| machines::registry::normalize_icon(Some(i)).ok().flatten());

    let device_name = registry.display_label(&their_machine_id, &their_label);
    let (reverse_token, minted_device_id) =
        DeviceRegistry::add_machine_device(&device_name, &their_machine_id, &app_data).map_err(RpcError::internal)?;

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
        icon: their_icon,
    };
    registry.upsert_peer(peer.clone());
    crate::daemon::machines::MachineHub::sync_links(state);
    serde_json::to_value(registry.view(&peer)).map_err(|e| RpcError::internal(e.to_string()))
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
    let trimmed = crate::daemon::device_registry::normalize_label(label)
        .map_err(|e| RpcError::invalid_params(format!("label {e}")))?;
    let registry = state.machines.get().ok_or_else(|| RpcError::internal("machine registry not initialised"))?;
    registry.set_label(trimmed);
    let mine = registry.self_machine().unwrap_or_else(|| registry.ensure_self());
    serde_json::to_value(mine).map_err(|e| RpcError::internal(e.to_string()))
}

/// Owner-set name for a paired peer, on this machine only. Also renames the
/// peer's reverse entry in the device registry, so the Paired devices list
/// and the chat list call it the same thing, and restamps its mirrored rows
/// at once instead of waiting for the peer's next snapshot.
pub(super) fn rename_machine(state: &Arc<DaemonState>, machine_id: &str, label: &str) -> Result<Value, RpcError> {
    let trimmed = crate::daemon::device_registry::normalize_label(label)
        .map_err(|e| RpcError::invalid_params(format!("label {e}")))?;
    let registry = state.machines.get().ok_or_else(|| RpcError::internal("machine registry not initialised"))?;
    if !registry.rename_peer(machine_id, trimmed) {
        return Err(RpcError::invalid_params(format!("unknown machine: {machine_id}")));
    }
    if let Some(device_id) = registry.peer(machine_id).and_then(|p| p.reverse_device_id) {
        let _ = DeviceRegistry::rename_device(&device_id, trimmed, registry.app_data());
    }
    if state.mirror.set_label(machine_id, trimmed) {
        crate::daemon::machines::publish_instances_changed(state);
    }
    state.notifier.publish("machines_changed", json!({}));
    Ok(json!({ "ok": true }))
}

/// Edits one machine's profile (name and icon) from any device. With no
/// `machine_id` (or this daemon's own id) it edits THIS machine and tells every
/// online peer. For a paired peer it forwards the edit to that peer, which owns
/// its profile, and updates the local cache on success.
///
/// A call arriving over `Transport::PeerMachine` is always about this daemon:
/// the forwarder strips `machine_id`, and a peer that names any other machine
/// is refused, so a paired machine can never rename a third one through us.
pub(super) async fn set_machine_profile(
    state: &Arc<DaemonState>,
    ctx: &ConnectionContext,
    req: super::SetMachineProfileParams,
) -> Result<Value, RpcError> {
    let registry = state.machines.get().ok_or_else(|| RpcError::internal("machine registry not initialised"))?;
    let mine = registry.self_machine().unwrap_or_else(|| registry.ensure_self());
    let label = match req.label.as_deref() {
        Some(raw) => Some(
            crate::daemon::device_registry::normalize_label(raw)
                .map_err(|e| RpcError::invalid_params(format!("label {e}")))?,
        ),
        None => None,
    };
    let icon = match &req.icon {
        Some(raw) => Some(machines::registry::normalize_icon(raw.as_deref()).map_err(RpcError::invalid_params)?),
        None => None,
    };
    if label.is_none() && icon.is_none() {
        return Err(RpcError::invalid_params("set_machine_profile needs a label or an icon"));
    }
    let target_is_self = match req.machine_id.as_deref() {
        None => true,
        Some(id) => id == mine.machine_id,
    };
    if !target_is_self && matches!(ctx.transport, Transport::PeerMachine(_)) {
        return Err(RpcError::invalid_params("a peer machine can only edit its own profile"));
    }

    if target_is_self {
        if let Some(l) = label {
            registry.set_label(l);
        }
        if let Some(i) = &icon {
            registry.set_icon(i.clone());
        }
        state.notifier.publish("machines_changed", json!({}));
        let now = registry.self_machine().unwrap_or(mine);
        push_profile_to_peers(state, now.label, now.icon);
        return Ok(json!({ "ok": true }));
    }

    let machine_id = req.machine_id.as_deref().unwrap_or_default();
    let client = machines::forward::resolve_peer_client(state, machine_id).await?;
    let mut params = serde_json::Map::new();
    if let Some(l) = label {
        params.insert("label".into(), json!(l));
    }
    if let Some(i) = &icon {
        params.insert("icon".into(), json!(i));
    }
    client
        .call("set_machine_profile", Value::Object(params))
        .await
        .map_err(machines::forward::map_peer_err)?;
    if let Some(peer) = registry.peer(machine_id) {
        let new_icon = icon.unwrap_or(peer.icon.clone());
        machines::apply_peer_profile(state, machine_id, label.unwrap_or(&peer.label), new_icon.as_deref());
    }
    Ok(json!({ "ok": true }))
}

/// Best-effort, spawned: an offline or old peer just catches up from its
/// health pull when its link next connects.
fn push_profile_to_peers(state: &Arc<DaemonState>, label: String, icon: Option<String>) {
    let Some(registry) = state.machines.get() else { return };
    for peer in registry.peers() {
        if !state.mirror.is_online(&peer.machine_id) {
            continue;
        }
        let state = state.clone();
        let (label, icon) = (label.clone(), icon.clone());
        tokio::spawn(async move {
            if let Ok(client) = peer_client::client_for(&state, &peer).await {
                let _ = client.call("peer_profile_changed", json!({ "label": label, "icon": icon })).await;
            }
        });
    }
}

/// A peer telling us its new name and icon. The sender is `ctx.transport`'s
/// machine, never a params id. Never pushes anything onward: the peer already
/// knows, and a push back would ping-pong between the two daemons.
pub(super) fn peer_profile_changed(
    state: &Arc<DaemonState>,
    ctx: &ConnectionContext,
    req: super::PeerProfileChangedParams,
) -> Result<Value, RpcError> {
    let Transport::PeerMachine(machine_id) = &ctx.transport else {
        return Err(RpcError::invalid_params("peer_profile_changed is only callable by a peer machine"));
    };
    let label = crate::daemon::device_registry::normalize_label(&req.label)
        .map_err(|e| RpcError::invalid_params(format!("label {e}")))?;
    let icon = machines::registry::normalize_icon(req.icon.as_deref()).map_err(RpcError::invalid_params)?;
    machines::apply_peer_profile(state, machine_id, label, icon.as_deref());
    Ok(json!({ "ok": true }))
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
    async fn rename_machine_names_the_peer_and_its_device_entry() {
        let dir = tempdir().unwrap();
        let state = state_with_machines(dir.path());
        let device_id = DeviceRegistry::add_machine_device("DESKTOP-ABC", "mach-b", dir.path()).unwrap().1;
        state.machines.get().unwrap().upsert_peer(PeerMachine {
            machine_id: "mach-b".into(),
            label: "DESKTOP-ABC".into(),
            os: "windows".into(),
            iroh_id: None,
            direct_url: None,
            token: "dummy-tok".into(),
            reverse_device_id: Some(device_id.clone()),
            added_at: 0,
            icon: None,
        });
        let mut r = Router::new();
        super::super::register_machines(&mut r, state.clone());
        let resp = r
            .dispatch(
                crate::daemon::rpc::Request {
                    jsonrpc: "2.0".into(),
                    id: json!(1),
                    method: "rename_machine".into(),
                    params: Some(json!({"machine_id": "mach-b", "label": " Office PC "})),
                },
                dummy_ctx(),
            )
            .await;
        assert!(resp.error.is_none(), "got {:?}", resp.error);
        assert_eq!(state.machines.get().unwrap().peer("mach-b").unwrap().label, "Office PC");
        let device = DeviceRegistry::list_devices(dir.path()).into_iter().find(|d| d.id == device_id).unwrap();
        assert_eq!(device.name, "Office PC");
    }

    #[tokio::test]
    async fn rename_machine_rejects_an_unknown_peer() {
        let dir = tempdir().unwrap();
        let mut r = Router::new();
        super::super::register_machines(&mut r, state_with_machines(dir.path()));
        let resp = r
            .dispatch(
                crate::daemon::rpc::Request {
                    jsonrpc: "2.0".into(),
                    id: json!(1),
                    method: "rename_machine".into(),
                    params: Some(json!({"machine_id": "nope", "label": "X"})),
                },
                dummy_ctx(),
            )
            .await;
        assert_eq!(resp.error.unwrap().code, -32602);
    }

    #[tokio::test]
    async fn pair_machine_refuses_while_remote_access_is_off() {
        let dir = tempdir().unwrap();
        let mut r = Router::new();
        super::super::register_machines(&mut r, state_with_machines(dir.path()));
        let resp = r
            .dispatch(
                crate::daemon::rpc::Request {
                    jsonrpc: "2.0".into(),
                    id: json!(1),
                    method: "pair_machine".into(),
                    params: Some(json!({"url": "conductor://pair?iroh=deadbeef&pair=abc"})),
                },
                dummy_ctx(),
            )
            .await;
        let err = resp.error.expect("pairing must be refused while switched off");
        assert!(err.message.contains("remote access is off"), "got {}", err.message);
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
        DeviceRegistry::set_enabled(true, dir.path()).unwrap();
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
            icon: None,
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
            icon: None,
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

    async fn dispatch_profile(
        state: &Arc<DaemonState>,
        method: &str,
        params: Value,
        transport: Option<Transport>,
    ) -> crate::daemon::rpc::Response {
        let mut r = Router::new();
        super::super::register_machines(&mut r, state.clone());
        let (tx, _rx) = tokio::sync::mpsc::channel(16);
        let ctx = match transport {
            Some(t) => crate::daemon::rpc::TRANSPORT.scope(t, async { ConnectionContext::new(tx) }).await,
            None => ConnectionContext::new(tx),
        };
        r.dispatch(
            crate::daemon::rpc::Request { jsonrpc: "2.0".into(), id: json!(1), method: method.into(), params: Some(params) },
            ctx,
        )
        .await
    }

    fn add_peer(state: &Arc<DaemonState>, id: &str, label: &str) {
        state.machines.get().unwrap().upsert_peer(PeerMachine {
            machine_id: id.into(),
            label: label.into(),
            os: "test".into(),
            iroh_id: None,
            direct_url: None,
            token: "tok".into(),
            reverse_device_id: None,
            added_at: 0,
            icon: None,
        });
    }

    #[tokio::test]
    async fn set_machine_profile_edits_this_machine_by_default_and_by_own_id() {
        let dir = tempdir().unwrap();
        let state = state_with_machines(dir.path());
        let own = state.machines.get().unwrap().self_machine().unwrap().machine_id;
        let resp = dispatch_profile(&state, "set_machine_profile", json!({"label": " Desk ", "icon": "ph-desktop"}), None).await;
        assert!(resp.error.is_none(), "got {:?}", resp.error);
        let me = state.machines.get().unwrap().self_machine().unwrap();
        assert_eq!((me.label.as_str(), me.icon.as_deref()), ("Desk", Some("ph-desktop")));

        // Label only leaves the icon alone; icon null clears it; own id is the same target.
        dispatch_profile(&state, "set_machine_profile", json!({"machine_id": own, "label": "Desk 2"}), None).await;
        assert_eq!(state.machines.get().unwrap().self_machine().unwrap().icon.as_deref(), Some("ph-desktop"));
        dispatch_profile(&state, "set_machine_profile", json!({"icon": null}), None).await;
        let me = state.machines.get().unwrap().self_machine().unwrap();
        assert_eq!((me.label.as_str(), me.icon), ("Desk 2", None));
    }

    #[tokio::test]
    async fn set_machine_profile_rejects_bad_icon_bad_label_and_empty_edit() {
        let dir = tempdir().unwrap();
        let state = state_with_machines(dir.path());
        let before = state.machines.get().unwrap().self_machine().unwrap();
        for params in [
            json!({"icon": "desktop"}),
            json!({"icon": "ph-<script>"}),
            json!({"label": "   "}),
            json!({"label": "x".repeat(41)}),
            json!({}),
        ] {
            let resp = dispatch_profile(&state, "set_machine_profile", params.clone(), None).await;
            assert_eq!(resp.error.map(|e| e.code), Some(-32602), "{params} must be refused");
        }
        assert_eq!(state.machines.get().unwrap().self_machine().unwrap(), before);
    }

    #[tokio::test]
    async fn set_machine_profile_for_an_unknown_peer_errors() {
        let dir = tempdir().unwrap();
        let state = state_with_machines(dir.path());
        let resp = dispatch_profile(&state, "set_machine_profile", json!({"machine_id": "ghost", "label": "X"}), None).await;
        let err = resp.error.expect("unknown machine");
        assert_eq!(err.code, -32602);
        assert!(err.message.contains("ghost"), "{}", err.message);
    }

    #[tokio::test]
    async fn set_machine_profile_from_a_peer_refuses_any_other_machine() {
        let dir = tempdir().unwrap();
        let state = state_with_machines(dir.path());
        add_peer(&state, "mach-b", "B");
        add_peer(&state, "mach-c", "C");
        let from_b = Some(Transport::PeerMachine("mach-b".into()));
        let resp = dispatch_profile(&state, "set_machine_profile", json!({"machine_id": "mach-c", "label": "Hacked"}), from_b.clone()).await;
        assert_eq!(resp.error.map(|e| e.code), Some(-32602));
        assert_eq!(state.machines.get().unwrap().peer("mach-c").unwrap().label, "C");

        // Without a machine_id (what the forwarder sends) it edits this daemon.
        let resp = dispatch_profile(&state, "set_machine_profile", json!({"label": "Renamed by B"}), from_b).await;
        assert!(resp.error.is_none(), "got {:?}", resp.error);
        assert_eq!(state.machines.get().unwrap().self_machine().unwrap().label, "Renamed by B");
    }

    #[tokio::test]
    async fn peer_profile_changed_updates_the_senders_entry_only() {
        let dir = tempdir().unwrap();
        let state = state_with_machines(dir.path());
        add_peer(&state, "mach-b", "B");
        add_peer(&state, "mach-c", "C");
        let own_before = state.machines.get().unwrap().self_machine().unwrap();
        let resp = dispatch_profile(
            &state,
            "peer_profile_changed",
            // A params machine_id is ignored: the sender is the transport's machine.
            json!({"machine_id": "mach-c", "label": "B new", "icon": "ph-laptop"}),
            Some(Transport::PeerMachine("mach-b".into())),
        )
        .await;
        assert!(resp.error.is_none(), "got {:?}", resp.error);
        let reg = state.machines.get().unwrap();
        let b = reg.peer("mach-b").unwrap();
        assert_eq!((b.label.as_str(), b.icon.as_deref()), ("B new", Some("ph-laptop")));
        assert_eq!(reg.peer("mach-c").unwrap().label, "C");
        assert_eq!(reg.self_machine().unwrap(), own_before, "an announcement never touches our own profile");
    }

    #[tokio::test]
    async fn peer_profile_changed_refuses_a_non_peer_caller_and_a_bad_icon() {
        let dir = tempdir().unwrap();
        let state = state_with_machines(dir.path());
        add_peer(&state, "mach-b", "B");
        let resp = dispatch_profile(&state, "peer_profile_changed", json!({"label": "X"}), None).await;
        assert_eq!(resp.error.map(|e| e.code), Some(-32602));
        let resp = dispatch_profile(
            &state,
            "peer_profile_changed",
            json!({"label": "X", "icon": "nope"}),
            Some(Transport::PeerMachine("mach-b".into())),
        )
        .await;
        assert_eq!(resp.error.map(|e| e.code), Some(-32602));
        assert_eq!(state.machines.get().unwrap().peer("mach-b").unwrap().label, "B");
    }
}
