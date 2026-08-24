//! "Your Todos" hook routes (todo 692): the `write_user_todo` MCP tool, and the
//! per-turn `UserPromptSubmit` injection. That event's `additionalContext`
//! envelope was verified against CLI 2.1.231 in the daemon's own stream-json
//! spawn shape before this was built; nothing else here registers it.

use super::validated_json::ValidatedJson;
use super::HookCtx;
use crate::daemon::methods::user_todos as todo_methods;
use axum::{
    extract::{Query, State as AxState},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

#[derive(Deserialize)]
pub(super) struct WriteTodoBody {
    session_id: String,
    action: String,
    // Option, not `#[serde(default)] String`: `default` only covers a MISSING
    // key, an explicit `"id": null` still hits String's visitor and 4xxs.
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    reason: Option<String>,
}

pub(super) async fn on_write_user_todo(
    AxState(ctx): AxState<Arc<HookCtx>>,
    ValidatedJson(body): ValidatedJson<WriteTodoBody>,
) -> impl IntoResponse {
    match todo_methods::write_user_todo(
        &ctx.state,
        &body.session_id,
        &body.action,
        &body.id.unwrap_or_default(),
        &body.text.unwrap_or_default(),
        &body.reason.unwrap_or_default(),
    ) {
        Ok(v) => (StatusCode::OK, Json(v)),
        Err(e) => (StatusCode::OK, Json(json!({"ok": false, "error": e}))),
    }
}

#[derive(Deserialize)]
pub(super) struct PromptSubmitQuery {
    /// OUR registry id, baked into the hook URL by `claude_config` - the id the
    /// daemon actually keys on, so it cannot drift on a fork.
    #[serde(default)]
    session_id: String,
}

/// Empty body when there is nothing to say: a "there is nothing" paragraph in
/// every turn forever is real per-turn cost, and empty stdout is the no-op.
/// `body` is read and discarded so curl consumes the CLI's stdin; the session
/// id comes from the query string instead.
pub(super) async fn on_prompt_submit(
    AxState(ctx): AxState<Arc<HookCtx>>,
    Query(q): Query<PromptSubmitQuery>,
    _body: String,
) -> impl IntoResponse {
    let Some(block) = todo_methods::render_for_injection(&ctx.state, &q.session_id) else {
        return (StatusCode::OK, String::new());
    };
    // Consume, then serve: a turn that reads the cards has by definition seen
    // Joe's changes to them.
    let _ = todo_methods::mark_todos_seen(&ctx.state, &q.session_id, &q.session_id);
    let payload: Value = json!({
        "hookSpecificOutput": {
            "hookEventName": "UserPromptSubmit",
            "additionalContext": block,
        }
    });
    (StatusCode::OK, payload.to_string())
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

    async fn body_text(resp: axum::response::Response) -> String {
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        String::from_utf8(bytes.to_vec()).unwrap()
    }

    #[tokio::test]
    async fn write_route_reports_an_unknown_session_without_panicking() {
        let body = WriteTodoBody {
            session_id: "ghost".to_string(),
            action: "add".to_string(),
            id: None,
            text: Some("do a thing".to_string()),
            reason: None,
        };
        let resp = on_write_user_todo(AxState(ctx()), ValidatedJson(body)).await.into_response();
        assert_eq!(resp.status(), StatusCode::OK);
        let v: Value = serde_json::from_str(&body_text(resp).await).unwrap();
        assert_eq!(v["ok"], false);
    }

    // Todo 741: an add sent with only `action` + `text` must deserialize, not
    // 4xx on the missing `id`/`reason` keys.
    #[test]
    fn write_todo_body_accepts_an_omitted_id() {
        let body: WriteTodoBody =
            serde_json::from_str(r#"{"session_id":"s","action":"add","text":"t"}"#).unwrap();
        assert_eq!(body.id, None);
        assert_eq!(body.id.unwrap_or_default(), "");
    }

    // The actual bug: `#[serde(default)]` alone lets a MISSING key through but
    // not an explicit `null`, which is what real callers were sending.
    #[test]
    fn write_todo_body_accepts_an_explicit_null_id() {
        let body: WriteTodoBody =
            serde_json::from_str(r#"{"session_id":"s","action":"add","id":null,"text":"t","reason":null}"#)
                .unwrap();
        assert_eq!(body.id, None);
        assert_eq!(body.reason.unwrap_or_default(), "");
    }

    #[test]
    fn write_todo_body_keeps_a_present_id() {
        let body: WriteTodoBody = serde_json::from_str(
            r#"{"session_id":"s","action":"drop","id":"todo-1","reason":"done"}"#,
        )
        .unwrap();
        assert_eq!(body.id.unwrap_or_default(), "todo-1");
        assert_eq!(body.reason.unwrap_or_default(), "done");
    }

    #[tokio::test]
    async fn prompt_submit_injects_nothing_for_an_unknown_session() {
        // The common case by volume: no cards means EMPTY stdout, never a JSON
        // envelope wrapping an empty string.
        let q = PromptSubmitQuery { session_id: "ghost".to_string() };
        let resp = on_prompt_submit(AxState(ctx()), Query(q), String::new()).await.into_response();
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(body_text(resp).await, "", "no cards means no injected bytes");
    }
}
