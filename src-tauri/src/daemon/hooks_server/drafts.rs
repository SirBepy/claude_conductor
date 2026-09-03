//! The `write_draft` MCP tool's HTTP route (todo 666). The per-turn injection
//! for drafts is served by `user_todos::on_prompt_submit`, which owns the one
//! `UserPromptSubmit` hook both features share.

use super::validated_json::ValidatedJson;
use super::HookCtx;
use crate::daemon::methods::drafts_store as draft_methods;
use axum::{extract::State as AxState, http::StatusCode, response::IntoResponse, Json};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

/// Everything past `session_id`/`action` is forwarded as a raw object rather
/// than named fields: the actions take disjoint sets, and `#[serde(default)]`
/// only covers a MISSING key, not an explicit null.
#[derive(Deserialize)]
pub(super) struct WriteDraftBody {
    session_id: String,
    action: String,
    #[serde(flatten)]
    rest: Value,
}

pub(super) async fn on_write_draft(
    AxState(ctx): AxState<Arc<HookCtx>>,
    ValidatedJson(body): ValidatedJson<WriteDraftBody>,
) -> impl IntoResponse {
    // todo 824 remaining 1: reachable only via the MCP `write_draft` tool.
    super::mark_mcp_tool_used(&ctx, &body.session_id);
    match draft_methods::write_draft(&ctx.state, &body.session_id, &body.action, &body.rest) {
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

    #[test]
    fn flattened_body_keeps_the_action_specific_fields() {
        let body: WriteDraftBody = serde_json::from_value(json!({
            "session_id": "s1",
            "action": "add",
            "topic": "Sprint slip",
            "recipient": "Bruno",
            "body": "hey"
        }))
        .unwrap();
        assert_eq!(body.action, "add");
        assert_eq!(body.rest["topic"], "Sprint slip");
        assert_eq!(body.rest["recipient"], "Bruno");
    }

    #[tokio::test]
    async fn write_route_reports_an_unknown_session_without_panicking() {
        let body: WriteDraftBody =
            serde_json::from_value(json!({"session_id": "ghost", "action": "add", "topic": "t"})).unwrap();
        let resp = on_write_draft(AxState(ctx()), ValidatedJson(body)).await.into_response();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        let v: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(v["ok"], false);
    }
}
