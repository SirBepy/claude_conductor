//! Load/save the persisted accounts registry. Mirrors `settings::store`'s
//! load/save shape: `save` writes through `util::write_json_atomic` (temp +
//! rename), and `load` backs up a totally unparsable file before defaulting
//! rather than silently discarding it. Unlike `settings::store`'s object-key
//! salvage, `accounts.json` is a top-level array, so the granularity here is
//! per-entry - the same shape as `Settings.projects`'s
//! `deserialize_lenient_projects` - so one bad `Account` entry drops only
//! itself instead of wiping the whole registry (todo 785/787's mechanism,
//! applied to this sibling).

use super::model::Account;
use anyhow::{Context, Result};
use std::path::Path;

/// Loads the accounts registry from disk. A missing file yields an empty
/// registry. A file that isn't valid JSON at all is renamed aside to
/// `accounts.json.broken-<unix-ts>` (never overwritten by a later `save`)
/// and an empty registry is returned. A file that IS valid JSON but has one
/// or more entries that don't match `Account` salvages every other entry -
/// only the unparsable ones are dropped, and each drop is logged.
pub fn load(path: &Path) -> Vec<Account> {
    let raw = match std::fs::read_to_string(path) {
        Ok(r) => r,
        Err(_) => return Vec::new(),
    };
    let items = match serde_json::from_str::<Vec<serde_json::Value>>(&raw) {
        Ok(items) => items,
        Err(err) => {
            let ts = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let backup = path.with_extension(format!("json.broken-{ts}"));
            let _ = std::fs::rename(path, &backup);
            log::error!(
                "[accounts] raw file was not valid JSON ({err}); preserved at {}; loaded empty registry",
                backup.display()
            );
            return Vec::new();
        }
    };
    items
        .into_iter()
        .filter_map(|v| match serde_json::from_value::<Account>(v) {
            Ok(a) => Some(a),
            Err(err) => {
                log::error!("[accounts] dropped unparsable account entry: {err}");
                None
            }
        })
        .collect()
}

/// Saves the accounts registry to disk, creating parent dirs as needed.
/// Write-temp-then-rename via `util::write_json_atomic`, matching
/// `settings::store::save`: a crash or kill mid-write truncates the temp
/// file, never `path` itself.
pub fn save(path: &Path, accounts: &[Account]) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("creating parent dir {parent:?}"))?;
    }
    let raw = serde_json::to_string_pretty(accounts).context("serializing accounts")?;
    crate::util::write_json_atomic(path, &raw)
        .with_context(|| format!("writing accounts to {path:?}"))?;
    Ok(())
}

/// Finds an existing account whose `org_uuid` or `email` (case-insensitive)
/// matches, excluding an account whose `config_dir` equals `exclude_config_dir`
/// (adopting a dir back into its own account is not a duplicate). Used by the
/// wizard's dedup step: "already added as <label>".
pub fn find_duplicate<'a>(
    accounts: &'a [Account],
    org_uuid: &str,
    email: &str,
    exclude_config_dir: Option<&std::path::Path>,
) -> Option<&'a Account> {
    accounts.iter().find(|a| {
        if Some(a.config_dir.as_path()) == exclude_config_dir {
            return false;
        }
        a.org_uuid == org_uuid || a.email.eq_ignore_ascii_case(email)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn acct(id: &str, org_uuid: &str, email: &str, config_dir: &str) -> Account {
        Account {
            id: id.into(),
            label: id.into(),
            colour: "#fff".into(),
            icon: "user".into(),
            config_dir: std::path::PathBuf::from(config_dir),
            chrome_profile_dir: std::path::PathBuf::from(format!("{config_dir}-chrome")),
            email: email.into(),
            org_uuid: org_uuid.into(),
            subscription_tier: "claude_pro".into(),
            created_at: "2026-07-07T00:00:00Z".into(),
            fleet_eligible: false,
        }
    }

    #[test]
    fn load_missing_file_returns_empty() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("nope.json");
        assert!(load(&path).is_empty());
    }

    #[test]
    fn load_corrupt_file_returns_empty() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("accounts.json");
        std::fs::write(&path, "{ not valid").unwrap();
        assert!(load(&path).is_empty());
    }

    /// The root-cause guard for the accounts half of todo 785/787: a totally
    /// unparsable file must be preserved (not clobbered by the next `save`)
    /// instead of just silently defaulting in place, mirroring
    /// `settings::store::load_corrupt_file_preserves_original_so_save_cannot_clobber`.
    #[test]
    fn load_corrupt_file_preserves_original_so_save_cannot_clobber() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("accounts.json");
        std::fs::write(&path, "{ not valid").unwrap();
        let _ = load(&path);
        assert!(!path.exists(), "broken file must be moved aside");
        let backups: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with("accounts.json.broken-")
            })
            .collect();
        assert_eq!(backups.len(), 1, "exactly one backup file");
    }

    /// A corrupt `accounts.json` must NOT silently discard the WHOLE
    /// registry when only one entry is bad - this is the exact mechanism
    /// behind todo 785 (one bad field wiping 7 unrelated top-level
    /// settings), applied to the accounts array: one unparsable `Account`
    /// entry drops only itself, every other account survives.
    #[test]
    fn load_salvages_every_other_account_when_one_entry_is_unparsable() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("accounts.json");
        let good = acct("a1", "org-1", "a@x.com", "C:/a");
        let raw = serde_json::json!([
            good,
            { "id": "broken", "label": "Broken" } // missing required fields
        ]);
        std::fs::write(&path, serde_json::to_string(&raw).unwrap()).unwrap();

        let loaded = load(&path);

        assert!(path.exists(), "one bad entry must not trigger the broken-file path");
        assert_eq!(loaded.len(), 1, "the broken entry drops, the good one survives");
        assert_eq!(loaded[0], good);
    }

    #[test]
    fn save_then_load_roundtrips() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("sub").join("accounts.json");
        let accounts = vec![acct("a1", "org-1", "a@x.com", "C:/a")];
        save(&path, &accounts).unwrap();
        assert_eq!(load(&path), accounts);
    }

    #[test]
    fn find_duplicate_matches_org_uuid() {
        let accounts = vec![acct("a1", "org-1", "a@x.com", "C:/a")];
        let dup = find_duplicate(&accounts, "org-1", "different@x.com", None);
        assert_eq!(dup.unwrap().id, "a1");
    }

    #[test]
    fn find_duplicate_matches_email_case_insensitive() {
        let accounts = vec![acct("a1", "org-1", "a@x.com", "C:/a")];
        let dup = find_duplicate(&accounts, "org-other", "A@X.COM", None);
        assert_eq!(dup.unwrap().id, "a1");
    }

    #[test]
    fn find_duplicate_none_when_no_match() {
        let accounts = vec![acct("a1", "org-1", "a@x.com", "C:/a")];
        assert!(find_duplicate(&accounts, "org-2", "b@x.com", None).is_none());
    }

    #[test]
    fn find_duplicate_excludes_own_config_dir_for_adoption() {
        let accounts = vec![acct("a1", "org-1", "a@x.com", "C:/a")];
        let dup = find_duplicate(
            &accounts,
            "org-1",
            "a@x.com",
            Some(std::path::Path::new("C:/a")),
        );
        assert!(dup.is_none(), "adopting a dir back into its own account is not a duplicate");
    }
}
