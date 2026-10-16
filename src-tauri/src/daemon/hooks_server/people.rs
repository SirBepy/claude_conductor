//! The `find_person` and `remember_person` MCP tools' HTTP routes. The
//! per-turn people block rides `user_todos::on_prompt_submit`, which owns the
//! one `UserPromptSubmit` hook every rider shares.

use super::validated_json::ValidatedJson;
use super::HookCtx;
use crate::daemon::methods::people as people_methods;
use axum::{extract::State as AxState, http::StatusCode, response::IntoResponse, Json};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

#[derive(Deserialize)]
pub(super) struct FindPersonBody {
    session_id: String,
    #[serde(default)]
    text: String,
}

pub(super) async fn on_find_person(
    AxState(ctx): AxState<Arc<HookCtx>>,
    ValidatedJson(body): ValidatedJson<FindPersonBody>,
) -> impl IntoResponse {
    super::mark_mcp_tool_used(&ctx, &body.session_id);
    match people_methods::find_person(&ctx.state, &body.session_id, &body.text) {
        Ok(v) => (StatusCode::OK, Json(v)),
        Err(e) => (StatusCode::OK, Json(json!({"ok": false, "error": e}))),
    }
}

/// Everything past `session_id` is forwarded as one object, same as
/// `drafts::WriteDraftBody`: the create and update shapes share no fields.
#[derive(Deserialize)]
pub(super) struct RememberPersonBody {
    session_id: String,
    #[serde(flatten)]
    rest: Value,
}

pub(super) async fn on_remember_person(
    AxState(ctx): AxState<Arc<HookCtx>>,
    ValidatedJson(body): ValidatedJson<RememberPersonBody>,
) -> impl IntoResponse {
    super::mark_mcp_tool_used(&ctx, &body.session_id);
    match people_methods::remember_person(&ctx.state, &body.session_id, &body.rest) {
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

    async fn json_of(resp: axum::response::Response) -> Value {
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    #[tokio::test]
    async fn both_routes_report_an_unknown_session_without_panicking() {
        let find: FindPersonBody = serde_json::from_value(json!({"session_id": "ghost", "text": "Stevan"})).unwrap();
        let v = json_of(on_find_person(AxState(ctx()), ValidatedJson(find)).await.into_response()).await;
        assert_eq!(v["ok"], false);
        let remember: RememberPersonBody =
            serde_json::from_value(json!({"session_id": "ghost", "person": "Stevan", "alias": "Stef"})).unwrap();
        assert_eq!(remember.rest["alias"], "Stef");
        let v = json_of(on_remember_person(AxState(ctx()), ValidatedJson(remember)).await.into_response()).await;
        assert_eq!(v["ok"], false);
    }
}
