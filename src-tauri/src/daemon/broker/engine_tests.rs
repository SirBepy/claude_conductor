//! Engine tests against a local mock server standing in for each service host.
//! Every secret here is a made-up canary, never a real token shape.

use super::audit::{AuditLog, VolumeLimits};
use super::engine::{BrokerRequest, Engine};
use super::guards::Limits;
use super::policy::{Policy, PolicyDecision, PolicyRequest};
use super::services::{Service, ServiceTable};
use super::store::testing::MemSecrets;
use mockito::Matcher;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

const SC: &str = "CANARY/sc+tok=1&x";
const LIN: &str = "CANARY-LIN-key-2";
const TR_KEY: &str = "CANARY-TR-key-3";
const TR_TOK: &str = "CANARY-TR-tok-4";
const FIG: &str = "CANARY-FIG-5";
const CLK: &str = "CANARY-CLK-6";
const HS_RT1: &str = "CANARY-HS-rt-7";
const HS_RT2: &str = "CANARY-HS-rt-8";
const HS_AT: &str = "CANARY-HS-at-9";

/// A policy double: records what it was asked and answers with a closure.
struct FnPolicy {
    f: Box<dyn Fn(&PolicyRequest<'_>) -> PolicyDecision + Send + Sync>,
    seen: Mutex<Vec<String>>,
}

impl FnPolicy {
    fn new(f: impl Fn(&PolicyRequest<'_>) -> PolicyDecision + Send + Sync + 'static) -> Arc<Self> {
        Arc::new(Self { f: Box::new(f), seen: Mutex::new(Vec::new()) })
    }
    fn allow() -> Arc<Self> {
        Self::new(|_| PolicyDecision::Allow { require_owner: false })
    }
    fn allow_owner() -> Arc<Self> {
        Self::new(|_| PolicyDecision::Allow { require_owner: true })
    }
}

impl Policy for FnPolicy {
    fn decide(&self, r: &PolicyRequest<'_>) -> PolicyDecision {
        self.seen.lock().unwrap().push(format!("{} {} {}{} read={} op={:?}", r.session, r.method.as_str(), r.path, r.query.map(|q| format!("?{q}")).unwrap_or_default(), r.read, r.linear_op));
        (self.f)(r)
    }
}

struct H {
    server: mockito::ServerGuard,
    engine: Engine,
    secrets: Arc<MemSecrets>,
    policy: Arc<FnPolicy>,
    audit_path: PathBuf,
    _dir: tempfile::TempDir,
}

fn all_secrets() -> Arc<MemSecrets> {
    Arc::new(MemSecrets::with(&[
        ("SHORTCUT_API_TOKEN", SC),
        ("LINEAR_API_KEY", LIN),
        ("TRELLO_API_KEY", TR_KEY),
        ("TRELLO_TOKEN", TR_TOK),
        ("FIGMA_TOKEN", FIG),
        ("CLOCKIFY_API_KEY", CLK),
        ("HUBSTAFF_REFRESH_TOKEN", HS_RT1),
    ]))
}

async fn harness_with(policy: Arc<FnPolicy>, secrets: Arc<MemSecrets>, limits: Limits, volume: VolumeLimits) -> H {
    let server = mockito::Server::new_async().await;
    let base = server.url();
    let mut table = ServiceTable::production();
    for s in Service::ALL {
        table = table.with_base_url(s, &base);
    }
    table = table.with_token_url(Service::Hubstaff, &format!("{base}/access_tokens"));
    let dir = tempfile::tempdir().unwrap();
    let audit_path = dir.path().join("audit.jsonl");
    let client = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).no_proxy().build().unwrap();
    let engine = Engine::with_client(table, secrets.clone(), policy.clone(), AuditLog::with_limits(audit_path.clone(), volume), limits, client);
    H { server, engine, secrets, policy, audit_path, _dir: dir }
}

async fn harness(policy: Arc<FnPolicy>) -> H {
    harness_with(policy, all_secrets(), Limits::default(), VolumeLimits::default()).await
}

fn audit_lines(h: &H) -> Vec<Value> {
    std::fs::read_to_string(&h.audit_path).unwrap_or_default().lines().map(|l| serde_json::from_str(l).unwrap()).collect()
}

/// The audit log never holds a secret, whatever happened in the test.
fn assert_audit_clean(h: &H) {
    let text = std::fs::read_to_string(&h.audit_path).unwrap_or_default();
    for c in [SC, LIN, TR_KEY, TR_TOK, FIG, CLK, HS_RT1, HS_RT2, HS_AT] {
        assert!(!text.contains(c), "audit log holds a canary: {c}");
    }
}

fn req(service: &str, method: &str, path: &str, body: Option<Value>) -> BrokerRequest {
    BrokerRequest::new("sess-1", service, method, path, body)
}

// ---- auth shapes -----------------------------------------------------------------

#[tokio::test]
async fn header_auth_sends_each_services_own_header_and_returns_the_body() {
    let mut h = harness(FnPolicy::allow()).await;
    let cases = [
        ("shortcut", "/api/v3/stories/1", "shortcut-token", SC),
        ("figma", "/v1/files/abc", "x-figma-token", FIG),
        ("clockify", "/api/v1/user", "x-api-key", CLK),
    ];
    for (service, path, header, secret) in cases {
        let m = h.server.mock("GET", path).match_header(header, secret).with_status(200).with_body(r#"{"ok":true}"#).expect(1).create_async().await;
        let r = h.engine.call(req(service, "GET", path, None)).await.unwrap();
        assert_eq!((r.status, r.body.as_str()), (200, r#"{"ok":true}"#), "{service}");
        m.assert_async().await;
    }
    assert_audit_clean(&h);
}

#[tokio::test]
async fn linear_sends_the_raw_key_in_authorization_and_the_graphql_body() {
    let mut h = harness(FnPolicy::allow()).await;
    let m = h
        .server
        .mock("POST", "/graphql")
        .match_header("authorization", LIN)
        .match_body(Matcher::PartialJson(json!({"query": "{ viewer { id } }"})))
        .with_status(200)
        .with_body(r#"{"data":{"viewer":{"id":"u1"}}}"#)
        .expect(1)
        .create_async()
        .await;
    let r = h.engine.call(req("linear", "POST", "/graphql", Some(json!({"query": "{ viewer { id } }"})))).await.unwrap();
    assert!(r.body.contains("u1"));
    m.assert_async().await;
    assert_eq!(h.policy.seen.lock().unwrap()[0], "sess-1 POST /graphql read=true op=None", "a Linear query is a read for the policy");
}

#[tokio::test]
async fn trello_appends_key_and_token_as_query_parameters_and_keeps_the_callers_query() {
    let mut h = harness(FnPolicy::allow()).await;
    let m = h
        .server
        .mock("GET", "/1/cards/abc")
        .match_query(Matcher::AllOf(vec![
            Matcher::UrlEncoded("fields".into(), "name".into()),
            Matcher::UrlEncoded("key".into(), TR_KEY.into()),
            Matcher::UrlEncoded("token".into(), TR_TOK.into()),
        ]))
        .with_status(200)
        .with_body(r#"{"name":"card"}"#)
        .expect(1)
        .create_async()
        .await;
    let r = h.engine.call(req("trello", "GET", "/1/cards/abc?fields=name", None)).await.unwrap();
    assert_eq!(r.status, 200);
    m.assert_async().await;
    let lines = audit_lines(&h);
    assert_eq!(lines[0]["path"], "/1/cards/abc?fields=name", "the audited path never holds the engine's key and token");
    assert_audit_clean(&h);
}

#[tokio::test]
async fn hubstaff_exchanges_the_refresh_token_stores_the_rotated_one_and_reuses_the_access_token() {
    let mut h = harness(FnPolicy::allow()).await;
    let token = h
        .server
        .mock("POST", "/access_tokens")
        .match_header("user-agent", Matcher::Regex("Mozilla".into()))
        .match_body(Matcher::AllOf(vec![
            Matcher::Regex("grant_type=refresh_token".into()),
            Matcher::Regex(format!("refresh_token={HS_RT1}")),
        ]))
        .with_status(200)
        .with_body(json!({"access_token": HS_AT, "refresh_token": HS_RT2, "expires_in": 3600}).to_string())
        .expect(1)
        .create_async()
        .await;
    let api = h
        .server
        .mock("GET", "/v2/users/me")
        .match_header("authorization", format!("Bearer {HS_AT}").as_str())
        .with_status(200)
        .with_body(r#"{"user":{"id":1}}"#)
        .expect(2)
        .create_async()
        .await;
    h.engine.call(req("hubstaff", "GET", "/v2/users/me", None)).await.unwrap();
    h.engine.call(req("hubstaff", "GET", "/v2/users/me", None)).await.unwrap();
    token.assert_async().await;
    api.assert_async().await;
    assert_eq!(*h.secrets.puts.lock().unwrap(), vec![("HUBSTAFF_REFRESH_TOKEN".to_string(), HS_RT2.to_string())]);
    assert_audit_clean(&h);
}

#[tokio::test]
async fn hubstaff_masks_the_access_and_rotated_refresh_tokens_in_a_response() {
    let mut h = harness(FnPolicy::allow()).await;
    let _t = h
        .server
        .mock("POST", "/access_tokens")
        .with_status(200)
        .with_body(json!({"access_token": HS_AT, "refresh_token": HS_RT2, "expires_in": 3600}).to_string())
        .create_async()
        .await;
    let _a = h
        .server
        .mock("GET", "/v2/echo")
        .with_status(200)
        .with_body(format!("auth={HS_AT} next={HS_RT2} old={HS_RT1}"))
        .create_async()
        .await;
    let r = h.engine.call(req("hubstaff", "GET", "/v2/echo", None)).await.unwrap();
    assert_eq!(r.body, "auth=[MASKED] next=[MASKED] old=[MASKED]");
}

#[tokio::test]
async fn hubstaff_refresh_failure_is_an_error_that_leaks_nothing() {
    let mut h = harness(FnPolicy::allow()).await;
    let _t = h.server.mock("POST", "/access_tokens").with_status(403).with_body(format!("denied {HS_RT1}")).create_async().await;
    let e = h.engine.call(req("hubstaff", "GET", "/v2/users/me", None)).await.unwrap_err();
    assert_eq!(e.code, "oauth_refresh_failed");
    assert!(!e.message.contains(HS_RT1) && e.message.contains("403"));
    assert!(h.secrets.puts.lock().unwrap().is_empty());
    assert_audit_clean(&h);
}

#[tokio::test]
async fn hubstaff_is_pc_only_where_the_store_cannot_rotate() {
    let secrets = Arc::new(MemSecrets { rotate: false, ..MemSecrets::with(&[("HUBSTAFF_REFRESH_TOKEN", HS_RT1)]) });
    let mut h = harness_with(FnPolicy::allow(), secrets, Limits::default(), VolumeLimits::default()).await;
    let t = h.server.mock("POST", "/access_tokens").expect(0).create_async().await;
    let e = h.engine.call(req("hubstaff", "GET", "/v2/users/me", None)).await.unwrap_err();
    assert_eq!(e.code, "pc_only");
    assert!(e.message.contains("PC only"));
    t.assert_async().await;
    assert!(h.secrets.reads.lock().unwrap().is_empty(), "the refresh token was never read");
}

#[tokio::test]
async fn a_rotated_token_that_cannot_be_stored_is_kept_in_memory_and_noted_in_the_audit() {
    let secrets = Arc::new(MemSecrets { fail_put: true, ..MemSecrets::with(&[("HUBSTAFF_REFRESH_TOKEN", HS_RT1)]) });
    let mut h = harness_with(FnPolicy::allow(), secrets, Limits::default(), VolumeLimits::default()).await;
    let _t = h
        .server
        .mock("POST", "/access_tokens")
        .with_status(200)
        .with_body(json!({"access_token": HS_AT, "refresh_token": HS_RT2, "expires_in": 3600}).to_string())
        .create_async()
        .await;
    let _a = h.server.mock("GET", "/v2/users/me").with_status(200).with_body("{}").create_async().await;
    h.engine.call(req("hubstaff", "GET", "/v2/users/me", None)).await.unwrap();
    let line = &audit_lines(&h)[0];
    assert!(line["reason"].as_str().unwrap().contains("not stored"));
    assert_audit_clean(&h);
}

// ---- masking ---------------------------------------------------------------------

#[tokio::test]
async fn a_secret_echoed_in_every_form_is_masked_in_body_and_headers() {
    use base64::Engine as _;
    let mut h = harness(FnPolicy::allow()).await;
    let b64 = base64::engine::general_purpose::STANDARD.encode(SC);
    let pct = "CANARY%2Fsc%2Btok%3D1%26x";
    let json_form = serde_json::to_string(SC).unwrap();
    let body = format!("raw={SC} pct={pct} b64={b64} json={json_form} basic={}", base64::engine::general_purpose::STANDARD.encode(format!("{SC}:")));
    let _m = h
        .server
        .mock("GET", "/api/v3/echo")
        .with_status(200)
        .with_header("x-echo-token", SC)
        .with_header("x-echo-b64", &b64)
        .with_body(&body)
        .create_async()
        .await;
    let r = h.engine.call(req("shortcut", "GET", "/api/v3/echo", None)).await.unwrap();
    let all = format!("{} {:?}", r.body, r.headers);
    for leak in [SC, pct, b64.as_str(), "CANARY/sc"] {
        assert!(!all.contains(leak), "leaked {leak}: {all}");
    }
    assert!(r.body.contains("[MASKED]"));
    assert!(r.headers.iter().any(|(k, v)| k == "x-echo-token" && v == "[MASKED]"));
    // A look-alike that is not the secret stays as it was.
    let _m2 = h.server.mock("GET", "/api/v3/lookalike").with_status(200).with_body("CANARY/sc+tok=2&x").create_async().await;
    let r2 = h.engine.call(req("shortcut", "GET", "/api/v3/lookalike", None)).await.unwrap();
    assert_eq!(r2.body, "CANARY/sc+tok=2&x");
}

#[tokio::test]
async fn a_trello_error_does_not_leak_the_key_or_token_that_sit_in_the_url() {
    let secrets = all_secrets();
    // A port nothing listens on: the connect error is the one reqwest decorates with the URL.
    let dir = tempfile::tempdir().unwrap();
    let table = ServiceTable::production().with_base_url(Service::Trello, "http://127.0.0.1:1");
    let client = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).no_proxy().build().unwrap();
    let audit = AuditLog::new(dir.path().join("a.jsonl"));
    let engine = Engine::with_client(table, secrets, FnPolicy::allow(), audit, Limits::default(), client);
    let e = engine.call(req("trello", "GET", "/1/cards/abc", None)).await.unwrap_err();
    assert!(e.code.starts_with("upstream_"), "{}", e.code);
    for c in [TR_KEY, TR_TOK] {
        assert!(!e.message.contains(c), "error leaks {c}: {}", e.message);
    }
    let text = std::fs::read_to_string(dir.path().join("a.jsonl")).unwrap();
    assert!(!text.contains(TR_KEY) && !text.contains(TR_TOK));
}

#[tokio::test]
async fn a_redirect_is_not_followed_and_its_location_is_masked() {
    let mut h = harness(FnPolicy::allow()).await;
    let landing = h.server.mock("GET", "/landing").expect(0).create_async().await;
    let location = format!("{}/landing?token={SC}", h.server.url());
    let _m = h.server.mock("GET", "/api/v3/stories/1").with_status(302).with_header("location", &location).create_async().await;
    let r = h.engine.call(req("shortcut", "GET", "/api/v3/stories/1", None)).await.unwrap();
    assert_eq!(r.status, 302);
    let loc = r.headers.iter().find(|(k, _)| k == "location").map(|(_, v)| v.clone()).unwrap();
    assert!(loc.contains("[MASKED]") && !loc.contains("CANARY"), "{loc}");
    landing.assert_async().await;
    assert_audit_clean(&h);
}

#[tokio::test]
async fn an_oversized_response_is_refused_not_truncated() {
    let limits = Limits { max_response_bytes: 100, ..Limits::default() };
    let mut h = harness_with(FnPolicy::allow(), all_secrets(), limits, VolumeLimits::default()).await;
    let _m = h.server.mock("GET", "/api/v3/big").with_status(200).with_body("x".repeat(500)).create_async().await;
    let e = h.engine.call(req("shortcut", "GET", "/api/v3/big", None)).await.unwrap_err();
    assert_eq!(e.code, "response_too_large");
    assert_eq!(audit_lines(&h)[0]["outcome"], "error");
}

#[tokio::test]
async fn a_query_that_carries_the_secret_is_masked_in_the_audited_path() {
    let mut h = harness(FnPolicy::allow()).await;
    let _m = h.server.mock("GET", "/api/v3/search").match_query(Matcher::Any).with_status(200).with_body("{}").create_async().await;
    h.engine.call(req("shortcut", "GET", "/api/v3/search?query=CANARY%2Fsc%2Btok%3D1%26x", None)).await.unwrap();
    assert_eq!(audit_lines(&h)[0]["path"], "/api/v3/search?query=[MASKED]");
    assert_audit_clean(&h);
}

// ---- guards through the engine ---------------------------------------------------

#[tokio::test]
async fn guard_failures_never_reach_the_network_the_policy_or_the_store() {
    let mut h = harness(FnPolicy::allow()).await;
    let any = h.server.mock("GET", Matcher::Any).expect(0).create_async().await;
    let any_post = h.server.mock("POST", Matcher::Any).expect(0).create_async().await;
    let mut hdr = req("shortcut", "GET", "/api/v3/stories/1", None);
    hdr.headers = vec![("X-Forwarded-Host".into(), "evil.example".into())];
    let cases = [
        req("shortcut", "GET", "https://evil.example/api/v3/stories/1", None),
        req("shortcut", "GET", "//evil.example/api/v3/stories/1", None),
        req("shortcut", "GET", "/api/v3/../../etc", None),
        req("shortcut", "GET", "/somewhere/else", None),
        req("shortcut", "TRACE", "/api/v3/stories/1", None),
        req("trello", "GET", "/1/cards/1?token=mine", None),
        hdr,
    ];
    for c in cases {
        let e = h.engine.call(c.clone()).await.unwrap_err();
        assert!(["path", "path_prefix", "method", "query", "header"].contains(&e.code), "{c:?} -> {}", e.code);
    }
    any.assert_async().await;
    any_post.assert_async().await;
    assert!(h.policy.seen.lock().unwrap().is_empty(), "the policy is only asked about calls that passed the guards");
    assert!(h.secrets.reads.lock().unwrap().is_empty(), "no secret was read");
    assert!(audit_lines(&h).iter().all(|l| l["outcome"] == "denied_guard" && l["status"].is_null()));
}

#[tokio::test]
async fn unknown_service_empty_session_and_an_oversized_body_are_refused() {
    let h = harness(FnPolicy::allow()).await;
    let e = h.engine.call(req("github", "GET", "/x", None)).await.unwrap_err();
    assert_eq!(e.code, "unknown_service");
    assert!(e.message.contains("shortcut"));
    let mut r = req("shortcut", "GET", "/api/v3/stories/1", None);
    r.session = "  ".into();
    assert_eq!(h.engine.call(r).await.unwrap_err().code, "no_session");
    let limits = Limits { max_request_bytes: 20, ..Limits::default() };
    let h2 = harness_with(FnPolicy::allow(), all_secrets(), limits, VolumeLimits::default()).await;
    let big = json!({"name": "x".repeat(100)});
    assert_eq!(h2.engine.call(req("shortcut", "POST", "/api/v3/stories", Some(big))).await.unwrap_err().code, "request_too_large");
}

// ---- policy ----------------------------------------------------------------------

#[tokio::test]
async fn a_policy_denial_returns_its_hint_without_reading_a_secret_or_calling_out() {
    let policy = FnPolicy::new(|_| PolicyDecision::Deny { reason: "no row allows PUT here".into(), hint: Some("add: PUT ^/api/v3/stories/\\d+$".into()) });
    let mut h = harness(policy).await;
    let any = h.server.mock("PUT", Matcher::Any).expect(0).create_async().await;
    let e = h.engine.call(req("shortcut", "PUT", "/api/v3/stories/9", Some(json!({"name": "x"})))).await.unwrap_err();
    assert_eq!(e.code, "policy_denied");
    assert_eq!(e.hint.as_deref(), Some("add: PUT ^/api/v3/stories/\\d+$"));
    any.assert_async().await;
    assert!(h.secrets.reads.lock().unwrap().is_empty());
    let line = &audit_lines(&h)[0];
    assert_eq!((line["outcome"].as_str(), line["method"].as_str(), line["session"].as_str()), (Some("denied_policy"), Some("PUT"), Some("sess-1")));
}

#[tokio::test]
async fn a_missing_secret_is_a_clear_error_and_no_request_goes_out() {
    let secrets = Arc::new(MemSecrets::with(&[("LINEAR_API_KEY", LIN)]));
    let mut h = harness_with(FnPolicy::allow(), secrets, Limits::default(), VolumeLimits::default()).await;
    let any = h.server.mock("GET", Matcher::Any).expect(0).create_async().await;
    let e = h.engine.call(req("shortcut", "GET", "/api/v3/stories/1", None)).await.unwrap_err();
    assert_eq!(e.code, "no_secret");
    assert!(e.message.contains("SHORTCUT_API_TOKEN"));
    any.assert_async().await;
    assert_eq!(audit_lines(&h)[0]["outcome"], "no_secret");
}

// ---- Shortcut ownership ----------------------------------------------------------

async fn shortcut_member(h: &mut H, times: usize) -> mockito::Mock {
    h.server.mock("GET", "/api/v3/member").with_status(200).with_body(r#"{"id":"me-1"}"#).expect(times).create_async().await
}

#[tokio::test]
async fn an_owned_story_may_be_written_and_the_member_id_is_fetched_once() {
    let mut h = harness(FnPolicy::allow_owner()).await;
    let member = shortcut_member(&mut h, 1).await;
    let _story = h.server.mock("GET", "/api/v3/stories/55").with_status(200).with_body(r#"{"owner_ids":["x","me-1"]}"#).create_async().await;
    let put = h.server.mock("PUT", "/api/v3/stories/55").match_header("shortcut-token", SC).with_status(200).with_body("{}").expect(1).create_async().await;
    let post = h.server.mock("POST", "/api/v3/stories/55/comments").with_status(201).with_body("{}").expect(1).create_async().await;
    assert_eq!(h.engine.call(req("shortcut", "PUT", "/api/v3/stories/55", Some(json!({"name": "n"})))).await.unwrap().status, 200);
    assert_eq!(h.engine.call(req("shortcut", "POST", "/api/v3/stories/55/comments", Some(json!({"text": "hi"})))).await.unwrap().status, 201);
    put.assert_async().await;
    post.assert_async().await;
    member.assert_async().await;
}

#[tokio::test]
async fn a_story_i_filed_counts_as_mine() {
    let mut h = harness(FnPolicy::allow_owner()).await;
    let _m = shortcut_member(&mut h, 1).await;
    let _s = h.server.mock("GET", "/api/v3/stories/7").with_status(200).with_body(r#"{"owner_ids":[],"requested_by_id":"me-1"}"#).create_async().await;
    let _p = h.server.mock("PUT", "/api/v3/stories/7").with_status(200).with_body("{}").create_async().await;
    assert!(h.engine.call(req("shortcut", "PUT", "/api/v3/stories/7", Some(json!({})))).await.is_ok());
}

#[tokio::test]
async fn someone_elses_story_is_refused_before_the_write_is_sent() {
    let mut h = harness(FnPolicy::allow_owner()).await;
    let _m = shortcut_member(&mut h, 1).await;
    let _s = h.server.mock("GET", "/api/v3/stories/56").with_status(200).with_body(r#"{"owner_ids":["other"],"requested_by_id":"other"}"#).create_async().await;
    let put = h.server.mock("PUT", "/api/v3/stories/56").expect(0).create_async().await;
    let e = h.engine.call(req("shortcut", "PUT", "/api/v3/stories/56", Some(json!({"name": "n"})))).await.unwrap_err();
    assert_eq!(e.code, "not_owner");
    put.assert_async().await;
    assert_eq!(audit_lines(&h)[0]["outcome"], "denied_owner");
}

#[tokio::test]
async fn an_owner_only_row_on_a_path_with_no_target_or_a_failed_lookup_is_refused() {
    let mut h = harness(FnPolicy::allow_owner()).await;
    let post = h.server.mock("POST", "/api/v3/stories").expect(0).create_async().await;
    let e = h.engine.call(req("shortcut", "POST", "/api/v3/stories", Some(json!({"name": "n"})))).await.unwrap_err();
    assert_eq!(e.code, "no_target");
    post.assert_async().await;
    // The lookup itself fails: the answer is "no", never "assume yes".
    let _m = shortcut_member(&mut h, 1).await;
    let _s = h.server.mock("GET", "/api/v3/stories/57").with_status(404).create_async().await;
    let put = h.server.mock("PUT", "/api/v3/stories/57").expect(0).create_async().await;
    let e = h.engine.call(req("shortcut", "PUT", "/api/v3/stories/57", Some(json!({})))).await.unwrap_err();
    assert_eq!(e.code, "owner_lookup_failed");
    put.assert_async().await;
}

#[tokio::test]
async fn an_owner_only_row_on_a_service_without_an_owner_rule_is_refused() {
    let mut h = harness(FnPolicy::allow_owner()).await;
    let any = h.server.mock("POST", Matcher::Any).expect(0).create_async().await;
    let e = h.engine.call(req("clockify", "POST", "/api/v1/workspaces/w/time-entries", Some(json!({})))).await.unwrap_err();
    assert_eq!(e.code, "no_owner_rule");
    any.assert_async().await;
}

// ---- Linear named operations and ownership --------------------------------------

const COMMENT: &str = "mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success } }";

async fn linear_lookups(h: &mut H, creator: &str, assignee: Option<&str>) {
    h.server
        .mock("POST", "/graphql")
        .match_body(Matcher::Regex("viewer".into()))
        .with_status(200)
        .with_body(r#"{"data":{"viewer":{"id":"me-1"}}}"#)
        .create_async()
        .await;
    let issue = json!({"data": {"issue": {"id": "i", "creator": {"id": creator}, "assignee": assignee.map(|a| json!({"id": a}))}}});
    h.server.mock("POST", "/graphql").match_body(Matcher::Regex("creator".into())).with_status(200).with_body(issue.to_string()).create_async().await;
}

#[tokio::test]
async fn a_linear_comment_on_my_issue_is_sent_and_the_policy_saw_the_named_operation() {
    let mut h = harness(FnPolicy::allow_owner()).await;
    linear_lookups(&mut h, "me-1", None).await;
    let write = h
        .server
        .mock("POST", "/graphql")
        .match_body(Matcher::Regex("commentCreate".into()))
        .match_header("authorization", LIN)
        .with_status(200)
        .with_body(r#"{"data":{"commentCreate":{"success":true}}}"#)
        .expect(1)
        .create_async()
        .await;
    let body = json!({"query": COMMENT, "variables": {"input": {"issueId": "MOB-12", "body": "hello"}}});
    let r = h.engine.call(req("linear", "POST", "/graphql", Some(body))).await.unwrap();
    assert!(r.body.contains("success"));
    write.assert_async().await;
    assert_eq!(h.policy.seen.lock().unwrap()[0], "sess-1 POST /graphql read=false op=Some(\"commentCreate\")");
}

#[tokio::test]
async fn a_linear_comment_on_someone_elses_issue_is_refused_and_never_sent() {
    let mut h = harness(FnPolicy::allow_owner()).await;
    linear_lookups(&mut h, "u-other", Some("u-third")).await;
    let write = h.server.mock("POST", "/graphql").match_body(Matcher::Regex("commentCreate".into())).expect(0).create_async().await;
    let body = json!({"query": COMMENT, "variables": {"input": {"issueId": "MOB-99", "body": "hello"}}});
    let e = h.engine.call(req("linear", "POST", "/graphql", Some(body))).await.unwrap_err();
    assert_eq!(e.code, "not_owner");
    write.assert_async().await;
}

#[tokio::test]
async fn an_assigned_linear_issue_counts_as_mine() {
    let mut h = harness(FnPolicy::allow_owner()).await;
    linear_lookups(&mut h, "u-other", Some("me-1")).await;
    let _w = h.server.mock("POST", "/graphql").match_body(Matcher::Regex("issueUpdate".into())).with_status(200).with_body("{\"data\":{}}").create_async().await;
    let q = "mutation($id: String!, $in: IssueUpdateInput!) { issueUpdate(id: $id, input: $in) { success } }";
    let body = json!({"query": q, "variables": {"id": "MOB-3", "in": {"title": "t"}}});
    assert!(h.engine.call(req("linear", "POST", "/graphql", Some(body))).await.is_ok());
}

#[tokio::test]
async fn linear_documents_the_broker_cannot_classify_are_refused_before_the_policy() {
    let mut h = harness(FnPolicy::allow()).await;
    let any = h.server.mock("POST", "/graphql").expect(0).create_async().await;
    let literal = json!({"query": r#"mutation { commentCreate(input: {issueId: "MOB-1", body: "x"}) { success } }"#});
    let two = json!({"query": "mutation($i: I!) { commentCreate(input: $i) { success } issueDelete(id: $d) { success } }"});
    let alias = json!({"query": "mutation($i: I!) { a: commentCreate(input: $i) { success } }"});
    for body in [literal, two, alias] {
        assert_eq!(h.engine.call(req("linear", "POST", "/graphql", Some(body))).await.unwrap_err().code, "graphql_unsupported");
    }
    assert_eq!(h.engine.call(req("linear", "GET", "/graphql", None)).await.unwrap_err().code, "graphql_method");
    assert_eq!(h.engine.call(req("linear", "POST", "/graphql", None)).await.unwrap_err().code, "graphql_body");
    assert_eq!(h.engine.call(req("linear", "POST", "/graphql", Some(json!({"query": "{ a }", "extensions": {}})))).await.unwrap_err().code, "graphql_body");
    any.assert_async().await;
    assert!(h.policy.seen.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_linear_owner_row_without_an_issue_in_the_variables_is_refused() {
    let mut h = harness(FnPolicy::allow_owner()).await;
    let any = h.server.mock("POST", "/graphql").expect(0).create_async().await;
    let create = json!({"query": "mutation($i: IssueCreateInput!) { issueCreate(input: $i) { success } }", "variables": {"i": {"title": "t"}}});
    let e = h.engine.call(req("linear", "POST", "/graphql", Some(create))).await.unwrap_err();
    assert_eq!(e.code, "no_target");
    any.assert_async().await;
}

// ---- audit -----------------------------------------------------------------------

#[tokio::test]
async fn every_outcome_leaves_one_audit_line_and_gets_are_counted_with_flags() {
    let volume = VolumeLimits { burst_per_min: 2, sustained_per_hour: 1000, large_response_bytes: 1_000_000 };
    let mut h = harness_with(FnPolicy::allow(), all_secrets(), Limits::default(), volume).await;
    let _g = h.server.mock("GET", "/api/v3/stories/1").with_status(200).with_body("{}").create_async().await;
    let _b = h.server.mock("GET", "/api/v3/stories/2").with_status(404).with_body("{}").create_async().await;
    let _p = h.server.mock("POST", "/api/v3/stories/1/comments").with_status(201).with_body("{}").create_async().await;
    h.engine.call(req("shortcut", "GET", "/api/v3/stories/1", None)).await.unwrap();
    let missing = h.engine.call(req("shortcut", "GET", "/api/v3/stories/2", None)).await.unwrap();
    assert_eq!(missing.status, 404, "an upstream error is still a response");
    h.engine.call(req("shortcut", "POST", "/api/v3/stories/1/comments", Some(json!({"text": "x"})))).await.unwrap();
    let _ = h.engine.call(req("shortcut", "GET", "/nope", None)).await;
    let lines = audit_lines(&h);
    assert_eq!(lines.len(), 4);
    let shape = |l: &Value| (l["method"].as_str().unwrap().to_string(), l["outcome"].as_str().unwrap().to_string(), l["status"].as_u64());
    assert_eq!(shape(&lines[0]), ("GET".into(), "ok".into(), Some(200)));
    assert_eq!(shape(&lines[1]), ("GET".into(), "upstream_error".into(), Some(404)));
    assert_eq!(shape(&lines[2]), ("POST".into(), "ok".into(), Some(201)));
    assert_eq!(shape(&lines[3]), ("GET".into(), "denied_guard".into(), None));
    assert_eq!(lines[0]["service"], "shortcut");
    assert_eq!(lines[0]["path"], "/api/v3/stories/1");
    assert_eq!(lines[0]["session"], "sess-1");
    assert_eq!(lines[0]["get_volume"]["last_min"], 1);
    assert_eq!(lines[1]["get_volume"]["last_min"], 2);
    assert_eq!(lines[1]["flags"], json!(["burst"]));
    assert_eq!(lines[2]["req_bytes"], json!({"text": "x"}).to_string().len());
    assert!(lines[2].get("get_volume").is_none());
    assert_audit_clean(&h);
}

#[tokio::test]
async fn an_unwritable_audit_log_does_not_lose_the_result_but_says_so() {
    let mut h = harness(FnPolicy::allow()).await;
    // A directory where the log file should be makes every append fail.
    std::fs::create_dir_all(&h.audit_path).unwrap();
    let _m = h.server.mock("GET", "/api/v3/stories/1").with_status(200).with_body("{}").create_async().await;
    let r = h.engine.call(req("shortcut", "GET", "/api/v3/stories/1", None)).await.unwrap();
    assert!(r.audit_failed);
}
