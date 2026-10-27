//! The chat-socket side of the bridge: one CDP WebSocket per Playwright
//! child, routed onto the extension connection that owns the chat's tabs.

use std::collections::HashMap;

use axum::extract::ws::{Message, WebSocket};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::sync::mpsc;

use super::model::{Chat, ExtId, Model, Route, Tab, TabId};
use super::Bridge;

impl Bridge {
    pub(super) async fn serve_chat(&'static self, key: String, socket: WebSocket) {
        let (mut sink, mut stream) = socket.split();
        let (tx, mut rx) = mpsc::unbounded_channel::<String>();
        {
            let mut i = self.lock();
            let Some((app, wants_profile)) = i.registrations.get(&key).copied() else { return };
            if i.model.chats.contains_key(&key) {
                return;
            }
            let ext = i.model.pick_ext_for(app, wants_profile);
            i.model.chats.insert(key.clone(), Chat { app, wants_profile, ext, window_id: None, tabs: HashMap::new(), auto_attach: false });
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
    pub(super) async fn attach_locked(&self, key: &str, ext: ExtId, tab: TabId, chat_opened: bool) -> Result<String, String> {
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
