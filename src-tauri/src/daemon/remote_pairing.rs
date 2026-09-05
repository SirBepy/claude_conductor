//! Device-pairing endpoint for the remote-access server. Split out of
//! `remote_handlers.rs` (ai_todo 319): only touches `DeviceRegistry`, no
//! dependency on the chat/session core.

use std::sync::Arc;

use axum::{extract::State, http::StatusCode, response::{IntoResponse, Response}, Json};
use serde::Deserialize;

use crate::daemon::device_registry::DeviceRegistry;
use crate::daemon::machines::{now_secs, PeerMachine};

use super::remote_server::{check_pairing_code, consume_pairing_code, RemoteCtx};

/// Present only when a peer DAEMON (not a phone) is pairing. Its own machine
/// identity plus the bearer it wants US to present back to IT.
#[derive(Deserialize)]
pub(super) struct PairPeer {
    machine_id: String,
    label: String,
    #[serde(default)]
    os: String,
    #[serde(default)]
    iroh_id: Option<String>,
    #[serde(default)]
    direct_url: Option<String>,
    reverse_token: String,
}

#[derive(Deserialize)]
pub(super) struct PairBody {
    pairing_code: String,
    device_name: Option<String>,
    #[serde(default)]
    peer: Option<PairPeer>,
}

pub(super) async fn pair_device(
    State(ctx): State<Arc<RemoteCtx>>,
    Json(body): Json<PairBody>,
) -> Response {
    if !DeviceRegistry::is_enabled(&ctx.app_data) {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }
    if let Err(reason) = check_pairing_code(&body.pairing_code, &ctx.app_data) {
        return (StatusCode::BAD_REQUEST, reason).into_response();
    }
    if let Some(peer) = body.peer {
        return pair_machine_peer(&ctx, peer).await;
    }
    let name = body.device_name.unwrap_or_else(|| "Phone".to_string());
    // Only consume the one-time code once registration actually succeeds -
    // a failed add_device must leave it valid so the same code can retry.
    match DeviceRegistry::add_device(&name, &ctx.app_data) {
        Ok(token) => {
            consume_pairing_code(&ctx.app_data);
            Json(serde_json::json!({ "device_token": token })).into_response()
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
}

/// The machine-pairing half of `/api/pair`, entered when the requester is
/// another daemon (`body.peer` present). Mirrors the phone branch's "consume
/// only after the follow-up succeeds" rule, and additionally revokes any
/// prior peer entry's reverse token for the same `machine_id` (a re-pair).
async fn pair_machine_peer(ctx: &Arc<RemoteCtx>, peer: PairPeer) -> Response {
    let Some(machines) = ctx.state.machines.get() else {
        return (StatusCode::SERVICE_UNAVAILABLE, "machine registry not initialised").into_response();
    };
    let (device_token, device_id) = match DeviceRegistry::add_machine_device(&peer.label, &peer.machine_id, &ctx.app_data) {
        Ok(v) => v,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    };
    if let Some(old) = machines.peer(&peer.machine_id) {
        if let Some(old_device_id) = old.reverse_device_id {
            let _ = DeviceRegistry::revoke_device(&old_device_id, &ctx.app_data);
        }
    }
    let mine = machines.self_machine().unwrap_or_else(|| machines.ensure_self());
    machines.upsert_peer(PeerMachine {
        machine_id: peer.machine_id,
        label: peer.label,
        os: peer.os,
        iroh_id: peer.iroh_id,
        direct_url: peer.direct_url,
        token: peer.reverse_token,
        reverse_device_id: Some(device_id),
        added_at: now_secs(),
    });
    consume_pairing_code(&ctx.app_data);
    Json(serde_json::json!({
        "device_token": device_token,
        "peer": {
            "machine_id": mine.machine_id,
            "label": mine.label,
            "os": mine.os,
            // No iroh tunnel plumbing yet - our own machine_id doubles as
            // our iroh endpoint id (see `MachineRegistry::ensure_self`).
            "iroh_id": mine.machine_id,
        }
    }))
    .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;
    use tempfile::tempdir;

    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::daemon::state::DaemonState;
    use crate::types::Settings;
    use crate::util::sha256_hex;

    fn ctx_for(app_data: std::path::PathBuf) -> Arc<RemoteCtx> {
        Arc::new(RemoteCtx {
            state: DaemonState::new(new_session_map(), SettingsCache::new(Settings::default())),
            app_data,
            router: crate::daemon::rpc::Router::new(),
            stt: crate::daemon::stt::SttSupervisor::new(std::env::temp_dir()),
        })
    }

    /// Same as `ctx_for`, but with the machine registry initialised - the
    /// machine-pairing branch 503s without one (see `pair_machine_peer`).
    fn ctx_with_machines(app_data: std::path::PathBuf) -> Arc<RemoteCtx> {
        let ctx = ctx_for(app_data.clone());
        ctx.state.init_machines(app_data);
        ctx.state.machines.get().unwrap().ensure_self();
        ctx
    }

    fn a_peer(machine_id: &str) -> PairPeer {
        PairPeer {
            machine_id: machine_id.to_string(),
            label: "Mac Mini".to_string(),
            os: "macos".to_string(),
            iroh_id: Some("iroh-abc".to_string()),
            direct_url: Some("http://127.0.0.1:27291".to_string()),
            reverse_token: "dummy-reverse".to_string(),
        }
    }

    fn write_pairing_code(app_data: &std::path::Path, code: &str) {
        let expires_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs()
            + 120;
        let body = serde_json::json!({ "code_hash": sha256_hex(code), "expires_at": expires_at });
        std::fs::write(app_data.join("remote-pairing.json"), body.to_string()).unwrap();
    }

    /// If `DeviceRegistry::add_device` fails, the one-time pairing code must
    /// NOT be burned: the pairing file stays on disk and the same code still
    /// validates on a retry. Forces the failure by making the registry file
    /// read-only, so `add_device`'s `save()` (a `std::fs::write`) errors out.
    #[tokio::test]
    async fn pair_device_leaves_pairing_code_intact_when_add_device_fails() {
        let dir = tempdir().unwrap();
        DeviceRegistry::ensure_desktop_device(dir.path());
        let code = "retryablecode";
        write_pairing_code(dir.path(), code);
        let registry_path = dir.path().join("remote-devices.json");
        let mut perms = std::fs::metadata(&registry_path).unwrap().permissions();
        perms.set_readonly(true);
        std::fs::set_permissions(&registry_path, perms).unwrap();

        let ctx = ctx_for(dir.path().to_path_buf());
        let resp = pair_device(
            State(ctx.clone()),
            Json(PairBody { pairing_code: code.to_string(), device_name: None, peer: None }),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::INTERNAL_SERVER_ERROR);

        assert!(dir.path().join("remote-pairing.json").exists());

        // Clear the forced failure and retry with the SAME code: it must
        // still be accepted and must now succeed.
        let mut perms = std::fs::metadata(&registry_path).unwrap().permissions();
        perms.set_readonly(false);
        std::fs::set_permissions(&registry_path, perms).unwrap();
        let resp2 = pair_device(
            State(ctx),
            Json(PairBody { pairing_code: code.to_string(), device_name: None, peer: None }),
        )
        .await;
        assert_eq!(resp2.status(), StatusCode::OK);
        let bytes = to_bytes(resp2.into_body(), usize::MAX).await.unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert!(v.get("device_token").is_some());
        assert!(!dir.path().join("remote-pairing.json").exists());
    }

    /// A `peer`-carrying pair request registers a Machine-kind device and
    /// upserts the caller into `MachineRegistry`, returning our own identity
    /// block instead of a bare `device_token`.
    #[tokio::test]
    async fn machine_pair_registers_peer_and_returns_identity_block() {
        let dir = tempdir().unwrap();
        DeviceRegistry::ensure_desktop_device(dir.path());
        let code = "machinecode1";
        write_pairing_code(dir.path(), code);
        let ctx = ctx_with_machines(dir.path().to_path_buf());

        let resp = pair_device(
            State(ctx.clone()),
            Json(PairBody { pairing_code: code.to_string(), device_name: None, peer: Some(a_peer("mach-1")) }),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        let device_token = v["device_token"].as_str().unwrap();
        assert_eq!(
            v["peer"]["machine_id"].as_str().unwrap(),
            ctx.state.machines.get().unwrap().self_machine().unwrap().machine_id
        );

        let (kind, machine_id) = DeviceRegistry::resolve_token(device_token, dir.path()).unwrap();
        assert_eq!(kind, crate::daemon::device_registry::DeviceKind::Machine);
        assert_eq!(machine_id.as_deref(), Some("mach-1"));

        let stored = ctx.state.machines.get().unwrap().peer("mach-1").unwrap();
        assert_eq!(stored.token, "reverse-tok");
        assert!(stored.reverse_device_id.is_some());

        assert!(!dir.path().join("remote-pairing.json").exists());
    }

    /// Re-pairing the same `machine_id` must revoke the stale reverse device
    /// from the first pairing - otherwise the old bearer token stays valid
    /// forever even though `MachineRegistry` no longer remembers it.
    #[tokio::test]
    async fn machine_repair_revokes_the_previous_reverse_device() {
        let dir = tempdir().unwrap();
        DeviceRegistry::ensure_desktop_device(dir.path());
        let ctx = ctx_with_machines(dir.path().to_path_buf());

        write_pairing_code(dir.path(), "code-one");
        let resp1 = pair_device(
            State(ctx.clone()),
            Json(PairBody { pairing_code: "code-one".to_string(), device_name: None, peer: Some(a_peer("mach-1")) }),
        )
        .await;
        assert_eq!(resp1.status(), StatusCode::OK);
        let bytes1 = to_bytes(resp1.into_body(), usize::MAX).await.unwrap();
        let v1: serde_json::Value = serde_json::from_slice(&bytes1).unwrap();
        let first_token = v1["device_token"].as_str().unwrap().to_string();
        assert!(DeviceRegistry::validate_token(&first_token, dir.path()));

        write_pairing_code(dir.path(), "code-two");
        let resp2 = pair_device(
            State(ctx.clone()),
            Json(PairBody { pairing_code: "code-two".to_string(), device_name: None, peer: Some(a_peer("mach-1")) }),
        )
        .await;
        assert_eq!(resp2.status(), StatusCode::OK);

        // The first pairing's device token must now be dead; the machine
        // registry keeps exactly one entry for "mach-1".
        assert!(!DeviceRegistry::validate_token(&first_token, dir.path()));
        assert_eq!(ctx.state.machines.get().unwrap().peers().len(), 1);
    }

    /// Mirrors `pair_device_leaves_pairing_code_intact_when_add_device_fails`
    /// for the machine branch: a failed `add_machine_device` must leave the
    /// one-time code retryable.
    #[tokio::test]
    async fn machine_pair_leaves_pairing_code_intact_when_add_device_fails() {
        let dir = tempdir().unwrap();
        DeviceRegistry::ensure_desktop_device(dir.path());
        let code = "retryable-machine";
        write_pairing_code(dir.path(), code);
        let ctx = ctx_with_machines(dir.path().to_path_buf());

        let registry_path = dir.path().join("remote-devices.json");
        let mut perms = std::fs::metadata(&registry_path).unwrap().permissions();
        perms.set_readonly(true);
        std::fs::set_permissions(&registry_path, perms).unwrap();

        let resp = pair_device(
            State(ctx.clone()),
            Json(PairBody { pairing_code: code.to_string(), device_name: None, peer: Some(a_peer("mach-1")) }),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::INTERNAL_SERVER_ERROR);
        assert!(dir.path().join("remote-pairing.json").exists());

        let mut perms = std::fs::metadata(&registry_path).unwrap().permissions();
        perms.set_readonly(false);
        std::fs::set_permissions(&registry_path, perms).unwrap();
        let resp2 = pair_device(
            State(ctx),
            Json(PairBody { pairing_code: code.to_string(), device_name: None, peer: Some(a_peer("mach-1")) }),
        )
        .await;
        assert_eq!(resp2.status(), StatusCode::OK);
        assert!(!dir.path().join("remote-pairing.json").exists());
    }
}
