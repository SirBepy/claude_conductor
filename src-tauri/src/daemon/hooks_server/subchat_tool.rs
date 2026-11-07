//! `/subchats/tool`: the `subchat` MCP tool (`list`, `status`, `log`, `send`).
//! The route only hands the call to `daemon::subchats::tool`; every refusal is
//! an `ok:false` naming the fix, because the model reads it as the tool result
//! and retries, and a malformed body must never reach it as a decode error.

use super::rejected_sends;
use super::validated_json::ValidatedJson;
use super::HookCtx;
use axum::{extract::State as AxState, http::StatusCode, response::IntoResponse, Json};
use serde_json::Value;
use std::sync::Arc;

pub(super) async fn on_subchat(
    AxState(ctx): AxState<Arc<HookCtx>>,
    ValidatedJson(body): ValidatedJson<Value>,
) -> impl IntoResponse {
    let Some(session_id) = body["session_id"].as_str().map(str::to_string) else {
        return rejected_sends::reply("/subchats/tool", "", "session_id is missing");
    };
    // The call arriving at all proves the MCP transport is up this turn.
    super::mark_mcp_tool_used(&ctx, &session_id);
    let out = crate::daemon::subchats::tool::run(&ctx.state, &session_id, &body).await;
    (StatusCode::OK, Json(out))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::daemon::state::DaemonState;
    use crate::types::Settings;

    fn ctx() -> Arc<HookCtx> {
        Arc::new(HookCtx { state: DaemonState::new(new_session_map(), SettingsCache::new(Settings::default())) })
    }

    async fn call(ctx: &Arc<HookCtx>, body: Value) -> Value {
        let resp = on_subchat(AxState(ctx.clone()), ValidatedJson(body)).await.into_response();
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    #[tokio::test]
    async fn a_call_without_a_session_id_is_refused_not_a_decode_error() {
        let v = call(&ctx(), json!({"action": "list"})).await;
        assert_eq!(v["ok"], json!(false));
        assert!(v["error"].as_str().unwrap().contains("session_id"));
    }

    #[tokio::test]
    async fn the_route_lists_a_main_chats_subs_and_refuses_a_chat_with_none() {
        let _d = crate::daemon::subchats::TempDataDir::new();
        let c = ctx();
        for id in ["rt-main", "rt-sub"] {
            c.state.registry.upsert_interactive(id, std::path::Path::new("."), "proj", "2026-11-05T00:00:00Z");
        }
        let none = call(&c, json!({"session_id": "rt-main", "action": "list", "sub": null, "text": null})).await;
        assert_eq!(none["ok"], json!(false), "an explicit null for an unused field must not break the call");
        c.state.registry.set_subchat_of("rt-sub", Some("rt-main".into()));
        let v = call(&c, json!({"session_id": "rt-main", "action": "list"})).await;
        assert_eq!(v["ok"], json!(true));
        assert_eq!(v["subs"].as_array().unwrap().len(), 1);
    }
}
