//! One fetcher per provider preset: asks the provider's own usage endpoint with
//! the key Conductor already stores for the account and turns the answer into a
//! [`ProviderUsage`]. Read docs/architecture/providers.md ("Provider usage")
//! before editing.
//!
//! Hard rules:
//! - The key goes only to the account's own `base_url` host, and only when that
//!   host is on the preset's list (`pinned_origin`). Anything else makes no call.
//! - Every error string passes the broker's exact-value `Masker` keyed on the
//!   key. A response body is never logged and never copied into an error.
//! - The User-Agent is `ClaudeConductor/<version>`, never `claude-cli` or
//!   `kimi-cli` (Kimi Code's terms forbid imitating its CLI).
//! - Redirects are not followed, so the key cannot travel to another host.

use super::model::{ProviderUsage, UsageBalance, UsageSpend, UsageWindow};
use crate::accounts::{EndpointConfig, EndpointPreset};
use crate::daemon::broker::mask::Masker;
use serde_json::Value;
use std::time::Duration;

const DEEPSEEK_HOSTS: &[&str] = &["api.deepseek.com"];
const OPENROUTER_HOSTS: &[&str] = &["openrouter.ai"];
/// The CLI's default is `api.kimi.com`; Conductor's preset is `api.kimi.ai`, and
/// the region is tied to the key, so both are the provider's own.
const KIMI_HOSTS: &[&str] = &["api.kimi.com", "api.kimi.ai"];

/// The presets that have a usage endpoint. Z.ai is not here (its endpoint is
/// community-documented and waits for a real-key probe), and `custom` never
/// gets a fetcher.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Fetcher {
    Deepseek,
    Openrouter,
    /// Kimi Code's `/coding/v1/usages`. Not in Moonshot's published API docs
    /// (read from kimi-cli's source), so it only runs once the account's "Show
    /// plan usage" switch is on.
    Kimi,
}

impl Fetcher {
    pub fn for_preset(preset: EndpointPreset) -> Option<Self> {
        match preset {
            EndpointPreset::Deepseek => Some(Self::Deepseek),
            EndpointPreset::Openrouter => Some(Self::Openrouter),
            EndpointPreset::KimiCode => Some(Self::Kimi),
            EndpointPreset::Custom => None,
        }
    }

    /// True for a fetcher that stays silent until the account's "Show plan
    /// usage" switch is turned on (see `switch.rs`).
    pub fn needs_opt_in(self) -> bool {
        matches!(self, Self::Kimi)
    }

    pub fn source(self) -> &'static str {
        match self {
            Self::Deepseek => "deepseek",
            Self::Openrouter => "openrouter",
            Self::Kimi => "kimi_code",
        }
    }

    fn hosts(self) -> &'static [&'static str] {
        match self {
            Self::Deepseek => DEEPSEEK_HOSTS,
            Self::Openrouter => OPENROUTER_HOSTS,
            Self::Kimi => KIMI_HOSTS,
        }
    }

    /// Path under the origin. DeepSeek's Anthropic base is `/anthropic`, but
    /// the balance route sits at the host root; OpenRouter's base is `/api`;
    /// Kimi's two known bases (`/coding/` here, `/coding/v1` in its CLI) both
    /// end up at the same route.
    fn path(self) -> &'static str {
        match self {
            Self::Deepseek => "/user/balance",
            Self::Openrouter => "/api/v1/key",
            Self::Kimi => "/coding/v1/usages",
        }
    }
}

/// `https://host` of the account's `base_url` when that host is on the
/// fetcher's list, else `None` (no call is made). Plain http, a custom port and
/// any host off the list all read as `None`.
pub fn pinned_origin(config: &EndpointConfig, fetcher: Fetcher) -> Option<String> {
    let url = url::Url::parse(config.base_url.trim()).ok()?;
    if url.scheme() != "https" || url.port().is_some() {
        return None;
    }
    let host = url.host_str()?.to_ascii_lowercase();
    fetcher.hosts().contains(&host.as_str()).then(|| format!("https://{host}"))
}

fn client() -> reqwest::Result<reqwest::Client> {
    reqwest::Client::builder()
        .user_agent(concat!("ClaudeConductor/", env!("CARGO_PKG_VERSION")))
        .timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .build()
}

/// One GET of `fetcher`'s usage route: the HTTP status and, when the body is
/// JSON, the body. `Err` is an already-masked "could not reach" line. The one
/// place the key leaves the process.
pub(super) async fn request(fetcher: Fetcher, origin: &str, key: &str) -> Result<(u16, Option<Value>), String> {
    let mask = |msg: String| Masker::new(&[key]).mask_str(&msg);
    let client = client().map_err(|e| mask(format!("could not start the request: {}", e.without_url())))?;
    let url = format!("{}{}", origin.trim_end_matches('/'), fetcher.path());
    let resp = client
        .get(&url)
        .bearer_auth(key)
        .send()
        .await
        .map_err(|e| mask(format!("could not reach the provider: {}", e.without_url())))?;
    let status = resp.status().as_u16();
    Ok((status, resp.json().await.ok()))
}

/// Reads `fetcher`'s usage endpoint at `origin` with `key`. Never fails: a
/// problem comes back as a [`ProviderUsage`] whose `error` says what, so the
/// caller stores an honest "unknown" instead of keeping old figures.
pub async fn fetch(fetcher: Fetcher, origin: &str, account_id: &str, key: &str) -> ProviderUsage {
    let fail = |msg: &str| masked_failure(account_id, fetcher.source(), key, msg);
    let (status, body) = match request(fetcher, origin, key).await {
        Ok(r) => r,
        Err(msg) => return fail(&msg),
    };
    if !(200..300).contains(&status) {
        return fail(&match status {
            401 | 403 => format!("the provider rejected the key (HTTP {status})"),
            404 => "the provider has no usage endpoint at this address (HTTP 404)".to_string(),
            429 => "the provider is rate limiting this key (HTTP 429)".to_string(),
            code => format!("the provider answered HTTP {code}"),
        });
    }
    let Some(body) = body else {
        return fail("the provider's answer was not the expected JSON");
    };
    let parsed = match fetcher {
        Fetcher::Deepseek => parse_deepseek(account_id, &body),
        Fetcher::Openrouter => parse_openrouter(account_id, &body),
        Fetcher::Kimi => parse_kimi(account_id, &body),
    };
    parsed.unwrap_or_else(|| fail("the provider's answer had no usage figures"))
}

/// An "unknown" read whose error text has `key` (in every encoded form) removed.
pub(super) fn masked_failure(account_id: &str, source: &str, key: &str, msg: &str) -> ProviderUsage {
    ProviderUsage::unknown(account_id, source, Masker::new(&[key]).mask_str(msg))
}

/// A JSON number or a numeric string (DeepSeek sends amounts as strings).
fn num(v: Option<&Value>) -> Option<f64> {
    match v? {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
    .filter(|n| n.is_finite())
}

fn stamped(account_id: &str, source: &str) -> ProviderUsage {
    ProviderUsage {
        account_id: account_id.to_string(),
        fetched_at: chrono::Utc::now().to_rfc3339(),
        source: source.to_string(),
        ..Default::default()
    }
}

/// `GET /user/balance`: `{ is_available, balance_infos: [{ currency, total_balance, .. }] }`.
pub(super) fn parse_deepseek(account_id: &str, body: &Value) -> Option<ProviderUsage> {
    let infos = body.get("balance_infos")?.as_array()?;
    let mut out = stamped(account_id, "deepseek");
    out.available = body.get("is_available").and_then(Value::as_bool);
    for info in infos {
        let (Some(currency), Some(amount)) = (info.get("currency").and_then(Value::as_str), num(info.get("total_balance"))) else {
            continue;
        };
        out.balances.push(UsageBalance { currency: currency.to_string(), amount });
    }
    if out.balances.is_empty() && out.available.is_none() {
        return None;
    }
    Some(out)
}

/// `GET /api/v1/key`: `{ data: { limit, limit_remaining, limit_reset, usage, usage_daily, .. } }`.
/// `limit` is null for a key with no cap, which draws no window.
pub(super) fn parse_openrouter(account_id: &str, body: &Value) -> Option<ProviderUsage> {
    let data = body.get("data")?;
    let usage = num(data.get("usage"));
    let limit = num(data.get("limit"));
    let remaining = num(data.get("limit_remaining"));
    if usage.is_none() && limit.is_none() {
        return None;
    }
    let mut out = stamped(account_id, "openrouter");
    out.spend = Some(UsageSpend {
        day: num(data.get("usage_daily")),
        week: num(data.get("usage_weekly")),
        month: num(data.get("usage_monthly")),
        limit,
        limit_remaining: remaining,
    });
    if let Some(limit) = limit {
        // `limit_reset` is a cadence ("daily", "weekly", "monthly"), not a time,
        // so the window carries no `resets_at`.
        let label = match data.get("limit_reset").and_then(Value::as_str) {
            Some("daily") => "Daily key limit",
            Some("weekly") => "Weekly key limit",
            Some("monthly") => "Monthly key limit",
            _ => "Key limit",
        };
        let used = remaining.map(|r| limit - r).or(usage);
        out.windows.push(UsageWindow { label: label.into(), used, limit: Some(limit), ..Default::default() }.with_derived_pct());
    }
    Some(out)
}

/// `GET /coding/v1/usages` (the route kimi-cli's own `/usage` calls). A live
/// answer (2026-11-25, HTTP 200) has this shape, numbers as strings:
/// `{ limits: [{ window: {duration: 300, timeUnit: "TIME_UNIT_MINUTE"},
/// detail: {limit: "100", used: "100", resetTime: "<RFC 3339>"} }],
/// usages: { limit_5h: {reset_time, used_ratio}, limit_month_code: {..},
/// limit_month_total: {..} } }`. `limits[]` is the rolling window (the 5h one);
/// `usages` adds the monthly allowances as a 0..1 `used_ratio`.
///
/// kimi-cli's own reader also takes a top-level `usage` block and `remaining`
/// instead of `used`; those are kept for plans that answer that way, but no
/// live answer has shown them (UNVERIFIED). A key or shape not named here is
/// skipped, never guessed at.
pub(super) fn parse_kimi(account_id: &str, body: &Value) -> Option<ProviderUsage> {
    let mut windows = Vec::new();
    if let Some(rows) = body.get("limits").and_then(Value::as_array) {
        for row in rows {
            let detail = row.get("detail").unwrap_or(row);
            let label = row.get("window").and_then(kimi_window_label).unwrap_or_else(|| "Usage limit".to_string());
            windows.extend(kimi_window(label, detail));
        }
    }
    if let Some(top) = body.get("usage") {
        windows.extend(kimi_window("Weekly limit".to_string(), top));
    }
    if let Some(map) = body.get("usages").and_then(Value::as_object) {
        for (key, block) in map {
            let Some(w) = kimi_ratio_window(key, block) else { continue };
            // `limits[]` already carries the 5h window, and `limit_month_code` repeats
            // `limit_month_total` while the plan has only Code usage: show each label once.
            let same_as_shown = windows.iter().any(|x| x.label == w.label);
            let echoes_total = key == "limit_month_code"
                && map.get("limit_month_total").and_then(|t| kimi_ratio_window(key, t)).is_some_and(|t| t.used_pct == w.used_pct && t.resets_at == w.resets_at);
            if !same_as_shown && !echoes_total {
                windows.push(w);
            }
        }
    }
    if windows.is_empty() {
        return None;
    }
    let mut out = stamped(account_id, "kimi_code");
    out.windows = windows;
    Some(out)
}

/// One `usages` entry: `{ used_ratio: 0..1, reset_time }`, labelled from its key
/// (`limit_5h`, `limit_month_total`, ...). `None` for a key or a ratio it cannot read.
fn kimi_ratio_window(key: &str, block: &Value) -> Option<UsageWindow> {
    let label = match key.strip_prefix("limit_")? {
        "month_total" => "Monthly limit".to_string(),
        "month_code" => "Monthly Code limit".to_string(),
        k if k.starts_with("week") => "Weekly limit".to_string(),
        "day" => "Daily limit".to_string(),
        k => format!("{}h limit", k.strip_suffix('h')?.parse::<u32>().ok().filter(|h| *h > 0)?),
    };
    let ratio = num(block.get("used_ratio")).or_else(|| num(block.get("usedRatio")))?;
    Some(UsageWindow {
        label,
        used_pct: Some((ratio * 100.0).clamp(0.0, 100.0)),
        resets_at: kimi_reset(block),
        ..Default::default()
    })
}

/// `{duration: 300, timeUnit: "TIME_UNIT_MINUTE"}` -> "5h limit".
fn kimi_window_label(window: &Value) -> Option<String> {
    let n = num(window.get("duration"))?;
    if n <= 0.0 || n.fract() != 0.0 {
        return None;
    }
    let n = n as u64;
    let unit = window.get("timeUnit").or_else(|| window.get("time_unit"))?.as_str()?.to_ascii_uppercase();
    let hours = match unit.trim_start_matches("TIME_UNIT_") {
        "MINUTE" if n % 60 == 0 => n / 60,
        "MINUTE" => return Some(format!("{n}m limit")),
        "HOUR" => n,
        "DAY" if n == 1 => return Some("Daily limit".to_string()),
        "DAY" if n == 7 => return Some("Weekly limit".to_string()),
        "DAY" => return Some(format!("{n}d limit")),
        _ => return None,
    };
    Some(format!("{hours}h limit"))
}

fn kimi_window(label: String, block: &Value) -> Option<UsageWindow> {
    let limit = num(block.get("limit")).filter(|l| *l > 0.0)?;
    // Neither `used` nor `remaining` is an unknown figure, not "0 used".
    let used = num(block.get("used")).or_else(|| num(block.get("remaining")).map(|r| limit - r))?;
    Some(
        UsageWindow {
            label,
            used: Some(used.clamp(0.0, limit)),
            limit: Some(limit),
            resets_at: kimi_reset(block),
            ..Default::default()
        }
        .with_derived_pct(),
    )
}

/// The reset moment as RFC 3339, from an ISO string, an epoch (seconds or
/// milliseconds) or a seconds-from-now countdown; `None` when absent or unreadable.
fn kimi_reset(block: &Value) -> Option<String> {
    use chrono::{DateTime, Duration as Span, Utc};
    for key in ["resetTime", "reset_time", "resetAt", "reset_at"] {
        match block.get(key) {
            Some(Value::String(s)) => {
                if let Ok(t) = DateTime::parse_from_rfc3339(s.trim()) {
                    return Some(t.with_timezone(&Utc).to_rfc3339());
                }
                if let Ok(n) = s.trim().parse::<f64>() {
                    return epoch_to_rfc3339(n);
                }
            }
            Some(Value::Number(n)) => return epoch_to_rfc3339(n.as_f64()?),
            _ => {}
        }
    }
    for key in ["resetIn", "reset_in", "ttl"] {
        if let Some(secs) = num(block.get(key)).filter(|s| (0.0..1.0e9).contains(s)) {
            return Some((Utc::now() + Span::seconds(secs as i64)).to_rfc3339());
        }
    }
    None
}

fn epoch_to_rfc3339(n: f64) -> Option<String> {
    if !n.is_finite() || n <= 0.0 {
        return None;
    }
    // Past 1e11 a value cannot be seconds (that would be the year 5138).
    let millis = if n > 1.0e11 { n as i64 } else { (n * 1000.0) as i64 };
    chrono::DateTime::from_timestamp_millis(millis).map(|t| t.to_rfc3339())
}

#[cfg(test)]
mod tests;
