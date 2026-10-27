//! `AccountKind::ApiCredit` accounts: a chat that bills the Max plan's monthly
//! API credit through an `ANTHROPIC_API_KEY` instead of the subscription's
//! OAuth login. The profile dir comes from the same factory as every account
//! (junctions back to `~/.claude`) but never gets a `.credentials.json`, so the
//! key is the only way a chat on it can authenticate.
//!
//! Secrets live beside the sessionKey: DPAPI-wrapped files in the data dir,
//! read and written through `auth::session` (a generic wrapped-text file
//! store despite the name).

use super::model::{slugify, Account, AccountKind};
use super::{profile, store};
use crate::settings::paths;
use anyhow::{anyhow, bail, Context, Result};
use std::path::{Path, PathBuf};

/// Where an ApiCredit account's files go. Injected so tests can aim the whole
/// creation at a temp tree; production resolves it from `settings::paths`.
pub struct ApiCreditPaths {
    pub home_claude_dir: PathBuf,
    pub accounts_file: PathBuf,
    pub api_key_file: PathBuf,
    pub chrome_profile_dir: PathBuf,
}

/// Creates and persists an ApiCredit account: profile dir (no OAuth
/// credentials), DPAPI-wrapped API key, registry entry. `console_org_uuid` is
/// the Console org (the `/api/account` membership with capability `api`);
/// `email` is the linked Console account's email, or "" when unknown.
pub fn create_api_credit_account(
    label: &str,
    api_key: &str,
    console_org_uuid: &str,
    email: &str,
) -> Result<Account> {
    let id = uuid::Uuid::new_v4().to_string();
    let home = dirs::home_dir().ok_or_else(|| anyhow!("could not resolve home dir"))?;
    let account_paths = ApiCreditPaths {
        home_claude_dir: home.join(".claude"),
        accounts_file: paths::accounts_file()?,
        api_key_file: paths::account_api_key_file(&id)?,
        chrome_profile_dir: paths::account_chrome_profile_dir(&id)?,
    };
    create_api_credit_account_in(&account_paths, &id, label, api_key, console_org_uuid, email)
}

pub fn create_api_credit_account_in(
    p: &ApiCreditPaths,
    id: &str,
    label: &str,
    api_key: &str,
    console_org_uuid: &str,
    email: &str,
) -> Result<Account> {
    let api_key = api_key.trim();
    if api_key.is_empty() {
        bail!("the API key must not be empty");
    }
    let mut accounts = store::load(&p.accounts_file);
    let config_dir = unique_config_dir(&p.home_claude_dir, &slugify(label), &accounts);
    // Only ever a brand-new dir: adopting an existing one could carry an OAuth
    // login that would make the account silently bill the subscription.
    let slug = config_dir
        .file_name()
        .and_then(|n| n.to_str())
        .and_then(|n| n.strip_prefix(".claude-"))
        .ok_or_else(|| anyhow!("unexpected profile dir {config_dir:?}"))?
        .to_string();
    let outcome = profile::create_or_adopt_profile_dir(&p.home_claude_dir, &slug)
        .map_err(|e| anyhow!("creating the profile folder: {e}"))?;
    // A dir that appeared after `unique_config_dir`'s check was adopted, not
    // created. Bail without touching it: the abort path below deletes the dir.
    require_new_dir(&outcome)?;

    let account = Account {
        id: id.to_string(),
        label: label.trim().to_string(),
        colour: "#d97706".to_string(),
        icon: "key".to_string(),
        config_dir: outcome.config_dir.clone(),
        chrome_profile_dir: p.chrome_profile_dir.clone(),
        email: email.trim().to_string(),
        org_uuid: console_org_uuid.trim().to_string(),
        subscription_tier: String::new(),
        created_at: chrono::Utc::now().to_rfc3339(),
        fleet_eligible: false,
        kind: AccountKind::ApiCredit,
    };

    // Abort-clean: a failure after the dir exists must not leave the dir or a
    // stray key file behind, mirroring `create_or_adopt_profile_dir`.
    let mut persist = || -> Result<()> {
        crate::auth::session::save(&p.api_key_file, api_key)
            .with_context(|| format!("storing the API key at {:?}", p.api_key_file))?;
        accounts.push(account.clone());
        store::save(&p.accounts_file, &accounts)
    };
    if let Err(e) = persist() {
        let _ = profile::delete_profile_dir(&outcome.config_dir);
        let _ = crate::auth::session::clear(&p.api_key_file);
        return Err(e);
    }
    Ok(account)
}

/// Refuses an adopted dir. Never deletes anything: it belongs to someone else.
fn require_new_dir(outcome: &profile::ProfileDirOutcome) -> Result<()> {
    if !outcome.created_new {
        bail!("the profile folder {:?} already exists, refusing to adopt it", outcome.config_dir);
    }
    Ok(())
}

/// First `~/.claude-<slug>[-N]` that is neither on disk nor already registered.
fn unique_config_dir(home_claude_dir: &Path, slug: &str, accounts: &[Account]) -> PathBuf {
    let mut n = 1u32;
    loop {
        let candidate = if n == 1 { slug.to_string() } else { format!("{slug}-{n}") };
        let dir = profile::config_dir_for_slug(home_claude_dir, &candidate);
        if !dir.exists() && !accounts.iter().any(|a| a.config_dir == dir) {
            return dir;
        }
        n += 1;
    }
}

pub const ANTHROPIC_API_BASE_URL: &str = "https://api.anthropic.com";

/// Proves `api_key` works and is workspace-scoped, for free: `GET /v1/models`
/// bills nothing. A key with no workspace answers 400 naming the
/// `anthropic-workspace-id` header (observed live 2026-10-26), and such a key
/// cannot bill the Max credit. The `Err` text is shown to the user as is.
pub async fn validate_api_key(base_url: &str, api_key: &str) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("could not check the API key: {e}"))?;
    let resp = client
        .get(format!("{base_url}/v1/models"))
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .send()
        .await
        .map_err(|e| format!("could not reach Anthropic to check the API key: {e}"))?;
    let status = resp.status();
    if status.is_success() {
        return Ok(());
    }
    if matches!(status.as_u16(), 401 | 403) {
        return Err("That API key was rejected".to_string());
    }
    let body = resp.text().await.unwrap_or_default();
    if status.as_u16() == 400 && body.contains("anthropic-workspace-id") {
        return Err("This key isn't scoped to a workspace. Create a key inside a workspace (Default is fine) in the Console.".to_string());
    }
    Err(format!("Anthropic answered HTTP {} when checking the API key", status.as_u16()))
}

/// The subscription account whose stored claude.ai login is asked for the
/// Console org: the default account when it is a Subscription one, else the
/// first Subscription account.
pub fn pick_lookup_account<'a>(accounts: &'a [Account], default_id: Option<&str>) -> Option<&'a Account> {
    let subscription = |a: &&Account| a.kind == AccountKind::Subscription;
    default_id
        .and_then(|id| accounts.iter().find(|a| a.id == id))
        .filter(subscription)
        .or_else(|| accounts.iter().find(subscription))
}

/// Fills the Console org uuid (and the email) of an existing account that was
/// created without them. Only empty fields are written, so a later lookup can
/// never overwrite what the user or an earlier login settled on. Returns whether
/// anything changed.
pub fn fill_missing_identity(accounts_file: &Path, account_id: &str, org_uuid: &str, email: &str) -> Result<bool> {
    let mut accounts = store::load(accounts_file);
    let account = accounts
        .iter_mut()
        .find(|a| a.id == account_id)
        .ok_or_else(|| anyhow!("no account with id {account_id}"))?;
    let mut changed = false;
    if account.org_uuid.is_empty() && !org_uuid.trim().is_empty() {
        account.org_uuid = org_uuid.trim().to_string();
        changed = true;
    }
    if account.email.is_empty() && !email.trim().is_empty() {
        account.email = email.trim().to_string();
        changed = true;
    }
    if changed {
        store::save(accounts_file, &accounts)?;
    }
    Ok(changed)
}

/// Replaces the stored API key for `account_id`.
pub fn save_api_key(account_id: &str, api_key: &str) -> Result<()> {
    let api_key = api_key.trim();
    if api_key.is_empty() {
        bail!("the API key must not be empty");
    }
    crate::auth::session::save(&paths::account_api_key_file(account_id)?, api_key)
}

/// The decrypted API key, or `None` when the file is missing, empty or
/// undecryptable (the wrapped blob is set aside by `auth::session::load`).
pub fn load_api_key(account_id: &str) -> Option<String> {
    let path = paths::account_api_key_file(account_id).ok()?;
    crate::auth::session::load(&path)
}

/// Replaces the stored Console `sessionKey` (platform.claude.com) for
/// `account_id`. Distinct from the claude.ai cookie: the Console org rejects
/// that one with 403.
pub fn save_console_session(account_id: &str, session_key: &str) -> Result<()> {
    let session_key = session_key.trim();
    if session_key.is_empty() {
        bail!("the Console session key must not be empty");
    }
    crate::auth::session::save(&paths::account_console_session_file(account_id)?, session_key)
}

/// The decrypted Console `sessionKey`, or `None` when none is stored or it
/// cannot be decrypted.
pub fn load_console_session(account_id: &str) -> Option<String> {
    let path = paths::account_console_session_file(account_id).ok()?;
    crate::auth::session::load(&path)
}

/// Deletes the secrets only an ApiCredit account has (API key and Console
/// sessionKey). Missing files are fine. Account removal calls this next to the
/// claude.ai sessionKey clear.
pub fn clear_api_credit_secrets(account_id: &str) {
    for path in [paths::account_api_key_file(account_id), paths::account_console_session_file(account_id)] {
        if let Ok(path) = path {
            let _ = crate::auth::session::clear(&path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts::profile::{JUNCTION_DIRS, SYMLINK_FILES};
    use tempfile::tempdir;

    fn setup() -> (tempfile::TempDir, ApiCreditPaths) {
        let root = tempdir().unwrap();
        let home_claude = root.path().join(".claude");
        std::fs::create_dir_all(&home_claude).unwrap();
        let data = root.path().join("data");
        std::fs::create_dir_all(&data).unwrap();
        let p = ApiCreditPaths {
            home_claude_dir: home_claude,
            accounts_file: data.join("accounts.json"),
            api_key_file: data.join("apikey-id-1.txt"),
            chrome_profile_dir: data.join("chrome-profiles").join("id-1"),
        };
        (root, p)
    }

    fn acct(id: &str, kind: AccountKind) -> Account {
        Account {
            id: id.into(),
            label: id.into(),
            colour: "#fff".into(),
            icon: "key".into(),
            config_dir: PathBuf::from(format!("C:/home/.claude-{id}")),
            chrome_profile_dir: PathBuf::from(format!("C:/appdata/{id}")),
            email: String::new(),
            org_uuid: String::new(),
            subscription_tier: String::new(),
            created_at: "2026-10-26T00:00:00Z".into(),
            fleet_eligible: false,
            kind,
        }
    }

    #[test]
    fn fill_missing_identity_writes_only_empty_fields() {
        let (_root, p) = setup();
        let a = create_api_credit_account_in(&p, "id-1", "API credit", "k", "", "").unwrap();
        assert!(fill_missing_identity(&p.accounts_file, &a.id, "ORG", "j@x.com").unwrap());
        let got = store::load(&p.accounts_file).remove(0);
        assert_eq!((got.org_uuid.as_str(), got.email.as_str()), ("ORG", "j@x.com"));
        assert!(!fill_missing_identity(&p.accounts_file, &a.id, "OTHER", "o@x.com").unwrap());
        let got = store::load(&p.accounts_file).remove(0);
        assert_eq!((got.org_uuid.as_str(), got.email.as_str()), ("ORG", "j@x.com"));
        assert!(fill_missing_identity(&p.accounts_file, "missing", "ORG", "").is_err());
    }

    #[test]
    fn lookup_account_is_the_default_subscription_else_the_first_subscription() {
        let accounts = vec![
            acct("api", AccountKind::ApiCredit),
            acct("sub-1", AccountKind::Subscription),
            acct("sub-2", AccountKind::Subscription),
        ];
        assert_eq!(pick_lookup_account(&accounts, Some("sub-2")).unwrap().id, "sub-2");
        assert_eq!(pick_lookup_account(&accounts, Some("api")).unwrap().id, "sub-1", "an ApiCredit default has no claude.ai login");
        assert_eq!(pick_lookup_account(&accounts, None).unwrap().id, "sub-1");
        assert!(pick_lookup_account(&accounts[..1], None).is_none());
    }

    #[tokio::test]
    async fn a_working_key_validates_and_sends_the_key_and_version_headers() {
        let mut server = mockito::Server::new_async().await;
        let m = server.mock("GET", "/v1/models")
            .match_header("x-api-key", "sk-ant-dummy-good")
            .match_header("anthropic-version", "2023-06-01")
            .with_status(200).with_body(r#"{"data":[]}"#)
            .create_async().await;
        assert_eq!(validate_api_key(&server.url(), "sk-ant-dummy-good").await, Ok(()));
        m.assert_async().await;
    }

    #[tokio::test]
    async fn a_rejected_key_says_so() {
        let mut server = mockito::Server::new_async().await;
        let _m = server.mock("GET", "/v1/models").with_status(401).create_async().await;
        assert_eq!(
            validate_api_key(&server.url(), "sk-ant-dummy-bad").await,
            Err("That API key was rejected".to_string())
        );
    }

    #[tokio::test]
    async fn a_key_without_a_workspace_is_told_to_make_one() {
        let mut server = mockito::Server::new_async().await;
        let _m = server.mock("GET", "/v1/models")
            .with_status(400)
            .with_body(r#"{"error":{"message":"must include the anthropic-workspace-id header"}}"#)
            .create_async().await;
        let err = validate_api_key(&server.url(), "sk-ant-dummy-nows").await.unwrap_err();
        assert!(err.starts_with("This key isn't scoped to a workspace."), "{err}");
    }

    #[tokio::test]
    async fn a_network_failure_refuses_with_the_error_text() {
        let err = validate_api_key("http://127.0.0.1:1", "sk-ant-dummy-x").await.unwrap_err();
        assert!(err.starts_with("could not reach Anthropic"), "{err}");
    }

    #[test]
    fn creates_profile_without_credentials_stores_key_and_registers() {
        let (_root, p) = setup();
        let a = create_api_credit_account_in(&p, "id-1", "API credit", "  sk-ant-test  ", "org-console", "j@x.com").unwrap();

        assert_eq!(a.kind, AccountKind::ApiCredit);
        assert_eq!(a.org_uuid, "org-console");
        assert_eq!(a.email, "j@x.com");
        assert!(a.config_dir.ends_with(".claude-api-credit"));
        assert!(!a.config_dir.join(".credentials.json").exists(), "no OAuth login in an ApiCredit profile");
        for name in JUNCTION_DIRS.iter().chain(SYMLINK_FILES.iter()) {
            assert!(
                std::fs::symlink_metadata(a.config_dir.join(name)).unwrap().file_type().is_symlink(),
                "{name} should link back to ~/.claude"
            );
        }
        assert_eq!(crate::auth::session::load(&p.api_key_file).as_deref(), Some("sk-ant-test"));
        let reg = store::load(&p.accounts_file);
        assert_eq!(reg, vec![a]);
    }

    #[test]
    fn a_second_account_with_the_same_label_gets_its_own_dir() {
        let (_root, p) = setup();
        let first = create_api_credit_account_in(&p, "id-1", "API credit", "k1", "org", "").unwrap();
        let second = create_api_credit_account_in(&p, "id-2", "API credit", "k2", "org", "").unwrap();
        assert_ne!(first.config_dir, second.config_dir);
        assert!(second.config_dir.ends_with(".claude-api-credit-2"));
        assert_eq!(store::load(&p.accounts_file).len(), 2);
    }

    /// The race `unique_config_dir` cannot close: the dir shows up between path
    /// selection and creation, so creation adopts it.
    #[test]
    fn an_adopted_dir_is_refused_and_left_on_disk() {
        let (_root, p) = setup();
        let existing = profile::config_dir_for_slug(&p.home_claude_dir, "api-credit");
        std::fs::create_dir_all(&existing).unwrap();
        let outcome = profile::create_or_adopt_profile_dir(&p.home_claude_dir, "api-credit").unwrap();
        assert!(!outcome.created_new);
        assert!(require_new_dir(&outcome).is_err());
        assert!(existing.exists());
    }

    #[test]
    fn empty_key_is_refused_before_anything_is_created() {
        let (_root, p) = setup();
        assert!(create_api_credit_account_in(&p, "id-1", "API credit", "   ", "org", "").is_err());
        assert!(!profile::config_dir_for_slug(&p.home_claude_dir, "api-credit").exists());
        assert!(store::load(&p.accounts_file).is_empty());
    }

    #[test]
    fn a_failed_registry_write_leaves_no_dir_or_key_behind() {
        let (_root, mut p) = setup();
        // A directory where accounts.json should be makes the atomic save fail.
        p.accounts_file = p.accounts_file.parent().unwrap().join("blocked");
        std::fs::create_dir_all(p.accounts_file.join("x")).unwrap();
        let err = create_api_credit_account_in(&p, "id-1", "API credit", "sk-ant-test", "org", "");
        assert!(err.is_err());
        assert!(!profile::config_dir_for_slug(&p.home_claude_dir, "api-credit").exists());
        assert!(!p.api_key_file.exists());
    }
}
