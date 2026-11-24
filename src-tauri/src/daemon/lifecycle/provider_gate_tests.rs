//! The sidecars and the model probe stay subscription-only: an endpoint account,
//! named or default, is refused before any claude starts. Each test holds a temp
//! data dir: the account list is `accounts.json` under it, so no test reads the
//! real registry.

use crate::accounts::{Account, AccountKind, EndpointAuth, EndpointConfig};
use crate::types::Settings;
use std::path::PathBuf;

pub(crate) const ENDPOINT_ID: &str = "ep-1";

pub(crate) fn endpoint_account() -> Account {
    Account {
        id: ENDPOINT_ID.into(),
        label: "Kimi".into(),
        colour: "#fff".into(),
        icon: "plug".into(),
        config_dir: PathBuf::from("C:/home/.claude-kimi"),
        chrome_profile_dir: PathBuf::from("C:/appdata/chrome-profiles/ep-1"),
        email: String::new(),
        org_uuid: String::new(),
        subscription_tier: String::new(),
        created_at: "2026-11-23T00:00:00Z".into(),
        fleet_eligible: false,
        kind: AccountKind::Endpoint,
        endpoint: Some(EndpointConfig {
            base_url: "https://api.kimi.example/coding/".into(),
            auth_style: EndpointAuth::Bearer,
            ..Default::default()
        }),
    }
}

/// Saves the endpoint account into the (temp) data dir's `accounts.json`.
pub(crate) fn register_endpoint_account() {
    crate::accounts::store::save(&crate::settings::paths::accounts_file().unwrap(), &[endpoint_account()]).unwrap();
}

fn assert_endpoint_refusal(msg: &str, what: &str) {
    assert!(msg.contains(what) && msg.contains("endpoint account \"Kimi\""), "{msg}");
}

#[test]
fn the_ask_sidecar_refuses_an_endpoint_account() {
    let _data = crate::daemon::subchats::TempDataDir::new();
    register_endpoint_account();
    let err = crate::ask::sidecar::prepare("Ask", Some(ENDPOINT_ID)).err().expect("refused");
    assert_endpoint_refusal(&err.to_string(), "Ask");
}

#[tokio::test]
async fn publishing_refuses_an_endpoint_account() {
    let _data = crate::daemon::subchats::TempDataDir::new();
    register_endpoint_account();
    let err = crate::claude_ai_publish::publish("<p>x</p>", "t", None, Some(ENDPOINT_ID), None).await.err().expect("refused");
    assert_endpoint_refusal(&err.to_string(), "publishing to claude.ai");
}

#[tokio::test]
async fn voice_cleanup_refuses_an_endpoint_default_account() {
    let _data = crate::daemon::subchats::TempDataDir::new();
    register_endpoint_account();
    let mut settings = Settings::default();
    settings.default_account_id = Some(ENDPOINT_ID.into());
    crate::settings::save(&crate::settings::paths::settings_file().unwrap(), &settings).unwrap();
    let err = crate::voice::cleanup::clean_transcript("um so I think we should ship this today").await.err().expect("refused");
    assert_endpoint_refusal(&err.to_string(), "dictation cleanup");
}
