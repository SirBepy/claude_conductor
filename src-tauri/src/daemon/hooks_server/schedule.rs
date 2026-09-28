//! `/schedule/write`: HTTP half of the `schedule` MCP tool. The claimed
//! `session_id` is untrusted here, exactly as in `spawn_chat.rs` - the method
//! re-derives the caller's cwd and inherited chat config from the registry
//! and refuses an unknown session. Outcome rides in the body at `200 OK`, the
//! same shape every other MCP route in this module uses, so a rejected write
//! reaches the model as a readable reason rather than a transport error.

use super::validated_json::ValidatedJson;
use super::HookCtx;
use crate::daemon::methods::schedule_mcp::{self, ScheduleArgs};
use axum::{extract::State as AxState, http::StatusCode, response::IntoResponse, Json};
use serde::Deserialize;
use serde_json::json;
use std::sync::Arc;

#[derive(Deserialize)]
pub(super) struct WriteScheduleBody {
    session_id: String,
    action: String,
    // Option rather than `#[serde(default)] String` throughout, for the reason
    // spelled out in `user_todos::WriteTodoBody`: `default` covers a missing
    // key, not an explicit null.
    #[serde(default)]
    prompt: Option<String>,
    #[serde(default)]
    target: Option<String>,
    #[serde(default)]
    in_minutes: Option<i64>,
    #[serde(default)]
    at: Option<String>,
    #[serde(default)]
    repeat: Option<String>,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    id: Option<String>,
}

pub(super) async fn on_write_schedule(
    AxState(ctx): AxState<Arc<HookCtx>>,
    ValidatedJson(body): ValidatedJson<WriteScheduleBody>,
) -> impl IntoResponse {
    // todo 824 remaining 1: reachable only via the MCP `schedule` tool.
    super::mark_mcp_tool_used(&ctx, &body.session_id);
    let args = ScheduleArgs {
        action: body.action,
        prompt: body.prompt,
        target: body.target,
        in_minutes: body.in_minutes,
        at: body.at,
        repeat: body.repeat,
        cwd: body.cwd,
        name: body.name,
        id: body.id,
    };
    match schedule_mcp::write_schedule(&ctx.state, &body.session_id, &args) {
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
    use serde_json::Value;

    fn ctx() -> Arc<HookCtx> {
        Arc::new(HookCtx {
            state: DaemonState::new(new_session_map(), SettingsCache::new(Settings::default())),
        })
    }

    async fn body_text(resp: axum::response::Response) -> String {
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        String::from_utf8(bytes.to_vec()).unwrap()
    }

    fn add_body(session_id: &str) -> WriteScheduleBody {
        WriteScheduleBody {
            session_id: session_id.to_string(),
            action: "add".to_string(),
            prompt: Some("check CI".to_string()),
            target: None,
            in_minutes: Some(30),
            at: None,
            repeat: None,
            cwd: None,
            name: None,
            id: None,
        }
    }

    /// The tool is advertised to every session, so the method's registry
    /// lookup is the only thing standing between it and an item scheduled
    /// against a session that does not exist. Read-only on this path (the
    /// caller check runs before any `upsert`), so it never touches the real
    /// `scheduled-items.json`.
    #[tokio::test]
    async fn add_rejects_an_unregistered_caller() {
        let resp = on_write_schedule(AxState(ctx()), ValidatedJson(add_body("ghost")))
            .await
            .into_response();
        assert_eq!(resp.status(), StatusCode::OK);
        let v: Value = serde_json::from_str(&body_text(resp).await).unwrap();
        assert_eq!(v["ok"], false);
        assert!(
            v["error"].as_str().unwrap_or_default().contains("unknown caller"),
            "got {v}"
        );
    }

    #[tokio::test]
    async fn an_unknown_action_reports_the_two_that_exist() {
        let mut body = add_body("ghost");
        body.action = "list".to_string();
        let resp = on_write_schedule(AxState(ctx()), ValidatedJson(body)).await.into_response();
        let v: Value = serde_json::from_str(&body_text(resp).await).unwrap();
        assert_eq!(v["ok"], false);
        let err = v["error"].as_str().unwrap_or_default();
        assert!(err.contains("add") && err.contains("cancel"), "got {err}");
    }

    #[test]
    fn body_accepts_an_add_with_only_the_keys_the_relay_sends() {
        let body: WriteScheduleBody = serde_json::from_str(
            r#"{"session_id":"s","action":"add","prompt":"p","in_minutes":30}"#,
        )
        .unwrap();
        assert_eq!(body.in_minutes, Some(30));
        assert_eq!(body.at, None);
    }

    #[test]
    fn body_accepts_explicit_nulls() {
        let body: WriteScheduleBody = serde_json::from_str(
            r#"{"session_id":"s","action":"cancel","id":"abc","prompt":null,"at":null,"in_minutes":null}"#,
        )
        .unwrap();
        assert_eq!(body.id.as_deref(), Some("abc"));
        assert_eq!(body.in_minutes, None);
    }
}
