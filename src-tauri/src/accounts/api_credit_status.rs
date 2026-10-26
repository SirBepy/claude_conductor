//! What an `ApiCredit` account has left, read from the Console, and whether
//! new turns on it must stop. Three reads feed it (`scraping::client`): the
//! prepaid credit tranches, the Console spend limits, and this month's spend.
//! Everything here is pure except `fetch_status`, so the block rules are
//! testable against the exact numbers seen live.

use crate::scraping::{
    fetch_current_spend, fetch_prepaid_credits, fetch_spend_limits, CurrentSpend, PrepaidCredits,
    ScrapeError, SpendLimits,
};
use serde::{Deserialize, Serialize};

/// `program_id` of the Max plan's monthly API-credit grant (live 2026-10-26).
/// Any other tranche is purchased credit.
const MAX_GRANT_PROGRAM_ID: &str = "subscription_api_credit";

/// Shown in `ApiCreditStatus::error` when no Console cookie is stored.
pub const ERR_NOT_CONNECTED: &str = "Console not connected";
/// Shown in `ApiCreditStatus::error` on a 401/403 from the Console.
pub const ERR_LOGIN_EXPIRED: &str = "Console login expired";

/// One account's credit picture. All amounts are cents. `None` means "not
/// known", which never blocks: a missing cookie or a failed read must not stop
/// a chat that may well have credit left.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, ts_rs::TS)]
#[serde(default)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct ApiCreditStatus {
    pub account_id: String,
    /// Left in the Max plan's monthly grant (`subscription_api_credit`).
    #[ts(type = "number | null")]
    pub max_grant_remaining_cents: Option<i64>,
    #[ts(type = "number | null")]
    pub max_grant_total_cents: Option<i64>,
    /// When the grant lapses (the billing cycle's end).
    pub max_grant_expires_at: Option<String>,
    /// Left across every other tranche. Chats never draw it on purpose: the
    /// block below stops them when the Max grant hits zero.
    #[ts(type = "number | null")]
    pub purchased_remaining_cents: Option<i64>,
    /// This calendar month's Console spend (Max-credit spend counts).
    #[ts(type = "number | null")]
    pub spend_cents: Option<i64>,
    /// The Console spend limit that pauses spend.
    #[ts(type = "number | null")]
    pub limit_cents: Option<i64>,
    pub spend_resets_at: Option<String>,
    pub fetched_at: String,
    pub blocked: bool,
    pub block_reason: Option<String>,
    pub error: Option<String>,
}

impl ApiCreditStatus {
    /// Equality ignoring `fetched_at`, which changes on every poll: a poll that
    /// found nothing new must not republish the status.
    pub fn same_content(&self, other: &Self) -> bool {
        let mut a = self.clone();
        a.fetched_at = other.fetched_at.clone();
        a == *other
    }
}

/// `2026-11-02T00:00:00Z` -> `2026-11-02`; anything unparseable passes through.
fn short_date(ts: &str) -> String {
    chrono::DateTime::parse_from_rfc3339(ts)
        .map(|d| d.format("%Y-%m-%d").to_string())
        .unwrap_or_else(|_| ts.to_string())
}

fn resets_clause(ts: Option<&str>) -> String {
    ts.map(|t| format!(", resets {}", short_date(t))).unwrap_or_default()
}

fn dollars(cents: i64) -> String {
    if cents % 100 == 0 {
        format!("${}", cents / 100)
    } else {
        format!("${}.{:02}", cents / 100, (cents % 100).abs())
    }
}

/// Whether a new turn on this account must be refused, and why. Blocks when
/// the Max grant is spent (so purchased credit is never drained by chats) or
/// when Console spend has reached the spend limit. Unknown figures never block.
pub fn compute_block(s: &ApiCreditStatus) -> (bool, Option<String>) {
    if let Some(remaining) = s.max_grant_remaining_cents {
        if remaining <= 0 {
            let reason = format!(
                "API credit for this cycle is used up{}",
                resets_clause(s.max_grant_expires_at.as_deref())
            );
            return (true, Some(reason));
        }
    }
    if let (Some(limit), Some(spend)) = (s.limit_cents, s.spend_cents) {
        if spend >= limit {
            let reason = format!(
                "Console spend limit {} reached{}",
                dollars(limit),
                resets_clause(s.spend_resets_at.as_deref())
            );
            return (true, Some(reason));
        }
    }
    (false, None)
}

/// Folds the three Console reads into a status. A 401/403 on any read means
/// the cookie is no good, so nothing else it returned is trusted and the
/// status is the plain "login expired" one. Any other failure only blanks its
/// own figures.
pub fn build_status(
    account_id: &str,
    fetched_at: &str,
    credits: Result<PrepaidCredits, ScrapeError>,
    limits: Result<SpendLimits, ScrapeError>,
    spend: Result<CurrentSpend, ScrapeError>,
) -> ApiCreditStatus {
    let mut status = ApiCreditStatus {
        account_id: account_id.to_string(),
        fetched_at: fetched_at.to_string(),
        ..Default::default()
    };
    let auth_failed = |e: &ScrapeError| matches!(e, ScrapeError::Unauthorized | ScrapeError::Forbidden);
    if [credits.as_ref().err(), limits.as_ref().err(), spend.as_ref().err()]
        .into_iter()
        .flatten()
        .any(auth_failed)
    {
        status.error = Some(ERR_LOGIN_EXPIRED.to_string());
        return status;
    }

    let mut errors = Vec::new();
    match credits {
        Ok(c) => {
            let (max, other): (Vec<_>, Vec<_>) = c
                .promo_tranches
                .iter()
                .chain(c.tranches.iter())
                .partition(|t| t.program_id.as_deref() == Some(MAX_GRANT_PROGRAM_ID));
            if !max.is_empty() {
                status.max_grant_remaining_cents = Some(max.iter().map(|t| t.remaining_amount_minor_units).sum());
                status.max_grant_total_cents = Some(max.iter().map(|t| t.granted_amount_minor_units).sum());
                status.max_grant_expires_at = max.iter().filter_map(|t| t.expires_at.clone()).min();
            }
            status.purchased_remaining_cents = Some(other.iter().map(|t| t.remaining_amount_minor_units).sum());
        }
        Err(e) => errors.push(format!("credit balance: {e:#}")),
    }
    match limits {
        Ok(l) => status.limit_cents = l.effective_limit_cents(),
        Err(e) => errors.push(format!("spend limit: {e:#}")),
    }
    match spend {
        Ok(s) => {
            status.spend_cents = Some(s.amount);
            status.spend_resets_at = s.resets_at;
        }
        Err(e) => errors.push(format!("current spend: {e:#}")),
    }
    if !errors.is_empty() {
        status.error = Some(errors.join("; "));
    }
    let (blocked, reason) = compute_block(&status);
    status.blocked = blocked;
    status.block_reason = reason;
    status
}

/// Reads the Console for `org_uuid` and builds the status. `session_key: None`
/// (no cookie stored) is a status with `ERR_NOT_CONNECTED`, not an error.
pub async fn fetch_status(
    base_url: &str,
    account_id: &str,
    org_uuid: &str,
    session_key: Option<&str>,
) -> ApiCreditStatus {
    let fetched_at = chrono::Utc::now().to_rfc3339();
    let Some(key) = session_key else {
        return ApiCreditStatus {
            account_id: account_id.to_string(),
            fetched_at,
            error: Some(ERR_NOT_CONNECTED.to_string()),
            ..Default::default()
        };
    };
    let (credits, limits, spend) = tokio::join!(
        fetch_prepaid_credits(base_url, key, org_uuid),
        fetch_spend_limits(base_url, key, org_uuid),
        fetch_current_spend(base_url, key, org_uuid),
    );
    build_status(account_id, &fetched_at, credits, limits, spend)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scraping::{CreditTranche, SpendLimit};

    fn tranche(program: &str, granted: i64, remaining: i64, expires: Option<&str>) -> CreditTranche {
        CreditTranche {
            program_id: Some(program.into()),
            name: None,
            granted_amount_minor_units: granted,
            remaining_amount_minor_units: remaining,
            expires_at: expires.map(String::from),
        }
    }

    /// The live numbers of 2026-10-26: $178.71 left of the $200 grant, $21.28
    /// spent against a $200 limit.
    fn live_status() -> ApiCreditStatus {
        ApiCreditStatus {
            account_id: "a".into(),
            max_grant_remaining_cents: Some(17871),
            max_grant_total_cents: Some(20000),
            max_grant_expires_at: Some("2026-11-02T00:00:00Z".into()),
            spend_cents: Some(2128),
            limit_cents: Some(20000),
            spend_resets_at: Some("2026-11-01T00:00:00Z".into()),
            ..Default::default()
        }
    }

    #[test]
    fn the_live_numbers_do_not_block() {
        assert_eq!(compute_block(&live_status()), (false, None));
    }

    #[test]
    fn an_empty_max_grant_blocks_with_the_reset_date() {
        let mut s = live_status();
        s.max_grant_remaining_cents = Some(0);
        assert_eq!(
            compute_block(&s),
            (true, Some("API credit for this cycle is used up, resets 2026-11-02".into()))
        );
        s.max_grant_remaining_cents = Some(-5);
        assert!(compute_block(&s).0, "an overdrawn grant is also used up");
        s.max_grant_expires_at = None;
        assert_eq!(compute_block(&s).1.as_deref(), Some("API credit for this cycle is used up"));
    }

    #[test]
    fn reaching_the_console_limit_blocks_with_the_reset_date() {
        let mut s = live_status();
        s.spend_cents = Some(20000);
        assert_eq!(
            compute_block(&s),
            (true, Some("Console spend limit $200 reached, resets 2026-11-01".into()))
        );
        s.spend_cents = Some(19999);
        assert!(!compute_block(&s).0, "one cent under the limit still runs");
        s.spend_cents = Some(25000);
        s.limit_cents = Some(2050);
        assert_eq!(compute_block(&s).1.as_deref(), Some("Console spend limit $20.50 reached, resets 2026-11-01"));
    }

    #[test]
    fn an_exhausted_grant_is_reported_before_the_spend_limit() {
        let mut s = live_status();
        s.max_grant_remaining_cents = Some(0);
        s.spend_cents = Some(20000);
        assert!(compute_block(&s).1.unwrap().starts_with("API credit"));
    }

    #[test]
    fn unknown_figures_never_block() {
        assert_eq!(compute_block(&ApiCreditStatus::default()), (false, None));
        // A spend with no known limit, and a limit with no known spend.
        let mut s = live_status();
        s.limit_cents = None;
        s.spend_cents = Some(999_999);
        assert!(!compute_block(&s).0);
        let mut s = live_status();
        s.spend_cents = None;
        s.max_grant_remaining_cents = None;
        assert!(!compute_block(&s).0);
    }

    fn ok_credits() -> PrepaidCredits {
        PrepaidCredits {
            amount: 20416,
            currency: "USD".into(),
            promo_tranches: vec![tranche("subscription_api_credit", 20000, 17871, Some("2026-11-02T00:00:00Z"))],
            tranches: vec![tranche("api_credits", 5000, 2545, None)],
        }
    }
    fn ok_limits() -> SpendLimits {
        SpendLimits {
            spend_limits: vec![SpendLimit { limit_usd: 20000, limit_action: "notify_and_pause".into() }],
            enforced_limit_usd: Some(20_000_000),
        }
    }
    fn ok_spend() -> CurrentSpend {
        CurrentSpend { amount: 2128, resets_at: Some("2026-11-01T00:00:00Z".into()) }
    }

    #[test]
    fn build_status_splits_the_max_grant_from_purchased_credit() {
        let s = build_status("a", "t", Ok(ok_credits()), Ok(ok_limits()), Ok(ok_spend()));
        assert_eq!(s.max_grant_remaining_cents, Some(17871));
        assert_eq!(s.max_grant_total_cents, Some(20000));
        assert_eq!(s.max_grant_expires_at.as_deref(), Some("2026-11-02T00:00:00Z"));
        assert_eq!(s.purchased_remaining_cents, Some(2545));
        assert_eq!((s.spend_cents, s.limit_cents), (Some(2128), Some(20000)));
        assert_eq!(s.spend_resets_at.as_deref(), Some("2026-11-01T00:00:00Z"));
        assert!(!s.blocked && s.block_reason.is_none() && s.error.is_none());
        assert_eq!(s.fetched_at, "t");
    }

    #[test]
    fn a_max_grant_listed_as_a_regular_tranche_is_still_the_max_grant() {
        let credits = PrepaidCredits {
            tranches: vec![tranche("subscription_api_credit", 20000, 0, None), tranche("api_credits", 100, 100, None)],
            ..Default::default()
        };
        let s = build_status("a", "t", Ok(credits), Ok(ok_limits()), Ok(ok_spend()));
        assert_eq!(s.max_grant_remaining_cents, Some(0));
        assert_eq!(s.purchased_remaining_cents, Some(100));
        assert!(s.blocked);
    }

    #[test]
    fn no_max_tranche_leaves_the_grant_unknown_and_unblocked() {
        let credits = PrepaidCredits { tranches: vec![tranche("api_credits", 100, 0, None)], ..Default::default() };
        let s = build_status("a", "t", Ok(credits), Ok(ok_limits()), Ok(ok_spend()));
        assert_eq!(s.max_grant_remaining_cents, None);
        assert_eq!(s.purchased_remaining_cents, Some(0));
        assert!(!s.blocked);
    }

    #[test]
    fn an_auth_failure_marks_the_login_expired_and_does_not_block() {
        for e in [ScrapeError::Unauthorized, ScrapeError::Forbidden] {
            let s = build_status("a", "t", Ok(ok_credits()), Err(e), Ok(ok_spend()));
            assert_eq!(s.error.as_deref(), Some(ERR_LOGIN_EXPIRED));
            assert!(!s.blocked);
            assert_eq!(s.max_grant_remaining_cents, None, "figures from a rejected session are not trusted");
        }
    }

    #[test]
    fn a_partial_failure_keeps_the_other_figures_and_records_the_error() {
        let s = build_status(
            "a",
            "t",
            Ok(ok_credits()),
            Err(ScrapeError::Other(anyhow::anyhow!("spend limits HTTP 500"))),
            Ok(ok_spend()),
        );
        assert_eq!(s.max_grant_remaining_cents, Some(17871));
        assert_eq!(s.limit_cents, None);
        assert!(s.error.as_deref().unwrap().contains("spend limit"));
        assert!(!s.blocked);

        // The grant alone is enough to block even when the limit read failed.
        let mut spent = ok_credits();
        spent.promo_tranches[0].remaining_amount_minor_units = 0;
        let s = build_status("a", "t", Ok(spent), Err(ScrapeError::Other(anyhow::anyhow!("x"))), Ok(ok_spend()));
        assert!(s.blocked);
        assert!(s.error.is_some());
    }

    #[test]
    fn same_content_ignores_only_fetched_at() {
        let a = live_status();
        let mut b = a.clone();
        b.fetched_at = "later".into();
        assert!(a.same_content(&b));
        b.spend_cents = Some(1);
        assert!(!a.same_content(&b));
    }

    #[tokio::test]
    async fn fetch_status_reads_all_three_routes() {
        let mut server = mockito::Server::new_async().await;
        let _c = server.mock("GET", "/api/organizations/ORG/prepaid/credits")
            .with_status(200).with_header("content-type", "application/json")
            .with_body(r#"{"amount":20416,"currency":"USD","promo_tranches":[{"program_id":"subscription_api_credit","granted_amount_minor_units":20000,"remaining_amount_minor_units":17871,"expires_at":"2026-11-02T00:00:00Z"}],"tranches":[]}"#)
            .create_async().await;
        let _l = server.mock("GET", "/api/organizations/ORG/spend_limits")
            .with_status(200).with_header("content-type", "application/json")
            .with_body(r#"{"spend_limits":[{"limit_usd":20000,"limit_action":"notify_and_pause"}],"enforced_limit_usd":20000000}"#)
            .create_async().await;
        let _s = server.mock("GET", "/api/organizations/ORG/current_spend")
            .with_status(200).with_header("content-type", "application/json")
            .with_body(r#"{"amount":2128,"resets_at":"2026-11-01T00:00:00Z"}"#)
            .create_async().await;

        let s = fetch_status(&server.url(), "acct", "ORG", Some("sk")).await;
        assert_eq!(s.account_id, "acct");
        assert_eq!((s.max_grant_remaining_cents, s.spend_cents, s.limit_cents), (Some(17871), Some(2128), Some(20000)));
        assert!(!s.blocked && s.error.is_none());
    }

    #[tokio::test]
    async fn fetch_status_without_a_cookie_is_unblocked_and_names_the_gap() {
        let s = fetch_status("http://127.0.0.1:1", "acct", "ORG", None).await;
        assert_eq!(s.error.as_deref(), Some(ERR_NOT_CONNECTED));
        assert!(!s.blocked);
    }

    #[tokio::test]
    async fn fetch_status_maps_a_403_to_login_expired() {
        let mut server = mockito::Server::new_async().await;
        let _all = server.mock("GET", mockito::Matcher::Regex("^/api/organizations/ORG/".into()))
            .with_status(403).expect_at_least(1).create_async().await;
        let s = fetch_status(&server.url(), "acct", "ORG", Some("sk")).await;
        assert_eq!(s.error.as_deref(), Some(ERR_LOGIN_EXPIRED));
        assert!(!s.blocked);
    }
}
