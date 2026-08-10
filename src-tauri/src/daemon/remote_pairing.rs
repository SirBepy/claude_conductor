//! Device-pairing endpoint for the remote-access server. Split out of
//! `remote_handlers.rs` (ai_todo 319): only touches `DeviceRegistry`, no
//! dependency on the chat/session core.

use std::sync::Arc;

use axum::{extract::State, http::StatusCode, response::{IntoResponse, Response}, Json};
use serde::Deserialize;

use crate::daemon::device_registry::DeviceRegistry;

use super::remote_server::{check_pairing_code, consume_pairing_code, RemoteCtx};

#[derive(Deserialize)]
pub(super) struct PairBody {
    pairing_code: String,
    device_name: Option<String>,
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
            Json(PairBody { pairing_code: code.to_string(), device_name: None }),
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
            Json(PairBody { pairing_code: code.to_string(), device_name: None }),
        )
        .await;
        assert_eq!(resp2.status(), StatusCode::OK);
        let bytes = to_bytes(resp2.into_body(), usize::MAX).await.unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert!(v.get("device_token").is_some());
        assert!(!dir.path().join("remote-pairing.json").exists());
    }
}
