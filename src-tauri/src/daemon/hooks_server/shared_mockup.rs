//! `/hooks/shared-mockup`: the `shared_mockup` MCP tool (`create`, `part`). The
//! route only hands the call to `daemon::preview`; the role checks live there,
//! and every refusal is an `ok:false` naming the fix.

use super::rejected_sends;
use super::validated_json::ValidatedJson;
use super::HookCtx;
use axum::{extract::State as AxState, http::StatusCode, response::IntoResponse, Json};
use serde_json::Value;
use std::sync::Arc;

pub(super) async fn on_shared_mockup(
    AxState(ctx): AxState<Arc<HookCtx>>,
    ValidatedJson(body): ValidatedJson<Value>,
) -> impl IntoResponse {
    let Some(session_id) = body["session_id"].as_str().map(str::to_string) else {
        return rejected_sends::reply("/hooks/shared-mockup", "", "session_id is missing");
    };
    super::mark_mcp_tool_used(&ctx, &session_id);
    let out = crate::daemon::preview::run_shared_mockup(&ctx.state, &session_id, &body);
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

    #[tokio::test]
    async fn a_call_without_a_session_id_is_refused_not_a_decode_error() {
        let ctx = Arc::new(HookCtx { state: DaemonState::new(new_session_map(), SettingsCache::new(Settings::default())) });
        let resp = on_shared_mockup(AxState(ctx), ValidatedJson(json!({"action": "create"}))).await.into_response();
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        let v: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(v["ok"], json!(false));
        assert!(v["error"].as_str().unwrap().contains("session_id"));
    }
}
