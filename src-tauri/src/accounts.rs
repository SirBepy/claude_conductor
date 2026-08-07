//! Multi-account identity: the `Account` record, its persisted registry, the
//! per-account `CLAUDE_CONFIG_DIR` profile-dir factory, and `.claude.json`
//! identity parsing. See `docs/multi-account/00-overview.md` (locked
//! decisions) and `docs/multi-account/01-account-identity.md` (this
//! milestone's spec).

pub mod model;
pub mod store;
pub mod identity;
pub mod profile;
pub mod login_step;
pub mod wizard;
pub mod env;
pub mod drift;
pub mod credentials;
pub mod migration;

pub use model::*;
pub use identity::{terminal_identity, OauthAccountInfo};
pub use wizard::WizardSession;

use std::collections::HashMap;

/// Errors resolving which registered `Account` a spawn should run under. See
/// `docs/multi-account/02-chat-routing.md`: "There is no no-override spawn
/// path: a chat REQUIRES a registry account."
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum AccountResolveError {
    #[error("no accounts registered - add an account before starting a chat")]
    NoAccounts,
    /// Registry is populated but the caller named no account and no
    /// `default_account_id` is set. Distinct from [`Self::NoAccounts`]: the
    /// user has accounts, they just haven't said which one an unattributed
    /// spawn should use.
    #[error("no default account set - pick one in Settings > Accounts")]
    NoDefault,
    #[error("account {0} not found in the registry")]
    NotFound(String),
}

/// Loads the on-disk accounts registry. Empty (never panics) if the path
/// can't be resolved or the file is missing/corrupt - mirrors `store::load`.
/// `pub(crate)` so the poll loop (`scheduler`) can iterate every registered
/// account without duplicating this fallback logic.
pub(crate) fn load_registry() -> Vec<model::Account> {
    match crate::settings::paths::accounts_file() {
        Ok(p) => store::load(&p),
        Err(_) => Vec::new(),
    }
}

/// Pure matching logic behind [`resolve_account`], split out so it is
/// testable without touching disk: `account_id` if given, else
/// `default_account_id`, looked up in an already-loaded registry slice.
fn pick_account(
    accounts: &[model::Account],
    account_id: Option<&str>,
    default_account_id: Option<&str>,
) -> Result<model::Account, AccountResolveError> {
    if accounts.is_empty() {
        return Err(AccountResolveError::NoAccounts);
    }
    let want = account_id
        .or(default_account_id)
        .ok_or(AccountResolveError::NoDefault)?;
    accounts
        .iter()
        .find(|a| a.id == want)
        .cloned()
        .ok_or_else(|| AccountResolveError::NotFound(want.to_string()))
}

/// Resolves the account a spawn should run under: `account_id` if given,
/// else `default_account_id`. Shared by every spawn site so "no spawn path
/// reaches `~/.claude`" holds uniformly regardless of caller.
pub fn resolve_account(
    account_id: Option<&str>,
    default_account_id: Option<&str>,
) -> Result<model::Account, AccountResolveError> {
    pick_account(&load_registry(), account_id, default_account_id)
}

/// Convenience wrapper for spawn sites that have no per-instance account
/// selection yet (channels, the news summarizer): resolves purely from
/// `Settings.default_account_id`, re-reading `settings.json` from disk since
/// these callers hold no live settings cache. Never falls back to
/// `~/.claude` - an unresolvable default means the caller skips/refuses.
pub fn resolve_default_account() -> Result<model::Account, AccountResolveError> {
    let settings_path =
        crate::settings::paths::settings_file().map_err(|_| AccountResolveError::NoAccounts)?;
    let settings = crate::settings::load(&settings_path);
    resolve_account(None, settings.default_account_id.as_deref())
}

/// The pool a Jarvis `spawn_worker` may draw an account from (todo 272,
/// "Fleet account allocation"): every account with `fleet_eligible == true`,
/// unioned with `default_account_id` even when that account has never opted
/// in. The union is what guarantees the pool is never empty - a fresh
/// install with zero accounts opted into the fleet still has its default
/// account available, matching v1's spawn-under-default behavior exactly.
/// Order is registry order with the default account appended last if it
/// wasn't already present (order has no ranking significance; `pick_from_pool`
/// below re-ranks by headroom).
fn eligible_pool(accounts: &[model::Account], default_account_id: Option<&str>) -> Vec<model::Account> {
    let mut pool: Vec<model::Account> = accounts.iter().filter(|a| a.fleet_eligible).cloned().collect();
    if let Some(default_id) = default_account_id {
        if !pool.iter().any(|a| a.id == default_id) {
            if let Some(default_acct) = accounts.iter().find(|a| a.id == default_id) {
                pool.push(default_acct.clone());
            }
        }
    }
    pool
}

/// Whether `account_id` is a legal explicit `spawn_worker` target: either it
/// opted into the fleet, or it IS the default account (always eligible - see
/// `eligible_pool`). Used to validate a caller-supplied `account` arg before
/// ever reaching `spawn_session`, so prompt discipline never guards billing:
/// the pool check itself is what a caller-picked account is measured against,
/// same as the auto-pick path.
pub fn is_in_eligible_pool(accounts: &[model::Account], default_account_id: Option<&str>, account_id: &str) -> bool {
    eligible_pool(accounts, default_account_id).iter().any(|a| a.id == account_id)
}

/// Pure ranking behind `pick_worker_account`, split out so it's testable
/// without a live `companion.db`: picks the pool member with the lowest 5h
/// utilization (most headroom). An account absent from `five_hour_utilization`
/// (no usage snapshot yet) is treated as 0.0 utilization - full headroom, per
/// Joe's call. Ties (including the common "nobody has usage data yet" case,
/// where every candidate reads 0.0) prefer `default_account_id` when it's
/// among the tied candidates, else the first pool member in iteration order.
fn pick_from_pool(
    pool: &[model::Account],
    default_account_id: Option<&str>,
    five_hour_utilization: &HashMap<String, f64>,
) -> Option<String> {
    let with_util: Vec<(&model::Account, f64)> = pool
        .iter()
        .map(|a| (a, five_hour_utilization.get(&a.id).copied().unwrap_or(0.0)))
        .collect();
    let min_util = with_util.iter().map(|(_, u)| *u).fold(f64::INFINITY, f64::min);
    let tied: Vec<&model::Account> = with_util
        .iter()
        .filter(|(_, u)| (*u - min_util).abs() < 1e-9)
        .map(|(a, _)| *a)
        .collect();
    if let Some(default_id) = default_account_id {
        if let Some(a) = tied.iter().find(|a| a.id == default_id) {
            return Some(a.id.clone());
        }
    }
    tied.first().map(|a| a.id.clone())
}

/// `pick_worker_account`'s pure core: builds the eligible pool and ranks it
/// by headroom. `None` iff the pool is empty (no default account set AND
/// nothing opted in) - the daemon-side async wrapper (`daemon::methods::
/// jarvis::pick_worker_account`) falls through to the ordinary `resolve_
/// account`/`NoDefault` error path in that case, unchanged from v1.
pub fn pick_worker_account_pure(
    accounts: &[model::Account],
    default_account_id: Option<&str>,
    five_hour_utilization: &HashMap<String, f64>,
) -> Option<String> {
    let pool = eligible_pool(accounts, default_account_id);
    pick_from_pool(&pool, default_account_id, five_hour_utilization)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn acct(id: &str) -> model::Account {
        model::Account {
            id: id.into(),
            label: id.into(),
            colour: "#fff".into(),
            icon: "user".into(),
            config_dir: std::path::PathBuf::from(format!("C:/home/.claude-{id}")),
            chrome_profile_dir: std::path::PathBuf::from(format!("C:/appdata/chrome-profiles/{id}")),
            email: format!("{id}@example.com"),
            org_uuid: format!("org-{id}"),
            subscription_tier: "claude_max".into(),
            created_at: "2026-07-07T00:00:00Z".into(),
            fleet_eligible: false,
        }
    }

    #[test]
    fn pick_account_empty_registry_is_no_accounts() {
        let err = pick_account(&[], None, None).unwrap_err();
        assert_eq!(err, AccountResolveError::NoAccounts);
    }

    #[test]
    fn pick_account_no_id_and_no_default_is_no_default() {
        let accounts = vec![acct("a")];
        let err = pick_account(&accounts, None, None).unwrap_err();
        assert_eq!(err, AccountResolveError::NoDefault);
    }

    #[test]
    fn pick_account_explicit_id_wins_over_default() {
        let accounts = vec![acct("a"), acct("b")];
        let got = pick_account(&accounts, Some("b"), Some("a")).unwrap();
        assert_eq!(got.id, "b");
    }

    #[test]
    fn pick_account_falls_back_to_default_when_no_explicit_id() {
        let accounts = vec![acct("a"), acct("b")];
        let got = pick_account(&accounts, None, Some("a")).unwrap();
        assert_eq!(got.id, "a");
    }

    #[test]
    fn pick_account_unknown_id_is_not_found() {
        let accounts = vec![acct("a")];
        let err = pick_account(&accounts, Some("ghost"), None).unwrap_err();
        assert_eq!(err, AccountResolveError::NotFound("ghost".to_string()));
    }

    // ── fleet allocation (todo 272) ─────────────────────────────────────────

    fn fleet_acct(id: &str) -> model::Account {
        let mut a = acct(id);
        a.fleet_eligible = true;
        a
    }

    #[test]
    fn eligible_pool_includes_only_opted_in_accounts_by_default() {
        let accounts = vec![acct("a"), fleet_acct("b"), acct("c")];
        let pool = eligible_pool(&accounts, None);
        assert_eq!(pool.iter().map(|a| a.id.as_str()).collect::<Vec<_>>(), vec!["b"]);
    }

    #[test]
    fn eligible_pool_unions_in_the_default_account_even_when_not_opted_in() {
        // v1 preservation: nothing opted in, but a default is set - the pool
        // must still contain exactly the default, never come back empty.
        let accounts = vec![acct("a"), acct("b")];
        let pool = eligible_pool(&accounts, Some("b"));
        assert_eq!(pool.iter().map(|a| a.id.as_str()).collect::<Vec<_>>(), vec!["b"]);
    }

    #[test]
    fn eligible_pool_does_not_duplicate_an_opted_in_default() {
        let accounts = vec![fleet_acct("a")];
        let pool = eligible_pool(&accounts, Some("a"));
        assert_eq!(pool.len(), 1);
    }

    #[test]
    fn eligible_pool_empty_when_nothing_opted_in_and_no_default() {
        let accounts = vec![acct("a"), acct("b")];
        assert!(eligible_pool(&accounts, None).is_empty());
    }

    #[test]
    fn is_in_eligible_pool_true_for_default_even_when_not_opted_in() {
        let accounts = vec![acct("a")];
        assert!(is_in_eligible_pool(&accounts, Some("a"), "a"));
    }

    #[test]
    fn is_in_eligible_pool_false_for_a_non_default_non_opted_in_account() {
        let accounts = vec![acct("a"), acct("b")];
        assert!(!is_in_eligible_pool(&accounts, Some("a"), "b"));
    }

    #[test]
    fn is_in_eligible_pool_true_for_an_opted_in_non_default_account() {
        let accounts = vec![acct("a"), fleet_acct("b")];
        assert!(is_in_eligible_pool(&accounts, Some("a"), "b"));
    }

    #[test]
    fn pick_worker_account_ranks_by_most_headroom() {
        let accounts = vec![fleet_acct("a"), fleet_acct("b")];
        let mut util = HashMap::new();
        util.insert("a".to_string(), 80.0);
        util.insert("b".to_string(), 20.0);
        let got = pick_worker_account_pure(&accounts, None, &util);
        assert_eq!(got.as_deref(), Some("b"), "b has more headroom (lower utilization)");
    }

    #[test]
    fn pick_worker_account_treats_missing_usage_as_full_headroom() {
        let accounts = vec![fleet_acct("a"), fleet_acct("b")];
        let mut util = HashMap::new();
        util.insert("a".to_string(), 10.0);
        // "b" has no snapshot at all.
        let got = pick_worker_account_pure(&accounts, None, &util);
        assert_eq!(got.as_deref(), Some("b"), "no data = 0.0 utilization = full headroom");
    }

    #[test]
    fn pick_worker_account_ties_prefer_the_default_account() {
        let accounts = vec![fleet_acct("a"), fleet_acct("b")];
        let util = HashMap::new(); // neither has data -> both read 0.0, a tie.
        let got = pick_worker_account_pure(&accounts, Some("b"), &util);
        assert_eq!(got.as_deref(), Some("b"));
    }

    #[test]
    fn pick_worker_account_none_when_pool_is_empty() {
        let accounts = vec![acct("a"), acct("b")];
        let util = HashMap::new();
        assert_eq!(pick_worker_account_pure(&accounts, None, &util), None);
    }

    #[test]
    fn pick_worker_account_falls_back_to_the_always_eligible_default_when_nothing_opted_in() {
        let accounts = vec![acct("a"), acct("b")];
        let util = HashMap::new();
        let got = pick_worker_account_pure(&accounts, Some("a"), &util);
        assert_eq!(got.as_deref(), Some("a"));
    }
}
