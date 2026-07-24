//! Reads the `oauthAccount` identity block Claude Code writes after a
//! successful `/login`. Two readers:
//! - `read_oauth_account(config_dir)` - `<config_dir>/.claude.json` (an app
//!   profile dir's own identity).
//! - `terminal_identity(home_dir)` - `<home_dir>/.claude.json`, the terminal's
//!   observed identity (NOT inside `~/.claude`; see 00-overview.md).

use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct OauthAccountInfo {
    pub email_address: String,
    pub organization_uuid: String,
    #[serde(default)]
    pub organization_name: Option<String>,
    #[serde(default)]
    pub organization_type: Option<String>,
}

fn read_from_state_file(path: &Path) -> Option<OauthAccountInfo> {
    let raw = std::fs::read_to_string(path).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let oauth = v.get("oauthAccount")?;
    serde_json::from_value(oauth.clone()).ok()
}

/// Parses `<config_dir>/.claude.json` -> `oauthAccount`. `None` if the file is
/// missing, unparsable, or has no `oauthAccount` block (never logged in yet,
/// or an API-key-only session that never populates it).
pub fn read_oauth_account(config_dir: &Path) -> Option<OauthAccountInfo> {
    read_from_state_file(&config_dir.join(".claude.json"))
}

/// The terminal's observed identity: `<home_dir>/.claude.json` -> `oauthAccount`.
/// This is NOT an app account (never spawnable, never removable, never in the
/// registry) - purely for labeling terminal sessions and the read-only
/// "Terminal: currently X" display. `home_dir` is a parameter (not
/// `dirs::home_dir()`) so tests and callers can inject it.
pub fn terminal_identity(home_dir: &Path) -> Option<OauthAccountInfo> {
    read_from_state_file(&home_dir.join(".claude.json"))
}

/// Reads `<config_dir>/.credentials.json` -> `claudeAiOauth.expiresAt`
/// (unix-ms epoch), for the read-only "token expiry" line on the Settings >
/// Accounts identity surface (multi-account milestone 07). The app never
/// writes this file (locked decision, 00-overview.md) - display-only. `None`
/// when the file is missing, unparsable, or has no `claudeAiOauth.expiresAt`
/// (never logged in yet, or a shape Claude Code hasn't written this key for).
pub fn read_token_expiry(config_dir: &Path) -> Option<i64> {
    let raw = std::fs::read_to_string(config_dir.join(".credentials.json")).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    v.get("claudeAiOauth")?.get("expiresAt")?.as_i64()
}

/// Reads `<config_dir>/.credentials.json` -> `claudeAiOauth.accessToken`, the
/// live OAuth access token used to authenticate the `/v1/models` and
/// `/v1/messages/count_tokens` calls in `ipc/models.rs` (consolidated here
/// per ai_todo 275 - was a second, duplicate `.credentials.json` parser
/// living in `ipc/models.rs`). The app never writes this file (locked
/// decision, 00-overview.md) - read-only, mirrors `read_token_expiry`. `None`
/// when the file is missing, unparsable, or has no
/// `claudeAiOauth.accessToken`.
pub fn read_access_token(config_dir: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(config_dir.join(".credentials.json")).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    v.get("claudeAiOauth")?
        .get("accessToken")?
        .as_str()
        .map(String::from)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    const FIXTURE: &str = r#"{
        "oauthAccount": {
            "emailAddress": "joe@example.com",
            "organizationUuid": "org-abc",
            "organizationName": "Fibo Studio",
            "organizationType": "claude_max"
        }
    }"#;

    #[test]
    fn read_oauth_account_parses_fixture() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join(".claude.json"), FIXTURE).unwrap();
        let identity = read_oauth_account(dir.path()).expect("expected identity");
        assert_eq!(identity.email_address, "joe@example.com");
        assert_eq!(identity.organization_uuid, "org-abc");
        assert_eq!(identity.organization_name.as_deref(), Some("Fibo Studio"));
        assert_eq!(identity.organization_type.as_deref(), Some("claude_max"));
    }

    #[test]
    fn read_oauth_account_none_when_file_missing() {
        let dir = tempdir().unwrap();
        assert!(read_oauth_account(dir.path()).is_none());
    }

    #[test]
    fn read_oauth_account_none_when_no_oauth_block() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join(".claude.json"), r#"{"other": true}"#).unwrap();
        assert!(read_oauth_account(dir.path()).is_none());
    }

    #[test]
    fn read_oauth_account_none_when_unparsable() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join(".claude.json"), "{ not valid").unwrap();
        assert!(read_oauth_account(dir.path()).is_none());
    }

    #[test]
    fn read_oauth_account_missing_optional_fields_default_to_none() {
        let dir = tempdir().unwrap();
        let raw = r#"{
            "oauthAccount": {
                "emailAddress": "a@x.com",
                "organizationUuid": "org-1"
            }
        }"#;
        std::fs::write(dir.path().join(".claude.json"), raw).unwrap();
        let identity = read_oauth_account(dir.path()).unwrap();
        assert_eq!(identity.organization_name, None);
        assert_eq!(identity.organization_type, None);
    }

    #[test]
    fn read_token_expiry_parses_fixture() {
        let dir = tempdir().unwrap();
        std::fs::write(
            dir.path().join(".credentials.json"),
            r#"{"claudeAiOauth":{"accessToken":"sk-ant-oat01-x","refreshToken":"sk-ant-ort01-x","expiresAt":1783437706982,"scopes":[]}}"#,
        ).unwrap();
        assert_eq!(read_token_expiry(dir.path()), Some(1783437706982));
    }

    #[test]
    fn read_token_expiry_none_when_file_missing() {
        let dir = tempdir().unwrap();
        assert_eq!(read_token_expiry(dir.path()), None);
    }

    #[test]
    fn read_token_expiry_none_when_no_claude_ai_oauth_block() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join(".credentials.json"), r#"{"other": true}"#).unwrap();
        assert_eq!(read_token_expiry(dir.path()), None);
    }

    #[test]
    fn read_token_expiry_none_when_unparsable() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join(".credentials.json"), "{ not valid").unwrap();
        assert_eq!(read_token_expiry(dir.path()), None);
    }

    #[test]
    fn read_access_token_parses_fixture() {
        let dir = tempdir().unwrap();
        std::fs::write(
            dir.path().join(".credentials.json"),
            r#"{"claudeAiOauth":{"accessToken":"sk-ant-oat01-x","refreshToken":"sk-ant-ort01-x","expiresAt":1783437706982,"scopes":[]}}"#,
        ).unwrap();
        assert_eq!(read_access_token(dir.path()).as_deref(), Some("sk-ant-oat01-x"));
    }

    #[test]
    fn read_access_token_none_when_file_missing() {
        let dir = tempdir().unwrap();
        assert_eq!(read_access_token(dir.path()), None);
    }

    #[test]
    fn read_access_token_none_when_no_claude_ai_oauth_block() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join(".credentials.json"), r#"{"other": true}"#).unwrap();
        assert_eq!(read_access_token(dir.path()), None);
    }

    #[test]
    fn read_access_token_none_when_unparsable() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join(".credentials.json"), "{ not valid").unwrap();
        assert_eq!(read_access_token(dir.path()), None);
    }

    #[test]
    fn terminal_identity_reads_home_dir_file_not_dot_claude_subdir() {
        let dir = tempdir().unwrap();
        // Deliberately put a DIFFERENT identity inside .claude/ to prove the
        // terminal reader looks at home_dir directly, not home_dir/.claude.
        std::fs::create_dir_all(dir.path().join(".claude")).unwrap();
        std::fs::write(dir.path().join(".claude").join(".claude.json"), r#"{
            "oauthAccount": { "emailAddress": "wrong@x.com", "organizationUuid": "org-wrong" }
        }"#).unwrap();
        std::fs::write(dir.path().join(".claude.json"), FIXTURE).unwrap();
        let identity = terminal_identity(dir.path()).expect("expected identity");
        assert_eq!(identity.email_address, "joe@example.com");
    }
}
