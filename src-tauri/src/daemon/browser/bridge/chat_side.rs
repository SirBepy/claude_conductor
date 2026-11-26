//! The chat-socket side of the bridge: one CDP WebSocket per Playwright
//! child, routed onto the extension connection that owns the chat's tabs.

use std::collections::HashMap;

use axum::extract::ws::{Message, WebSocket};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::sync::mpsc;

use super::model::{Chat, ExtId, Held, Model, Route, Tab, TabId, TabState};
use super::Bridge;

/// A chat key is the path credential of its CDP socket, so logs carry only a prefix.
pub(super) fn short(key: &str) -> &str {
    key.get(..8).unwrap_or(key)
}

impl Bridge {
    pub(super) async fn serve_chat(&'static self, key: String, socket: WebSocket) {
        let (mut sink, mut stream) = socket.split();
        let (tx, mut rx) = mpsc::unbounded_channel::<String>();
        {
            let mut i = self.lock();
            let Some((app, wants_profile)) = i.registrations.get(&key).copied() else {
                log::info!("browser bridge: chat {} socket refused, not registered", short(&key));
                return;
            };
            if i.model.chats.contains_key(&key) {
                log::info!("browser bridge: chat {} socket refused, already connected", short(&key));
                return;
            }
            let ext = i.model.pick_ext_for(app, wants_profile);
            log::info!("browser bridge: chat {} socket connected ({app:?}, connection {ext:?})", short(&key));
            i.model.chats.insert(key.clone(), Chat { app, wants_profile, ext, window_id: None, tabs: HashMap::new(), auto_attach: false, reconnect: None });
            i.chat_tx.insert(key.clone(), tx);
        }
        let writer = tokio::spawn(async move {
            while let Some(m) = rx.recv().await {
                if sink.send(Message::Text(m)).await.is_err() {
                    break;
                }
            }
        });
        let why = loop {
            match stream.next().await {
                Some(Ok(Message::Text(text))) => self.on_cdp(&key, &text),
                Some(Ok(Message::Close(frame))) => break format!("close frame {:?}", frame.map(|f| f.code)),
                Some(Ok(_)) => {}
                Some(Err(e)) => break format!("socket error: {e}"),
                None => break "stream ended".to_string(),
            }
        };
        writer.abort();
        let window = {
            let mut i = self.lock();
            i.chat_tx.remove(&key);
            // A chat that leaves while its browser is away has its window closed on reconnect.
            i.model.remove_chat(&key, std::time::Instant::now())
        };
        log::info!("browser bridge: chat {} socket closed ({why}), window {:?}", short(&key), window.as_ref().map(|(_, w, _)| w));
        // The chat's child exited (idle, chat closed, or retired): its window goes too.
        match window {
            Some((ext, window, None)) => {
                let _ = self.call(ext, "windows.remove", json!([window])).await;
            }
            // The chat was re-bound moments ago and the window id is not trusted yet.
            Some((ext, window, Some(tabs))) => self.close_window_if_ours(ext, window, &tabs).await,
            None => {}
        }
    }

    pub(super) fn on_cdp(&'static self, key: &str, text: &str) {
        self.route_cdp(key, text, true);
    }

    /// `reroute`: a message whose tab moved to a reconnected browser while it
    /// was being routed may be routed once more; the second time it is sent as is.
    fn route_cdp(&'static self, key: &str, text: &str, reroute: bool) {
        let Ok(msg) = serde_json::from_str::<Value>(text) else { return };
        let id = msg["id"].clone();
        let method = msg["method"].as_str().unwrap_or_default().to_string();
        let params = msg.get("params").cloned().unwrap_or_else(|| json!({}));
        let session = msg["sessionId"].as_str().map(str::to_string);
        let mut events = Vec::new();
        // What switched the browser to GUID-named downloads is unconfirmed
        // (pc-1553), so every such command is on record.
        if method.ends_with("DownloadBehavior") {
            log::info!("browser bridge: chat {} sent {method} {params} (session {session:?})", short(key));
        }
        let route = {
            let mut i = self.lock();
            let ua = i.model.chats.get(key).map_or_else(String::new, |c| {
                let live = c.ext.and_then(|e| i.model.exts.get(&e)).map(|e| e.user_agent.clone());
                live.or_else(|| c.reconnect.as_ref().map(|r| r.user_agent.clone())).unwrap_or_default()
            });
            i.model.route(key, &method, &params, session.as_deref(), &ua, &mut events)
        };
        for e in events {
            self.send_chat(key, e);
        }
        let key = key.to_string();
        match route {
            Route::Reply(v) => self.reply(&key, &id, session.as_deref(), Ok(v)),
            Route::Wait => {
                // Kept under the lock the re-bind takes the list with, so a message cannot slip in after it ran.
                let kept = self.lock().model.defer(&key, text);
                if !kept {
                    self.route_cdp(&key, text, false);
                }
            }
            Route::Fail(e) => self.reply(&key, &id, session.as_deref(), Err(e)),
            Route::Forward { ext, target } => {
                // Queued to the extension now, in arrival order: Chrome must
                // see a tab's commands in the order Playwright sent them.
                let rx = self.start_call(ext, "debugger.sendCommand", json!([target, method, params]));
                tokio::spawn(async move { self.reply(&key, &id, session.as_deref(), Self::finish(rx).await) });
            }
            Route::Hold { ext, tab, target } => {
                // The tab may have finished re-attaching since `route`
                // looked, so the check and the keep happen under one lock.
                let held = Held { key: key.clone(), id: id.clone(), session: session.clone(), target, method, params };
                let mut i = self.lock();
                if let Err(h) = i.model.hold(ext, tab, held) {
                    if i.model.tab_state(ext, tab) == Some(TabState::Parked) {
                        drop(i);
                        return self.reply(&key, &id, session.as_deref(), Err(super::replay::PARKED_MESSAGE.into()));
                    }
                    // The tab moved to a reconnected browser (or was dropped) since `route`: route it again.
                    if reroute && i.model.tab_state(ext, tab).is_none() {
                        drop(i);
                        return self.route_cdp(&key, text, false);
                    }
                    // Routed while the tab waited, so `route` did not record it.
                    if h.target.get("sessionId").is_none() {
                        i.model.record_setup(ext, tab, &h.method, &h.params);
                    }
                    let rx = Self::start_call_in(&mut i, ext, "debugger.sendCommand", json!([h.target, h.method, h.params]));
                    drop(i);
                    tokio::spawn(async move { self.reply(&key, &id, session.as_deref(), Self::finish(rx).await) });
                }
            }
            Route::CreateTarget { ext, url } => {
                tokio::spawn(async move {
                    let r = self.create_target(&key, ext, &url).await.map(|t| json!({ "targetId": t }));
                    self.reply(&key, &id, session.as_deref(), r);
                });
            }
            Route::CloseTab { ext, tab } => {
                log::info!("browser bridge: chat {} asked to close tab {tab} (Target.closeTarget)", short(&key));
                self.lock().model.mark_closing(ext, &[tab]);
                tokio::spawn(async move {
                    let removed = self.call(ext, "tabs.remove", json!([tab])).await;
                    if removed.is_err() {
                        self.lock().model.unmark_closing(ext, &[tab]);
                    }
                    let r = removed.map(|_| json!({ "success": true }));
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
                log::info!("browser bridge: chat {} asked to close window {window} (Browser.close)", short(&key));
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
            log::info!("browser bridge: chat {} closes superseded tabs {stale:?} after opening tab {tab}", short(key));
            self.lock().model.mark_closing(ext, &stale);
            if self.call(ext, "tabs.remove", json!([&stale])).await.is_err() {
                self.lock().model.unmark_closing(ext, &stale);
            }
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
        let outcome = {
            let mut i = self.lock();
            // A tab that closed while the calls above were in flight lost its
            // owner entry in `drop_tab`; adopting it now would list a dead page.
            let still_ours = i.model.owners.get(&(ext, tab)).is_some_and(|o| o == key);
            match attached {
                Ok(info) if still_ours && i.model.chats.contains_key(key) => Ok(info),
                Ok(_) => {
                    i.model.owners.remove(&(ext, tab));
                    Err(if still_ours { "chat closed" } else { "tab closed while attaching" }.to_string())
                }
                Err(e) => {
                    i.model.owners.remove(&(ext, tab));
                    Err(e)
                }
            }
        };
        let info = match outcome {
            Ok(info) => info,
            Err(e) => {
                // Best effort: leaves no debugger banner on a tab nobody drives.
                // Not awaited: the chat's ops lock is held, and a hung browser must not stall it.
                drop(self.start_call(ext, "debugger.detach", json!([{ "tabId": tab }])));
                return Err(e);
            }
        };
        let mut i = self.lock();
        let target_id = info["targetId"].as_str().unwrap_or_default().to_string();
        let t = Tab { session_id: i.model.new_session_id(), target_info: info, children: Default::default(), chat_opened, ..Default::default() };
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
