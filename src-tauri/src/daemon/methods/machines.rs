//! Machine-identity RPCs: `list_machines` (desktop + read-only), and the
//! pairing/unpairing/labeling mutators, desktop-pipe-only (absent from
//! `remote_handlers::TRANSPORT_TABLE`) except `peer_unpaired` - the one
//! peer-callable exception (mask `M` there), the OTHER side of an unpair.
//! `list_machine_projects` is also desktop-pipe-only: it's the new-chat
//! picker's own cross-machine fetch, not a method a peer daemon would call.

use std::sync::Arc;

use serde::Deserialize;
use serde_json::{json, Value};

use crate::daemon::device_registry::DeviceRegistry;
use crate::daemon::machines::forward::map_peer_err;
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

/// How `pair_machine` will physically reach the peer it just parsed a
/// pairing URL for - decided before any network call, so it's unit-testable
/// on its own. Mirrors `peer_client::reach_url`'s branch order (direct wins,
/// iroh is the fallback), but works off `ParsedPairing` since pairing hasn't
/// stored a `PeerMachine` yet.
#[derive(Debug, PartialEq)]
pub(crate) enum ReachDecision {
    Direct(String),
    Iroh(String),
    Neither,
}

pub(crate) fn decide_reach(parsed: &ParsedPairing) -> ReachDecision {
    if let Some(direct) = &parsed.direct_url {
        ReachDecision::Direct(direct.clone())
    } else if let Some(id) = &parsed.iroh_id {
        ReachDecision::Iroh(id.clone())
    } else {
        ReachDecision::Neither
    }
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
    if let Ok(client) = peer_client::client_for(state, &removed).await {
        let _ = client.call("peer_unpaired", json!({ "machine_id": mine.machine_id })).await;
    }
    crate::daemon::machines::MachineHub::sync_links(state);
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
            crate::daemon::machines::MachineHub::sync_links(state);
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

    // ── decide_reach ────────────────────────────────────────────────────

    #[test]
    fn decide_reach_prefers_direct_url() {
        let parsed = parse_pairing_url("https://box.tailnet.ts.net/?pair=abc123&iroh=deadbeef").unwrap();
        assert_eq!(decide_reach(&parsed), ReachDecision::Direct("https://box.tailnet.ts.net".into()));
    }

    #[test]
    fn decide_reach_falls_back_to_iroh_for_a_conductor_scheme_link() {
        let parsed = parse_pairing_url("conductor://pair?iroh=deadbeef&pair=abc123").unwrap();
        assert_eq!(decide_reach(&parsed), ReachDecision::Iroh("deadbeef".into()));
    }

    #[test]
    fn decide_reach_neither_when_a_plain_conductor_link_carries_no_iroh_id() {
        let parsed = ParsedPairing { code: "abc123".into(), iroh_id: None, direct_url: None };
        assert_eq!(decide_reach(&parsed), ReachDecision::Neither);
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
