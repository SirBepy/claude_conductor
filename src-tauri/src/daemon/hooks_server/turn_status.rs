//! `/turn/report-status` route: the `cc_conductor` `report_turn_status` MCP
//! tool POSTs here (todo 435). Same trust level as `hooks_server::channel` -
//! `session_id` rides the tool call's own `CC_SESSION_ID` env, no separate
//! auth.

use super::HookCtx;
use crate::daemon::methods::turn_status;
use axum::{extract::State as AxState, http::StatusCode, response::IntoResponse, Json};
use serde::Deserialize;
use serde_json::json;
use std::sync::Arc;

#[derive(Deserialize)]
pub(super) struct ReportStatusBody {
    session_id: String,
    status: String,
    #[serde(default)]
    title: Option<String>,
}

pub(super) async fn on_report_status(
    AxState(ctx): AxState<Arc<HookCtx>>,
    Json(body): Json<ReportStatusBody>,
) -> impl IntoResponse {
    match turn_status::report_status(&ctx.state, &body.session_id, &body.status, body.title.as_deref()) {
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
    async fn valid_status_route_returns_ok() {
        let body = ReportStatusBody { session_id: "s".into(), status: "done".into(), title: Some("Fix bug".into()) };
        let resp = on_report_status(AxState(ctx()), Json(body)).await.into_response();
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(body_json(resp).await, json!({"ok": true}));
    }

    #[tokio::test]
    async fn invalid_status_route_returns_ok_false_with_error() {
        let body = ReportStatusBody { session_id: "s".into(), status: "bogus".into(), title: None };
        let resp = on_report_status(AxState(ctx()), Json(body)).await.into_response();
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        assert_eq!(v["ok"], json!(false));
        assert!(v["error"].as_str().unwrap().contains("bogus"));
    }
}
