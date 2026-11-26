//! A browser connection that drops (Brave's extension socket closed about
//! every 5 minutes on 2026-11-21, 76 times) leaves the tabs open in the
//! browser, so the chats that own them keep their tabs, window and session ids
//! for a grace period. The same install coming back (the `installId` of its
//! `hello`) takes them over: the tab ids are re-keyed to the new connection and
//! each tab is attached again and replayed like a detach (`reattach.rs`). A
//! chat's commands for those tabs wait (`Held`), and the ones that need the
//! browser itself wait as raw messages (`deferred`). A different install, or a
//! connection that stays away, ends it the old way: the tabs are dropped and
//! the chat hears them close.

use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::{ExtId, Held, Model, TabId, TabState, WindowId};

/// How long a chat waits for its browser to reconnect.
#[cfg(not(test))]
pub const GRACE: Duration = Duration::from_secs(90);
#[cfg(test)]
pub const GRACE: Duration = Duration::from_millis(400);

#[derive(Debug, Clone)]
pub struct Reconnect {
    pub install_id: String,
    pub since: Instant,
    /// The dropped connection's, so `Browser.getVersion` keeps answering while the chat waits.
    pub user_agent: String,
}

/// What the bridge does after a connection closed.
#[derive(Debug, Default)]
pub struct Closed {
    /// Tabs the chat hears closed.
    pub dropped: Vec<(String, Value)>,
    /// Commands whose tab is gone with the connection.
    pub failed_held: Vec<Held>,
    /// Chats now waiting for their browser (or, from `expire`, chats that gave
    /// up), with the detach events of the child sessions that died.
    pub waiting: Vec<(String, Vec<Value>)>,
    /// The same install already had another connection up.
    pub rebound: Rebound,
}

#[derive(Debug, Default)]
pub struct Rebound {
    pub ext: ExtId,
    pub chats: Vec<Rebind>,
    /// Windows of chats that left while the browser was away, with the tabs
    /// the chat had in them.
    pub orphan_windows: Vec<(WindowId, Vec<TabId>)>,
    /// Tabs whose id the new connection's own chat already owns: the waiting
    /// chat hears them close and their held commands fail.
    pub dropped: Vec<(String, Value)>,
    pub failed_held: Vec<Held>,
}

#[derive(Debug)]
pub struct Rebind {
    pub key: String,
    pub tabs: Vec<TabId>,
    pub window: Option<WindowId>,
}

impl Model {
    /// A connection closed. A chat with a window or tabs on an install that
    /// said hello starts waiting for it; every other chat on it loses its tabs.
    pub fn close_ext(&mut self, ext: ExtId, now: Instant) -> Closed {
        let user_agent = self.exts.get(&ext).map(|e| e.user_agent.clone()).unwrap_or_default();
        let install = self.exts.get(&ext).filter(|e| e.ready && !e.install_id.is_empty()).map(|e| e.install_id.clone());
        let mut closed = Closed::default();
        // A tab the chat was closing is gone with the connection; there is nothing to wait for.
        let closing: Vec<_> = self.closing.iter().filter(|(e, _)| *e == ext).copied().collect();
        closed.dropped.extend(closing.into_iter().filter_map(|(e, t)| self.drop_tab(e, t)));
        if let Some(install) = &install {
            for (key, chat) in self.chats.iter_mut().filter(|(_, c)| c.ext == Some(ext) && (c.reconnect.is_some() || c.window_id.is_some() || !c.tabs.is_empty())) {
                chat.reconnect = Some(Reconnect { install_id: install.clone(), since: now, user_agent: user_agent.clone() });
                let mut events = Vec::new();
                for tab in chat.tabs.values_mut() {
                    tab.state = TabState::Reattaching;
                    tab.redetached = false;
                    let session = tab.session_id.clone();
                    // The debugger's child sessions are not trusted across the gap; the replayed auto-attach announces the live ones.
                    events.extend(tab.children.drain().map(|c| json!({ "sessionId": session, "method": "Target.detachedFromTarget", "params": { "sessionId": c } })));
                }
                closed.waiting.push((key.clone(), events));
            }
        }
        closed.dropped.extend(self.drop_ext(ext));
        let gone: Vec<_> = self.held.keys().filter(|k| k.0 == ext && !self.owners.contains_key(k)).copied().collect();
        closed.failed_held = gone.into_iter().flat_map(|k| self.held.remove(&k).unwrap_or_default()).collect();
        // The install's new connection can be up before the old one's end was noticed.
        let successor = install.and_then(|i| self.exts.iter().filter(|(_, e)| e.ready && e.install_id == i).max_by_key(|(_, e)| e.connected_at).map(|(id, _)| *id));
        if let Some(new) = successor {
            closed.rebound = self.rebind(new);
        }
        closed
    }

    /// Hands every chat waiting for `new`'s install its tabs back: the tab ids
    /// now belong to `new`, and the caller attaches each one again.
    pub fn rebind(&mut self, new: ExtId) -> Rebound {
        let Some(install) = self.exts.get(&new).filter(|e| !e.install_id.is_empty()).map(|e| e.install_id.clone()) else { return Rebound::default() };
        let mut out = Rebound { ext: new, ..Default::default() };
        let waiting: Vec<_> = self
            .chats
            .iter()
            .filter(|(_, c)| c.reconnect.as_ref().is_some_and(|r| r.install_id == install))
            .filter_map(|(k, c)| c.ext.filter(|old| *old != new).map(|old| (k.clone(), old)))
            .collect();
        for (key, old) in waiting {
            let Some(chat) = self.chats.get_mut(&key) else { continue };
            // `reconnect` stays set until `take_deferred`: the chat's window id is not trusted before a tab
            // passed the target-id check, so calls that use it keep waiting while the tabs attach again.
            chat.ext = Some(new);
            let window = chat.window_id;
            let mut tabs = Vec::new();
            for t in chat.tabs.keys().copied().collect::<Vec<_>>() {
                // A chat that picked the new connection before this one came back can already own that id there.
                if self.owners.get(&(new, t)).is_some_and(|o| *o != key) {
                    self.owners.remove(&(old, t));
                    self.reattached.remove(&(old, t));
                    out.failed_held.extend(self.held.remove(&(old, t)).unwrap_or_default());
                    if let Some(tab) = chat.tabs.remove(&t) {
                        out.dropped.push((key.clone(), json!({ "method": "Target.detachedFromTarget", "params": { "sessionId": tab.session_id, "targetId": tab.target_info["targetId"] } })));
                    }
                    continue;
                }
                if let Some(owner) = self.owners.remove(&(old, t)) {
                    self.owners.insert((new, t), owner);
                }
                if let Some(held) = self.held.remove(&(old, t)) {
                    self.held.insert((new, t), held);
                }
                if let Some(used) = self.reattached.remove(&(old, t)) {
                    self.reattached.insert((new, t), used);
                }
                tabs.push(t);
            }
            out.chats.push(Rebind { key, tabs, window });
        }
        let (mine, rest): (Vec<_>, Vec<_>) = std::mem::take(&mut self.closed_windows).into_iter().partition(|(i, _, _, _)| *i == install);
        self.closed_windows = rest;
        out.orphan_windows = mine.into_iter().map(|(_, w, tabs, _)| (w, tabs)).collect();
        out
    }

    /// The grace period of the chats still waiting on `ext` is over: the tabs
    /// close for them after all. A chat that was re-bound or has waited less
    /// than the period (a later drop of the same chat) is left alone.
    pub fn expire(&mut self, ext: ExtId, now: Instant) -> Closed {
        let mut closed = Closed::default();
        let due: Vec<String> = self
            .chats
            .iter()
            .filter(|(_, c)| c.ext == Some(ext) && c.reconnect.as_ref().is_some_and(|r| now.saturating_duration_since(r.since) >= GRACE))
            .map(|(k, _)| k.clone())
            .collect();
        for key in due {
            let tabs: Vec<TabId> = self.chats.get(&key).map(|c| c.tabs.keys().copied().collect()).unwrap_or_default();
            for t in tabs {
                closed.failed_held.extend(self.held.remove(&(ext, t)).unwrap_or_default());
                closed.dropped.extend(self.drop_tab(ext, t));
            }
            if let Some(chat) = self.chats.get_mut(&key) {
                chat.ext = None;
                chat.window_id = None;
                chat.reconnect = None;
            }
            closed.waiting.push((key, Vec::new()));
        }
        let owners = &self.owners;
        self.reattached.retain(|k, _| k.0 != ext || owners.contains_key(k));
        self.closed_windows.retain(|(_, _, _, at)| now.saturating_duration_since(*at) < GRACE);
        closed
    }

    /// A chat's socket ended. Returns the window to close now; a chat that
    /// leaves while its browser is away has its window closed on reconnect.
    ///
    /// The tab list is `Some` while the window id is not trusted yet (the chat
    /// was re-bound and its tabs are still attaching): the caller closes the
    /// window only if nothing but those tabs is in it.
    pub fn remove_chat(&mut self, key: &str, now: Instant) -> Option<(ExtId, WindowId, Option<Vec<TabId>>)> {
        self.owners.retain(|_, k| k != key);
        self.forget_held_of_chat(key);
        self.deferred.remove(key);
        let chat = self.chats.remove(key)?;
        // Joe's adopted tabs are not in the chat's window: they stay open, only their debugger goes.
        if let Some(ext) = chat.ext {
            self.orphans.extend(chat.tabs.iter().filter(|(_, t)| t.adopted).map(|(id, _)| (ext, *id)));
        }
        let window = chat.window_id?;
        // A re-bound chat is still marked waiting while its tabs attach again, but its connection is up.
        if let Some(live) = chat.ext.filter(|e| self.exts.contains_key(e)) {
            return Some((live, window, chat.reconnect.is_some().then(|| chat.tabs.keys().copied().collect())));
        }
        match chat.reconnect {
            Some(r) => {
                // The tab ids let the reconnect check the window is still the one the chat opened.
                self.closed_windows.push((r.install_id, window, chat.tabs.keys().copied().collect(), now));
                None
            }
            None => Some((chat.ext?, window, None)),
        }
    }

    /// Keeps a raw CDP message until the chat's browser is back. False when it
    /// is not waiting any more, so the caller runs the message now.
    pub fn defer(&mut self, key: &str, text: &str) -> bool {
        if !self.chats.get(key).is_some_and(|c| c.reconnect.is_some()) {
            return false;
        }
        self.deferred.entry(key.to_string()).or_default().push(text.to_string());
        true
    }

    /// The chat's browser is back and its tabs are attached again (or it gave
    /// up waiting): ends the wait and returns what it sent meanwhile. A chat
    /// whose connection dropped again keeps waiting and its messages stay.
    pub fn take_deferred(&mut self, key: &str) -> Vec<String> {
        let connected = self.chats.get(key).is_some_and(|c| c.ext.is_none() || c.ext.is_some_and(|e| self.exts.contains_key(&e)));
        if !connected {
            return Vec::new();
        }
        if let Some(c) = self.chats.get_mut(key) {
            c.reconnect = None;
        }
        self.deferred.remove(key).unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use std::collections::{HashMap, HashSet};

    use super::super::{Chat, Ext, Held, Route, Tab, TabState};
    use super::*;
    use crate::daemon::browser::target::App;

    const UA: &str = "Mozilla/5.0 Chrome/155.0.1.2 Safari/537.36";

    fn ext(install: &str) -> Ext {
        Ext { app: Some(App::Brave), user_agent: UA.into(), connected_at: Instant::now(), ready: true, install_id: install.into() }
    }

    fn model_with_tab(install: &str) -> (Model, String) {
        let mut m = Model::default();
        m.exts.insert(1, ext(install));
        m.chats.insert("a".into(), Chat { app: App::Brave, wants_profile: false, ext: Some(1), window_id: Some(10), tabs: HashMap::new(), auto_attach: false, reconnect: None, parked: None });
        let session = m.new_session_id();
        m.owners.insert((1, 5), "a".into());
        m.chats.get_mut("a").unwrap().tabs.insert(5, Tab { session_id: session.clone(), target_info: json!({ "targetId": "T5", "type": "page" }), children: HashSet::new(), chat_opened: true, ..Default::default() });
        (m, session)
    }

    fn route(m: &mut Model, method: &str, session: Option<&str>) -> Route {
        m.route("a", method, &json!({}), session, UA, &mut Vec::new())
    }

    #[test]
    fn the_same_install_coming_back_keeps_the_tabs_the_window_and_the_session_ids() {
        let (mut m, session) = model_with_tab("install-1");
        route(&mut m, "Page.enable", Some(&session));
        let closed = m.close_ext(1, Instant::now());
        assert!(closed.dropped.is_empty(), "the chat hears no close: {:?}", closed.dropped);
        assert_eq!(closed.waiting.len(), 1);
        assert_eq!(m.chats["a"].window_id, Some(10), "the window is kept");
        assert_eq!(m.chats["a"].tabs[&5].state, TabState::Reattaching);
        m.exts.insert(2, ext("install-1"));
        let rebound = m.rebind(2);
        assert_eq!((rebound.ext, rebound.chats.len()), (2, 1));
        assert_eq!((rebound.chats[0].key.as_str(), rebound.chats[0].tabs.clone(), rebound.chats[0].window), ("a", vec![5], Some(10)));
        assert_eq!(m.chats["a"].ext, Some(2));
        assert!(m.chats["a"].reconnect.is_some(), "window calls keep waiting until the tabs are attached again");
        assert_eq!(m.chats["a"].tabs[&5].session_id, session, "Playwright keeps the same page");
        assert_eq!(m.owners.get(&(2, 5)).map(String::as_str), Some("a"));
        assert!(!m.owners.contains_key(&(1, 5)));
        assert_eq!(m.replay_plan(2, 5).unwrap().1[0].0, "Page.enable", "the recorded setup survives for the replay");
    }

    #[test]
    fn a_different_install_does_not_take_the_tabs() {
        let (mut m, _) = model_with_tab("install-1");
        m.close_ext(1, Instant::now());
        m.exts.insert(2, ext("install-2"));
        assert!(m.rebind(2).chats.is_empty());
        assert_eq!(m.chats["a"].ext, Some(1), "still waiting for its own browser");
        assert!(m.chats["a"].tabs.contains_key(&5));
        // And a chat that waits does not adopt the stranger either.
        assert!(matches!(route(&mut m, "Browser.getVersion", None), Route::Reply(_)));
        assert!(m.chats["a"].tabs.contains_key(&5) && m.chats["a"].ext == Some(1));
    }

    #[test]
    fn a_tab_id_that_names_another_page_after_a_browser_restart_is_not_adopted() {
        let (mut m, _) = model_with_tab("install-1");
        m.close_ext(1, Instant::now());
        m.exts.insert(2, ext("install-1"));
        m.rebind(2);
        assert!(!m.refresh_target_info(2, 5, &json!({ "targetId": "SOMEONE-ELSES", "url": "https://joe.example", "title": "Joe's tab" })));
        assert_eq!(m.chats["a"].tabs[&5].target_info["targetId"], json!("T5"));
        assert!(m.chats["a"].tabs[&5].target_info.get("url").is_none(), "nothing of the other page is taken");
        assert!(m.refresh_target_info(2, 5, &json!({ "targetId": "T5", "url": "https://a.example" })));
    }

    #[test]
    fn a_connection_that_never_said_hello_or_has_no_install_id_drops_its_tabs_at_once() {
        let (mut m, _) = model_with_tab("");
        let closed = m.close_ext(1, Instant::now());
        assert_eq!(closed.dropped.len(), 1);
        assert!(closed.waiting.is_empty() && m.chats["a"].ext.is_none() && m.owners.is_empty());
        let (mut m, _) = model_with_tab("install-1");
        m.exts.get_mut(&1).unwrap().ready = false;
        assert_eq!(m.close_ext(1, Instant::now()).dropped.len(), 1);
    }

    #[test]
    fn a_command_for_a_waiting_tab_is_held_and_follows_the_tab_to_the_new_connection() {
        let (mut m, session) = model_with_tab("install-1");
        m.close_ext(1, Instant::now());
        let Route::Hold { ext: on, tab, target } = route(&mut m, "Page.navigate", Some(&session)) else { panic!("held") };
        assert_eq!((on, tab, target.clone()), (1, 5, json!({ "tabId": 5 })));
        let held = Held { key: "a".into(), id: json!(1), session: Some(session.clone()), target, method: "Page.navigate".into(), params: json!({}) };
        assert!(m.hold(1, 5, held).is_ok());
        m.exts.insert(2, ext("install-1"));
        m.rebind(2);
        assert!(m.take_held(1, 5).is_empty());
        assert_eq!(m.take_held(2, 5).len(), 1, "the command is sent on the new connection once the tab is attached");
    }

    #[test]
    fn a_call_that_needs_the_browser_waits_for_the_reconnect_instead_of_failing() {
        let (mut m, _) = model_with_tab("install-1");
        m.close_ext(1, Instant::now());
        assert_eq!(m.route("a", "Target.createTarget", &json!({ "url": "about:blank" }), None, UA, &mut Vec::new()), Route::Wait);
        assert_eq!(route(&mut m, "Browser.close", None), Route::Wait);
        assert!(m.defer("a", "{\"id\":1}"));
        m.exts.insert(2, ext("install-1"));
        m.rebind(2);
        assert_eq!(route(&mut m, "Browser.close", None), Route::Wait, "the window id is not trusted until the tabs are back");
        assert!(m.defer("a", "{\"id\":3}"));
        assert_eq!(m.take_deferred("a"), ["{\"id\":1}", "{\"id\":3}"]);
        assert!(!m.defer("a", "{\"id\":2}"), "a chat that is not waiting runs its message now");
        assert!(matches!(route(&mut m, "Target.createTarget", None), Route::CreateTarget { ext: 2, .. }));
    }

    #[test]
    fn the_grace_period_ends_with_the_old_close_and_only_for_chats_still_waiting() {
        let (mut m, _) = model_with_tab("install-1");
        let t0 = Instant::now();
        m.close_ext(1, t0);
        let held = Held { key: "a".into(), id: json!(1), session: None, target: json!({}), method: "x".into(), params: json!({}) };
        m.hold(1, 5, held).unwrap();
        let early = m.expire(1, t0);
        assert!(early.dropped.is_empty() && early.waiting.is_empty(), "inside the grace period nothing happens");
        let late = m.expire(1, t0 + GRACE);
        assert_eq!(late.dropped.len(), 1, "the chat hears the tab close now");
        assert_eq!(late.failed_held.len(), 1);
        assert_eq!(late.waiting.iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>(), ["a"]);
        assert!(m.chats["a"].ext.is_none() && m.chats["a"].window_id.is_none() && m.chats["a"].reconnect.is_none());
        assert!(m.owners.is_empty());
        // After the chat was re-bound, a late timer finds nothing to do.
        let (mut m, _) = model_with_tab("install-1");
        m.close_ext(1, t0);
        m.exts.insert(2, ext("install-1"));
        m.rebind(2);
        assert!(m.expire(1, t0 + GRACE).dropped.is_empty());
        assert!(m.chats["a"].tabs.contains_key(&5));
    }

    #[test]
    fn a_second_drop_is_not_cut_short_by_the_first_ones_timer() {
        let (mut m, _) = model_with_tab("install-1");
        let t0 = Instant::now();
        m.close_ext(1, t0);
        m.exts.insert(2, ext("install-1"));
        m.rebind(2);
        let t1 = t0 + GRACE / 2;
        m.close_ext(2, t1);
        assert!(m.expire(2, t0 + GRACE).dropped.is_empty(), "the timer of the first drop fires into the second wait");
        assert_eq!(m.expire(2, t1 + GRACE).dropped.len(), 1);
    }

    #[test]
    fn a_new_connection_that_was_up_before_the_old_one_ended_takes_the_tabs_at_once() {
        let (mut m, session) = model_with_tab("install-1");
        m.exts.insert(2, ext("install-1"));
        let closed = m.close_ext(1, Instant::now());
        assert!(closed.dropped.is_empty());
        assert_eq!(closed.rebound.ext, 2);
        assert_eq!(closed.rebound.chats.len(), 1);
        assert_eq!(m.chats["a"].ext, Some(2));
        assert_eq!(m.chats["a"].tabs[&5].session_id, session);
    }

    #[test]
    fn child_sessions_are_announced_gone_and_a_tab_being_closed_is_dropped_not_kept() {
        let (mut m, session) = model_with_tab("install-1");
        m.route_event(1, &json!({ "tabId": 5 }), "Target.attachedToTarget", &json!({ "sessionId": "CHILD" }));
        let closed = m.close_ext(1, Instant::now());
        let events = &closed.waiting[0].1;
        assert_eq!(events.len(), 1);
        assert_eq!((events[0]["sessionId"].as_str(), events[0]["params"]["sessionId"].as_str()), (Some(session.as_str()), Some("CHILD")));
        let (mut m, _) = model_with_tab("install-1");
        m.mark_closing(1, &[5]);
        let closed = m.close_ext(1, Instant::now());
        assert_eq!(closed.dropped.len(), 1, "the chat asked to close that tab, so it is gone");
        assert!(m.chats["a"].tabs.is_empty() && m.chats["a"].reconnect.is_some(), "the window is still worth waiting for");
    }

    #[test]
    fn a_tab_id_another_chat_already_owns_on_the_new_connection_is_not_taken_from_it() {
        let (mut m, _) = model_with_tab("install-1");
        m.close_ext(1, Instant::now());
        m.exts.insert(2, ext("install-1"));
        m.chats.insert("b".into(), Chat { app: App::Brave, wants_profile: false, ext: Some(2), window_id: None, tabs: HashMap::new(), auto_attach: false, reconnect: None, parked: None });
        m.owners.insert((2, 5), "b".into());
        let held = Held { key: "a".into(), id: json!(1), session: None, target: json!({}), method: "x".into(), params: json!({}) };
        m.hold(1, 5, held).unwrap();
        let rebound = m.rebind(2);
        assert_eq!(rebound.chats[0].tabs, Vec::<TabId>::new());
        assert_eq!(m.owners.get(&(2, 5)).map(String::as_str), Some("b"), "the other chat keeps its tab");
        assert!(m.chats["a"].tabs.is_empty());
        assert_eq!((rebound.dropped.len(), rebound.failed_held.len()), (1, 1), "the waiting chat hears its tab close and its command fails");
        assert!(m.take_held(2, 5).is_empty());
    }

    #[test]
    fn a_chat_whose_browser_dropped_again_keeps_waiting_and_keeps_its_messages() {
        let (mut m, _) = model_with_tab("install-1");
        m.close_ext(1, Instant::now());
        assert!(m.defer("a", "{\"id\":1}"));
        m.exts.insert(2, ext("install-1"));
        m.rebind(2);
        m.close_ext(2, Instant::now());
        // The first re-bind's task finishes after the second drop.
        assert!(m.take_deferred("a").is_empty());
        assert!(m.chats["a"].reconnect.is_some());
        m.exts.insert(3, ext("install-1"));
        m.rebind(3);
        assert_eq!(m.take_deferred("a"), ["{\"id\":1}"]);
        assert!(m.chats["a"].reconnect.is_none());
    }

    #[test]
    fn a_re_bound_chat_that_leaves_before_its_wait_ends_closes_its_window_on_the_live_connection() {
        let (mut m, _) = model_with_tab("install-1");
        m.close_ext(1, Instant::now());
        m.exts.insert(2, ext("install-1"));
        m.rebind(2);
        assert_eq!(m.remove_chat("a", Instant::now()), Some((2, 10, Some(vec![5]))), "the window id is checked before it is closed");
        assert!(m.rebind(2).orphan_windows.is_empty(), "nothing is parked for a later reconnect");
    }

    #[test]
    fn a_re_bound_chat_with_nothing_left_still_gets_a_grace_period_when_the_new_connection_drops() {
        let (mut m, _) = model_with_tab("install-1");
        m.close_ext(1, Instant::now());
        m.exts.insert(2, ext("install-1"));
        m.rebind(2);
        let c = m.chats.get_mut("a").unwrap();
        c.tabs.clear();
        c.window_id = None;
        let t1 = Instant::now();
        let closed = m.close_ext(2, t1);
        assert_eq!(closed.waiting.len(), 1, "it is on the timer, not left waiting forever");
        assert!(m.expire(2, t1 + GRACE).waiting.iter().any(|(k, _)| k == "a"));
        assert!(m.chats["a"].reconnect.is_none() && m.chats["a"].ext.is_none());
    }

    #[test]
    fn a_waiting_chat_still_answers_with_its_browsers_user_agent() {
        let (mut m, _) = model_with_tab("install-1");
        m.close_ext(1, Instant::now());
        assert_eq!(m.chats["a"].reconnect.as_ref().map(|r| r.user_agent.as_str()), Some(UA));
    }

    #[test]
    fn a_chat_that_leaves_while_its_browser_is_away_has_its_window_closed_on_reconnect() {
        let (mut m, _) = model_with_tab("install-1");
        m.close_ext(1, Instant::now());
        assert_eq!(m.remove_chat("a", Instant::now()), None, "there is no browser to ask yet");
        assert!(m.owners.is_empty());
        m.exts.insert(2, ext("install-2"));
        assert!(m.rebind(2).orphan_windows.is_empty(), "another install's reconnect leaves it alone");
        m.exts.insert(3, ext("install-1"));
        assert_eq!(m.rebind(3).orphan_windows, [(10, vec![5])]);
        assert!(m.rebind(3).orphan_windows.is_empty(), "closed once");
        let (mut m, _) = model_with_tab("install-1");
        assert_eq!(m.remove_chat("a", Instant::now()), Some((1, 10, None)), "a chat on a live connection closes its window now");
    }
}
