use super::*;
use crate::accounts::EndpointConfig;
use chrono::{TimeZone, Utc};
use std::path::PathBuf;

const NOW: i64 = 1_800_000_000;
const POLL: i64 = 600;

fn account(kind: AccountKind) -> Account {
    Account {
        id: "a".into(),
        label: "a".into(),
        colour: String::new(),
        icon: String::new(),
        config_dir: PathBuf::from("C:/x"),
        chrome_profile_dir: PathBuf::from("C:/y"),
        email: String::new(),
        org_uuid: "ORG".into(),
        subscription_tier: String::new(),
        created_at: "2026-11-23T00:00:00Z".into(),
        fleet_eligible: false,
        kind,
        endpoint: (kind == AccountKind::Endpoint).then(EndpointConfig::default),
    }
}

fn rfc(t: i64) -> String {
    Utc.timestamp_opt(t, 0).unwrap().to_rfc3339()
}

fn snap(age: i64, five: f64, five_reset: i64, week: f64, week_reset: i64) -> UsageSnapshot {
    UsageSnapshot {
        captured_at: rfc(NOW - age),
        five_hour: WindowUsage { utilization: five, resets_at: rfc(five_reset) },
        five_hour_limited: true,
        seven_day: WindowUsage { utilization: week, resets_at: rfc(week_reset) },
        extra_usage: None,
        account_id: Some("a".into()),
    }
}

fn signals(snapshot: Option<UsageSnapshot>, rate_limit: Option<(i64, &str)>) -> Signals {
    Signals { snapshot, rate_limit: rate_limit.map(|(t, w)| (t, w.to_string())), poll_interval_secs: POLL, now: NOW }
}

fn sub() -> Account {
    account(AccountKind::Subscription)
}

#[test]
fn a_fresh_full_5h_window_is_a_limit_with_its_reset() {
    let l = at_limit(&sub(), &signals(Some(snap(60, 100.0, NOW + 3600, 10.0, NOW + 9999)), None)).unwrap();
    assert_eq!(l, Limit { window: "5h", resets_at: Some(NOW + 3600) });
}

#[test]
fn a_fresh_full_weekly_window_is_a_limit() {
    let l = at_limit(&sub(), &signals(Some(snap(60, 20.0, NOW + 3600, 100.0, NOW + 50_000)), None)).unwrap();
    assert_eq!(l, Limit { window: "weekly", resets_at: Some(NOW + 50_000) });
}

#[test]
fn under_100_percent_is_not_a_limit() {
    assert_eq!(at_limit(&sub(), &signals(Some(snap(60, 99.9, NOW + 3600, 99.0, NOW + 9999)), None)), None);
}

#[test]
fn a_live_rate_limit_with_a_future_reset_is_a_limit_and_a_past_one_is_not() {
    let l = at_limit(&sub(), &signals(None, Some((NOW + 600, "five_hour")))).unwrap();
    assert_eq!(l, Limit { window: "5h", resets_at: Some(NOW + 600) });
    assert_eq!(at_limit(&sub(), &signals(None, Some((NOW - 1, "five_hour")))), None);
    assert_eq!(at_limit(&sub(), &signals(None, Some((NOW, "five_hour")))), None);
    // An Endpoint account that was refused has the same hard signal.
    assert!(at_limit(&account(AccountKind::Endpoint), &signals(None, Some((NOW + 600, "seven_day")))).is_some());
}

#[test]
fn a_stale_snapshot_is_not_a_limit() {
    let fresh = snap(POLL * 3, 100.0, NOW + 3600, 0.0, NOW + 9999);
    assert!(at_limit(&sub(), &signals(Some(fresh), None)).is_some(), "exactly three intervals old still counts");
    let stale = snap(POLL * 3 + 1, 100.0, NOW + 3600, 0.0, NOW + 9999);
    assert_eq!(at_limit(&sub(), &signals(Some(stale), None)), None);
}

#[test]
fn an_unknown_figure_is_not_a_limit() {
    assert_eq!(at_limit(&sub(), &signals(None, None)), None);
    let mut unparsable = snap(60, 100.0, NOW + 3600, 100.0, NOW + 3600);
    unparsable.captured_at = "yesterday".into();
    assert_eq!(at_limit(&sub(), &signals(Some(unparsable), None)), None);
}

#[test]
fn a_window_that_already_reset_is_not_a_limit_and_an_unknown_reset_still_is() {
    assert_eq!(at_limit(&sub(), &signals(Some(snap(60, 100.0, NOW - 5, 100.0, NOW - 5)), None)), None);
    let mut s = snap(60, 100.0, NOW + 1, 0.0, NOW + 1);
    s.five_hour.resets_at = String::new();
    assert_eq!(at_limit(&sub(), &signals(Some(s), None)), Some(Limit { window: "5h", resets_at: None }));
}

#[test]
fn a_plan_with_no_5h_window_ignores_its_5h_reading() {
    let mut s = snap(60, 100.0, NOW + 3600, 10.0, NOW + 9999);
    s.five_hour_limited = false;
    assert_eq!(at_limit(&sub(), &signals(Some(s), None)), None);
}

#[test]
fn only_a_subscription_reads_the_usage_snapshot() {
    let s = signals(Some(snap(60, 100.0, NOW + 3600, 100.0, NOW + 3600)), None);
    assert_eq!(at_limit(&account(AccountKind::Endpoint), &s), None);
    assert_eq!(at_limit(&account(AccountKind::ApiCredit), &s), None);
}

#[test]
fn the_note_names_the_window_and_the_reset_time() {
    assert!(Limit { window: "5h", resets_at: Some(NOW) }.describe().starts_with("its 5h limit (resets "));
    assert_eq!(Limit { window: "weekly", resets_at: None }.describe(), "its weekly limit");
}
