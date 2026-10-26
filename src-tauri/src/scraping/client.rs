//! Fetches usage JSON from claude.ai using a stored sessionKey cookie.

use crate::types::UsageSnapshot;
use anyhow::{anyhow, Context, Result};
use serde::Deserialize;
use std::time::Duration;

const USER_AGENT: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
     (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/// One entry from `GET /api/organizations`. Widened (multi-account milestone
/// 01) beyond the bare `uuid` so the add-account wizard's cross-check can
/// report a human-readable org name; `name` is best-effort (`None` if the API
/// shape ever changes) and never blocks the uuid-based cross-check itself.
#[derive(Deserialize, Clone, Debug)]
pub struct OrgListEntry {
    pub uuid: String,
    #[serde(default)]
    pub name: Option<String>,
}

/// Identity of the account behind a sessionKey cookie, from
/// `GET /api/account` (validated live 2026-07-08, ai_todo 167): unlike
/// `/api/organizations` this DOES return the email, plus every org the
/// account is a member of. Used by the add-account wizard's browser-cookie
/// identity fallback when the CLI never writes `oauthAccount`.
#[derive(Deserialize, Clone, Debug)]
pub struct WebAccountIdentity {
    pub email_address: String,
    #[serde(default)]
    pub memberships: Vec<WebAccountMembership>,
}

#[derive(Deserialize, Clone, Debug)]
pub struct WebAccountMembership {
    pub organization: WebAccountOrg,
}

/// One org from a membership. `capabilities` matters: a single account can
/// belong to several orgs (observed live: a `["claude_max","chat"]`
/// subscription org AND an `["api","api_individual"]` Console org) - only a
/// chat-capable org is the claude.ai subscription identity we want.
#[derive(Deserialize, Clone, Debug)]
pub struct WebAccountOrg {
    pub uuid: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub capabilities: Vec<String>,
    /// Set on Team/Enterprise orgs instead of a `claude_*` capability string
    /// (observed live 2026-07-09, ai_todo 173: `capabilities: ["raven",
    /// "chat"]`, `raven_type: "team"` - no `claude_team` anywhere). `None` for
    /// plain individual-subscription orgs, which still carry `claude_max`/
    /// `claude_pro` etc. directly in `capabilities`.
    #[serde(default)]
    pub raven_type: Option<String>,
}

impl WebAccountIdentity {
    /// The claude.ai subscription org: first membership whose capabilities
    /// include "chat", falling back to the first membership at all (better a
    /// slightly-off org than a dead-end for a shape we haven't seen).
    pub fn chat_org(&self) -> Option<&WebAccountOrg> {
        self.memberships
            .iter()
            .find(|m| m.organization.capabilities.iter().any(|c| c == "chat"))
            .or_else(|| self.memberships.first())
            .map(|m| &m.organization)
    }
}

impl WebAccountOrg {
    /// Subscription tier in the same vocabulary the CLI's `oauthAccount`
    /// uses for `organizationType` ("claude_max", "claude_pro", ...): the
    /// first `claude_*` capability. Team/Enterprise orgs don't carry one of
    /// those - they signal their tier via `raven_type` instead (ai_todo 173)
    /// - so fall back to `"claude_" + raven_type` (e.g. `raven_type: "team"`
    /// -> `"claude_team"`), which lines up with `tierLabel()`'s `KNOWN_TIERS`
    /// map on the frontend. `None` only when neither source states a tier.
    pub fn subscription_tier(&self) -> Option<String> {
        self.capabilities
            .iter()
            .find(|c| c.starts_with("claude_"))
            .cloned()
            .or_else(|| self.raven_type.as_deref().map(|t| format!("claude_{t}")))
    }
}

/// Errors that callers may want to react to distinctly.
#[derive(thiserror::Error, Debug)]
pub enum ScrapeError {
    #[error("unauthorized (session expired)")]
    Unauthorized,
    #[error("forbidden")]
    Forbidden,
    #[error("no organizations returned")]
    NoOrgs,
    /// The requested `org_uuid` was not present in this session's org list.
    /// Distinct from `NoOrgs` so per-account poll isolation (milestone 03)
    /// can log which account's expected org went missing rather than a bare
    /// "no orgs" message.
    #[error("organization {0} not found in this session's org list")]
    OrgNotFound(String),
    #[error(transparent)]
    Other(#[from] anyhow::Error),
}

fn http_client() -> Result<reqwest::Client, ScrapeError> {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(Duration::from_secs(10))
        .build()
        .context("building http client")
        .map_err(ScrapeError::Other)
}

/// `GET /api/organizations` for the session behind `session_key`. Used both
/// by `fetch_usage` (org id needed for the usage call) and the add-account
/// wizard's cross-check (does the web cookie's org list contain the CLI
/// login's `organizationUuid`?).
pub async fn fetch_org_list(base_url: &str, session_key: &str)
    -> Result<Vec<OrgListEntry>, ScrapeError>
{
    let client = http_client()?;
    let cookie_header = format!("sessionKey={session_key}");
    let orgs_url = format!("{base_url}/api/organizations");
    let orgs_resp = client.get(&orgs_url)
        .header("cookie", &cookie_header)
        .header("accept", "application/json")
        .header("referer", format!("{base_url}/settings/usage"))
        .send().await
        .context("GET /api/organizations")
        .map_err(ScrapeError::Other)?;

    let status = orgs_resp.status();
    if status.as_u16() == 401 { return Err(ScrapeError::Unauthorized); }
    if status.as_u16() == 403 { return Err(ScrapeError::Forbidden); }
    if !status.is_success() {
        return Err(ScrapeError::Other(anyhow!(
            "organizations HTTP {}",
            status.as_u16()
        )));
    }

    orgs_resp.json().await.context("parsing org list").map_err(ScrapeError::Other)
}

/// `GET /api/account` for the session behind `session_key`: the account's
/// email + org memberships. The add-account wizard's cookie-identity fallback
/// (ai_todo 167) uses this when the profile dir has valid credentials but the
/// CLI never wrote `oauthAccount`.
pub async fn fetch_web_account(base_url: &str, session_key: &str)
    -> Result<WebAccountIdentity, ScrapeError>
{
    let client = http_client()?;
    let url = format!("{base_url}/api/account");
    let resp = client.get(&url)
        .header("cookie", format!("sessionKey={session_key}"))
        .header("accept", "application/json")
        .header("referer", format!("{base_url}/settings/usage"))
        .send().await
        .context("GET /api/account")
        .map_err(ScrapeError::Other)?;

    let status = resp.status();
    if status.as_u16() == 401 { return Err(ScrapeError::Unauthorized); }
    if status.as_u16() == 403 { return Err(ScrapeError::Forbidden); }
    if !status.is_success() {
        return Err(ScrapeError::Other(anyhow!("account HTTP {}", status.as_u16())));
    }

    resp.json().await.context("parsing account identity").map_err(ScrapeError::Other)
}

/// Console host for the API-credit reads below. claude.ai answers the same
/// routes, but platform.claude.com is what the Console itself calls.
pub const CONSOLE_BASE_URL: &str = "https://platform.claude.com";

/// Deserializes `null` as the type's default. `#[serde(default)]` alone only
/// covers an ABSENT key, and an explicit `null` from these undocumented
/// routes must not fail the whole parse either.
fn null_as_default<'de, D, T>(d: D) -> Result<T, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Default + Deserialize<'de>,
{
    Ok(Option::<T>::deserialize(d)?.unwrap_or_default())
}

/// One credit grant from `prepaid/credits`. Amounts are in minor units
/// (cents). Unknown fields (`scope`, `granted_at`, ...) are ignored.
#[derive(Deserialize, Clone, Debug, Default, PartialEq)]
pub struct CreditTranche {
    #[serde(default)]
    pub program_id: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default, deserialize_with = "null_as_default")]
    pub granted_amount_minor_units: i64,
    #[serde(default, deserialize_with = "null_as_default")]
    pub remaining_amount_minor_units: i64,
    #[serde(default)]
    pub expires_at: Option<String>,
}

/// `GET /api/organizations/{console_org}/prepaid/credits`. The Max plan's
/// monthly grant is in `promo_tranches` (`program_id` `subscription_api_credit`);
/// purchased credit is in `tranches`.
#[derive(Deserialize, Clone, Debug, Default, PartialEq)]
pub struct PrepaidCredits {
    #[serde(default, deserialize_with = "null_as_default")]
    pub amount: i64,
    #[serde(default, deserialize_with = "null_as_default")]
    pub currency: String,
    #[serde(default, deserialize_with = "null_as_default")]
    pub promo_tranches: Vec<CreditTranche>,
    #[serde(default, deserialize_with = "null_as_default")]
    pub tranches: Vec<CreditTranche>,
}

/// One Console spend limit. `limit_usd` is in CENTS despite the name (live
/// 2026-10-26: `20000` for a $200 limit).
#[derive(Deserialize, Clone, Debug, Default, PartialEq)]
pub struct SpendLimit {
    #[serde(default, deserialize_with = "null_as_default")]
    pub limit_usd: i64,
    #[serde(default, deserialize_with = "null_as_default")]
    pub limit_action: String,
}

/// `GET /api/organizations/{console_org}/spend_limits`.
#[derive(Deserialize, Clone, Debug, Default, PartialEq)]
pub struct SpendLimits {
    #[serde(default, deserialize_with = "null_as_default")]
    pub spend_limits: Vec<SpendLimit>,
    /// The organisation-wide ceiling, also in cents.
    #[serde(default)]
    pub enforced_limit_usd: Option<i64>,
}

impl SpendLimits {
    /// The limit that actually stops spend, in cents: the lowest positive
    /// `notify_and_pause` entry or `enforced_limit_usd`. A `notify`-only limit
    /// never pauses anything, so it is not a cap. `None` when nothing applies.
    pub fn effective_limit_cents(&self) -> Option<i64> {
        self.spend_limits
            .iter()
            .filter(|l| l.limit_action == "notify_and_pause" && l.limit_usd > 0)
            .map(|l| l.limit_usd)
            .chain(self.enforced_limit_usd.filter(|v| *v > 0))
            .min()
    }
}

/// `GET /api/organizations/{console_org}/current_spend`: this calendar month's
/// spend (UTC), in cents. Max-credit spend counts toward it.
#[derive(Deserialize, Clone, Debug, Default, PartialEq)]
pub struct CurrentSpend {
    #[serde(default, deserialize_with = "null_as_default")]
    pub amount: i64,
    #[serde(default)]
    pub resets_at: Option<String>,
}

/// One cookie-authed JSON GET under `/api/organizations/{org_uuid}/{path}`,
/// with the 401/403 mapping every fetcher in this file shares. `what` only
/// labels the error context.
async fn fetch_org_json<T: serde::de::DeserializeOwned>(
    base_url: &str,
    session_key: &str,
    org_uuid: &str,
    path: &str,
    referer_page: &str,
    what: &str,
) -> Result<T, ScrapeError> {
    let client = http_client()?;
    let url = format!("{base_url}/api/organizations/{org_uuid}/{path}");
    let resp = client.get(&url)
        .header("cookie", format!("sessionKey={session_key}"))
        .header("accept", "application/json")
        .header("referer", format!("{base_url}/{referer_page}"))
        .send().await
        .with_context(|| format!("GET {what}"))
        .map_err(ScrapeError::Other)?;

    let status = resp.status();
    if status.as_u16() == 401 { return Err(ScrapeError::Unauthorized); }
    if status.as_u16() == 403 { return Err(ScrapeError::Forbidden); }
    if !status.is_success() {
        return Err(ScrapeError::Other(anyhow!("{what} HTTP {}", status.as_u16())));
    }

    resp.json().await
        .with_context(|| format!("parsing {what}"))
        .map_err(ScrapeError::Other)
}

/// The prepaid API-credit balance that the Console's Billing page shows (route
/// found in the claude.ai web bundle; there is no public API). Needs the
/// CONSOLE org and a Console `sessionKey`: the claude.ai cookie gets 403.
pub async fn fetch_prepaid_credits(base_url: &str, session_key: &str, org_uuid: &str)
    -> Result<PrepaidCredits, ScrapeError>
{
    fetch_org_json(base_url, session_key, org_uuid, "prepaid/credits", "settings/billing", "prepaid credits").await
}

/// The Console spend limits for `org_uuid`. Doubles as the cheapest check that
/// a pasted Console cookie works for that org.
pub async fn fetch_spend_limits(base_url: &str, session_key: &str, org_uuid: &str)
    -> Result<SpendLimits, ScrapeError>
{
    fetch_org_json(base_url, session_key, org_uuid, "spend_limits", "settings/limits", "spend limits").await
}

/// This month's Console spend for `org_uuid`.
pub async fn fetch_current_spend(base_url: &str, session_key: &str, org_uuid: &str)
    -> Result<CurrentSpend, ScrapeError>
{
    fetch_org_json(base_url, session_key, org_uuid, "current_spend", "settings/limits", "current spend").await
}

/// Fetches current usage, always scraping the FIRST org in the session's org
/// list. This is the legacy single-cookie behavior (`docs/multi-account/
/// 03-per-account-usage.md`'s migration bridge): correct only when the
/// session belongs to exactly one org, or the caller doesn't care which.
/// `base_url` is injected for tests; production passes `"https://claude.ai"`.
pub async fn fetch_usage(base_url: &str, session_key: &str)
    -> Result<UsageSnapshot, ScrapeError>
{
    fetch_usage_for_org(base_url, session_key, None).await
}

/// Fetches current usage for a specific org. `org_uuid = Some(uuid)` selects
/// that org by id (used for every registered account, which knows its own
/// `org_uuid` - an email that is a member of multiple orgs would otherwise
/// silently scrape the wrong one via `orgs.first()`); `None` falls back to
/// the legacy first-org behavior. `base_url` is injected for tests.
pub async fn fetch_usage_for_org(base_url: &str, session_key: &str, org_uuid: Option<&str>)
    -> Result<UsageSnapshot, ScrapeError>
{
    let client = http_client()?;
    let cookie_header = format!("sessionKey={session_key}");

    let orgs = fetch_org_list(base_url, session_key).await?;
    let org_id = match org_uuid {
        Some(uuid) => orgs.iter().find(|o| o.uuid == uuid)
            .ok_or_else(|| ScrapeError::OrgNotFound(uuid.to_string()))?
            .uuid.clone(),
        None => orgs.first().ok_or(ScrapeError::NoOrgs)?.uuid.clone(),
    };

    // 2. Get usage
    let usage_url = format!("{base_url}/api/organizations/{org_id}/usage");
    let usage_resp = client.get(&usage_url)
        .header("cookie", &cookie_header)
        .header("accept", "application/json")
        .header("referer", format!("{base_url}/settings/usage"))
        .send().await
        .context("GET usage").map_err(ScrapeError::Other)?;

    let status = usage_resp.status();
    if status.as_u16() == 401 { return Err(ScrapeError::Unauthorized); }
    if status.as_u16() == 403 { return Err(ScrapeError::Forbidden); }
    if !status.is_success() {
        return Err(ScrapeError::Other(anyhow!(
            "usage HTTP {}",
            status.as_u16()
        )));
    }

    // The API returns { five_hour, seven_day, extra_usage } without a
    // captured_at field; we stamp that ourselves.
    #[derive(Deserialize)]
    struct RawUsage {
        five_hour: crate::types::WindowUsage,
        seven_day: crate::types::WindowUsage,
        #[serde(default)]
        extra_usage: Option<crate::types::ExtraUsage>,
    }
    let raw: RawUsage = usage_resp.json().await
        .context("parsing usage").map_err(ScrapeError::Other)?;

    Ok(UsageSnapshot {
        captured_at: chrono::Utc::now().to_rfc3339(),
        five_hour: raw.five_hour,
        seven_day: raw.seven_day,
        extra_usage: raw.extra_usage,
        // The caller (scheduler) stamps `account_id` once it knows which
        // registered account this fetch was for; `fetch_usage_for_org` only
        // knows the org uuid used for selection, not the app-level account id.
        account_id: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // Shapes quoted from the live Console responses (2026-10-26). The prepaid
    // body is trimmed to the documented fields plus the extras (`scope`,
    // `granted_at`) the parse has to ignore.
    const PREPAID_BODY: &str = r#"{
        "amount": 20416,
        "currency": "USD",
        "promo_tranches": [{
            "name": "API credit (Max 20x)",
            "program_id": "subscription_api_credit",
            "granted_amount_minor_units": 20000,
            "remaining_amount_minor_units": 17871,
            "expires_at": "2026-11-02T00:00:00Z",
            "granted_at": "2026-10-02T00:00:00Z",
            "scope": {"applies_to": [{"product": "api"}, {"product": "agent_sdk"}]}
        }],
        "tranches": [{
            "program_id": "api_credits",
            "granted_amount_minor_units": 5000,
            "remaining_amount_minor_units": 2545,
            "expires_at": null
        }]
    }"#;
    const SPEND_LIMITS_BODY: &str = r#"{"spend_limits":[{"id":"sl_1","limit_usd":20000,"limit_action":"notify_and_pause","type":"self_selected_spend_limit","triggered_until":null,"ignored_until":null}],"enforced_limit_usd":20000000}"#;
    const CURRENT_SPEND_BODY: &str = r#"{"amount":2128,"resets_at":"2026-11-01T00:00:00Z"}"#;

    #[tokio::test]
    async fn prepaid_credits_parses_the_live_shape_and_maps_errors() {
        let mut server = mockito::Server::new_async().await;
        let _ok = server.mock("GET", "/api/organizations/ORG-API/prepaid/credits")
            .match_header("cookie", "sessionKey=sk-abc")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(PREPAID_BODY)
            .create_async().await;
        let _denied = server.mock("GET", "/api/organizations/ORG-X/prepaid/credits")
            .with_status(403)
            .create_async().await;
        let _expired = server.mock("GET", "/api/organizations/ORG-401/prepaid/credits")
            .with_status(401)
            .create_async().await;
        let _boom = server.mock("GET", "/api/organizations/ORG-500/prepaid/credits")
            .with_status(500)
            .create_async().await;

        let c = fetch_prepaid_credits(&server.url(), "sk-abc", "ORG-API").await.unwrap();
        assert_eq!(c.amount, 20416);
        assert_eq!(c.currency, "USD");
        assert_eq!(c.promo_tranches.len(), 1);
        let max = &c.promo_tranches[0];
        assert_eq!(max.program_id.as_deref(), Some("subscription_api_credit"));
        assert_eq!(max.granted_amount_minor_units, 20000);
        assert_eq!(max.remaining_amount_minor_units, 17871);
        assert_eq!(max.expires_at.as_deref(), Some("2026-11-02T00:00:00Z"));
        assert_eq!(c.tranches[0].remaining_amount_minor_units, 2545);
        assert_eq!(c.tranches[0].expires_at, None);
        assert!(matches!(
            fetch_prepaid_credits(&server.url(), "sk-abc", "ORG-X").await,
            Err(ScrapeError::Forbidden)
        ));
        assert!(matches!(
            fetch_prepaid_credits(&server.url(), "sk-abc", "ORG-401").await,
            Err(ScrapeError::Unauthorized)
        ));
        assert!(matches!(
            fetch_prepaid_credits(&server.url(), "sk-abc", "ORG-500").await,
            Err(ScrapeError::Other(_))
        ));
    }

    #[test]
    fn prepaid_credits_tolerates_missing_and_null_fields() {
        let c: PrepaidCredits = serde_json::from_str(
            r#"{"amount": null, "promo_tranches": null, "tranches": [{"remaining_amount_minor_units": null, "future": 1}], "future_field": {}}"#,
        ).unwrap();
        assert_eq!(c.amount, 0);
        assert!(c.promo_tranches.is_empty());
        assert_eq!(c.tranches, vec![CreditTranche::default()]);
        assert_eq!(serde_json::from_str::<PrepaidCredits>("{}").unwrap(), PrepaidCredits::default());
    }

    #[tokio::test]
    async fn spend_limits_parse_the_live_shape_and_map_errors() {
        let mut server = mockito::Server::new_async().await;
        let _ok = server.mock("GET", "/api/organizations/ORG-API/spend_limits")
            .match_header("cookie", "sessionKey=sk-abc")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(SPEND_LIMITS_BODY)
            .create_async().await;
        let _denied = server.mock("GET", "/api/organizations/ORG-X/spend_limits")
            .with_status(403)
            .create_async().await;
        let _expired = server.mock("GET", "/api/organizations/ORG-401/spend_limits")
            .with_status(401)
            .create_async().await;

        let l = fetch_spend_limits(&server.url(), "sk-abc", "ORG-API").await.unwrap();
        assert_eq!(l.spend_limits.len(), 1);
        assert_eq!(l.spend_limits[0].limit_usd, 20000);
        assert_eq!(l.spend_limits[0].limit_action, "notify_and_pause");
        assert_eq!(l.enforced_limit_usd, Some(20_000_000));
        assert_eq!(l.effective_limit_cents(), Some(20000));
        assert!(matches!(
            fetch_spend_limits(&server.url(), "sk-abc", "ORG-X").await,
            Err(ScrapeError::Forbidden)
        ));
        assert!(matches!(
            fetch_spend_limits(&server.url(), "sk-abc", "ORG-401").await,
            Err(ScrapeError::Unauthorized)
        ));
    }

    #[test]
    fn effective_limit_is_the_lowest_pausing_limit() {
        let limits = |entries: &[(i64, &str)], enforced: Option<i64>| SpendLimits {
            spend_limits: entries
                .iter()
                .map(|(v, a)| SpendLimit { limit_usd: *v, limit_action: (*a).into() })
                .collect(),
            enforced_limit_usd: enforced,
        };
        assert_eq!(limits(&[], None).effective_limit_cents(), None);
        assert_eq!(limits(&[], Some(5000)).effective_limit_cents(), Some(5000));
        assert_eq!(
            limits(&[(20000, "notify_and_pause"), (3000, "notify_and_pause")], Some(9000)).effective_limit_cents(),
            Some(3000)
        );
        // A notify-only limit never pauses spend, and a zero limit is "unset".
        assert_eq!(limits(&[(100, "notify")], None).effective_limit_cents(), None);
        assert_eq!(limits(&[(0, "notify_and_pause")], Some(0)).effective_limit_cents(), None);
        assert_eq!(limits(&[(100, "notify"), (4000, "notify_and_pause")], None).effective_limit_cents(), Some(4000));
    }

    #[tokio::test]
    async fn current_spend_parses_the_live_shape_and_maps_errors() {
        let mut server = mockito::Server::new_async().await;
        let _ok = server.mock("GET", "/api/organizations/ORG-API/current_spend")
            .match_header("cookie", "sessionKey=sk-abc")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(CURRENT_SPEND_BODY)
            .create_async().await;
        let _denied = server.mock("GET", "/api/organizations/ORG-X/current_spend")
            .with_status(403)
            .create_async().await;
        let _boom = server.mock("GET", "/api/organizations/ORG-500/current_spend")
            .with_status(502)
            .create_async().await;

        let s = fetch_current_spend(&server.url(), "sk-abc", "ORG-API").await.unwrap();
        assert_eq!(s, CurrentSpend { amount: 2128, resets_at: Some("2026-11-01T00:00:00Z".into()) });
        assert!(matches!(
            fetch_current_spend(&server.url(), "sk-abc", "ORG-X").await,
            Err(ScrapeError::Forbidden)
        ));
        assert!(matches!(
            fetch_current_spend(&server.url(), "sk-abc", "ORG-500").await,
            Err(ScrapeError::Other(_))
        ));
    }

    /// Live, read-only: prints the typed credit, limit and spend reads for the
    /// `api`-capable org of the Console session named by `CC_LIVE_SESSION_FILE`.
    /// Run with `cargo test --lib -- --ignored live_prepaid_credits --nocapture`.
    #[tokio::test]
    #[ignore]
    async fn live_prepaid_credits() {
        let path = std::env::var("CC_LIVE_SESSION_FILE").expect("set CC_LIVE_SESSION_FILE");
        let stored = std::fs::read_to_string(path).unwrap();
        // Accepts a stored session file or a request_secret `KEY=value` file.
        let stored = stored.trim();
        let stored = stored.strip_prefix("CONSOLE_SESSION_KEY=").unwrap_or(stored);
        let key = crate::util::secret_store::unprotect(stored).unwrap();
        let key = key.trim();
        let account = fetch_web_account("https://claude.ai", key).await.unwrap();
        let org = account
            .memberships
            .iter()
            .map(|m| &m.organization)
            .find(|o| o.capabilities.iter().any(|c| c == "api"))
            .expect("no api-capable org in this session");
        println!("ORG {} caps={:?}", org.uuid, org.capabilities);
        println!("credits: {:?}", fetch_prepaid_credits(CONSOLE_BASE_URL, key, &org.uuid).await);
        let limits = fetch_spend_limits(CONSOLE_BASE_URL, key, &org.uuid).await;
        println!("limits: {limits:?}");
        if let Ok(l) = &limits {
            println!("effective limit (cents): {:?}", l.effective_limit_cents());
        }
        println!("spend: {:?}", fetch_current_spend(CONSOLE_BASE_URL, key, &org.uuid).await);
    }

    #[tokio::test]
    async fn happy_path_returns_snapshot() {
        let mut server = mockito::Server::new_async().await;
        let _m1 = server.mock("GET", "/api/organizations")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"[{"uuid":"ORG-1"}]"#)
            .create_async().await;
        let _m2 = server.mock("GET", "/api/organizations/ORG-1/usage")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"{
                "five_hour": {"utilization": 10.0, "resets_at": "x"},
                "seven_day": {"utilization": 5.0, "resets_at": "y"}
            }"#)
            .create_async().await;

        let snap = fetch_usage(&server.url(), "sk-abc").await.unwrap();
        assert_eq!(snap.five_hour.utilization, 10.0);
        assert_eq!(snap.seven_day.utilization, 5.0);
    }

    #[tokio::test]
    async fn unauthorized_on_401() {
        let mut server = mockito::Server::new_async().await;
        let _m = server.mock("GET", "/api/organizations")
            .with_status(401).create_async().await;
        let err = fetch_usage(&server.url(), "sk-bad").await.unwrap_err();
        assert!(matches!(err, ScrapeError::Unauthorized));
    }

    #[tokio::test]
    async fn fetch_org_list_captures_name_when_present() {
        let mut server = mockito::Server::new_async().await;
        let _m = server.mock("GET", "/api/organizations")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"[{"uuid":"ORG-1","name":"Fibo Studio"}]"#)
            .create_async().await;
        let orgs = fetch_org_list(&server.url(), "sk-abc").await.unwrap();
        assert_eq!(orgs.len(), 1);
        assert_eq!(orgs[0].uuid, "ORG-1");
        assert_eq!(orgs[0].name.as_deref(), Some("Fibo Studio"));
    }

    #[tokio::test]
    async fn fetch_org_list_name_defaults_to_none_when_absent() {
        let mut server = mockito::Server::new_async().await;
        let _m = server.mock("GET", "/api/organizations")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"[{"uuid":"ORG-1"}]"#)
            .create_async().await;
        let orgs = fetch_org_list(&server.url(), "sk-abc").await.unwrap();
        assert_eq!(orgs[0].name, None);
    }

    // Trimmed live /api/account shape (2026-07-08): a Max subscription org
    // plus an API-only Console org on the same email.
    const ACCOUNT_BODY: &str = r#"{
        "uuid": "acct-uuid",
        "email_address": "joe@example.com",
        "display_name": "Joe",
        "memberships": [
            {"organization": {"uuid": "ORG-API", "name": "Individual Org", "capabilities": ["api", "api_individual"]}},
            {"organization": {"uuid": "ORG-CHAT", "name": "Joe's Organization", "capabilities": ["claude_max", "chat"]}}
        ]
    }"#;

    #[tokio::test]
    async fn fetch_web_account_parses_email_and_picks_chat_org() {
        let mut server = mockito::Server::new_async().await;
        let _m = server.mock("GET", "/api/account")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(ACCOUNT_BODY)
            .create_async().await;
        let account = fetch_web_account(&server.url(), "sk-abc").await.unwrap();
        assert_eq!(account.email_address, "joe@example.com");
        let org = account.chat_org().expect("expected a chat org");
        assert_eq!(org.uuid, "ORG-CHAT", "must pick the chat-capable org, not the first");
        assert_eq!(org.name.as_deref(), Some("Joe's Organization"));
        assert_eq!(org.subscription_tier().as_deref(), Some("claude_max"));
    }

    #[tokio::test]
    async fn fetch_web_account_unauthorized_on_401() {
        let mut server = mockito::Server::new_async().await;
        let _m = server.mock("GET", "/api/account")
            .with_status(401).create_async().await;
        let err = fetch_web_account(&server.url(), "sk-bad").await.unwrap_err();
        assert!(matches!(err, ScrapeError::Unauthorized));
    }

    #[test]
    fn subscription_tier_falls_back_to_raven_type_for_team_orgs() {
        // Trimmed live shape (ai_todo 173, 2026-07-09): a Team org has no
        // `claude_*` capability at all - the tier only shows up as
        // `raven_type`. `capabilities: ["raven","chat"]` alone must not
        // resolve to a tier; `raven_type` is what makes it "claude_team".
        let org: WebAccountOrg = serde_json::from_str(
            r#"{"uuid": "ORG-TEAM", "capabilities": ["raven", "chat"], "raven_type": "team"}"#,
        ).unwrap();
        assert_eq!(org.subscription_tier().as_deref(), Some("claude_team"));
    }

    #[test]
    fn chat_org_falls_back_to_first_membership_when_none_chat_capable() {
        let account: WebAccountIdentity = serde_json::from_str(r#"{
            "email_address": "a@x.com",
            "memberships": [
                {"organization": {"uuid": "ORG-1", "capabilities": ["api"]}},
                {"organization": {"uuid": "ORG-2"}}
            ]
        }"#).unwrap();
        assert_eq!(account.chat_org().unwrap().uuid, "ORG-1");
        assert_eq!(account.chat_org().unwrap().subscription_tier(), None);
    }

    #[test]
    fn chat_org_none_when_no_memberships() {
        let account: WebAccountIdentity =
            serde_json::from_str(r#"{"email_address": "a@x.com"}"#).unwrap();
        assert!(account.chat_org().is_none());
    }

    #[tokio::test]
    async fn no_orgs_returns_no_orgs_error() {
        let mut server = mockito::Server::new_async().await;
        let _m = server.mock("GET", "/api/organizations")
            .with_status(200).with_body("[]")
            .create_async().await;
        let err = fetch_usage(&server.url(), "sk").await.unwrap_err();
        assert!(matches!(err, ScrapeError::NoOrgs));
    }

    /// Milestone 03 correctness fix: a session that's a member of multiple
    /// orgs must scrape the org matching the account's `org_uuid`, NOT
    /// whichever happens to sort first.
    #[tokio::test]
    async fn fetch_usage_for_org_selects_requested_uuid_not_first() {
        let mut server = mockito::Server::new_async().await;
        let _m1 = server.mock("GET", "/api/organizations")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"[{"uuid":"ORG-1"},{"uuid":"ORG-2"}]"#)
            .create_async().await;
        // Only ORG-2's usage endpoint is mocked; if the code ever regresses
        // to orgs.first(), this test fails with a connection/404 error
        // instead of the expected snapshot.
        let _m2 = server.mock("GET", "/api/organizations/ORG-2/usage")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"{
                "five_hour": {"utilization": 42.0, "resets_at": "x"},
                "seven_day": {"utilization": 11.0, "resets_at": "y"}
            }"#)
            .create_async().await;

        let snap = fetch_usage_for_org(&server.url(), "sk-abc", Some("ORG-2")).await.unwrap();
        assert_eq!(snap.five_hour.utilization, 42.0);
    }

    #[tokio::test]
    async fn fetch_usage_for_org_none_falls_back_to_first() {
        let mut server = mockito::Server::new_async().await;
        let _m1 = server.mock("GET", "/api/organizations")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"[{"uuid":"ORG-1"},{"uuid":"ORG-2"}]"#)
            .create_async().await;
        let _m2 = server.mock("GET", "/api/organizations/ORG-1/usage")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"{
                "five_hour": {"utilization": 5.0, "resets_at": "x"},
                "seven_day": {"utilization": 2.0, "resets_at": "y"}
            }"#)
            .create_async().await;

        let snap = fetch_usage_for_org(&server.url(), "sk-abc", None).await.unwrap();
        assert_eq!(snap.five_hour.utilization, 5.0);
    }

    #[tokio::test]
    async fn fetch_usage_for_org_missing_uuid_is_org_not_found() {
        let mut server = mockito::Server::new_async().await;
        let _m = server.mock("GET", "/api/organizations")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"[{"uuid":"ORG-1"}]"#)
            .create_async().await;
        let err = fetch_usage_for_org(&server.url(), "sk-abc", Some("ORG-GHOST")).await.unwrap_err();
        assert!(matches!(err, ScrapeError::OrgNotFound(ref u) if u == "ORG-GHOST"));
    }
}
