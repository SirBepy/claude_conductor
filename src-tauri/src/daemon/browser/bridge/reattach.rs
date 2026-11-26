//! Attaches a live tab's debugger again after the browser detached it with
//! `target_closed`, under the same bridge session id, so Playwright never
//! hears a close (Brave detaches a live tab on a password manager's menu
//! frame, pc-1454). Only a tab that is really gone, or a replay that fails,
//! reaches the chat as a closed page.

use std::time::Instant;

use serde_json::json;

use super::chat_side::short;
use super::model::{ExtId, Held, TabId, TabState};
use super::{replay, Bridge};

impl Bridge {
    /// A debugger detach with `target_closed` on an owned tab. Starts the quiet
    /// re-attach and returns true; false leaves the old path (drop the tab and
    /// tell the chat) to the caller, as for a tab with no re-attach budget left.
    pub(super) fn begin_quiet_reattach(&'static self, ext: ExtId, tab: TabId) -> bool {
        let began = {
            let mut i = self.lock();
            i.model.reattach_plan(ext, tab, Instant::now()).and_then(|key| i.model.begin_reattach(ext, tab).map(|children| (key, children)))
        };
        let Some((key, children)) = began else { return false };
        // Child sessions died with the debugger; the replayed auto-attach announces the live ones again.
        for event in children {
            self.send_chat(&key, event);
        }
        log::info!("browser bridge: tab {tab} debugger detached (connection {ext}), re-attaching quietly for chat {}", short(&key));
        tokio::spawn(async move { self.quiet_reattach(key, ext, tab).await });
        true
    }

    fn still_ours(&self, ext: ExtId, tab: TabId, key: &str) -> bool {
        self.lock().model.owners.get(&(ext, tab)).is_some_and(|o| o == key)
    }

    pub(super) async fn quiet_reattach(&'static self, key: String, ext: ExtId, tab: TabId) {
        // A browser that detaches again while the replay runs gets the attach redone, a few times.
        for _round in 0..3 {
            if self.reattach_once(&key, ext, tab).await {
                return;
            }
        }
        self.give_up(&key, ext, tab, "the browser kept detaching the debugger", true);
    }

    /// One attach, replay and flush. True when it is over (done, or the tab was given up on); false when the browser detached again meanwhile.
    async fn reattach_once(&'static self, key: &str, ext: ExtId, tab: TabId) -> bool {
        let key = key.to_string();
        let mut parked = false;
        let mut tries = 0;
        // The attach made a new debugger session, as opposed to finding the old one still there.
        let mut fresh = true;
        loop {
            // Detaches up to here belong to the debugger that is gone; one after the attach is news.
            self.lock().model.take_redetach(ext, tab);
            if !self.still_ours(ext, tab, &key) {
                // Closed meanwhile: whoever dropped it answered the held commands.
                return true;
            }
            if let Err(e) = self.call(ext, "tabs.get", json!([tab])).await {
                // The connection itself went away: the chat waits for the next one, it does not lose the tab.
                if self.ext_gone(ext) {
                    return true;
                }
                self.give_up(&key, ext, tab, &format!("the tab is gone ({e})"), false);
                return true;
            }
            match self.call(ext, "debugger.attach", json!([{ "tabId": tab }, "1.3"])).await {
                Ok(_) => break,
                Err(e) if e.contains("already attached") => {
                    fresh = false;
                    break;
                }
                Err(_) if self.ext_gone(ext) => return true,
                Err(e) if replay::is_extension_refusal(&e) => {
                    if !parked {
                        parked = true;
                        log::info!("browser bridge: tab {tab} is held by another extension's frame, parked for chat {}: {e}", short(&key));
                        let held = {
                            let mut i = self.lock();
                            i.model.set_tab_state(ext, tab, TabState::Parked);
                            i.model.take_held(ext, tab)
                        };
                        self.fail_held(held, replay::PARKED_MESSAGE);
                    }
                    tries += 1;
                    if tries >= replay::PARK_TRIES {
                        self.give_up(&key, ext, tab, "another extension held the tab for too long", false);
                        return true;
                    }
                    tokio::time::sleep(replay::PARK_RETRY).await;
                }
                Err(e) => {
                    self.give_up(&key, ext, tab, &format!("attach failed: {e}"), false);
                    return true;
                }
            }
        }
        // Commands that arrive from here on wait for the replay instead of being refused.
        {
            let mut i = self.lock();
            if !i.model.set_tab_state(ext, tab, TabState::Reattaching) {
                return true;
            }
        }
        match self.replay_session(&key, ext, tab, fresh).await {
            Ok(()) => {
                let rxs = {
                    let mut i = self.lock();
                    // The connection dropped after the last replay call: the tab stays Reattaching for the next re-bind.
                    if !i.ext_tx.contains_key(&ext) {
                        return true;
                    }
                    // Detached again after the attach: this debugger is already dead, so go round once more.
                    if i.model.take_redetach(ext, tab) {
                        return false;
                    }
                    if !i.model.set_tab_state(ext, tab, TabState::Live) {
                        return true;
                    }
                    // Queued under the lock that flips the state, so a command routed right after cannot overtake them.
                    let held = i.model.take_held(ext, tab);
                    for h in &held {
                        // Not recorded while it waited, so it is not replayed on top of this send.
                        if h.target.get("sessionId").is_none() {
                            i.model.record_setup(ext, tab, &h.method, &h.params);
                        }
                    }
                    held.into_iter().map(|h| (h.key, h.id, h.session, Self::start_call_in(&mut i, ext, "debugger.sendCommand", json!([h.target, h.method, h.params])))).collect::<Vec<_>>()
                };
                log::info!("browser bridge: tab {tab} attached again for chat {}, {} waiting command(s) sent", short(&key), rxs.len());
                for (key, id, session, rx) in rxs {
                    tokio::spawn(async move {
                        let r = Self::finish(rx).await;
                        self.reply(&key, &id, session.as_deref(), r);
                    });
                }
            }
            Err(e) => {
                // A replay command that fails because the browser detached the fresh debugger is a second detach, not a dead tab.
                if self.lock().model.take_redetach(ext, tab) {
                    return false;
                }
                // The connection dropped mid-replay: the next one starts the attach over.
                if self.ext_gone(ext) {
                    return true;
                }
                self.give_up(&key, ext, tab, &e, true);
            }
        }
        true
    }

    /// The fresh debugger session gets what the old one had: the page's current
    /// description, focus emulation, then the chat's recorded setup in order.
    /// `fresh`: the attach made a new debugger session. When the attach found
    /// the old one still there (an extension worker that restarted keeps its
    /// debuggers, UNVERIFIED until live check P2), it still holds the scripts
    /// and enabled domains: replaying a script or a binding would add it twice,
    /// and clearing the contexts would strand Playwright, since a second
    /// `Runtime.enable` announces nothing.
    async fn replay_session(&self, key: &str, ext: ExtId, tab: TabId, fresh: bool) -> Result<(), String> {
        let (session, setup) = self.lock().model.replay_plan(ext, tab).ok_or("the tab closed while attaching")?;
        let target = json!({ "tabId": tab });
        let info = self.call(ext, "debugger.sendCommand", json!([target, "Target.getTargetInfo"])).await?;
        if !self.lock().model.refresh_target_info(ext, tab, &info["targetInfo"]) {
            return Err("the tab id now belongs to a different page (the browser restarted)".into());
        }
        // A minimized window is hidden, and a hidden page skips animation frames.
        let _ = self.call(ext, "debugger.sendCommand", json!([target, "Emulation.setFocusEmulationEnabled", { "enabled": true }])).await;
        if fresh {
            // Playwright drops the old page's execution contexts first, so the replayed Runtime.enable announces the new ones into a clean slate.
            self.send_chat(key, json!({ "sessionId": session, "method": "Runtime.executionContextsCleared", "params": {} }));
        }
        for (method, params) in setup.into_iter().filter(|(m, _)| fresh || !replay::accumulates(m)) {
            self.call(ext, "debugger.sendCommand", json!([target, method, params])).await.map_err(|e| format!("replaying {method} failed: {e}"))?;
        }
        Ok(())
    }

    /// The tab is really gone, or could not be rebuilt: now, and only now, the
    /// chat hears it close, and the commands it had waiting fail.
    /// `detach`: the debugger was attached again, so release it.
    fn give_up(&self, key: &str, ext: ExtId, tab: TabId, why: &str, detach: bool) {
        let (dropped, held) = {
            let mut i = self.lock();
            let held = i.model.take_held(ext, tab);
            (i.model.drop_tab(ext, tab), held)
        };
        log::info!("browser bridge: tab {tab} not re-attached for chat {}: {why}", short(key));
        if detach {
            // Best effort: leaves no debugger banner on a tab nobody drives.
            drop(self.start_call(ext, "debugger.detach", json!([{ "tabId": tab }])));
        }
        if let Some((k, event)) = dropped {
            self.send_chat(&k, event);
        }
        self.fail_held(held, &format!("Target page, context or browser has been closed ({why})"));
    }

    pub(super) fn fail_held(&self, held: Vec<Held>, message: &str) {
        for h in held {
            self.reply(&h.key, &h.id, h.session.as_deref(), Err(message.to_string()));
        }
    }
}
