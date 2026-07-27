//! One-time single -> multi-account migration bridge (milestone 08). See
//! `docs/multi-account/08-notifications-polish.md` and the migration notes in
//! `docs/multi-account/03-per-account-usage.md`.
//!
//! No account is ever auto-created here - `/login` cannot be scripted for the
//! user (00-overview.md, locked decision). Instead:
//! - The legacy `session.txt` poll (`scheduler::do_poll_legacy`) keeps working
//!   until the first account is added (`scheduler::account_has_cookie`/
//!   `do_poll`'s branch choice already handles that half unchanged).
//! - A one-time "set up your accounts" prompt surfaces in the app whenever the
//!   registry is empty and a legacy `session.txt` still exists
//!   (`should_show_setup_prompt`), until the user dismisses it or adds an
//!   account (whichever first - both conditions naturally clear the prompt,
//!   no separate "seen" flag needed for the latter).
//! - When an account IS added, `add_account_finalize` calls
//!   [`migrate_if_matching`]: if the new account's `org_uuid` is among the
//!   orgs visible to the (still-live) legacy cookie, its usage history +
//!   capacity re-key to the new account and `session.txt` retires. The legacy
//!   poll never persisted which org it was scraping (`fetch_usage` /
//!   `orgs.first()` - see `03-per-account-usage.md`), so that org list is
//!   fetched fresh, once, at migration time via the legacy cookie itself.
//!
//! Every effectful step here is idempotent and best-effort: a failure must
//! never fail account creation, and a no-op re-run (e.g. a second account
//! added after the first already claimed the legacy history) must never
//! double-migrate or lose data - legacy data that matches no account stays
//! parked (not deleted), per the milestone-03 acceptance criterion.

use crate::accounts::Account;
use crate::settings::paths;
use crate::types::usage::UsageSnapshot;
use anyhow::Result;
use rusqlite::Connection;
use std::path::{Path, PathBuf};

/// Whether the one-time "set up your accounts" prompt should show. Pure so
/// it's trivially unit-testable; the IPC command (`get_accounts_setup_prompt_
/// state`) supplies the three inputs from disk/settings.
pub fn should_show_setup_prompt(
    registry_empty: bool,
    legacy_session_exists: bool,
    dismissed: bool,
) -> bool {
    registry_empty && legacy_session_exists && !dismissed
}

/// Outcome of one [`migrate_if_org_matches`] attempt, surfaced for logging.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MigrationOutcome {
    /// The account's `org_uuid` wasn't among the legacy cookie's orgs -
    /// nothing to migrate for this account.
    NoMatch,
    Migrated {
        rows_rekeyed: usize,
        capacity_copied: bool,
        /// `Some(backup_path)` if this call is what retired `session.txt`;
        /// `None` if it was already retired by a prior (idempotent) run.
        retired_to: Option<PathBuf>,
    },
}

/// Re-keys every legacy (`account_id IS NULL`) `usage_snapshots` row to
/// `account_id`. Rewrites BOTH the indexed column and the row's stored JSON
/// blob's `account_id` field - `usage_store::get_snapshots`/`get_all_snapshots`
/// deserialize the blob, not the column, so leaving the blob's `account_id:
/// null` behind would silently un-migrate every read despite the column
/// update. Idempotent: a second call finds no `NULL` rows left (0 re-keyed).
pub fn rekey_usage_history(conn: &Connection, account_id: &str) -> Result<usize> {
    let mut stmt = conn.prepare("SELECT id, data FROM usage_snapshots WHERE account_id IS NULL")?;
    let rows: Vec<(i64, String)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    drop(stmt);

    let mut n = 0usize;
    for (id, data) in rows {
        let mut snap: UsageSnapshot = serde_json::from_str(&data)?;
        snap.account_id = Some(account_id.to_string());
        let new_data = serde_json::to_string(&snap)?;
        conn.execute(
            "UPDATE usage_snapshots SET account_id = ?1, data = ?2 WHERE id = ?3",
            rusqlite::params![account_id, new_data, id],
        )?;
        n += 1;
    }
    Ok(n)
}

/// Copies the legacy capacity estimate to the account's own capacity file -
/// but ONLY when the account doesn't already have one, so a capacity ruler
/// the account has already calibrated on its own polls is never clobbered.
/// Returns `true` if a copy happened. Idempotent: a second call is a no-op
/// (the target now exists) and returns `false`.
pub fn rekey_capacity_at(legacy_path: &Path, target_path: &Path) -> Result<bool> {
    if target_path.exists() || !legacy_path.exists() {
        return Ok(false);
    }
    let estimate = crate::tokens::capacity::load(legacy_path);
    crate::tokens::capacity::save(target_path, &estimate)?;
    Ok(true)
}

/// Renames the legacy session file to `<name>.bak` so the legacy poll branch
/// (`scheduler::account_has_cookie`) stops being reachable for it - renamed
/// rather than deleted, recoverable if migration ever picked the wrong
/// account. Idempotent: a missing source (already retired, or never existed)
/// is a no-op success.
pub fn retire_legacy_session_at(legacy_session_path: &Path) -> Result<Option<PathBuf>> {
    if !legacy_session_path.exists() {
        return Ok(None);
    }
    let backup = crate::storage::migration::bak_path(legacy_session_path);
    std::fs::rename(legacy_session_path, &backup)?;
    Ok(Some(backup))
}

/// Pure decision + effect step: given the org uuids visible to the legacy
/// cookie (fetched by the caller - this fn does no I/O beyond the explicit
/// paths/connection passed in), decides whether `account` matches and, if so,
/// performs the re-key. Fully unit-testable without HTTP.
pub fn migrate_if_org_matches(
    account: &Account,
    legacy_org_uuids: &[String],
    conn: &Connection,
    legacy_capacity_path: &Path,
    account_capacity_path: &Path,
    legacy_session_path: &Path,
) -> Result<MigrationOutcome> {
    if !legacy_org_uuids.iter().any(|u| u == &account.org_uuid) {
        return Ok(MigrationOutcome::NoMatch);
    }
    let rows_rekeyed = rekey_usage_history(conn, &account.id)?;
    let capacity_copied = rekey_capacity_at(legacy_capacity_path, account_capacity_path)?;
    let retired_to = retire_legacy_session_at(legacy_session_path)?;
    Ok(MigrationOutcome::Migrated { rows_rekeyed, capacity_copied, retired_to })
}

/// Fetches the org uuid(s) visible to the legacy cookie. The legacy poll
/// (`fetch_usage`/`orgs.first()`) never persisted which org it scraped, so
/// this is the one place that org list gets read - once, at migration time.
/// Empty (not an error) when there's no legacy cookie on disk at all.
///
/// `pub(crate)`, not `pub`: this is the async, network-touching half of the
/// migration attempt. Callers (`ipc::accounts::add_account_finalize`) must
/// run this BEFORE taking any `Mutex` guard (e.g. `AppState.db`) - a sync
/// guard held across this `.await` would poison the command's `Send` bound.
/// [`apply_migration_if_matching`] is the sync half that follows.
pub(crate) async fn legacy_org_uuids(legacy_session_path: &Path) -> Result<Vec<String>> {
    let Some(session_key) = crate::auth::session::load(legacy_session_path) else {
        return Ok(Vec::new());
    };
    let orgs = crate::scraping::client::fetch_org_list("https://claude.ai", &session_key).await?;
    Ok(orgs.into_iter().map(|o| o.uuid).collect())
}

/// Real-paths wrapper around [`migrate_if_org_matches`] for `add_account_
/// finalize`: resolves the legacy capacity/session paths and this account's
/// own capacity path, then runs the sync re-key. Takes the already-fetched
/// `legacy_org_uuids` (see that fn's doc comment for why the fetch must
/// happen before any lock is taken) rather than fetching them itself.
pub fn apply_migration_if_matching(
    account: &Account,
    legacy_org_uuids: &[String],
    conn: &Connection,
) -> Result<MigrationOutcome> {
    let legacy_session_path = paths::session_file()?;
    let legacy_capacity_path = paths::session_capacity_file()?;
    let account_capacity_path = paths::account_session_capacity_file(&account.id)?;
    migrate_if_org_matches(
        account,
        legacy_org_uuids,
        conn,
        &legacy_capacity_path,
        &account_capacity_path,
        &legacy_session_path,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::db::{init_schema, run_migrations};
    use crate::tokens::capacity::CapacityEstimate;
    use tempfile::tempdir;

    fn test_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        init_schema(&conn).unwrap();
        run_migrations(&conn).unwrap();
        conn
    }

    fn acct(id: &str, org_uuid: &str) -> Account {
        Account {
            id: id.into(),
            label: id.into(),
            colour: "#fff".into(),
            icon: "user".into(),
            config_dir: std::path::PathBuf::from(format!("C:/home/.claude-{id}")),
            chrome_profile_dir: std::path::PathBuf::from(format!("C:/appdata/chrome-profiles/{id}")),
            email: format!("{id}@example.com"),
            org_uuid: org_uuid.into(),
            subscription_tier: "claude_max".into(),
            created_at: "2026-07-07T00:00:00Z".into(),
            fleet_eligible: false,
        }
    }

    fn legacy_snap() -> UsageSnapshot {
        UsageSnapshot {
            captured_at: "2026-07-01T00:00:00Z".into(),
            five_hour: crate::types::WindowUsage { utilization: 12.0, resets_at: "x".into() },
            seven_day: crate::types::WindowUsage { utilization: 8.0, resets_at: "y".into() },
            extra_usage: None,
            account_id: None,
        }
    }

    // -- should_show_setup_prompt ------------------------------------------

    #[test]
    fn setup_prompt_shows_only_when_empty_registry_and_legacy_session_and_not_dismissed() {
        assert!(should_show_setup_prompt(true, true, false));
        assert!(!should_show_setup_prompt(false, true, false), "registry not empty");
        assert!(!should_show_setup_prompt(true, false, false), "no legacy session");
        assert!(!should_show_setup_prompt(true, true, true), "dismissed");
    }

    // -- rekey_usage_history -------------------------------------------------

    #[test]
    fn rekey_usage_history_updates_column_and_blob_and_is_idempotent() {
        let conn = test_conn();
        crate::storage::usage_store::insert_snapshot(&conn, &legacy_snap()).unwrap();
        crate::storage::usage_store::insert_snapshot(&conn, &legacy_snap()).unwrap();

        let n = rekey_usage_history(&conn, "acct-1").unwrap();
        assert_eq!(n, 2, "both legacy (NULL) rows re-keyed");

        // Column AND the deserialized blob must agree.
        let all = crate::storage::usage_store::get_all_snapshots(&conn).unwrap();
        assert_eq!(all.len(), 2);
        for s in &all {
            assert_eq!(s.account_id.as_deref(), Some("acct-1"));
        }
        let only_acct1 = crate::storage::usage_store::get_snapshots(&conn, 0, -1, Some("acct-1")).unwrap();
        assert_eq!(only_acct1.len(), 2);

        // Idempotent: nothing left to re-key.
        let n2 = rekey_usage_history(&conn, "acct-1").unwrap();
        assert_eq!(n2, 0);
    }

    #[test]
    fn rekey_usage_history_leaves_already_tagged_rows_alone() {
        let conn = test_conn();
        let mut tagged = legacy_snap();
        tagged.account_id = Some("other-acct".into());
        crate::storage::usage_store::insert_snapshot(&conn, &tagged).unwrap();
        crate::storage::usage_store::insert_snapshot(&conn, &legacy_snap()).unwrap();

        let n = rekey_usage_history(&conn, "acct-1").unwrap();
        assert_eq!(n, 1, "only the NULL row is re-keyed");

        let all = crate::storage::usage_store::get_all_snapshots(&conn).unwrap();
        let ids: Vec<Option<String>> = all.iter().map(|s| s.account_id.clone()).collect();
        assert!(ids.contains(&Some("other-acct".to_string())));
        assert!(ids.contains(&Some("acct-1".to_string())));
    }

    // -- rekey_capacity_at ----------------------------------------------------

    #[test]
    fn rekey_capacity_copies_when_target_absent() {
        let dir = tempdir().unwrap();
        let legacy = dir.path().join("session-capacity.json");
        let target = dir.path().join("session-capacity-acct-1.json");
        crate::tokens::capacity::save(&legacy, &CapacityEstimate {
            capacity_5h_units: 42.0,
            capacity_weekly_units: 900.0,
            samples: 5,
            updated_at: "2026-07-01T00:00:00Z".into(),
        }).unwrap();

        let copied = rekey_capacity_at(&legacy, &target).unwrap();
        assert!(copied);
        let loaded = crate::tokens::capacity::load(&target);
        assert_eq!(loaded.capacity_5h_units, 42.0);
    }

    #[test]
    fn rekey_capacity_never_overwrites_an_existing_target() {
        let dir = tempdir().unwrap();
        let legacy = dir.path().join("session-capacity.json");
        let target = dir.path().join("session-capacity-acct-1.json");
        crate::tokens::capacity::save(&legacy, &CapacityEstimate {
            capacity_5h_units: 1.0, capacity_weekly_units: 1.0, samples: 1, updated_at: "x".into(),
        }).unwrap();
        crate::tokens::capacity::save(&target, &CapacityEstimate {
            capacity_5h_units: 999.0, capacity_weekly_units: 999.0, samples: 50, updated_at: "y".into(),
        }).unwrap();

        let copied = rekey_capacity_at(&legacy, &target).unwrap();
        assert!(!copied, "must not report a copy when the target already existed");
        let loaded = crate::tokens::capacity::load(&target);
        assert_eq!(loaded.capacity_5h_units, 999.0, "account's own calibration must survive untouched");
    }

    #[test]
    fn rekey_capacity_missing_legacy_is_a_noop() {
        let dir = tempdir().unwrap();
        let legacy = dir.path().join("nope.json");
        let target = dir.path().join("session-capacity-acct-1.json");
        assert!(!rekey_capacity_at(&legacy, &target).unwrap());
        assert!(!target.exists());
    }

    // -- retire_legacy_session_at ---------------------------------------------

    #[test]
    fn retire_legacy_session_renames_to_bak_and_is_idempotent() {
        let dir = tempdir().unwrap();
        let legacy = dir.path().join("session.txt");
        std::fs::write(&legacy, "sk-legacy-cookie").unwrap();

        let backup = retire_legacy_session_at(&legacy).unwrap();
        let backup = backup.expect("first call retires");
        assert_eq!(backup, dir.path().join("session.txt.bak"));
        assert!(!legacy.exists());
        assert!(backup.exists());
        assert_eq!(std::fs::read_to_string(&backup).unwrap(), "sk-legacy-cookie");

        // Idempotent: already retired, second call is a clean no-op.
        let second = retire_legacy_session_at(&legacy).unwrap();
        assert_eq!(second, None);
    }

    // -- migrate_if_org_matches (full orchestration, no network) -------------

    #[test]
    fn migrate_if_org_matches_is_a_noop_for_a_non_matching_org() {
        let conn = test_conn();
        crate::storage::usage_store::insert_snapshot(&conn, &legacy_snap()).unwrap();
        let dir = tempdir().unwrap();
        let legacy_capacity = dir.path().join("session-capacity.json");
        let account_capacity = dir.path().join("session-capacity-acct-1.json");
        let legacy_session = dir.path().join("session.txt");
        std::fs::write(&legacy_session, "sk").unwrap();

        let account = acct("acct-1", "org-mine");
        let outcome = migrate_if_org_matches(
            &account,
            &["org-someone-else".to_string()],
            &conn,
            &legacy_capacity,
            &account_capacity,
            &legacy_session,
        ).unwrap();

        assert_eq!(outcome, MigrationOutcome::NoMatch);
        // Nothing touched: legacy row still NULL, session.txt still present.
        let all = crate::storage::usage_store::get_all_snapshots(&conn).unwrap();
        assert_eq!(all[0].account_id, None);
        assert!(legacy_session.exists());
    }

    /// The full happy path AND its idempotence: re-running the exact same
    /// migration attempt (e.g. a second account-add IPC round, or a retry
    /// after a partial earlier failure) must be lossless and side-effect-free
    /// the second time.
    #[test]
    fn migrate_if_org_matches_full_happy_path_is_idempotent() {
        let conn = test_conn();
        crate::storage::usage_store::insert_snapshot(&conn, &legacy_snap()).unwrap();
        let dir = tempdir().unwrap();
        let legacy_capacity = dir.path().join("session-capacity.json");
        let account_capacity = dir.path().join("session-capacity-acct-1.json");
        let legacy_session = dir.path().join("session.txt");
        crate::tokens::capacity::save(&legacy_capacity, &CapacityEstimate {
            capacity_5h_units: 10.0, capacity_weekly_units: 200.0, samples: 3, updated_at: "x".into(),
        }).unwrap();
        std::fs::write(&legacy_session, "sk-legacy").unwrap();

        let account = acct("acct-1", "org-mine");
        let org_uuids = vec!["org-other".to_string(), "org-mine".to_string()];

        let first = migrate_if_org_matches(
            &account, &org_uuids, &conn, &legacy_capacity, &account_capacity, &legacy_session,
        ).unwrap();
        match &first {
            MigrationOutcome::Migrated { rows_rekeyed, capacity_copied, retired_to } => {
                assert_eq!(*rows_rekeyed, 1);
                assert!(*capacity_copied);
                assert!(retired_to.is_some());
            }
            other => panic!("expected Migrated, got {other:?}"),
        }
        assert!(!legacy_session.exists(), "legacy session retired");
        assert!(dir.path().join("session.txt.bak").exists());
        let all = crate::storage::usage_store::get_all_snapshots(&conn).unwrap();
        assert_eq!(all[0].account_id.as_deref(), Some("acct-1"));

        // Second attempt against the same (now-migrated) state: no rows left
        // to re-key, capacity target already exists, session already retired.
        let second = migrate_if_org_matches(
            &account, &org_uuids, &conn, &legacy_capacity, &account_capacity, &legacy_session,
        ).unwrap();
        assert_eq!(second, MigrationOutcome::Migrated {
            rows_rekeyed: 0,
            capacity_copied: false,
            retired_to: None,
        });
    }
}
