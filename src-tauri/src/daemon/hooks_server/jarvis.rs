//! Jarvis fleet-orchestration hooks routes (todo 272, chunk 2b). The MCP
//! `cc_conductor` tools `spawn_worker` / `send_to_session` / `fleet_status` /
//! `respond_worker_prompt` POST here - those tools only ever appear in a
//! Jarvis child's `tools/list` (see `mcp::server::tool_list_response`'s
//! `CC_JARVIS` gate and `daemon::claude_config::write_mcp_config`), but a
//! `tools/call` for a tool name the model was never shown can still reach
//! this HTTP layer, so every handler below hands the claimed
//! `jarvis_session_id` straight to `daemon::methods::jarvis`, which
//! independently re-validates it against the registry's `jarvis` flag before
//! touching any state.
//!
//! Unlike `permission.rs`'s relay endpoints, none of these block on a
//! oneshot: `spawn_worker`/`send_to_session`/`respond_worker_prompt` all
//! complete synchronously (a session spawn or a stdin write), and
//! `fleet_status` is a plain read. All responses are `200 OK` with the
//! success/error shape in the JSON body - the MCP layer forwards that body to
//! the model as a tool result either way (see `mcp::server::TOOL_SPAWN_WORKER`
//! et al.), so the HTTP status carries no meaning to it beyond "the request
//! reached the daemon".

use super::validated_json::ValidatedJson;
use super::HookCtx;
use crate::daemon::methods::jarvis as jarvis_methods;
use axum::{extract::State as AxState, http::StatusCode, response::IntoResponse, Json};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

#[derive(Deserialize)]
pub(super) struct SpawnWorkerBody {
    jarvis_session_id: String,
    cwd: String,
    task: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    model: Option<String>,
    /// Explicit account request (todo 272 "Fleet account allocation"). Omit
    /// to let `spawn_worker` auto-pick from the fleet-eligible pool; if
    /// given, validated against that same pool before spawning.
    #[serde(default)]
    account: Option<String>,
}

pub(super) async fn on_spawn_worker(
    AxState(ctx): AxState<Arc<HookCtx>>,
    ValidatedJson(body): ValidatedJson<SpawnWorkerBody>,
) -> impl IntoResponse {
    // todo 824 remaining 1: reachable only via the MCP `spawn_worker` tool.
    super::mark_mcp_tool_used(&ctx, &body.jarvis_session_id);
    let result = jarvis_methods::spawn_worker(
        &ctx.state,
        &body.jarvis_session_id,
        &body.cwd,
        &body.task,
        body.name.as_deref(),
        body.model.as_deref(),
        body.account.as_deref(),
    )
    .await;
    match result {
        Ok(session_id) => (StatusCode::OK, Json(json!({"ok": true, "session_id": session_id}))),
        Err(e) => (StatusCode::OK, Json(json!({"ok": false, "error": e}))),
    }
}

#[derive(Deserialize)]
pub(super) struct SendToSessionBody {
    jarvis_session_id: String,
    session_id: String,
    text: String,
}

pub(super) async fn on_send_to_session(
    AxState(ctx): AxState<Arc<HookCtx>>,
    ValidatedJson(body): ValidatedJson<SendToSessionBody>,
) -> impl IntoResponse {
    // todo 824 remaining 1: reachable only via the MCP `send_to_session` tool.
    super::mark_mcp_tool_used(&ctx, &body.jarvis_session_id);
    let result = jarvis_methods::send_to_session(
        &ctx.state,
        &body.jarvis_session_id,
        &body.session_id,
        &body.text,
    )
    .await;
    match result {
        Ok(()) => (StatusCode::OK, Json(json!({"ok": true}))),
        Err(e) => (StatusCode::OK, Json(json!({"ok": false, "error": e}))),
    }
}

#[derive(Deserialize)]
pub(super) struct FleetStatusBody {
    jarvis_session_id: String,
}

pub(super) async fn on_fleet_status(
    AxState(ctx): AxState<Arc<HookCtx>>,
    ValidatedJson(body): ValidatedJson<FleetStatusBody>,
) -> impl IntoResponse {
    // todo 824 remaining 1: reachable only via the MCP `fleet_status` tool.
    super::mark_mcp_tool_used(&ctx, &body.jarvis_session_id);
    let result = jarvis_methods::fleet_status(&ctx.state, &body.jarvis_session_id).await;
    match result {
        Ok(v) => (StatusCode::OK, Json(v)),
        Err(e) => (StatusCode::OK, Json(json!({"ok": false, "error": e}))),
    }
}

#[derive(Deserialize)]
pub(super) struct RespondWorkerPromptBody {
    jarvis_session_id: String,
    request_id: String,
    allow: bool,
    #[serde(default)]
    message: Option<String>,
    #[serde(default)]
    updated_input: Option<Value>,
}

pub(super) async fn on_respond_worker_prompt(
    AxState(ctx): AxState<Arc<HookCtx>>,
    ValidatedJson(body): ValidatedJson<RespondWorkerPromptBody>,
) -> impl IntoResponse {
    // todo 824 remaining 1: reachable only via the MCP `respond_worker_prompt` tool.
    super::mark_mcp_tool_used(&ctx, &body.jarvis_session_id);
    let result = jarvis_methods::respond_worker_prompt(
        &ctx.state,
        &body.jarvis_session_id,
        &body.request_id,
        body.allow,
        body.message,
        body.updated_input,
    )
    .await;
    match result {
        Ok(delivered) => (StatusCode::OK, Json(json!({"ok": true, "delivered": delivered}))),
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

    async fn body_json(resp: axum::response::Response) -> Value {
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    /// Defense-in-depth regression: a `tools/call` naming `spawn_worker` with a
    /// `jarvis_session_id` the registry doesn't recognise as Jarvis (or
    /// doesn't recognise at all) must be rejected here, independent of
    /// whether the MCP layer's `CC_JARVIS` env gate ever let the tool show up
    /// in `tools/list` for that caller.
    #[tokio::test]
    async fn spawn_worker_rejects_non_jarvis_caller() {
        let body = SpawnWorkerBody {
            jarvis_session_id: "not-jarvis".to_string(),
            cwd: ".".to_string(),
            task: "do the thing".to_string(),
            name: None,
            model: None,
            account: None,
        };
        let resp = on_spawn_worker(AxState(ctx()), ValidatedJson(body)).await.into_response();
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        assert_eq!(v["ok"], false);
        assert!(v["error"].as_str().unwrap().contains("not the Jarvis session"));
    }

    #[tokio::test]
    async fn fleet_status_rejects_non_jarvis_caller() {
        let body = FleetStatusBody { jarvis_session_id: "not-jarvis".to_string() };
        let resp = on_fleet_status(AxState(ctx()), ValidatedJson(body)).await.into_response();
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        assert_eq!(v["ok"], false);
    }
}
