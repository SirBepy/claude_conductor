//! Pre-spawn drift guard: refuses to spawn if a profile dir's CLI identity no
//! longer matches what the registry recorded at add-account time (someone ran
//! `/login` inside that dir since onboarding, silently rebinding it to a
//! different account). See `docs/multi-account/02-chat-routing.md` step 3b.

use super::identity::{self, OauthAccountInfo};
use super::model::Account;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum DriftError {
    #[error("\"{label}\" has no CLI credentials at {config_dir} - run /login inside it first")]
    NotLoggedIn { label: String, config_dir: String },
    #[error("\"{label}\" is now logged in as {actual_email} (registered as {expected_email}) - re-verify the account before chatting")]
    Mismatch {
        label: String,
        expected_email: String,
        actual_email: String,
    },
}

/// Compares the account's PROFILE DIR identity (what `/login` actually left
/// behind) against the REGISTRY record (what the wizard verified at
/// add-account time). Pure comparison logic over already-read disk state so
/// it is testable without touching disk.
///
/// A missing `oauthAccount` is NOT drift when valid credentials exist: the
/// CLI only writes that block during the live `/login` handshake, so both
/// cookie-identity accounts (browser-first wizard, 2026-07-08) and dirs whose
/// `/login` finished a moment ago legitimately run on credentials alone. The
/// credentials file is the real login artifact; `oauthAccount`, when present,
/// is only used to DETECT a re-login into a different account.
pub fn compare(
    account: &Account,
    current_identity: Option<&OauthAccountInfo>,
    has_credentials: bool,
) -> Result<(), DriftError> {
    let identity = match current_identity {
        Some(i) => i,
        None if has_credentials => return Ok(()),
        None => {
            return Err(DriftError::NotLoggedIn {
                label: account.label.clone(),
                config_dir: account.config_dir.display().to_string(),
            })
        }
    };
    let mismatch = identity.organization_uuid != account.org_uuid
        || !identity.email_address.eq_ignore_ascii_case(&account.email);
    if mismatch {
        return Err(DriftError::Mismatch {
            label: account.label.clone(),
            expected_email: account.email.clone(),
            actual_email: identity.email_address.clone(),
        });
    }
    Ok(())
}

/// Reads `<account.config_dir>/.claude.json` + `.credentials.json` and runs
/// [`compare`]. The disk-read / comparison split keeps `compare` a pure
/// unit-testable function.
pub fn check(account: &Account) -> Result<(), DriftError> {
    let identity = identity::read_oauth_account(&account.config_dir);
    let has_credentials = identity::read_token_expiry(&account.config_dir).is_some();
    compare(account, identity.as_ref(), has_credentials)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn acct() -> Account {
        Account {
            id: "id-1".into(),
            label: "Work".into(),
            colour: "#fff".into(),
            icon: "user".into(),
            config_dir: PathBuf::from("C:/home/.claude-work"),
            chrome_profile_dir: PathBuf::from("C:/appdata/chrome-profiles/id-1"),
            email: "work@example.com".into(),
            org_uuid: "org-work".into(),
            subscription_tier: "claude_max".into(),
            created_at: "2026-07-07T00:00:00Z".into(),
            fleet_eligible: false,
        }
    }

    fn identity(email: &str, org_uuid: &str) -> OauthAccountInfo {
        OauthAccountInfo {
            email_address: email.into(),
            organization_uuid: org_uuid.into(),
            organization_name: None,
            organization_type: None,
        }
    }

    #[test]
    fn matching_identity_passes() {
        let a = acct();
        let id = identity("work@example.com", "org-work");
        assert!(compare(&a, Some(&id), true).is_ok());
    }

    #[test]
    fn matching_identity_is_case_insensitive_on_email() {
        let a = acct();
        let id = identity("WORK@EXAMPLE.COM", "org-work");
        assert!(compare(&a, Some(&id), true).is_ok());
    }

    #[test]
    fn org_uuid_mismatch_is_drift() {
        let a = acct();
        let id = identity("work@example.com", "org-someone-else");
        let err = compare(&a, Some(&id), true).unwrap_err();
        assert!(matches!(err, DriftError::Mismatch { .. }));
    }

    #[test]
    fn email_mismatch_is_drift() {
        let a = acct();
        let id = identity("someone-else@example.com", "org-work");
        let err = compare(&a, Some(&id), true).unwrap_err();
        assert!(matches!(err, DriftError::Mismatch { .. }));
    }

    #[test]
    fn missing_everything_is_not_logged_in() {
        let a = acct();
        let err = compare(&a, None, false).unwrap_err();
        assert!(matches!(err, DriftError::NotLoggedIn { .. }));
    }

    #[test]
    fn missing_identity_with_credentials_is_not_drift() {
        // Cookie-identity accounts (browser-first wizard) and dirs whose
        // /login landed moments ago never/haven't-yet got `oauthAccount` -
        // valid credentials alone are a complete login (past incident:
        // 2026-07-08, freshly re-added "personal" flagged red).
        let a = acct();
        assert!(compare(&a, None, true).is_ok());
    }

    #[test]
    fn mismatched_identity_is_drift_even_with_credentials() {
        let a = acct();
        let id = identity("someone-else@example.com", "org-work");
        assert!(matches!(compare(&a, Some(&id), true).unwrap_err(), DriftError::Mismatch { .. }));
    }

    #[test]
    fn check_reads_from_config_dir_on_disk() {
        let dir = tempfile::tempdir().unwrap();
        let mut a = acct();
        a.config_dir = dir.path().to_path_buf();
        // Empty dir -> no credentials, no identity -> not logged in.
        assert!(matches!(check(&a).unwrap_err(), DriftError::NotLoggedIn { .. }));

        // Credentials alone (no oauthAccount) -> complete login, no drift.
        std::fs::write(
            dir.path().join(".credentials.json"),
            r#"{"claudeAiOauth":{"accessToken":"sk-ant-oat01-x","refreshToken":"sk-ant-ort01-x","expiresAt":1783437706982,"scopes":[]}}"#,
        )
        .unwrap();
        assert!(check(&a).is_ok());

        // A matching oauthAccount stays fine; a mismatched one is drift.
        std::fs::write(
            dir.path().join(".claude.json"),
            r#"{"oauthAccount": {"emailAddress": "work@example.com", "organizationUuid": "org-work"}}"#,
        )
        .unwrap();
        assert!(check(&a).is_ok());
        std::fs::write(
            dir.path().join(".claude.json"),
            r#"{"oauthAccount": {"emailAddress": "other@example.com", "organizationUuid": "org-other"}}"#,
        )
        .unwrap();
        assert!(matches!(check(&a).unwrap_err(), DriftError::Mismatch { .. }));
    }
}
