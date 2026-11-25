//! Parsers run on the documented response shapes, and the HTTP path runs
//! against a local mockito server only: no test ever calls a provider or uses
//! a real key.

use super::*;
use serde_json::json;

const KEY: &str = "fake-provider-key-0123456789abcdef";

fn endpoint(preset: EndpointPreset, base_url: &str) -> EndpointConfig {
    EndpointConfig { preset, base_url: base_url.into(), ..Default::default() }
}

#[test]
fn only_documented_presets_have_a_fetcher() {
    assert_eq!(Fetcher::for_preset(EndpointPreset::Deepseek), Some(Fetcher::Deepseek));
    assert_eq!(Fetcher::for_preset(EndpointPreset::Openrouter), Some(Fetcher::Openrouter));
    assert_eq!(Fetcher::for_preset(EndpointPreset::KimiCode), Some(Fetcher::Kimi));
    assert_eq!(Fetcher::for_preset(EndpointPreset::Custom), None, "a custom URL never gets a fetcher");
    assert!(Fetcher::Kimi.needs_opt_in(), "an undocumented route runs only behind the account's switch");
    assert!(!Fetcher::Deepseek.needs_opt_in() && !Fetcher::Openrouter.needs_opt_in());
}

/// The ONE real read-only call Joe approved (2026-11-25), run by hand:
/// `cargo test ... kimi_live_probe -- --ignored --nocapture`. It goes through
/// the app's own `request` and key loader, and prints the status and the masked
/// shape only; the key is never printed.
#[tokio::test]
#[ignore = "calls Kimi with the stored key; run once by hand"]
async fn kimi_live_probe() {
    let acc = crate::accounts::load_registry()
        .into_iter()
        .find(|a| a.endpoint.as_ref().is_some_and(|e| e.preset == EndpointPreset::KimiCode))
        .expect("a Kimi Code account");
    let key = crate::accounts::api_credit::load_api_key(&acc.id).expect("a stored key");
    let origin = pinned_origin(acc.endpoint.as_ref().unwrap(), Fetcher::Kimi).expect("the account's own Kimi host");
    let masker = Masker::new(&[key.as_str()]);
    match request(Fetcher::Kimi, &origin, &key).await {
        Ok((status, body)) => {
            println!("PROBE host={origin} status={status}");
            match body {
                Some(b) => println!("PROBE body={}", masker.mask_str(&b.to_string())),
                None => println!("PROBE body=<not JSON>"),
            }
        }
        Err(e) => println!("PROBE error={e}"),
    }
}

#[test]
fn the_key_goes_only_to_the_presets_own_https_host() {
    let ds = endpoint(EndpointPreset::Deepseek, "https://api.deepseek.com/anthropic");
    assert_eq!(pinned_origin(&ds, Fetcher::Deepseek).as_deref(), Some("https://api.deepseek.com"));
    let or = endpoint(EndpointPreset::Openrouter, "https://OpenRouter.ai/api");
    assert_eq!(pinned_origin(&or, Fetcher::Openrouter).as_deref(), Some("https://openrouter.ai"), "host case is folded");

    for (cfg, f) in [
        (endpoint(EndpointPreset::Deepseek, "https://evil.example/anthropic"), Fetcher::Deepseek),
        (endpoint(EndpointPreset::Deepseek, "https://api.deepseek.com.evil.example"), Fetcher::Deepseek),
        (endpoint(EndpointPreset::Deepseek, "https://evil.example/api.deepseek.com"), Fetcher::Deepseek),
        (endpoint(EndpointPreset::Deepseek, "http://api.deepseek.com"), Fetcher::Deepseek),
        (endpoint(EndpointPreset::Deepseek, "https://api.deepseek.com:8443"), Fetcher::Deepseek),
        (endpoint(EndpointPreset::Deepseek, "http://127.0.0.1:9999"), Fetcher::Deepseek),
        (endpoint(EndpointPreset::Openrouter, "https://api.deepseek.com"), Fetcher::Openrouter),
        (endpoint(EndpointPreset::Deepseek, "not a url"), Fetcher::Deepseek),
        (endpoint(EndpointPreset::Deepseek, ""), Fetcher::Deepseek),
    ] {
        assert_eq!(pinned_origin(&cfg, f), None, "{} must make no call", cfg.base_url);
    }
}

#[test]
fn deepseek_balance_parses_strings_and_keeps_every_currency() {
    let body = json!({
        "is_available": true,
        "balance_infos": [
            { "currency": "CNY", "total_balance": "110.00", "granted_balance": "10.00", "topped_up_balance": "100.00" },
            { "currency": "USD", "total_balance": "12.40", "granted_balance": "0", "topped_up_balance": "12.40" },
        ],
    });
    let u = parse_deepseek("acc", &body).unwrap();
    assert_eq!(u.source, "deepseek");
    assert_eq!(u.available, Some(true));
    assert_eq!(u.balances, vec![
        UsageBalance { currency: "CNY".into(), amount: 110.0 },
        UsageBalance { currency: "USD".into(), amount: 12.4 },
    ]);
    assert!(u.windows.is_empty() && u.error.is_none());
}

#[test]
fn deepseek_unavailable_with_no_rows_is_still_a_read() {
    let u = parse_deepseek("acc", &json!({ "is_available": false, "balance_infos": [] })).unwrap();
    assert_eq!(u.available, Some(false));
    assert!(u.balances.is_empty());
    assert!(parse_deepseek("acc", &json!({ "balance_infos": [] })).is_none(), "nothing known is not a read");
    assert!(parse_deepseek("acc", &json!({ "unexpected": 1 })).is_none());
}

#[test]
fn deepseek_skips_a_row_whose_amount_is_not_a_number() {
    let body = json!({ "is_available": true, "balance_infos": [
        { "currency": "USD", "total_balance": "n/a" },
        { "currency": "CNY", "total_balance": "5.5" },
    ]});
    let u = parse_deepseek("acc", &body).unwrap();
    assert_eq!(u.balances, vec![UsageBalance { currency: "CNY".into(), amount: 5.5 }]);
}

#[test]
fn openrouter_key_with_a_cap_draws_a_window_and_spend() {
    let body = json!({ "data": {
        "label": "sk-or-v1-abc...", "limit": 20.0, "limit_remaining": 3.1, "limit_reset": "monthly",
        "usage": 16.9, "usage_daily": 1.2, "usage_weekly": 4.0, "usage_monthly": 16.9, "is_free_tier": false,
    }});
    let u = parse_openrouter("acc", &body).unwrap();
    assert_eq!(u.windows.len(), 1);
    let w = &u.windows[0];
    assert_eq!(w.label, "Monthly key limit");
    assert_eq!(w.limit, Some(20.0));
    assert!((w.used.unwrap() - 16.9).abs() < 1e-9);
    assert!((w.used_pct.unwrap() - 84.5).abs() < 1e-6);
    assert_eq!(w.resets_at, None, "limit_reset is a cadence, not a time");
    let s = u.spend.unwrap();
    assert_eq!((s.day, s.week, s.month), (Some(1.2), Some(4.0), Some(16.9)));
    assert_eq!(s.limit_remaining, Some(3.1));
}

#[test]
fn openrouter_uncapped_key_has_spend_but_no_window() {
    let body = json!({ "data": { "limit": null, "limit_remaining": null, "limit_reset": null, "usage": 0.4, "usage_daily": 0.1 }});
    let u = parse_openrouter("acc", &body).unwrap();
    assert!(u.windows.is_empty(), "no cap, no window");
    assert_eq!(u.spend.unwrap().day, Some(0.1));
    assert!(parse_openrouter("acc", &json!({ "data": {} })).is_none());
    assert!(parse_openrouter("acc", &json!({ "error": "x" })).is_none());
}

/// The answer a real Kimi Code key got on 2026-11-25 (HTTP 200), figures only.
const KIMI_LIVE_BODY: &str = r#"{"limits":[{"detail":{"limit":"100","resetTime":"2026-11-25T01:28:11.601808Z","used":"100"},"window":{"duration":300,"timeUnit":"TIME_UNIT_MINUTE"}}],"usages":{"limit_5h":{"reset_time":"2026-11-25T01:28:11Z","used_ratio":1},"limit_month_code":{"reset_time":"2026-12-25T00:00:00Z","used_ratio":0.1236},"limit_month_total":{"reset_time":"2026-12-25T00:00:00Z","used_ratio":0.1236}}}"#;

#[test]
fn kimi_live_answer_gives_the_5h_and_monthly_windows_once_each() {
    let body: Value = serde_json::from_str(KIMI_LIVE_BODY).unwrap();
    let u = parse_kimi("acc", &body).unwrap();
    assert_eq!(u.source, "kimi_code");
    let labels: Vec<&str> = u.windows.iter().map(|w| w.label.as_str()).collect();
    assert_eq!(labels, ["5h limit", "Monthly limit"], "5h not repeated from usages, month_code echo dropped");
    let five = &u.windows[0];
    assert_eq!((five.used, five.limit, five.used_pct), (Some(100.0), Some(100.0), Some(100.0)), "string numbers are read");
    assert_eq!(five.resets_at.as_deref(), Some("2026-11-25T01:28:11.601808+00:00"));
    let month = &u.windows[1];
    assert!((month.used_pct.unwrap() - 12.36).abs() < 1e-9);
    assert_eq!(month.resets_at.as_deref(), Some("2026-12-25T00:00:00+00:00"));
}

#[test]
fn kimi_monthly_code_shows_when_it_differs_from_the_total() {
    let body = json!({ "usages": {
        "limit_month_code": { "reset_time": "2026-12-25T00:00:00Z", "used_ratio": 0.5 },
        "limit_month_total": { "reset_time": "2026-12-25T00:00:00Z", "used_ratio": 0.2 },
    }});
    let labels: Vec<String> = parse_kimi("acc", &body).unwrap().windows.into_iter().map(|w| w.label).collect();
    assert_eq!(labels, ["Monthly Code limit", "Monthly limit"]);
}

#[test]
fn kimi_reads_the_clis_older_shapes_leniently() {
    // `remaining` instead of `used`, an epoch-seconds reset, a top-level weekly `usage`.
    let body = json!({
        "usage": { "limit": 200, "remaining": 150, "reset_at": 1_795_000_000 },
        "limits": [{ "window": { "duration": 5, "timeUnit": "TIME_UNIT_HOUR" }, "detail": { "limit": "10", "remaining": "4", "resetIn": 600 } }],
    });
    let u = parse_kimi("acc", &body).unwrap();
    assert_eq!(u.windows[0].label, "5h limit");
    assert_eq!(u.windows[0].used_pct, Some(60.0));
    assert!(u.windows[0].resets_at.is_some(), "a countdown becomes a moment");
    assert_eq!(u.windows[1].label, "Weekly limit");
    assert_eq!(u.windows[1].used_pct, Some(25.0));
    assert!(u.windows[1].resets_at.as_deref().is_some_and(|t| t.starts_with("2026-")), "an epoch becomes a moment");
}

#[test]
fn kimi_milliseconds_and_seconds_epochs_land_on_the_same_moment() {
    let secs = kimi_reset(&json!({ "resetAt": 1_795_000_000 }));
    let millis = kimi_reset(&json!({ "resetAt": 1_795_000_000_000_i64 }));
    assert_eq!(secs, millis);
    assert!(secs.unwrap().starts_with("2026-"));
}

#[test]
fn kimi_without_readable_figures_is_not_a_read() {
    assert!(parse_kimi("acc", &json!({})).is_none());
    assert!(parse_kimi("acc", &json!({ "limits": [] })).is_none());
    // No `used` and no `remaining`: unknown, not "0% used".
    assert!(parse_kimi("acc", &json!({ "limits": [{ "detail": { "limit": "100" } }] })).is_none());
    // A zero limit cannot make a percent.
    assert!(parse_kimi("acc", &json!({ "limits": [{ "detail": { "limit": 0, "used": 0 } }] })).is_none());
    // An unknown usages key or a ratio that is not a number is skipped, never guessed.
    assert!(parse_kimi("acc", &json!({ "usages": { "limit_weird": { "used_ratio": 0.5 }, "limit_5h": { "used_ratio": "n/a" } } })).is_none());
}

#[test]
fn the_kimi_key_goes_only_to_kimis_own_hosts() {
    for base in ["https://api.kimi.ai/coding/", "https://api.kimi.com/coding/v1", "https://API.KIMI.COM/coding/"] {
        assert!(pinned_origin(&endpoint(EndpointPreset::KimiCode, base), Fetcher::Kimi).is_some(), "{base}");
    }
    for base in ["https://evil.example/coding/", "https://api.kimi.ai.evil.example/coding/", "http://api.kimi.ai/coding/", "https://api.kimi.ai:8443/coding/", "https://api.deepseek.com"] {
        assert_eq!(pinned_origin(&endpoint(EndpointPreset::KimiCode, base), Fetcher::Kimi), None, "{base}");
    }
}

#[tokio::test]
async fn kimi_fetch_reads_the_usages_route_with_a_bearer_key_and_an_honest_user_agent() {
    let mut server = mockito::Server::new_async().await;
    let m = server
        .mock("GET", "/coding/v1/usages")
        .match_header("authorization", format!("Bearer {KEY}").as_str())
        .match_header("user-agent", mockito::Matcher::Regex("^ClaudeConductor/".into()))
        .with_status(200)
        .with_header("content-type", "application/json")
        .with_body(KIMI_LIVE_BODY)
        .create_async()
        .await;
    let u = fetch(Fetcher::Kimi, &server.url(), "acc", KEY).await;
    m.assert_async().await;
    assert_eq!(u.error, None);
    assert_eq!(u.windows.len(), 2);
}

#[tokio::test]
async fn kimi_rate_limit_and_errors_are_unknowns_that_never_echo_the_body_or_key() {
    for status in [429_usize, 401, 500] {
        let mut server = mockito::Server::new_async().await;
        let _m = server
            .mock("GET", "/coding/v1/usages")
            .with_status(status)
            .with_body(format!("{{\"error\":\"quota gone {KEY}\"}}"))
            .create_async()
            .await;
        let u = fetch(Fetcher::Kimi, &server.url(), "acc", KEY).await;
        let err = u.error.expect("an error read");
        assert!(err.contains(&format!("HTTP {status}")), "{err}");
        assert!(!err.contains(KEY) && !err.contains("quota gone"), "no body in the error: {err}");
        assert!(u.windows.is_empty(), "an error read is an unknown, never a figure");
    }
}

#[test]
fn an_error_message_never_carries_the_key() {
    let u = masked_failure("acc", "deepseek", KEY, &format!("could not reach {KEY} at host"));
    let err = u.error.unwrap();
    assert!(!err.contains(KEY), "{err}");
    assert!(err.contains("[MASKED]"));
    assert!(u.windows.is_empty() && u.balances.is_empty(), "an error read is an unknown, never a figure");
}

#[tokio::test]
async fn fetch_sends_a_bearer_key_and_an_honest_user_agent_and_reads_the_figures() {
    let mut server = mockito::Server::new_async().await;
    let m = server
        .mock("GET", "/user/balance")
        .match_header("authorization", format!("Bearer {KEY}").as_str())
        .match_header("user-agent", mockito::Matcher::Regex("^ClaudeConductor/".into()))
        .with_status(200)
        .with_header("content-type", "application/json")
        .with_body(r#"{"is_available":true,"balance_infos":[{"currency":"USD","total_balance":"12.40"}]}"#)
        .create_async()
        .await;
    let u = fetch(Fetcher::Deepseek, &server.url(), "acc", KEY).await;
    m.assert_async().await;
    assert_eq!(u.error, None);
    assert_eq!(u.balances[0].amount, 12.4);
}

#[tokio::test]
async fn openrouter_reads_the_key_route_under_api() {
    let mut server = mockito::Server::new_async().await;
    let m = server
        .mock("GET", "/api/v1/key")
        .with_status(200)
        .with_body(r#"{"data":{"limit":10,"limit_remaining":0,"usage":10}}"#)
        .create_async()
        .await;
    let u = fetch(Fetcher::Openrouter, &server.url(), "acc", KEY).await;
    m.assert_async().await;
    assert_eq!(u.windows[0].used_pct, Some(100.0));
}

#[tokio::test]
async fn a_rejected_key_is_an_unknown_that_never_echoes_the_response_body() {
    let mut server = mockito::Server::new_async().await;
    let _m = server
        .mock("GET", "/user/balance")
        .with_status(401)
        .with_body(format!("bad key {KEY}"))
        .create_async()
        .await;
    let u = fetch(Fetcher::Deepseek, &server.url(), "acc", KEY).await;
    let err = u.error.expect("an error read");
    assert!(err.contains("HTTP 401"), "{err}");
    assert!(!err.contains(KEY) && !err.contains("bad key"), "no body in the error: {err}");
    assert!(u.balances.is_empty() && u.windows.is_empty());
}

#[tokio::test]
async fn server_errors_and_garbage_are_unknowns() {
    let mut server = mockito::Server::new_async().await;
    let _m = server.mock("GET", "/user/balance").with_status(503).create_async().await;
    let u = fetch(Fetcher::Deepseek, &server.url(), "acc", KEY).await;
    assert!(u.error.unwrap().contains("HTTP 503"));

    let mut server = mockito::Server::new_async().await;
    let _m = server.mock("GET", "/user/balance").with_status(200).with_body("<html>").create_async().await;
    assert!(fetch(Fetcher::Deepseek, &server.url(), "acc", KEY).await.error.is_some());

    let mut server = mockito::Server::new_async().await;
    let _m = server.mock("GET", "/user/balance").with_status(200).with_body("{}").create_async().await;
    assert!(fetch(Fetcher::Deepseek, &server.url(), "acc", KEY).await.error.is_some(), "no figures is an unknown");
}

#[tokio::test]
async fn a_redirect_is_not_followed_so_the_key_cannot_travel() {
    let mut target = mockito::Server::new_async().await;
    let leaked = target.mock("GET", "/user/balance").expect(0).create_async().await;
    let mut server = mockito::Server::new_async().await;
    let _m = server
        .mock("GET", "/user/balance")
        .with_status(302)
        .with_header("location", &format!("{}/user/balance", target.url()))
        .create_async()
        .await;
    let u = fetch(Fetcher::Deepseek, &server.url(), "acc", KEY).await;
    leaked.assert_async().await;
    assert!(u.error.unwrap().contains("HTTP 302"));
}
