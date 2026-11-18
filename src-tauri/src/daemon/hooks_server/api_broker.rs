//! `/hooks/api-broker`: the `api_read` and `api_write` MCP tools. The MCP child
//! posts the model's arguments plus its own `session_id` and the tool name; this
//! route looks up the scope the daemon minted for that session at launch
//! (`BrokerSessions::current`) and hands the call to `broker::front::run`.
//!
//! Every answer is a 200 with `ok`: a refusal (a service the chat is not bound to,
//! a policy denial) is expected control flow and names the line to add, so it must
//! not go to `rejected-sends.jsonl` or draw anything in the chat. The route is
//! loopback and `origin_guard`ed like every other hook route, and trusts the
//! session id the MCP child sends the way the rest of them do: a same-user process
//! can post another session's id, the limit `docs/architecture/api-broker.md` states.

use super::validated_json::ValidatedJson;
use super::HookCtx;
use crate::daemon::broker::front::{self, Tool};
use axum::{extract::State as AxState, http::StatusCode, response::IntoResponse, Json};
use serde_json::{json, Value};
use std::sync::Arc;

const NO_SCOPE: &str = "the broker has no scope for this chat: it was not started by this daemon run, or it was closed. Send a new message to start a fresh turn, then retry";

fn refuse(error: &str) -> (StatusCode, Json<Value>) {
    (StatusCode::OK, Json(json!({"ok": false, "error": error})))
}

pub(super) async fn on_api_broker(AxState(ctx): AxState<Arc<HookCtx>>, ValidatedJson(args): ValidatedJson<Value>) -> impl IntoResponse {
    let session_id = args["session_id"].as_str().unwrap_or("").trim().to_string();
    if session_id.is_empty() {
        return refuse("session_id is missing: the broker tools run from a chat");
    }
    let Some(tool) = args["tool"].as_str().and_then(Tool::parse) else {
        return refuse("tool must be api_read or api_write");
    };
    super::mark_mcp_tool_used(&ctx, &session_id);
    let Some(claims) = ctx.state.broker_sessions.current(&session_id) else {
        return refuse(NO_SCOPE);
    };
    let engine = match ctx.state.broker_engine() {
        Ok(e) => e,
        Err(e) => return refuse(&format!("the broker is unavailable: {e}")),
    };
    (StatusCode::OK, Json(front::run(engine, &claims, tool, &args).await))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::broker::front::testing::engine_against;
    use crate::daemon::broker::services::Service;
    use crate::daemon::broker::session::{Role, SessionClaims};
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::daemon::state::DaemonState;
    use crate::types::Settings;

    const FIG: &str = "CANARY-FIG-route-1";

    fn hook_ctx() -> Arc<HookCtx> {
        Arc::new(HookCtx { state: DaemonState::new(new_session_map(), SettingsCache::new(Settings::default())) })
    }

    async fn call(c: &Arc<HookCtx>, v: Value) -> Value {
        let resp = on_api_broker(AxState(c.clone()), ValidatedJson(v)).await.into_response();
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    #[tokio::test]
    async fn a_call_needs_a_session_a_known_tool_and_a_scope_the_daemon_minted() {
        let c = hook_ctx();
        assert!(call(&c, json!({"tool": "api_read"})).await["error"].as_str().unwrap().starts_with("session_id is missing"));
        assert!(call(&c, json!({"session_id": "s", "tool": "api_delete"})).await["error"].as_str().unwrap().contains("api_read or api_write"));
        // No claims for the session: nothing was minted, so nothing is reachable, and no engine is built.
        let r = call(&c, json!({"session_id": "never-launched", "tool": "api_read", "service": "figma", "path": "/v1/me"})).await;
        assert_eq!(r["ok"], json!(false));
        assert!(r["error"].as_str().unwrap().contains("no scope for this chat"), "{r}");
    }

    #[tokio::test]
    async fn a_bound_call_goes_through_and_an_unbound_one_names_the_binding_line() {
        let _data = crate::daemon::subchats::TempDataDir::new();
        let mut server = mockito::Server::new_async().await;
        let dir = tempfile::tempdir().unwrap();
        let c = hook_ctx();
        c.state.install_broker_engine(Arc::new(engine_against(&server.url(), dir.path(), &[("FIGMA_TOKEN", FIG), ("SHORTCUT_API_TOKEN", "CANARY-SC-route")])));
        c.state.broker_sessions.mint(SessionClaims::new("chat-a", Role::Chat, vec![Service::Figma]));
        let ok = server.mock("GET", "/v1/me").match_header("x-figma-token", FIG).with_status(200).with_body(r#"{"id":"u1"}"#).create_async().await;
        let none = server.mock("GET", mockito::Matcher::Regex("^/api/v3".into())).expect(0).create_async().await;

        let r = call(&c, json!({"session_id": "chat-a", "tool": "api_read", "service": "figma", "path": "/v1/me"})).await;
        assert_eq!((r["ok"].clone(), r["status"].clone(), r["body"].clone()), (json!(true), json!(200), json!({"id": "u1"})), "{r}");
        ok.assert_async().await;

        let r = call(&c, json!({"session_id": "chat-a", "tool": "api_read", "service": "shortcut", "path": "/api/v3/member"})).await;
        assert_eq!(r["ok"], json!(false));
        let e = r["error"].as_str().unwrap();
        assert!(e.contains("service_not_bound") && e.contains("\"broker_services\": [\"figma\", \"shortcut\"]"), "{e}");
        none.assert_async().await;
    }

    #[tokio::test]
    async fn a_session_id_in_the_arguments_of_a_closed_chat_reaches_nothing() {
        let _data = crate::daemon::subchats::TempDataDir::new();
        let server = mockito::Server::new_async().await;
        let dir = tempfile::tempdir().unwrap();
        let c = hook_ctx();
        c.state.install_broker_engine(Arc::new(engine_against(&server.url(), dir.path(), &[("FIGMA_TOKEN", FIG)])));
        c.state.broker_sessions.mint(SessionClaims::new("chat-b", Role::Chat, vec![Service::Figma]));
        c.state.broker_sessions.revoke("chat-b");
        let r = call(&c, json!({"session_id": "chat-b", "tool": "api_read", "service": "figma", "path": "/v1/me"})).await;
        assert!(r["error"].as_str().unwrap().contains("no scope for this chat"), "{r}");
    }
}
