//! Daemon-side home of the API-credit status: the in-memory cache, the poller
//! that keeps it fresh, and the lookup the send/spawn gate reads.
//!
//! It lives in the daemon (not the app's usage scheduler) because the gate
//! that refuses a turn runs here, and the daemon outlives the app window. The
//! usage scheduler's cache, `AppState.current_usage_by_account`, is invisible
//! to this process.

use crate::accounts::api_credit::load_console_session;
use crate::accounts::api_credit_status::{fetch_status, keep_block_across_error};
use crate::accounts::{Account, ApiCreditStatus};
use crate::daemon::state::DaemonState;
use crate::scraping::CONSOLE_BASE_URL;
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// How often every ApiCredit account's Console figures are re-read. The
/// Console's own Credits panel refetches on the same cadence.
const POLL_INTERVAL: Duration = Duration::from_secs(300);
/// At most one turn-end refresh per account in this window, so a chat that
/// finishes turns back to back reads the Console once, not per turn.
const NUDGE_MIN_GAP: Duration = Duration::from_secs(30);

/// Notifier event published when an account's status changes. Needs the three
/// registrations: this publish, `daemon_link`'s match arm, `GLOBAL_EVENT_MAP`.
pub const STATUS_CHANGED_EVENT: &str = "api_credit_status_changed";

#[derive(Default)]
pub struct ApiCreditHub {
    statuses: Mutex<HashMap<String, ApiCreditStatus>>,
    last_nudge: Mutex<HashMap<String, Instant>>,
}

impl ApiCreditHub {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn snapshot(&self) -> HashMap<String, ApiCreditStatus> {
        self.statuses.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    pub fn get(&self, account_id: &str) -> Option<ApiCreditStatus> {
        self.statuses.lock().unwrap_or_else(|e| e.into_inner()).get(account_id).cloned()
    }

    /// Stores `status`; true when anything but `fetched_at` differs from what
    /// was there, i.e. when listeners need telling. A partial read after a
    /// non-auth fetch error keeps the previous block (see
    /// `keep_block_across_error`), decided under the same lock as the insert.
    pub fn set(&self, status: ApiCreditStatus) -> bool {
        let mut map = self.statuses.lock().unwrap_or_else(|e| e.into_inner());
        let status = keep_block_across_error(map.get(&status.account_id), status);
        let changed = map.get(&status.account_id).map_or(true, |old| !old.same_content(&status));
        map.insert(status.account_id.clone(), status);
        changed
    }

    /// Drops every status whose account is gone (removed, or no longer an
    /// ApiCredit account).
    pub fn retain_accounts(&self, keep: &HashSet<String>) {
        self.statuses.lock().unwrap_or_else(|e| e.into_inner()).retain(|id, _| keep.contains(id));
        self.last_nudge.lock().unwrap_or_else(|e| e.into_inner()).retain(|id, _| keep.contains(id));
    }

    /// Why new turns on `account_id` are refused, or `None` to let them
    /// through. An account with no status yet is let through: unknown never
    /// blocks.
    pub fn blocked_reason(&self, account_id: &str) -> Option<String> {
        let map = self.statuses.lock().unwrap_or_else(|e| e.into_inner());
        block_reason_of(map.get(account_id))
    }

    /// True when `account_id` is a tracked ApiCredit account whose last nudge
    /// is older than `NUDGE_MIN_GAP`; records `now` as the new last nudge.
    /// Subscription accounts are never tracked, so they cost nothing here.
    fn nudge_due(&self, account_id: &str, now: Instant) -> bool {
        if !self.statuses.lock().unwrap_or_else(|e| e.into_inner()).contains_key(account_id) {
            return false;
        }
        let mut last = self.last_nudge.lock().unwrap_or_else(|e| e.into_inner());
        if last.get(account_id).is_some_and(|t| now.saturating_duration_since(*t) < NUDGE_MIN_GAP) {
            return false;
        }
        last.insert(account_id.to_string(), now);
        true
    }
}

/// The gate's decision: the reason to refuse, or `None` when the turn may go.
pub(crate) fn block_reason_of(status: Option<&ApiCreditStatus>) -> Option<String> {
    let status = status?;
    if !status.blocked {
        return None;
    }
    Some(status.block_reason.clone().unwrap_or_else(|| "API credit is used up".to_string()))
}

/// Re-reads the Console for `account` with `base_url`, stores the result and
/// tells listeners if it changed. A missing cookie is a status with an error,
/// not a failure.
pub async fn refresh_account_at(
    state: &Arc<DaemonState>,
    account: &Account,
    base_url: &str,
) -> ApiCreditStatus {
    let key = load_console_session(&account.id);
    let status = fetch_status(base_url, &account.id, &account.org_uuid, key.as_deref()).await;
    store(state, status.clone());
    status
}

pub async fn refresh_account(state: &Arc<DaemonState>, account: &Account) -> ApiCreditStatus {
    refresh_account_at(state, account, CONSOLE_BASE_URL).await
}

/// Stores `status` and publishes `STATUS_CHANGED_EVENT` when its content changed.
pub fn store(state: &DaemonState, status: ApiCreditStatus) {
    let payload = json!({ "account_id": status.account_id, "status": status });
    if state.api_credit.set(status) {
        state.notifier.publish(STATUS_CHANGED_EVENT, payload);
    }
}

fn api_credit_accounts() -> Vec<Account> {
    crate::accounts::load_registry().into_iter().filter(Account::is_api_credit).collect()
}

async fn poll_all(state: &Arc<DaemonState>) {
    let accounts = api_credit_accounts();
    let keep: HashSet<String> = accounts.iter().map(|a| a.id.clone()).collect();
    state.api_credit.retain_accounts(&keep);
    for account in &accounts {
        refresh_account(state, account).await;
    }
}

/// Starts the 5-minute poll over every ApiCredit account. The first tick runs
/// at once, so the cache is warm before the first chat is sent.
pub fn spawn_poller(state: Arc<DaemonState>) {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(POLL_INTERVAL);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            ticker.tick().await;
            poll_all(&state).await;
        }
    });
}

/// A chat on `account_id` just finished a turn, so its spend moved: refresh
/// now rather than waiting for the poll, since the next turn's gate reads this.
/// Fire-and-forget and debounced; a no-op for any account that is not a
/// tracked ApiCredit account.
pub fn nudge_after_turn(state: &Arc<DaemonState>, account_id: &str) {
    if !state.api_credit.nudge_due(account_id, Instant::now()) {
        return;
    }
    let state = state.clone();
    let account_id = account_id.to_string();
    tokio::spawn(async move {
        if let Some(account) = api_credit_accounts().into_iter().find(|a| a.id == account_id) {
            refresh_account(&state, &account).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::types::Settings;

    fn status(id: &str, blocked: bool, reason: Option<&str>) -> ApiCreditStatus {
        ApiCreditStatus {
            account_id: id.into(),
            fetched_at: "t0".into(),
            blocked,
            block_reason: reason.map(String::from),
            ..Default::default()
        }
    }

    #[test]
    fn the_gate_refuses_only_a_blocked_status_and_carries_its_reason() {
        assert_eq!(block_reason_of(None), None, "no status yet: unknown never blocks");
        assert_eq!(block_reason_of(Some(&status("a", false, None))), None);
        assert_eq!(
            block_reason_of(Some(&status("a", true, Some("API credit for this cycle is used up, expires 2026-11-02")))),
            Some("API credit for this cycle is used up, expires 2026-11-02".into())
        );
        assert!(block_reason_of(Some(&status("a", true, None))).is_some(), "a blocked status always has a reason");
    }

    #[test]
    fn set_reports_a_change_but_not_a_refetch_of_the_same_figures() {
        let hub = ApiCreditHub::new();
        assert!(hub.set(status("a", false, None)), "first sight is a change");
        let mut again = status("a", false, None);
        again.fetched_at = "t1".into();
        assert!(!hub.set(again), "only fetched_at moved");
        assert_eq!(hub.get("a").unwrap().fetched_at, "t1", "the newer timestamp is still stored");
        assert!(hub.set(status("a", true, Some("x"))));
        assert_eq!(hub.blocked_reason("a").as_deref(), Some("x"));
        assert_eq!(hub.blocked_reason("other"), None);
    }

    #[test]
    fn a_fetch_error_after_a_blocked_status_keeps_the_gate_closed() {
        let hub = ApiCreditHub::new();
        hub.set(status("a", true, Some("API credit for this cycle is used up")));
        let mut errored = status("a", false, None);
        errored.error = Some("credit balance: prepaid credits HTTP 500".into());
        errored.fetched_at = "t1".into();
        hub.set(errored);
        assert_eq!(hub.blocked_reason("a").as_deref(), Some("API credit for this cycle is used up"));
        assert_eq!(hub.get("a").unwrap().fetched_at, "t1", "the errored read is still stored");

        let mut recovered = status("a", false, None);
        recovered.fetched_at = "t2".into();
        recovered.max_grant_remaining_cents = Some(500);
        recovered.limit_cents = Some(20000);
        recovered.spend_cents = Some(10);
        assert!(hub.set(recovered), "a clean read clears the block");
        assert_eq!(hub.blocked_reason("a"), None);
    }

    #[test]
    fn retain_accounts_drops_removed_accounts() {
        let hub = ApiCreditHub::new();
        hub.set(status("a", false, None));
        hub.set(status("b", true, Some("x")));
        hub.retain_accounts(&HashSet::from(["a".to_string()]));
        assert!(hub.get("b").is_none());
        assert!(hub.get("a").is_some());
        assert_eq!(hub.snapshot().len(), 1);
    }

    #[test]
    fn nudges_are_debounced_per_account_and_skip_untracked_accounts() {
        let hub = ApiCreditHub::new();
        let t0 = Instant::now();
        assert!(!hub.nudge_due("sub", t0), "an account with no status is not an ApiCredit account");
        hub.set(status("a", false, None));
        hub.set(status("b", false, None));
        assert!(hub.nudge_due("a", t0));
        assert!(!hub.nudge_due("a", t0 + Duration::from_secs(29)), "inside the 30s gap");
        assert!(hub.nudge_due("b", t0 + Duration::from_secs(1)), "each account has its own gap");
        assert!(hub.nudge_due("a", t0 + Duration::from_secs(31)));
    }

    #[tokio::test]
    async fn store_publishes_once_per_content_change() {
        let state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        let mut rx = state.notifier.subscribe();
        store(&state, status("a", false, None));
        let frame = rx.try_recv().expect("first status is published");
        assert_eq!(frame["method"], STATUS_CHANGED_EVENT);
        assert_eq!(frame["params"]["account_id"], "a");
        assert_eq!(frame["params"]["status"]["blocked"], false);

        let mut refetch = status("a", false, None);
        refetch.fetched_at = "t9".into();
        store(&state, refetch);
        assert!(rx.try_recv().is_err(), "an unchanged refetch stays quiet");

        store(&state, status("a", true, Some("x")));
        assert_eq!(rx.try_recv().unwrap()["params"]["status"]["block_reason"], "x");
    }
}
