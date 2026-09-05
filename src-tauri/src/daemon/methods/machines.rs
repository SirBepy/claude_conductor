//! Machine-identity RPCs: `list_machines` (desktop + read-only), and the
//! pairing/unpairing/labeling mutators, desktop-pipe-only (absent from
//! `remote_handlers::TRANSPORT_TABLE`) except `peer_unpaired` - the one
//! peer-callable exception (mask `M` there), the OTHER side of an unpair.

use std::sync::Arc;

use serde::Deserialize;
use serde_json::{json, Value};

use crate::daemon::device_registry::DeviceRegistry;
use crate::daemon::machines::{self, peer_client, PeerMachine, PeerMachineView};
use crate::daemon::rpc::{ConnectionContext, Router, RpcError, Transport};
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
                pair_machine(&state, req).await
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
                unpair_machine(&state, &req.machine_id).await
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
                set_machine_label(&state, &req.label)
            }
        }
    });

    router.register("peer_unpaired", {
        let state = state.clone();
        move |_params, ctx| {
            let state = state.clone();
            async move { peer_unpaired(&state, &ctx).await }
        }
    });
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

/// The three URL shapes `build_pairing_url` (`ipc::remote_access`) mints,
/// plus a plain `http://host:port/?pair=code` for a same-LAN direct pair.
#[derive(Debug, PartialEq)]
pub(crate) struct ParsedPairing {
    pub code: String,
    pub iroh_id: Option<String>,
    /// Origin (`scheme://host[:port]`) to reach the peer directly. `None`
    /// for `conductor://` links, which carry no usable host.
    pub direct_url: Option<String>,
}

/// Pure URL parsing so this is unit-testable without a network or a daemon.
pub(crate) fn parse_pairing_url(raw: &str) -> Result<ParsedPairing, String> {
    let parsed = url::Url::parse(raw).map_err(|e| format!("invalid pairing url: {e}"))?;
    let mut code = None;
    let mut iroh_id = None;
    for (k, v) in parsed.query_pairs() {
        match k.as_ref() {
            "pair" => code = Some(v.into_owned()),
            "iroh" => iroh_id = Some(v.into_owned()),
            _ => {}
        }
    }
    let code = code.ok_or_else(|| "pairing url is missing a pair= code".to_string())?;
    let direct_url = match parsed.scheme() {
        "http" | "https" => {
            let host = parsed.host_str().ok_or_else(|| "pairing url has no host".to_string())?;
            match parsed.port() {
                Some(port) => Some(format!("{}://{}:{}", parsed.scheme(), host, port)),
                None => Some(format!("{}://{}", parsed.scheme(), host)),
            }
        }
        _ => None,
    };
    Ok(ParsedPairing { code, iroh_id, direct_url })
}

async fn pair_machine(state: &Arc<DaemonState>, req: PairMachineParams) -> Result<Value, RpcError> {
    let registry = state.machines.get().ok_or_else(|| RpcError::internal("machine registry not initialised"))?;
    let mine = registry.self_machine().unwrap_or_else(|| registry.ensure_self());
    let app_data = registry.app_data().to_path_buf();

    let parsed = parse_pairing_url(&req.url).map_err(RpcError::invalid_params)?;
    let Some(direct_url) = parsed.direct_url else {
        return Err(RpcError::invalid_params(
            "iroh-only pairing arrives in a later chunk; use a URL with a host",
        ));
    };

    let health = peer_client::PeerClient::new(&direct_url, "")
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

    let resp = match peer_client::post_pairing_request(&direct_url, body).await {
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
        direct_url: Some(direct_url),
        token: device_token,
        reverse_device_id: Some(minted_device_id),
        added_at: machines::now_secs(),
    };
    registry.upsert_peer(peer.clone());
    serde_json::to_value(PeerMachineView::from(&peer)).map_err(|e| RpcError::internal(e.to_string()))
}

async fn unpair_machine(state: &Arc<DaemonState>, machine_id: &str) -> Result<Value, RpcError> {
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
    if let Ok(client) = peer_client::client_for(&removed) {
        let _ = client.call("peer_unpaired", json!({ "machine_id": mine.machine_id })).await;
    }
    Ok(json!({ "removed": true }))
}

fn set_machine_label(state: &Arc<DaemonState>, label: &str) -> Result<Value, RpcError> {
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
async fn peer_unpaired(state: &Arc<DaemonState>, ctx: &ConnectionContext) -> Result<Value, RpcError> {
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
            Ok(json!({ "removed": true }))
        }
        None => Ok(json!({ "removed": false })),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::types::Settings;
    use tempfile::tempdir;

    // ── parse_pairing_url ──────────────────────────────────────────────────

    #[test]
    fn parses_tailscale_plus_iroh_shape() {
        let p = parse_pairing_url("https://box.tailnet.ts.net/?pair=abc123&iroh=deadbeef").unwrap();
        assert_eq!(p.code, "abc123");
        assert_eq!(p.iroh_id.as_deref(), Some("deadbeef"));
        assert_eq!(p.direct_url.as_deref(), Some("https://box.tailnet.ts.net"));
    }

    #[test]
    fn parses_tailscale_only_shape() {
        let p = parse_pairing_url("https://box.tailnet.ts.net/?pair=abc123").unwrap();
        assert_eq!(p.code, "abc123");
        assert_eq!(p.iroh_id, None);
        assert_eq!(p.direct_url.as_deref(), Some("https://box.tailnet.ts.net"));
    }

    #[test]
    fn parses_conductor_scheme_iroh_only_shape() {
        let p = parse_pairing_url("conductor://pair?iroh=deadbeef&pair=abc123").unwrap();
        assert_eq!(p.code, "abc123");
        assert_eq!(p.iroh_id.as_deref(), Some("deadbeef"));
        assert_eq!(p.direct_url, None, "conductor:// carries no usable host");
    }

    #[test]
    fn parses_plain_local_http_shape() {
        let p = parse_pairing_url("http://127.0.0.1:27291/?pair=someothercode").unwrap();
        assert_eq!(p.code, "someothercode");
        assert_eq!(p.iroh_id, None);
        assert_eq!(p.direct_url.as_deref(), Some("http://127.0.0.1:27291"));
    }

    #[test]
    fn rejects_garbage_urls() {
        assert!(parse_pairing_url("not a url").is_err());
        assert!(parse_pairing_url("https://box.tailnet.ts.net/").is_err(), "no pair= code");
    }

    // ── RPC-level ────────────────────────────────────────────────────────

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
        register_machines(&mut r, state_with_machines(dir.path()));
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
        register_machines(&mut r, state_with_machines(dir.path()));
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
        register_machines(&mut r, state_with_machines(dir.path()));
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
        register_machines(&mut r, state.clone());
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
        register_machines(&mut r, state.clone());
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
        register_machines(&mut r, state);
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
