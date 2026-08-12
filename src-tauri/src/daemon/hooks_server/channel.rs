//! Inter-agent coordination-channel hooks routes. The MCP `cc_conductor`
//! tools `list_peers` / `post_message` / `read_messages` POST here. Unlike
//! `hooks_server::jarvis`'s routes, these tools are advertised UNCONDITIONALLY
//! in every session's `tools/list` (see `mcp::server::tool_list_response`),
//! so there's no privileged-caller re-validation to do here - `session_id`
//! just has to resolve to a live registry entry, the same trust level as any
//! other MCP tool call riding that session's own `CC_SESSION_ID` env.

use super::validated_json::ValidatedJson;
use super::HookCtx;
use crate::daemon::methods::channel as channel_methods;
use axum::{extract::State as AxState, http::StatusCode, response::IntoResponse, Json};
use serde::Deserialize;
use serde_json::json;
use std::sync::Arc;

#[derive(Deserialize)]
pub(super) struct SessionOnlyBody {
    session_id: String,
}

pub(super) async fn on_list_peers(
    AxState(ctx): AxState<Arc<HookCtx>>,
    ValidatedJson(body): ValidatedJson<SessionOnlyBody>,
) -> impl IntoResponse {
    match channel_methods::list_peers(&ctx.state, &body.session_id) {
        Ok(v) => (StatusCode::OK, Json(v)),
        Err(e) => (StatusCode::OK, Json(json!({"ok": false, "error": e}))),
    }
}

pub(super) async fn on_read_messages(
    AxState(ctx): AxState<Arc<HookCtx>>,
    ValidatedJson(body): ValidatedJson<SessionOnlyBody>,
) -> impl IntoResponse {
    match channel_methods::read_messages(&ctx.state, &body.session_id) {
        Ok(v) => (StatusCode::OK, Json(v)),
        Err(e) => (StatusCode::OK, Json(json!({"ok": false, "error": e}))),
    }
}

#[derive(Deserialize)]
pub(super) struct PostMessageBody {
    session_id: String,
    text: String,
}

pub(super) async fn on_post_message(
    AxState(ctx): AxState<Arc<HookCtx>>,
    ValidatedJson(body): ValidatedJson<PostMessageBody>,
) -> impl IntoResponse {
    match channel_methods::post_message(&ctx.state, &body.session_id, &body.text) {
        Ok(v) => (StatusCode::OK, Json(v)),
        Err(e) => (StatusCode::OK, Json(json!({"ok": false, "error": e}))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::daemon::state::DaemonState;
    use crate::types::Settings;

    fn ctx() -> Arc<HookCtx> {
        Arc::new(HookCtx {
            state: DaemonState::new(new_session_map(), SettingsCache::new(Settings::default())),
        })
    }

    async fn body_json(resp: axum::response::Response) -> serde_json::Value {
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    #[tokio::test]
    async fn list_peers_route_errors_for_unregistered_session() {
        let body = SessionOnlyBody { session_id: "ghost".to_string() };
        let resp = on_list_peers(AxState(ctx()), ValidatedJson(body)).await.into_response();
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        assert_eq!(v["ok"], false);
    }

    #[tokio::test]
    async fn post_message_route_errors_for_empty_text() {
        let c = ctx();
        c.state.registry.upsert_interactive("s1", std::path::Path::new("."), "proj-1", "2026-07-30T00:00:00Z");
        let body = PostMessageBody { session_id: "s1".to_string(), text: "".to_string() };
        let resp = on_post_message(AxState(c), ValidatedJson(body)).await.into_response();
        let v = body_json(resp).await;
        assert_eq!(v["ok"], false);
    }
}
