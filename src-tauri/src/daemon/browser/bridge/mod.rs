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

mod model;
pub mod native_host;

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing;
use axum::Router;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::{mpsc, oneshot, Notify};

use super::target::{App, Mine};
use model::{Chat, Ext, ExtId, Model, Route, Tab, TabId};
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
    registrations: HashMap<String, App>,
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
    pub fn register(&self, app: App) -> Result<(String, String), String> {
        let port = self.port.get().ok_or("the browser bridge is not running in this daemon")?;
        let key = random_hex(16);
        self.lock().registrations.insert(key.clone(), app);
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

    fn has_ext(&self, app: App) -> bool {
        self.lock().model.pick_ext(app).is_some()
    }

    /// Ok once a bridge connection for `mine.app` is up, starting the browser
    /// in the background first when none is.
    pub async fn ensure_connected(&self, mine: &Mine) -> Result<(), String> {
        if self.port.get().is_none() {
            return Err("the browser bridge is not running in this daemon".into());
        }
        if self.has_ext(mine.app) {
            return Ok(());
        }
        if let Err(e) = mine.launch_in_background() {
            log::info!("browser bridge: could not start {:?}: {e}", mine.app);
        }
        let deadline = tokio::time::Instant::now() + CONNECT_WAIT;
        loop {
            let notified = self.ext_ready.notified();
            if self.has_ext(mine.app) {
                return Ok(());
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

    // ---- extension side ----

    async fn serve_extension(&'static self, socket: WebSocket) {
        let (mut sink, mut stream) = socket.split();
        let (tx, mut rx) = mpsc::unbounded_channel::<Message>();
        let id = {
            let mut i = self.lock();
            i.next_ext += 1;
            let id = i.next_ext;
            i.model.exts.insert(id, Ext { app: None, user_agent: String::new(), connected_at: Instant::now(), ready: false });
            i.ext_tx.insert(id, tx.clone());
            id
        };
        let writer = tokio::spawn(async move {
            while let Some(m) = rx.recv().await {
                if sink.send(m).await.is_err() {
                    break;
                }
            }
        });
        let pinger = tokio::spawn(async move {
            let mut n = 0u64;
            loop {
                tokio::time::sleep(PING_EVERY).await;
                n += 1;
                if tx.send(Message::Text(json!({ "ping": n }).to_string())).is_err() {
                    break;
                }
            }
        });
        while let Some(Ok(msg)) = stream.next().await {
            match msg {
                Message::Text(text) => self.on_ext_message(id, &text),
                Message::Close(_) => break,
                _ => {}
            }
        }
        pinger.abort();
        writer.abort();
        self.on_ext_closed(id);
    }

    fn on_ext_closed(&self, ext: ExtId) {
        let events = {
            let mut i = self.lock();
            i.ext_tx.remove(&ext);
            // Dropping the senders fails every call still waiting on this browser.
            i.pending.retain(|_, (e, _)| *e != ext);
            i.model.drop_ext(ext)
        };
        for (key, event) in events {
            self.send_chat(&key, event);
        }
        log::info!("browser bridge: extension connection {ext} closed");
    }

    fn on_ext_message(&'static self, ext: ExtId, text: &str) {
        let Ok(msg) = serde_json::from_str::<Value>(text) else { return };
        if let Some(id) = msg["id"].as_u64() {
            let waiter = self.lock().pending.remove(&id);
            if let Some((_, tx)) = waiter {
                let result = match msg.get("error") {
                    Some(e) => Err(e.as_str().unwrap_or("error").to_string()),
                    None => Ok(msg["result"].clone()),
                };
                let _ = tx.send(result);
            }
            return;
        }
        let Some(event) = msg["event"].as_str() else { return };
        let args = &msg["args"];
        match event {
            "hello" => {
                let hello = &args[0];
                {
                    let mut i = self.lock();
                    if let Some(e) = i.model.exts.get_mut(&ext) {
                        e.app = App::parse(hello["browser"].as_str().unwrap_or_default());
                        e.user_agent = hello["userAgent"].as_str().unwrap_or_default().to_string();
                        e.ready = true;
                    }
                }
                log::info!("browser bridge: {} connected (connection {ext})", hello["browser"].as_str().unwrap_or("?"));
                self.ext_ready.notify_waiters();
            }
            "debugger.onEvent" => {
                let routed = self.lock().model.route_event(ext, &args[0], args[1].as_str().unwrap_or_default(), &args[2]);
                if let Some((key, m)) = routed {
                    self.send_chat(&key, m);
                }
            }
            "debugger.onDetach" | "tabs.onRemoved" => {
                let tab = if event == "tabs.onRemoved" { args[0].as_i64() } else { args[0]["tabId"].as_i64() };
                let dropped = tab.and_then(|t| self.lock().model.drop_tab(ext, t));
                if let Some((key, m)) = dropped {
                    self.send_chat(&key, m);
                }
            }
            "tabs.onCreated" | "webNavigation.onCreatedNavigationTarget" => {
                let (tab, window, opener) = if event == "tabs.onCreated" {
                    (args[0]["id"].as_i64(), args[0]["windowId"].as_i64(), args[0]["openerTabId"].as_i64())
                } else {
                    (args[0]["tabId"].as_i64(), None, args[0]["sourceTabId"].as_i64())
                };
                let Some(tab) = tab else { return };
                let claim = {
                    let i = self.lock();
                    let key = i.model.claimant(ext, window, opener);
                    key.filter(|k| i.model.chats.get(k).is_some_and(|c| c.auto_attach) && !i.model.owners.contains_key(&(ext, tab)))
                };
                if let Some(key) = claim {
                    tokio::spawn(async move {
                        let ops = self.chat_ops(&key);
                        let _g = ops.lock().await;
                        if let Err(e) = self.attach_locked(&key, ext, tab, false).await {
                            log::debug!("browser bridge: attach new tab {tab}: {e}");
                        }
                    });
                }
            }
            "windows.onRemoved" => {
                let mut i = self.lock();
                for chat in i.model.chats.values_mut() {
                    if chat.ext == Some(ext) && chat.window_id == args[0].as_i64() {
                        chat.window_id = None;
                    }
                }
            }
            _ => {}
        }
    }

    // ---- chat side ----

    async fn serve_chat(&'static self, key: String, socket: WebSocket) {
        let (mut sink, mut stream) = socket.split();
        let (tx, mut rx) = mpsc::unbounded_channel::<String>();
        {
            let mut i = self.lock();
            let Some(app) = i.registrations.get(&key).copied() else { return };
            if i.model.chats.contains_key(&key) {
                return;
            }
            let ext = i.model.pick_ext(app);
            i.model.chats.insert(key.clone(), Chat { ext, window_id: None, tabs: HashMap::new(), auto_attach: false });
            i.chat_tx.insert(key.clone(), tx);
        }
        let writer = tokio::spawn(async move {
            while let Some(m) = rx.recv().await {
                if sink.send(Message::Text(m)).await.is_err() {
                    break;
                }
            }
        });
        while let Some(Ok(msg)) = stream.next().await {
            match msg {
                Message::Text(text) => self.on_cdp(&key, &text),
                Message::Close(_) => break,
                _ => {}
            }
        }
        writer.abort();
        let window = {
            let mut i = self.lock();
            i.chat_tx.remove(&key);
            i.model.owners.retain(|_, k| k != &key);
            i.model.chats.remove(&key).and_then(|c| Some((c.ext?, c.window_id?)))
        };
        // The chat's child exited (idle, chat closed, or retired): its window goes too.
        if let Some((ext, window)) = window {
            let _ = self.call(ext, "windows.remove", json!([window])).await;
        }
    }

    fn on_cdp(&'static self, key: &str, text: &str) {
        let Ok(msg) = serde_json::from_str::<Value>(text) else { return };
        let id = msg["id"].clone();
        let method = msg["method"].as_str().unwrap_or_default().to_string();
        let params = msg.get("params").cloned().unwrap_or_else(|| json!({}));
        let session = msg["sessionId"].as_str().map(str::to_string);
        let mut events = Vec::new();
        let route = {
            let mut i = self.lock();
            let ua = i.model.chats.get(key).and_then(|c| c.ext).and_then(|e| i.model.exts.get(&e)).map(|e| e.user_agent.clone()).unwrap_or_default();
            i.model.route(key, &method, &params, session.as_deref(), &ua, &mut events)
        };
        for e in events {
            self.send_chat(key, e);
        }
        let key = key.to_string();
        match route {
            Route::Reply(v) => self.reply(&key, &id, session.as_deref(), Ok(v)),
            Route::Fail(e) => self.reply(&key, &id, session.as_deref(), Err(e)),
            Route::Forward { ext, target } => {
                // Queued to the extension now, in arrival order: Chrome must
                // see a tab's commands in the order Playwright sent them.
                let rx = self.start_call(ext, "debugger.sendCommand", json!([target, method, params]));
                tokio::spawn(async move { self.reply(&key, &id, session.as_deref(), Self::finish(rx).await) });
            }
            Route::CreateTarget { ext, url } => {
                tokio::spawn(async move {
                    let r = self.create_target(&key, ext, &url).await.map(|t| json!({ "targetId": t }));
                    self.reply(&key, &id, session.as_deref(), r);
                });
            }
            Route::CloseTab { ext, tab } => {
                tokio::spawn(async move {
                    let r = self.call(ext, "tabs.remove", json!([tab])).await.map(|_| json!({ "success": true }));
                    self.reply(&key, &id, session.as_deref(), r);
                });
            }
            Route::Activate { ext, tab } => {
                tokio::spawn(async move {
                    let r = self.call(ext, "tabs.update", json!([tab, { "active": true }])).await.map(|_| json!({}));
                    self.reply(&key, &id, session.as_deref(), r);
                });
            }
            Route::CloseWindow { ext, window } => {
                tokio::spawn(async move {
                    let r = self.call(ext, "windows.remove", json!([window])).await.map(|_| json!({}));
                    self.reply(&key, &id, session.as_deref(), r);
                });
            }
        }
    }

    /// Opens a tab for the chat in its own window (made on first use,
    /// minimized and unfocused so it never lands over Joe's work) and
    /// attaches to it. Returns the CDP target id.
    async fn create_target(&self, key: &str, ext: ExtId, url: &str) -> Result<String, String> {
        let ops = self.chat_ops(key);
        let _g = ops.lock().await;
        let window = self.lock().model.chats.get(key).ok_or("chat closed")?.window_id;
        let in_window = match window {
            Some(w) => self.call(ext, "tabs.create", json!([{ "windowId": w, "url": url, "active": true }])).await.ok(),
            None => None,
        };
        let tab = match in_window {
            Some(tab) => tab["id"].as_i64(),
            // No window yet, or Joe closed it.
            None => {
                let win = self.call(ext, "windows.create", json!([{ "url": url, "focused": false, "state": "minimized" }])).await?;
                let window = win["id"].as_i64().ok_or("windows.create returned no window")?;
                let alive = match self.lock().model.chats.get_mut(key) {
                    Some(c) => {
                        c.window_id = Some(window);
                        true
                    }
                    None => false,
                };
                if !alive {
                    let _ = self.call(ext, "windows.remove", json!([window])).await;
                    return Err("chat closed".into());
                }
                win["tabs"][0]["id"].as_i64()
            }
        };
        let tab = tab.ok_or("the new tab has no id")?;
        let target = self.attach_locked(key, ext, tab, true).await?;
        let stale = self.lock().model.superseded(key, tab);
        if !stale.is_empty() {
            let _ = self.call(ext, "tabs.remove", json!([stale])).await;
        }
        Ok(target)
    }

    /// Attaches the debugger to `tab` for chat `key`; the caller holds the
    /// chat's ops lock. Returns the tab's target id.
    async fn attach_locked(&self, key: &str, ext: ExtId, tab: TabId, chat_opened: bool) -> Result<String, String> {
        {
            let mut i = self.lock();
            match i.model.owners.get(&(ext, tab)) {
                Some(owner) if owner == key => {
                    let t = i.model.chats.get(key).and_then(|c| c.tabs.get(&tab));
                    return t.and_then(|t| t.target_info["targetId"].as_str().map(str::to_string)).ok_or_else(|| "tab is still attaching".to_string());
                }
                Some(_) => return Err("that tab belongs to another chat".into()),
                None => {
                    i.model.owners.insert((ext, tab), key.to_string());
                }
            }
        }
        let attached = async {
            self.call(ext, "debugger.attach", json!([{ "tabId": tab }, "1.3"])).await?;
            let info = self.call(ext, "debugger.sendCommand", json!([{ "tabId": tab }, "Target.getTargetInfo"])).await?;
            // A minimized window is hidden, and a hidden page skips
            // animation frames, which Playwright's click and screenshot wait on.
            let _ = self.call(ext, "debugger.sendCommand", json!([{ "tabId": tab }, "Emulation.setFocusEmulationEnabled", { "enabled": true }])).await;
            Ok::<Value, String>(info["targetInfo"].clone())
        }
        .await;
        let mut i = self.lock();
        let info = match attached {
            Ok(info) if i.model.chats.contains_key(key) => info,
            Ok(_) => {
                i.model.owners.remove(&(ext, tab));
                return Err("chat closed".into());
            }
            Err(e) => {
                i.model.owners.remove(&(ext, tab));
                return Err(e);
            }
        };
        let target_id = info["targetId"].as_str().unwrap_or_default().to_string();
        let t = Tab { session_id: i.model.new_session_id(), target_info: info, children: Default::default(), chat_opened };
        let event = Model::attached_event(&t);
        if let Some(chat) = i.model.chats.get_mut(key) {
            chat.tabs.insert(tab, t);
        }
        if let Some(tx) = i.chat_tx.get(key) {
            let _ = tx.send(event.to_string());
        }
        Ok(target_id)
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
mod tests {
    use super::*;

    #[test]
    fn only_the_bridge_extension_and_originless_clients_pass_the_origin_check() {
        let mut h = HeaderMap::new();
        let ext = format!("chrome-extension://{EXTENSION_ID}");
        assert!(origin_ok(&h, None), "Playwright sends no Origin");
        assert!(!origin_ok(&h, Some(&ext)), "the extension always sends one");
        h.insert("origin", "https://evil.example".parse().unwrap());
        assert!(!origin_ok(&h, None), "a web page cannot reach a chat endpoint");
        assert!(!origin_ok(&h, Some(&ext)));
        h.insert("origin", format!("{ext}/").parse().unwrap());
        assert!(origin_ok(&h, Some(&ext)));
    }

    #[test]
    fn random_hex_is_lowercase_hex_of_twice_the_byte_count() {
        let h = random_hex(16);
        assert_eq!(h.len(), 32);
        assert!(h.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
    }

    #[test]
    fn the_pairing_file_is_replaced_whole_and_leaves_no_temp_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = pairing_file(dir.path(), "");
        write_pairing_file(&path, r#"{"port":1,"token":"a"}"#).unwrap();
        write_pairing_file(&path, r#"{"port":2,"token":"b"}"#).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), r#"{"port":2,"token":"b"}"#);
        let names: Vec<_> = std::fs::read_dir(dir.path()).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(names.len(), 1, "the temp sibling is renamed away: {names:?}");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
    }

    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    use tokio_tungstenite::tungstenite::Message as WsMsg;

    type Ws = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

    async fn connect(url: &str, origin: Option<&str>) -> Result<Ws, String> {
        let mut req = url.into_client_request().unwrap();
        if let Some(o) = origin {
            req.headers_mut().insert("origin", o.parse().unwrap());
        }
        tokio_tungstenite::connect_async(req).await.map(|(ws, _)| ws).map_err(|e| e.to_string())
    }

    async fn recv(ws: &mut Ws) -> Value {
        loop {
            let msg = tokio::time::timeout(Duration::from_secs(5), ws.next()).await.expect("timed out").unwrap().unwrap();
            if let WsMsg::Text(t) = msg {
                let v: Value = serde_json::from_str(&t).unwrap();
                if v.get("ping").is_none() {
                    return v;
                }
            }
        }
    }

    async fn send(ws: &mut Ws, v: Value) {
        ws.send(WsMsg::Text(v.to_string())).await.unwrap();
    }

    /// The fake extension answers one call it expects by name.
    async fn answer(ext: &mut Ws, call: &str, result: Value) -> Value {
        let m = recv(ext).await;
        assert_eq!(m["call"], json!(call), "{m}");
        send(ext, json!({ "id": m["id"], "result": result })).await;
        m
    }

    /// One extension, two chats, over real sockets: a chat's first page opens
    /// a minimized window of its own, focus emulation goes on, the other
    /// chat cannot reach that tab, and the window closes when its chat leaves.
    #[tokio::test]
    async fn two_chats_share_one_browser_each_in_its_own_window() {
        let dir = tempfile::tempdir().unwrap();
        {
            // Keeps the pairing file out of the real data dir.
            let _env = crate::util::ENV_MUTATION_LOCK.lock().unwrap_or_else(|p| p.into_inner());
            std::env::set_var("CC_DATA_DIR", dir.path());
            get().start().await;
            std::env::remove_var("CC_DATA_DIR");
        }
        let b = get();
        let port = *b.port.get().unwrap();
        let pairing: Value = serde_json::from_str(&std::fs::read_to_string(pairing_file(dir.path(), &crate::daemon::instance::instance_suffix())).unwrap()).unwrap();
        assert_eq!(pairing["port"], json!(port));

        let ext_url = format!("ws://127.0.0.1:{port}/extension?token={}", b.token);
        let ext_origin = format!("chrome-extension://{EXTENSION_ID}");
        assert!(connect(&format!("ws://127.0.0.1:{port}/extension?token=nope"), Some(&ext_origin)).await.is_err(), "wrong token");
        assert!(connect(&ext_url, Some("chrome-extension://someoneelse")).await.is_err(), "another extension");
        let mut ext = connect(&ext_url, Some(&ext_origin)).await.unwrap();
        send(&mut ext, json!({ "event": "hello", "args": [{ "browser": "brave", "userAgent": "Mozilla/5.0 Chrome/155.0.7.1 Safari/537.36" }] })).await;
        b.ensure_connected(&Mine { app: App::Brave, profile: None }).await.unwrap();
        assert_eq!(b.connected_browsers(), ["Brave"]);

        let (key_a, url_a) = b.register(App::Brave).unwrap();
        let (_key_b, url_b) = b.register(App::Brave).unwrap();
        assert!(connect(&url_a, Some("https://evil.example")).await.is_err(), "a web page cannot open a chat endpoint");
        let mut a = connect(&url_a, None).await.unwrap();
        let mut c = connect(&url_b, None).await.unwrap();

        send(&mut a, json!({ "id": 1, "method": "Browser.getVersion" })).await;
        assert_eq!(recv(&mut a).await["result"]["product"], json!("Chrome/155.0.7.1"));

        send(&mut a, json!({ "id": 2, "method": "Target.createTarget", "params": { "url": "about:blank" } })).await;
        let create = answer(&mut ext, "windows.create", json!({ "id": 7, "tabs": [{ "id": 70 }] })).await;
        assert_eq!(create["args"][0]["state"], json!("minimized"));
        assert_eq!(create["args"][0]["focused"], json!(false));
        answer(&mut ext, "debugger.attach", Value::Null).await;
        answer(&mut ext, "debugger.sendCommand", json!({ "targetInfo": { "targetId": "T70", "type": "page", "url": "about:blank" } })).await;
        let focus = answer(&mut ext, "debugger.sendCommand", json!({})).await;
        assert_eq!(focus["args"][1], json!("Emulation.setFocusEmulationEnabled"));
        let attached = recv(&mut a).await;
        assert_eq!(attached["method"], json!("Target.attachedToTarget"));
        let session = attached["params"]["sessionId"].as_str().unwrap().to_string();
        assert_eq!(recv(&mut a).await, json!({ "id": 2, "result": { "targetId": "T70" } }));

        // Events reach only the owner; the other chat cannot borrow the session.
        send(&mut ext, json!({ "event": "debugger.onEvent", "args": [{ "tabId": 70 }, "Page.loadEventFired", { "timestamp": 1 }] })).await;
        let ev = recv(&mut a).await;
        assert_eq!((ev["method"].as_str(), ev["sessionId"].as_str()), (Some("Page.loadEventFired"), Some(session.as_str())));
        send(&mut c, json!({ "id": 9, "method": "Runtime.evaluate", "sessionId": session, "params": {} })).await;
        assert!(recv(&mut c).await["error"]["message"].as_str().unwrap().contains("does not belong"));

        // The owner's own command reaches its tab, in order.
        send(&mut a, json!({ "id": 3, "method": "Page.navigate", "sessionId": session, "params": { "url": "https://example.com" } })).await;
        let nav = answer(&mut ext, "debugger.sendCommand", json!({ "frameId": "F" })).await;
        assert_eq!(nav["args"], json!([{ "tabId": 70 }, "Page.navigate", { "url": "https://example.com" }]));
        assert_eq!(recv(&mut a).await["result"]["frameId"], json!("F"));

        drop(a);
        let close = recv(&mut ext).await;
        assert_eq!((close["call"].as_str(), &close["args"]), (Some("windows.remove"), &json!([7])));
        b.unregister(&key_a);
    }

    #[test]
    fn the_token_must_match_exactly() {
        let b = get();
        assert!(b.token_ok(Some(&b.token.clone())));
        assert!(!b.token_ok(None));
        assert!(!b.token_ok(Some("")));
        assert!(!b.token_ok(Some(&b.token[..b.token.len() - 1])));
    }
}
