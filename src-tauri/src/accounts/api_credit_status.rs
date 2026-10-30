//! What an `ApiCredit` account has left, read from the Console, and whether
//! new turns on it must stop. Three reads feed it (`scraping::console_credit`): the
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

/// Shown as the block reason when the credits read succeeded and carries
/// purchased credit but no Max grant tranche (the grant lapsed or was never
/// issued). Chats never draw purchased credit on purpose, so they stop.
pub const BLOCK_NO_MAX_GRANT: &str = "No Max API credit grant this cycle";

/// Shown in `ApiCreditStatus::error` when no Console cookie is stored.
pub const ERR_NOT_CONNECTED: &str = "Console not connected";
/// Shown in `ApiCreditStatus::error` on a 401/403 from the Console.
pub const ERR_LOGIN_EXPIRED: &str = "Console login expired";

/// Which figure a block was decided from. `keep_block_across_error` needs it
/// because `block_reason` is display text: carrying a block over a partial read
/// is only justified while the figure behind THIS block is still unread.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BlockKind {
    /// The Max grant hit zero (`max_grant_remaining_cents`).
    GrantUsedUp,
    /// Console spend reached the limit (`spend_cents` and `limit_cents`).
    SpendLimit,
    /// The credits read showed purchased credit and no Max grant tranche.
    NoMaxGrant,
}

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
    /// Why `blocked` is set, for `keep_block_across_error` only. Not on the
    /// wire (the reason text already is) and not persisted: the hub is
    /// in-memory, and a status without a kind keeps the cautious rule.
    #[serde(skip)]
    #[ts(skip)]
    pub block_kind: Option<BlockKind>,
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

/// Whether a new turn on this account must be refused, and why, plus the figure
/// that decided it. Blocks when the Max grant is spent (so purchased credit is
/// never drained by chats) or when Console spend has reached the spend limit.
/// Unknown figures never block.
fn compute_block_kind(s: &ApiCreditStatus) -> Option<(BlockKind, String)> {
    if let Some(remaining) = s.max_grant_remaining_cents {
        if remaining <= 0 {
            let reason = format!(
                "API credit for this cycle is used up{}",
                resets_clause(s.max_grant_expires_at.as_deref())
            );
            return Some((BlockKind::GrantUsedUp, reason));
        }
    }
    if let (Some(limit), Some(spend)) = (s.limit_cents, s.spend_cents) {
        if spend >= limit {
            let reason = format!(
                "Console spend limit {} reached{}",
                dollars(limit),
                resets_clause(s.spend_resets_at.as_deref())
            );
            return Some((BlockKind::SpendLimit, reason));
        }
    }
    None
}

/// The sum of `amounts`, or `None` when any entry is unknown: a partial sum
/// would read as a real balance, and a too-low one would block a chat that
/// still has credit.
fn sum_if_all_known(amounts: impl Iterator<Item = Option<i64>>) -> Option<i64> {
    amounts.sum::<Option<i64>>()
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
    let mut max_grant_missing = false;
    match credits {
        Ok(c) => {
            let (max, other): (Vec<_>, Vec<_>) = c
                .promo_tranches
                .iter()
                .chain(c.tranches.iter())
                .partition(|t| t.program_id.as_deref() == Some(MAX_GRANT_PROGRAM_ID));
            if max.is_empty() {
                // A successful read with only purchased tranches: the grant is
                // gone, not merely unread, so this is a block (no tranches at
                // all stays unknown).
                max_grant_missing = !other.is_empty();
            } else {
                status.max_grant_remaining_cents = sum_if_all_known(max.iter().map(|t| t.remaining_amount_minor_units));
                status.max_grant_total_cents = sum_if_all_known(max.iter().map(|t| t.granted_amount_minor_units));
                status.max_grant_expires_at = max.iter().filter_map(|t| t.expires_at.clone()).min();
            }
            // Unknown amounts are skipped, but a purchased list with no known
            // amount at all is unknown, not a $0 balance.
            status.purchased_remaining_cents =
                if !other.is_empty() && other.iter().all(|t| t.remaining_amount_minor_units.is_none()) {
                    None
                } else {
                    Some(other.iter().filter_map(|t| t.remaining_amount_minor_units).sum())
                };
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
    if let Some((kind, reason)) = compute_block_kind(&status) {
        status.blocked = true;
        status.block_reason = Some(reason);
        status.block_kind = Some(kind);
    } else if max_grant_missing {
        status.blocked = true;
        status.block_reason = Some(BLOCK_NO_MAX_GRANT.to_string());
        status.block_kind = Some(BlockKind::NoMaxGrant);
    }
    status
}

/// `next` with the previous block carried over when `next` is a partial read:
/// a non-auth fetch error blanks the failed read's figures, so a status that
/// was blocked would otherwise flip to unblocked on a network blip and let
/// chats spend again. The block stays only while a figure that feeds THAT block
/// (see `BlockKind`) is still unknown, so the next clean read, or a partial one
/// whose own figure shows the block is over, decides afresh. A missing cookie or an expired login is not a
/// transient failure: those keep their plain unblocked status.
pub fn keep_block_across_error(prev: Option<&ApiCreditStatus>, mut next: ApiCreditStatus) -> ApiCreditStatus {
    let Some(prev) = prev else { return next };
    let transient_error = next.error.as_deref().is_some_and(|e| e != ERR_LOGIN_EXPIRED && e != ERR_NOT_CONNECTED);
    let blind = match prev.block_kind {
        Some(BlockKind::GrantUsedUp) => next.max_grant_remaining_cents.is_none(),
        Some(BlockKind::SpendLimit) => next.limit_cents.is_none() || next.spend_cents.is_none(),
        // The block means a successful credits read showed no Max grant tranche,
        // so it is over once a read shows one. `purchased_remaining_cents` is no
        // signal: a successful read leaves it None when every purchased amount is null.
        Some(BlockKind::NoMaxGrant) => next.max_grant_remaining_cents.is_none(),
        None => next.max_grant_remaining_cents.is_none() || next.limit_cents.is_none() || next.spend_cents.is_none(),
    };
    if prev.blocked && !next.blocked && transient_error && blind {
        next.blocked = true;
        next.block_reason = prev.block_reason.clone();
        next.block_kind = prev.block_kind;
    }
    next
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

    fn compute_block(s: &ApiCreditStatus) -> (bool, Option<String>) {
        match compute_block_kind(s) {
            Some((_, reason)) => (true, Some(reason)),
            None => (false, None),
        }
    }

    fn tranche(program: &str, granted: i64, remaining: i64, expires: Option<&str>) -> CreditTranche {
        CreditTranche {
            program_id: Some(program.into()),
            name: None,
            granted_amount_minor_units: Some(granted),
            remaining_amount_minor_units: Some(remaining),
            expires_at: expires.map(String::from),
        }
    }

    /// A tranche whose amounts the Console sent as null or left out.
    fn unknown_tranche(program: &str) -> CreditTranche {
        CreditTranche { program_id: Some(program.into()), ..Default::default() }
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
    fn purchased_credit_with_no_max_grant_blocks_so_chats_never_drain_it() {
        for remaining in [0, 2545] {
            let credits =
                PrepaidCredits { tranches: vec![tranche("api_credits", 100, remaining, None)], ..Default::default() };
            let s = build_status("a", "t", Ok(credits), Ok(ok_limits()), Ok(ok_spend()));
            assert_eq!(s.max_grant_remaining_cents, None);
            assert_eq!(s.purchased_remaining_cents, Some(remaining));
            assert_eq!((s.blocked, s.block_reason.as_deref()), (true, Some(BLOCK_NO_MAX_GRANT)));
            assert!(s.error.is_none(), "a vanished grant is not a fetch error");
        }
    }

    #[test]
    fn a_credits_read_with_no_tranches_at_all_stays_unknown_and_unblocked() {
        let s = build_status("a", "t", Ok(PrepaidCredits::default()), Ok(ok_limits()), Ok(ok_spend()));
        assert_eq!(s.max_grant_remaining_cents, None);
        assert!(!s.blocked && s.block_reason.is_none());
    }

    #[test]
    fn a_failed_credits_read_does_not_look_like_a_missing_grant() {
        let s = build_status(
            "a",
            "t",
            Err(ScrapeError::Other(anyhow::anyhow!("prepaid credits HTTP 500"))),
            Ok(ok_limits()),
            Ok(ok_spend()),
        );
        assert!(!s.blocked, "an unread grant is unknown, not gone");
    }

    #[test]
    fn a_null_remaining_amount_is_unknown_and_never_blocks() {
        let credits = PrepaidCredits {
            promo_tranches: vec![unknown_tranche("subscription_api_credit")],
            tranches: vec![tranche("api_credits", 5000, 2545, None)],
            ..Default::default()
        };
        let s = build_status("a", "t", Ok(credits), Ok(ok_limits()), Ok(ok_spend()));
        assert_eq!(s.max_grant_remaining_cents, None);
        assert_eq!(s.max_grant_total_cents, None);
        assert_eq!(s.purchased_remaining_cents, Some(2545));
        assert!(!s.blocked && s.block_reason.is_none());
    }

    #[test]
    fn one_unknown_max_tranche_makes_the_whole_grant_unknown() {
        let credits = PrepaidCredits {
            promo_tranches: vec![
                tranche("subscription_api_credit", 10000, 0, None),
                unknown_tranche("subscription_api_credit"),
            ],
            ..Default::default()
        };
        let s = build_status("a", "t", Ok(credits), Ok(ok_limits()), Ok(ok_spend()));
        assert_eq!(s.max_grant_remaining_cents, None, "a partial sum of 0 must not read as used up");
        assert!(!s.blocked);
    }

    #[test]
    fn an_unknown_purchased_amount_is_skipped_in_the_purchased_sum() {
        let credits = PrepaidCredits {
            promo_tranches: vec![tranche("subscription_api_credit", 20000, 17871, None)],
            tranches: vec![unknown_tranche("api_credits"), tranche("api_credits", 100, 100, None)],
            ..Default::default()
        };
        let s = build_status("a", "t", Ok(credits), Ok(ok_limits()), Ok(ok_spend()));
        assert_eq!(s.purchased_remaining_cents, Some(100));
        assert!(!s.blocked);
    }

    fn blocked_prev() -> ApiCreditStatus {
        let mut s = live_status();
        s.max_grant_remaining_cents = Some(0);
        s.blocked = true;
        s.block_reason = Some("API credit for this cycle is used up, resets 2026-11-02".into());
        s
    }

    fn blank_after_error(err: &str) -> ApiCreditStatus {
        ApiCreditStatus { account_id: "a".into(), fetched_at: "t2".into(), error: Some(err.into()), ..Default::default() }
    }

    #[test]
    fn a_non_auth_fetch_error_keeps_the_previous_block() {
        let next = keep_block_across_error(Some(&blocked_prev()), blank_after_error("credit balance: HTTP 500"));
        assert!(next.blocked);
        assert_eq!(next.block_reason.as_deref(), Some("API credit for this cycle is used up, resets 2026-11-02"));
        assert_eq!(next.fetched_at, "t2", "only the block is carried, not the old figures");
        assert_eq!(next.max_grant_remaining_cents, None);
    }

    #[test]
    fn a_partial_read_that_lost_the_limit_keeps_a_spend_limit_block() {
        let mut prev = live_status();
        prev.spend_cents = Some(20000);
        prev.blocked = true;
        prev.block_reason = Some("Console spend limit $200 reached, resets 2026-11-01".into());
        let mut next = live_status();
        next.limit_cents = None;
        next.error = Some("spend limit: HTTP 500".into());
        let next = keep_block_across_error(Some(&prev), next);
        assert_eq!(next.block_reason.as_deref(), Some("Console spend limit $200 reached, resets 2026-11-01"));
        assert!(next.blocked);
    }

    /// A real block as `build_status` produces it, so the kind is set.
    fn built_block(credits: PrepaidCredits, spend: CurrentSpend) -> ApiCreditStatus {
        let s = build_status("a", "t1", Ok(credits), Ok(ok_limits()), Ok(spend));
        assert!(s.blocked);
        s
    }

    fn used_up_credits() -> PrepaidCredits {
        let mut c = ok_credits();
        c.promo_tranches[0].remaining_amount_minor_units = Some(0);
        c
    }

    fn partial(credits: Result<PrepaidCredits, ScrapeError>, spend: Result<CurrentSpend, ScrapeError>) -> ApiCreditStatus {
        build_status("a", "t2", credits, Ok(ok_limits()), spend)
    }

    fn fetch_failed() -> ScrapeError {
        ScrapeError::Other(anyhow::anyhow!("HTTP 500"))
    }

    #[test]
    fn a_used_up_grant_block_clears_when_the_grant_is_read_fine_and_the_spend_read_failed() {
        let prev = built_block(used_up_credits(), ok_spend());
        assert_eq!(prev.block_kind, Some(BlockKind::GrantUsedUp));
        let next = keep_block_across_error(Some(&prev), partial(Ok(ok_credits()), Err(fetch_failed())));
        assert!(!next.blocked && next.block_reason.is_none(), "the grant is known to be fine");
    }

    #[test]
    fn a_used_up_grant_block_stays_while_the_grant_read_is_what_failed() {
        let prev = built_block(used_up_credits(), ok_spend());
        let next = keep_block_across_error(Some(&prev), partial(Err(fetch_failed()), Ok(ok_spend())));
        assert!(next.blocked);
        assert_eq!(next.block_reason, prev.block_reason);
    }

    #[test]
    fn a_spend_limit_block_clears_when_spend_and_limit_are_known_and_under_and_credits_failed() {
        let prev = built_block(ok_credits(), CurrentSpend { amount: 20000, resets_at: None });
        assert_eq!(prev.block_kind, Some(BlockKind::SpendLimit));
        let next = keep_block_across_error(Some(&prev), partial(Err(fetch_failed()), Ok(ok_spend())));
        assert!(!next.blocked, "spend 2128 is under the 20000 limit");
    }

    #[test]
    fn a_spend_limit_block_stays_while_the_spend_read_is_what_failed() {
        let prev = built_block(ok_credits(), CurrentSpend { amount: 20000, resets_at: None });
        let next = keep_block_across_error(Some(&prev), partial(Ok(ok_credits()), Err(fetch_failed())));
        assert!(next.blocked);
    }

    #[test]
    fn a_no_max_grant_block_clears_once_the_credits_read_shows_a_grant_and_stays_while_it_failed() {
        let no_grant = PrepaidCredits { tranches: vec![tranche("api_credits", 100, 100, None)], ..Default::default() };
        let prev = built_block(no_grant, ok_spend());
        assert_eq!(prev.block_kind, Some(BlockKind::NoMaxGrant));
        let cleared = keep_block_across_error(Some(&prev), partial(Ok(ok_credits()), Err(fetch_failed())));
        assert!(!cleared.blocked);
        let kept = keep_block_across_error(Some(&prev), partial(Err(fetch_failed()), Ok(ok_spend())));
        assert!(kept.blocked);
        assert_eq!(kept.block_kind, Some(BlockKind::NoMaxGrant));
    }

    #[test]
    fn a_no_max_grant_block_clears_on_a_partial_read_that_shows_the_grant_even_with_unreadable_purchased_amounts() {
        let no_grant = PrepaidCredits { tranches: vec![tranche("api_credits", 100, 100, None)], ..Default::default() };
        let prev = built_block(no_grant, ok_spend());
        assert_eq!(prev.block_kind, Some(BlockKind::NoMaxGrant));
        // Credits read fine and show the grant; the purchased amounts are null
        // (so `purchased_remaining_cents` is None) and the spend read failed.
        let credits = PrepaidCredits {
            promo_tranches: vec![tranche("subscription_api_credit", 20000, 17871, None)],
            tranches: vec![unknown_tranche("api_credits")],
            ..Default::default()
        };
        let next = partial(Ok(credits), Err(fetch_failed()));
        assert_eq!((next.max_grant_remaining_cents, next.purchased_remaining_cents), (Some(17871), None));
        let next = keep_block_across_error(Some(&prev), next);
        assert!(!next.blocked, "the grant is visible, so the no-grant block is over");
    }

    #[test]
    fn a_purchased_list_with_no_known_amount_is_unknown_not_zero() {
        let credits = PrepaidCredits {
            promo_tranches: vec![tranche("subscription_api_credit", 20000, 17871, None)],
            tranches: vec![unknown_tranche("api_credits")],
            ..Default::default()
        };
        let s = build_status("a", "t", Ok(credits), Ok(ok_limits()), Ok(ok_spend()));
        assert_eq!(s.purchased_remaining_cents, None);
        let none = PrepaidCredits {
            promo_tranches: vec![tranche("subscription_api_credit", 20000, 17871, None)],
            ..Default::default()
        };
        let s = build_status("a", "t", Ok(none), Ok(ok_limits()), Ok(ok_spend()));
        assert_eq!(s.purchased_remaining_cents, Some(0), "no purchased tranche at all is a real $0");
    }

    #[test]
    fn a_clean_read_replaces_the_previous_block() {
        let mut clean = live_status();
        clean.fetched_at = "t2".into();
        let next = keep_block_across_error(Some(&blocked_prev()), clean);
        assert!(!next.blocked && next.block_reason.is_none(), "a clean read that clears the block is believed");
    }

    #[test]
    fn missing_cookie_and_expired_login_do_not_inherit_a_block() {
        for err in [ERR_NOT_CONNECTED, ERR_LOGIN_EXPIRED] {
            let next = keep_block_across_error(Some(&blocked_prev()), blank_after_error(err));
            assert!(!next.blocked, "{err}: unknown never blocks");
        }
    }

    #[test]
    fn an_error_with_no_previous_block_or_no_previous_status_stays_unblocked() {
        let unblocked_prev = live_status();
        assert!(!keep_block_across_error(Some(&unblocked_prev), blank_after_error("x")).blocked);
        assert!(!keep_block_across_error(None, blank_after_error("x")).blocked);
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
        spent.promo_tranches[0].remaining_amount_minor_units = Some(0);
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
