//! The services the broker can call, in code (not in a file a chat could edit):
//! the host each one lives on, the path prefix a call may reach, and how its
//! secret is attached to a request.
//!
//! A chat names a service and a path; it never supplies a host, a scheme or an
//! auth header. The host in this table is the only place a request can go.

use std::collections::HashMap;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Service {
    Shortcut,
    Linear,
    Trello,
    Figma,
    Clockify,
    Hubstaff,
}

impl Service {
    pub const ALL: [Service; 6] =
        [Service::Shortcut, Service::Linear, Service::Trello, Service::Figma, Service::Clockify, Service::Hubstaff];

    /// The name a chat, a policy row and an audit line use.
    pub fn name(self) -> &'static str {
        match self {
            Service::Shortcut => "shortcut",
            Service::Linear => "linear",
            Service::Trello => "trello",
            Service::Figma => "figma",
            Service::Clockify => "clockify",
            Service::Hubstaff => "hubstaff",
        }
    }

    pub fn parse(name: &str) -> Option<Service> {
        Service::ALL.into_iter().find(|s| s.name() == name.trim().to_ascii_lowercase())
    }
}

/// How the secret reaches the upstream request.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AuthShape {
    /// `<name>: <prefix><secret>`.
    Header { name: &'static str, prefix: &'static str, store_key: &'static str },
    /// `?<param>=<secret>` for each pair, appended by the engine.
    Query { params: &'static [(&'static str, &'static str)] },
    /// A long-lived refresh token exchanged at `token_url` for a short access
    /// token sent as `Authorization: Bearer`. The refresh token rotates: every
    /// exchange returns a new one, which replaces the stored one.
    OauthRefresh { exchange_url: String, refresh_store_key: &'static str, user_agent: &'static str },
}

#[derive(Clone, Debug)]
pub struct ServiceSpec {
    pub service: Service,
    /// `scheme://host[:port]`, no path. Tests point it at a local mock.
    pub base_url: String,
    /// Every request path must start with this (the API's own version prefix),
    /// so a call cannot wander to another endpoint family on the same host.
    pub path_prefix: &'static str,
    pub auth: AuthShape,
}

impl ServiceSpec {
    /// Registry names (`api_keys::REGISTRY`) of every secret this service's
    /// requests can carry, so the masker covers all of them.
    pub fn secret_names(&self) -> Vec<&'static str> {
        match &self.auth {
            AuthShape::Header { store_key, .. } => vec![store_key],
            AuthShape::Query { params } => params.iter().map(|(_, s)| *s).collect(),
            AuthShape::OauthRefresh { refresh_store_key, .. } => vec![refresh_store_key],
        }
    }

    /// Query parameter names the caller may not set because the engine owns them.
    pub fn reserved_query(&self) -> Vec<&'static str> {
        match &self.auth {
            AuthShape::Query { params } => params.iter().map(|(p, _)| *p).collect(),
            _ => Vec::new(),
        }
    }

    /// Header names the engine owns for this service.
    pub fn auth_header(&self) -> Option<&'static str> {
        match &self.auth {
            AuthShape::Header { name, .. } => Some(name),
            AuthShape::OauthRefresh { .. } => Some("authorization"),
            AuthShape::Query { .. } => None,
        }
    }
}

/// The paths a binary `out_file` may be fetched from, per service. A `*` stands for exactly one
/// non-empty path segment. A binary body is written unmasked, so this list is the whole
/// door: a new download endpoint is a row here and a test, never a pattern the chat supplies.
///
/// UNVERIFIED against the live service: the Trello row is the documented attachment download
/// shape; no download was run against api.trello.com.
pub const DOWNLOAD_PATHS: &[(Service, &str)] = &[(Service::Trello, "/1/cards/*/attachments/*/download/*")];

/// True when `path` (query ignored) is one of the named download paths of `service`.
pub fn is_download_path(service: Service, path: &str) -> bool {
    let path = path.split('?').next().unwrap_or("");
    DOWNLOAD_PATHS.iter().filter(|(s, _)| *s == service).any(|(_, pattern)| {
        let want: Vec<&str> = pattern.split('/').collect();
        let got: Vec<&str> = path.split('/').collect();
        want.len() == got.len() && want.iter().zip(&got).all(|(w, g)| if *w == "*" { !g.is_empty() } else { w == g })
    })
}

/// What a refused download tells the chat.
pub fn download_hint() -> String {
    let list = DOWNLOAD_PATHS.iter().map(|(s, p)| format!("{} {p}", s.name())).collect::<Vec<_>>().join("; ");
    format!("named download paths (a binary file is saved only from these): {list}. For a JSON or text response send the call without download and use out_file for the masked text")
}

/// Browser-like agent for `account.hubstaff.com`: it sits behind Cloudflare,
/// which refuses default library agents with `403 error code: 1010` (the same
/// 403 a revoked token would give, so a wrong agent reads as a dead token).
pub const HUBSTAFF_USER_AGENT: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

/// The set of services one engine serves.
#[derive(Clone, Debug)]
pub struct ServiceTable {
    specs: HashMap<Service, ServiceSpec>,
}

impl ServiceTable {
    /// The real hosts.
    pub fn production() -> Self {
        let mk = |service, base: &str, path_prefix, auth| ServiceSpec { service, base_url: base.to_string(), path_prefix, auth };
        let specs = [
            mk(
                Service::Shortcut,
                "https://api.app.shortcut.com",
                "/api/v3/",
                AuthShape::Header { name: "Shortcut-Token", prefix: "", store_key: "SHORTCUT_API_TOKEN" },
            ),
            // Linear takes the raw key, no `Bearer`, for a personal API key.
            mk(
                Service::Linear,
                "https://api.linear.app",
                "/graphql",
                AuthShape::Header { name: "Authorization", prefix: "", store_key: "LINEAR_API_KEY" },
            ),
            mk(
                Service::Trello,
                "https://api.trello.com",
                "/1/",
                AuthShape::Query { params: &[("key", "TRELLO_API_KEY"), ("token", "TRELLO_TOKEN")] },
            ),
            mk(
                Service::Figma,
                "https://api.figma.com",
                "/v1/",
                AuthShape::Header { name: "X-Figma-Token", prefix: "", store_key: "FIGMA_TOKEN" },
            ),
            mk(
                Service::Clockify,
                "https://api.clockify.me",
                "/api/v1/",
                AuthShape::Header { name: "X-Api-Key", prefix: "", store_key: "CLOCKIFY_API_KEY" },
            ),
            mk(
                Service::Hubstaff,
                "https://api.hubstaff.com",
                "/v2/",
                AuthShape::OauthRefresh {
                    exchange_url: "https://account.hubstaff.com/access_tokens".to_string(),
                    refresh_store_key: "HUBSTAFF_REFRESH_TOKEN",
                    user_agent: HUBSTAFF_USER_AGENT,
                },
            ),
        ];
        Self { specs: specs.into_iter().map(|s| (s.service, s)).collect() }
    }

    /// Replaces one service's base URL (and, for an oauth service, nothing
    /// else): test seam so a mock server stands in for the host.
    pub fn with_base_url(mut self, service: Service, base_url: &str) -> Self {
        if let Some(s) = self.specs.get_mut(&service) {
            s.base_url = base_url.trim_end_matches('/').to_string();
        }
        self
    }

    /// Test seam for an oauth service's token endpoint.
    pub fn with_token_url(mut self, service: Service, url: &str) -> Self {
        if let Some(ServiceSpec { auth: AuthShape::OauthRefresh { exchange_url, .. }, .. }) = self.specs.get_mut(&service) {
            *exchange_url = url.to_string();
        }
        self
    }

    pub fn get(&self, service: Service) -> Option<&ServiceSpec> {
        self.specs.get(&service)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_service_has_a_spec_with_https_host_and_prefix() {
        let t = ServiceTable::production();
        for s in Service::ALL {
            let spec = t.get(s).unwrap_or_else(|| panic!("{} has no spec", s.name()));
            assert!(spec.base_url.starts_with("https://"), "{}: {}", s.name(), spec.base_url);
            assert!(!spec.base_url.trim_start_matches("https://").contains('/'), "base url has a path");
            assert!(spec.path_prefix.starts_with('/'));
        }
    }

    #[test]
    fn auth_shapes_match_each_service() {
        let t = ServiceTable::production();
        assert!(matches!(t.get(Service::Shortcut).unwrap().auth, AuthShape::Header { name: "Shortcut-Token", .. }));
        assert!(matches!(t.get(Service::Linear).unwrap().auth, AuthShape::Header { name: "Authorization", prefix: "", .. }));
        assert!(matches!(t.get(Service::Trello).unwrap().auth, AuthShape::Query { .. }));
        assert!(matches!(t.get(Service::Figma).unwrap().auth, AuthShape::Header { name: "X-Figma-Token", .. }));
        assert!(matches!(t.get(Service::Clockify).unwrap().auth, AuthShape::Header { name: "X-Api-Key", .. }));
        assert!(matches!(t.get(Service::Hubstaff).unwrap().auth, AuthShape::OauthRefresh { .. }));
    }

    #[test]
    fn every_secret_name_is_a_registry_row() {
        let t = ServiceTable::production();
        for s in Service::ALL {
            for n in t.get(s).unwrap().secret_names() {
                assert!(crate::api_keys::entry(n).is_some(), "{n} is not in api_keys::REGISTRY");
            }
        }
    }

    #[test]
    fn names_round_trip_and_unknown_is_none() {
        for s in Service::ALL {
            assert_eq!(Service::parse(s.name()), Some(s));
        }
        assert_eq!(Service::parse(" Shortcut "), Some(Service::Shortcut));
        assert_eq!(Service::parse("github"), None);
    }

    #[test]
    fn a_download_path_is_a_named_shape_for_its_own_service_only() {
        let p = "/1/cards/5f0/attachments/6a1/download/shot.png";
        assert!(is_download_path(Service::Trello, p));
        assert!(is_download_path(Service::Trello, &format!("{p}?x=1")), "the query is ignored");
        assert!(!is_download_path(Service::Figma, p), "another service's table has no such row");
        for bad in [
            "/1/cards/5f0/attachments/6a1/download",
            "/1/cards/5f0/attachments/6a1/download/",
            "/1/cards//attachments/6a1/download/x",
            "/1/cards/5f0/attachments/6a1/download/x/y",
            "/1/cards/5f0/attachments/6a1/downloads/x",
            "/2/cards/5f0/attachments/6a1/download/x",
            "/1/cards/5f0",
        ] {
            assert!(!is_download_path(Service::Trello, bad), "{bad}");
        }
        assert!(download_hint().contains("trello /1/cards/*/attachments/*/download/*"));
        for (s, pattern) in DOWNLOAD_PATHS {
            assert!(pattern.starts_with(ServiceTable::production().get(*s).unwrap().path_prefix.trim_end_matches('/')), "{pattern} is outside {}'s prefix", s.name());
        }
    }

    #[test]
    fn trello_owns_its_key_and_token_params() {
        let t = ServiceTable::production();
        assert_eq!(t.get(Service::Trello).unwrap().reserved_query(), vec!["key", "token"]);
        assert!(t.get(Service::Figma).unwrap().reserved_query().is_empty());
    }
}
