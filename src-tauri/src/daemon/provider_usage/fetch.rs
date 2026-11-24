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

/// The presets that have a documented usage endpoint. Kimi Code and Z.ai are
/// not here: their endpoints are community-documented and wait for a real-key
/// probe, and `custom` never gets a fetcher.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Fetcher {
    Deepseek,
    Openrouter,
}

impl Fetcher {
    pub fn for_preset(preset: EndpointPreset) -> Option<Self> {
        match preset {
            EndpointPreset::Deepseek => Some(Self::Deepseek),
            EndpointPreset::Openrouter => Some(Self::Openrouter),
            EndpointPreset::KimiCode | EndpointPreset::Custom => None,
        }
    }

    pub fn source(self) -> &'static str {
        match self {
            Self::Deepseek => "deepseek",
            Self::Openrouter => "openrouter",
        }
    }

    fn hosts(self) -> &'static [&'static str] {
        match self {
            Self::Deepseek => DEEPSEEK_HOSTS,
            Self::Openrouter => OPENROUTER_HOSTS,
        }
    }

    /// Path under the origin. DeepSeek's Anthropic base is `/anthropic`, but
    /// the balance route sits at the host root; OpenRouter's base is `/api`.
    fn path(self) -> &'static str {
        match self {
            Self::Deepseek => "/user/balance",
            Self::Openrouter => "/api/v1/key",
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

/// Reads `fetcher`'s usage endpoint at `origin` with `key`. Never fails: a
/// problem comes back as a [`ProviderUsage`] whose `error` says what, so the
/// caller stores an honest "unknown" instead of keeping old figures.
pub async fn fetch(fetcher: Fetcher, origin: &str, account_id: &str, key: &str) -> ProviderUsage {
    let fail = |msg: &str| masked_failure(account_id, fetcher.source(), key, msg);
    let client = match client() {
        Ok(c) => c,
        Err(e) => return fail(&format!("could not start the request: {}", e.without_url())),
    };
    let url = format!("{}{}", origin.trim_end_matches('/'), fetcher.path());
    let resp = match client.get(&url).bearer_auth(key).send().await {
        Ok(r) => r,
        Err(e) => return fail(&format!("could not reach the provider: {}", e.without_url())),
    };
    let status = resp.status();
    if !status.is_success() {
        return fail(&match status.as_u16() {
            401 | 403 => format!("the provider rejected the key (HTTP {})", status.as_u16()),
            404 => "the provider has no usage endpoint at this address (HTTP 404)".to_string(),
            code => format!("the provider answered HTTP {code}"),
        });
    }
    let body: Value = match resp.json().await {
        Ok(v) => v,
        Err(_) => return fail("the provider's answer was not the expected JSON"),
    };
    let parsed = match fetcher {
        Fetcher::Deepseek => parse_deepseek(account_id, &body),
        Fetcher::Openrouter => parse_openrouter(account_id, &body),
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

#[cfg(test)]
mod tests;
