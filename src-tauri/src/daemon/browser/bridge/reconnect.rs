//! The bridge's half of surviving an extension reconnect: when a connection
//! drops, its chats wait for the same install (`model/reconnect.rs` holds the
//! rules); when it says hello again every waiting tab is attached again under
//! its old session and replayed (`reattach.rs`), then the messages the chat
//! sent meanwhile run. A connection that stays away is given up on after
//! `GRACE`, and the tabs close for the chat the way they used to at once.

use std::time::{Duration, Instant};

use serde_json::json;

use super::chat_side::short;
use super::model::{Closed, ExtId, Rebound, GRACE};
use super::Bridge;

impl Bridge {
    /// The connection is closed and its chats are sorted: tell the ones that
    /// lost their tabs, re-bind the ones whose browser is already back, and
    /// start the clock on the rest.
    pub(super) fn after_ext_closed(&'static self, ext: ExtId, closed: Closed) {
        let waiting = closed.waiting.len();
        let waiting_keys: Vec<_> = closed.waiting.iter().map(|(k, _)| short(k).to_string()).collect();
        let rebound = !closed.rebound.chats.is_empty() || !closed.rebound.orphan_windows.is_empty();
        self.fail_held(closed.failed_held, "Target page, context or browser has been closed (the browser's connection dropped)");
        for (key, events) in closed.waiting {
            for event in events {
                self.send_chat(&key, event);
            }
        }
        let chats: Vec<_> = closed.dropped.iter().map(|(k, _)| short(k)).collect();
        log::info!("browser bridge: connection {ext} left {waiting} chat(s) waiting {waiting_keys:?} and dropped {} tab(s) of chats {chats:?}", closed.dropped.len());
        for (key, event) in closed.dropped {
            self.send_chat(&key, event);
        }
        if rebound {
            self.start_rebind(closed.rebound);
        } else if waiting > 0 {
            tokio::spawn(async move {
                tokio::time::sleep(GRACE).await;
                self.expire_waiting(ext);
            });
        }
    }

    /// The grace period for `ext` is over: chats that never got their browser
    /// back lose their tabs, and the messages they kept run against whatever
    /// browser there is now.
    fn expire_waiting(&'static self, ext: ExtId) {
        let closed = self.lock().model.expire(ext, Instant::now());
        if closed.waiting.is_empty() {
            return;
        }
        let keys: Vec<_> = closed.waiting.iter().map(|(k, _)| k.clone()).collect();
        let chats: Vec<_> = keys.iter().map(|k| short(k)).collect();
        log::info!("browser bridge: connection {ext} did not come back in {}s, dropped {} tab(s) of chats {chats:?}", GRACE.as_secs(), closed.dropped.len());
        self.fail_held(closed.failed_held, "Target page, context or browser has been closed (the browser did not reconnect)");
        for (key, event) in closed.dropped {
            self.send_chat(&key, event);
        }
        for key in keys {
            self.run_deferred(&key);
        }
    }

    /// `hello` (or a successor connection already up) re-bound chats to `rebound.ext`.
    pub(super) fn start_rebind(&'static self, rebound: Rebound) {
        let ext = rebound.ext;
        self.fail_held(rebound.failed_held, "Target page, context or browser has been closed (the tab id now belongs to another chat)");
        for (key, event) in rebound.dropped {
            self.send_chat(&key, event);
        }
        for (window, tabs) in rebound.orphan_windows {
            tokio::spawn(async move { self.close_window_if_ours(ext, window, &tabs).await });
        }
        for chat in rebound.chats {
            log::info!("browser bridge: chat {} re-bound to connection {ext}: {} tab(s), window {:?}", short(&chat.key), chat.tabs.len(), chat.window);
            tokio::spawn(async move {
                // The window may have been closed while the socket was down; a chat that finds out opens a new one on its next tab.
                if let Some(window) = chat.window {
                    // A browser that does not answer says nothing about the window, so only an error counts.
                    let got = tokio::time::timeout(Duration::from_secs(5), self.call(ext, "windows.get", json!([window, {}]))).await;
                    if matches!(got, Ok(Err(_))) && !self.ext_gone(ext) {
                        log::info!("browser bridge: chat {} window {window} is gone", short(&chat.key));
                        if let Some(c) = self.lock().model.chats.get_mut(&chat.key).filter(|c| c.window_id == Some(window)) {
                            c.window_id = None;
                        }
                    }
                }
                let attaches: Vec<_> = chat
                    .tabs
                    .iter()
                    .map(|&tab| {
                        let key = chat.key.clone();
                        tokio::spawn(async move { self.quiet_reattach(key, ext, tab).await })
                    })
                    .collect();
                // The messages that waited go after the tabs are back, so a new tab never races a replay;
                // a tab a password manager holds (parked) cannot hold them for more than this.
                let _ = tokio::time::timeout(Duration::from_secs(10), futures_util::future::join_all(attaches)).await;
                // A window id says nothing after a browser restart; it stays the chat's only while one of its tabs
                // passed the target-id check, and a chat with no tab left has no window worth keeping.
                if let Some(window) = chat.window {
                    if let Some(c) = self.lock().model.chats.get_mut(&chat.key).filter(|c| c.window_id == Some(window) && c.tabs.values().all(|t| t.adopted)) {
                        c.window_id = None;
                    }
                }
                self.run_deferred(&chat.key);
            });
        }
    }

    /// A browser restart renumbers windows and tabs, so a remembered window id
    /// could name one of Joe's windows: it is closed only while every tab in it
    /// is one the chat had.
    pub(super) async fn close_window_if_ours(&self, ext: ExtId, window: i64, tabs: &[i64]) {
        let Ok(info) = self.call(ext, "windows.get", json!([window, { "populate": true }])).await else { return };
        let inside: Vec<i64> = info["tabs"].as_array().map(|t| t.iter().filter_map(|t| t["id"].as_i64()).collect()).unwrap_or_default();
        if !inside.is_empty() && inside.iter().all(|t| tabs.contains(t)) {
            log::info!("browser bridge: closing window {window} of a chat that left while its browser was re-attaching");
            let _ = self.call(ext, "windows.remove", json!([window])).await;
        }
    }

    /// Runs again the calls a chat sent while its browser was away.
    fn run_deferred(&'static self, key: &str) {
        let messages = self.lock().model.take_deferred(key);
        for text in messages {
            self.on_cdp(key, &text);
        }
    }

    /// The connection is closed: a call to it can no longer succeed.
    pub(super) fn ext_gone(&self, ext: ExtId) -> bool {
        !self.lock().ext_tx.contains_key(&ext)
    }
}
