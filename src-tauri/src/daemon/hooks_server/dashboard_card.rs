//! `dashboard_card` MCP tool route: a chat reads, writes, deletes or dry-runs a
//! custom dashboard card for its own project (or a group containing it). The
//! scope rule lives in `methods::project_dashboard::cards`.

use super::validated_json::ValidatedJson;
use super::HookCtx;
use crate::daemon::methods::project_dashboard::cards;
use axum::{extract::State as AxState, http::StatusCode, response::IntoResponse, Json};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

#[derive(Deserialize)]
pub(super) struct DashboardCardBody {
    session_id: String,
    action: String,
    // Option, not `#[serde(default)]`: the latter covers a missing key only,
    // an explicit `null` would still 4xx.
    #[serde(default)]
    card: Option<Value>,
    #[serde(default)]
    id: Option<String>,
    /// `pin`: the quick-action commands to pin.
    #[serde(default)]
    actions: Option<Vec<String>>,
    /// `pin`: which dashboard (default: this project).
    #[serde(default)]
    scope: Option<Value>,
}

pub(super) async fn on_dashboard_card(
    AxState(ctx): AxState<Arc<HookCtx>>,
    ValidatedJson(body): ValidatedJson<DashboardCardBody>,
) -> impl IntoResponse {
    super::mark_mcp_tool_used(&ctx, &body.session_id);
    match cards::dashboard_card_tool(&ctx.state, &body.session_id, &body.action, body.card, body.id, body.actions, body.scope)
        .await {
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
        Arc::new(HookCtx { state: DaemonState::new(new_session_map(), SettingsCache::new(Settings::default())) })
    }

    #[tokio::test]
    async fn an_unknown_session_gets_ok_false_not_a_panic() {
        let body = DashboardCardBody {
            session_id: uuid::Uuid::new_v4().to_string(),
            action: "list".to_string(),
            card: None,
            id: None,
            actions: None,
            scope: None,
        };
        let resp = on_dashboard_card(AxState(ctx()), ValidatedJson(body)).await.into_response();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        let v: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(v["ok"], false);
        assert!(v["error"].as_str().unwrap().contains("unknown session"));
    }

    #[test]
    fn body_accepts_explicit_nulls_for_card_and_id() {
        let b: DashboardCardBody = serde_json::from_str(
            r#"{"session_id":"s","action":"list","card":null,"id":null,"actions":null,"scope":null}"#,
        )
        .unwrap();
        assert!(b.card.is_none() && b.id.is_none() && b.actions.is_none() && b.scope.is_none());
    }
}
