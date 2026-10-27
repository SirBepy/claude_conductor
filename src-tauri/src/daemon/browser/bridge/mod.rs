//! Joe's own browsers, driven through the Claude Conductor Browser Bridge
//! extension (`browser-extension/` at the repo root). The extension only
//! forwards a fixed set of `chrome.*` calls and their events over one
//! WebSocket per browser profile; this module turns that into a separate
//! CDP endpoint per chat, so stock `@playwright/mcp` attaches to it with
//! `--cdp-endpoint` and every chat gets its own window, sees only its own
//! tabs, and runs alongside the others.
//!
//! The listener is loopback-only and every connection needs the token from
//! `browser-bridge[suffix].json`, which the extension gets through the native
//! messaging host (`native_host.rs`) and the daemon hands to its own
//! Playwright children in their endpoint URL.

mod chat_side;
mod ext_side;
mod model;
pub mod native_host;

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use axum::extract::ws::{Message, WebSocketUpgrade};
use axum::extract::{Path, Query};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing;
use axum::Router;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::{mpsc, oneshot, Notify};

use super::target::{App, Mine};
use model::{ExtId, Model};
pub use model::NOT_CONNECTED;

/// The extension id `browser-extension/manifest.json`'s pinned `key` gives,
/// in every Chromium browser.
pub const EXTENSION_ID: &str = "eonlkjegojelfkcpghfcbfajkpbmjoia";
/// Above Playwright's own timeouts, so a slow page fails there with a reason.
const CALL_TIMEOUT: Duration = Duration::from_secs(310);
/// Any message on an open WebSocket resets the MV3 worker's 30s idle timer.
const PING_EVERY: Duration = Duration::from_secs(20);
/// The extension retries every 30s (the shortest alarm Chrome allows) after
/// a daemon restart, so a wait shorter than that can miss a running browser.
const CONNECT_WAIT: Duration = Duration::from_secs(35);
/// Full-page screenshots arrive as one base64 CDP message.
const MAX_MESSAGE_BYTES: usize = 64 * 1024 * 1024;

pub struct Bridge {
    token: String,
    port: OnceLock<u16>,
    inner: Mutex<Inner>,
    ext_ready: Notify,
}

type CallResult = Result<Value, String>;

#[derive(Default)]
struct Inner {
    model: Model,
    next_ext: ExtId,
    ext_tx: HashMap<ExtId, mpsc::UnboundedSender<Message>>,
    next_call: u64,
    pending: HashMap<u64, (ExtId, oneshot::Sender<CallResult>)>,
    chat_tx: HashMap<String, mpsc::UnboundedSender<String>>,
    /// Endpoint keys handed to Playwright children, and the browser each
    /// one drives. A key outlives its socket so a child that reconnects
    /// lands on the same chat.
    registrations: HashMap<String, (App, bool)>,
    /// Serializes a chat's tab creation and attaches, so a new tab's
    /// `tabs.onCreated` never races its own `Target.createTarget`.
    chat_ops: HashMap<String, Arc<tokio::sync::Mutex<()>>>,
}

pub fn get() -> &'static Bridge {
    static BRIDGE: OnceLock<Bridge> = OnceLock::new();
    BRIDGE.get_or_init(|| Bridge {
        token: random_hex(32),
        port: OnceLock::new(),
        inner: Mutex::new(Inner::default()),
        ext_ready: Notify::new(),
    })
}

fn random_hex(bytes: usize) -> String {
    use rand::RngCore;
    let mut buf = vec![0u8; bytes];
    rand::thread_rng().fill_bytes(&mut buf);
    crate::util::to_hex(&buf)
}

/// Atomic so the native host (a separate process the browser launches) never
/// reads a half-written file. The token inside gates the `/extension` and
/// `/cdp` sockets, so on unix the temp file is created 0600 first:
/// `write_json_atomic` truncates it in place and the rename keeps its mode.
/// On Windows the file inherits the data dir's ACL, which under the default
/// `%APPDATA%\claude-conductor` is SYSTEM, Administrators and the user only,
/// so no explicit DACL is set. A `CC_DATA_DIR` pointed outside the user's
/// profile is the caller's responsibility to keep private.
fn write_pairing_file(path: &std::path::Path, body: &str) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        let tmp = path.with_extension("json.tmp");
        std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&tmp)?;
    }
    crate::util::write_json_atomic(path, body)
}

pub fn pairing_file(data_dir: &std::path::Path, suffix: &str) -> std::path::PathBuf {
    data_dir.join(format!("browser-bridge{suffix}.json"))
}

/// The unpacked extension Joe loads into his browser: bundled beside an
/// installed app (`tauri.conf.json` resources, where `../` becomes `_up_`),
/// else found by walking up from the exe in a source checkout.
pub fn extension_dir() -> Option<std::path::PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let exe_dir = exe.parent()?;
    let bundled = [exe_dir.join("_up_"), exe_dir.join("../Resources/_up_"), exe_dir.to_path_buf()];
    bundled
        .into_iter()
        .chain(exe_dir.ancestors().map(std::path::Path::to_path_buf))
        .map(|d| d.join("browser-extension"))
        .find(|d| d.join("manifest.json").is_file())
}

#[derive(Deserialize)]
struct TokenQuery {
    token: Option<String>,
}

impl Bridge {
    /// Binds the loopback listener and writes the pairing file. Best-effort:
    /// a failure only leaves "My browser" unavailable for this run.
    pub async fn start(&'static self) {
        let listener = match tokio::net::TcpListener::bind(("127.0.0.1", 0)).await {
            Ok(l) => l,
            Err(e) => return log::warn!("browser bridge: bind failed: {e}"),
        };
        let Ok(port) = listener.local_addr().map(|a| a.port()) else { return };
        let _ = self.port.set(port);
        match crate::settings::paths::data_dir() {
            Ok(dir) => {
                let path = pairing_file(&dir, &crate::daemon::instance::instance_suffix());
                let body = json!({ "port": port, "token": self.token }).to_string();
                if let Err(e) = write_pairing_file(&path, &body) {
                    log::warn!("browser bridge: write {}: {e}", path.display());
                }
            }
            Err(e) => log::warn!("browser bridge: no data dir: {e}"),
        }
        log::info!("browser bridge listening on 127.0.0.1:{port}");
        let app = Router::new().route("/extension", routing::get(extension_ws)).route("/cdp/:key", routing::get(chat_ws));
        tokio::spawn(async move {
            if let Err(e) = axum::serve(listener, app).await {
                log::warn!("browser bridge server ended: {e}");
            }
        });
    }

    fn token_ok(&self, token: Option<&str>) -> bool {
        token.is_some_and(|t| t.len() == self.token.len() && t.bytes().zip(self.token.bytes()).fold(0u8, |acc, (a, b)| acc | (a ^ b)) == 0)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Registers a new Playwright child for a chat on `app` and returns the
    /// key to `unregister` it by, plus the endpoint to pass as
    /// `--cdp-endpoint`.
    /// `wants_profile`: the chat named a profile folder, which the bridge
    /// cannot match to a connection (see `Chat::wants_profile`).
    pub fn register(&self, app: App, wants_profile: bool) -> Result<(String, String), String> {
        let port = self.port.get().ok_or("the browser bridge is not running in this daemon")?;
        let key = random_hex(16);
        self.lock().registrations.insert(key.clone(), (app, wants_profile));
        Ok((key.clone(), format!("ws://127.0.0.1:{port}/cdp/{key}?token={}", self.token)))
    }

    pub fn unregister(&self, key: &str) {
        let mut i = self.lock();
        i.registrations.remove(key);
        i.chat_ops.remove(key);
    }

    /// Browsers with a bridge connection up, for Settings' status line.
    pub fn connected_browsers(&self) -> Vec<String> {
        let i = self.lock();
        let mut names: Vec<String> = i.model.exts.values().filter(|e| e.ready).map(|e| e.app.map_or("Chromium", |a| a.label()).to_string()).collect();
        names.sort();
        names.dedup();
        names
    }

    /// `None` while no connection for `mine.app` is up. A named profile with
    /// several profiles of the app connected is an error, not a pick: the
    /// extension cannot say which profile it runs in.
    fn connection_state(&self, mine: &Mine) -> Option<Result<(), String>> {
        let i = self.lock();
        if mine.profile.is_some() && i.model.profile_ambiguous(mine.app) {
            return Some(Err(model::profile_ambiguous_message(mine.app)));
        }
        i.model.pick_ext(mine.app).map(|_| Ok(()))
    }

    /// Ok once a bridge connection for `mine.app` is up, starting the browser
    /// in the background first when none is.
    pub async fn ensure_connected(&self, mine: &Mine) -> Result<(), String> {
        if self.port.get().is_none() {
            return Err("the browser bridge is not running in this daemon".into());
        }
        if let Some(state) = self.connection_state(mine) {
            return state;
        }
        if let Err(e) = mine.launch_in_background() {
            log::info!("browser bridge: could not start {:?}: {e}", mine.app);
        }
        let deadline = tokio::time::Instant::now() + CONNECT_WAIT;
        loop {
            let notified = self.ext_ready.notified();
            if let Some(state) = self.connection_state(mine) {
                return state;
            }
            if tokio::time::timeout_at(deadline, notified).await.is_err() {
                return Err(NOT_CONNECTED.into());
            }
        }
    }

    fn start_call(&self, ext: ExtId, call: &str, args: Value) -> oneshot::Receiver<CallResult> {
        let (tx, rx) = oneshot::channel();
        let mut i = self.lock();
        let Some(sender) = i.ext_tx.get(&ext).cloned() else {
            let _ = tx.send(Err(NOT_CONNECTED.into()));
            return rx;
        };
        i.next_call += 1;
        let id = i.next_call;
        i.pending.insert(id, (ext, tx));
        let _ = sender.send(Message::Text(json!({ "id": id, "call": call, "args": args }).to_string()));
        rx
    }

    async fn finish(rx: oneshot::Receiver<CallResult>) -> CallResult {
        match tokio::time::timeout(CALL_TIMEOUT, rx).await {
            Err(_) => Err("Joe's browser did not answer in time".into()),
            // The sender is dropped when the browser's connection closes.
            Ok(Err(_)) => Err(NOT_CONNECTED.into()),
            Ok(Ok(r)) => r,
        }
    }

    async fn call(&self, ext: ExtId, call: &str, args: Value) -> CallResult {
        Self::finish(self.start_call(ext, call, args)).await
    }

    fn send_chat(&self, key: &str, msg: Value) {
        if let Some(tx) = self.lock().chat_tx.get(key) {
            let _ = tx.send(msg.to_string());
        }
    }

    fn reply(&self, key: &str, id: &Value, session: Option<&str>, result: CallResult) {
        let mut msg = match result {
            Ok(v) => json!({ "id": id, "result": if v.is_null() { json!({}) } else { v } }),
            Err(e) => json!({ "id": id, "error": { "code": -32000, "message": e } }),
        };
        if let Some(s) = session {
            msg["sessionId"] = json!(s);
        }
        self.send_chat(key, msg);
    }

    fn chat_ops(&self, key: &str) -> Arc<tokio::sync::Mutex<()>> {
        self.lock().chat_ops.entry(key.to_string()).or_default().clone()
    }
}

fn origin_ok(headers: &HeaderMap, allowed: Option<&str>) -> bool {
    match (headers.get("origin").and_then(|o| o.to_str().ok()), allowed) {
        // A web page always sends its Origin; only our own extension's passes.
        (Some(origin), Some(allowed)) => origin.trim_end_matches('/') == allowed,
        (Some(_), None) => false,
        // Node (Playwright) sends none; the token still has to match.
        (None, _) => allowed.is_none(),
    }
}

async fn extension_ws(ws: WebSocketUpgrade, headers: HeaderMap, Query(q): Query<TokenQuery>) -> Response {
    let b = get();
    let origin = format!("chrome-extension://{EXTENSION_ID}");
    if !b.token_ok(q.token.as_deref()) || !origin_ok(&headers, Some(&origin)) {
        return StatusCode::FORBIDDEN.into_response();
    }
    ws.max_message_size(MAX_MESSAGE_BYTES).max_frame_size(MAX_MESSAGE_BYTES).on_upgrade(move |s| b.serve_extension(s))
}

async fn chat_ws(ws: WebSocketUpgrade, headers: HeaderMap, Path(key): Path<String>, Query(q): Query<TokenQuery>) -> Response {
    let b = get();
    if !b.token_ok(q.token.as_deref()) || !origin_ok(&headers, None) || !b.lock().registrations.contains_key(&key) {
        return StatusCode::FORBIDDEN.into_response();
    }
    ws.max_message_size(MAX_MESSAGE_BYTES).max_frame_size(MAX_MESSAGE_BYTES).on_upgrade(move |s| b.serve_chat(key, s))
}

#[cfg(test)]
mod tests;
