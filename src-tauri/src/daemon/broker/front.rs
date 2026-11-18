//! The MCP front (step 5): the logic behind `api_read` and `api_write`, between
//! the hooks route that receives the call and `Engine::call`.
//!
//! A front never builds a URL, reads a secret or sets a header: it parses the
//! tool's arguments, decides whether the call is a read or a write, builds the
//! request from the caller's own claims (`SessionClaims::request`, so the engine
//! refuses a service the chat is not bound to) and shapes the masked result. The
//! session comes from the MCP child's own channel (`CC_SESSION_ID`), never from an
//! argument the model wrote: the route overwrites any `session_id` in the args.
//!
//! Read versus write is the tool's contract, because `~/.claude` hooks match
//! `api_write` to run their guards. `api_read` therefore refuses anything that
//! changes data: a GET, a Linear query document, or one of the POST searches
//! (Shortcut's search endpoints are POSTs that only read). `api_write` takes every
//! other method; a GET sent there is refused so a read never pays a write's checks.

use super::audit::AuditLog;
use super::engine::{BrokerError, BrokerResponse, Engine};
use super::graphql::{self, GqlKind};
use super::guards::{Limits, Method};
use super::policy_file::FilePolicy;
use super::services::{Service, ServiceTable};
use super::session::SessionClaims;
use super::store::SystemSecrets;
use serde_json::{json, Map, Value};
use std::path::Path;
use std::sync::Arc;

pub const TOOL_API_READ: &str = "api_read";
pub const TOOL_API_WRITE: &str = "api_write";
pub const AUDIT_FILE: &str = "broker-audit.jsonl";

/// A body longer than this comes back cut, with `truncated: true`; the engine's
/// own response cap is far larger and is about memory, this is about the model's context.
const MAX_BODY_CHARS: usize = 200_000;
/// How much of an upstream error body goes into the error text.
const MAX_ERROR_BODY_CHARS: usize = 4_000;
/// Response headers a chat gets back. The rest add tokens and nothing a call needs.
const RETURNED_HEADERS: [&str; 6] = ["content-type", "location", "retry-after", "link", "x-ratelimit-remaining", "x-ratelimit-reset"];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tool {
    Read,
    Write,
}

impl Tool {
    pub fn parse(name: &str) -> Option<Tool> {
        match name {
            TOOL_API_READ => Some(Tool::Read),
            TOOL_API_WRITE => Some(Tool::Write),
            _ => None,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Tool::Read => TOOL_API_READ,
            Tool::Write => TOOL_API_WRITE,
        }
    }
}

/// The daemon's one engine: real hosts, the broker store then `.env`, the
/// hot-reloaded policy file, the audit log under `data_dir`, and a refusal of any
/// request that carries no session scope.
pub fn daemon_engine(data_dir: &Path) -> Result<Engine, String> {
    Engine::new(
        ServiceTable::production(),
        Arc::new(SystemSecrets::new(data_dir)),
        Arc::new(FilePolicy::open(data_dir)),
        AuditLog::new(data_dir.join(AUDIT_FILE)),
        Limits::default(),
    )
    .map(Engine::require_scope)
}

/// What the tool's arguments name, checked for shape only.
#[derive(Debug, PartialEq)]
struct Call {
    service: String,
    method: Method,
    path: String,
    body: Option<Value>,
}

fn str_arg<'a>(args: &'a Value, field: &str) -> Result<Option<&'a str>, String> {
    match args.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Ok(Some(s.trim())),
        Some(_) => Err(format!("{field} must be a string")),
    }
}

fn parse_call(tool: Tool, args: &Value) -> Result<Call, String> {
    let service = str_arg(args, "service")?.filter(|s| !s.is_empty()).ok_or_else(|| {
        let known = Service::ALL.map(|s| s.name()).join(", ");
        format!("service is missing: name one of {known}")
    })?;
    // Linear has one endpoint and always takes a POST, so a call can leave both out.
    let linear = service.eq_ignore_ascii_case("linear");
    let path = match str_arg(args, "path")?.filter(|p| !p.is_empty()) {
        Some(p) => p.to_string(),
        None if linear => "/graphql".to_string(),
        None => return Err("path is missing: a path relative to the service host, such as /api/v3/stories/123".to_string()),
    };
    let method_text = match str_arg(args, "method")?.filter(|m| !m.is_empty()) {
        Some(m) => m.to_string(),
        None if linear => "POST".to_string(),
        None if tool == Tool::Read => "GET".to_string(),
        None => return Err("method is missing: one of POST, PUT, PATCH, DELETE".to_string()),
    };
    let method = Method::parse(&method_text).ok_or_else(|| format!("method {method_text:?} is not one of GET, POST, PUT, PATCH, DELETE"))?;
    let body = match args.get("body") {
        None | Some(Value::Null) => None,
        // A model often sends a JSON body as text.
        Some(Value::String(s)) if s.trim().is_empty() => None,
        Some(Value::String(s)) => Some(serde_json::from_str::<Value>(s).map_err(|e| format!("body is a string that is not JSON: {e}"))?),
        Some(v) => Some(v.clone()),
    };
    Ok(Call { service: service.to_ascii_lowercase(), method, path, body })
}

/// Shortcut's search endpoints are POSTs that read. Matched on the path without
/// its query: `/search`, `/search/<kind>` and `/<collection>/search`.
fn is_shortcut_search(path: &str) -> bool {
    let path = path.split('?').next().unwrap_or("");
    let Some(rest) = path.strip_prefix("/api/v3/") else { return false };
    let parts: Vec<&str> = rest.split('/').collect();
    match parts[..] {
        ["search"] => true,
        ["search", kind] => !kind.is_empty(),
        [collection, "search"] => !collection.is_empty(),
        _ => false,
    }
}

/// `Ok` when the call changes nothing, else the reason it is not a read.
fn require_read(call: &Call) -> Result<(), String> {
    if call.method == Method::Get {
        return Ok(());
    }
    if call.service == "linear" {
        let body = call.body.as_ref().ok_or("a Linear call needs a body: {\"query\": ..., \"variables\": {...}}")?;
        return match graphql::parse_body(body) {
            Ok(g) if g.kind == GqlKind::Query => Ok(()),
            Ok(_) => Err("this GraphQL document is a mutation (or cannot be classified as a query), so api_read refuses it: send it with api_write".to_string()),
            Err(e) => Err(e),
        };
    }
    if call.service == "shortcut" && call.method == Method::Post && is_shortcut_search(&call.path) {
        return Ok(());
    }
    Err(format!("api_read sends reads only: a {} to {} may change data, so send it with api_write", call.method.as_str(), call.path))
}

fn refuse(error: String) -> Value {
    json!({"ok": false, "error": error})
}

fn engine_refusal(e: BrokerError) -> Value {
    // The relay shows a chat only `error`, so the line to add (a policy row, a
    // binding) rides inside it. The engine has masked both parts already.
    let mut text = format!("{}: {}", e.code, e.message);
    if let Some(h) = &e.hint {
        text.push_str(". ");
        text.push_str(h);
    }
    json!({"ok": false, "code": e.code, "error": text})
}

fn cut(s: &str, max: usize) -> (&str, bool) {
    if s.len() <= max {
        return (s, false);
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    (&s[..end], true)
}

/// `changed_data` is true for any call that is not a GET: a server error on one of those may
/// follow an applied change, so the error text says to check before retrying.
fn shape_response(r: BrokerResponse, changed_data: bool) -> Value {
    let mut headers = Map::new();
    for (name, value) in &r.headers {
        let lower = name.to_ascii_lowercase();
        if RETURNED_HEADERS.contains(&lower.as_str()) {
            headers.insert(lower, json!(value));
        }
    }
    if r.status >= 400 {
        let (body, _) = cut(&r.body, MAX_ERROR_BODY_CHARS);
        // The relay shows a chat only `error`, so what a retry needs rides inside it.
        let retry = headers.get("retry-after").and_then(Value::as_str).map(|s| format!(" (retry-after {s})")).unwrap_or_default();
        let applied = if changed_data && r.status >= 500 { ". the change may have been applied: check the object before retrying a write" } else { "" };
        return json!({"ok": false, "status": r.status, "error": format!("upstream answered {}{retry}: {body}{applied}", r.status)});
    }
    let (text, truncated) = cut(&r.body, MAX_BODY_CHARS);
    // Text, never parsed: the engine masked the exact forms of each secret, and parsing JSON here
    // would decode escapes (`a`) back into a form the masker never saw.
    let mut v = json!({"ok": true, "status": r.status, "body": text});
    if !headers.is_empty() {
        v["headers"] = Value::Object(headers);
    }
    if truncated {
        v["truncated"] = json!(true);
    }
    if r.audit_failed {
        v["audit_failed"] = json!(true);
    }
    v
}

/// Runs one tool call for the session `claims` describes.
///
/// The engine call is spawned detached and awaited through its handle: it writes
/// its audit line and (for Hubstaff) stores a rotated refresh token after the
/// request returns, so a dropped future (a closed chat, a timeout) must not cut it
/// short.
pub async fn run(engine: Arc<Engine>, claims: &SessionClaims, tool: Tool, args: &Value) -> Value {
    let call = match parse_call(tool, args) {
        Ok(c) => c,
        Err(e) => return refuse(e),
    };
    match tool {
        Tool::Read => {
            if let Err(e) = require_read(&call) {
                return refuse(e);
            }
        }
        Tool::Write if call.method == Method::Get => {
            return refuse("api_write is for calls that change data: send a GET with api_read".to_string());
        }
        Tool::Write => {}
    }
    let changed_data = call.method != Method::Get;
    let req = claims.request(&call.service, call.method.as_str(), &call.path, call.body);
    match tokio::spawn(async move { engine.call(req).await }).await {
        Ok(Ok(r)) => shape_response(r, changed_data),
        Ok(Err(e)) => engine_refusal(e),
        Err(e) => refuse(format!("the broker call was aborted: {e}")),
    }
}

/// A real engine (the real policy file, seeded; a real audit log) aimed at a mock
/// server, for the route's and the MCP path's tests.
#[cfg(test)]
pub(crate) mod testing {
    use super::*;
    use crate::daemon::broker::store::testing::MemSecrets;

    pub fn engine_against(base_url: &str, dir: &Path, secrets: &[(&str, &str)]) -> Engine {
        let mut table = ServiceTable::production();
        for s in Service::ALL {
            table = table.with_base_url(s, base_url);
        }
        table = table.with_token_url(Service::Hubstaff, &format!("{base_url}/access_tokens"));
        let client = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).no_proxy().build().unwrap();
        Engine::with_client(
            table,
            Arc::new(MemSecrets::with(secrets)),
            Arc::new(FilePolicy::open(dir)),
            AuditLog::new(dir.join(AUDIT_FILE)),
            Limits::default(),
            client,
        )
        .require_scope()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_read_defaults_to_get_and_a_write_needs_its_method() {
        let c = parse_call(Tool::Read, &json!({"service": "Figma", "path": "/v1/files/abc"})).unwrap();
        assert_eq!((c.service.as_str(), c.method), ("figma", Method::Get));
        let e = parse_call(Tool::Write, &json!({"service": "shortcut", "path": "/api/v3/stories"})).unwrap_err();
        assert!(e.starts_with("method is missing"), "{e}");
        let e = parse_call(Tool::Read, &json!({"service": "shortcut"})).unwrap_err();
        assert!(e.starts_with("path is missing"), "{e}");
        let e = parse_call(Tool::Read, &json!({"path": "/x"})).unwrap_err();
        assert!(e.contains("figma") && e.contains("hubstaff"), "the error names the known services: {e}");
        let e = parse_call(Tool::Read, &json!({"service": "figma", "path": "/x", "method": "TRACE"})).unwrap_err();
        assert!(e.contains("TRACE"), "{e}");
        let e = parse_call(Tool::Read, &json!({"service": 5, "path": "/x"})).unwrap_err();
        assert!(e.contains("must be a string"), "{e}");
    }

    #[test]
    fn linear_needs_neither_path_nor_method_and_a_text_body_is_parsed() {
        let c = parse_call(Tool::Read, &json!({"service": "linear", "body": "{\"query\":\"{ viewer { id } }\"}"})).unwrap();
        assert_eq!((c.path.as_str(), c.method), ("/graphql", Method::Post));
        assert_eq!(c.body, Some(json!({"query": "{ viewer { id } }"})));
        let e = parse_call(Tool::Read, &json!({"service": "linear", "body": "not json"})).unwrap_err();
        assert!(e.contains("not JSON"), "{e}");
        // A model often sends an empty text body on a GET: that is no body.
        for empty in ["", "  "] {
            assert_eq!(parse_call(Tool::Read, &json!({"service": "figma", "path": "/v1/me", "body": empty})).unwrap().body, None);
        }
    }

    #[test]
    fn a_read_is_a_get_a_linear_query_or_a_shortcut_search() {
        let read = |v: Value| parse_call(Tool::Read, &v).and_then(|c| require_read(&c));
        assert!(read(json!({"service": "figma", "path": "/v1/files/abc"})).is_ok());
        assert!(read(json!({"service": "linear", "body": {"query": "query { viewer { id } }"}})).is_ok());
        assert!(read(json!({"service": "linear", "body": {"query": "{ viewer { id } }"}})).is_ok());
        for path in ["/api/v3/search", "/api/v3/search/stories", "/api/v3/stories/search", "/api/v3/search?page_size=5"] {
            assert!(read(json!({"service": "shortcut", "method": "POST", "path": path})).is_ok(), "{path}");
        }
    }

    #[test]
    fn api_read_refuses_whatever_could_change_data() {
        let read = |v: Value| parse_call(Tool::Read, &v).and_then(|c| require_read(&c));
        let m = "mutation($i: CommentCreateInput!) { commentCreate(input: $i) { success } }";
        let e = read(json!({"service": "linear", "body": {"query": m, "variables": {"i": {}}}})).unwrap_err();
        assert!(e.contains("api_write"), "{e}");
        let e = read(json!({"service": "linear", "body": {"query": "query { a } query { b }"}})).unwrap_err();
        assert!(!e.is_empty());
        let e = read(json!({"service": "linear"})).unwrap_err();
        assert!(e.contains("needs a body"), "{e}");
        for (service, method, path) in [
            ("shortcut", "POST", "/api/v3/stories"),
            ("shortcut", "PUT", "/api/v3/stories/1"),
            ("shortcut", "DELETE", "/api/v3/stories/1"),
            ("shortcut", "POST", "/api/v3/stories/1/comments"),
            // A search lookalike that is not one of the three shapes.
            ("shortcut", "POST", "/api/v3/stories/1/search"),
            ("shortcut", "POST", "/api/v3/search/stories/1/extra"),
            ("shortcut", "PUT", "/api/v3/search"),
            ("trello", "POST", "/1/cards"),
            ("clockify", "POST", "/api/v1/workspaces/w/time-entries"),
            // Only Shortcut has a read-by-POST; the same path elsewhere is a write.
            ("figma", "POST", "/api/v3/search"),
        ] {
            let e = read(json!({"service": service, "method": method, "path": path})).unwrap_err();
            assert!(e.contains("api_write"), "{method} {path}: {e}");
        }
    }

    #[test]
    fn a_response_is_shaped_with_its_body_as_text_and_few_headers() {
        let r = BrokerResponse {
            status: 200,
            headers: vec![("Content-Type".into(), "application/json".into()), ("Set-Cookie".into(), "a=b".into()), ("Location".into(), "/x".into())],
            body: "{\"id\": 7}".into(),
            audit_failed: true,
        };
        let v = shape_response(r, false);
        assert_eq!(v["ok"], json!(true));
        // Text, not parsed: an escaped echo of a secret must not be decoded back into the plain value.
        assert_eq!(v["body"], json!("{\"id\": 7}"));
        let echoed = shape_response(BrokerResponse { status: 200, headers: vec![], body: "{\"k\":\"\\u0061bc\"}".into(), audit_failed: false }, false);
        assert_eq!(echoed["body"], json!("{\"k\":\"\\u0061bc\"}"), "the escape stays escaped");
        assert_eq!(v["headers"], json!({"content-type": "application/json", "location": "/x"}));
        assert_eq!(v["audit_failed"], json!(true));
        let text = shape_response(BrokerResponse { status: 200, headers: vec![], body: "plain".into(), audit_failed: false }, false);
        assert_eq!(text["body"], json!("plain"));
        assert!(text.get("headers").is_none() && text.get("audit_failed").is_none());
    }

    #[test]
    fn an_upstream_error_is_ok_false_with_its_status_and_body_in_the_error() {
        let v = shape_response(BrokerResponse { status: 422, headers: vec![], body: "{\"message\":\"bad name\"}".into(), audit_failed: false }, false);
        assert_eq!(v["ok"], json!(false));
        assert_eq!(v["status"], json!(422));
        assert!(v["error"].as_str().unwrap().contains("bad name"), "{v}");
        let limited = shape_response(BrokerResponse { status: 429, headers: vec![("Retry-After".into(), "30".into())], body: "slow down".into(), audit_failed: false }, false);
        assert!(limited["error"].as_str().unwrap().contains("retry-after 30"), "{limited}");
        // A server error after a write may follow an applied change; after a read it cannot.
        let down = |changed| shape_response(BrokerResponse { status: 502, headers: vec![], body: "bad gateway".into(), audit_failed: false }, changed);
        assert!(down(true)["error"].as_str().unwrap().contains("check the object before retrying"), "{}", down(true));
        assert!(!down(false)["error"].as_str().unwrap().contains("check the object"), "{}", down(false));
        assert!(!shape_response(BrokerResponse { status: 422, headers: vec![], body: "x".into(), audit_failed: false }, true)["error"].as_str().unwrap().contains("check the object"));
    }

    #[test]
    fn a_long_body_is_cut_on_a_character_boundary_and_flagged() {
        let body = "é".repeat(MAX_BODY_CHARS);
        let v = shape_response(BrokerResponse { status: 200, headers: vec![], body, audit_failed: false }, false);
        assert_eq!(v["truncated"], json!(true));
        let s = v["body"].as_str().unwrap();
        assert!(s.len() <= MAX_BODY_CHARS && s.chars().all(|c| c == 'é'));
    }

    #[test]
    fn a_refusal_carries_the_hint_in_its_error_text() {
        let v = engine_refusal(BrokerError { code: "policy_denied", message: "no row allows it".into(), hint: Some("add this row".into()) });
        assert_eq!(v["ok"], json!(false));
        assert_eq!(v["error"], json!("policy_denied: no row allows it. add this row"));
        let v = engine_refusal(BrokerError { code: "no_secret", message: "no token".into(), hint: None });
        assert_eq!(v["error"], json!("no_secret: no token"));
    }

    #[test]
    fn tool_names_round_trip() {
        for t in [Tool::Read, Tool::Write] {
            assert_eq!(Tool::parse(t.name()), Some(t));
        }
        assert_eq!(Tool::parse("api_delete"), None);
    }
}
