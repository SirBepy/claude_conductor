//! A chat's window and tabs outlive its Playwright child. The child goes away
//! for reasons that say nothing about the chat (the 10-minute idle sweep, a
//! crash, Playwright reconnecting its CDP socket after `browser_close`), and
//! closing the window then meant every later call opened a fresh one and the
//! page Joe was asked to sign in to was gone. The model chat is keyed by the
//! chat's session id, not by the child's endpoint key, so the next child of the
//! same session finds the chat again: `park_chat` keeps it without a socket,
//! `claim_session` hands it to the new socket. Only the chat ending, a
//! `browser_close`, a `browser_target` switch or `PARK_MAX` close the window.

use std::collections::HashSet;
use std::time::{Duration, Instant};

use crate::daemon::browser::target::App;

use super::{Chat, ExtId, Model, TabId, TabState, WindowId};

/// A window nobody came back to is closed after this, so an abandoned chat
/// cannot leave Joe's browser holding its pages forever.
pub const PARK_MAX: Duration = Duration::from_secs(24 * 60 * 60);

/// A window to close: the connection it is on, its id, and (while the id is not
/// trusted yet, `remove_chat`) the tabs the chat had in it.
pub type Window = (ExtId, WindowId, Option<Vec<TabId>>);

#[derive(Debug, PartialEq)]
pub enum Left {
    /// The chat stays, without a socket.
    Parked,
    /// Nothing worth keeping (no window, no tab): the chat is gone, and its window if any.
    Gone(Option<Window>),
}

#[derive(Debug, PartialEq)]
pub enum Claim {
    /// No chat of this session existed; a fresh one was made.
    New,
    /// The session's parked chat takes over. `tabs` are live tabs whose debugger still holds the
    /// old child's state: the caller attaches them fresh, and until then their commands wait.
    Resumed { ext: Option<ExtId>, tabs: Vec<TabId> },
    /// The old chat drove another browser; it is gone (its window to close) and a fresh one was made.
    Replaced(Option<Window>),
}

impl Model {
    /// The child's socket ended. A chat that has a window or a tab stays; the
    /// commands the dead child had waiting are dropped, nobody can answer them.
    pub fn park_chat(&mut self, key: &str, now: Instant) -> Left {
        let keep = self.chats.get(key).is_some_and(|c| c.window_id.is_some() || !c.tabs.is_empty());
        if !keep {
            return Left::Gone(self.remove_chat(key, now));
        }
        self.forget_held_of_chat(key);
        self.deferred.remove(key);
        if let Some(c) = self.chats.get_mut(key) {
            c.parked = Some(now);
        }
        Left::Parked
    }

    /// A child registered for session `key` connected. Takes over the session's
    /// chat when there is one for the same browser, else makes a new one.
    pub fn claim_session(&mut self, key: &str, app: App, wants_profile: bool, now: Instant) -> Claim {
        let replaced = match self.chats.get(key) {
            Some(c) if c.app != app || c.wants_profile != wants_profile => Some(self.remove_chat(key, now)),
            Some(_) => None,
            None => {
                self.insert_chat(key, app, wants_profile);
                return Claim::New;
            }
        };
        if let Some(window) = replaced {
            self.insert_chat(key, app, wants_profile);
            return Claim::Replaced(window);
        }
        // A socket replaced before its end was noticed was never parked: what it left waiting carries its
        // request ids, which the new child would otherwise be answered with.
        self.forget_held_of_chat(key);
        self.deferred.remove(key);
        let Some(chat) = self.chats.get_mut(key) else { return Claim::New };
        chat.parked = None;
        // The new Playwright has not asked for pages yet; its own setAutoAttach turns this on.
        chat.auto_attach = false;
        let waiting = chat.reconnect.is_some();
        let mut fresh = Vec::new();
        for (id, tab) in &mut chat.tabs {
            // What the old child set up is not the new one's: it sends its own setup, and replaying the old
            // one (or an old script twice) into a fresh Playwright would corrupt it.
            tab.setup.clear();
            tab.children.clear();
            if tab.state == TabState::Live && !waiting {
                tab.state = TabState::Reattaching;
                tab.redetached = false;
                fresh.push(*id);
            }
        }
        Claim::Resumed { ext: chat.ext, tabs: fresh }
    }

    fn insert_chat(&mut self, key: &str, app: App, wants_profile: bool) {
        let ext = self.pick_ext_for(app, wants_profile);
        self.chats.insert(
            key.to_string(),
            Chat { app, wants_profile, ext, window_id: None, tabs: Default::default(), auto_attach: false, reconnect: None, parked: None },
        );
    }

    /// Chats that have had no child for `max`.
    pub fn parked_over(&self, now: Instant, max: Duration) -> Vec<String> {
        self.chats.iter().filter(|(_, c)| c.parked.is_some_and(|p| now.saturating_duration_since(p) >= max)).map(|(k, _)| k.clone()).collect()
    }

    /// Chats of sessions that no longer exist.
    pub fn chats_not_in(&self, live: &HashSet<String>) -> Vec<String> {
        self.chats.keys().filter(|k| !live.contains(*k)).cloned().collect()
    }
}

#[cfg(test)]
mod tests {
    use std::collections::{HashMap, HashSet};

    use serde_json::json;

    use super::super::{Held, Tab};
    use super::*;

    const UA: &str = "Mozilla/5.0 Chrome/155.0.1.2 Safari/537.36";

    fn model_with_tab() -> Model {
        let mut m = Model::default();
        m.exts.insert(1, super::super::Ext { app: Some(App::Brave), user_agent: UA.into(), connected_at: Instant::now(), ready: true, install_id: "i".into() });
        assert_eq!(m.claim_session("s", App::Brave, false, Instant::now()), Claim::New);
        let session = m.new_session_id();
        m.owners.insert((1, 5), "s".into());
        let chat = m.chats.get_mut("s").unwrap();
        chat.window_id = Some(10);
        chat.auto_attach = true;
        chat.tabs.insert(5, Tab { session_id: session, target_info: json!({ "targetId": "T5", "type": "page" }), children: HashSet::from(["CHILD".to_string()]), chat_opened: true, setup: vec![("Page.enable".into(), json!({}))], ..Default::default() });
        m
    }

    #[test]
    fn a_child_that_leaves_keeps_the_window_and_the_tabs_and_drops_what_it_was_waiting_for() {
        let mut m = model_with_tab();
        m.tab_mut(1, 5).unwrap().state = TabState::Reattaching;
        let held = Held { key: "s".into(), id: json!(1), session: None, target: json!({}), method: "x".into(), params: json!({}) };
        m.hold(1, 5, held).unwrap();
        let t0 = Instant::now();
        assert_eq!(m.park_chat("s", t0), Left::Parked);
        assert_eq!(m.chats["s"].window_id, Some(10), "the window is the chat's, not the child's");
        assert!(m.chats["s"].tabs.contains_key(&5) && m.owners.contains_key(&(1, 5)));
        assert_eq!(m.chats["s"].parked, Some(t0));
        assert!(m.take_held(1, 5).is_empty(), "nobody is left to answer a command of the dead child");
    }

    #[test]
    fn a_chat_with_no_window_and_no_tab_is_not_worth_parking() {
        let mut m = Model::default();
        assert_eq!(m.claim_session("s", App::Brave, false, Instant::now()), Claim::New);
        assert_eq!(m.park_chat("s", Instant::now()), Left::Gone(None));
        assert!(m.chats.is_empty());
    }

    #[test]
    fn the_next_child_of_the_session_takes_the_same_window_and_tab_and_attaches_them_fresh() {
        let mut m = model_with_tab();
        let session = m.chats["s"].tabs[&5].session_id.clone();
        m.park_chat("s", Instant::now());
        let claim = m.claim_session("s", App::Brave, false, Instant::now());
        assert_eq!(claim, Claim::Resumed { ext: Some(1), tabs: vec![5] });
        let chat = &m.chats["s"];
        assert_eq!((chat.window_id, chat.parked, chat.auto_attach), (Some(10), None, false));
        let tab = &chat.tabs[&5];
        assert_eq!(tab.session_id, session, "the page keeps its session id");
        assert!(tab.setup.is_empty() && tab.children.is_empty(), "the old child's setup is not the new one's");
        assert_eq!(tab.state, TabState::Reattaching, "its commands wait until the debugger is attached fresh");
    }

    #[test]
    fn a_child_that_connects_before_the_old_socket_was_noticed_closing_takes_over_the_same_way() {
        let mut m = model_with_tab();
        assert_eq!(m.claim_session("s", App::Brave, false, Instant::now()), Claim::Resumed { ext: Some(1), tabs: vec![5] });
    }

    #[test]
    fn a_takeover_of_a_socket_never_parked_drops_what_the_old_child_left_waiting() {
        let mut m = model_with_tab();
        m.tab_mut(1, 5).unwrap().state = TabState::Reattaching;
        let held = Held { key: "s".into(), id: json!(1), session: None, target: json!({}), method: "x".into(), params: json!({}) };
        m.hold(1, 5, held).unwrap();
        m.claim_session("s", App::Brave, false, Instant::now());
        assert!(m.take_held(1, 5).is_empty(), "its request ids would be answered into the new child's socket");
    }

    #[test]
    fn a_chat_that_waits_for_its_browser_leaves_the_attach_to_the_rebind() {
        let mut m = model_with_tab();
        m.close_ext(1, Instant::now());
        m.park_chat("s", Instant::now());
        assert_eq!(m.claim_session("s", App::Brave, false, Instant::now()), Claim::Resumed { ext: Some(1), tabs: vec![] });
        assert!(m.chats["s"].tabs[&5].setup.is_empty());
    }

    #[test]
    fn a_session_that_now_drives_another_browser_does_not_inherit_the_old_window() {
        let mut m = model_with_tab();
        m.park_chat("s", Instant::now());
        m.exts.insert(2, super::super::Ext { app: Some(App::Edge), user_agent: UA.into(), connected_at: Instant::now(), ready: true, install_id: "e".into() });
        assert_eq!(m.claim_session("s", App::Edge, false, Instant::now()), Claim::Replaced(Some((1, 10, None))));
        assert!(m.chats["s"].tabs.is_empty() && m.chats["s"].window_id.is_none());
        assert_eq!(m.chats["s"].ext, Some(2));
        assert!(m.owners.is_empty(), "the old tabs are not the new chat's");
    }

    #[test]
    fn a_chat_parked_for_a_day_is_due_and_a_live_one_never_is() {
        let mut m = model_with_tab();
        let t0 = Instant::now();
        assert!(m.parked_over(t0 + PARK_MAX * 2, PARK_MAX).is_empty(), "a chat with a child is never parked");
        m.park_chat("s", t0);
        assert!(m.parked_over(t0 + PARK_MAX - Duration::from_secs(1), PARK_MAX).is_empty());
        assert_eq!(m.parked_over(t0 + PARK_MAX, PARK_MAX), ["s"]);
    }

    #[test]
    fn only_chats_of_sessions_that_still_exist_survive_a_prune() {
        let mut m = model_with_tab();
        m.chats.insert("t".into(), Chat { app: App::Brave, wants_profile: false, ext: Some(1), window_id: None, tabs: HashMap::new(), auto_attach: false, reconnect: None, parked: None });
        let live: HashSet<String> = ["t".to_string()].into_iter().collect();
        assert_eq!(m.chats_not_in(&live), ["s"]);
    }
}
