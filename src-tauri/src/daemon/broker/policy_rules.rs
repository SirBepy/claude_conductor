//! The rows of `broker-policy.json` and how they decide a call. Pure: no file, no
//! clock, so every rule is a plain test. The file side (load, hot reload, the one
//! write function) is `policy_file.rs`.
//!
//! A row is `{service, method, path, require_owner}` for an HTTP write, or
//! `{service: "linear", op, require_owner}` for a Linear mutation pinned by its
//! root field name (`LINEAR_OPS`). Rules the code holds:
//!
//! - Anything no row allows is denied, and the denial carries the exact row to add.
//! - A GET is open (on a service the chat is bound to; the binding is step 4's
//!   check, not the policy's), and so is a Linear query document. Shortcut's
//!   `POST /api/v3/search` is not a GET, so it is an explicit row in the seed.
//! - A path pattern is matched against the whole path, without its query string:
//!   `^(?:pattern)$` is what runs, so a pattern cannot match by prefix.
//! - Linear writes are exactly `LINEAR_OPS`. A row for any other operation is
//!   refused when the file loads, and a call for one is denied without a hint.
//! - When several rows allow a call, `require_owner` is true if any of them says so.
//! - A row for DELETE or a bulk endpoint loads (Joe can add one on purpose) but the
//!   seed never holds one.

use super::guards::Method;
use super::ownership;
use super::policy::{PolicyDecision, PolicyRequest};
use super::services::{Service, ServiceTable};
use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};

/// The only Linear mutations a row can allow, and whether a suggested row asks for
/// ownership. `issueCreate` has no existing issue to own.
pub const LINEAR_OPS: [(&str, bool); 3] = [("commentCreate", true), ("issueCreate", false), ("issueUpdate", true)];

fn yes() -> bool {
    true
}

/// One line of `broker-policy.json`. `require_owner` defaults to true, so a row
/// written without it asks for the stricter check.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PolicyRow {
    pub service: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub method: Option<String>,
    /// Regular expression over the whole path (no query string).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// Linear mutation root field.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub op: Option<String>,
    #[serde(default = "yes")]
    pub require_owner: bool,
    /// Free text for Joe; never read by the policy.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PolicyFile {
    #[serde(default)]
    pub version: u32,
    pub rows: Vec<PolicyRow>,
}

enum Matcher {
    Http { method: Method, re: Regex },
    LinearOp(String),
}

struct CompiledRow {
    service: Service,
    matcher: Matcher,
    require_owner: bool,
}

/// A compiled policy file.
pub struct Rules {
    rows: Vec<CompiledRow>,
}

/// What `Rules::evaluate` found. A denial keeps the row to add as data; the file
/// side words it, because only it knows the file's name.
pub enum Verdict {
    Allow { require_owner: bool },
    Deny { reason: String, add: Option<PolicyRow> },
}

impl Verdict {
    /// `file` is how the denial names the policy file (`broker-policy.json`).
    pub fn into_decision(self, file: &str) -> PolicyDecision {
        match self {
            Verdict::Allow { require_owner } => PolicyDecision::Allow { require_owner },
            Verdict::Deny { reason, add } => {
                let hint = add.map(|row| {
                    let line = serde_json::to_string(&row).unwrap_or_default();
                    format!("to allow this call, Joe adds this row to \"rows\" in {file} (the policy card writes it): {line}")
                });
                PolicyDecision::Deny { reason, hint }
            }
        }
    }
}

impl Rules {
    /// Fails on the first bad row, naming it by position, so a half-valid file
    /// is never applied: the caller keeps the last good policy instead.
    pub fn compile(file: &PolicyFile) -> Result<Rules, String> {
        let mut rows = Vec::with_capacity(file.rows.len());
        for (i, r) in file.rows.iter().enumerate() {
            rows.push(compile_row(r).map_err(|e| format!("row {}: {e}", i + 1))?);
        }
        Ok(Rules { rows })
    }

    pub fn len(&self) -> usize {
        self.rows.len()
    }

    pub fn is_empty(&self) -> bool {
        self.rows.is_empty()
    }

    pub fn evaluate(&self, req: &PolicyRequest<'_>) -> Verdict {
        if req.read {
            return Verdict::Allow { require_owner: false };
        }
        let allowed: Vec<&CompiledRow> = self.rows.iter().filter(|r| r.service == req.service && row_matches(r, req)).collect();
        if !allowed.is_empty() {
            return Verdict::Allow { require_owner: allowed.iter().any(|r| r.require_owner) };
        }
        if req.service == Service::Linear {
            if let Some(op) = req.linear_op {
                if !LINEAR_OPS.iter().any(|(o, _)| *o == op) {
                    let names: Vec<&str> = LINEAR_OPS.iter().map(|(o, _)| *o).collect();
                    return Verdict::Deny {
                        reason: format!("linear mutation {op} is not allowed: Linear writes are limited to {}, and no policy row can add another", names.join(", ")),
                        add: None,
                    };
                }
            }
        }
        Verdict::Deny {
            reason: format!("no policy row allows {} {}; a call that is not in the policy is denied", req.service.name(), describe(req)),
            add: Some(suggest_row(req)),
        }
    }
}

fn describe(req: &PolicyRequest<'_>) -> String {
    match req.linear_op {
        Some(op) => format!("mutation {op}"),
        None => format!("{} {}", req.method.as_str(), req.path),
    }
}

fn row_matches(row: &CompiledRow, req: &PolicyRequest<'_>) -> bool {
    match &row.matcher {
        Matcher::Http { method, re } => req.linear_op.is_none() && *method == req.method && re.is_match(req.path),
        Matcher::LinearOp(op) => req.linear_op == Some(op.as_str()),
    }
}

fn compile_row(r: &PolicyRow) -> Result<CompiledRow, String> {
    let service = Service::parse(&r.service).ok_or_else(|| format!("unknown service {:?}", r.service))?;
    match (&r.op, &r.method, &r.path) {
        (Some(op), None, None) => {
            if service != Service::Linear {
                return Err("an op row is only for linear".into());
            }
            if !LINEAR_OPS.iter().any(|(o, _)| o == op) {
                let names: Vec<&str> = LINEAR_OPS.iter().map(|(o, _)| *o).collect();
                return Err(format!("linear op {op:?} cannot be allowed; the only Linear writes are {}", names.join(", ")));
            }
            Ok(CompiledRow { service, matcher: Matcher::LinearOp(op.clone()), require_owner: r.require_owner })
        }
        (None, Some(m), Some(p)) => {
            if service == Service::Linear {
                return Err("linear writes are op rows ({\"service\":\"linear\",\"op\":...}), not method and path".into());
            }
            let method = Method::parse(m).ok_or_else(|| format!("unknown method {m:?}"))?;
            if p.is_empty() || p.len() > 400 {
                return Err("path must be 1 to 400 characters".into());
            }
            let re = RegexBuilder::new(&format!("^(?:{p})$"))
                .size_limit(200_000)
                .build()
                .map_err(|e| format!("path is not a valid pattern: {e}"))?;
            Ok(CompiledRow { service, matcher: Matcher::Http { method, re }, require_owner: r.require_owner })
        }
        _ => Err("a row is either {service, method, path} or {service, op}, nothing else".into()),
    }
}

/// The row that would allow `req`, for a denial to print. Ids in the path become
/// classes, and ownership is asked for exactly when the engine can check it
/// (a Shortcut story or epic, a Linear op with an issue).
pub fn suggest_row(req: &PolicyRequest<'_>) -> PolicyRow {
    if let (Service::Linear, Some(op)) = (req.service, req.linear_op) {
        let owner = LINEAR_OPS.iter().find(|(o, _)| *o == op).is_some_and(|(_, o)| *o);
        return PolicyRow { service: "linear".into(), method: None, path: None, op: Some(op.into()), require_owner: owner, note: None };
    }
    PolicyRow {
        service: req.service.name().into(),
        method: Some(req.method.as_str().into()),
        path: Some(path_shape(req.service, req.path)),
        op: None,
        require_owner: req.service == Service::Shortcut && ownership::shortcut_target(req.path).is_some(),
        note: None,
    }
}

/// `/api/v3/stories/123/comments` -> `^/api/v3/stories/\d+/comments$`. Same
/// shapes as `scripts/broker-seed-scan.mjs`: the service's own prefix (`/api/v3/`)
/// stays literal, then digits, uuids and 24-hex ids become classes, a plain
/// lowercase word stays, anything else matches one segment.
pub fn path_shape(service: Service, path: &str) -> String {
    let prefix = ServiceTable::production().get(service).map(|s| s.path_prefix).filter(|p| p.ends_with('/')).unwrap_or("/");
    let (lead, rest) = match path.strip_prefix(prefix) {
        Some(rest) => (prefix, rest),
        None => ("/", path),
    };
    let segs: Vec<String> = rest
        .split('/')
        .filter(|s| !s.is_empty())
        .map(|s| {
            let b = s.as_bytes();
            if b.iter().all(u8::is_ascii_digit) {
                "\\d+".to_string()
            } else if is_uuid(s) {
                "[0-9a-f-]{36}".to_string()
            } else if b.len() == 24 && b.iter().all(u8::is_ascii_hexdigit) {
                "[0-9a-f]{24}".to_string()
            } else if b.len() <= 24 && b[0].is_ascii_lowercase() && b.iter().all(|c| c.is_ascii_lowercase() || *c == b'_' || *c == b'-') {
                s.to_string()
            } else {
                "[^/]+".to_string()
            }
        })
        .collect();
    format!("^{lead}{}$", segs.join("/"))
}

fn is_uuid(s: &str) -> bool {
    let parts: Vec<&str> = s.split('-').collect();
    parts.len() == 5
        && [8, 4, 4, 4, 12].iter().zip(&parts).all(|(n, p)| p.len() == *n && p.bytes().all(|c| c.is_ascii_hexdigit()))
}
