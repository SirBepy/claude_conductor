//! The broker engine: one entry point, `Engine::call`, that makes a single
//! authenticated API call for a chat and returns a masked result. The chat names
//! a service, a method, a relative path and a body; the engine adds the host and
//! the secret, and nothing it hands back can contain the secret.
//!
//! Order of every call (each step can end it, and every ending is audited):
//!
//! 1. unknown service, empty session, then `guards::check` (path, query,
//!    headers, sizes, method);
//! 2. Linear only: the body must be a `{query, variables}` document the narrow
//!    reader in `graphql.rs` can classify;
//! 3. the injected `Policy` (step 3b brings the real one) allows the call,
//!    possibly with `require_owner`;
//! 4. the secret is read from the protected store, else `.env`;
//! 5. `require_owner`: the target object is fetched with the same secret and
//!    must be Joe's (`ownership.rs`);
//! 6. the request is sent (redirects off, response size capped);
//! 7. the status, every header, the body and any error text go through the
//!    `Masker` built from every secret the call carried (including a Hubstaff
//!    access token and a rotated refresh token).
//!
//! The secret is read after the policy answers, so a denied call never touches
//! the store.

use super::audit::{AuditEntry, AuditLog};
use super::carry::CarryTracker;
use super::graphql::{self, GqlKind, GqlRequest};
use super::guards::{self, CheckedRequest, Limits, Method};
use super::mask::Masker;
use super::ownership;
use super::policy::{Policy, PolicyDecision, PolicyRequest};
use super::services::{AuthShape, Service, ServiceSpec, ServiceTable};
use super::store::SecretSource;
use reqwest::header::{HeaderName, HeaderValue};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

mod oauth;
mod owner;
#[cfg(test)]
mod tests;
mod transport;

use oauth::CachedAccess;
use transport::{header_name, sent_hint, Auth, SendError};

/// One call, as a front hands it over. There is no host, scheme or credential
/// field: those come from the service table and the store.
#[derive(Debug, Clone)]
pub struct BrokerRequest {
    pub session: String,
    pub service: String,
    pub method: String,
    /// Relative to the service host, e.g. `/api/v3/stories/123`; may carry a query.
    pub path: String,
    pub body: Option<Value>,
    /// Only `accept` and `content-type` pass the guards. The body is always sent
    /// as JSON, so a `content-type` value is checked and then not used.
    pub headers: Vec<(String, String)>,
    /// The services the calling session is bound to (`session::SessionClaims::request`
    /// fills it from a verified token). `None` is an unscoped call, which only
    /// in-process code that never sees a chat's input may make; a service
    /// outside `Some(list)` is refused and audited before anything else runs.
    pub bound_services: Option<Vec<Service>>,
    /// The caller wants the raw response bytes for a file (the HTTP front's binary
    /// `out_file`). Honoured only for a GET on a named download path
    /// (`services::is_download_path`); anything else is refused. A 2xx answer then
    /// comes back unmasked in `BrokerResponse::raw` and the audit line says so.
    pub download: bool,
}

impl BrokerRequest {
    pub fn new(session: &str, service: &str, method: &str, path: &str, body: Option<Value>) -> Self {
        Self {
            session: session.into(),
            service: service.into(),
            method: method.into(),
            path: path.into(),
            body,
            headers: Vec::new(),
            bound_services: None,
            download: false,
        }
    }
}

/// A completed call. Everything in it has been masked. An upstream 4xx or 5xx is
/// still a response; the front decides what `ok` means for it.
#[derive(Debug, Clone)]
pub struct BrokerResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    /// UTF-8 text; bytes that are not valid UTF-8 come back as the replacement
    /// character. Empty when `raw` holds the body.
    pub body: String,
    /// The response bytes exactly as the service sent them, NOT masked. Set only
    /// for a 2xx answer to a `download` request (see `BrokerRequest::download`);
    /// the caller writes them to a file and never shows them to a chat.
    pub raw: Option<Vec<u8>>,
    /// The audit line could not be written. The call itself went through.
    pub audit_failed: bool,
}

/// A call the engine refused or could not complete. `message` and `hint` are
/// masked and safe to show a chat.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BrokerError {
    pub code: &'static str,
    pub message: String,
    pub hint: Option<String>,
}

/// What `call` fills in as it goes, for the audit line and error masking.
struct Ctx {
    service: String,
    method: String,
    path: String,
    status: Option<u16>,
    outcome: &'static str,
    reason: Option<String>,
    /// Facts that must survive a later failure overwriting `reason` (a rotated
    /// Hubstaff token that could not be stored).
    notes: Vec<String>,
    req_bytes: usize,
    resp_bytes: usize,
    masker: Option<Arc<Masker>>,
    /// The body left as raw bytes (a binary download), so the audit line says it was not masked.
    unmasked: bool,
}

impl Ctx {
    fn mask(&self, s: &str) -> String {
        match &self.masker {
            Some(m) => m.mask_str(s),
            None => s.to_string(),
        }
    }

    fn audit_reason(&self) -> Option<String> {
        match (&self.reason, self.notes.is_empty()) {
            (r, true) => r.clone(),
            (Some(r), false) => Some(format!("{r}; {}", self.notes.join("; "))),
            (None, false) => Some(self.notes.join("; ")),
        }
    }

    fn fail(&mut self, outcome: &'static str, code: &'static str, message: impl Into<String>, hint: Option<String>) -> BrokerError {
        let message = self.mask(&message.into());
        self.outcome = outcome;
        self.reason = Some(format!("{code}: {}", truncate(&message, 300)));
        BrokerError { code, hint: hint.map(|h| self.mask(&h)), message }
    }
}

fn truncate(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

pub struct Engine {
    table: ServiceTable,
    secrets: Arc<dyn SecretSource>,
    policy: Arc<dyn Policy>,
    audit: AuditLog,
    client: reqwest::Client,
    limits: Limits,
    /// Hubstaff access tokens, per process. Async so a refresh is serialized:
    /// two calls racing would spend the one-use refresh token twice.
    tokens: tokio::sync::Mutex<HashMap<Service, CachedAccess>>,
    /// The caller's own id per service (Shortcut member, Linear viewer).
    me: Mutex<HashMap<Service, String>>,
    /// Refuse a request with no `bound_services`. The daemon's one engine sets it
    /// (`require_scope`), so a front that forgets `SessionClaims::request` fails
    /// closed instead of making an unscoped call.
    require_scope: bool,
    /// What each chat's reads answered, so a write repeating it into another service is held
    /// to a `carry_from` row (`carry.rs`).
    carry: CarryTracker,
    /// The values of every secret in the store, for the masker (`stored_secret_values`).
    stored: Mutex<Option<(Instant, Arc<Vec<String>>)>>,
    /// Counts the changes to the store under the engine (`forget_service`, a rotated refresh token); a
    /// read that began before the latest one never writes its older snapshot into `stored`.
    stored_gen: AtomicU64,
    /// The cached Hubstaff access and refresh tokens, mirrored in a plain mutex so a call to another
    /// service masks them without waiting on `tokens`, which a Hubstaff refresh holds across its request.
    memory_secrets: Mutex<HashMap<Service, Vec<String>>>,
}

/// How long the stored values are reused before the store is read again. A card clears them at once;
/// this bounds how long a token added by hand (the Settings page, an edited `.env`) goes unmasked.
const STORED_TTL: Duration = Duration::from_secs(120);

impl Engine {
    pub fn new(
        table: ServiceTable,
        secrets: Arc<dyn SecretSource>,
        policy: Arc<dyn Policy>,
        audit: AuditLog,
        limits: Limits,
    ) -> Result<Self, String> {
        // Redirects are never followed: a service that answers 3xx hands the
        // `Location` back (masked) instead of the secret following it.
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(limits.timeout)
            .user_agent("cc-conductor-broker")
            // A stock client would follow redirects and forward custom auth
            // headers (`Shortcut-Token`, `X-Api-Key`) across hosts, so a build
            // failure is an error, never a fallback.
            .build()
            .map_err(|e| format!("broker http client could not be built: {e}"))?;
        Ok(Self::with_client(table, secrets, policy, audit, limits, client))
    }

    /// For tests that need a client with no proxy; the client must not follow redirects.
    pub fn with_client(
        table: ServiceTable,
        secrets: Arc<dyn SecretSource>,
        policy: Arc<dyn Policy>,
        audit: AuditLog,
        limits: Limits,
        client: reqwest::Client,
    ) -> Self {
        Self { table, secrets, policy, audit, client, limits, tokens: Default::default(), me: Default::default(), require_scope: false, carry: CarryTracker::default(), stored: Default::default(), stored_gen: AtomicU64::new(0), memory_secrets: Default::default() }
    }

    /// Every other secret in the store, read at most once per [`STORED_TTL`]. A response can quote a
    /// token of another service (Joe's Linear key pasted into a Shortcut story), and the masker built
    /// from the called service alone would hand it to the chat as it is. A name that is not stored is
    /// skipped; a read that fails is skipped too, but then nothing is cached, so the next call reads
    /// again instead of trusting an empty answer for [`STORED_TTL`]. The call's own secrets are read,
    /// and checked, apart.
    fn stored_secret_values(&self) -> Arc<Vec<String>> {
        if let Some((at, values)) = &*self.stored.lock().unwrap() {
            if at.elapsed() < STORED_TTL {
                return values.clone();
            }
        }
        let generation = self.stored_gen.load(Ordering::SeqCst);
        let mut complete = true;
        let values: Vec<String> = crate::api_keys::REGISTRY
            .iter()
            .filter_map(|e| match self.secrets.get(e.env_name) {
                Ok(v) => v,
                Err(_) => {
                    complete = false;
                    None
                }
            })
            .collect();
        let values = Arc::new(values);
        let mut slot = self.stored.lock().unwrap();
        // A card that stored a token while this read ran bumped the generation: this snapshot may predate it.
        if complete && self.stored_gen.load(Ordering::SeqCst) == generation {
            *slot = Some((Instant::now(), values.clone()));
        }
        values
    }

    /// Forgets the cached snapshot of the store and makes any read still running drop its result.
    fn invalidate_stored(&self) {
        self.stored_gen.fetch_add(1, Ordering::SeqCst);
        *self.stored.lock().unwrap() = None;
    }

    /// Makes an unscoped request (`bound_services: None`) a refusal.
    pub fn require_scope(mut self) -> Self {
        self.require_scope = true;
        self
    }

    /// Drops what the engine remembered about `service` from the token that was in the
    /// store: the cached Hubstaff access token and the caller's own id. The add/replace
    /// card calls it after storing a new token, so the next call authenticates as the
    /// new account instead of the cached one.
    pub async fn forget_service(&self, service: Service) {
        self.me.lock().unwrap().remove(&service);
        // Both go under the `tokens` guard: a refresh that runs between them would otherwise leave its
        // token cached with no mirror entry, and unmasked in other services' responses.
        let mut cached = self.tokens.lock().await;
        cached.remove(&service);
        self.memory_secrets.lock().unwrap().remove(&service);
        drop(cached);
        // A card just stored a token: the next call masks it too, and the one it replaced no longer matters.
        self.invalidate_stored();
    }

    pub async fn call(&self, req: BrokerRequest) -> Result<BrokerResponse, BrokerError> {
        let mut ctx = Ctx {
            service: truncate(&req.service, 40),
            method: truncate(&req.method.to_ascii_uppercase(), 10),
            path: truncate(&req.path, 300),
            status: None,
            outcome: "error",
            reason: None,
            notes: Vec::new(),
            req_bytes: 0,
            resp_bytes: 0,
            masker: None,
            unmasked: false,
        };
        let result = self.call_inner(&req, &mut ctx).await;
        let entry = AuditEntry {
            session: truncate(&req.session, 80),
            service: ctx.service.clone(),
            method: ctx.method.clone(),
            path: ctx.mask(&ctx.path),
            status: ctx.status,
            outcome: ctx.outcome,
            reason: ctx.audit_reason(),
            req_bytes: ctx.req_bytes,
            resp_bytes: ctx.resp_bytes,
            unmasked: ctx.unmasked,
        };
        let audit_failed = match self.audit.record(&entry) {
            Ok(_) => false,
            Err(e) => {
                log::error!("[broker] audit line not written: {e}");
                true
            }
        };
        result.map(|mut r| {
            r.audit_failed = audit_failed;
            r
        })
    }

    async fn call_inner(&self, req: &BrokerRequest, ctx: &mut Ctx) -> Result<BrokerResponse, BrokerError> {
        let Some(service) = Service::parse(&req.service) else {
            let known = Service::ALL.map(|s| s.name()).join(", ");
            return Err(ctx.fail("denied_guard", "unknown_service", format!("unknown service {:?}; known services: {known}", truncate(&req.service, 40)), None));
        };
        ctx.service = service.name().to_string();
        if req.session.trim().is_empty() {
            return Err(ctx.fail("denied_guard", "no_session", "a broker call needs the calling session's id", None));
        }
        if req.bound_services.is_none() && self.require_scope {
            return Err(ctx.fail("denied_scope", "no_scope", "this request carries no session scope; a front builds chat requests with SessionClaims::request", None));
        }
        if let Some(bound) = &req.bound_services {
            if !bound.contains(&service) {
                return Err(ctx.fail(
                    "denied_scope",
                    "service_not_bound",
                    format!("{} is not bound to this chat's project", service.name()),
                    Some(super::binding::binding_hint(service, bound)),
                ));
            }
        }
        let spec = self.table.get(service).ok_or_else(|| ctx.fail("error", "config", "service has no table entry", None))?;
        let body_bytes: Option<Vec<u8>> = match &req.body {
            Some(b) => Some(serde_json::to_vec(b).map_err(|e| ctx.fail("denied_guard", "body", format!("body is not JSON: {e}"), None))?),
            None => None,
        };
        ctx.req_bytes = body_bytes.as_ref().map_or(0, Vec::len);
        let checked = guards::check(spec, &req.method, &req.path, &req.headers, ctx.req_bytes, &self.limits)
            .map_err(|g| ctx.fail("denied_guard", g.code, g.message, None))?;
        ctx.method = checked.method.as_str().to_string();
        ctx.path = checked.target();

        // Raw bytes leave the engine unmasked, so only a GET on a path the table names
        // as a download may ask for them; the check runs before the policy and any secret read.
        if req.download && (checked.method != Method::Get || !super::services::is_download_path(service, &checked.path)) {
            return Err(ctx.fail("denied_guard", "not_a_download_path", "a binary download is allowed only for a GET on a named download path", Some(super::services::download_hint())));
        }

        if matches!(spec.auth, AuthShape::OauthRefresh { .. }) && !self.secrets.can_rotate() {
            return Err(ctx.fail(
                "error",
                "pc_only",
                format!("{} is PC only: its refresh token rotates on every use and is never copied between machines", service.name()),
                None,
            ));
        }

        let gql = if service == Service::Linear {
            Some(self.read_linear_body(&checked, req.body.as_ref()).map_err(|(code, msg)| ctx.fail("denied_guard", code, msg, None))?)
        } else {
            None
        };

        let (read, linear_op) = match &gql {
            Some(g) => match &g.kind {
                GqlKind::Query => (true, None),
                GqlKind::Mutation { field, .. } => (false, Some(field.as_str())),
                GqlKind::Unsupported(_) => unreachable!("read_linear_body rejects Unsupported"),
            },
            None => (checked.method == Method::Get, None),
        };
        // A read changes nothing, so it carries nothing anywhere; only a write is asked where its text came from.
        let carried = if read { Vec::new() } else { self.carry.carried(&req.session, service, req.body.as_ref(), checked.query.as_deref()) };
        let decision = self.policy.decide(&PolicyRequest {
            session: &req.session,
            service,
            method: checked.method,
            path: &checked.path,
            query: checked.query.as_deref(),
            read,
            linear_op,
            carried: &carried,
        });
        let require_owner = match decision {
            PolicyDecision::Allow { require_owner } => require_owner,
            PolicyDecision::Deny { reason, hint } => return Err(ctx.fail("denied_policy", "policy_denied", reason, hint)),
        };

        // Secrets are read only now, after the policy said yes.
        let mut values: Vec<(&'static str, String)> = Vec::new();
        for name in spec.secret_names() {
            match self.secrets.get(name) {
                Ok(Some(v)) => values.push((name, v)),
                Ok(None) => {
                    return Err(ctx.fail(
                        "no_secret",
                        "no_secret",
                        format!("{} has no stored token ({name}); Joe adds it with the API keys add/replace card", service.name()),
                        None,
                    ))
                }
                Err(e) => return Err(ctx.fail("no_secret", "secret_unreadable", format!("{name} cannot be read: {e}"), None)),
            }
        }
        let value_of = |n: &str| values.iter().find(|(k, _)| *k == n).map(|(_, v)| v.clone()).unwrap_or_default();
        let mut mask_values: Vec<String> = values.iter().map(|(_, v)| v.clone()).collect();
        mask_values.extend(self.stored_secret_values().iter().filter(|v| !mask_values.contains(v)).cloned().collect::<Vec<_>>());
        // A Hubstaff access token lives only in memory, so the store snapshot never holds it.
        for v in self.memory_secrets.lock().unwrap().values().flatten() {
            if !v.is_empty() && !mask_values.contains(v) {
                mask_values.push(v.clone());
            }
        }
        ctx.masker = Some(Arc::new(Masker::new(&mask_values)));

        let auth = match &spec.auth {
            AuthShape::Header { name, prefix, store_key } => Auth {
                headers: vec![(header_name(name).map_err(|m| ctx.fail("error", "config", m, None))?, format!("{prefix}{}", value_of(store_key)))],
                query: Vec::new(),
            },
            AuthShape::Query { params } => {
                Auth { headers: Vec::new(), query: params.iter().map(|(p, s)| (p.to_string(), value_of(s))).collect() }
            }
            AuthShape::OauthRefresh { exchange_url, refresh_store_key, user_agent } => {
                let access = self
                    .oauth_access(service, exchange_url, user_agent, refresh_store_key, &value_of(refresh_store_key), &mut mask_values, ctx)
                    .await;
                // The access token and any rotated refresh token are secrets too.
                ctx.masker = Some(Arc::new(Masker::new(&mask_values)));
                let access = access.map_err(|(code, msg)| ctx.fail("error", code, msg, None))?;
                Auth { headers: vec![(reqwest::header::AUTHORIZATION, format!("Bearer {access}"))], query: Vec::new() }
            }
        };

        if require_owner {
            self.check_owner(spec, service, &auth, &checked, gql.as_ref())
                .await
                .map_err(|(code, msg)| ctx.fail("denied_owner", code, msg, None))?;
        }

        let accept = req.headers.iter().find(|(n, _)| n.eq_ignore_ascii_case("accept")).map(|(_, v)| v.as_str());
        let up = match self.send(spec, &auth, &checked, body_bytes.as_deref(), accept).await {
            Ok(u) => u,
            Err(SendError::TooLarge) => {
                return Err(ctx.fail(
                    "error",
                    "response_too_large",
                    format!("response is over the {} byte cap", self.limits.max_response_bytes),
                    sent_hint(read),
                ))
            }
            Err(SendError::Net { message, timeout, sent }) => {
                let code = if timeout { "upstream_timeout" } else { "upstream_unreachable" };
                let hint = if sent { sent_hint(read) } else { None };
                return Err(ctx.fail("error", code, message, hint));
            }
        };
        ctx.status = Some(up.status);
        ctx.resp_bytes = up.body.len();
        ctx.outcome = if up.status >= 400 { "upstream_error" } else { "ok" };
        let masker = ctx.masker.clone().expect("masker is set before a request is sent");
        let headers = up.headers.iter().map(|(k, v)| (masker.mask_str(k), masker.mask_str(v))).collect();
        // An error body is text a chat may read, so it is masked like any other; only a
        // successful download keeps its bytes as they came.
        if req.download && (200..300).contains(&up.status) {
            ctx.unmasked = true;
            // A text file is read by the chat from disk, so it counts as an answer it holds; a binary
            // one is not UTF-8 and holds no text to repeat. Only hashes are kept, never the bytes.
            if let Ok(text) = std::str::from_utf8(&up.body) {
                self.carry.record(&req.session, service, text);
            }
            return Ok(BrokerResponse { status: up.status, headers, body: String::new(), raw: Some(up.body), audit_failed: false });
        }
        let body = String::from_utf8_lossy(&masker.mask_bytes(&up.body)).into_owned();
        // A Shortcut search is a POST to the engine (a write for the policy and the carry check) but
        // its answer is story text like any read's, so it is remembered too.
        let answers_a_read = read || (service == Service::Shortcut && checked.method == Method::Post && super::front::is_shortcut_search(&checked.path));
        if answers_a_read && (200..300).contains(&up.status) {
            self.carry.record(&req.session, service, &body);
        }
        Ok(BrokerResponse { status: up.status, headers, body, raw: None, audit_failed: false })
    }

    /// Linear takes `POST /graphql` with one classifiable document. The failure
    /// is `(code, message)` for `Ctx::fail`.
    fn read_linear_body(&self, checked: &CheckedRequest, body: Option<&Value>) -> Result<GqlRequest, (&'static str, String)> {
        if checked.method != Method::Post {
            return Err(("graphql_method", "Linear takes POST /graphql".into()));
        }
        let body = body.ok_or(("graphql_body", "Linear needs a body: {\"query\": ..., \"variables\": {...}}".to_string()))?;
        let g = graphql::parse_body(body).map_err(|m| ("graphql_body", m))?;
        if let GqlKind::Unsupported(why) = &g.kind {
            return Err((
                "graphql_unsupported",
                format!("this GraphQL document cannot be classified, so it is refused: {why}. Send one query, or one mutation whose arguments are all variables"),
            ));
        }
        Ok(g)
    }
}
