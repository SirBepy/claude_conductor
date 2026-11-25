//! Daemon-side home of provider usage: what an Endpoint account (DeepSeek,
//! OpenRouter, later Kimi Code and Z.ai) has left, read from the provider's own
//! usage endpoint with the key Conductor already stores. Built like
//! `daemon::api_credit` (cache, poller, turn-end nudge, change event) but with
//! no gate: provider usage never refuses a turn. Read
//! docs/architecture/providers.md ("Provider usage") before editing.
//!
//! It lives in the daemon, not the app's usage scheduler, because routing reads
//! it at spawn time and the daemon outlives the window. An unknown figure (no
//! read yet, an error, a stale read) is never a limit.

pub mod fetch;
pub mod model;
mod switch;

pub use model::{ProviderUsage, ProviderUsageView, UsageBalance, UsageSpend, UsageWindow};

use crate::accounts::api_credit::load_api_key;
use crate::accounts::Account;
use crate::daemon::state::DaemonState;
use fetch::{fetch as fetch_usage, pinned_origin, Fetcher};
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// How often every fetchable Endpoint account is re-read. These endpoints are
/// balances and caps that move per turn at most, so a slow poll is plenty.
pub const POLL_INTERVAL: Duration = Duration::from_secs(600);
/// At most one turn-end refresh per account in this window.
const NUDGE_MIN_GAP: Duration = Duration::from_secs(60);

/// Notifier event published when an account's figures change. Needs the three
/// registrations: this publish, `daemon_link`'s match arm, `GLOBAL_EVENT_MAP`.
pub const USAGE_CHANGED_EVENT: &str = "provider_usage_changed";

#[derive(Default)]
pub struct ProviderUsageHub {
    usage: Mutex<HashMap<String, ProviderUsage>>,
    last_try: Mutex<HashMap<String, Instant>>,
    /// "Show plan usage" per account; read by `read_account` before any call.
    switches: Mutex<switch::Switches>,
}

impl ProviderUsageHub {
    pub fn new() -> Self {
        Self::default()
    }

    /// Reads the saved switches (once, at daemon start).
    pub fn load_switches(&self) {
        self.switches.lock().unwrap_or_else(|e| e.into_inner()).load();
    }

    /// True when `fetcher` may call for `account_id`: always for a documented
    /// route, only with the account's switch on for the rest.
    pub fn may_fetch(&self, account_id: &str, fetcher: Fetcher) -> bool {
        !fetcher.needs_opt_in() || self.switches.lock().unwrap_or_else(|e| e.into_inner()).is_on(account_id)
    }

    /// The saved answers, keyed by account id, for the view.
    pub fn switch_snapshot(&self) -> HashMap<String, bool> {
        self.switches.lock().unwrap_or_else(|e| e.into_inner()).snapshot()
    }

    fn set_switch(&self, account_id: &str, on: bool) -> Result<(), String> {
        self.switches.lock().unwrap_or_else(|e| e.into_inner()).set(account_id, on)
    }

    pub fn snapshot(&self) -> HashMap<String, ProviderUsage> {
        self.usage.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    pub fn get(&self, account_id: &str) -> Option<ProviderUsage> {
        self.usage.lock().unwrap_or_else(|e| e.into_inner()).get(account_id).cloned()
    }

    /// Stores `usage`; true when anything but `fetched_at` differs from what
    /// was there, i.e. when listeners need telling.
    pub fn set(&self, usage: ProviderUsage) -> bool {
        let mut map = self.usage.lock().unwrap_or_else(|e| e.into_inner());
        let changed = map.get(&usage.account_id).map_or(true, |old| !old.same_content(&usage));
        map.insert(usage.account_id.clone(), usage);
        changed
    }

    /// Drops every entry whose account is gone or no longer fetchable.
    pub fn retain_accounts(&self, keep: &HashSet<String>) {
        self.usage.lock().unwrap_or_else(|e| e.into_inner()).retain(|id, _| keep.contains(id));
        self.last_try.lock().unwrap_or_else(|e| e.into_inner()).retain(|id, _| keep.contains(id));
    }

    /// True when `account_id` has figures and its last turn-end refresh is
    /// older than `NUDGE_MIN_GAP`; records `now`. An account with no entry
    /// (every Claude account, every Custom endpoint) costs nothing here.
    fn nudge_due(&self, account_id: &str, now: Instant) -> bool {
        if !self.usage.lock().unwrap_or_else(|e| e.into_inner()).contains_key(account_id) {
            return false;
        }
        self.try_due(account_id, now)
    }

    /// True when `account_id` was not tried in the last `NUDGE_MIN_GAP`;
    /// records `now`. Lets a read kick off the first fetch of a new account
    /// without a page that polls `get_provider_usage` hammering the provider.
    pub(crate) fn try_due(&self, account_id: &str, now: Instant) -> bool {
        let mut last = self.last_try.lock().unwrap_or_else(|e| e.into_inner());
        if last.get(account_id).is_some_and(|t| now.saturating_duration_since(*t) < NUDGE_MIN_GAP) {
            return false;
        }
        last.insert(account_id.to_string(), now);
        true
    }
}

/// The Endpoint accounts that have a fetcher, with it.
fn fetchable_accounts() -> Vec<(Account, Fetcher)> {
    crate::accounts::load_registry()
        .into_iter()
        .filter_map(|a| {
            let fetcher = a.endpoint.as_ref().and_then(|e| Fetcher::for_preset(e.preset))?;
            a.is_endpoint().then_some((a, fetcher))
        })
        .collect()
}

/// Reads `account`'s figures now, stores them and tells listeners if they
/// changed. A missing key or an address off the preset's host list is stored as
/// an "unknown" with its reason, and makes no call.
pub async fn refresh_account(state: &Arc<DaemonState>, account: &Account, fetcher: Fetcher) -> ProviderUsage {
    let usage = if state.provider_usage.may_fetch(&account.id, fetcher) {
        read_account(account, fetcher, load_api_key(&account.id)).await
    } else {
        ProviderUsage::unknown(&account.id, fetcher.source(), SWITCH_OFF_NOTE)
    };
    store(state, usage.clone());
    usage
}

/// The "unknown" an opt-in account carries while its switch is off. Shown as a
/// tooltip; the row's own switch is what says "off".
pub const SWITCH_OFF_NOTE: &str = "Show plan usage is off for this account, so Conductor does not ask the provider";

/// Turns an opt-in account's "Show plan usage" on or off, then reads (or
/// clears) its figures at once. `Err` names why nothing changed.
pub async fn set_plan_usage(state: &Arc<DaemonState>, account_id: &str, on: bool) -> Result<(), String> {
    set_plan_usage_among(state, fetchable_accounts(), account_id, on).await
}

async fn set_plan_usage_among(
    state: &Arc<DaemonState>,
    accounts: Vec<(Account, Fetcher)>,
    account_id: &str,
    on: bool,
) -> Result<(), String> {
    let (account, fetcher) = accounts
        .into_iter()
        .find(|(a, _)| a.id == account_id)
        .ok_or_else(|| "no Endpoint account with that id has a usage reader".to_string())?;
    if !fetcher.needs_opt_in() {
        return Err("this account's usage is always shown; it has no switch".to_string());
    }
    state.provider_usage.set_switch(account_id, on)?;
    refresh_account(state, &account, fetcher).await;
    Ok(())
}

async fn read_account(account: &Account, fetcher: Fetcher, key: Option<String>) -> ProviderUsage {
    let Some(config) = account.endpoint.as_ref() else {
        return ProviderUsage::unknown(&account.id, fetcher.source(), "not an endpoint account");
    };
    let Some(key) = key else {
        return ProviderUsage::unknown(&account.id, fetcher.source(), "no key stored for this account");
    };
    let Some(origin) = pinned_origin(config, fetcher) else {
        return ProviderUsage::unknown(
            &account.id,
            fetcher.source(),
            "this account's address is not the provider's own, so its key is not sent there",
        );
    };
    fetch_usage(fetcher, &origin, &account.id, &key).await
}

/// Stores `usage` and publishes `USAGE_CHANGED_EVENT` when its content changed.
pub fn store(state: &DaemonState, usage: ProviderUsage) {
    let payload = json!({ "account_id": usage.account_id, "usage": usage });
    if state.provider_usage.set(usage) {
        state.notifier.publish(USAGE_CHANGED_EVENT, payload);
    }
}

async fn poll_all(state: &Arc<DaemonState>) {
    let accounts = fetchable_accounts();
    let keep: HashSet<String> = accounts.iter().map(|(a, _)| a.id.clone()).collect();
    state.provider_usage.retain_accounts(&keep);
    for (account, fetcher) in &accounts {
        refresh_account(state, account, *fetcher).await;
    }
}

/// Starts the poll over every fetchable Endpoint account. The first tick runs
/// at once, so the cache is warm before the Accounts page opens.
pub fn spawn_poller(state: Arc<DaemonState>) {
    state.provider_usage.load_switches();
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
/// now rather than waiting for the poll. Fire-and-forget and debounced; a no-op
/// for any account the hub does not track.
pub fn nudge_after_turn(state: &Arc<DaemonState>, account_id: &str) {
    if !state.provider_usage.nudge_due(account_id, Instant::now()) {
        return;
    }
    refresh_in_background(state, account_id);
}

/// Starts the first read for every fetchable account that has none yet, so a
/// freshly added account shows figures without waiting for the next poll.
/// Debounced per account.
pub fn kick_missing(state: &Arc<DaemonState>) {
    let have = state.provider_usage.snapshot();
    for (account, _) in fetchable_accounts() {
        if !have.contains_key(&account.id) && state.provider_usage.try_due(&account.id, Instant::now()) {
            refresh_in_background(state, &account.id);
        }
    }
}

fn refresh_in_background(state: &Arc<DaemonState>, account_id: &str) {
    let state = state.clone();
    let account_id = account_id.to_string();
    tokio::spawn(async move {
        if let Some((account, fetcher)) = fetchable_accounts().into_iter().find(|(a, _)| a.id == account_id) {
            refresh_account(&state, &account, fetcher).await;
        }
    });
}

#[cfg(test)]
mod tests;
