//! Console (platform.claude.com) API-credit reads: prepaid balance, spend
//! limits and this month's spend, all cookie-authed JSON GETs under
//! `/api/organizations/{console_org}/`.

use super::client::{http_client, ScrapeError};
use anyhow::{anyhow, Context};
use serde::Deserialize;

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
/// (cents). Unknown fields (`scope`, `granted_at`, ...) are ignored. A missing
/// or null amount is `None` ("not known"), never 0: the cap gate blocks on a
/// known zero only, so reading a null as 0 would stop every turn on data the
/// Console never sent.
#[derive(Deserialize, Clone, Debug, Default, PartialEq)]
pub struct CreditTranche {
    #[serde(default)]
    pub program_id: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub granted_amount_minor_units: Option<i64>,
    #[serde(default)]
    pub remaining_amount_minor_units: Option<i64>,
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scraping::client::fetch_web_account;

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
        assert_eq!(max.granted_amount_minor_units, Some(20000));
        assert_eq!(max.remaining_amount_minor_units, Some(17871));
        assert_eq!(max.expires_at.as_deref(), Some("2026-11-02T00:00:00Z"));
        assert_eq!(c.tranches[0].remaining_amount_minor_units, Some(2545));
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
        // A null amount stays unknown (`None`); it is not folded into 0.
        assert_eq!(c.tranches, vec![CreditTranche::default()]);
        assert_eq!(c.tranches[0].remaining_amount_minor_units, None);
        assert_eq!(c.tranches[0].granted_amount_minor_units, None);
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
        let org = account.api_org().expect("no api-capable org in this session");
        println!("ORG {} caps={:?}", org.uuid, org.capabilities);
        println!("credits: {:?}", fetch_prepaid_credits(CONSOLE_BASE_URL, key, &org.uuid).await);
        let limits = fetch_spend_limits(CONSOLE_BASE_URL, key, &org.uuid).await;
        println!("limits: {limits:?}");
        if let Ok(l) = &limits {
            println!("effective limit (cents): {:?}", l.effective_limit_cents());
        }
        println!("spend: {:?}", fetch_current_spend(CONSOLE_BASE_URL, key, &org.uuid).await);
    }
}
