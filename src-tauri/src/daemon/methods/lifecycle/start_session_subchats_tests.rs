//! The `subchats_on` branches of `start_session`, driven through the router.
//! A missing `cwd` makes `spawn_session` fail before any `claude` is started, so
//! none of these needs the binary. Each holds the temp data dir: the mode lives
//! in `chat-config.json` and the account list in `accounts.json`, both under it.

use super::core::register_core;
use crate::accounts::{Account, AccountKind};
use crate::daemon::rpc::{ConnectionContext, Request, Response, Router};
use crate::daemon::state::DaemonState;
use serde_json::{json, Value};
use crate::daemon::session::new_session_map;
use crate::daemon::settings_cache::SettingsCache;
use crate::daemon::subchats::TempDataDir;

async fn start(params: Value) -> Response {
    let state = DaemonState::new(new_session_map(), SettingsCache::new(crate::types::Settings::default()));
    let mut router = Router::new();
    register_core(&mut router, state);
    let (tx, _rx) = tokio::sync::mpsc::channel(16);
    router
        .dispatch(
            Request { jsonrpc: "2.0".into(), id: json!(1), method: "start_session".into(), params: Some(params) },
            ConnectionContext::new(tx),
        )
        .await
}

fn params(extra: Value) -> Value {
    let mut base = json!({
        "cwd": "Z:\\does\\not\\exist", "model": "opus", "effort": "high", "subchats_on": true,
    });
    for (k, v) in extra.as_object().expect("extra is an object") {
        base[k] = v.clone();
    }
    base
}

fn chat_config_path() -> std::path::PathBuf {
    crate::settings::paths::data_dir().unwrap().join("chat-config.json")
}

/// A refusal that fires ahead of the spawn leaves no chat-config behind. The
/// spawn-failure rollback writes `subchats_on: false` for the id, so the file
/// existing at all would mean the refusal ran too late.
fn assert_nothing_persisted() {
    assert!(!chat_config_path().exists(), "a refused start must not touch chat-config.json");
    assert!(crate::sessions::chat_config::list_subchats_on().is_empty());
}

#[tokio::test]
async fn a_plain_resume_with_subchats_on_is_refused_and_writes_nothing() {
    let _data = TempDataDir::new();
    let resp = start(params(json!({"resume_id": "existing-chat"}))).await;
    let err = resp.error.expect("a plain resume cannot turn the mode on");
    assert_eq!(err.code, -32602);
    assert!(err.message.contains("not a plain resume"), "{}", err.message);
    assert_nothing_persisted();
}

/// Control for the refusal above: a fork mints a new chat, so the mode is
/// allowed and the start gets as far as the spawn (which fails on the cwd).
#[tokio::test]
async fn a_fork_with_subchats_on_is_not_refused_as_a_resume() {
    let _data = TempDataDir::new();
    let resp = start(params(json!({"resume_id": "existing-chat", "fork": true}))).await;
    let err = resp.error.expect("the cwd is missing");
    assert!(err.message.contains("cwd does not exist"), "{}", err.message);
}

#[tokio::test]
async fn an_api_credit_account_with_subchats_on_is_refused_and_writes_nothing() {
    let _data = TempDataDir::new();
    let account = Account {
        id: "api-1".into(),
        label: "api-1".into(),
        colour: "#fff".into(),
        icon: "key".into(),
        config_dir: std::path::PathBuf::from("C:/home/.claude-x"),
        chrome_profile_dir: std::path::PathBuf::from("C:/appdata/chrome-profiles/x"),
        email: String::new(),
        org_uuid: "ORG".into(),
        subscription_tier: String::new(),
        created_at: "2026-11-07T00:00:00Z".into(),
        fleet_eligible: false,
        kind: AccountKind::ApiCredit,
    };
    crate::accounts::store::save(&crate::settings::paths::accounts_file().unwrap(), &[account]).unwrap();

    let resp = start(params(json!({"account_id": "api-1"}))).await;
    let err = resp.error.expect("an API-credit account cannot use subchats");
    assert_eq!(err.code, -32602);
    assert_eq!(err.message, crate::daemon::subchats::API_CREDIT_REFUSAL);
    assert_nothing_persisted();
}

/// The mode is persisted under an id the handler mints before the spawn
/// (`lifecycle::spawn` finds it there), and a spawn that fails must not leave
/// the chat holding it. One config entry, a UUID, switched back off.
#[tokio::test]
async fn a_failed_spawn_leaves_the_minted_id_with_the_mode_off() {
    let _data = TempDataDir::new();
    let resp = start(params(json!({}))).await;
    let err = resp.error.expect("the cwd is missing");
    assert!(err.message.contains("cwd does not exist"), "{}", err.message);

    assert!(crate::sessions::chat_config::list_subchats_on().is_empty(), "the rollback clears the mode");
    let raw = std::fs::read_to_string(chat_config_path()).expect("the mode was persisted before the spawn");
    let map: serde_json::Map<String, Value> = serde_json::from_str(&raw).unwrap();
    assert_eq!(map.len(), 1, "{raw}");
    let (id, cfg) = map.iter().next().unwrap();
    assert!(uuid::Uuid::parse_str(id).is_ok(), "the handler mints the id: {id}");
    assert_eq!(cfg["subchats_on"], json!(false));
}
