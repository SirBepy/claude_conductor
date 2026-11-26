//! The bridge's half of `browser_adopt_tab` (`model/adopt.rs` holds the rules):
//! listing Joe's tabs through the extension, attaching the debugger to the one
//! a chat names, and letting go of it again. An adopted tab is Joe's and is
//! never closed here, only detached.

use std::time::Instant;

use serde_json::json;

use crate::daemon::browser::adopt::{clean_title, clean_url, is_browser_page};

use super::model::{ExtId, Origin, TabId};
use super::{Bridge, Mine};

impl Bridge {
    /// The connection `session_id`'s chat adopts through, making the chat when
    /// its first Playwright child has not connected yet.
    fn adopt_ext(&self, session_id: &str, mine: &Mine, tab: Option<TabId>) -> Result<ExtId, String> {
        let mut i = self.lock();
        let has_child = i.chat_tx.contains_key(session_id);
        i.model.ensure_chat(session_id, mine.app, mine.profile.is_some(), has_child, Instant::now())?;
        i.model.adopt_ext(session_id, tab)
    }

    /// `browser_adopt_tab list`.
    pub async fn adopt_list(&self, session_id: &str, mine: &Mine) -> Result<String, String> {
        let ext = self.adopt_ext(session_id, mine, None)?;
        let tabs = self.call(ext, "tabs.query", json!([{ "windowType": "normal" }])).await.map_err(|e| {
            if e.contains("not allowed") {
                "Joe's browser still runs an older Claude Conductor Browser Bridge extension that cannot list tabs: tell Joe to reload it once (brave://extensions, edge://extensions or chrome://extensions, then Reload on the bridge).".to_string()
            } else {
                e
            }
        })?;
        Ok(self.lock().model.list_text(session_id, ext, &tabs, mine.app))
    }

    /// `browser_adopt_tab take`: attaches the debugger to Joe's tab and
    /// announces it to the chat like a popup. The tab is not moved, raised or
    /// reloaded.
    pub async fn adopt_take(&self, session_id: &str, mine: &Mine, tab: TabId) -> Result<String, String> {
        let ext = self.adopt_ext(session_id, mine, Some(tab))?;
        let ops = self.chat_ops(session_id);
        let _g = ops.lock().await;
        let info = self
            .call(ext, "tabs.get", json!([tab]))
            .await
            .map_err(|e| format!("Tab {tab} is not open in Joe's browser ({e}): run browser_adopt_tab with action list for the current ids."))?;
        let url = info["url"].as_str().unwrap_or_default();
        if is_browser_page(url) {
            return Err(format!("Tab {tab} is one of the browser's own pages, which cannot be driven."));
        }
        if info["windowId"].as_i64().is_some_and(|w| self.lock().model.is_chat_window(ext, w)) {
            return Err(format!("Tab {tab} is in a window that belongs to one of Claude's chats."));
        }
        self.attach_locked(session_id, ext, tab, Origin::Adopted).await.map_err(|e| format!("Could not adopt tab {tab}: {e}"))?;
        log::info!("browser bridge: chat {} adopted tab {tab}", super::chat_side::short(session_id));
        Ok(format!(
            "Adopted tab {tab}: \"{}\" {}. It was not moved, raised or reloaded, and it is never closed: closing it only lets go of it. \
Run browser_tabs with action list and select this tab's index before using other tools on it. Release it with browser_adopt_tab \
action release and tabId {tab}.",
            clean_title(info["title"].as_str().unwrap_or_default()),
            clean_url(url)
        ))
    }

    /// `browser_adopt_tab release`.
    pub async fn adopt_release(&self, session_id: &str, tab: TabId) -> Result<String, String> {
        self.release_adopted(session_id, tab).await?;
        log::info!("browser bridge: chat {} released adopted tab {tab}", super::chat_side::short(session_id));
        Ok(format!("Released tab {tab}. It stays open in Joe's browser."))
    }

    /// Lets go of an adopted tab: the chat hears the page detach, the
    /// debugger is released, and what waited on the tab fails. Never closes it.
    pub(super) async fn release_adopted(&self, key: &str, tab: TabId) -> Result<(), String> {
        let (ext, event, held) = self.lock().model.release_adopted(key, tab)?;
        self.send_chat(key, event);
        self.fail_held(held, "Target page, context or browser has been closed (the tab was released)");
        // Best effort: a tab that is gone has no debugger to release.
        let _ = self.call(ext, "debugger.detach", json!([{ "tabId": tab }])).await;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_extension_may_list_tabs_and_still_cannot_reach_history_or_bookmarks() {
        let js = include_str!("../../../../../browser-extension/background.js");
        assert!(js.contains("'tabs.query': (info) => chrome.tabs.query(info)"), "browser_adopt_tab list needs it");
        for denied in ["history.", "bookmarks.", "downloads.", "cookies."] {
            assert!(!js.lines().any(|l| l.trim_start().starts_with('\'') && l.contains(denied)), "{denied} must stay out of CALLS");
        }
    }
}
