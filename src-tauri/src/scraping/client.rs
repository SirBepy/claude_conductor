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
