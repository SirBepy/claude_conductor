//! The bridge's half of parking a chat's window and tabs past its Playwright
//! child (`model/park.rs` holds the rules): taking a parked chat over when the
//! session's next child connects, and the four ways a window really closes.

use std::collections::HashSet;
use std::time::{Duration, Instant};

use serde_json::json;

use super::chat_side::short;
use super::model::{ExtId, TabId, Window, PARK_MAX};
use super::Bridge;

impl Bridge {
    /// Closes the window of a chat that is gone, the way `Model::remove_chat` said to.
    pub(super) async fn close_left_window(&self, window: Option<Window>) {
        self.detach_orphans().await;
        match window {
            Some((ext, window, None)) => {
                let _ = self.call(ext, "windows.remove", json!([window])).await;
            }
            // The chat was re-bound moments ago and the window id is not trusted yet.
            Some((ext, window, Some(tabs))) => self.close_window_if_ours(ext, window, &tabs).await,
            None => {}
        }
    }

    /// Lets go of the adopted tabs of chats that were removed: they are Joe's
    /// and stay open, only the debugger goes.
    async fn detach_orphans(&self) {
        let orphans = self.lock().model.take_orphans();
        for (ext, tab) in orphans {
            log::info!("browser bridge: detaching adopted tab {tab} of an ended chat (connection {ext}), leaving it open");
            let _ = self.call(ext, "debugger.detach", json!([{ "tabId": tab }])).await;
        }
    }

    /// A new child took over a parked chat. Its tabs' debuggers still hold what
    /// the old child set up (enabled domains, injected scripts), and a second
    /// `Runtime.enable` on them would announce no execution contexts, so each is
    /// detached and attached again, which gives the new Playwright a clean
    /// page. The commands it sends meanwhile wait (`Held`).
    pub(super) fn start_takeover(&'static self, key: &str, ext: ExtId, tabs: Vec<TabId>) {
        for tab in tabs {
            let key = key.to_string();
            log::info!("browser bridge: chat {} takes over tab {tab} left by its previous child", short(&key));
            tokio::spawn(async move {
                // Best effort: a tab whose debugger is already gone just attaches.
                let _ = self.call(ext, "debugger.detach", json!([{ "tabId": tab }])).await;
                self.quiet_reattach(key, ext, tab).await;
            });
        }
    }

    /// The session is over (the chat ended, or it switched browser): the chat is
    /// forgotten and its window closed, whether or not a child is connected.
    pub async fn end_session(&self, session_id: &str) {
        let window = {
            let mut i = self.lock();
            i.chat_tx.remove(session_id);
            i.chat_ops.remove(session_id);
            i.model.remove_chat(session_id, Instant::now())
        };
        if let Some((_, w, _)) = &window {
            log::info!("browser bridge: session {} ended, closing window {w}", short(session_id));
        }
        self.close_left_window(window).await;
    }

    /// `browser_close`: the chat's window goes, the chat stays (its child is
    /// still running and the next page opens a new window). The tabs in it
    /// reach the chat as closed through the browser's own events.
    pub async fn close_window(&self, session_id: &str) {
        let target = {
            let mut i = self.lock();
            let live: HashSet<_> = i.model.exts.keys().copied().collect();
            // A chat waiting for its browser has no window id worth trusting yet.
            i.model.chats.get_mut(session_id).filter(|c| c.reconnect.is_none()).and_then(|c| Some((c.ext.filter(|e| live.contains(e))?, c.window_id.take()?)))
        };
        if let Some((ext, window)) = target {
            log::info!("browser bridge: chat {} called browser_close, closing window {window}", short(session_id));
            let _ = self.call(ext, "windows.remove", json!([window])).await;
        }
        // The chat's browser is closed: Joe's tabs it adopted are let go of, never closed.
        let adopted = self.lock().model.adopted_tabs(session_id);
        for tab in adopted {
            let _ = self.release_adopted(session_id, tab).await;
        }
    }

    /// Ends the sessions of chats that no longer exist (parked or not).
    pub async fn prune_sessions(&self, live: &HashSet<String>) {
        let gone = self.lock().model.chats_not_in(live);
        for id in gone {
            self.end_session(&id).await;
        }
    }

    /// Closes windows no child came back to for a day.
    pub async fn sweep_parked(&self) {
        self.sweep_parked_at(Instant::now(), PARK_MAX).await;
    }

    pub(super) async fn sweep_parked_at(&self, now: Instant, max: Duration) {
        let due = self.lock().model.parked_over(now, max);
        for id in due {
            log::info!("browser bridge: chat {} has had no child for {}h, closing its window", short(&id), max.as_secs() / 3600);
            self.end_session(&id).await;
        }
    }

    /// The daemon is going down: nothing could take a parked window over later.
    pub async fn end_all(&self) {
        let all: Vec<String> = self.lock().model.chats.keys().cloned().collect();
        for id in all {
            self.end_session(&id).await;
        }
    }
}
