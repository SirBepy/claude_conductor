use super::registry::Registry;

impl Registry {
    /// Set the registry account this session was spawned under. Returns true
    /// if found. Also re-derives the instance's rate-limit stamp from the new
    /// account, so a chat started while exhausted is born blocked - and, on
    /// the in-place account switch, a chat moved OFF an exhausted account
    /// stops carrying that account's window.
    pub fn set_account(&self, session_id: &str, account_id: &str) -> bool {
        let limits = self.rate_limits.lock().unwrap();
        let stamp = limits.get(account_id).cloned();
        drop(limits);
        let mut guard = self.inner.lock().unwrap();
        let Some(i) = guard.get_mut(session_id) else { return false };
        i.account_id = Some(account_id.to_string());
        match stamp {
            Some((resets_at, kind)) => {
                i.rate_limited_resets_at = Some(resets_at);
                i.rate_limited_type = Some(kind);
            }
            None => {
                i.rate_limited_resets_at = None;
                i.rate_limited_type = None;
            }
        }
        true
    }

    /// Record that `account_id` is rate limited until `resets_at` (unix secs),
    /// and stamp every live instance on that account (account-keyed since one
    /// window blocks all its sessions). Returns the marked session ids.
    pub fn set_rate_limited_for_account(
        &self,
        account_id: &str,
        resets_at: i64,
        kind: &str,
    ) -> Vec<String> {
        self.rate_limits
            .lock()
            .unwrap()
            .insert(account_id.to_string(), (resets_at, kind.to_string()));
        let mut guard = self.inner.lock().unwrap();
        let mut marked: Vec<String> = guard
            .values_mut()
            .filter(|i| i.ended_at.is_none() && i.account_id.as_deref() == Some(account_id))
            .map(|i| {
                i.rate_limited_resets_at = Some(resets_at);
                i.rate_limited_type = Some(kind.to_string());
                i.session_id.clone()
            })
            .collect();
        marked.sort();
        marked
    }

    /// Hygiene only: a turn completed on this account, so whatever window we
    /// recorded is demonstrably over. Correctness never depends on this being
    /// called, because every consumer already treats a past `resets_at` as
    /// unblocked.
    pub fn clear_rate_limit_for_account(&self, account_id: &str) {
        if self.rate_limits.lock().unwrap().remove(account_id).is_none() {
            return;
        }
        let mut guard = self.inner.lock().unwrap();
        for i in guard.values_mut() {
            if i.account_id.as_deref() == Some(account_id) {
                i.rate_limited_resets_at = None;
                i.rate_limited_type = None;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{EndReason, Settings};
    use std::path::Path;
    use std::sync::Mutex;

    fn fresh_settings() -> Mutex<Settings> {
        Mutex::new(Settings::default())
    }

    #[test]
    fn rate_limit_marks_only_the_matching_account() {
        let registry = Registry::new();
        let settings = fresh_settings();
        for sid in ["a1", "a2", "b1"] {
            registry.record_interactive_session(sid, Path::new("/tmp/x"), &settings, "2026-07-07T00:00:00Z");
        }
        registry.set_account("a1", "acct-a");
        registry.set_account("a2", "acct-a");
        registry.set_account("b1", "acct-b");

        let marked = registry.set_rate_limited_for_account("acct-a", 1_800_000_000, "five_hour");

        assert_eq!(marked, vec!["a1".to_string(), "a2".to_string()]);
        for sid in ["a1", "a2"] {
            let i = registry.get(sid).unwrap();
            assert_eq!(i.rate_limited_resets_at, Some(1_800_000_000));
            assert_eq!(i.rate_limited_type.as_deref(), Some("five_hour"));
        }
        let b = registry.get("b1").unwrap();
        assert_eq!(b.rate_limited_resets_at, None, "other accounts must be untouched");
    }

    #[test]
    fn rate_limit_does_not_mark_ended_sessions() {
        let registry = Registry::new();
        let settings = fresh_settings();
        registry.record_interactive_session("live", Path::new("/tmp/x"), &settings, "2026-07-07T00:00:00Z");
        registry.record_interactive_session("dead", Path::new("/tmp/x"), &settings, "2026-07-07T00:00:00Z");
        registry.set_account("live", "acct-a");
        registry.set_account("dead", "acct-a");
        registry.mark_ended("dead", EndReason::Manual, "2026-07-07T01:00:00Z");

        let marked = registry.set_rate_limited_for_account("acct-a", 1_800_000_000, "five_hour");

        assert_eq!(marked, vec!["live".to_string()]);
        assert_eq!(registry.get("dead").unwrap().rate_limited_resets_at, None);
    }

    /// A chat started while its account is already exhausted must be born
    /// blocked, not look healthy until its own first turn is rejected.
    #[test]
    fn set_account_seeds_an_active_rate_limit() {
        let registry = Registry::new();
        let settings = fresh_settings();
        registry.set_rate_limited_for_account("acct-a", 1_800_000_000, "seven_day");
        registry.record_interactive_session("fresh", Path::new("/tmp/x"), &settings, "2026-07-07T00:00:00Z");
        assert_eq!(registry.get("fresh").unwrap().rate_limited_resets_at, None);

        registry.set_account("fresh", "acct-a");

        let i = registry.get("fresh").unwrap();
        assert_eq!(i.rate_limited_resets_at, Some(1_800_000_000));
        assert_eq!(i.rate_limited_type.as_deref(), Some("seven_day"));
    }

    #[test]
    fn clearing_a_rate_limit_unblocks_that_accounts_sessions() {
        let registry = Registry::new();
        let settings = fresh_settings();
        registry.record_interactive_session("a1", Path::new("/tmp/x"), &settings, "2026-07-07T00:00:00Z");
        registry.set_account("a1", "acct-a");
        registry.set_rate_limited_for_account("acct-a", 1_800_000_000, "five_hour");

        registry.clear_rate_limit_for_account("acct-a");

        assert_eq!(registry.get("a1").unwrap().rate_limited_resets_at, None);
        // And the seed is gone, so a later session is not born blocked.
        registry.record_interactive_session("a2", Path::new("/tmp/x"), &settings, "2026-07-07T00:00:00Z");
        registry.set_account("a2", "acct-a");
        assert_eq!(registry.get("a2").unwrap().rate_limited_resets_at, None);
    }

    #[test]
    fn set_account_records_attribution() {
        let registry = Registry::new();
        let settings = fresh_settings();
        registry.record_interactive_session("s1", Path::new("/tmp/x"), &settings, "2026-07-07T00:00:00Z");
        assert_eq!(registry.get("s1").unwrap().account_id, None);
        assert!(registry.set_account("s1", "acct-work"));
        assert_eq!(registry.get("s1").unwrap().account_id.as_deref(), Some("acct-work"));
    }

    /// The in-place account switch's whole point is escaping an exhausted
    /// account, so the stamp must be re-derived from the account being moved
    /// TO, not left behind from the one being moved off.
    #[test]
    fn set_account_drops_the_previous_accounts_rate_limit() {
        let registry = Registry::new();
        let settings = fresh_settings();
        registry.record_interactive_session("s1", Path::new("/tmp/x"), &settings, "2026-07-07T00:00:00Z");
        registry.set_account("s1", "acct-blocked");
        registry.set_rate_limited_for_account("acct-blocked", 1_800_000_000, "five_hour");
        assert_eq!(registry.get("s1").unwrap().rate_limited_resets_at, Some(1_800_000_000));

        registry.set_account("s1", "acct-healthy");

        let i = registry.get("s1").unwrap();
        assert_eq!(i.account_id.as_deref(), Some("acct-healthy"));
        assert_eq!(i.rate_limited_resets_at, None, "the old account's window must not follow the chat");
        assert_eq!(i.rate_limited_type, None);
    }

    #[test]
    fn set_account_unknown_session_is_noop() {
        let registry = Registry::new();
        assert!(!registry.set_account("ghost", "acct-work"));
    }
}
