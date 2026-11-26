//! Joe's own tabs a chat took with `browser_adopt_tab`. A tab the chat
//! adopted is its own like any other for routing (commands, events, re-attach),
//! but it is Joe's: nothing here ever closes it. Closing it, `Browser.close`,
//! the chat ending and a re-bind that gives up only detach the debugger
//! (`Route::ReleaseTab`, `Route::CloseWindow::release`, `Model::orphans`).

use std::time::Instant;

use crate::daemon::browser::adopt::{clean_title, clean_url, is_browser_page};
use crate::daemon::browser::target::App;

use super::{profile_ambiguous_message, ExtId, Held, Model, TabId, WindowId, NOT_CONNECTED};

/// Rows a list shows; Joe can have hundreds of tabs open.
const LIST_MAX: usize = 100;

const RECONNECTING: &str = "Joe's browser is reconnecting to Claude Conductor: try browser_adopt_tab again in a moment.";

impl Model {
    /// Makes the chat of `key` when it has none, so a tab can be adopted before
    /// the chat's first Playwright child connects. Without a child it counts as
    /// parked at once, so the 24-hour sweep owns it like any other.
    pub fn ensure_chat(&mut self, key: &str, app: App, wants_profile: bool, has_child: bool, now: Instant) -> Result<(), String> {
        match self.chats.get(key) {
            Some(c) if c.app != app || c.wants_profile != wants_profile => Err("This chat's browser changed: call browser_adopt_tab again.".into()),
            Some(_) => Ok(()),
            None => {
                self.insert_chat(key, app, wants_profile);
                if let (false, Some(c)) = (has_child, self.chats.get_mut(key)) {
                    c.parked = Some(now);
                }
                Ok(())
            }
        }
    }

    /// The connection `key`'s chat adopts through. `tab`: the tab it is about
    /// to take, which must be nobody's yet.
    pub fn adopt_ext(&mut self, key: &str, tab: Option<TabId>) -> Result<ExtId, String> {
        let (app, wants_profile, current, waiting) = {
            let c = self.chats.get(key).ok_or("unknown chat")?;
            (c.app, c.wants_profile, c.ext, c.reconnect.is_some())
        };
        if waiting {
            return Err(RECONNECTING.into());
        }
        let ext = match current.filter(|e| self.exts.get(e).is_some_and(|x| x.ready)) {
            Some(e) => e,
            None => {
                if wants_profile && self.profile_ambiguous(app) {
                    return Err(profile_ambiguous_message(app));
                }
                let e = self.pick_ext_for(app, wants_profile).ok_or(NOT_CONNECTED)?;
                if let Some(c) = self.chats.get_mut(key) {
                    c.ext = Some(e);
                }
                e
            }
        };
        match tab.and_then(|t| self.owners.get(&(ext, t))) {
            Some(owner) if owner == key => Err("This chat already holds that tab.".into()),
            Some(_) => Err("Another chat holds that tab.".into()),
            None => Ok(ext),
        }
    }

    /// A chat's own window holds only that chat's pages, so a tab in one is never adoptable.
    pub fn is_chat_window(&self, ext: ExtId, window: WindowId) -> bool {
        self.chats.values().any(|c| c.ext == Some(ext) && c.window_id == Some(window))
    }

    /// The tabs of `key`'s chat that are Joe's.
    pub fn adopted_tabs(&self, key: &str) -> Vec<TabId> {
        self.chats.get(key).map_or_else(Vec::new, |c| c.tabs.iter().filter(|(_, t)| t.adopted).map(|(id, _)| *id).collect())
    }

    /// Lets go of an adopted tab: the chat no longer owns it. Returns the
    /// connection, the detach event for the chat and the commands that were
    /// waiting on the tab. The caller detaches the debugger.
    pub fn release_adopted(&mut self, key: &str, tab: TabId) -> Result<(ExtId, serde_json::Value, Vec<Held>), String> {
        let chat = self.chats.get(key).ok_or("unknown chat")?;
        match chat.tabs.get(&tab) {
            None => return Err(format!("This chat holds no tab {tab}.")),
            Some(t) if !t.adopted => return Err(format!("Tab {tab} is not an adopted tab: only a tab taken with browser_adopt_tab can be released.")),
            Some(_) => {}
        }
        let ext = chat.ext.ok_or(NOT_CONNECTED)?;
        let held = self.take_held(ext, tab);
        let (_, event) = self.drop_tab(ext, tab).ok_or("that tab is gone")?;
        Ok((ext, event, held))
    }

    /// Adopted tabs of chats that were removed, for the bridge to detach.
    pub fn take_orphans(&mut self) -> Vec<(ExtId, TabId)> {
        std::mem::take(&mut self.orphans)
    }

    /// What `browser_adopt_tab list` answers: Joe's tabs from the extension's
    /// `tabs.query`, minus the ones another chat holds, the ones in a chat's own
    /// window and the browser's own pages.
    pub fn list_text(&self, key: &str, ext: ExtId, tabs: &serde_json::Value, app: App) -> String {
        let mut rows = Vec::new();
        for t in tabs.as_array().map(Vec::as_slice).unwrap_or_default() {
            let (Some(id), url) = (t["id"].as_i64(), t["url"].as_str().unwrap_or_default()) else { continue };
            let window = t["windowId"].as_i64();
            let held = match self.owners.get(&(ext, id)) {
                Some(owner) if owner == key => Some(self.chats.get(key).and_then(|c| c.tabs.get(&id)).is_some_and(|t| t.adopted)),
                Some(_) => continue,
                None => None,
            };
            if is_browser_page(url) || (held.is_none() && window.is_some_and(|w| self.is_chat_window(ext, w))) {
                continue;
            }
            let mark = match held {
                Some(true) => " [adopted by this chat]",
                Some(false) => " [this chat's own tab]",
                None => "",
            };
            let active = if t["active"] == true { ", the one showing in its window" } else { "" };
            rows.push(format!(
                "- tabId {id} (window {}{active}): \"{}\" {}{mark}",
                window.map_or_else(|| "?".to_string(), |w| w.to_string()),
                clean_title(t["title"].as_str().unwrap_or_default()),
                clean_url(url)
            ));
        }
        if rows.is_empty() {
            return format!("Joe has no open {} tabs this chat can adopt.", app.label());
        }
        let more = rows.len().saturating_sub(LIST_MAX);
        rows.truncate(LIST_MAX);
        let mut out = format!("Joe's open {} tabs ({}{}):\n{}\n", app.label(), rows.len(), if more > 0 { format!(", {more} more not shown") } else { String::new() }, rows.join("\n"));
        out.push_str("Take one with browser_adopt_tab action take and its tabId.");
        out
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::super::{Ext, Route, Tab, TabState};
    use super::*;

    fn model() -> Model {
        let mut m = Model::default();
        m.exts.insert(1, Ext { app: Some(App::Brave), user_agent: "Mozilla/5.0 Chrome/155.0.1.2".into(), connected_at: Instant::now(), ready: true, install_id: "i".into() });
        m.ensure_chat("a", App::Brave, false, true, Instant::now()).unwrap();
        m
    }

    fn adopt(m: &mut Model, key: &str, tab: TabId, target: &str) -> String {
        let session = m.new_session_id();
        m.owners.insert((1, tab), key.into());
        m.chats.get_mut(key).unwrap().tabs.insert(tab, Tab { session_id: session.clone(), target_info: json!({ "targetId": target, "type": "page" }), adopted: true, ..Default::default() });
        session
    }

    fn route(m: &mut Model, key: &str, method: &str, params: serde_json::Value, session: Option<&str>) -> Route {
        m.route(key, method, &params, session, "Mozilla/5.0 Chrome/155.0.1.2", &mut vec![])
    }

    #[test]
    fn a_chat_can_adopt_before_its_first_child_and_is_then_parked() {
        let mut m = Model::default();
        m.exts.insert(1, Ext { app: Some(App::Brave), user_agent: String::new(), connected_at: Instant::now(), ready: true, install_id: "i".into() });
        let t0 = Instant::now();
        m.ensure_chat("a", App::Brave, false, false, t0).unwrap();
        assert_eq!(m.chats["a"].parked, Some(t0), "no child yet, so the sweep owns it");
        assert_eq!(m.adopt_ext("a", Some(5)), Ok(1));
        assert!(m.ensure_chat("a", App::Edge, false, false, t0).is_err(), "a chat on another browser is not silently reused");
        m.ensure_chat("a", App::Brave, false, true, t0).unwrap();
        m.ensure_chat("b", App::Brave, false, true, t0).unwrap();
        assert_eq!(m.chats["b"].parked, None, "a chat with a child is not parked");
    }

    #[test]
    fn a_tab_another_chat_holds_or_this_one_already_holds_is_refused() {
        let mut m = model();
        m.ensure_chat("b", App::Brave, false, true, Instant::now()).unwrap();
        adopt(&mut m, "b", 7, "T7");
        assert_eq!(m.adopt_ext("a", Some(7)), Err("Another chat holds that tab.".into()));
        adopt(&mut m, "a", 8, "T8");
        assert_eq!(m.adopt_ext("a", Some(8)), Err("This chat already holds that tab.".into()));
        assert_eq!(m.adopt_ext("a", Some(9)), Ok(1));
        m.chats.get_mut("a").unwrap().reconnect = Some(super::super::Reconnect { install_id: "i".into(), since: Instant::now(), user_agent: String::new() });
        assert!(m.adopt_ext("a", Some(9)).unwrap_err().contains("reconnecting"));
    }

    #[test]
    fn a_chat_without_a_browser_connection_is_told_so() {
        let mut m = Model::default();
        m.ensure_chat("a", App::Brave, false, true, Instant::now()).unwrap();
        assert_eq!(m.adopt_ext("a", None), Err(NOT_CONNECTED.into()));
    }

    #[test]
    fn closing_an_adopted_tab_releases_it_and_closing_the_chats_own_tab_still_closes_it() {
        let mut m = model();
        let joes = adopt(&mut m, "a", 5, "T5");
        let own = m.new_session_id();
        m.owners.insert((1, 6), "a".into());
        m.chats.get_mut("a").unwrap().tabs.insert(6, Tab { session_id: own, target_info: json!({ "targetId": "T6", "type": "page" }), chat_opened: true, ..Default::default() });
        assert_eq!(route(&mut m, "a", "Target.closeTarget", json!({ "targetId": "T5" }), None), Route::ReleaseTab { ext: 1, tab: 5 }, "Joe's tab is never closed on a chat's say-so");
        assert_eq!(route(&mut m, "a", "Target.closeTarget", json!({ "targetId": "T6" }), None), Route::CloseTab { ext: 1, tab: 6 });
        assert!(matches!(route(&mut m, "a", "Page.navigate", json!({ "url": "https://x.example" }), Some(&joes)), Route::Forward { .. }), "an adopted tab is driven like any other");
        assert_eq!(route(&mut m, "a", "Page.close", json!({}), Some(&joes)), Route::ReleaseTab { ext: 1, tab: 5 }, "page.close() on Joe's tab only lets go of it");
        let own_session = m.chats["a"].tabs[&6].session_id.clone();
        assert!(matches!(route(&mut m, "a", "Page.close", json!({}), Some(&own_session)), Route::Forward { .. }), "the chat's own tab closes as before");
    }

    #[test]
    fn browser_close_lets_go_of_adopted_tabs_and_closes_only_the_chats_window() {
        let mut m = model();
        adopt(&mut m, "a", 5, "T5");
        let r = route(&mut m, "a", "Browser.close", json!({}), None);
        assert_eq!(r, Route::CloseWindow { ext: 1, window: None, release: vec![5] });
        m.chats.get_mut("a").unwrap().window_id = Some(10);
        assert_eq!(route(&mut m, "a", "Browser.close", json!({}), None), Route::CloseWindow { ext: 1, window: Some(10), release: vec![5] });
    }

    #[test]
    fn a_new_page_of_the_chat_never_supersedes_an_adopted_tab() {
        let mut m = model();
        adopt(&mut m, "a", 5, "T5");
        m.chats.get_mut("a").unwrap().tabs.get_mut(&5).unwrap().chat_opened = true;
        assert!(m.superseded("a", 6).is_empty(), "even a tab wrongly marked as opened by the chat is spared");
    }

    #[test]
    fn releasing_removes_the_tab_from_the_chat_and_fails_what_waited_on_it() {
        let mut m = model();
        let s = adopt(&mut m, "a", 5, "T5");
        m.begin_reattach(1, 5);
        let held = Held { key: "a".into(), id: json!(1), session: Some(s.clone()), target: json!({}), method: "x".into(), params: json!({}) };
        m.hold(1, 5, held).unwrap();
        let (ext, event, waiting) = m.release_adopted("a", 5).unwrap();
        assert_eq!(ext, 1);
        assert_eq!(event["method"], json!("Target.detachedFromTarget"));
        assert_eq!(event["params"]["sessionId"], json!(s));
        assert_eq!(waiting.len(), 1);
        assert!(m.chats["a"].tabs.is_empty() && m.owners.is_empty(), "the tab is nobody's again");
        assert!(m.release_adopted("a", 5).unwrap_err().contains("no tab 5"));
    }

    #[test]
    fn only_an_adopted_tab_can_be_released() {
        let mut m = model();
        let own = m.new_session_id();
        m.owners.insert((1, 6), "a".into());
        m.chats.get_mut("a").unwrap().tabs.insert(6, Tab { session_id: own, chat_opened: true, ..Default::default() });
        assert!(m.release_adopted("a", 6).unwrap_err().contains("not an adopted tab"));
        assert!(m.chats["a"].tabs.contains_key(&6));
    }

    #[test]
    fn a_chat_that_ends_leaves_its_adopted_tabs_open_and_queues_only_their_detach() {
        let mut m = model();
        adopt(&mut m, "a", 5, "T5");
        m.chats.get_mut("a").unwrap().window_id = Some(10);
        let window = m.remove_chat("a", Instant::now());
        assert_eq!(window, Some((1, 10, None)), "only the chat's own window is closed");
        assert_eq!(m.take_orphans(), vec![(1, 5)], "Joe's tab is only detached");
        assert!(m.take_orphans().is_empty());
        assert!(m.owners.is_empty());
    }

    #[test]
    fn an_adopted_tab_never_vouches_for_the_window_a_leaving_chat_may_close() {
        let mut m = model();
        adopt(&mut m, "a", 5, "T5");
        m.owners.insert((1, 6), "a".into());
        m.chats.get_mut("a").unwrap().tabs.insert(6, Tab { session_id: "s6".into(), target_info: json!({ "targetId": "T6" }), chat_opened: true, ..Default::default() });
        let chat = m.chats.get_mut("a").unwrap();
        chat.window_id = Some(10);
        chat.reconnect = Some(super::super::reconnect::Reconnect { install_id: "i".into(), since: Instant::now(), user_agent: String::new() });
        assert_eq!(m.remove_chat("a", Instant::now()), Some((1, 10, Some(vec![6]))), "a restart can renumber Joe's tab into the chat's old window, so only its own tab counts");
    }

    #[test]
    fn an_adopted_tab_keeps_a_chat_parked_and_a_takeover_attaches_it_fresh() {
        let mut m = model();
        adopt(&mut m, "a", 5, "T5");
        assert_eq!(m.park_chat("a", Instant::now()), super::super::Left::Parked, "a tab is worth keeping, with or without a window");
        let claim = m.claim_session("a", App::Brave, false, Instant::now());
        assert_eq!(claim, super::super::Claim::Resumed { ext: Some(1), tabs: vec![5] });
        assert_eq!(m.chats["a"].tabs[&5].state, TabState::Reattaching);
        assert!(m.chats["a"].tabs[&5].adopted, "it is still Joe's");
    }

    #[test]
    fn the_list_leaves_out_other_chats_tabs_chat_windows_and_browser_pages_and_marks_this_chats() {
        let mut m = model();
        m.ensure_chat("b", App::Brave, false, true, Instant::now()).unwrap();
        m.chats.get_mut("b").unwrap().window_id = Some(20);
        adopt(&mut m, "b", 2, "T2");
        adopt(&mut m, "a", 3, "T3");
        let own = m.new_session_id();
        m.owners.insert((1, 4), "a".into());
        m.chats.get_mut("a").unwrap().tabs.insert(4, Tab { session_id: own, chat_opened: true, ..Default::default() });
        let tabs = json!([
            { "id": 1, "windowId": 1, "title": "Inbox\n(3)", "url": "https://mail.example/u/0/?token=SECRET#x", "active": true },
            { "id": 2, "windowId": 1, "title": "Other chat's", "url": "https://other.example/" },
            { "id": 3, "windowId": 1, "title": "Mine adopted", "url": "https://c.example/" },
            { "id": 4, "windowId": 20, "title": "Own page", "url": "https://d.example/" },
            { "id": 5, "windowId": 20, "title": "Not attached yet, in b's window", "url": "https://e.example/" },
            { "id": 6, "windowId": 1, "title": "Settings", "url": "chrome://settings" }
        ]);
        let text = m.list_text("a", 1, &tabs, App::Brave);
        assert!(text.contains("tabId 1 (window 1, the one showing in its window): \"Inbox (3)\" https://mail.example/u/0/"), "{text}");
        assert!(!text.contains("SECRET"), "the query string is dropped: {text}");
        assert!(!text.contains("Inbox\n"), "a title is one line: {text}");
        assert!(text.contains("tabId 3") && text.contains("[adopted by this chat]"), "{text}");
        assert!(text.contains("tabId 4") && text.contains("[this chat's own tab]"), "{text}");
        for hidden in ["tabId 2", "tabId 5", "tabId 6"] {
            assert!(!text.contains(hidden), "{hidden} must not be listed: {text}");
        }
        assert!(m.list_text("a", 1, &json!([]), App::Brave).contains("no open Brave tabs"));
    }

    #[test]
    fn a_long_list_is_cut_and_says_how_many_more() {
        let m = model();
        let tabs: Vec<_> = (0..130).map(|i| json!({ "id": i + 100, "windowId": 1, "title": "t", "url": "https://x.example/" })).collect();
        let text = m.list_text("a", 1, &json!(tabs), App::Brave);
        assert!(text.contains("100, 30 more not shown"), "{text}");
        assert_eq!(text.lines().filter(|l| l.starts_with("- tabId")).count(), 100);
    }
}
