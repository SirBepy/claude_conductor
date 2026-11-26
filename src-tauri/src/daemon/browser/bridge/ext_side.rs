//! The extension-socket side of the bridge: one WebSocket per connected
//! browser profile, carrying `chrome.*` calls out and its events back in.

use std::time::{Duration, Instant};

use axum::extract::ws::{Message, WebSocket};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::sync::mpsc;

use super::chat_side::short;
use super::model::{Ext, ExtId, TabState};
use super::telemetry::{note_worker, Hello, SocketEnd};
use super::{App, Bridge, PING_EVERY};

impl Bridge {
    pub(super) async fn serve_extension(&'static self, socket: WebSocket) {
        let (mut sink, mut stream) = socket.split();
        let (tx, mut rx) = mpsc::unbounded_channel::<Message>();
        let id = {
            let mut i = self.lock();
            i.next_ext += 1;
            let id = i.next_ext;
            i.model.exts.insert(id, Ext { app: None, user_agent: String::new(), connected_at: Instant::now(), ready: false, install_id: String::new() });
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
        let opened = Instant::now();
        let end = loop {
            match stream.next().await {
                Some(Ok(Message::Text(text))) => self.on_ext_message(id, &text),
                Some(Ok(Message::Close(frame))) => break SocketEnd::Frame(frame.map(|f| (f.code, f.reason.into_owned()))),
                Some(Ok(_)) => {}
                Some(Err(e)) => break SocketEnd::Error(e.to_string()),
                None => break SocketEnd::Ended,
            }
        };
        pinger.abort();
        writer.abort();
        self.on_ext_closed(id, &end, opened.elapsed());
    }

    fn on_ext_closed(&'static self, ext: ExtId, end: &SocketEnd, lived: Duration) {
        let closed = {
            let mut i = self.lock();
            i.ext_tx.remove(&ext);
            // Dropping the senders fails every call still waiting on this browser.
            i.pending.retain(|_, (e, _)| *e != ext);
            i.model.close_ext(ext, Instant::now())
        };
        log::info!("browser bridge: extension connection {ext} closed after {}s ({})", lived.as_secs(), end.describe());
        self.after_ext_closed(ext, closed);
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
                let hello = Hello::parse(&args[0]);
                let rebound = {
                    let mut i = self.lock();
                    if let Some(e) = i.model.exts.get_mut(&ext) {
                        e.app = App::parse(&hello.browser);
                        e.user_agent = hello.user_agent.clone();
                        e.install_id = hello.install_id.clone();
                        e.ready = true;
                    }
                    // Chats whose tabs waited for this install get them back.
                    i.model.rebind(ext)
                };
                let now_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64);
                log::info!("browser bridge: {}", hello.describe(ext, note_worker(&hello), now_ms));
                self.start_rebind(rebound);
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
                if event == "debugger.onDetach" {
                    let Some(t) = tab else { return };
                    // The detach churn of a tab already being attached again is part of that attach.
                    let target_closed = args[1] == json!("target_closed");
                    if target_closed {
                        let mut i = self.lock();
                        if i.model.tab_state(ext, t).is_some_and(|s| s != TabState::Live) {
                            // Remembered, so a debugger that died after the attach is attached once more.
                            i.model.note_redetach(ext, t);
                            return;
                        }
                    }
                    // A live tab the browser detached keeps its session: the chat never hears a close.
                    if target_closed && self.begin_quiet_reattach(ext, t) {
                        return;
                    }
                }
                let (dropped, held) = match tab {
                    Some(t) => {
                        let mut i = self.lock();
                        let held = i.model.take_held(ext, t);
                        (i.model.drop_tab(ext, t), held)
                    }
                    None => (None, Vec::new()),
                };
                self.fail_held(held, "Target page, context or browser has been closed");
                // The reason and removeInfo are what tell a crash or a user close from a page that merely navigated away.
                let cause = if event == "tabs.onRemoved" {
                    format!("isWindowClosing={}, windowId={}", args[1]["isWindowClosing"], args[1]["windowId"])
                } else {
                    format!("reason={}", args[1])
                };
                log::info!(
                    "browser bridge: {event} tab {tab:?} ({cause}, connection {ext}), chat {}",
                    dropped.as_ref().map_or("none", |(k, _)| short(k))
                );
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
}
