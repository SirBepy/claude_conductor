//! Web Push enrolment endpoints for the remote-access server (ai_todo 119):
//! VAPID key handoff, subscribe, unsubscribe. Split out of
//! `remote_handlers.rs` (ai_todo 319) since these three handlers only touch
//! `ctx.state.push` and share no helpers with the chat/session core.

use std::sync::Arc;

use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;

use super::remote_server::RemoteCtx;

/// The VAPID public key the phone needs as its `applicationServerKey`.
pub(super) async fn push_vapid_key(State(ctx): State<Arc<RemoteCtx>>) -> Response {
    match ctx.state.push.get() {
        Some(pm) => Json(serde_json::json!({ "key": pm.vapid_public() })).into_response(),
        None => StatusCode::SERVICE_UNAVAILABLE.into_response(),
    }
}

/// Register a phone's Web Push subscription (body = `subscription.toJSON()`).
pub(super) async fn push_subscribe(
    State(ctx): State<Arc<RemoteCtx>>,
    Json(sub): Json<crate::daemon::push::PushSubscription>,
) -> StatusCode {
    match ctx.state.push.get() {
        Some(pm) => {
            pm.subscribe(sub);
            StatusCode::NO_CONTENT
        }
        None => StatusCode::SERVICE_UNAVAILABLE,
    }
}

#[derive(Deserialize)]
pub(super) struct UnsubscribeBody {
    endpoint: String,
}

/// Drop a phone's subscription (on disable / re-pair).
pub(super) async fn push_unsubscribe(
    State(ctx): State<Arc<RemoteCtx>>,
    Json(body): Json<UnsubscribeBody>,
) -> StatusCode {
    match ctx.state.push.get() {
        Some(pm) => {
            pm.unsubscribe(&body.endpoint);
            StatusCode::NO_CONTENT
        }
        None => StatusCode::SERVICE_UNAVAILABLE,
    }
}
