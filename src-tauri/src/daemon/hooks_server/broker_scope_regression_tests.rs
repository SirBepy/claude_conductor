//! Step 8 scoped-token regression, through both fronts. The script front proves its caller with the
//! chat's own `CC_BROKER_TOKEN`; the MCP front is a channel of one chat and takes the session from
//! that channel. Both must give a chat exactly the services its launch bound, nothing from another
//! chat, nothing after the chat closed, and nothing to a credential that is not one of ours.

use super::broker_rig::Rig;
use crate::daemon::broker::services::Service;
use crate::daemon::broker::session::{Role, SessionClaims};
use axum::http::StatusCode;
use serde_json::{json, Value};

const SC: &str = "CANARY-sc-scope-1";
const FIG: &str = "CANARY-fig-scope-2";

fn secrets() -> Vec<(&'static str, &'static str)> {
    vec![("SHORTCUT_API_TOKEN", SC), ("FIGMA_TOKEN", FIG)]
}

fn unauthorized((status, v): (StatusCode, Value)) {
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{v}");
    assert_eq!(v["ok"], json!(false));
    assert!(!v.to_string().contains("CANARY"), "{v}");
}

async fn mock_both(r: &mut Rig) -> (mockito::Mock, mockito::Mock) {
    let fig = r.server.mock("GET", "/v1/me").match_header("x-figma-token", FIG).with_status(200).with_body("{}").create_async().await;
    let sc = r.server.mock("GET", "/api/v3/member").match_header("shortcut-token", SC).with_status(200).with_body("{}").create_async().await;
    (fig, sc)
}

#[tokio::test]
async fn the_script_front_gives_a_token_its_own_chats_services_and_nothing_a_neighbour_holds() {
    let mut r = Rig::new(&secrets()).await;
    let (fig, sc) = mock_both(&mut r).await;
    let a = r.token("chat-a", &[Service::Figma]);
    let b = r.token("chat-b", &[Service::Shortcut]);
    let fig_call = json!({"service": "figma", "path": "/v1/me"});
    let sc_call = json!({"service": "shortcut", "path": "/api/v3/member"});

    assert_eq!(r.http_ok(&a, fig_call.clone()).await["ok"], json!(true));
    assert_eq!(r.http_ok(&b, sc_call.clone()).await["ok"], json!(true));
    // chat-a holds no Shortcut binding, whatever session the body names.
    for body in [sc_call.clone(), json!({"service": "shortcut", "path": "/api/v3/member", "session_id": "chat-b"})] {
        let v = r.http_ok(&a, body).await;
        assert!(v["error"].as_str().unwrap().contains("service_not_bound"), "{v}");
    }
    // A token with its service field edited, or another chat's mac spliced on, is not a token.
    let parts: Vec<&str> = a.split('.').collect();
    let widened = [parts[0], parts[1], parts[2], "figma,shortcut", parts[4], parts[5]].join(".");
    unauthorized(r.http(Some(&format!("Bearer {widened}")), sc_call.clone()).await);
    let swapped_session = [parts[0], "chat-b", parts[2], parts[3], parts[4], parts[5]].join(".");
    unauthorized(r.http(Some(&format!("Bearer {swapped_session}")), sc_call.clone()).await);
    let b_parts: Vec<&str> = b.split('.').collect();
    let spliced = [parts[0], parts[1], parts[2], "shortcut", parts[4], b_parts[5]].join(".");
    unauthorized(r.http(Some(&format!("Bearer {spliced}")), sc_call.clone()).await);
    fig.assert_async().await;
    sc.assert_async().await;
    let audit = r.audit();
    assert_eq!(audit.iter().filter(|l| l["session"] == json!("chat-b")).count(), 1, "chat-b made one call");
    assert!(audit.iter().filter(|l| l["outcome"] == json!("denied_scope")).all(|l| l["session"] == json!("chat-a")));
    r.assert_no_leak(&[SC, FIG], &[]);
}

#[tokio::test]
async fn the_script_front_rejects_a_closed_chats_token_a_superseded_token_and_the_daemons_own_token_file() {
    let mut r = Rig::new(&secrets()).await;
    let (fig, sc) = mock_both(&mut r).await;
    let call = json!({"service": "figma", "path": "/v1/me"});

    // The daemon's own credential (what `remote-access-token.txt` holds) is not a session token.
    let file_text = "DAEMON-FILE-CANARY-0123456789abcdef0123456789abcdef";
    std::fs::write(r.data.join("remote-access-token.txt"), file_text).unwrap();
    let from_file = std::fs::read_to_string(r.data.join("remote-access-token.txt")).unwrap();
    unauthorized(r.http(Some(&format!("Bearer {from_file}")), call.clone()).await);
    unauthorized(r.http(Some("Bearer chat-a"), call.clone()).await);

    // A rebind supersedes the old token; the old one stops working, the new one works.
    let old = r.token("chat-a", &[Service::Figma]);
    assert_eq!(r.http_ok(&old, call.clone()).await["ok"], json!(true));
    let new = r.token("chat-a", &[Service::Figma, Service::Shortcut]);
    assert_ne!(old, new);
    unauthorized(r.http(Some(&format!("Bearer {old}")), call.clone()).await);
    assert_eq!(r.http_ok(&new, call.clone()).await["ok"], json!(true));

    // The chat closes: its token is dead, and so is the same text after a resume mints a new one.
    r.ctx.state.broker_sessions.revoke("chat-a");
    unauthorized(r.http(Some(&format!("Bearer {new}")), call.clone()).await);
    let resumed = r.token("chat-a", &[Service::Figma, Service::Shortcut]);
    assert_ne!(resumed, new, "a resume is a new epoch");
    unauthorized(r.http(Some(&format!("Bearer {new}")), call.clone()).await);
    assert_eq!(r.http_ok(&resumed, call.clone()).await["ok"], json!(true));
    fig.expect_at_least(3).assert_async().await;
    sc.expect(0).assert_async().await;
}

#[tokio::test]
async fn the_mcp_front_takes_the_session_from_its_channel_and_scopes_it_to_that_chats_launch() {
    let mut r = Rig::new(&secrets()).await;
    let (fig, sc) = mock_both(&mut r).await;
    // chat-b has Shortcut; chat-a, the channel making these calls, does not.
    r.token("chat-a", &[Service::Figma]);
    r.token("chat-b", &[Service::Shortcut, Service::Figma]);

    let v = r.mcp("chat-a", "api_read", json!({"service": "figma", "path": "/v1/me"})).await;
    assert_eq!(v["ok"], json!(true), "{v}");
    // The model writes another chat's id into its arguments: the channel's own id wins.
    let v = r.mcp("chat-a", "api_read", json!({"service": "shortcut", "path": "/api/v3/member", "session_id": "chat-b"})).await;
    assert!(v["error"].as_str().unwrap().contains("service_not_bound"), "{v}");
    assert!(v["error"].as_str().unwrap().contains("\"broker_services\": [\"figma\", \"shortcut\"]"), "the refusal names the line to add: {v}");
    assert!(r.ctx.state.list_prompts().await.is_empty(), "a scope refusal raises no card");
    assert!(r.audit().iter().all(|l| l["session"] == json!("chat-a")), "the audit names the channel's chat");

    // A chat the daemon never launched, and a chat that closed, have no scope at all.
    for session in ["never-launched", "chat-b"] {
        if session == "chat-b" {
            r.ctx.state.broker_sessions.revoke("chat-b");
        }
        let v = r.mcp(session, "api_read", json!({"service": "shortcut", "path": "/api/v3/member"})).await;
        assert!(v["error"].as_str().unwrap().contains("no scope for this chat"), "{session}: {v}");
    }
    // A later launch with a narrower set replaces the claims the front reads.
    r.token("chat-a", &[]);
    let v = r.mcp("chat-a", "api_read", json!({"service": "figma", "path": "/v1/me"})).await;
    assert!(v["error"].as_str().unwrap().contains("service_not_bound"), "{v}");
    fig.expect(1).assert_async().await;
    sc.expect(0).assert_async().await;
    r.assert_no_leak(&[SC, FIG], &[]);
}

#[tokio::test]
async fn a_hidden_sub_holds_its_parents_set_on_both_fronts_and_no_more() {
    let mut r = Rig::new(&secrets()).await;
    let (fig, sc) = mock_both(&mut r).await;
    // The parent was launched with Figma only; the sub's claims are a copy of that (`binding.rs`).
    let parent = SessionClaims::new("main-1", Role::Chat, vec![Service::Figma]);
    r.ctx.state.broker_sessions.mint(parent.clone());
    let sub_token = r.ctx.state.broker_sessions.mint(SessionClaims::new("sub-1", Role::Sub, parent.services.clone())).expose().to_string();
    let v = r.mcp("sub-1", "api_read", json!({"service": "figma", "path": "/v1/me"})).await;
    assert_eq!(v["ok"], json!(true), "{v}");
    let v = r.mcp("sub-1", "api_read", json!({"service": "shortcut", "path": "/api/v3/member"})).await;
    assert!(v["error"].as_str().unwrap().contains("service_not_bound"), "{v}");
    let v = r.http_ok(&sub_token, json!({"service": "shortcut", "path": "/api/v3/member"})).await;
    assert!(v["error"].as_str().unwrap().contains("service_not_bound"), "{v}");
    let v = r.http_ok(&sub_token, json!({"service": "figma", "path": "/v1/me"})).await;
    assert_eq!(v["ok"], json!(true), "{v}");
    // A sub's token does not open its parent's channel and the other way round.
    let parent_token = r.token("main-1", &[Service::Figma, Service::Shortcut]);
    let forged = parent_token.replacen("main-1", "sub-1", 1);
    unauthorized(r.http(Some(&format!("Bearer {forged}")), json!({"service": "shortcut", "path": "/api/v3/member"})).await);
    fig.expect(2).assert_async().await;
    sc.expect(0).assert_async().await;
}
