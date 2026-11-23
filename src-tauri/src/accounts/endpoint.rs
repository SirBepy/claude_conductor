//! `AccountKind::Endpoint` accounts: the `claude` CLI pointed at a third-party
//! Anthropic-compatible endpoint (Kimi Code, DeepSeek, OpenRouter, a custom
//! URL) with that provider's key. Read docs/architecture/providers.md first.
//!
//! The profile dir comes from the same factory as every account (junctions back
//! to `~/.claude`) and never gets a `.credentials.json`. The key is stored the
//! way an API-credit key is: a DPAPI-wrapped `apikey-<id>.txt` in the data dir,
//! read and written through `api_credit::{save_api_key, load_api_key}`. It is
//! never in `accounts.json` and never in a log.

use super::api_credit::{require_new_dir, unique_config_dir, ApiCreditPaths};
use super::model::{is_valid_endpoint_model, slugify, Account, AccountKind, EndpointAuth, EndpointConfig, EndpointPreset};
use super::{profile, store};
use crate::settings::paths;
use anyhow::{anyhow, bail, Context, Result};
use std::path::Path;

/// The Settings form's message for a key the CLI could not carry as an env var.
/// A newline or other control character would split or truncate the value, so
/// it is refused instead of trimmed.
pub fn check_key(api_key: &str) -> Result<String, String> {
    let key = api_key.trim();
    if key.is_empty() {
        return Err("Paste the API key".to_string());
    }
    if key.chars().any(char::is_control) {
        return Err("That key contains a line break or control character".to_string());
    }
    Ok(key.to_string())
}

/// A base URL the CLI can send requests to: `https`, or plain `http` for a
/// loopback host (a local gateway or test endpoint). No credentials in the URL
/// (they would land in the process list and logs), no query or fragment.
pub fn check_base_url(raw: &str) -> Result<String, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err("Enter the endpoint's base URL".to_string());
    }
    let url = url::Url::parse(raw).map_err(|_| "That base URL is not a valid URL".to_string())?;
    let loopback = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    match url.scheme() {
        "https" => {}
        "http" if loopback => {}
        _ => return Err("The base URL must start with https:// (http:// is only allowed for localhost)".to_string()),
    }
    if url.host_str().is_none() {
        return Err("That base URL has no host".to_string());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Leave the key out of the base URL: it goes in the key field".to_string());
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err("The base URL must not carry a query or fragment".to_string());
    }
    Ok(raw.to_string())
}

/// Trimmed, de-duplicated model ids, or the first one that fails the safe charset.
pub fn check_models(models: &[String]) -> Result<Vec<String>, String> {
    let mut out: Vec<String> = Vec::new();
    for m in models.iter().map(|m| m.trim()).filter(|m| !m.is_empty()) {
        if !is_valid_endpoint_model(m) {
            return Err(format!("\"{m}\" is not a usable model id (letters, digits and . _ : / ~ [ ] - only, up to 128, not starting with -)"));
        }
        if !out.iter().any(|x| x == m) {
            out.push(m.to_string());
        }
    }
    Ok(out)
}

/// A whole [`EndpointConfig`] checked for the Settings form.
pub fn check_config(preset: EndpointPreset, base_url: &str, auth_style: EndpointAuth, models: &[String]) -> Result<EndpointConfig, String> {
    Ok(EndpointConfig { preset, base_url: check_base_url(base_url)?, auth_style, models: check_models(models)? })
}

/// Creates and persists an Endpoint account: profile dir (no OAuth
/// credentials), DPAPI-wrapped key, registry entry.
pub fn create_endpoint_account(label: &str, config: EndpointConfig, api_key: &str) -> Result<Account> {
    let id = uuid::Uuid::new_v4().to_string();
    let home = dirs::home_dir().ok_or_else(|| anyhow!("could not resolve home dir"))?;
    let account_paths = ApiCreditPaths {
        home_claude_dir: home.join(".claude"),
        accounts_file: paths::accounts_file()?,
        api_key_file: paths::account_api_key_file(&id)?,
        chrome_profile_dir: paths::account_chrome_profile_dir(&id)?,
    };
    create_endpoint_account_in(&account_paths, &id, label, config, api_key)
}

pub fn create_endpoint_account_in(
    p: &ApiCreditPaths,
    id: &str,
    label: &str,
    config: EndpointConfig,
    api_key: &str,
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
    require_new_dir(&outcome)?;

    let account = Account {
        id: id.to_string(),
        label: label.trim().to_string(),
        colour: "#0ea5e9".to_string(),
        icon: "plug".to_string(),
        config_dir: outcome.config_dir.clone(),
        chrome_profile_dir: p.chrome_profile_dir.clone(),
        // Identity strings stay required but meaningless here: no claude.ai
        // login or Console org exists for this kind.
        email: String::new(),
        org_uuid: String::new(),
        subscription_tier: String::new(),
        created_at: chrono::Utc::now().to_rfc3339(),
        fleet_eligible: false,
        kind: AccountKind::Endpoint,
        endpoint: Some(config),
    };

    // Abort-clean: a failure after the dir exists must not leave the dir or a
    // stray key file behind.
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

/// The fields an edit may change; `None` leaves a field as it is. The key is
/// replaced separately (`api_credit::save_api_key`).
#[derive(Default)]
pub struct EndpointUpdate {
    pub label: Option<String>,
    pub preset: Option<EndpointPreset>,
    pub base_url: Option<String>,
    pub auth_style: Option<EndpointAuth>,
    pub models: Option<Vec<String>>,
}

/// Applies `update` to the Endpoint account `account_id` in `accounts_file` and
/// returns it. Refuses any other kind: a Subscription account must never gain an
/// endpoint. Every value is checked before anything is written.
pub fn update_endpoint_account_in(accounts_file: &Path, account_id: &str, update: EndpointUpdate) -> Result<Account, String> {
    let mut accounts = store::load(accounts_file);
    let account = accounts
        .iter_mut()
        .find(|a| a.id == account_id)
        .ok_or_else(|| format!("no account with id {account_id}"))?;
    if !account.is_endpoint() {
        return Err("Only an endpoint account has these settings".to_string());
    }
    let mut config = account.endpoint.clone().unwrap_or_default();
    if let Some(label) = update.label {
        if label.trim().is_empty() {
            return Err("Give the account a label".to_string());
        }
        account.label = label.trim().to_string();
    }
    if let Some(preset) = update.preset {
        config.preset = preset;
    }
    if let Some(url) = update.base_url {
        config.base_url = check_base_url(&url)?;
    }
    if let Some(auth) = update.auth_style {
        config.auth_style = auth;
    }
    if let Some(models) = update.models {
        config.models = check_models(&models)?;
    }
    account.endpoint = Some(config);
    let updated = account.clone();
    store::save(accounts_file, &accounts).map_err(|e| format!("{e:#}"))?;
    Ok(updated)
}

/// A key can only be replaced on an Endpoint account that exists:
/// `save_api_key` writes whatever id it is given, so without this a stray id
/// would leave an orphan key file and a Subscription account could gain one.
pub fn require_endpoint_account(accounts: &[Account], account_id: &str) -> Result<(), String> {
    match accounts.iter().find(|a| a.id == account_id) {
        None => Err(format!("no account with id {account_id}")),
        Some(a) if !a.is_endpoint() => Err("Only an endpoint account has an endpoint key".to_string()),
        Some(_) => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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
            api_key_file: data.join("apikey-e1.txt"),
            chrome_profile_dir: data.join("chrome-profiles").join("e1"),
        };
        (root, p)
    }

    fn cfg() -> EndpointConfig {
        EndpointConfig {
            preset: EndpointPreset::Deepseek,
            base_url: "https://api.deepseek.com/anthropic".into(),
            auth_style: EndpointAuth::XApiKey,
            models: vec!["deepseek-v4-pro".into()],
        }
    }

    #[test]
    fn creating_stores_the_key_outside_accounts_json_and_registers_the_endpoint() {
        let (_root, p) = setup();
        let a = create_endpoint_account_in(&p, "e1", "DeepSeek", cfg(), "  sk-ds-secret  ").unwrap();
        assert_eq!(a.kind, AccountKind::Endpoint);
        assert_eq!(a.endpoint, Some(cfg()));
        assert!(!a.config_dir.join(".credentials.json").exists());
        assert_eq!(crate::auth::session::load(&p.api_key_file).as_deref(), Some("sk-ds-secret"));
        let raw = std::fs::read_to_string(&p.accounts_file).unwrap();
        assert!(!raw.contains("sk-ds-secret"), "the key must never reach accounts.json");
        assert_eq!(store::load(&p.accounts_file), vec![a]);
    }

    #[test]
    fn an_empty_key_is_refused_before_anything_is_created() {
        let (_root, p) = setup();
        assert!(create_endpoint_account_in(&p, "e1", "DeepSeek", cfg(), "  ").is_err());
        assert!(!profile::config_dir_for_slug(&p.home_claude_dir, "deepseek").exists());
        assert!(store::load(&p.accounts_file).is_empty());
    }

    #[test]
    fn a_failed_registry_write_leaves_no_dir_or_key_behind() {
        let (_root, mut p) = setup();
        p.accounts_file = p.accounts_file.parent().unwrap().join("blocked");
        std::fs::create_dir_all(p.accounts_file.join("x")).unwrap();
        assert!(create_endpoint_account_in(&p, "e1", "DeepSeek", cfg(), "sk-x").is_err());
        assert!(!profile::config_dir_for_slug(&p.home_claude_dir, "deepseek").exists());
        assert!(!p.api_key_file.exists());
    }

    #[test]
    fn editing_changes_the_listed_fields_only_and_never_the_key() {
        let (_root, p) = setup();
        let a = create_endpoint_account_in(&p, "e1", "DeepSeek", cfg(), "sk-keep").unwrap();
        let got = update_endpoint_account_in(
            &p.accounts_file,
            "e1",
            EndpointUpdate {
                label: Some(" DS prod ".into()),
                base_url: Some("https://example.test/anthropic".into()),
                auth_style: Some(EndpointAuth::Bearer),
                models: Some(vec!["a".into(), " a ".into(), "b".into()]),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(got.label, "DS prod");
        let c = got.endpoint.clone().unwrap();
        assert_eq!((c.base_url.as_str(), c.auth_style, c.preset), ("https://example.test/anthropic", EndpointAuth::Bearer, EndpointPreset::Deepseek));
        assert_eq!(c.models, vec!["a".to_string(), "b".to_string()]);
        assert_eq!(got.config_dir, a.config_dir);
        assert_eq!(store::load(&p.accounts_file), vec![got]);
        assert_eq!(crate::auth::session::load(&p.api_key_file).as_deref(), Some("sk-keep"));
    }

    #[test]
    fn a_bad_edit_writes_nothing_and_a_non_endpoint_account_is_refused() {
        let (_root, p) = setup();
        let a = create_endpoint_account_in(&p, "e1", "DeepSeek", cfg(), "sk-keep").unwrap();
        let bad = update_endpoint_account_in(&p.accounts_file, "e1", EndpointUpdate { base_url: Some("ftp://x".into()), ..Default::default() });
        assert!(bad.is_err());
        assert_eq!(store::load(&p.accounts_file), vec![a.clone()]);
        let mut sub = a;
        sub.id = "s1".into();
        sub.kind = AccountKind::Subscription;
        store::save(&p.accounts_file, &[sub.clone()]).unwrap();
        assert!(update_endpoint_account_in(&p.accounts_file, "s1", EndpointUpdate::default()).is_err());
        assert!(require_endpoint_account(&[sub], "s1").is_err());
        assert!(require_endpoint_account(&[], "ghost").is_err());
    }

    #[test]
    fn base_urls_must_be_https_or_loopback_without_credentials() {
        assert!(check_base_url(" https://openrouter.ai/api ").is_ok());
        assert!(check_base_url("http://127.0.0.1:8080/x").is_ok());
        assert!(check_base_url("http://localhost:3000").is_ok());
        for bad in ["", "http://api.example.com", "ftp://x.test", "not a url", "https://user:pw@x.test", "https://x.test/?k=1", "https://x.test/#f"] {
            assert!(check_base_url(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn keys_with_control_characters_are_refused() {
        assert_eq!(check_key("  abc  "), Ok("abc".to_string()));
        assert!(check_key("  ").is_err());
        assert!(check_key("abc\ndef").is_err());
    }

    #[test]
    fn model_lists_are_checked_and_deduplicated() {
        assert_eq!(check_models(&["x".into(), "".into(), "x".into(), " y ".into()]), Ok(vec!["x".to_string(), "y".to_string()]));
        assert!(check_models(&["ok".into(), "bad id".into()]).is_err());
    }
}
