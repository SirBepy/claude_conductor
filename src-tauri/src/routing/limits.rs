//! "Is this account at its usage limit right now?", the question a rule's
//! `fallback` hangs on (pc-1833 phase 3). [`at_limit`] is pure over the signals
//! the daemon already holds; [`probe`] gathers them. Nothing here polls.
//!
//! An unknown figure is never a limit: no snapshot, a snapshot older than three
//! poll intervals, or a window that already reset all read as "not at limit", so
//! a missing signal can only ever leave a spawn where it would have been.

use crate::accounts::{Account, AccountKind};
use crate::daemon::state::DaemonState;
use crate::types::{UsageSnapshot, WindowUsage};

/// A snapshot older than this many poll intervals no longer says anything.
const STALE_POLL_INTERVALS: i64 = 3;

/// Which window is exhausted and when it refills, for the routing note.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Limit {
    /// `5h`, `weekly` or `rate`.
    pub window: &'static str,
    /// Unix seconds, `None` when the window's reset time is unknown.
    pub resets_at: Option<i64>,
}

impl Limit {
    /// `the 5h limit (resets 17:40)`.
    pub fn describe(&self) -> String {
        let name = match self.window {
            "5h" => "its 5h limit",
            "weekly" => "its weekly limit",
            _ => "a rate limit",
        };
        match self.resets_at.and_then(|t| chrono::DateTime::from_timestamp(t, 0)) {
            Some(t) => format!("{name} (resets {})", t.with_timezone(&chrono::Local).format("%H:%M")),
            None => name.to_string(),
        }
    }
}

/// What the daemon knows about one account.
#[derive(Clone, Debug, Default)]
pub struct Signals {
    /// The newest usage snapshot (percent utilization, 0..=100).
    pub snapshot: Option<UsageSnapshot>,
    /// The live rate-limit block from a refused turn: (resets_at, window).
    pub rate_limit: Option<(i64, String)>,
    pub poll_interval_secs: i64,
    pub now: i64,
}

fn window_limit(w: &WindowUsage, name: &'static str, now: i64) -> Option<Limit> {
    if w.utilization < 100.0 {
        return None;
    }
    let resets_at = chrono::DateTime::parse_from_rfc3339(&w.resets_at).ok().map(|t| t.timestamp());
    // A window that already reset says nothing about now, even at 100% when sampled.
    if resets_at.is_some_and(|t| t <= now) {
        return None;
    }
    Some(Limit { window: name, resets_at })
}

/// The limit `account` is at, if any. A live rate-limit block with a future
/// reset counts for every kind; the usage snapshot only for a Claude
/// subscription (an Endpoint account has no usage tracker, an API-credit
/// account is never a rule's target and has its own cap gate).
pub fn at_limit(account: &Account, s: &Signals) -> Option<Limit> {
    if let Some((resets_at, window)) = &s.rate_limit {
        if *resets_at > s.now {
            let window = match window.as_str() {
                "five_hour" => "5h",
                "seven_day" | "weekly" => "weekly",
                _ => "rate",
            };
            return Some(Limit { window, resets_at: Some(*resets_at) });
        }
    }
    if account.kind != AccountKind::Subscription {
        return None;
    }
    let snap = s.snapshot.as_ref()?;
    let captured = chrono::DateTime::parse_from_rfc3339(&snap.captured_at).ok()?.timestamp();
    if s.now - captured > s.poll_interval_secs.max(60) * STALE_POLL_INTERVALS {
        return None;
    }
    if snap.five_hour_limited {
        if let Some(l) = window_limit(&snap.five_hour, "5h", s.now) {
            return Some(l);
        }
    }
    window_limit(&snap.seven_day, "weekly", s.now)
}

/// Gathers the signals for `account` from the daemon and runs [`at_limit`].
pub fn probe(state: &DaemonState, poll_interval_secs: u64, account: &Account) -> Option<Limit> {
    let snapshot = state.db.as_ref().and_then(|db| {
        let mgr = db.lock().unwrap_or_else(|e| e.into_inner());
        crate::storage::usage_store::get_snapshots(mgr.conn(), 0, 1, Some(&account.id)).ok().and_then(|mut v| v.pop())
    });
    let s = Signals {
        snapshot,
        rate_limit: state.registry.rate_limit_for_account(&account.id),
        poll_interval_secs: poll_interval_secs as i64,
        now: chrono::Utc::now().timestamp(),
    };
    at_limit(account, &s)
}

/// The probe a spawn path hands to `resolve_with`.
pub fn prober(state: &DaemonState, poll_interval_secs: u64) -> impl Fn(&Account) -> Option<Limit> + '_ {
    move |a| probe(state, poll_interval_secs, a)
}

#[cfg(test)]
mod tests;
