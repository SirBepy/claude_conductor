use super::*;
use crate::accounts::{AccountKind, EndpointConfig, EndpointPreset};
use crate::daemon::session::new_session_map;
use crate::daemon::settings_cache::SettingsCache;
use crate::types::Settings;
use std::path::PathBuf;

fn usage(id: &str, pct: Option<f64>) -> ProviderUsage {
    ProviderUsage {
        account_id: id.into(),
        fetched_at: "t0".into(),
        source: "deepseek".into(),
        windows: pct.map(|p| UsageWindow { label: "w".into(), used_pct: Some(p), ..Default::default() }).into_iter().collect(),
        ..Default::default()
    }
}

fn account(preset: EndpointPreset, base_url: &str) -> Account {
    Account {
        id: "ep".into(),
        label: "ep".into(),
        colour: String::new(),
        icon: String::new(),
        config_dir: PathBuf::from("C:/x"),
        chrome_profile_dir: PathBuf::from("C:/y"),
        email: String::new(),
        org_uuid: String::new(),
        subscription_tier: String::new(),
        created_at: "2026-11-25T00:00:00Z".into(),
        fleet_eligible: false,
        kind: AccountKind::Endpoint,
        endpoint: Some(EndpointConfig { preset, base_url: base_url.into(), ..Default::default() }),
    }
}

#[test]
fn set_reports_a_change_but_not_a_refetch_of_the_same_figures() {
    let hub = ProviderUsageHub::new();
    assert!(hub.set(usage("a", Some(10.0))), "first sight is a change");
    let mut again = usage("a", Some(10.0));
    again.fetched_at = "t1".into();
    assert!(!hub.set(again), "only fetched_at moved");
    assert_eq!(hub.get("a").unwrap().fetched_at, "t1", "the newer timestamp is still stored");
    assert!(hub.set(usage("a", Some(11.0))));
    assert!(hub.get("other").is_none());
}

#[test]
fn an_error_read_replaces_old_figures_instead_of_keeping_them() {
    let hub = ProviderUsageHub::new();
    hub.set(usage("a", Some(99.0)));
    assert!(hub.set(ProviderUsage::unknown("a", "deepseek", "the provider answered HTTP 500")));
    let now = hub.get("a").unwrap();
    assert!(now.windows.is_empty(), "stale 99% must not outlive a failed read");
    assert!(now.error.is_some());
}

#[test]
fn retain_accounts_drops_removed_accounts() {
    let hub = ProviderUsageHub::new();
    hub.set(usage("a", None));
    hub.set(usage("b", None));
    hub.retain_accounts(&HashSet::from(["a".to_string()]));
    assert!(hub.get("b").is_none());
    assert_eq!(hub.snapshot().len(), 1);
}

#[test]
fn nudges_are_debounced_per_account_and_skip_untracked_accounts() {
    let hub = ProviderUsageHub::new();
    let t0 = Instant::now();
    assert!(!hub.nudge_due("claude-acct", t0), "an account with no figures costs nothing at turn end");
    hub.set(usage("a", None));
    hub.set(usage("b", None));
    assert!(hub.nudge_due("a", t0));
    assert!(!hub.nudge_due("a", t0 + Duration::from_secs(59)), "inside the 60s gap");
    assert!(hub.nudge_due("b", t0 + Duration::from_secs(1)), "each account has its own gap");
    assert!(hub.nudge_due("a", t0 + Duration::from_secs(61)));
}

#[test]
fn a_first_fetch_is_tried_once_per_gap() {
    let hub = ProviderUsageHub::new();
    let t0 = Instant::now();
    assert!(hub.try_due("new", t0));
    assert!(!hub.try_due("new", t0 + Duration::from_secs(5)), "a page polling the read must not hammer the provider");
    assert!(hub.try_due("new", t0 + Duration::from_secs(61)));
}

#[test]
fn freshness_is_by_age_and_an_unparsable_stamp_is_not_fresh() {
    let mut u = usage("a", None);
    u.fetched_at = "2026-11-25T10:00:00Z".into();
    let t = chrono::DateTime::parse_from_rfc3339("2026-11-25T10:00:00Z").unwrap().timestamp();
    assert!(u.is_fresh(t + 100, 300));
    assert!(!u.is_fresh(t + 301, 300));
    u.fetched_at = "t0".into();
    assert!(!u.is_fresh(t, i64::MAX / 2), "unknown age is never fresh");
}

#[tokio::test]
async fn store_publishes_once_per_content_change() {
    let state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
    let mut rx = state.notifier.subscribe();
    store(&state, usage("a", Some(10.0)));
    let frame = rx.try_recv().expect("first read is published");
    assert_eq!(frame["method"], USAGE_CHANGED_EVENT);
    assert_eq!(frame["params"]["account_id"], "a");
    assert_eq!(frame["params"]["usage"]["windows"][0]["used_pct"], 10.0);

    let mut refetch = usage("a", Some(10.0));
    refetch.fetched_at = "t9".into();
    store(&state, refetch);
    assert!(rx.try_recv().is_err(), "an unchanged refetch stays quiet");

    store(&state, usage("a", Some(20.0)));
    assert_eq!(rx.try_recv().unwrap()["params"]["usage"]["windows"][0]["used_pct"], 20.0);
}

#[tokio::test]
async fn an_account_with_no_key_makes_no_call_and_says_why() {
    let u = read_account(&account(EndpointPreset::Deepseek, "https://api.deepseek.com/anthropic"), Fetcher::Deepseek, None).await;
    assert!(u.error.unwrap().contains("no key"));
}

#[tokio::test]
async fn an_address_off_the_hosts_list_never_receives_the_key() {
    let mut server = mockito::Server::new_async().await;
    let hit = server.mock("GET", mockito::Matcher::Any).expect(0).create_async().await;
    let acct = account(EndpointPreset::Deepseek, &server.url());
    let u = read_account(&acct, Fetcher::Deepseek, Some("fake-provider-key-0123456789".into())).await;
    hit.assert_async().await;
    assert!(u.error.unwrap().contains("not the provider's own"));
    assert!(u.balances.is_empty());
}

#[test]
fn only_an_opt_in_fetcher_waits_for_its_switch() {
    let hub = ProviderUsageHub::new();
    assert!(hub.may_fetch("ds", Fetcher::Deepseek), "documented routes need no switch");
    assert!(hub.may_fetch("or", Fetcher::Openrouter));
    assert!(!hub.may_fetch("kimi", Fetcher::Kimi), "no answer reads as off");
    hub.set_switch("kimi", true).unwrap();
    assert!(hub.may_fetch("kimi", Fetcher::Kimi));
    assert!(!hub.may_fetch("other-kimi", Fetcher::Kimi), "the switch is per account");
    hub.set_switch("kimi", false).unwrap();
    assert!(!hub.may_fetch("kimi", Fetcher::Kimi));
    assert_eq!(hub.switch_snapshot().get("kimi"), Some(&false));
}

#[tokio::test]
async fn a_kimi_account_with_its_switch_off_stores_an_unknown_and_never_reaches_the_key() {
    let state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
    let acct = account(EndpointPreset::KimiCode, "https://api.kimi.ai/coding/");
    let off = refresh_account(&state, &acct, Fetcher::Kimi).await;
    assert_eq!(off.error.as_deref(), Some(SWITCH_OFF_NOTE), "off says so and goes no further");
    assert!(off.windows.is_empty());
    assert_eq!(state.provider_usage.get("ep").unwrap().error.as_deref(), Some(SWITCH_OFF_NOTE));

    state.provider_usage.set_switch("ep", true).unwrap();
    let on = refresh_account(&state, &acct, Fetcher::Kimi).await;
    assert!(on.error.unwrap().contains("no key stored"), "with the switch on the read proceeds to the key");
}

#[tokio::test]
async fn the_switch_is_refused_for_an_account_without_one() {
    let state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
    let deepseek = account(EndpointPreset::Deepseek, "https://api.deepseek.com/anthropic");
    let err = set_plan_usage_among(&state, vec![(deepseek, Fetcher::Deepseek)], "ep", true).await.unwrap_err();
    assert!(err.contains("no switch"), "{err}");
    assert!(state.provider_usage.switch_snapshot().is_empty(), "nothing was saved");
    let err = set_plan_usage_among(&state, Vec::new(), "ghost", true).await.unwrap_err();
    assert!(err.contains("no Endpoint account"), "{err}");
}

#[tokio::test]
async fn flipping_the_switch_publishes_the_account_as_unknown_or_read() {
    let state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
    let mut rx = state.notifier.subscribe();
    let kimi = account(EndpointPreset::KimiCode, "https://api.kimi.ai/coding/");
    set_plan_usage_among(&state, vec![(kimi.clone(), Fetcher::Kimi)], "ep", true).await.unwrap();
    assert!(state.provider_usage.may_fetch("ep", Fetcher::Kimi));
    let frame = rx.try_recv().expect("turning it on reads the account at once");
    assert_eq!(frame["params"]["account_id"], "ep");

    set_plan_usage_among(&state, vec![(kimi, Fetcher::Kimi)], "ep", false).await.unwrap();
    let frame = rx.try_recv().expect("turning it off clears the figures on every surface");
    assert_eq!(frame["params"]["usage"]["error"], SWITCH_OFF_NOTE);
}
