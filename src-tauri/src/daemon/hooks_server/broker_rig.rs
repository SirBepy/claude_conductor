//! Shared rig for the broker's end-to-end tests (step 8). One in-process daemon: a real
//! `DaemonState` (token registry, session registry, the engine slot), the real hooks routes
//! (`/hooks/api-broker` for the MCP tools, `/hooks/api-broker-http` for scripts), the real policy
//! file and audit log, all under a private data folder (`CC_DATA_DIR`, so never the live one),
//! with a mock server standing in for the six services.
//!
//! What stands in for a model's session record: the daemon never writes the model's tool results
//! (the `claude` child does, in its own transcript), so the rig appends every answer it hands back
//! to a `session.jsonl` in the chat's folder in the shape of a `tool_result` line. A leak check then
//! reads exactly what the model would have stored.

use super::api_broker::on_api_broker;
use super::api_broker_http::on_api_broker_http;
use super::validated_json::ValidatedJson;
use super::HookCtx;
use crate::daemon::broker::front::testing::engine_with_secrets;
use crate::daemon::broker::services::Service;
use crate::daemon::broker::session::{Role, SessionClaims};
use crate::daemon::broker::store::testing::MemSecrets;
use crate::daemon::session::new_session_map;
use crate::daemon::settings_cache::SettingsCache;
use crate::daemon::state::DaemonState;
use crate::types::Settings;
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::{extract::State as AxState, response::IntoResponse};
use serde_json::{json, Value};
use std::cell::RefCell;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

thread_local! {
    /// The daemon the MCP relay stub posts to, set on the thread that runs one tool call.
    static ROUTE: RefCell<Option<Arc<HookCtx>>> = const { RefCell::new(None) };
}

/// The MCP child's `http_post`, answered by the route handler in-process.
fn route_post(rt: &tokio::runtime::Runtime, url: &str, body: Value) -> Result<Value, String> {
    let ctx = ROUTE.with(|r| r.borrow().clone()).ok_or("the relay stub has no daemon")?;
    assert!(url.ends_with("/hooks/api-broker"), "the broker tools post to one route, got {url}");
    rt.block_on(async move {
        let resp = on_api_broker(AxState(ctx), ValidatedJson(body)).await.into_response();
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.map_err(|e| e.to_string())?;
        serde_json::from_slice(&bytes).map_err(|e| e.to_string())
    })
}

/// A secret in every form a service might echo it back in.
pub(super) fn forms(secret: &str) -> Vec<String> {
    use base64::Engine as _;
    let url_form: String = url::form_urlencoded::byte_serialize(secret.as_bytes()).collect();
    let pct = url_form.replace('+', "%20");
    let std64 = base64::engine::general_purpose::STANDARD.encode(secret);
    let url64 = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(secret);
    let json_text = serde_json::to_string(secret).unwrap();
    let json_text = json_text.trim_matches('"').to_string();
    let hex: String = secret.bytes().map(|b| format!("{b:02x}")).collect();
    vec![secret.to_string(), url_form, pct, std64, url64, json_text, secret.replace('/', "\\/"), hex]
}

pub(super) struct Rig {
    pub ctx: Arc<HookCtx>,
    pub server: mockito::ServerGuard,
    /// The chat's own folder (`chat-a`'s cwd).
    pub project: tempfile::TempDir,
    /// The daemon's private data folder.
    pub data: PathBuf,
    pub secrets: Arc<MemSecrets>,
    /// Every answer handed back to a caller, as text.
    seen: Mutex<Vec<String>>,
    _env: crate::daemon::subchats::TempDataDir,
}

impl Rig {
    /// `base` overrides the mock server's address for every service (an unreachable one, say).
    pub async fn with(secrets: &[(&str, &str)], base: Option<&str>) -> Rig {
        let env = crate::daemon::subchats::TempDataDir::new();
        let server = mockito::Server::new_async().await;
        let project = tempfile::tempdir().unwrap();
        let data = crate::settings::paths::data_dir().unwrap();
        std::fs::create_dir_all(&data).unwrap();
        let ctx = Arc::new(HookCtx { state: DaemonState::new(new_session_map(), SettingsCache::new(Settings::default())) });
        let store = Arc::new(MemSecrets::with(secrets));
        let url = base.map(str::to_string).unwrap_or_else(|| server.url());
        ctx.state.install_broker_engine(Arc::new(engine_with_secrets(&url, &data, store.clone())));
        ctx.state.registry.upsert_interactive("chat-a", project.path(), "p1", "2026-11-18T00:00:00Z");
        Rig { ctx, server, project, data, secrets: store, seen: Mutex::new(Vec::new()), _env: env }
    }

    pub async fn new(secrets: &[(&str, &str)]) -> Rig {
        Rig::with(secrets, None).await
    }

    /// Mints the chat's launch claims, as `spawn_session` does, and returns the env token.
    pub fn token(&self, session: &str, services: &[Service]) -> String {
        self.ctx.state.broker_sessions.mint(SessionClaims::new(session, Role::Chat, services.to_vec())).expose().to_string()
    }

    pub fn policy_path(&self) -> PathBuf {
        self.data.join(crate::daemon::broker::policy_file::POLICY_FILE)
    }

    /// Adds a policy row the way the policy card does (the one write function).
    pub fn allow(&self, row: Value) {
        let row = serde_json::from_value(row).unwrap();
        crate::daemon::broker::policy_file::add_row(&self.policy_path(), row).unwrap();
    }

    fn record(&self, answer: &str) {
        self.seen.lock().unwrap().push(answer.to_string());
        let line = json!({"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "toolu_rig", "content": answer}]}});
        let mut f = std::fs::OpenOptions::new().create(true).append(true).open(self.project.path().join("session.jsonl")).unwrap();
        writeln!(f, "{line}").unwrap();
    }

    /// One MCP tool call, from the model's side: the real `tools/call` routing, relayed to the real
    /// route. Returns the JSON-RPC answer the model's client would store.
    pub async fn mcp_rpc(&self, session: &str, tool: &str, args: Value) -> Value {
        let (ctx, session, tool) = (self.ctx.clone(), session.to_string(), tool.to_string());
        let rpc = tokio::task::spawn_blocking(move || {
            std::thread::spawn(move || {
                ROUTE.with(|r| *r.borrow_mut() = Some(ctx));
                crate::mcp::dispatch_for_test(&tool, &args, &session, route_post)
            })
            .join()
            .expect("the mcp dispatch thread panicked")
        })
        .await
        .unwrap();
        self.record(&rpc.to_string());
        rpc
    }

    /// The text the model reads for an MCP answer, and whether it is an error.
    pub fn text_of(rpc: &Value) -> (String, bool) {
        (rpc["result"]["content"][0]["text"].as_str().unwrap_or_default().to_string(), rpc["result"]["isError"] == json!(true))
    }

    /// `mcp_rpc`, reduced to the route's JSON: an ok answer parses from its text; a refusal comes
    /// back as `{ok:false, error}` with the relay's error text.
    pub async fn mcp(&self, session: &str, tool: &str, args: Value) -> Value {
        let rpc = self.mcp_rpc(session, tool, args).await;
        let (text, is_error) = Self::text_of(&rpc);
        if is_error {
            return json!({"ok": false, "error": text});
        }
        serde_json::from_str(&text).unwrap_or_else(|_| json!({"ok": true, "text": text}))
    }

    pub async fn read(&self, session: &str, service: &str, path: &str) -> Value {
        self.mcp(session, "api_read", json!({"service": service, "path": path})).await
    }

    pub async fn write(&self, session: &str, service: &str, method: &str, path: &str, body: Value) -> Value {
        self.mcp(session, "api_write", json!({"service": service, "method": method, "path": path, "body": body})).await
    }

    /// One script call over the loopback front.
    pub async fn http(&self, auth: Option<&str>, body: Value) -> (StatusCode, Value) {
        let mut h = HeaderMap::new();
        if let Some(a) = auth {
            h.insert(header::AUTHORIZATION, HeaderValue::from_str(a).unwrap());
        }
        let resp = on_api_broker_http(AxState(self.ctx.clone()), h, ValidatedJson(body)).await.into_response();
        let status = resp.status();
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        let v: Value = serde_json::from_slice(&bytes).unwrap();
        self.record(&v.to_string());
        (status, v)
    }

    /// A call with a good token; asserts the route answered (a refusal is a 200 with `ok:false`).
    pub async fn http_ok(&self, token: &str, body: Value) -> Value {
        let (status, v) = self.http(Some(&format!("Bearer {token}")), body).await;
        assert_eq!(status, StatusCode::OK, "{v}");
        v
    }

    pub fn audit(&self) -> Vec<Value> {
        let text = std::fs::read_to_string(self.data.join("broker-audit.jsonl")).unwrap_or_default();
        text.lines().map(|l| serde_json::from_str(l).unwrap()).collect()
    }

    /// Where a secret in any form shows up: an answer handed back, or any file under the private
    /// data folder or the chat's folder (the session record, `out_file`s), except `skip` names.
    pub fn leaks(&self, secrets: &[&str], skip: &[&str]) -> Vec<String> {
        let mut found = Vec::new();
        let mut check = |where_: String, text: &str| {
            for s in secrets {
                for f in forms(s) {
                    if text.contains(&f) {
                        found.push(format!("{where_} holds {f:?}"));
                    }
                }
            }
        };
        for (i, a) in self.seen.lock().unwrap().iter().enumerate() {
            check(format!("answer #{i}"), a);
        }
        for root in [&self.data, &self.project.path().to_path_buf()] {
            for file in files_under(root) {
                if skip.iter().any(|s| file.file_name().is_some_and(|n| n == *s)) {
                    continue;
                }
                let bytes = std::fs::read(&file).unwrap_or_default();
                check(file.display().to_string(), &String::from_utf8_lossy(&bytes));
            }
        }
        found
    }

    pub fn assert_no_leak(&self, secrets: &[&str], skip: &[&str]) {
        let found = self.leaks(secrets, skip);
        assert!(found.is_empty(), "a secret reached a sink: {found:#?}");
    }
}

fn files_under(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir(dir) else { return out };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            out.extend(files_under(&p));
        } else {
            out.push(p);
        }
    }
    out
}
