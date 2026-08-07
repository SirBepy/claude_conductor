//! Pre-spawn credential guard. `drift::check` only asks whether SOME
//! credentials exist; a failed refresh leaves the record in place with both
//! tokens blanked to `""` and `expiresAt` zeroed, so it passes drift and then
//! dies at the CLI instead. Observed 2026-08-07 on `~/.claude-personal`.

use super::model::Account;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum CredentialError {
    #[error("\"{label}\" has a blanked OAuth record at {config_dir} (a token refresh failed) - run /login inside it again")]
    Blanked { label: String, config_dir: String },
    #[error("\"{label}\" has an expired OAuth session at {config_dir} that cannot be refreshed - run /login inside it again")]
    Unrefreshable { label: String, config_dir: String },
}

/// The `claudeAiOauth` fields this guard reads. Absent keys and wrong-typed
/// values both land as `None`/empty, which the assessment treats as unusable.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct OauthRecord {
    pub access_token: String,
    pub expires_at: Option<i64>,
    pub refresh_token: String,
    pub refresh_token_expires_at: Option<i64>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Verdict {
    Usable,
    Blanked,
    Unrefreshable,
}

/// Pure verdict over an already-read record; `now_ms` is a unix-ms epoch. An
/// expired access token alone is fine (the CLI refreshes on demand); fatal is
/// having no way back. A missing `expiresAt` reads as never-expiring, so a
/// shape that stops carrying the key can't start blocking spawns.
pub fn assess(record: &OauthRecord, now_ms: i64) -> Verdict {
    if record.access_token.is_empty() {
        return Verdict::Blanked;
    }
    let access_expired = record.expires_at.is_some_and(|e| e <= now_ms);
    if !access_expired {
        return Verdict::Usable;
    }
    let refresh_dead = record.refresh_token.is_empty()
        || record.refresh_token_expires_at.is_some_and(|e| e <= now_ms);
    if refresh_dead {
        return Verdict::Unrefreshable;
    }
    Verdict::Usable
}

fn read_record(config_dir: &std::path::Path) -> Option<OauthRecord> {
    let raw = std::fs::read_to_string(config_dir.join(".credentials.json")).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let o = v.get("claudeAiOauth")?;
    let str_of = |k: &str| o.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
    Some(OauthRecord {
        access_token: str_of("accessToken"),
        expires_at: o.get("expiresAt").and_then(|x| x.as_i64()),
        refresh_token: str_of("refreshToken"),
        refresh_token_expires_at: o.get("refreshTokenExpiresAt").and_then(|x| x.as_i64()),
    })
}

/// Reads `<account.config_dir>/.credentials.json` and runs [`assess`]. A
/// missing/unparsable/`claudeAiOauth`-less file is not this guard's error -
/// `drift::check` runs first and already reports that as `NotLoggedIn`.
pub fn check(account: &Account, now_ms: i64) -> Result<(), CredentialError> {
    let Some(record) = read_record(&account.config_dir) else {
        return Ok(());
    };
    match assess(&record, now_ms) {
        Verdict::Usable => Ok(()),
        Verdict::Blanked => Err(CredentialError::Blanked {
            label: account.label.clone(),
            config_dir: account.config_dir.display().to_string(),
        }),
        Verdict::Unrefreshable => Err(CredentialError::Unrefreshable {
            label: account.label.clone(),
            config_dir: account.config_dir.display().to_string(),
        }),
    }
}

/// `check` against the current wall clock.
pub fn check_now(account: &Account) -> Result<(), CredentialError> {
    check(account, chrono::Utc::now().timestamp_millis())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    const NOW: i64 = 1_786_120_000_000;

    fn acct() -> Account {
        Account {
            id: "id-1".into(),
            label: "personal".into(),
            colour: "#fff".into(),
            icon: "user".into(),
            config_dir: PathBuf::from("C:/home/.claude-personal"),
            chrome_profile_dir: PathBuf::from("C:/appdata/chrome-profiles/id-1"),
            email: "joe@example.com".into(),
            org_uuid: "org-1".into(),
            subscription_tier: "claude_max".into(),
            created_at: "2026-07-08T00:00:00Z".into(),
            fleet_eligible: false,
        }
    }

    fn healthy() -> OauthRecord {
        OauthRecord {
            access_token: "sk-ant-oat01-x".into(),
            expires_at: Some(NOW + 8 * 3600 * 1000),
            refresh_token: "sk-ant-ort01-x".into(),
            refresh_token_expires_at: Some(NOW + 28 * 24 * 3600 * 1000),
        }
    }

    #[test]
    fn healthy_record_is_usable() {
        assert_eq!(assess(&healthy(), NOW), Verdict::Usable);
    }

    #[test]
    fn expired_access_token_with_live_refresh_token_is_usable() {
        let r = OauthRecord { expires_at: Some(NOW - 1), ..healthy() };
        assert_eq!(assess(&r, NOW), Verdict::Usable);
    }

    #[test]
    fn blanked_access_token_is_blanked() {
        // The exact shape a failed refresh leaves behind: both tokens emptied,
        // expiresAt zeroed, the metadata fields untouched.
        let r = OauthRecord {
            access_token: String::new(),
            expires_at: Some(0),
            refresh_token: String::new(),
            refresh_token_expires_at: Some(1_786_100_788_601),
        };
        assert_eq!(assess(&r, NOW), Verdict::Blanked);
    }

    #[test]
    fn expired_access_token_with_empty_refresh_token_is_unrefreshable() {
        let r = OauthRecord { expires_at: Some(NOW - 1), refresh_token: String::new(), ..healthy() };
        assert_eq!(assess(&r, NOW), Verdict::Unrefreshable);
    }

    #[test]
    fn expired_access_token_with_expired_refresh_token_is_unrefreshable() {
        let r = OauthRecord {
            expires_at: Some(NOW - 1),
            refresh_token_expires_at: Some(NOW - 1),
            ..healthy()
        };
        assert_eq!(assess(&r, NOW), Verdict::Unrefreshable);
    }

    #[test]
    fn expired_refresh_token_alone_does_not_block_a_live_access_token() {
        let r = OauthRecord { refresh_token_expires_at: Some(NOW - 1), ..healthy() };
        assert_eq!(assess(&r, NOW), Verdict::Usable);
    }

    #[test]
    fn missing_expiry_keys_are_treated_as_never_expiring() {
        let r = OauthRecord { expires_at: None, refresh_token_expires_at: None, ..healthy() };
        assert_eq!(assess(&r, NOW), Verdict::Usable);
    }

    #[test]
    fn check_passes_when_file_missing_or_unparsable_or_shapeless() {
        let dir = tempfile::tempdir().unwrap();
        let mut a = acct();
        a.config_dir = dir.path().to_path_buf();
        assert!(check(&a, NOW).is_ok());

        std::fs::write(dir.path().join(".credentials.json"), "{ not valid").unwrap();
        assert!(check(&a, NOW).is_ok());

        std::fs::write(dir.path().join(".credentials.json"), r#"{"mcpOAuth":{}}"#).unwrap();
        assert!(check(&a, NOW).is_ok());
    }

    #[test]
    fn check_reads_the_blanked_shape_from_disk() {
        let dir = tempfile::tempdir().unwrap();
        let mut a = acct();
        a.config_dir = dir.path().to_path_buf();

        std::fs::write(
            dir.path().join(".credentials.json"),
            r#"{"claudeAiOauth":{"accessToken":"","refreshToken":"","expiresAt":0,"refreshTokenExpiresAt":1786100788601,"subscriptionType":"max"}}"#,
        )
        .unwrap();
        assert!(matches!(check(&a, NOW).unwrap_err(), CredentialError::Blanked { .. }));

        std::fs::write(
            dir.path().join(".credentials.json"),
            r#"{"claudeAiOauth":{"accessToken":"sk-ant-oat01-x","refreshToken":"sk-ant-ort01-x","expiresAt":1786180000000,"refreshTokenExpiresAt":1788500000000}}"#,
        )
        .unwrap();
        assert!(check(&a, NOW).is_ok());
    }

    #[test]
    fn wrong_typed_values_do_not_panic_and_read_as_unusable() {
        let dir = tempfile::tempdir().unwrap();
        let mut a = acct();
        a.config_dir = dir.path().to_path_buf();
        std::fs::write(
            dir.path().join(".credentials.json"),
            r#"{"claudeAiOauth":{"accessToken":null,"refreshToken":42,"expiresAt":"soon"}}"#,
        )
        .unwrap();
        assert!(matches!(check(&a, NOW).unwrap_err(), CredentialError::Blanked { .. }));
    }
}
