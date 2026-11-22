//! `/subchats/run-plan`: the `run_plan` MCP tool. The route only hands the call to
//! `daemon::subchats::run`; every refusal is an `ok:false` naming the fix, because
//! the model reads it as the tool result and retries, and a malformed body must
//! never reach it as a decode error.

use super::rejected_sends;
use super::validated_json::ValidatedJson;
use super::HookCtx;
use axum::{extract::State as AxState, http::StatusCode, response::IntoResponse, Json};
use serde_json::Value;
use std::sync::Arc;

pub(super) async fn on_run_plan(
    AxState(ctx): AxState<Arc<HookCtx>>,
    ValidatedJson(body): ValidatedJson<Value>,
) -> impl IntoResponse {
    let Some(session_id) = body["session_id"].as_str().map(str::to_string) else {
        return rejected_sends::reply("/subchats/run-plan", "", "session_id is missing");
    };
    // The call arriving at all proves the MCP transport is up this turn.
    super::mark_mcp_tool_used(&ctx, &session_id);
    // Detached: hyper drops a handler whose client socket closed, and a create dropped
    // between two lane spawns would leave lanes running that no plan file records.
    let state = ctx.state.clone();
    let caller = session_id.clone();
    let out = match tokio::spawn(async move { crate::daemon::subchats::run::run(&state, &session_id, &body).await }).await {
        Ok(out) => out,
        Err(e) => serde_json::json!({"ok": false, "error": format!("run_plan stopped unexpectedly ({e}). Read the lanes with subchat list.")}),
    };
    // Every refusal is a handler error (bad arguments, a chat the tool is not for), so
    // the release report sees it like the other relay routes' `ok:false` replies.
    if out["ok"] == serde_json::json!(false) {
        rejected_sends::record("/subchats/run-plan", &caller, None, out["error"].as_str().unwrap_or("refused"));
    }
    (StatusCode::OK, Json(out))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::daemon::state::DaemonState;
    use crate::types::Settings;
    use serde_json::json;

    fn ctx() -> Arc<HookCtx> {
        Arc::new(HookCtx { state: DaemonState::new(new_session_map(), SettingsCache::new(Settings::default())) })
    }

    async fn call(ctx: &Arc<HookCtx>, body: Value) -> Value {
        let resp = on_run_plan(AxState(ctx.clone()), ValidatedJson(body)).await.into_response();
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    #[tokio::test]
    async fn a_call_without_a_session_id_is_refused_not_a_decode_error() {
        let v = call(&ctx(), json!({"action": "status"})).await;
        assert_eq!(v["ok"], json!(false));
        assert!(v["error"].as_str().unwrap().contains("session_id"));
    }

    /// The real route, end to end up to the daemon: a chat with the mode off is
    /// told the fix, and an unknown action on a mode-on chat is named, not a decode error.
    #[tokio::test]
    async fn the_route_refuses_a_chat_without_the_mode_and_names_a_bad_action() {
        let _d = crate::daemon::subchats::TempDataDir::new();
        let c = ctx();
        c.state.registry.upsert_interactive("rp-route", std::path::Path::new("."), "proj", "2026-11-21T00:00:00Z");
        let off = call(&c, json!({"session_id": "rp-route", "action": "status", "steps": null, "title": null})).await;
        assert_eq!(off["ok"], json!(false), "an explicit null for an unused field must not break the call");
        assert!(off["error"].as_str().unwrap().contains("Use subchats"), "{off}");
        crate::sessions::chat_config::set_subchats_on("rp-route", true);
        let bad = call(&c, json!({"session_id": "rp-route", "action": "wipe"})).await;
        assert!(bad["error"].as_str().unwrap().contains("not one of create, status"), "{bad}");
        let none = call(&c, json!({"session_id": "rp-route", "action": "status"})).await;
        assert!(none["error"].as_str().unwrap().contains("no run plan yet"), "{none}");
    }
}
