//! Request guards: what a chat may put in a broker call before any policy row
//! is consulted. They keep a call on the host and path family the service
//! table names, and stop a chat from steering authentication.
//!
//! - Relative paths only: the path starts with a single `/`, carries no scheme,
//!   authority, backslash, control character, fragment or dot segment (plain or
//!   percent-encoded), so it can only extend the service's own base URL.
//! - Every path stays inside the service's `path_prefix`.
//! - The caller cannot set a query parameter the engine owns (Trello's
//!   `key`/`token`) or one named like a credential.
//! - Only `accept` and `content-type` headers pass; host-override and
//!   credential headers are refused by name.
//! - Request and response sizes are capped (`Limits`); redirects are never
//!   followed (the client is built with `redirect::Policy::none()`).

use super::services::ServiceSpec;
use std::time::Duration;

/// Caps and timeouts one engine applies.
#[derive(Clone, Copy, Debug)]
pub struct Limits {
    pub max_request_bytes: usize,
    pub max_response_bytes: usize,
    pub timeout: Duration,
}

impl Default for Limits {
    fn default() -> Self {
        Self { max_request_bytes: 1024 * 1024, max_response_bytes: 8 * 1024 * 1024, timeout: Duration::from_secs(30) }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Method {
    Get,
    Post,
    Put,
    Patch,
    Delete,
}

impl Method {
    pub fn parse(s: &str) -> Option<Method> {
        match s.trim().to_ascii_uppercase().as_str() {
            "GET" => Some(Method::Get),
            "POST" => Some(Method::Post),
            "PUT" => Some(Method::Put),
            "PATCH" => Some(Method::Patch),
            "DELETE" => Some(Method::Delete),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Method::Get => "GET",
            Method::Post => "POST",
            Method::Put => "PUT",
            Method::Patch => "PATCH",
            Method::Delete => "DELETE",
        }
    }
}

/// A refusal: a stable `code` for the audit log and a message the chat sees.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GuardError {
    pub code: &'static str,
    pub message: String,
}

fn refuse<T>(code: &'static str, message: impl Into<String>) -> Result<T, GuardError> {
    Err(GuardError { code, message: message.into() })
}

/// A request that passed the guards, split so later stages never re-parse.
#[derive(Clone, Debug)]
pub struct CheckedRequest {
    pub method: Method,
    /// Path without its query string.
    pub path: String,
    /// Raw query string without `?`, as the caller wrote it.
    pub query: Option<String>,
}

impl CheckedRequest {
    /// Path plus query, as audited and as appended to the base URL.
    pub fn target(&self) -> String {
        match &self.query {
            Some(q) => format!("{}?{q}", self.path),
            None => self.path.clone(),
        }
    }
}

const MAX_PATH_LEN: usize = 2048;

/// Headers a caller may send. Everything else is dropped by being refused.
const ALLOWED_HEADERS: [&str; 2] = ["accept", "content-type"];

/// Refused by name so the message can say why (a header the caller might try to
/// steer routing or authentication with).
const HOST_OVERRIDE_HEADERS: [&str; 10] = [
    "host",
    "x-forwarded-host",
    "x-forwarded-for",
    "x-forwarded-server",
    "x-forwarded-proto",
    "forwarded",
    "x-original-url",
    "x-rewrite-url",
    "x-host",
    "x-http-method-override",
];

/// Query parameter names refused for every service: a credential in a URL ends
/// up in logs, proxies and error text.
const CREDENTIAL_PARAMS: [&str; 6] = ["key", "token", "access_token", "api_key", "apikey", "api-key"];

pub fn check(
    spec: &ServiceSpec,
    method: &str,
    path: &str,
    headers: &[(String, String)],
    body_len: usize,
    limits: &Limits,
) -> Result<CheckedRequest, GuardError> {
    let Some(method) = Method::parse(method) else {
        return refuse("method", format!("method {method:?} is not allowed; use GET, POST, PUT, PATCH or DELETE"));
    };
    if method == Method::Get && body_len > 0 {
        return refuse("body", "a GET request cannot carry a body");
    }
    if body_len > limits.max_request_bytes {
        return refuse("request_too_large", format!("request body is {body_len} bytes, over the {} byte cap", limits.max_request_bytes));
    }
    check_headers(spec, headers)?;
    let (path_part, query) = split_path(path)?;
    check_path(spec, path_part)?;
    if let Some(q) = query {
        // An exact-path service (Linear's `/graphql`) takes its whole request in
        // the body; a query string could carry a second document that the
        // classified body does not describe.
        if !spec.path_prefix.ends_with('/') {
            return refuse("query", format!("{} takes no query string", spec.service.name()));
        }
        check_query(spec, q)?;
    }
    Ok(CheckedRequest { method, path: path_part.to_string(), query: query.map(str::to_string) })
}

fn split_path(path: &str) -> Result<(&str, Option<&str>), GuardError> {
    if path.is_empty() || path.len() > MAX_PATH_LEN {
        return refuse("path", "path must be 1 to 2048 characters");
    }
    if path.chars().any(|c| c.is_control() || c.is_whitespace() || c == '\\' || c == '#') {
        return refuse("path", "path cannot contain whitespace, control characters, a backslash or a fragment");
    }
    match path.split_once('?') {
        Some((p, q)) => Ok((p, Some(q))),
        None => Ok((path, None)),
    }
}

fn check_path(spec: &ServiceSpec, p: &str) -> Result<(), GuardError> {
    if !p.starts_with('/') || p.starts_with("//") {
        return refuse("path", "path must be relative to the service and start with a single '/'");
    }
    if p.contains("://") || p.contains('@') {
        return refuse("path", "path cannot name a host or carry credentials; give only the API path");
    }
    let lower = p.to_ascii_lowercase();
    for enc in ["%2e", "%2f", "%5c", "%00", "%25"] {
        if lower.contains(enc) {
            return refuse("path", format!("path cannot contain the encoded form {enc}"));
        }
    }
    if p.split('/').any(|seg| seg == "." || seg == "..") {
        return refuse("path", "path cannot contain '.' or '..' segments");
    }
    let prefix = spec.path_prefix;
    let inside = if prefix.ends_with('/') { p.starts_with(prefix) } else { p == prefix };
    if !inside {
        return refuse("path_prefix", format!("{} paths must start with {prefix}", spec.service.name()));
    }
    Ok(())
}

fn check_query(spec: &ServiceSpec, q: &str) -> Result<(), GuardError> {
    let reserved = spec.reserved_query();
    for pair in q.split('&').filter(|p| !p.is_empty()) {
        let name = pair.split_once('=').map(|(k, _)| k).unwrap_or(pair);
        let name = percent_decode_lossy(name).to_ascii_lowercase();
        if reserved.iter().any(|r| r.eq_ignore_ascii_case(&name)) || CREDENTIAL_PARAMS.contains(&name.as_str()) {
            return refuse("query", format!("query parameter {name:?} is set by the broker or looks like a credential"));
        }
    }
    Ok(())
}

fn check_headers(spec: &ServiceSpec, headers: &[(String, String)]) -> Result<(), GuardError> {
    for (name, value) in headers {
        let n = name.trim().to_ascii_lowercase();
        if HOST_OVERRIDE_HEADERS.contains(&n.as_str()) {
            return refuse("header", format!("header {n} would override where the request goes"));
        }
        if n == "authorization" || n == "cookie" || n == "proxy-authorization" || Some(n.as_str()) == spec.auth_header().map(|h| h.to_ascii_lowercase()).as_deref() {
            return refuse("header", format!("header {n} carries credentials, which the broker supplies itself"));
        }
        if !ALLOWED_HEADERS.contains(&n.as_str()) {
            return refuse("header", format!("header {n} is not allowed; only accept and content-type pass"));
        }
        if value.len() > 200 || value.chars().any(|c| c.is_control()) {
            return refuse("header", format!("header {n} has an unusable value"));
        }
    }
    Ok(())
}

/// Decodes `%XX`; bytes that are not valid stay as the replacement character.
fn percent_decode_lossy(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let (Some(h), Some(l)) = ((b[i + 1] as char).to_digit(16), (b[i + 2] as char).to_digit(16)) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(if b[i] == b'+' { b' ' } else { b[i] });
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Joins the base URL and the checked target and proves the result still points
/// at the table's host: same scheme, host and port, no userinfo. Defence in
/// depth behind `check`; a path that slipped a guard cannot change host here.
pub fn build_url(spec: &ServiceSpec, req: &CheckedRequest) -> Result<url::Url, GuardError> {
    let base = url::Url::parse(&spec.base_url).map_err(|e| GuardError { code: "config", message: format!("bad base url: {e}") })?;
    let full = url::Url::parse(&format!("{}{}", spec.base_url, req.target()))
        .map_err(|_| GuardError { code: "path", message: "path does not form a valid URL".into() })?;
    let same = full.scheme() == base.scheme()
        && full.host_str() == base.host_str()
        && full.port_or_known_default() == base.port_or_known_default()
        && full.username().is_empty()
        && full.password().is_none();
    if !same {
        return refuse("path", "request would leave the service host");
    }
    Ok(full)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::broker::services::{Service, ServiceTable};

    fn spec(s: Service) -> ServiceSpec {
        ServiceTable::production().get(s).unwrap().clone()
    }

    fn ok(s: Service, method: &str, path: &str) -> Result<CheckedRequest, GuardError> {
        check(&spec(s), method, path, &[], 0, &Limits::default())
    }

    #[test]
    fn a_plain_relative_path_passes_and_keeps_its_query() {
        let r = ok(Service::Shortcut, "get", "/api/v3/stories/123?includes_description=true").unwrap();
        assert_eq!(r.method, Method::Get);
        assert_eq!(r.path, "/api/v3/stories/123");
        assert_eq!(r.target(), "/api/v3/stories/123?includes_description=true");
    }

    #[test]
    fn absolute_urls_and_scheme_relative_paths_are_refused() {
        for p in ["https://evil.example/api/v3/x", "//evil.example/api/v3/x", "api/v3/stories", "/api/v3/@evil.example/x", "/api/v3/x://y"] {
            assert!(ok(Service::Shortcut, "GET", p).is_err(), "{p} should be refused");
        }
    }

    #[test]
    fn dot_segments_encoded_separators_and_odd_characters_are_refused() {
        for p in [
            "/api/v3/../../admin",
            "/api/v3/./stories",
            "/api/v3/%2e%2e/admin",
            "/api/v3/%2E%2E/admin",
            "/api/v3/stories%2f..%2fx",
            "/api/v3/stories%5c..",
            "/api/v3/stories%00",
            "/api/v3/%252e%252e/x",
            "/api/v3/stories/1#frag",
            "/api/v3/stories/1 2",
            "/api/v3/stories\\1",
            "/api/v3/stories/1\n",
            "",
        ] {
            assert!(ok(Service::Shortcut, "GET", p).is_err(), "{p:?} should be refused");
        }
    }

    #[test]
    fn a_path_outside_the_service_prefix_is_refused() {
        assert_eq!(ok(Service::Shortcut, "GET", "/other/thing").unwrap_err().code, "path_prefix");
        assert_eq!(ok(Service::Trello, "GET", "/2/cards/1").unwrap_err().code, "path_prefix");
        assert!(ok(Service::Trello, "GET", "/1/cards/1").is_ok());
        // Linear's prefix is exact, not a family.
        assert!(ok(Service::Linear, "POST", "/graphql").is_ok());
        assert_eq!(ok(Service::Linear, "POST", "/graphql/extra").unwrap_err().code, "path_prefix");
        assert_eq!(ok(Service::Linear, "POST", "/graphqlx").unwrap_err().code, "path_prefix");
    }

    #[test]
    fn an_exact_path_service_takes_no_query_string() {
        assert_eq!(ok(Service::Linear, "POST", "/graphql?query=%7Bviewer%7Bid%7D%7D").unwrap_err().code, "query");
        assert!(ok(Service::Linear, "POST", "/graphql").is_ok());
    }

    #[test]
    fn credential_looking_and_owned_query_parameters_are_refused() {
        assert_eq!(ok(Service::Trello, "GET", "/1/cards/1?key=abc").unwrap_err().code, "query");
        assert!(ok(Service::Trello, "GET", "/1/cards/1?%74oken=abc").is_err(), "an encoded name is decoded first");
        assert!(ok(Service::Figma, "GET", "/v1/files/x?access_token=abc").is_err());
        assert!(ok(Service::Trello, "GET", "/1/cards/1?fields=name&members=true").is_ok());
    }

    #[test]
    fn only_methods_the_broker_knows_pass_and_a_get_has_no_body() {
        assert!(ok(Service::Figma, "TRACE", "/v1/files/x").is_err());
        assert!(ok(Service::Figma, "CONNECT", "/v1/files/x").is_err());
        assert!(check(&spec(Service::Figma), "GET", "/v1/files/x", &[], 5, &Limits::default()).is_err());
        assert!(check(&spec(Service::Figma), "POST", "/v1/files/x", &[], 5, &Limits::default()).is_ok());
    }

    #[test]
    fn the_request_size_cap_is_enforced() {
        let limits = Limits { max_request_bytes: 10, ..Limits::default() };
        assert!(check(&spec(Service::Shortcut), "POST", "/api/v3/stories", &[], 10, &limits).is_ok());
        let e = check(&spec(Service::Shortcut), "POST", "/api/v3/stories", &[], 11, &limits).unwrap_err();
        assert_eq!(e.code, "request_too_large");
    }

    #[test]
    fn host_override_credential_and_unknown_headers_are_refused() {
        let s = spec(Service::Shortcut);
        let h = |n: &str| vec![(n.to_string(), "x".to_string())];
        for name in ["Host", "X-Forwarded-Host", "X-Original-URL", "Forwarded", "X-HTTP-Method-Override", "Authorization", "Cookie", "Shortcut-Token", "X-Custom"] {
            assert!(check(&s, "GET", "/api/v3/stories/1", &h(name), 0, &Limits::default()).is_err(), "{name} should be refused");
        }
        assert!(check(&s, "GET", "/api/v3/stories/1", &h("Accept"), 0, &Limits::default()).is_ok());
        assert!(check(&s, "POST", "/api/v3/stories", &h("content-type"), 2, &Limits::default()).is_ok());
        // The Figma auth header is refused for Figma, and only for Figma.
        let f = spec(Service::Figma);
        assert!(check(&f, "GET", "/v1/files/x", &h("X-Figma-Token"), 0, &Limits::default()).is_err());
    }

    #[test]
    fn build_url_stays_on_the_table_host() {
        let s = spec(Service::Clockify);
        let r = ok(Service::Clockify, "GET", "/api/v1/user").unwrap();
        let u = build_url(&s, &r).unwrap();
        assert_eq!(u.host_str(), Some("api.clockify.me"));
        assert_eq!(u.as_str(), "https://api.clockify.me/api/v1/user");
        // A hand-built request that bypassed `check` still cannot change host.
        let evil = CheckedRequest { method: Method::Get, path: "@evil.example/x".into(), query: None };
        assert!(build_url(&s, &evil).is_err());
    }
}
