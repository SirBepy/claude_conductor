//! Step 8 canary tests: a mock service reflects whatever credential the engine sent, in every
//! form a real service might, and the secret must be absent from everything a model or a disk can
//! hold: the MCP answer, the script answer, `out_file` text, the audit log, the data folder and the
//! session record. Every secret here is a made-up canary. The mock only echoes a canary when the
//! engine really sent it (each mock matches the header or query it reflects), so a green test means
//! the masker beat a live reflection, not that nothing was echoed.

use super::broker_rig::{forms, Rig};
use crate::daemon::broker::services::Service;
use base64::Engine as _;
use serde_json::{json, Value};
use std::fs;

const SC: &str = "CANARY-sc/3+tok=Q";
const FIG: &str = "CANARY-fig/9+tok=Z q";
const LIN: &str = "CANARY-lin/4+key=Y";
const CLK: &str = "CANARY-clk/5+key=X";
const TK: &str = "CANARY-trello-key/1+a=";
const TT: &str = "CANARY-trello-tok/2+b=";
const HS_RT1: &str = "CANARY-hs-refresh-1";
const HS_RT2: &str = "CANARY-hs-refresh-2/x+y=";
const HS_AT: &str = "CANARY-hs-access/1+z=";

const ALL: [&str; 9] = [SC, FIG, LIN, CLK, TK, TT, HS_RT1, HS_RT2, HS_AT];
const AUTH_HEADERS: [&str; 4] = ["x-figma-token", "shortcut-token", "authorization", "x-api-key"];

fn secrets() -> Vec<(&'static str, &'static str)> {
    vec![
        ("SHORTCUT_API_TOKEN", SC),
        ("FIGMA_TOKEN", FIG),
        ("LINEAR_API_KEY", LIN),
        ("CLOCKIFY_API_KEY", CLK),
        ("TRELLO_API_KEY", TK),
        ("TRELLO_TOKEN", TT),
        ("HUBSTAFF_REFRESH_TOKEN", HS_RT1),
    ]
}

fn header_of(req: &mockito::Request, name: &str) -> String {
    req.header(name).first().and_then(|v| v.to_str().ok()).unwrap_or_default().to_string()
}

/// The credential the engine sent, as the request carried it: an auth header, or a `key` / `token`
/// query value of a Trello call.
fn sent_credentials(req: &mockito::Request) -> Vec<String> {
    let mut out: Vec<String> = AUTH_HEADERS.iter().map(|h| header_of(req, h)).filter(|v| !v.is_empty()).collect();
    if let Some((_, q)) = req.path_and_query().split_once('?') {
        out.extend(url::form_urlencoded::parse(q.as_bytes()).filter(|(k, _)| k == "key" || k == "token").map(|(_, v)| v.into_owned()));
    }
    out
}

/// What a hostile or sloppy service does: reflect the credential raw, form-encoded, base64, with
/// escaped slashes, as a Basic header and inside the request URL it saw.
fn echo_body(req: &mockito::Request) -> Vec<u8> {
    let std64 = base64::engine::general_purpose::STANDARD;
    let echoes: Vec<Value> = sent_credentials(req)
        .iter()
        .map(|c| {
            json!({
                "raw": c,
                "form": url::form_urlencoded::byte_serialize(c.as_bytes()).collect::<String>(),
                "b64": std64.encode(c),
                "slashes": c.replace('/', "\\/"),
                "basic": format!("Basic {}", std64.encode(format!("someone:{c}"))),
            })
        })
        .collect();
    json!({"echoes": echoes, "url_seen": req.path_and_query()}).to_string().into_bytes()
}

fn encoded(c: &str) -> String {
    url::form_urlencoded::byte_serialize(c.as_bytes()).collect()
}

/// Mocks every path the tests call on the six services to echo what it received.
async fn echoing_server(r: &mut Rig) {
    let ok_paths = [
        ("GET", "/api/v3/member"),
        ("GET", "/v1/me"),
        ("GET", "/api/v1/user"),
        ("GET", "/1/members/me"),
        ("POST", "/graphql"),
    ];
    for (m, p) in ok_paths {
        // A Trello call carries its key and token in the query, which a plain path would not match.
        r.server
            .mock(m, mockito::Matcher::Regex(format!("^{}(\\?.*)?$", regex::escape(p))))
            .match_request(|req| !sent_credentials(req).is_empty())
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_header_from_request("link", |req| format!("<https://example.test/next?t={}>; rel=\"next\"", encoded(&sent_credentials(req).concat())))
            .with_body_from_request(echo_body)
            .expect_at_least(1)
            .create_async()
            .await;
    }
}

#[tokio::test]
async fn a_service_that_reflects_the_credential_leaks_nothing_through_either_front_or_to_any_file() {
    let mut r = Rig::new(&secrets()).await;
    echoing_server(&mut r).await;
    let all = [Service::Shortcut, Service::Figma, Service::Linear, Service::Clockify, Service::Trello];
    let t = r.token("chat-a", &all);

    let calls = [("shortcut", "/api/v3/member"), ("figma", "/v1/me"), ("clockify", "/api/v1/user"), ("trello", "/1/members/me")];
    for (service, path) in calls {
        let m = r.read("chat-a", service, path).await;
        assert_eq!(m["ok"], json!(true), "{service}: {m}");
        let body = m["body"].as_str().unwrap();
        assert!(body.contains("[MASKED]"), "{service}: the service did echo, so the answer must show a mask: {body}");
        assert!(m["headers"]["link"].as_str().unwrap().contains("[MASKED]"), "{service}: the Link header carried the credential: {m}");

        let h = r.http_ok(&t, json!({"service": service, "path": path})).await;
        assert!(h["body"].as_str().unwrap().contains("[MASKED]"), "{service}: {h}");
        let file = format!("{service}.json");
        let f = r.http_ok(&t, json!({"service": service, "path": path, "out_file": file})).await;
        assert_eq!(f["ok"], json!(true), "{service}: {f}");
        assert!(f.get("body").is_none());
        let text = fs::read_to_string(r.project.path().join(&file)).unwrap();
        assert!(text.contains("[MASKED]"), "{service}: the out_file holds the masked body: {text}");
    }
    // Linear: the key travels raw in `Authorization`, the call is a POST read, and the answer is masked.
    let q = r.mcp("chat-a", "api_read", json!({"service": "linear", "body": {"query": "{ viewer { id } }"}})).await;
    assert!(q["body"].as_str().unwrap().contains("[MASKED]"), "{q}");
    let q = r.http_ok(&t, json!({"service": "linear", "method": "POST", "path": "/graphql", "body": {"query": "{ viewer { id } }"}, "out_file": "linear.json"})).await;
    assert_eq!(q["ok"], json!(true), "{q}");

    r.assert_no_leak(&[SC, FIG, LIN, CLK, TK, TT], &[]);
    // The `Basic` form of an unknown user is a whole-string check the forms list does not cover.
    let std64 = base64::engine::general_purpose::STANDARD;
    for c in [SC, FIG, LIN, CLK, TK, TT] {
        let basic = std64.encode(format!("someone:{c}"));
        assert!(r.leaks(&[&basic], &[]).is_empty(), "base64(user:{c}) reached a sink");
    }
    // Control: the scanner reads the sinks. Without this, "no leak" could mean "scanned nothing".
    assert!(!r.leaks(&["[MASKED]"], &[]).is_empty(), "the leak check saw no answers or files");
    assert!(r.project.path().join("session.jsonl").exists());
    assert!(r.audit().len() >= 14, "every call is audited: {}", r.audit().len());
}

#[tokio::test]
async fn an_error_body_a_redirect_location_and_an_upstream_error_text_are_masked() {
    let mut r = Rig::new(&secrets()).await;
    let mut reflect = |status: usize, path: &'static str| {
        let m = r.server.mock("GET", path).match_request(|req| !sent_credentials(req).is_empty()).with_status(status).with_header_from_request("location", |req| {
            format!("https://files.example.test/signed?sig={}", encoded(&sent_credentials(req).concat()))
        });
        m.with_body_from_request(|req| format!("failed for {}", sent_credentials(req).join(" and ")).into_bytes())
    };
    let _a = reflect(500, "/api/v3/stories/500").create_async().await;
    let _b = reflect(404, "/api/v3/stories/404").create_async().await;
    let _c = reflect(302, "/api/v3/stories/302").create_async().await;
    let t = r.token("chat-a", &[Service::Shortcut]);

    for (path, status) in [("/api/v3/stories/500", 500), ("/api/v3/stories/404", 404)] {
        let m = r.read("chat-a", "shortcut", path).await;
        assert_eq!(m["ok"], json!(false), "{m}");
        assert!(m["error"].as_str().unwrap().contains(&format!("upstream answered {status}")), "{m}");
        assert!(m["error"].as_str().unwrap().contains("[MASKED]"), "the error text carries the reflected credential, masked: {m}");
        let h = r.http_ok(&t, json!({"service": "shortcut", "path": path, "out_file": "never.json"})).await;
        assert_eq!(h["ok"], json!(false), "{h}");
    }
    // A 3xx is not followed. `api_read` hands back the Location, masked; the script front writes no file and does not echo it.
    let m = r.read("chat-a", "shortcut", "/api/v3/stories/302").await;
    assert_eq!(m["status"], json!(302), "{m}");
    let loc = m["headers"]["location"].as_str().unwrap();
    assert!(loc.starts_with("https://files.example.test/signed?sig=") && loc.contains("[MASKED]"), "{loc}");
    let h = r.http_ok(&t, json!({"service": "shortcut", "path": "/api/v3/stories/302", "out_file": "moved.json"})).await;
    assert_eq!(h["ok"], json!(false), "{h}");
    assert!(!h.to_string().contains("signed"), "the Location is not echoed on the script front: {h}");
    assert!(!r.project.path().join("moved.json").exists() && !r.project.path().join("never.json").exists());

    r.assert_no_leak(&[SC], &[]);
    assert!(r.audit().iter().any(|l| l["status"] == json!(500) && l["outcome"] == json!("upstream_error")));
}

#[tokio::test]
async fn a_connection_failure_text_carries_neither_the_url_nor_the_credentials_in_it() {
    // Trello's key and token ride in the query string, and reqwest prints the URL in its errors.
    let r = Rig::with(&secrets(), Some("http://127.0.0.1:1")).await;
    let t = r.token("chat-a", &[Service::Trello]);
    let m = r.read("chat-a", "trello", "/1/members/me").await;
    assert_eq!(m["ok"], json!(false), "{m}");
    assert!(m["error"].as_str().unwrap().contains("upstream_unreachable"), "{m}");
    let h = r.http_ok(&t, json!({"service": "trello", "path": "/1/members/me"})).await;
    assert_eq!(h["ok"], json!(false), "{h}");
    r.assert_no_leak(&[TK, TT], &[]);
    let reasons: Vec<String> = r.audit().iter().filter_map(|l| l["reason"].as_str().map(str::to_string)).collect();
    assert!(!reasons.is_empty() && reasons.iter().all(|s| !s.contains("key=") && !s.contains("token=")), "{reasons:?}");
}

#[tokio::test]
async fn hubstaff_access_and_rotated_refresh_tokens_are_masked_though_only_the_exchange_returned_them() {
    let mut r = Rig::new(&secrets()).await;
    r.server
        .mock("POST", "/access_tokens")
        .with_status(200)
        .with_body(json!({"access_token": HS_AT, "refresh_token": HS_RT2, "expires_in": 3600}).to_string())
        .expect(1)
        .create_async()
        .await;
    r.server
        .mock("GET", "/v2/users/me")
        .match_header("authorization", format!("Bearer {HS_AT}").as_str())
        .with_status(200)
        .with_body_from_request(|req| json!({"seen": header_of(req, "authorization"), "refresh": HS_RT2}).to_string().into_bytes())
        .expect_at_least(1)
        .create_async()
        .await;
    let t = r.token("chat-a", &[Service::Hubstaff]);
    let m = r.read("chat-a", "hubstaff", "/v2/users/me").await;
    assert_eq!(m["ok"], json!(true), "{m}");
    assert!(m["body"].as_str().unwrap().contains("[MASKED]"), "{m}");
    let h = r.http_ok(&t, json!({"service": "hubstaff", "path": "/v2/users/me", "out_file": "hs.json"})).await;
    assert_eq!(h["ok"], json!(true), "{h}");
    r.assert_no_leak(&[HS_AT, HS_RT1, HS_RT2], &[]);
    assert_eq!(r.secrets.puts.lock().unwrap().last().map(|(_, v)| v.as_str()), Some(HS_RT2), "the rotated refresh token went to the store, nowhere else");
}

#[tokio::test]
async fn a_binary_download_is_the_one_unmasked_path_and_the_audit_line_says_so() {
    let mut r = Rig::new(&secrets()).await;
    let mut bytes = vec![0xff, 0x00, 0x89];
    bytes.extend_from_slice(TT.as_bytes());
    r.server
        .mock("GET", mockito::Matcher::Regex("^/1/cards/c1/attachments/a1/download/shot.png".into()))
        .with_status(200)
        .with_body(bytes.clone())
        .create_async()
        .await;
    let t = r.token("chat-a", &[Service::Trello]);
    let v = r.http_ok(&t, json!({"service": "trello", "path": "/1/cards/c1/attachments/a1/download/shot.png", "download": true, "out_file": "shot.png"})).await;
    assert_eq!((v["ok"].clone(), v["unmasked"].clone()), (json!(true), json!(true)), "{v}");
    // The file is the service's bytes as sent: it is how a real image survives. It is the documented
    // exception, so it is skipped below, and nothing else may hold the credential.
    assert_eq!(fs::read(r.project.path().join("shot.png")).unwrap(), bytes);
    r.assert_no_leak(&[TK, TT], &["shot.png"]);
    let audit = r.audit();
    assert_eq!(audit.len(), 1);
    assert_eq!(audit[0]["unmasked"], json!(true), "the audit line marks the one unmasked body: {}", audit[0]);
}

#[test]
fn the_form_list_covers_the_encodings_the_mock_uses() {
    // The scanner is only as good as its list: pin that it holds the forms `echo_body` emits.
    let f = forms(FIG);
    assert!(f.contains(&FIG.to_string()) && f.contains(&encoded(FIG)) && f.contains(&FIG.replace('/', "\\/")));
    assert!(f.contains(&base64::engine::general_purpose::STANDARD.encode(FIG)));
    assert!(ALL.iter().all(|c| c.starts_with("CANARY")));
}
