//! `browser_*` hook route: every Playwright MCP tool a chat calls lands here
//! and runs against Claude's own browser (`daemon::browser`). Re-checks the
//! Settings switch on every call, because a chat spawned while it was on keeps
//! the tools listed after Joe turns it off.

use super::validated_json::ValidatedJson;
use super::HookCtx;
use axum::{extract::State as AxState, http::StatusCode, response::IntoResponse, Json};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

pub(super) const DISABLED: &str = "Claude's browser is turned off in Settings > Chat defaults.";

#[derive(Deserialize)]
pub(super) struct BrowserCallBody {
    session_id: String,
    name: String,
    #[serde(default)]
    arguments: Value,
}

pub(super) async fn on_browser_call(
    AxState(ctx): AxState<Arc<HookCtx>>,
    ValidatedJson(body): ValidatedJson<BrowserCallBody>,
) -> impl IntoResponse {
    if !body.session_id.is_empty() {
        super::mark_mcp_tool_used(&ctx, &body.session_id);
    }
    if !ctx.state.settings.snapshot().claude_browser_enabled() {
        return (StatusCode::OK, Json(json!({"ok": false, "error": DISABLED})));
    }
    let args = if body.arguments.is_null() { json!({}) } else { body.arguments };
    match crate::daemon::browser::get().call(&body.session_id, &body.name, args).await {
        Ok(result) => (StatusCode::OK, Json(json!({"ok": true, "result": result}))),
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

    /// Default settings have the switch off, so the call is refused before
    /// any Chrome or node process could start.
    #[tokio::test]
    async fn a_call_with_the_switch_off_is_refused() {
        let ctx = Arc::new(HookCtx {
            state: DaemonState::new(new_session_map(), SettingsCache::new(Settings::default())),
        });
        let body = BrowserCallBody {
            session_id: "s1".into(),
            name: "browser_navigate".into(),
            arguments: json!({"url": "https://example.com"}),
        };
        let resp = on_browser_call(AxState(ctx), ValidatedJson(body)).await.into_response();
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        let v: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(v["ok"], json!(false));
        assert_eq!(v["error"], json!(DISABLED));
    }
}
