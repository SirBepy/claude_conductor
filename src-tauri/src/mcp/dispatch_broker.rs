//! `api_read` and `api_write`'s arm. Both go to one daemon route, which holds the
//! scope check; the arm only says which tool was called and whose session it is.

use serde_json::{json, Value};

use super::dispatch::forward_all_args;
use super::relay::Ctx;
use super::tool_schemas_broker::{TOOL_API_CARD, TOOL_API_READ, TOOL_API_WRITE};

pub(super) fn broker_tools(ctx: &Ctx, name: &str) -> Option<Value> {
    if name == TOOL_API_CARD {
        // Same channel rule as below: the route reads the session from the MCP child, never the body.
        let body = forward_all_args(ctx.args, ctx.session_id);
        return Some(ctx.relay("/hooks/api-broker-card", body, Some("api card refused"), None));
    }
    if name != TOOL_API_READ && name != TOOL_API_WRITE {
        return None;
    }
    // `forward_all_args` overwrites any `session_id` the model put in its arguments
    // with this MCP child's own, and `tool` is set after it, so neither can be
    // chosen by the caller: the route trusts the channel, not the body.
    let mut body = forward_all_args(ctx.args, ctx.session_id);
    body["tool"] = json!(name);
    Some(ctx.relay("/hooks/api-broker", body, Some("api broker call refused"), None))
}

#[cfg(test)]
mod tests {
    use super::super::dispatch::dispatch_tool_with;
    use super::super::relay::HttpPost;
    use super::*;
    use std::cell::RefCell;
    use std::sync::Arc;

    thread_local! {
        static SEEN: RefCell<Vec<(String, Value)>> = const { RefCell::new(Vec::new()) };
    }

    fn fake_post(_rt: &tokio::runtime::Runtime, url: &str, body: Value) -> Result<Value, String> {
        SEEN.with(|s| s.borrow_mut().push((url.to_string(), body)));
        Ok(json!({"ok": true, "status": 200, "body": {}}))
    }

    fn call(name: &str, args: Value, post: HttpPost) -> Value {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        dispatch_tool_with(&rt, &json!(1), name, &args, "chat-real", 4321, post)
    }

    #[test]
    fn both_tools_relay_to_the_one_route_with_the_channels_own_session_and_the_tool_name() {
        for (name, other) in [(TOOL_API_READ, TOOL_API_WRITE), (TOOL_API_WRITE, TOOL_API_READ)] {
            SEEN.with(|s| s.borrow_mut().clear());
            // The model writes a session_id and a tool of its own: neither survives.
            let r = call(name, json!({"service": "figma", "path": "/v1/me", "session_id": "someone-else", "tool": other}), fake_post);
            assert_ne!(r["result"]["isError"], json!(true), "{r}");
            let (url, body) = SEEN.with(|s| s.borrow()[0].clone());
            assert_eq!(url, "http://127.0.0.1:4321/hooks/api-broker");
            assert_eq!(body["session_id"], json!("chat-real"));
            assert_eq!(body["tool"], json!(name));
            assert_eq!(body["service"], json!("figma"));
            assert_eq!(body["path"], json!("/v1/me"));
        }
    }

    #[test]
    fn the_card_tool_relays_to_its_own_route_with_the_channels_session() {
        SEEN.with(|s| s.borrow_mut().clear());
        // A token in the arguments is never forwarded as anything the card could show or store:
        // the schema has no such field, and the session is the channel's, not the model's.
        let r = call(TOOL_API_CARD, json!({"kind": "replace", "name": "FIGMA_TOKEN", "session_id": "someone-else"}), fake_post);
        assert_ne!(r["result"]["isError"], json!(true), "{r}");
        let (url, body) = SEEN.with(|s| s.borrow()[0].clone());
        assert_eq!(url, "http://127.0.0.1:4321/hooks/api-broker-card");
        assert_eq!((body["session_id"].clone(), body["kind"].clone(), body["name"].clone()), (json!("chat-real"), json!("replace"), json!("FIGMA_TOKEN")));
    }

    const FIG: &str = "CANARY-FIG-e2e-1";
    const TR_KEY: &str = "CANARY-TRKEY-e2e-2";
    const TR_TOK: &str = "CANARY-TRTOK-e2e-3";

    /// One MCP `tools/call` over the real transport (`relay::http_post`) to the live hooks
    /// server, from a plain thread because the relay builds its own runtime.
    async fn mcp_call(port: u16, session: &str, name: &str, args: Value) -> Value {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let (session, name) = (session.to_string(), name.to_string());
        std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
            let _ = tx.send(dispatch_tool_with(&rt, &json!(1), &name, &args, &session, port, super::super::relay::http_post));
        });
        rx.await.unwrap()
    }

    fn text_of(r: &Value) -> String {
        r["result"]["content"][0]["text"].as_str().unwrap_or_default().to_string()
    }

    /// The whole path a chat takes: the MCP dispatch, the real relay, the real hooks server,
    /// the session's minted scope, the engine with the real (seeded) policy and a mock service.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_scoped_call_through_the_mcp_path_reaches_the_mock_and_no_result_shows_a_secret() {
        use crate::daemon::broker::front::testing::engine_against;
        use crate::daemon::broker::services::Service;
        use crate::daemon::broker::session::{Role, SessionClaims};
        use crate::daemon::session::new_session_map;
        use crate::daemon::settings_cache::SettingsCache;
        use crate::daemon::state::DaemonState;

        let _data = crate::daemon::subchats::TempDataDir::new();
        let mut server = mockito::Server::new_async().await;
        let dir = tempfile::tempdir().unwrap();
        let state = DaemonState::new(new_session_map(), SettingsCache::new(crate::types::Settings::default()));
        state.install_broker_engine(Arc::new(engine_against(
            &server.url(),
            dir.path(),
            &[("FIGMA_TOKEN", FIG), ("TRELLO_API_KEY", TR_KEY), ("TRELLO_TOKEN", TR_TOK), ("SHORTCUT_API_TOKEN", "CANARY-SC-e2e-4")],
        )));
        state.broker_sessions.mint(SessionClaims::new("chat-e2e", Role::Chat, vec![Service::Figma, Service::Trello]));
        let port = crate::daemon::hooks_server::spawn(state.clone()).await.expect("hooks server binds an ephemeral port in a test");

        // A read: the service echoes the token in its body and in a header.
        let fig = server
            .mock("GET", "/v1/files/abc")
            .match_header("x-figma-token", FIG)
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_header("location", FIG)
            .with_body(format!(r#"{{"name":"file","echo":"{FIG}"}}"#))
            .create_async()
            .await;
        // The model also writes a session id of its own: the channel's wins.
        let r = mcp_call(port, "chat-e2e", "api_read", json!({"service": "figma", "path": "/v1/files/abc", "session_id": "someone-else"})).await;
        assert_ne!(r["result"]["isError"], json!(true), "{r}");
        let v: Value = serde_json::from_str(&text_of(&r)).unwrap();
        assert_eq!((v["ok"].clone(), v["status"].clone()), (json!(true), json!(200)), "{v}");
        assert!(v["body"].as_str().unwrap().contains("\"name\":\"file\""), "{v}");
        assert!(!text_of(&r).contains(FIG), "the token must not reach the model: {r}");
        fig.assert_async().await;

        // A write the seed allows (Trello, no owner check); the mock echoes both secrets.
        let card = server
            .mock("POST", mockito::Matcher::Regex("^/1/cards".into()))
            .with_status(200)
            .with_body(format!(r#"{{"id":"c1","k":"{TR_KEY}","t":"{TR_TOK}"}}"#))
            .create_async()
            .await;
        let r = mcp_call(port, "chat-e2e", "api_write", json!({"service": "trello", "method": "POST", "path": "/1/cards", "body": {"name": "x", "idList": "0123456789abcdef01234567"}})).await;
        assert_ne!(r["result"]["isError"], json!(true), "{r}");
        let text = text_of(&r);
        let v: Value = serde_json::from_str(&text).unwrap();
        assert!(v["body"].as_str().unwrap().contains("\"c1\""), "{text}");
        assert!(!text.contains(TR_KEY) && !text.contains(TR_TOK), "{text}");
        card.assert_async().await;

        // api_read never sends a write, whatever the policy says.
        let r = mcp_call(port, "chat-e2e", "api_read", json!({"service": "trello", "method": "POST", "path": "/1/cards"})).await;
        assert_eq!(r["result"]["isError"], json!(true));
        assert!(text_of(&r).contains("api_write"), "{r}");

        // api_write is for writes: a GET sent there is sent back to api_read.
        let r = mcp_call(port, "chat-e2e", "api_write", json!({"service": "figma", "method": "GET", "path": "/v1/me"})).await;
        assert_eq!(r["result"]["isError"], json!(true));
        assert!(text_of(&r).contains("api_read"), "{r}");

        // A write no row allows is denied with the exact row to add, and nothing is sent.
        let never = server.mock("POST", mockito::Matcher::Regex("^/v1/files".into())).expect(0).create_async().await;
        let r = mcp_call(port, "chat-e2e", "api_write", json!({"service": "figma", "method": "POST", "path": "/v1/files/abc/comments", "body": {"message": "hi"}})).await;
        assert_eq!(r["result"]["isError"], json!(true));
        let text = text_of(&r);
        assert!(text.contains("policy_denied") && text.contains("broker-policy.json") && text.contains(r#""service":"figma""#) && text.contains(r#""method":"POST""#), "{text}");
        never.assert_async().await;

        // A service this chat is not bound to names the binding line, and no secret was read for it.
        let r = mcp_call(port, "chat-e2e", "api_read", json!({"service": "shortcut", "path": "/api/v3/member"})).await;
        assert_eq!(r["result"]["isError"], json!(true));
        assert!(text_of(&r).contains("\"broker_services\": [\"figma\", \"shortcut\", \"trello\"]"), "{r}");

        // A chat the daemon never launched has no scope, even with a real session id's spelling.
        let r = mcp_call(port, "someone-else", "api_read", json!({"service": "figma", "path": "/v1/me"})).await;
        assert_eq!(r["result"]["isError"], json!(true));
        assert!(text_of(&r).contains("no scope for this chat"), "{r}");

        // Every call is audited under the channel's session, and no secret is in the log.
        let audit = std::fs::read_to_string(dir.path().join("broker-audit.jsonl")).unwrap();
        assert!(audit.lines().count() >= 4, "{audit}");
        for line in audit.lines() {
            let l: Value = serde_json::from_str(line).unwrap();
            assert_eq!(l["session"], json!("chat-e2e"), "{line}");
        }
        for secret in [FIG, TR_KEY, TR_TOK] {
            assert!(!audit.contains(secret), "audit log holds a secret");
        }
    }

    #[test]
    fn a_refusal_reaches_the_chat_as_an_error_carrying_the_daemons_text() {
        fn refusing(_: &tokio::runtime::Runtime, _: &str, _: Value) -> Result<Value, String> {
            Ok(json!({"ok": false, "error": "service_not_bound: shortcut is not bound. to allow it, add this line"}))
        }
        let r = call(TOOL_API_READ, json!({"service": "shortcut", "path": "/api/v3/member"}), refusing);
        assert_eq!(r["result"]["isError"], json!(true));
        assert!(r["result"]["content"][0]["text"].as_str().unwrap().contains("add this line"), "{r}");
    }
}
