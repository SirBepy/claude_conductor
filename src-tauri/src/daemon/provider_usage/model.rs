//! The one figure shape every provider fetcher fills in. Raw provider JSON
//! never leaves `fetch.rs`: a surface sees only these fields, so a new
//! provider adds a fetcher and no UI branch.
//!
//! Every field is optional or defaulted. `None` means "not known", which is
//! never a limit and never blocks anything (see `routing/limits.rs`).

use serde::{Deserialize, Serialize};

/// A rolling or fixed usage window (a plan's 5h or weekly allowance, an API
/// key's spend cap). Only `label` is always set.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, ts_rs::TS)]
#[serde(default)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct UsageWindow {
    pub label: String,
    /// 0..=100; derived from `used` and `limit` when the provider gives no percent.
    pub used_pct: Option<f64>,
    pub used: Option<f64>,
    pub limit: Option<f64>,
    /// RFC 3339. `None` when the provider does not say when the window refills.
    pub resets_at: Option<String>,
}

/// One currency's remaining balance.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, ts_rs::TS)]
#[serde(default)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct UsageBalance {
    /// ISO code as the provider reports it (`USD`, `CNY`).
    pub currency: String,
    pub amount: f64,
}

/// Spend in dollars over the calendar day, week and month, plus the key's own cap.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, ts_rs::TS)]
#[serde(default)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct UsageSpend {
    pub day: Option<f64>,
    pub week: Option<f64>,
    pub month: Option<f64>,
    pub limit: Option<f64>,
    pub limit_remaining: Option<f64>,
}

/// What one provider account has left, as of `fetched_at`.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, ts_rs::TS)]
#[serde(default)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct ProviderUsage {
    pub account_id: String,
    pub fetched_at: String,
    pub windows: Vec<UsageWindow>,
    /// A pay-per-token account's remaining money, one row per currency.
    pub balances: Vec<UsageBalance>,
    pub spend: Option<UsageSpend>,
    /// The provider's own "can this key be used" flag, when it has one. A
    /// shown warning only: nothing routes or blocks on it.
    pub available: Option<bool>,
    /// Why the figures are missing, already passed through the key masker.
    /// Shown as a tooltip, never as a limit.
    pub error: Option<String>,
    /// The preset the figures came from (`deepseek`, `openrouter`).
    pub source: String,
}

/// What `get_provider_usage` answers: the provider's own figures per account,
/// and the always-available fallback summed from the account's transcripts.
/// Both maps are keyed by account id; an account missing from `usage` has no
/// read yet (or no fetcher), which is "unknown", never a limit.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, ts_rs::TS)]
#[serde(default)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct ProviderUsageView {
    pub usage: std::collections::HashMap<String, ProviderUsage>,
    pub tokens: std::collections::HashMap<String, crate::tokens::account_usage::AccountTokens>,
    /// "Show plan usage" per account that has the switch (Kimi Code), `true`
    /// when turned on. An account absent here has no switch, or never answered
    /// it, which reads as off.
    pub plan_usage: std::collections::HashMap<String, bool>,
}

impl ProviderUsage {
    /// An empty read that says why: the honest "Usage unknown".
    pub fn unknown(account_id: &str, source: &str, error: impl Into<String>) -> Self {
        Self {
            account_id: account_id.to_string(),
            fetched_at: chrono::Utc::now().to_rfc3339(),
            source: source.to_string(),
            error: Some(error.into()),
            ..Default::default()
        }
    }

    /// Equality ignoring `fetched_at`, which moves on every poll: a poll that
    /// found nothing new must not republish the figures.
    pub fn same_content(&self, other: &Self) -> bool {
        let mut a = self.clone();
        a.fetched_at = other.fetched_at.clone();
        a == *other
    }

    /// True while the read is recent enough to say anything about now. Older
    /// than `max_age_secs`, or a timestamp that does not parse, is not fresh.
    pub fn is_fresh(&self, now: i64, max_age_secs: i64) -> bool {
        chrono::DateTime::parse_from_rfc3339(&self.fetched_at)
            .map(|t| now - t.timestamp() <= max_age_secs)
            .unwrap_or(false)
    }
}

impl UsageWindow {
    /// Fills `used_pct` from `used` and `limit` when only those are known.
    pub fn with_derived_pct(mut self) -> Self {
        if self.used_pct.is_none() {
            if let (Some(used), Some(limit)) = (self.used, self.limit) {
                if limit > 0.0 {
                    self.used_pct = Some((used / limit * 100.0).clamp(0.0, 100.0));
                }
            }
        }
        self
    }
}
