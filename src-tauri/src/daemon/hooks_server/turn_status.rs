//! `/turn/report-status` route: the `cc_conductor` `report_turn_status` MCP
//! tool POSTs here (todo 435). Same trust level as `hooks_server::channel` -
//! `session_id` rides the tool call's own `CC_SESSION_ID` env, no separate
//! auth.

use super::HookCtx;
use crate::daemon::methods::turn_status;
use axum::{extract::State as AxState, http::StatusCode, response::IntoResponse, Json};
use serde_json::{json, Value};
use std::sync::Arc;

/// Extracts as `Json<Value>` rather than a typed struct with a required
/// `status: String` field (todo 542): a model call missing/nulling `status`
/// (observed live - the Stop hook's prompt never tells it to pass one) used
/// to fail axum's typed-`Json` deserialization *before* this handler ran,
/// and axum's default rejection body is plain text, not JSON - so the MCP
/// relay client's `resp.json()` parse failed with an opaque "error decoding
/// response body" instead of the clean `{"ok": false, "error": ...}` todo
/// 435 was meant to guarantee. Pulling fields out of a `Value` keeps every
/// response JSON, valid status or not.
pub(super) async fn on_report_status(
    AxState(ctx): AxState<Arc<HookCtx>>,
    Json(body): Json<Value>,
) -> impl IntoResponse {
    let session_id = body["session_id"].as_str().unwrap_or_default();
    let title = body["title"].as_str();
    let status = match body["status"].as_str() {
        Some(s) => s,
        None => {
            return (
                StatusCode::OK,
                Json(json!({
                    "ok": false,
                    "error": "missing 'status': must be one of done|question|waiting|working"
                })),
            );
        }
    };
    match turn_status::report_status(&ctx.state, session_id, status, title) {
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
        let body = json!({"session_id": "s", "status": "done", "title": "Fix bug"});
        let resp = on_report_status(AxState(ctx()), Json(body)).await.into_response();
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(body_json(resp).await, json!({"ok": true}));
    }

    #[tokio::test]
    async fn invalid_status_route_returns_ok_false_with_error() {
        let body = json!({"session_id": "s", "status": "bogus"});
        let resp = on_report_status(AxState(ctx()), Json(body)).await.into_response();
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        assert_eq!(v["ok"], json!(false));
        assert!(v["error"].as_str().unwrap().contains("bogus"));
    }

    // The actual todo-542 bug: `status` missing/null (what the model sends
    // when it calls the tool with no arguments) must still round-trip as
    // JSON, not fall through to axum's plain-text rejection body.
    #[tokio::test]
    async fn missing_status_route_returns_ok_false_with_error() {
        let body = json!({"session_id": "s"});
        let resp = on_report_status(AxState(ctx()), Json(body)).await.into_response();
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        assert_eq!(v["ok"], json!(false));
        assert!(v["error"].as_str().unwrap().contains("missing 'status'"));
    }

    #[tokio::test]
    async fn null_status_route_returns_ok_false_with_error() {
        let body = json!({"session_id": "s", "status": null});
        let resp = on_report_status(AxState(ctx()), Json(body)).await.into_response();
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        assert_eq!(v["ok"], json!(false));
        assert!(v["error"].as_str().unwrap().contains("missing 'status'"));
    }
}
