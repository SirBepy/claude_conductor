//! Which chat's Playwright child holds each of Joe's browser profiles.

use std::collections::HashMap;

use super::target;

/// The extension serves one connection at a time, so a second chat's child
/// would make the first one's tab reset to about:blank; the second is refused
/// instead.
#[derive(Default)]
pub(super) struct ExtensionHolders(pub(super) HashMap<String, String>);

impl ExtensionHolders {
    /// Keyed by the resolved profile, so "no profile" (the last-used one) and
    /// that same profile named explicitly share one holder.
    fn key(mine: &target::Mine) -> String {
        format!("{:?}/{}", mine.app, mine.resolved_profile().unwrap_or_default())
    }

    /// Ok when `session_id` now holds the profile (or already did); Err names
    /// the chat that holds it.
    pub(super) fn try_acquire(&mut self, mine: &target::Mine, session_id: &str) -> Result<(), String> {
        let holder = self.0.entry(Self::key(mine)).or_insert_with(|| session_id.to_string());
        if holder == session_id { Ok(()) } else { Err(holder.clone()) }
    }

    pub(super) fn release_session(&mut self, session_id: &str) {
        self.0.retain(|_, holder| holder != session_id);
    }

    pub(super) fn retain_sessions(&mut self, live: impl Fn(&str) -> bool) {
        self.0.retain(|_, holder| live(holder));
    }
}

pub(super) const PROFILE_BUSY: &str = "Another chat is using Joe's browser (this app and profile), and its extension connection serves one chat at a time: \
sharing it would reset that chat's tab. Switch this chat to Claude's own browser with browser_target (target own), or wait until \
the other chat's browser goes idle (about ten minutes without a browser call) and try again.";

#[cfg(test)]
mod tests {
    use super::*;

    fn mine_of(app: target::App, profile: Option<&str>) -> target::Mine {
        target::Mine { app, profile: profile.map(str::to_string) }
    }

    #[test]
    fn a_second_chat_cannot_take_a_profile_another_chat_holds() {
        let mut h = ExtensionHolders::default();
        let brave = mine_of(target::App::Brave, Some("Profile 1"));
        assert!(h.try_acquire(&brave, "a").is_ok());
        assert!(h.try_acquire(&brave, "a").is_ok(), "the holder itself may restart its child");
        assert_eq!(h.try_acquire(&brave, "b"), Err("a".to_string()));
        assert!(h.try_acquire(&mine_of(target::App::Brave, Some("Profile 2")), "b").is_ok(), "another profile is free");
        assert!(h.try_acquire(&mine_of(target::App::Chrome, Some("Profile 1")), "b").is_ok(), "another app is free");
    }

    #[test]
    fn releasing_a_chat_frees_its_profile() {
        let mut h = ExtensionHolders::default();
        let edge = mine_of(target::App::Edge, None);
        h.try_acquire(&edge, "a").unwrap();
        h.release_session("a");
        assert!(h.try_acquire(&edge, "b").is_ok());
        h.retain_sessions(|id| id != "b");
        assert!(h.try_acquire(&edge, "c").is_ok(), "a chat gone from the registry frees its hold");
    }
}
