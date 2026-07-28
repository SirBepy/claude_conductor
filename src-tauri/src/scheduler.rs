//! Background task that polls usage on an interval and broadcasts results.

use crate::accounts::Account;
use crate::auth;
use crate::scraping::{fetch_usage, fetch_usage_for_org, ScrapeError};
use crate::state::AppState;
use crate::types::{AuthState, UsageSnapshot};
use crate::settings::paths;
use crate::auth::session;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Clone, Copy, Debug)]
pub enum PollTrigger { Scheduled, Manual, Hook }

const BASE_URL: &str = "https://claude.ai";
const FAIL_STREAK_BEFORE_RELOGIN: u32 = 3;
const RETRY_AFTER_LOGIN_SECS: u64 = 5;

pub fn spawn(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut fail_streak: u32 = 0;
        loop {
            let interval_secs = interval_for(&app);

            let prev_util: Option<f64> = {
                let state = app.state::<crate::state::AppState>();
                let guard = state.current_usage.lock().unwrap();
                guard.as_ref().map(|s| s.five_hour.utilization)
            };

            match poll_once(&app, PollTrigger::Scheduled).await {
                Ok(snap) => {
                    fail_streak = 0;
                    log::info!(
                        "poll ok: 5h={:.1}% 7d={:.1}%",
                        snap.five_hour.utilization,
                        snap.seven_day.utilization,
                    );
                    let reset_detected = prev_util
                        .map(|prev| prev >= 15.0 && snap.five_hour.utilization < prev - 30.0)
                        .unwrap_or(false);
                    if reset_detected {
                        let jitter = reset_jitter_secs();
                        log::info!("usage reset detected - waiting {}s before next poll", jitter);
                        tokio::time::sleep(Duration::from_secs(jitter)).await;
                    } else {
                        sleep_until_next_target(interval_secs as i64).await;
                    }
                }
                Err(PollErr::NoSession) => {
                    log::info!("no session on disk - triggering login flow");
                    let _ = app.emit(
                        "poll-failed",
                        serde_json::json!({"reason": "no-session"}),
                    );
                    trigger_login(&app).await;
                    log::info!("login flow returned; retrying poll in {}s", RETRY_AFTER_LOGIN_SECS);
                    tokio::time::sleep(Duration::from_secs(RETRY_AFTER_LOGIN_SECS)).await;
                }
                Err(PollErr::NeedsLogin) => {
                    fail_streak += 1;
                    log::warn!("poll unauthorized (streak={fail_streak}/{FAIL_STREAK_BEFORE_RELOGIN})");
                    let _ = app.emit(
                        "poll-failed",
                        serde_json::json!({"reason": "unauthorized"}),
                    );
                    if fail_streak >= FAIL_STREAK_BEFORE_RELOGIN {
                        log::info!("auth failure streak reached - triggering login flow");
                        fail_streak = 0;
                        trigger_login(&app).await;
                        tokio::time::sleep(Duration::from_secs(RETRY_AFTER_LOGIN_SECS)).await;
                    } else {
                        sleep_until_next_target(interval_secs as i64).await;
                    }
                }
                Err(PollErr::Other(msg)) => {
                    log::warn!("poll failed (network or other): {msg}");
                    let _ = app.emit(
                        "poll-failed",
                        serde_json::json!({"reason": msg}),
                    );
                    sleep_until_next_target(interval_secs as i64).await;
                }
            }
        }
    });
}

/// Random delay after a usage reset: 60-300 seconds (1-5 min).
/// Uses subsecond nanoseconds of the current wall clock as cheap pseudo-randomness.
fn reset_jitter_secs() -> u64 {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .subsec_nanos();
    60 + (nanos % 241) as u64
}

/// Next wall-clock target: ceil(now_ts / interval) * interval + offset, where
/// offset = min(55, interval - 5). Aligns the 10-min poll to HH:X0:55 so a
/// reset at HH:X0:00 is captured on the very next tick rather than being
/// sampled right as the server's counter flips.
pub(crate) fn next_target_ts(interval_secs: i64, now_ts: i64) -> i64 {
    let interval = interval_secs.max(60);
    let offset = (interval - 5).min(55).max(0);
    let mut target = (now_ts / interval) * interval + offset;
    if target <= now_ts {
        target += interval;
    }
    target
}

/// Sleep in 15s chunks until the next wall-clock aligned target. Short chunks
/// let us recover from system-sleep: when the laptop suspends, tokio's
/// monotonic timer pauses, so a single long `sleep(600s)` would miss every
/// aligned slot that elapsed during suspend. Checking wall-clock each wake-up
/// fires the next poll within ~15s of resume.
async fn sleep_until_next_target(interval_secs: i64) {
    let target = next_target_ts(interval_secs, chrono::Utc::now().timestamp());
    loop {
        let now = chrono::Utc::now().timestamp();
        if now >= target { return; }
        let remaining = (target - now).max(1) as u64;
        let step = remaining.min(15);
        tokio::time::sleep(Duration::from_secs(step)).await;
    }
}

/// Runs the Chrome-CDP login flow, guarding against concurrent invocations
/// by checking `AuthState::InProgress`.
async fn trigger_login(app: &AppHandle) {
    {
        let state = app.state::<AppState>();
        let mut guard = state.auth_state.lock().unwrap();
        if matches!(*guard, AuthState::InProgress) {
            return; // another trigger already handling it
        }
        *guard = AuthState::InProgress;
    }
    let _ = app.emit("auth-progress", serde_json::json!({"stage": "starting"}));
    match auth::run(app.clone()).await {
        Ok(()) => {
            *app.state::<AppState>().auth_state.lock().unwrap() = AuthState::LoggedIn;
        }
        Err(e) => {
            log::error!("auto-login failed: {e}");
            *app.state::<AppState>().auth_state.lock().unwrap() = AuthState::NeedsLogin;
        }
    }
}

fn interval_for(app: &AppHandle) -> u64 {
    let state = app.state::<AppState>();
    let s = state.settings.lock().unwrap();
    s.poll_interval_secs.max(60) // floor 60s to avoid accidental hammering
}

#[derive(Debug)]
pub enum PollErr {
    NoSession,
    NeedsLogin,
    Other(String),
}

pub async fn poll_once(app: &AppHandle, trigger: PollTrigger) -> Result<UsageSnapshot, PollErr> {
    poll_once_scoped(app, trigger, None).await
}

/// Same as [`poll_once`], but when `account_id` is given only that account is
/// polled (used by the click-to-refresh dial - a single account's manual
/// refresh shouldn't re-poll every other configured account too). `None`
/// preserves the original all-accounts behaviour.
pub async fn poll_once_scoped(
    app: &AppHandle,
    trigger: PollTrigger,
    account_id: Option<&str>,
) -> Result<UsageSnapshot, PollErr> {
    let _ = trigger;
    let result = do_poll(app, account_id).await;

    crate::tray::render_tray_now(app);
    if let Ok(snap) = &result {
        let _ = app.emit("usage-updated", snap.clone());
    }
    result
}

/// Orchestrates one poll tick, either legacy (single `session.txt`) or
/// per-account, then applies the effects shared by both paths exactly once:
/// mirror the "representative" snapshot into the legacy state fields (tray,
/// dashboard, and every other consumer not yet migrated to per-account reads
/// - see `AppState::current_usage`'s doc comment) and prune retention. The
/// threshold notification is fired INSIDE each branch instead (milestone 08):
/// the legacy branch fires once with no account context (`{account}` renders
/// empty); the per-account branch fires once per account against that
/// account's own previous snapshot, so a non-default account crossing a
/// threshold is never silently missed by comparing against the wrong
/// account's prior reading. Each branch owns its own SQLite insert(s) since
/// the per-account branch may write more than one row.
async fn do_poll(app: &AppHandle, account_filter: Option<&str>) -> Result<UsageSnapshot, PollErr> {
    let accounts = crate::accounts::load_registry();
    let mut with_cookies: Vec<Account> = accounts.into_iter().filter(account_has_cookie).collect();
    if let Some(id) = account_filter {
        with_cookies.retain(|a| a.id == id);
        if with_cookies.is_empty() {
            // The requested account has no cookie to poll with - the legacy
            // branch below ignores the filter entirely, so falling through to
            // it would poll the wrong (or an arbitrary) account instead.
            return Err(PollErr::NoSession);
        }
    }

    let snap = if with_cookies.is_empty() {
        let prev_snap = app.state::<AppState>().current_usage.lock().unwrap().clone();
        let snap = do_poll_legacy(app).await?;
        maybe_notify_threshold_crossed(app, prev_snap.as_ref(), &snap, None);
        snap
    } else {
        do_poll_accounts(app, &with_cookies).await?
    };

    {
        let state = app.state::<AppState>();
        *state.current_usage.lock().unwrap() = Some(snap.clone());
        *state.auth_state.lock().unwrap() = AuthState::LoggedIn;
    }

    {
        let state = app.state::<AppState>();
        let policies = state.settings.lock().unwrap().retention;
        let mgr = state.db.lock().unwrap();
        if let Err(e) = crate::storage::prune_all(mgr.conn(), &policies) {
            log::warn!("storage: retention prune failed: {e:#}");
        }
    }

    Ok(snap)
}

/// True if a registered account has a stored, non-empty web sessionKey
/// cookie. Accounts without one stay on the legacy poll path until their
/// cookie is captured (migration bridge - `03-per-account-usage.md`).
fn account_has_cookie(account: &Account) -> bool {
    paths::account_session_file(&account.id)
        .ok()
        .and_then(|p| session::load(&p))
        .is_some()
}

/// The pre-multi-account poll: single `session.txt`, `orgs.first()` org
/// selection, one SQLite row tagged `account_id: None`. Kept byte-for-byte
/// behaviorally identical to the original single-account implementation so
/// nothing regresses for anyone who hasn't added an account yet.
async fn do_poll_legacy(app: &AppHandle) -> Result<UsageSnapshot, PollErr> {
    let session_path = paths::session_file()
        .map_err(|e| PollErr::Other(format!("{e:#}")))?;
    let Some(session_key) = session::load(&session_path) else {
        return Err(PollErr::NoSession);
    };

    let snap = match fetch_usage(BASE_URL, &session_key).await {
        Ok(s) => s,
        Err(ScrapeError::Unauthorized) => return Err(PollErr::NeedsLogin),
        Err(ScrapeError::Forbidden) => return Err(PollErr::NeedsLogin),
        Err(e) => return Err(PollErr::Other(format!("{e:#}"))),
    };

    {
        let state = app.state::<AppState>();
        let mgr = state.db.lock().unwrap();
        crate::storage::usage_store::insert_snapshot(mgr.conn(), &snap)
            .map_err(|e| PollErr::Other(format!("{e:#}")))?;
    }

    Ok(snap)
}

/// Polls every account that has a stored cookie, independently: one
/// account's failure (expired cookie, network error, its `org_uuid` missing
/// from the session's org list, ...) is recorded as that account's own
/// `AuthState::NeedsLogin` and never drops the others. Persists a tagged
/// snapshot per successful account, fires that account's OWN threshold
/// notification (milestone 08 - compared against ITS previous snapshot, not
/// some other account's), then returns the "default" account's snapshot
/// (`Settings.default_account_id`, falling back to the first success) as the
/// tick's representative result for the shared legacy-state mirror in
/// `do_poll`.
async fn do_poll_accounts(
    app: &AppHandle,
    accounts: &[Account],
) -> Result<UsageSnapshot, PollErr> {
    let label_by_id: std::collections::HashMap<&str, &str> =
        accounts.iter().map(|a| (a.id.as_str(), a.label.as_str())).collect();

    let outcomes = poll_accounts_isolated(accounts, |account| async move {
        let session_path = paths::account_session_file(&account.id)
            .map_err(|e| format!("{e:#}"))?;
        let Some(session_key) = session::load(&session_path) else {
            return Err("no session".to_string());
        };
        match fetch_usage_for_org(BASE_URL, &session_key, Some(&account.org_uuid)).await {
            Ok(mut snap) => {
                snap.account_id = Some(account.id.clone());
                Ok(snap)
            }
            Err(e) => Err(format!("{e:#}")),
        }
    })
    .await;

    let state = app.state::<AppState>();
    let default_account_id = state.settings.lock().unwrap().default_account_id.clone();
    // Snapshot each account's PREVIOUS reading before this tick overwrites the
    // map below - threshold crossing must compare against that account's own
    // prior state, not whatever `current_usage_by_account` holds mid-loop.
    let prev_by_account = state.current_usage_by_account.lock().unwrap().clone();

    let mut default_snap: Option<UsageSnapshot> = None;
    let mut any_ok = false;
    for (account_id, outcome) in &outcomes {
        match outcome {
            Ok(snap) => {
                any_ok = true;
                state.current_usage_by_account.lock().unwrap().insert(account_id.clone(), snap.clone());
                state.auth_state_by_account.lock().unwrap().insert(account_id.clone(), AuthState::LoggedIn);
                {
                    let mgr = state.db.lock().unwrap();
                    if let Err(e) = crate::storage::usage_store::insert_snapshot(mgr.conn(), snap) {
                        log::warn!("storage: insert per-account snapshot failed for {account_id}: {e:#}");
                    }
                }
                maybe_notify_threshold_crossed(
                    app,
                    prev_by_account.get(account_id.as_str()),
                    snap,
                    label_by_id.get(account_id.as_str()).copied(),
                );
                let is_default = default_account_id.as_deref() == Some(account_id.as_str())
                    || (default_account_id.is_none() && default_snap.is_none());
                if is_default {
                    default_snap = Some(snap.clone());
                }
            }
            Err(e) => {
                log::warn!("poll failed for account {account_id}: {e}");
                state.auth_state_by_account.lock().unwrap().insert(account_id.clone(), AuthState::NeedsLogin);
            }
        }
    }

    if !any_ok {
        return Err(PollErr::Other("all accounts failed to poll".to_string()));
    }

    Ok(default_snap
        .or_else(|| outcomes.iter().find_map(|(_, r)| r.as_ref().ok().cloned()))
        .expect("any_ok guarantees at least one successful outcome"))
}

/// Runs `fetch` for every account in turn, collecting `(account_id, outcome)`
/// pairs regardless of individual failures - the loop never short-circuits,
/// so a failing account can never prevent the ones after it from being
/// attempted. Extracted as a standalone async fn (independent of `AppState`/
/// `AppHandle`) so the isolation guarantee is unit-testable with a fake
/// `fetch` instead of real HTTP (see `tests::poll_accounts_isolated_*`).
pub(crate) async fn poll_accounts_isolated<F, Fut>(
    accounts: &[Account],
    mut fetch: F,
) -> Vec<(String, Result<UsageSnapshot, String>)>
where
    F: FnMut(Account) -> Fut,
    Fut: std::future::Future<Output = Result<UsageSnapshot, String>>,
{
    let mut out = Vec::with_capacity(accounts.len());
    for account in accounts {
        let outcome = fetch(account.clone()).await;
        out.push((account.id.clone(), outcome));
    }
    out
}

/// Pure crossing check: `Some(pct)` when either window's percent crosses a
/// configured color threshold between `prev` and `new` (`pct` is the larger
/// of the two new percentages, matching the notification's `{percent}`);
/// `None` otherwise. Extracted from `maybe_notify_threshold_crossed` so the
/// per-account evaluation (milestone 08 acceptance: "a threshold alert names
/// its account") is unit-testable without an `AppHandle`/`AppState`.
fn threshold_crossing(
    prev: &UsageSnapshot,
    new: &UsageSnapshot,
    thresholds: &[crate::tray::ColorStop],
) -> Option<u32> {
    let prev_sess = Some(crate::scraping::session_pct(prev));
    let new_sess = Some(crate::scraping::session_pct(new));
    let prev_wk = Some(crate::scraping::weekly_pct(prev));
    let new_wk = Some(crate::scraping::weekly_pct(new));
    let crossed =
        crate::scraping::threshold_crossed(prev_sess, new_sess, thresholds) ||
        crate::scraping::threshold_crossed(prev_wk, new_wk, thresholds);
    if !crossed { return None; }
    Some(new_sess.unwrap_or(0.0).max(new_wk.unwrap_or(0.0)).round() as u32)
}

/// Fires the `ThresholdCrossed` notification when `threshold_crossing`
/// reports a crossing between `prev` and `new`. Shared by the legacy path
/// (`account_label: None` - the `{account}` token renders empty) and the
/// per-account path (`account_label: Some(&account.label)`, evaluated against
/// THAT account's own previous snapshot - see `do_poll_accounts`).
fn maybe_notify_threshold_crossed(
    app: &AppHandle,
    prev: Option<&UsageSnapshot>,
    new: &UsageSnapshot,
    account_label: Option<&str>,
) {
    let Some(prev) = prev else { return };
    let icon_s = crate::tray::IconSettings::try_from(
        &*app.state::<AppState>().settings.lock().unwrap()
    ).unwrap_or_default();
    if let Some(pct) = threshold_crossing(prev, new, &icon_s.color_thresholds) {
        crate::notifications::fire(
            app,
            crate::notifications::NotifKind::ThresholdCrossed,
            crate::notifications::NotifContext {
                percent: Some(pct),
                name: None,
                account: account_label.map(String::from),
            },
            None,
            None,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::{next_target_ts, poll_accounts_isolated, threshold_crossing};
    use crate::accounts::Account;
    use crate::tray::ColorStop;
    use crate::types::{UsageSnapshot, WindowUsage};

    fn acct(id: &str) -> Account {
        Account {
            id: id.into(),
            label: id.into(),
            colour: "#fff".into(),
            icon: "user".into(),
            config_dir: std::path::PathBuf::from(format!("C:/home/.claude-{id}")),
            chrome_profile_dir: std::path::PathBuf::from(format!("C:/appdata/chrome-profiles/{id}")),
            email: format!("{id}@example.com"),
            org_uuid: format!("org-{id}"),
            subscription_tier: "claude_max".into(),
            created_at: "2026-07-07T00:00:00Z".into(),
            fleet_eligible: false,
        }
    }

    fn snap_for(account_id: &str) -> UsageSnapshot {
        UsageSnapshot {
            captured_at: "2026-07-07T10:00:00Z".into(),
            five_hour: WindowUsage { utilization: 10.0, resets_at: "x".into() },
            seven_day: WindowUsage { utilization: 5.0, resets_at: "y".into() },
            extra_usage: None,
            account_id: Some(account_id.to_string()),
        }
    }

    fn snap_pct(five_hour: f64, seven_day: f64) -> UsageSnapshot {
        UsageSnapshot {
            captured_at: "2026-07-07T10:00:00Z".into(),
            five_hour: WindowUsage { utilization: five_hour, resets_at: "x".into() },
            seven_day: WindowUsage { utilization: seven_day, resets_at: "y".into() },
            extra_usage: None,
            account_id: None,
        }
    }

    fn default_thresholds() -> Vec<ColorStop> {
        vec![
            ColorStop { min: 0, color: "#27ae60".into() },
            ColorStop { min: 50, color: "#e67e22".into() },
            ColorStop { min: 80, color: "#e74c3c".into() },
        ]
    }

    /// Milestone 08 acceptance: crossing a threshold reports the crossing so
    /// the caller can fire a per-account notification.
    #[test]
    fn threshold_crossing_detects_upward_crossing_and_reports_the_larger_pct() {
        let prev = snap_pct(40.0, 10.0);
        let new = snap_pct(55.0, 20.0);
        let pct = threshold_crossing(&prev, &new, &default_thresholds());
        assert_eq!(pct, Some(55));
    }

    #[test]
    fn threshold_crossing_none_when_steady_state() {
        let prev = snap_pct(40.0, 10.0);
        let new = snap_pct(45.0, 15.0);
        assert_eq!(threshold_crossing(&prev, &new, &default_thresholds()), None);
    }

    /// Two accounts polled in the same tick must each be evaluated against
    /// THEIR OWN previous snapshot: account A crossing 80% must not be masked
    /// or falsely triggered by account B's numbers.
    #[test]
    fn threshold_crossing_is_independent_per_account_snapshot_pair() {
        let thresholds = default_thresholds();
        // Account "work": crosses 80%.
        let work_prev = snap_pct(70.0, 10.0);
        let work_new = snap_pct(85.0, 12.0);
        // Account "personal": stays flat, must NOT report a crossing even
        // though it shares the same tick as "work".
        let personal_prev = snap_pct(20.0, 5.0);
        let personal_new = snap_pct(22.0, 6.0);

        assert_eq!(threshold_crossing(&work_prev, &work_new, &thresholds), Some(85));
        assert_eq!(threshold_crossing(&personal_prev, &personal_new, &thresholds), None);
    }

    /// The load-bearing milestone-03 acceptance criterion: one account
    /// failing must not drop the accounts after it in the iteration order.
    #[tokio::test]
    async fn one_account_failure_does_not_poison_others() {
        let accounts = vec![acct("a"), acct("b"), acct("c")];
        let outcomes = poll_accounts_isolated(&accounts, |account| async move {
            if account.id == "b" {
                Err("simulated 401".to_string())
            } else {
                Ok(snap_for(&account.id))
            }
        })
        .await;

        assert_eq!(outcomes.len(), 3, "every account must be attempted");
        assert_eq!(outcomes[0].0, "a");
        assert!(outcomes[0].1.is_ok());
        assert_eq!(outcomes[1].0, "b");
        assert!(outcomes[1].1.is_err());
        assert_eq!(outcomes[2].0, "c", "the account AFTER the failure must still be polled");
        assert!(outcomes[2].1.is_ok());
        assert_eq!(
            outcomes[2].1.as_ref().unwrap().account_id.as_deref(),
            Some("c"),
            "each snapshot must carry its own account tag",
        );
    }

    #[tokio::test]
    async fn all_accounts_failing_yields_all_errors_not_a_panic() {
        let accounts = vec![acct("a"), acct("b")];
        let outcomes = poll_accounts_isolated(&accounts, |_| async move {
            Err("down".to_string())
        })
        .await;
        assert_eq!(outcomes.len(), 2);
        assert!(outcomes.iter().all(|(_, r)| r.is_err()));
    }

    #[tokio::test]
    async fn empty_account_list_yields_empty_outcomes() {
        let outcomes = poll_accounts_isolated(&[], |account: Account| async move {
            Ok(snap_for(&account.id))
        })
        .await;
        assert!(outcomes.is_empty());
    }

    #[test]
    fn aligns_to_10min_boundary_plus_55s() {
        // 2026-04-22 10:03:00 UTC
        let now = 1_777_198_980;
        let t = next_target_ts(600, now);
        assert_eq!(t - now, 7 * 60 + 55);
    }

    #[test]
    fn jumps_to_next_slot_when_past_offset() {
        // 2026-04-22 10:00:56 UTC - one sec past the 10:00:55 offset
        let now = 1_777_198_856;
        let t = next_target_ts(600, now);
        // Next slot should be 10:10:55, i.e. 9m4s away.
        assert_eq!(t - now, 9 * 60 + 59);
    }

    #[test]
    fn non_standard_interval_clamps_offset() {
        // 60s interval → offset = min(55, 55) = 55
        let now = 1_000_000;
        let t = next_target_ts(60, now);
        let diff = t - now;
        assert!(diff > 0 && diff <= 60);
    }
}
