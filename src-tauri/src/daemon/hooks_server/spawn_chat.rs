//! `/chat/spawn`: HTTP half of the unconditional `spawn_chat` and `respawn`
//! MCP tools (`respawn` is the same body with `respawn: true`). The
//! claimed `session_id` is untrusted here - `methods::spawn_chat` re-derives
//! the caller's real cwd from the registry and refuses anything else. Outcome
//! rides in the body at `200 OK`, same as `jarvis.rs`'s routes.

use super::validated_json::ValidatedJson;
use super::HookCtx;
use crate::daemon::methods::spawn_chat as spawn_chat_method;
use axum::{extract::State as AxState, http::StatusCode, response::IntoResponse, Json};
use serde::Deserialize;
use serde_json::json;
use std::sync::Arc;

#[derive(Deserialize)]
pub(super) struct SpawnChatBody {
    session_id: String,
    cwd: String,
    prompt: String,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    effort: Option<String>,
    #[serde(default)]
    name: Option<String>,
    /// `respawn` rather than `spawn_chat`: link the new session back to the
    /// caller and close the caller at its turn end.
    #[serde(default)]
    respawn: bool,
}

pub(super) async fn on_spawn_chat(
    AxState(ctx): AxState<Arc<HookCtx>>,
    ValidatedJson(body): ValidatedJson<SpawnChatBody>,
) -> impl IntoResponse {
    // todo 824 remaining 1: reachable only via the MCP `spawn_chat`/`respawn` tools.
    super::mark_mcp_tool_used(&ctx, &body.session_id);
    let result = spawn_chat_method::spawn_chat(
        &ctx.state,
        &body.session_id,
        &body.cwd,
        &body.prompt,
        body.model.as_deref(),
        body.effort.as_deref(),
        body.name.as_deref(),
        body.respawn,
    )
    .await;
    match result {
        Ok(session_id) => (StatusCode::OK, Json(json!({"ok": true, "session_id": session_id}))),
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

    /// The tool is advertised to every session, so the method's registry
    /// lookup is the only thing gating an arbitrary spawn.
    #[tokio::test]
    async fn spawn_chat_rejects_an_unregistered_caller() {
        let body = SpawnChatBody {
            session_id: "ghost".to_string(),
            cwd: ".".to_string(),
            prompt: "carry on".to_string(),
            model: None,
            effort: None,
            name: None,
            respawn: false,
        };
        let resp = on_spawn_chat(AxState(ctx()), ValidatedJson(body)).await.into_response();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        let v: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(v["ok"], false);
        assert!(v["error"].as_str().unwrap().contains("unknown caller session"));
    }
}
