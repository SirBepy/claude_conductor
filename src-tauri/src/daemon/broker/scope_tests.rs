//! Scope tests: a chat reaches the engine only through its own token, and only
//! for the services its project binds. Secrets here are made-up canaries.

use super::audit::AuditLog;
use super::engine::{BrokerRequest, Engine};
use super::guards::Limits;
use super::policy::{Policy, PolicyDecision, PolicyRequest};
use super::services::{Service, ServiceTable};
use super::session::{BrokerSessions, Role, SessionClaims, TokenError};
use super::store::testing::MemSecrets;
use serde_json::Value;
use std::path::PathBuf;
use std::sync::Arc;

const FIG: &str = "CANARY-FIG-scope-1";
const SC: &str = "CANARY-SC-scope-2";

struct AllowAll;

impl Policy for AllowAll {
    fn decide(&self, _: &PolicyRequest<'_>) -> PolicyDecision {
        PolicyDecision::Allow { require_owner: false }
    }
}

struct H {
    server: mockito::ServerGuard,
    engine: Engine,
    secrets: Arc<MemSecrets>,
    audit_path: PathBuf,
    sessions: BrokerSessions,
    _dir: tempfile::TempDir,
}

async fn harness() -> H {
    let server = mockito::Server::new_async().await;
    let mut table = ServiceTable::production();
    for s in Service::ALL {
        table = table.with_base_url(s, &server.url());
    }
    let dir = tempfile::tempdir().unwrap();
    let audit_path = dir.path().join("audit.jsonl");
    let secrets = Arc::new(MemSecrets::with(&[("FIGMA_TOKEN", FIG), ("SHORTCUT_API_TOKEN", SC)]));
    let client = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).no_proxy().build().unwrap();
    let engine = Engine::with_client(table, secrets.clone(), Arc::new(AllowAll), AuditLog::new(audit_path.clone()), Limits::default(), client);
    H { server, engine, secrets, audit_path, sessions: BrokerSessions::new(), _dir: dir }
}

fn audit(h: &H) -> Vec<Value> {
    std::fs::read_to_string(&h.audit_path).unwrap_or_default().lines().map(|l| serde_json::from_str(l).unwrap()).collect()
}

/// What a front does: verify the presented token, then build the request from its claims.
fn front_request(h: &H, presented: &str, service: &str, path: &str) -> Result<BrokerRequest, TokenError> {
    Ok(h.sessions.verify(presented)?.request(service, "GET", path, None))
}

#[tokio::test]
async fn a_bound_service_is_called_and_the_audit_line_names_the_session() {
    let mut h = harness().await;
    let t = h.sessions.mint(SessionClaims::new("sess-a", Role::Chat, vec![Service::Figma]));
    let m = h.server.mock("GET", "/v1/files/f1").match_header("x-figma-token", FIG).with_status(200).with_body("{}").expect(1).create_async().await;
    let r = h.engine.call(front_request(&h, t.expose(), "figma", "/v1/files/f1").unwrap()).await.unwrap();
    assert_eq!(r.status, 200);
    m.assert_async().await;
    let lines = audit(&h);
    assert_eq!((lines[0]["session"].as_str(), lines[0]["outcome"].as_str()), (Some("sess-a"), Some("ok")));
}

#[tokio::test]
async fn an_unbound_service_is_refused_with_the_line_to_add_before_any_secret_is_read() {
    let mut h = harness().await;
    let t = h.sessions.mint(SessionClaims::new("sess-a", Role::Chat, vec![Service::Figma]));
    let m = h.server.mock("GET", mockito::Matcher::Any).expect(0).create_async().await;
    let err = h.engine.call(front_request(&h, t.expose(), "shortcut", "/api/v3/member").unwrap()).await.unwrap_err();
    assert_eq!(err.code, "service_not_bound");
    let hint = err.hint.expect("the line to add");
    assert!(hint.contains(r#""broker_services": ["figma", "shortcut"]"#), "{hint}");
    m.assert_async().await;
    assert!(h.secrets.reads.lock().unwrap().is_empty(), "a refused call never touches the store");
    let lines = audit(&h);
    assert_eq!((lines[0]["outcome"].as_str(), lines[0]["session"].as_str(), lines[0]["service"].as_str()), (Some("denied_scope"), Some("sess-a"), Some("shortcut")));
}

#[tokio::test]
async fn an_engine_that_requires_scope_refuses_a_request_built_without_claims() {
    let mut h = harness().await;
    h.engine = h.engine.require_scope();
    let m = h.server.mock("GET", mockito::Matcher::Any).expect(0).create_async().await;
    let err = h.engine.call(BrokerRequest::new("sess-a", "figma", "GET", "/v1/files/f1", None)).await.unwrap_err();
    assert_eq!(err.code, "no_scope");
    m.assert_async().await;
    assert!(h.secrets.reads.lock().unwrap().is_empty());
    assert_eq!(audit(&h)[0]["outcome"].as_str(), Some("denied_scope"));
}

#[tokio::test]
async fn a_chat_with_no_services_bound_reaches_nothing() {
    let h = harness().await;
    let t = h.sessions.mint(SessionClaims::new("sess-a", Role::Sub, vec![]));
    for service in Service::ALL {
        let err = h.engine.call(front_request(&h, t.expose(), service.name(), "/x").unwrap()).await.unwrap_err();
        assert_eq!(err.code, "service_not_bound", "{}", service.name());
    }
    assert!(h.secrets.reads.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_chat_cannot_widen_its_own_set_by_editing_its_token() {
    let h = harness().await;
    let t = h.sessions.mint(SessionClaims::new("sess-a", Role::Chat, vec![Service::Figma]));
    let widened = t.expose().replace(".figma.", ".figma,shortcut.");
    assert_eq!(front_request(&h, &widened, "shortcut", "/api/v3/member").unwrap_err(), TokenError::BadSignature);
}

#[tokio::test]
async fn another_sessions_token_cannot_speak_for_this_session() {
    let h = harness().await;
    let a = h.sessions.mint(SessionClaims::new("sess-a", Role::Chat, vec![Service::Figma]));
    h.sessions.mint(SessionClaims::new("sess-b", Role::Chat, vec![Service::Shortcut]));
    // The request a front builds takes its session from the token, so A's token acts as A and as nobody else.
    let req = front_request(&h, a.expose(), "figma", "/v1/files/f1").unwrap();
    assert_eq!(req.session, "sess-a");
    assert_eq!(h.sessions.verify_for(a.expose(), "sess-b"), Err(TokenError::WrongSession));
    // A's token does not unlock B's services.
    let err = h.engine.call(front_request(&h, a.expose(), "shortcut", "/api/v3/member").unwrap()).await.unwrap_err();
    assert_eq!(err.code, "service_not_bound");
}

#[tokio::test]
async fn a_revoked_token_never_reaches_the_engine() {
    let h = harness().await;
    let t = h.sessions.mint(SessionClaims::new("sess-a", Role::Chat, vec![Service::Figma]));
    h.sessions.revoke("sess-a");
    assert_eq!(front_request(&h, t.expose(), "figma", "/v1/files/f1").unwrap_err(), TokenError::Revoked);
    assert!(audit(&h).is_empty() && h.secrets.reads.lock().unwrap().is_empty());
}

#[tokio::test]
async fn the_daemon_token_file_alone_is_not_a_broker_credential() {
    let h = harness().await;
    h.sessions.mint(SessionClaims::new("sess-a", Role::Chat, vec![Service::Figma]));
    let dir = tempfile::tempdir().unwrap();
    // The daemon writes its remote token here (`ipc::remote_access::token`).
    std::fs::write(dir.path().join("remote-access-token.txt"), "canary-daemon-remote-token-0123456789abcdef\n").unwrap();
    std::fs::write(dir.path().join("remote-access.json"), r#"{"hash":"deadbeef","token":"canary-daemon-remote-token-0123456789abcdef"}"#).unwrap();
    for file in ["remote-access-token.txt", "remote-access.json"] {
        let contents = std::fs::read_to_string(dir.path().join(file)).unwrap();
        assert!(front_request(&h, contents.trim(), "figma", "/v1/files/f1").is_err(), "{file}");
    }
    assert!(audit(&h).is_empty());
}

#[tokio::test]
async fn the_token_never_reaches_the_audit_log() {
    let mut h = harness().await;
    let t = h.sessions.mint(SessionClaims::new("sess-a", Role::Chat, vec![Service::Figma]));
    h.server.mock("GET", "/v1/files/f1").with_status(200).with_body("{}").create_async().await;
    h.engine.call(front_request(&h, t.expose(), "figma", "/v1/files/f1").unwrap()).await.unwrap();
    let _ = h.engine.call(front_request(&h, t.expose(), "shortcut", "/api/v3/member").unwrap()).await;
    let log = std::fs::read_to_string(&h.audit_path).unwrap();
    assert!(!log.contains(t.expose()) && !log.contains(FIG) && !log.contains(SC));
}
