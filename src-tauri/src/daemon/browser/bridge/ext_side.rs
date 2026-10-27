//! The extension-socket side of the bridge: one WebSocket per connected
//! browser profile, carrying `chrome.*` calls out and its events back in.

use std::time::Instant;

use axum::extract::ws::{Message, WebSocket};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::sync::mpsc;

use super::model::{Ext, ExtId};
use super::{App, Bridge, PING_EVERY};

impl Bridge {
    pub(super) async fn serve_extension(&'static self, socket: WebSocket) {
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
}
