//! The pre-fire guard: running an item's guard command, turning its verdict into
//! a skip or a fire, and the pure skipped-state transition.

use super::compute_fired;
use crate::daemon::schedule_guard::{self, GuardVerdict};
use crate::daemon::state::DaemonState;
use crate::sessions::scheduled_items::{self, ScheduledItem, ScheduledKind, ScheduledStatus, SkippedFire};
use chrono::{DateTime, Utc};
use std::sync::Arc;

/// The scheduled (not manual) firing path: runs the item's guard first, and a
/// guard that says skip ends the firing here without creating a chat. `fire_now`
/// bypasses this on purpose - a click on Fire now / Retry is an explicit "run
/// it", and a guard that answered "already ran" must not swallow it.
pub(super) async fn compute_guarded(state: &Arc<DaemonState>, item: ScheduledItem, now: DateTime<Utc>) -> ScheduledItem {
    let verdict = guard_verdict(&item, now).await;
    apply_guard_verdict(state, item, now, verdict).await
}

/// Runs the item's guard, if it has one. `None` means there was nothing to run.
pub(super) async fn guard_verdict(item: &ScheduledItem, now: DateTime<Utc>) -> Option<GuardVerdict> {
    let (command, cwd) = guard_of(item)?;
    let fire_date = DateTime::parse_from_rfc3339(&item.fire_at)
        .map(|dt| dt.with_timezone(&chrono::Local).format("%Y-%m-%d").to_string())
        .unwrap_or_else(|_| now.with_timezone(&chrono::Local).format("%Y-%m-%d").to_string());
    Some(schedule_guard::run(&command, &cwd, &item.id, &fire_date).await)
}

/// One verdict per input slot (a `None` slot runs no guard), taken concurrently
/// so N slow guards cost the slowest one rather than their sum.
pub(super) async fn guard_verdicts<'a>(items: impl Iterator<Item = Option<&'a ScheduledItem>>) -> Vec<Option<GuardVerdict>> {
    let now = Utc::now();
    futures_util::future::join_all(items.map(|slot| async move {
        match slot {
            Some(item) => guard_verdict(item, now).await,
            None => None,
        }
    }))
    .await
}

pub(super) async fn apply_guard_verdict(
    state: &Arc<DaemonState>,
    item: ScheduledItem,
    now: DateTime<Utc>,
    verdict: Option<GuardVerdict>,
) -> ScheduledItem {
    if let Some(GuardVerdict::Skip(reason)) = verdict {
        return compute_skipped(item, now, reason);
    }
    compute_fired(state, item, now).await
}

/// The guard command and the folder it runs in. `JarvisHygiene` has no
/// folder and no way to be created with a guard, so it never has one.
pub(super) fn guard_of(item: &ScheduledItem) -> Option<(String, std::path::PathBuf)> {
    let command = item.guard_command()?;
    let cwd = match &item.kind {
        ScheduledKind::Message { cwd, .. } | ScheduledKind::NewChat { cwd, .. } => cwd,
        ScheduledKind::JarvisHygiene => return None,
    };
    Some((command.to_string(), std::path::PathBuf::from(cwd)))
}

/// A guard turned this firing away. Recurring items go back to Pending at their
/// next occurrence, one-shots go terminal as `Skipped`; `last_fired_at` stays
/// untouched because nothing fired. Pure like `compute_missed`.
pub(super) fn compute_skipped(mut item: ScheduledItem, now: DateTime<Utc>, reason: String) -> ScheduledItem {
    item.last_result = Some(format!("skipped: {reason}"));
    item.last_skip = Some(SkippedFire { at: now.to_rfc3339(), reason });
    if let Some(rec) = item.recurrence.clone() {
        item.fire_at = scheduled_items::next_occurrence(now, &rec).to_rfc3339();
        item.status = ScheduledStatus::Pending;
    } else {
        item.status = ScheduledStatus::Skipped;
    }
    item
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::test_support::{guarded, test_state};
    use crate::sessions::scheduled_items::{Recurrence, RecurrenceRule};
    use std::time::Duration;

    // --- pre-fire guard ---

    #[test]
    fn compute_skipped_one_shot_goes_terminal_and_records_the_reason() {
        let now = Utc::now();
        let updated = compute_skipped(guarded("g", ".", None), now, "already ran".into());
        assert_eq!(updated.status, ScheduledStatus::Skipped);
        assert_eq!(updated.last_skip, Some(SkippedFire { at: now.to_rfc3339(), reason: "already ran".into() }));
        assert_eq!(updated.last_result.as_deref(), Some("skipped: already ran"));
        assert!(updated.last_fired_at.is_none(), "a skip is not a fire");
    }

    #[test]
    fn compute_skipped_recurring_resets_to_pending_at_the_next_occurrence() {
        let rec = Recurrence { time: "09:00".into(), rule: RecurrenceRule::Daily };
        let item = guarded("g", ".", Some(rec));
        let old_fire_at = item.fire_at.clone();
        let updated = compute_skipped(item, Utc::now(), "already ran".into());
        assert_eq!(updated.status, ScheduledStatus::Pending);
        assert_ne!(updated.fire_at, old_fire_at);
        assert!(updated.last_skip.is_some(), "the panel needs the skip even though the item is Pending again");
    }

    #[tokio::test]
    async fn a_guard_that_exits_zero_skips_instead_of_firing() {
        let state = test_state();
        let updated = compute_guarded(&state, guarded("echo 'already ran'; exit 0", ".", None), Utc::now()).await;
        assert_eq!(updated.status, ScheduledStatus::Skipped);
        assert_eq!(updated.last_skip.map(|s| s.reason).as_deref(), Some("already ran"));
    }

    #[tokio::test]
    async fn a_guard_that_cannot_run_fires_normally() {
        // The missing cwd makes the guard fail to start (fail open) and then
        // makes the fire itself fail, so Failed proves the fire path was reached.
        let state = test_state();
        let updated = compute_guarded(&state, guarded("exit 0", "Z:\\does\\not\\exist", None), Utc::now()).await;
        assert!(matches!(updated.status, ScheduledStatus::Failed { .. }), "got {:?}", updated.status);
        assert!(updated.last_skip.is_none());
    }

    #[tokio::test]
    async fn an_unguarded_item_and_a_blank_guard_never_run_a_command() {
        let state = test_state();
        let mut blank = guarded("   ", "Z:\\does\\not\\exist", None);
        let updated = compute_guarded(&state, blank.clone(), Utc::now()).await;
        assert!(matches!(updated.status, ScheduledStatus::Failed { .. }));
        blank.guard = None;
        assert!(guard_of(&blank).is_none());
    }

    #[test]
    fn jarvis_hygiene_never_has_a_guard() {
        let mut item = ScheduledItem::new(ScheduledKind::JarvisHygiene, "hi".into(), Utc::now().to_rfc3339(), None);
        item.guard = Some("exit 0".into());
        assert!(guard_of(&item).is_none());
    }

    #[tokio::test]
    async fn two_slow_guards_cost_one_guard_s_time_not_two() {
        // `exit 1` fires, so the verdict is irrelevant: the point is the clock.
        let slow = guarded("sleep 3; exit 1", ".", None);
        let skip = guarded("sleep 3; echo 'already ran'; exit 0", ".", None);
        let started = std::time::Instant::now();
        let verdicts = guard_verdicts([Some(&slow), None, Some(&skip)].into_iter()).await;
        let took = started.elapsed();
        assert_eq!(verdicts.len(), 3, "one slot per input, in order");
        assert_eq!(verdicts[0], Some(GuardVerdict::Fire));
        assert_eq!(verdicts[1], None, "an empty slot runs nothing");
        assert_eq!(verdicts[2], Some(GuardVerdict::Skip("already ran".into())));
        assert!(took < Duration::from_millis(5500), "guards ran one after another: {took:?}");
    }

    #[tokio::test]
    async fn waiting_for_a_meeting_does_not_stop_a_guard_from_skipping_once_released() {
        // The gate only decides WHEN; once released the firing goes through the
        // same guard path as any other, so a guard that says skip still skips.
        let state = test_state();
        let mut item = guarded("echo 'already ran'; exit 0", ".", None);
        item.after_meeting = Some(true);
        let updated = compute_guarded(&state, item, Utc::now()).await;
        assert_eq!(updated.status, ScheduledStatus::Skipped);
    }
}
