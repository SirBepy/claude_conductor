//! Device-pairing endpoint for the remote-access server. Split out of
//! `remote_handlers.rs` (ai_todo 319): only touches `DeviceRegistry`, no
//! dependency on the chat/session core.

use std::sync::Arc;

use axum::{extract::State, http::StatusCode, response::{IntoResponse, Response}, Json};
use serde::Deserialize;

use crate::daemon::device_registry::DeviceRegistry;

use super::remote_server::{validate_pairing_code, RemoteCtx};

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
    if let Err(reason) = validate_pairing_code(&body.pairing_code, &ctx.app_data) {
        return (StatusCode::BAD_REQUEST, reason).into_response();
    }
    let name = body.device_name.unwrap_or_else(|| "Phone".to_string());
    match DeviceRegistry::add_device(&name, &ctx.app_data) {
        Ok(token) => Json(serde_json::json!({ "device_token": token })).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
}
