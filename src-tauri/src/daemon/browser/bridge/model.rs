//! The bridge's bookkeeping: which extension connections are up, which chat
//! owns which tab, and where each CDP message goes. Pure state with no I/O,
//! so every routing rule is unit-testable; `mod.rs` does the sockets.
//!
//! Each chat sees a browser that holds only its own tabs. Playwright's
//! `connectOverCDP` gets a browser-level session from us (the extension's
//! `chrome.debugger` only reaches single tabs), so the root-session methods
//! Playwright sends are answered here, and every tab session is checked
//! against its owner before anything reaches the extension.

use std::collections::{HashMap, HashSet};
use std::time::Instant;

use serde_json::{json, Value};

use super::super::target::App;

pub type ExtId = u64;
pub type TabId = i64;
pub type WindowId = i64;

#[derive(Debug)]
pub struct Ext {
    pub app: Option<App>,
    pub user_agent: String,
    pub connected_at: Instant,
    /// Set by the extension's `hello`; until then it is not offered to chats.
    pub ready: bool,
}

#[derive(Debug, Default)]
pub struct Tab {
    pub session_id: String,
    pub target_info: Value,
    /// Flat child sessions (out-of-process iframes, workers) Chrome attached
    /// under this tab; commands naming one go to this tab with that session.
    pub children: HashSet<String>,
    /// Opened by the chat itself (`Target.createTarget`), as opposed to by a
    /// page (a popup, a `target=_blank` link).
    pub chat_opened: bool,
}

#[derive(Debug)]
pub struct Chat {
    pub ext: Option<ExtId>,
    pub window_id: Option<WindowId>,
    pub tabs: HashMap<TabId, Tab>,
    /// Playwright's root `Target.setAutoAttach` arrived, so new tabs in this
    /// chat's window (popups, `target=_blank`) are attached as they appear.
    pub auto_attach: bool,
}

#[derive(Default)]
pub struct Model {
    pub exts: HashMap<ExtId, Ext>,
    pub chats: HashMap<String, Chat>,
    /// Tab ids are per browser, so two connected browsers can reuse one.
    pub owners: HashMap<(ExtId, TabId), String>,
    next_session: u64,
}

/// What to do with one CDP message from a chat's Playwright.
#[derive(Debug, PartialEq)]
pub enum Route {
    Reply(Value),
    Fail(String),
    /// Send `debugger.sendCommand` to this tab, as is.
    Forward { ext: ExtId, target: Value },
    /// Needs extension calls before it can answer.
    CreateTarget { ext: ExtId, url: String },
    CloseTab { ext: ExtId, tab: TabId },
    /// Make a tab current inside its window without raising the window over
    /// whatever Joe is doing (`Page.bringToFront` would).
    Activate { ext: ExtId, tab: TabId },
    CloseWindow { ext: ExtId, window: WindowId },
}

impl Model {
    pub fn new_session_id(&mut self) -> String {
        self.next_session += 1;
        format!("cc-tab-{}", self.next_session)
    }

    /// The connection a chat on `app` should drive: the newest ready one for
    /// that browser, else the only ready one when exactly one is up (a build
    /// whose brand the extension cannot name, such as plain Chromium).
    pub fn pick_ext(&self, app: App) -> Option<ExtId> {
        let ready = || self.exts.iter().filter(|(_, e)| e.ready);
        ready()
            .filter(|(_, e)| e.app == Some(app))
            .max_by_key(|(_, e)| e.connected_at)
            .map(|(id, _)| *id)
            .or_else(|| {
                let mut all = ready();
                match (all.next(), all.next()) {
                    (Some((id, e)), None) if e.app.is_none() => Some(*id),
                    _ => None,
                }
            })
    }

    pub fn tab_by_session<'a>(chat: &'a Chat, session_id: &str) -> Option<(TabId, Option<&'a str>)> {
        for (id, t) in &chat.tabs {
            if t.session_id == session_id {
                return Some((*id, None));
            }
        }
        for (id, t) in &chat.tabs {
            if let Some(child) = t.children.get(session_id) {
                return Some((*id, Some(child.as_str())));
            }
        }
        None
    }

    pub fn attached_event(tab: &Tab) -> Value {
        let mut info = tab.target_info.clone();
        info["attached"] = json!(true);
        json!({ "method": "Target.attachedToTarget", "params": { "sessionId": tab.session_id, "targetInfo": info, "waitingForDebugger": false } })
    }

    /// Routes one command. `events` collects messages to send to the chat
    /// before the reply (a root `setAutoAttach` replays the chat's tabs).
    pub fn route(&mut self, chat_key: &str, method: &str, params: &Value, session_id: Option<&str>, user_agent: &str, events: &mut Vec<Value>) -> Route {
        let Some(chat) = self.chats.get_mut(chat_key) else { return Route::Fail("unknown chat".into()) };
        let Some(ext) = chat.ext else { return Route::Fail(NOT_CONNECTED.into()) };
        if let Some(session_id) = session_id {
            let Some((tab, child)) = Self::tab_by_session(chat, session_id) else {
                return Route::Fail(format!("session {session_id} does not belong to this chat"));
            };
            return match (method, child) {
                ("Page.bringToFront", None) => Route::Activate { ext, tab },
                // Hidden (minimized) windows only keep rendering, and so only
                // let clicks and screenshots finish, with focus emulation on.
                ("Emulation.setFocusEmulationEnabled", _) if params["enabled"] == json!(false) => Route::Reply(json!({})),
                _ => Route::Forward { ext, target: tab_target(tab, child) },
            };
        }
        match method {
            "Browser.getVersion" => {
                let version = user_agent.split("Chrome/").nth(1).and_then(|v| v.split_whitespace().next()).unwrap_or("0.0.0.0");
                Route::Reply(json!({ "protocolVersion": "1.3", "product": format!("Chrome/{version}"), "revision": "", "userAgent": user_agent, "jsVersion": "" }))
            }
            // Downloads stay the browser's own; the rest are no-ops for a
            // browser that only ever holds this chat's tabs.
            "Browser.setDownloadBehavior" | "Target.setDiscoverTargets" => Route::Reply(json!({})),
            "Target.setAutoAttach" => {
                chat.auto_attach = true;
                events.extend(chat.tabs.values().map(Self::attached_event));
                Route::Reply(json!({}))
            }
            // Playwright's barrier after setAutoAttach: any answer will do.
            "Target.getTargetInfo" => Route::Reply(json!({ "targetInfo": { "targetId": "browser", "type": "browser", "title": "", "url": "", "attached": true, "canAccessOpener": false } })),
            "Target.getTargets" => Route::Reply(json!({ "targetInfos": chat.tabs.values().map(|t| t.target_info.clone()).collect::<Vec<_>>() })),
            "Target.createTarget" => Route::CreateTarget { ext, url: params["url"].as_str().unwrap_or("about:blank").to_string() },
            "Target.closeTarget" | "Target.activateTarget" => {
                let target_id = params["targetId"].as_str().unwrap_or_default();
                match chat.tabs.iter().find(|(_, t)| t.target_info["targetId"].as_str() == Some(target_id)) {
                    Some((tab, _)) if method == "Target.closeTarget" => Route::CloseTab { ext, tab: *tab },
                    Some((tab, _)) => Route::Activate { ext, tab: *tab },
                    None if method == "Target.closeTarget" => Route::Reply(json!({ "success": false })),
                    None => Route::Fail(format!("target {target_id} does not belong to this chat")),
                }
            }
            // Never Joe's whole browser: "closing" it closes this chat's window.
            "Browser.close" => match chat.window_id {
                Some(window) => Route::CloseWindow { ext, window },
                None => Route::Reply(json!({})),
            },
            // Separate browser contexts would need a browser-wide session the
            // extension cannot give; Playwright MCP uses the default one.
            m if m.starts_with("Target.") && m.contains("BrowserContext") => Route::Fail(format!("{m} is not supported in Joe's browser")),
            // Browser-scoped (Storage.*, Network.*): chrome.debugger needs a
            // tab, and any of this chat's tabs gives the same answer.
            _ => match chat.tabs.keys().next() {
                Some(tab) => Route::Forward { ext, target: tab_target(*tab, None) },
                None => Route::Fail(format!("{method} needs a page open first")),
            },
        }
    }

    /// Who should hear a `chrome.debugger.onEvent`, and as what message.
    pub fn route_event(&mut self, ext: ExtId, source: &Value, method: &str, params: &Value) -> Option<(String, Value)> {
        let tab = source["tabId"].as_i64()?;
        let key = self.owners.get(&(ext, tab))?.clone();
        let t = self.chats.get_mut(&key)?.tabs.get_mut(&tab)?;
        if let Some(child) = params["sessionId"].as_str() {
            match method {
                "Target.attachedToTarget" => {
                    t.children.insert(child.to_string());
                }
                "Target.detachedFromTarget" => {
                    t.children.remove(child);
                }
                _ => {}
            }
        }
        let session = source["sessionId"].as_str().unwrap_or(&t.session_id).to_string();
        Some((key, json!({ "sessionId": session, "method": method, "params": params })))
    }

    /// Forgets a tab (closed, or its debugger detached) and returns the chat
    /// to notify with the matching detach event.
    pub fn drop_tab(&mut self, ext: ExtId, tab: TabId) -> Option<(String, Value)> {
        let key = self.owners.remove(&(ext, tab))?;
        let t = self.chats.get_mut(&key)?.tabs.remove(&tab)?;
        let event = json!({ "method": "Target.detachedFromTarget", "params": { "sessionId": t.session_id, "targetId": t.target_info["targetId"] } });
        Some((key, event))
    }

    /// The chat that should take a newly created tab, if any: the one whose
    /// window it opened in, or the owner of the tab that opened it.
    pub fn claimant(&self, ext: ExtId, window: Option<WindowId>, opener: Option<TabId>) -> Option<String> {
        if let Some(key) = opener.and_then(|o| self.owners.get(&(ext, o))) {
            return Some(key.clone());
        }
        let window = window?;
        self.chats.iter().find(|(_, c)| c.ext == Some(ext) && c.window_id == Some(window)).map(|(k, _)| k.clone())
    }

    /// The chat's other self-opened tabs, to close once it opened `newest`:
    /// a chat works in one tab at a time, so each new one replaces the last
    /// instead of piling up. Page-opened tabs stay, since closing the page
    /// that opened a sign-in popup breaks that sign-in.
    pub fn superseded(&self, chat_key: &str, newest: TabId) -> Vec<TabId> {
        self.chats.get(chat_key).map_or_else(Vec::new, |c| {
            c.tabs.iter().filter(|(id, t)| **id != newest && t.chat_opened).map(|(id, _)| *id).collect()
        })
    }

    /// An extension connection went away: every chat on it loses its tabs
    /// and window. Returns the detach events to deliver.
    pub fn drop_ext(&mut self, ext: ExtId) -> Vec<(String, Value)> {
        self.exts.remove(&ext);
        let tabs: Vec<_> = self.owners.keys().filter(|(e, _)| *e == ext).copied().collect();
        let events = tabs.into_iter().filter_map(|(e, t)| self.drop_tab(e, t)).collect();
        for chat in self.chats.values_mut().filter(|c| c.ext == Some(ext)) {
            chat.ext = None;
            chat.window_id = None;
        }
        events
    }
}

pub fn tab_target(tab: TabId, child: Option<&str>) -> Value {
    match child {
        Some(s) => json!({ "tabId": tab, "sessionId": s }),
        None => json!({ "tabId": tab }),
    }
}

pub const NOT_CONNECTED: &str = "Joe's browser is not connected to Claude Conductor: the Claude Conductor Browser Bridge extension \
is not running in it. Tell Joe with send_message to open that browser and check the extension is installed (Settings > Claude's \
browser), or use browser_target to switch to Claude's own browser.";

#[cfg(test)]
mod tests {
    use super::*;

    fn ext(app: Option<App>, ready: bool) -> Ext {
        Ext { app, user_agent: "Mozilla/5.0 Chrome/155.0.1.2 Safari/537.36".into(), connected_at: Instant::now(), ready }
    }

    fn model_with_chat(key: &str) -> Model {
        let mut m = Model::default();
        m.exts.insert(1, ext(Some(App::Brave), true));
        m.chats.insert(key.into(), Chat { ext: Some(1), window_id: Some(10), tabs: HashMap::new(), auto_attach: false });
        m
    }

    fn add_tab(m: &mut Model, key: &str, tab: TabId, target: &str) -> String {
        let session = m.new_session_id();
        m.owners.insert((1, tab), key.into());
        m.chats.get_mut(key).unwrap().tabs.insert(tab, Tab { session_id: session.clone(), target_info: json!({ "targetId": target, "type": "page" }), children: HashSet::new(), chat_opened: true });
        session
    }

    fn route(m: &mut Model, key: &str, method: &str, params: Value, session: Option<&str>) -> (Route, Vec<Value>) {
        let mut events = vec![];
        let r = m.route(key, method, &params, session, "Mozilla/5.0 Chrome/155.0.1.2 Safari/537.36", &mut events);
        (r, events)
    }

    #[test]
    fn a_chat_cannot_reach_another_chats_tab() {
        let mut m = model_with_chat("a");
        m.chats.insert("b".into(), Chat { ext: Some(1), window_id: Some(11), tabs: HashMap::new(), auto_attach: false });
        let b_session = add_tab(&mut m, "b", 7, "T7");
        let (r, _) = route(&mut m, "a", "Runtime.evaluate", json!({}), Some(&b_session));
        assert!(matches!(r, Route::Fail(e) if e.contains("does not belong")));
        let (r, _) = route(&mut m, "a", "Target.closeTarget", json!({ "targetId": "T7" }), None);
        assert_eq!(r, Route::Reply(json!({ "success": false })), "closing someone else's tab is a no-op");
        let (r, _) = route(&mut m, "a", "Target.getTargets", json!({}), None);
        assert_eq!(r, Route::Reply(json!({ "targetInfos": [] })), "other chats' tabs are invisible");
    }

    #[test]
    fn own_tab_commands_and_child_sessions_forward_to_the_tab() {
        let mut m = model_with_chat("a");
        let s = add_tab(&mut m, "a", 5, "T5");
        assert_eq!(route(&mut m, "a", "Page.navigate", json!({}), Some(&s)).0, Route::Forward { ext: 1, target: json!({ "tabId": 5 }) });
        m.route_event(1, &json!({ "tabId": 5 }), "Target.attachedToTarget", &json!({ "sessionId": "CHILD" }));
        assert_eq!(route(&mut m, "a", "Runtime.enable", json!({}), Some("CHILD")).0, Route::Forward { ext: 1, target: json!({ "tabId": 5, "sessionId": "CHILD" }) });
    }

    #[test]
    fn raising_a_page_never_raises_its_window_and_focus_emulation_stays_on() {
        let mut m = model_with_chat("a");
        let s = add_tab(&mut m, "a", 5, "T5");
        assert_eq!(route(&mut m, "a", "Page.bringToFront", json!({}), Some(&s)).0, Route::Activate { ext: 1, tab: 5 });
        assert_eq!(route(&mut m, "a", "Emulation.setFocusEmulationEnabled", json!({ "enabled": false }), Some(&s)).0, Route::Reply(json!({})));
        assert!(matches!(route(&mut m, "a", "Emulation.setFocusEmulationEnabled", json!({ "enabled": true }), Some(&s)).0, Route::Forward { .. }));
    }

    #[test]
    fn closing_the_browser_closes_only_the_chats_window() {
        let mut m = model_with_chat("a");
        assert_eq!(route(&mut m, "a", "Browser.close", json!({}), None).0, Route::CloseWindow { ext: 1, window: 10 });
    }

    #[test]
    fn root_auto_attach_replays_the_chats_own_tabs() {
        let mut m = model_with_chat("a");
        let s = add_tab(&mut m, "a", 5, "T5");
        let (r, events) = route(&mut m, "a", "Target.setAutoAttach", json!({ "autoAttach": true }), None);
        assert_eq!(r, Route::Reply(json!({})));
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["params"]["sessionId"], json!(s));
        assert_eq!(events[0]["params"]["targetInfo"]["attached"], json!(true));
        assert!(m.chats["a"].auto_attach);
    }

    #[test]
    fn version_comes_from_the_real_browser() {
        let mut m = model_with_chat("a");
        let (Route::Reply(v), _) = route(&mut m, "a", "Browser.getVersion", json!({}), None) else { panic!() };
        assert_eq!(v["product"], json!("Chrome/155.0.1.2"));
    }

    #[test]
    fn a_chat_with_no_browser_gets_the_way_out() {
        let mut m = model_with_chat("a");
        m.chats.get_mut("a").unwrap().ext = None;
        assert!(matches!(route(&mut m, "a", "Browser.getVersion", json!({}), None).0, Route::Fail(e) if e.contains("browser_target")));
    }

    #[test]
    fn events_go_only_to_the_tab_owner_with_its_session() {
        let mut m = model_with_chat("a");
        let s = add_tab(&mut m, "a", 5, "T5");
        let (key, msg) = m.route_event(1, &json!({ "tabId": 5 }), "Page.loadEventFired", &json!({})).unwrap();
        assert_eq!((key.as_str(), msg["sessionId"].as_str()), ("a", Some(s.as_str())));
        assert!(m.route_event(1, &json!({ "tabId": 6 }), "Page.loadEventFired", &json!({})).is_none(), "a tab no chat owns stays silent");
        assert!(m.route_event(2, &json!({ "tabId": 5 }), "Page.loadEventFired", &json!({})).is_none(), "same tab id in another browser");
    }

    #[test]
    fn new_tabs_go_to_the_window_owner_or_the_opener_owner() {
        let mut m = model_with_chat("a");
        add_tab(&mut m, "a", 5, "T5");
        assert_eq!(m.claimant(1, Some(10), None).as_deref(), Some("a"));
        assert_eq!(m.claimant(1, Some(99), Some(5)).as_deref(), Some("a"), "a popup in its own window");
        assert_eq!(m.claimant(1, Some(99), None), None, "Joe's own windows are never claimed");
    }

    #[test]
    fn a_new_chat_opened_tab_supersedes_the_old_one_but_never_a_popup() {
        let mut m = model_with_chat("a");
        add_tab(&mut m, "a", 5, "T5");
        add_tab(&mut m, "a", 6, "T6");
        m.chats.get_mut("a").unwrap().tabs.get_mut(&6).unwrap().chat_opened = false;
        add_tab(&mut m, "a", 7, "T7");
        assert_eq!(m.superseded("a", 7), vec![5], "the old tab goes, the popup stays");
        assert!(m.superseded("nobody", 7).is_empty());
    }

    #[test]
    fn a_dropped_extension_detaches_its_chats() {
        let mut m = model_with_chat("a");
        add_tab(&mut m, "a", 5, "T5");
        let events = m.drop_ext(1);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].1["method"], json!("Target.detachedFromTarget"));
        assert!(m.owners.is_empty() && m.chats["a"].ext.is_none() && m.chats["a"].window_id.is_none());
    }

    #[test]
    fn the_newest_matching_browser_wins_and_a_lone_unknown_one_is_used() {
        let mut m = Model::default();
        m.exts.insert(1, ext(Some(App::Chrome), true));
        assert_eq!(m.pick_ext(App::Brave), None, "a different known browser is never used");
        std::thread::sleep(std::time::Duration::from_millis(2));
        m.exts.insert(2, ext(Some(App::Chrome), true));
        assert_eq!(m.pick_ext(App::Chrome), Some(2));
        let mut lone = Model::default();
        lone.exts.insert(3, ext(None, true));
        assert_eq!(lone.pick_ext(App::Edge), Some(3));
        lone.exts.insert(4, ext(None, false));
        assert_eq!(lone.pick_ext(App::Edge), Some(3), "a connection that has not said hello does not count");
    }
}
