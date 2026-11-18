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
//! - A write that repeats text the chat read from another service (`carry.rs` finds it, and
//!   `PolicyRequest::carried` lists those services) passes only when the rows allowing it name
//!   each such service in `carry_from`; the denial prints a row that does.
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

const MAX_ROW_PATH: usize = 4200;
/// A printed row for a 2048-byte path of 1000 `\d+` segments compiles to a few MB (a
/// Unicode `\d` is about 100 states), so a lower limit would refuse a row the card
/// itself printed. A hand-written blow-up like `((a{0,100}){0,100}){0,100}` still exceeds it.
const REGEX_SIZE_LIMIT: usize = 8_000_000;

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
    /// Services whose read answers a call under this row may carry text from. A write that
    /// repeats data read from another service is denied unless the rows allowing it name that
    /// service here (the data-carry rule, `carry.rs`). Empty means no cross-service data.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub carry_from: Vec<String>,
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
    carry_from: Vec<Service>,
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
            // The rows that allow the call together name the services it may carry data from.
            let missing: Vec<Service> =
                req.carried.iter().copied().filter(|s| !allowed.iter().any(|r| r.carry_from.contains(s))).collect();
            if !missing.is_empty() {
                let names: Vec<&str> = missing.iter().map(|s| s.name()).collect();
                return Verdict::Deny {
                    reason: format!(
                        "this {} call repeats text the chat read from {}; text from one service is not written into another unless a policy row names it in carry_from",
                        req.service.name(),
                        names.join(" and ")
                    ),
                    add: Some(suggest_row(req)),
                };
            }
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
    let carry_from = r
        .carry_from
        .iter()
        .map(|n| Service::parse(n).ok_or_else(|| format!("carry_from names unknown service {n:?}")))
        .collect::<Result<Vec<_>, _>>()?;
    match (&r.op, &r.method, &r.path) {
        (Some(op), None, None) => {
            if service != Service::Linear {
                return Err("an op row is only for linear".into());
            }
            if !LINEAR_OPS.iter().any(|(o, _)| o == op) {
                let names: Vec<&str> = LINEAR_OPS.iter().map(|(o, _)| *o).collect();
                return Err(format!("linear op {op:?} cannot be allowed; the only Linear writes are {}", names.join(", ")));
            }
            Ok(CompiledRow { service, matcher: Matcher::LinearOp(op.clone()), require_owner: r.require_owner, carry_from })
        }
        (None, Some(m), Some(p)) => {
            if service == Service::Linear {
                return Err("linear writes are op rows ({\"service\":\"linear\",\"op\":...}), not method and path".into());
            }
            let method = Method::parse(m).ok_or_else(|| format!("unknown method {m:?}"))?;
            // 4200 covers a printed row for the longest path the guards accept (2048),
            // even when every character is escaped.
            if p.is_empty() || p.len() > MAX_ROW_PATH {
                return Err(format!("path must be 1 to {MAX_ROW_PATH} characters"));
            }
            // The pattern must be a whole regex on its own: wrapped by string
            // formatting, an unbalanced `.*)|(.*` would close the group and match any path.
            RegexBuilder::new(p).size_limit(REGEX_SIZE_LIMIT).build().map_err(|e| format!("path is not a valid pattern: {e}"))?;
            let re = RegexBuilder::new(&format!("^(?:{p})$"))
                .size_limit(REGEX_SIZE_LIMIT)
                .build()
                .map_err(|e| format!("path is not a valid pattern: {e}"))?;
            Ok(CompiledRow { service, matcher: Matcher::Http { method, re }, require_owner: r.require_owner, carry_from })
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
        return PolicyRow { service: "linear".into(), method: None, path: None, op: Some(op.into()), require_owner: owner, carry_from: carried_names(req), note: None };
    }
    let path = path_shape(req.service, req.path);
    // A row that could cover a story or epic asks for the owner check even when the
    // engine cannot read an id from this call's path (`12x`, 19 digits, `%73tories`):
    // the engine then refuses for want of a target, instead of the wildcard row
    // opening every story. A pinned word (`search`, `from-template`) covers no story.
    let require_owner = req.service == Service::Shortcut
        && (ownership::shortcut_target(req.path).is_some() || row_could_cover_a_story_or_epic(req.path));
    PolicyRow {
        service: req.service.name().into(),
        method: Some(req.method.as_str().into()),
        path: Some(path),
        op: None,
        require_owner,
        carry_from: carried_names(req),
        note: None,
    }
}

/// The `carry_from` a printed row needs for `req` to pass: every service its data came from.
fn carried_names(req: &PolicyRequest<'_>) -> Vec<String> {
    req.carried.iter().map(|s| s.name().to_string()).collect()
}

/// Whether the row printed for `req_path` could cover a story or epic. Read from the
/// path's shape, the same way `path_shape` prints it, never by probing the pattern (a
/// probe misses a tail class such as a uuid):
/// - a collection with a digit prints as the wildcard `[^/]+` (`%73tories`, `a1`) and
///   could be `stories`: yes;
/// - a literal `stories` or `epics` (any case) pins the collection, so the object
///   segment decides: an id-like one (a digit, a uuid or 24-hex id) the engine cannot
///   read: yes, a pinned word (`search`, `from-template`) covers no story: no;
/// - anything else is a pinned other collection: no.
///
/// Fails closed when the path is not under the Shortcut prefix.
fn row_could_cover_a_story_or_epic(req_path: &str) -> bool {
    let Some(rest) = req_path.strip_prefix("/api/v3/") else { return true };
    let mut segs = rest.split('/');
    let collection = segs.next().unwrap_or("");
    // An empty collection (`/api/v3//stories/12`) could be collapsed to `/stories/12`
    // upstream, so it asks for the owner like a wildcard collection does.
    if collection.is_empty() || collection.bytes().any(|c| c.is_ascii_digit()) {
        return true;
    }
    if !["stories", "epics"].iter().any(|c| collection.eq_ignore_ascii_case(c)) {
        return false;
    }
    segs.find(|s| !s.is_empty()).is_some_and(|s| {
        s.bytes().any(|c| c.is_ascii_digit()) || is_uuid(s) || (s.len() == 24 && s.bytes().all(|c| c.is_ascii_hexdigit()))
    })
}

/// `/api/v3/stories/123/comments` -> `^/api/v3/stories/\d+/comments$`. Same
/// shapes as `scripts/broker-seed-scan.mjs`: the service's own prefix (`/api/v3/`)
/// stays literal, then digits, uuids and 24-hex ids become classes, a plain
/// lowercase word stays, anything else matches one segment.
pub fn path_shape(service: Service, path: &str) -> String {
    let prefix = ServiceTable::production().get(service).map(|s| s.path_prefix).filter(|p| p.ends_with('/')).unwrap_or("/");
    let (lead, rest) = match path.strip_prefix(prefix) {
        Some(rest) => (prefix, rest),
        None => ("/", path.strip_prefix('/').unwrap_or(path)),
    };
    // Empty segments (a trailing `/`, a `//`) are kept: the row has to match the
    // path as sent, or the retry after the card writes it is denied again.
    let segs: Vec<String> = rest
        .split('/')
        .map(|s| {
            let b = s.as_bytes();
            if b.is_empty() {
                return String::new();
            }
            let upper = b.iter().any(u8::is_ascii_uppercase);
            if b.iter().all(u8::is_ascii_digit) {
                "\\d+".to_string()
            } else if is_uuid(s) {
                (if upper { "[0-9a-fA-F-]{36}" } else { "[0-9a-f-]{36}" }).to_string()
            } else if b.len() == 24 && b.iter().all(u8::is_ascii_hexdigit) {
                (if upper { "[0-9a-fA-F]{24}" } else { "[0-9a-f]{24}" }).to_string()
            } else if b.len() <= 24 && b[0].is_ascii_lowercase() && b.iter().all(|c| c.is_ascii_lowercase() || *c == b'_' || *c == b'-') {
                s.to_string()
            } else if b.iter().any(u8::is_ascii_digit) {
                // Something id-like (a Figma file key, a slug with a number).
                "[^/]+".to_string()
            } else {
                // A name with no digit (`archiveAllCards`) is an action, not an id:
                // pin it, so one printed row never opens every sibling endpoint.
                regex::escape(s)
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
