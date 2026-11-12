//! The pure outcome of one due item (missed, fired, requeued behind a rate limit)
//! and the stagger slots a rate-limited resume is spread across.

use super::schedule_fire;
use crate::daemon::state::DaemonState;
use crate::sessions::scheduled_items::{self, ScheduledItem, ScheduledKind, ScheduledStatus};
use chrono::{DateTime, Utc};
use std::sync::Arc;

/// Breathing room after the reported reset before the first resume fires.
/// `resetsAt` from the CLI has been observed to be optimistic, and a turn sent
/// at the exact boundary can be rejected again.
const RESUME_DELAY_SECS: i64 = 60;
/// Spacing between successive resumes on the SAME account. Without it, N
/// blocked chats all fire in the tick right after the reset and immediately
/// re-exhaust the window they just waited out.
const RESUME_STAGGER_SECS: i64 = 45;
/// `fire_message` (`schedule_fire.rs`) returns `Err("RATE_LIMITED:<unix
/// secs>")` when the account is still inside its window at fire time.
/// `compute_fired` turns that into a requeue instead of a terminal `Failed`,
/// because the item is not broken, it is early.
pub(crate) const RATE_LIMITED_PREFIX: &str = "RATE_LIMITED:";

/// When should the next resume on `account_id` fire, given the account leaves
/// its window at `resets_at` (unix secs)? Slots are `resets_at + 60s`, then
/// +45s per already-pending resume on that same account, so a fan-out of
/// blocked chats resumes in single file rather than as a thundering herd.
///
/// Counts only `Pending` `Message` items, so an item currently being fired
/// (status `Firing`, i.e. the one asking) never counts itself.
pub fn next_stagger_slot(
    state: &Arc<DaemonState>,
    account_id: Option<&str>,
    resets_at: i64,
) -> DateTime<Utc> {
    let ordinal = scheduled_items::list()
        .iter()
        .filter(|it| matches!(it.status, ScheduledStatus::Pending))
        .filter_map(|it| match &it.kind {
            ScheduledKind::Message { session_id, .. } => Some(session_id.clone()),
            ScheduledKind::NewChat { .. } => None,
            ScheduledKind::JarvisHygiene => None,
        })
        .filter(|sid| {
            state.registry.get(sid).and_then(|i| i.account_id).as_deref() == account_id
        })
        .count() as i64;
    let ts = resets_at + RESUME_DELAY_SECS + ordinal * RESUME_STAGGER_SECS;
    DateTime::from_timestamp(ts, 0).unwrap_or_else(Utc::now)
}

/// Past the grace window: never fires. Recurring items reset to Pending at
/// their next occurrence (computed from `now`, not the missed `fire_at`, so a
/// long-missed daily item doesn't immediately re-fire); one-shots go terminal.
/// Pure (no store I/O) so it's directly unit-testable; the caller persists
/// the returned item via `scheduled_items::upsert`.
pub(super) fn compute_missed(mut item: ScheduledItem, now: DateTime<Utc>) -> ScheduledItem {
    item.last_result = Some("missed: past the grace window".to_string());
    if let Some(rec) = item.recurrence.clone() {
        item.fire_at = scheduled_items::next_occurrence(now, &rec).to_rfc3339();
        item.status = ScheduledStatus::Pending;
    } else {
        item.status = ScheduledStatus::Missed;
    }
    item
}


/// Within the grace window: attempt the fire, record the outcome, and either
/// reset to Pending (recurring) or go terminal (one-shot). The fire attempt
/// itself has side effects (spawns/sends via `state`), but never touches the
/// scheduled-items store directly - the caller persists the returned item.
pub(super) async fn compute_fired(state: &Arc<DaemonState>, mut item: ScheduledItem, now: DateTime<Utc>) -> ScheduledItem {
    // A message whose chat is mid-turn (a compaction, a wake, Joe's own turn)
    // is early, not broken: it stays Pending at the same `fire_at`, so the next
    // tick fires it once the chat is idle, and the grace window still turns a
    // chat that never goes idle into Missed. Firing it would only meet
    // `fire_message`'s busy refusal, which used to fail a one-shot for good
    // (spike S1, g3: a `schedule_fire_now` landing mid-compaction was lost).
    if let ScheduledKind::Message { session_id, .. } = &item.kind {
        if crate::daemon::lifecycle::is_busy(state, session_id) {
            item.status = ScheduledStatus::Pending;
            item.last_result = Some("waiting: the chat was mid-turn, retried once it is idle".to_string());
            return item;
        }
    }
    let outcome = schedule_fire::fire_kind(state, &item).await;
    // Still inside the account's window: not a failure, just early. Push the
    // item to the next free stagger slot and leave it Pending. `last_fired_at`
    // stays untouched so the schedule view doesn't claim we tried to send.
    if let Some(resets_at) = outcome.as_ref().err().and_then(|e| parse_rate_limited(e)) {
        let account_id = match &item.kind {
            ScheduledKind::Message { session_id, .. } => {
                state.registry.get(session_id).and_then(|i| i.account_id)
            }
            ScheduledKind::NewChat { account_id, .. } => account_id.clone(),
            ScheduledKind::JarvisHygiene => None,
        };
        item.fire_at = next_stagger_slot(state, account_id.as_deref(), resets_at).to_rfc3339();
        item.status = ScheduledStatus::Pending;
        item.last_result = Some("waiting: account still rate limited".to_string());
        return item;
    }
    item.last_fired_at = Some(now.to_rfc3339());
    item.last_result = Some(match &outcome {
        Ok(_) => "sent".to_string(),
        Err(reason) => reason.clone(),
    });
    // On a successful fire, `outcome` carries the session id that was spawned
    // (NewChat) or targeted (Message), so the schedule view can later offer
    // an "open that chat" click-through. A failed fire leaves whatever
    // `last_session_id` was recorded on the previous fire untouched.
    if let Ok(Some(sid)) = &outcome {
        item.last_session_id = Some(sid.clone());
        // Announce the fire so the app can pop a clickable toast: a scheduled
        // chat otherwise springs to life silently (it only surfaces when the
        // session list next refreshes, often mid-response). One-shot per fire,
        // distinct from the list-shaped `scheduled_items_changed` broadcast.
        let kind_tag = match &item.kind {
            ScheduledKind::Message { .. } => "message",
            ScheduledKind::NewChat { .. } => "new_chat",
            ScheduledKind::JarvisHygiene => "jarvis_hygiene",
        };
        state.notifier.publish(
            "scheduled_item_fired",
            serde_json::json!({
                "id": item.id,
                "kind": kind_tag,
                "session_id": sid,
                "prompt": item.prompt,
            }),
        );
    }
    if let Some(rec) = item.recurrence.clone() {
        item.fire_at = scheduled_items::next_occurrence(now, &rec).to_rfc3339();
        item.status = ScheduledStatus::Pending;
    } else {
        item.status = match outcome {
            Ok(_) => ScheduledStatus::Sent,
            Err(reason) => ScheduledStatus::Failed { reason },
        };
    }
    item
}

/// `Some(resets_at)` if `reason` is the requeue sentinel from `fire_message`.
pub(crate) fn parse_rate_limited(reason: &str) -> Option<i64> {
    reason.strip_prefix(RATE_LIMITED_PREFIX)?.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::test_support::{make_item, test_state};
    use crate::sessions::scheduled_items::{Recurrence, RecurrenceRule};

    // compute_missed / compute_fired are pure (no store I/O), so these run
    // against in-memory ScheduledItem values only - never touching the real
    // scheduled-items.json.

    #[test]
    fn compute_missed_one_shot_goes_terminal() {
        let item = make_item(Utc::now() - chrono::Duration::hours(3), None);
        let updated = compute_missed(item, Utc::now());
        assert_eq!(updated.status, ScheduledStatus::Missed);
        assert!(updated.last_result.is_some());
    }

    #[test]
    fn compute_missed_recurring_resets_to_pending_with_new_fire_at() {
        let rec = Recurrence { time: "09:00".into(), rule: RecurrenceRule::Daily };
        let old_fire_at = Utc::now() - chrono::Duration::hours(5);
        let item = make_item(old_fire_at, Some(rec));
        let now = Utc::now();
        let updated = compute_missed(item, now);
        assert_eq!(updated.status, ScheduledStatus::Pending, "recurring item resets to Pending after a miss");
        assert_ne!(updated.fire_at, old_fire_at.to_rfc3339(), "fire_at must advance to the next occurrence");
    }

    #[tokio::test]
    async fn compute_fired_one_shot_failure_goes_failed_with_reason() {
        let state = test_state();
        let item = make_item(Utc::now() - chrono::Duration::minutes(1), None);
        let now = Utc::now();
        let updated = compute_fired(&state, item, now).await;
        assert!(matches!(updated.status, ScheduledStatus::Failed { .. }), "missing cwd must surface as Failed, not panic");
        assert!(updated.last_fired_at.is_some());
        assert!(updated.last_result.is_some());
    }

    /// Spike S1 (g3): a one-shot fired while its chat was compacting failed
    /// for good with "still mid-turn". It must wait for the next tick instead.
    #[tokio::test]
    async fn a_one_shot_fired_into_a_mid_turn_chat_stays_pending_for_the_next_tick() {
        let state = test_state();
        state.registry.upsert_interactive("sched-busy", std::path::Path::new("C:/proj"), "proj-1", "2026-01-01T00:00:00Z");
        state.registry.set_busy("sched-busy", true);
        let fire_at = Utc::now() - chrono::Duration::minutes(1);
        let item = ScheduledItem::new(
            ScheduledKind::Message { session_id: "sched-busy".into(), cwd: "C:/proj".into() },
            "wake".into(),
            fire_at.to_rfc3339(),
            None,
        );
        let updated = compute_fired(&state, item, Utc::now()).await;
        assert_eq!(updated.status, ScheduledStatus::Pending, "{:?}", updated.last_result);
        assert_eq!(updated.fire_at, fire_at.to_rfc3339(), "still due, so the next idle tick fires it");
        assert!(updated.last_fired_at.is_none(), "nothing was sent");
    }

    #[tokio::test]
    async fn compute_fired_recurring_resets_to_pending_even_on_failure() {
        let state = test_state();
        let rec = Recurrence { time: "09:00".into(), rule: RecurrenceRule::Daily };
        let old_fire_at = Utc::now() - chrono::Duration::minutes(1);
        let item = make_item(old_fire_at, Some(rec));
        let now = Utc::now();
        let updated = compute_fired(&state, item, now).await;
        assert_eq!(updated.status, ScheduledStatus::Pending, "recurring item stays Pending regardless of fire outcome");
        assert_ne!(updated.fire_at, old_fire_at.to_rfc3339());
    }
}
