//! Load/save the persisted accounts registry. Mirrors `settings::store`'s
//! load/save shape (defaults on missing file, on-disk array of `Account`).

use super::model::Account;
use anyhow::{Context, Result};
use std::path::Path;

/// Loads the accounts registry from disk. Missing or unparsable file yields
/// an empty registry (never panics, never blocks boot).
pub fn load(path: &Path) -> Vec<Account> {
    let raw = match std::fs::read_to_string(path) {
        Ok(r) => r,
        Err(_) => return Vec::new(),
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

/// Saves the accounts registry to disk, creating parent dirs as needed.
pub fn save(path: &Path, accounts: &[Account]) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("creating parent dir {parent:?}"))?;
    }
    let raw = serde_json::to_string_pretty(accounts).context("serializing accounts")?;
    std::fs::write(path, raw).with_context(|| format!("writing accounts to {path:?}"))?;
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
