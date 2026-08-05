//! Daemon-side scheduler for scheduled messages / scheduled new-chats
//! (`sessions::scheduled_items`). Mirrors `crate::scheduler`'s wall-clock
//! chunked-sleep pattern (see `scheduler.rs:114-128`, standby-safe) but on a
//! short fixed ~30s tick rather than a single aligned poll slot, since
//! scheduled items fire at arbitrary times.
//!
//! Each tick: load every item, fire (or mark Missed) whatever is due, then
//! emit `scheduled_items_changed` at most once for the whole tick via the
//! daemon's existing notifier broadcast (the same mechanism `instances_
//! changed` uses - see `daemon::notifier`).
//!
//! Split into `schedule_fire.rs` (todo 419): the `fire_kind` dispatcher and
//! its four per-kind handlers (`fire_jarvis_hygiene`, `fire_message`,
//! `respawn_for_message`, `fire_new_chat`). This module keeps the tick loop
//! and the claim/compute bookkeeping around it.

use super::schedule_fire;
use crate::daemon::state::DaemonState;
use crate::sessions::scheduled_items::{self, ScheduledItem, ScheduledKind, ScheduledStatus};
use chrono::{DateTime, Utc};
use std::sync::Arc;
use std::time::Duration;

const TICK_SECS: u64 = 30;
const SLEEP_CHUNK_SECS: u64 = 15;
/// Fallback grace window when `Settings.schedule_grace_secs` is unset.
const DEFAULT_GRACE_SECS: i64 = 3600;

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

/// Spawn the scheduler tick loop. Call once at daemon startup, alongside the
/// other background loops in `daemon::run_daemon_main` (e.g. `detector_task::spawn`).
pub fn spawn(state: Arc<DaemonState>) {
    tokio::spawn(async move {
        // Startup recovery: an item stuck in `Firing` means the daemon died
        // mid-fire on a previous run (claimed and persisted, but `finish_fire`
        // never ran) - resolve the ambiguity to `Failed` before the first
        // tick so it can't be silently re-fired.
        if scheduled_items::sweep_firing_to_failed() {
            notify_changed(&state);
        }
        loop {
            sleep_chunked(TICK_SECS).await;
            tick(&state).await;
        }
    });
}

/// Sleeps in `SLEEP_CHUNK_SECS` steps instead of one long sleep, so a system
/// suspend/resume is recovered from within one chunk instead of missing a
/// whole tick - same rationale as `scheduler::sleep_until_next_target`.
async fn sleep_chunked(total_secs: u64) {
    let mut remaining = total_secs;
    while remaining > 0 {
        let step = remaining.min(SLEEP_CHUNK_SECS);
        tokio::time::sleep(Duration::from_secs(step)).await;
        remaining -= step;
    }
}

/// One scheduler tick: evaluate every Pending item against `now`.
async fn tick(state: &Arc<DaemonState>) {
    let now = Utc::now();
    let grace_secs = state
        .settings
        .snapshot()
        .schedule_grace_secs
        .map(|s| s as i64)
        .unwrap_or(DEFAULT_GRACE_SECS);
    let mut changed = false;
    for item in scheduled_items::list() {
        if !matches!(item.status, ScheduledStatus::Pending) {
            continue;
        }
        let Ok(fire_at) = DateTime::parse_from_rfc3339(&item.fire_at) else {
            log::warn!("scheduled item {} has unparsable fire_at {:?}; skipping", item.id, item.fire_at);
            continue;
        };
        let fire_at = fire_at.with_timezone(&Utc);
        if fire_at > now {
            continue;
        }
        let lateness = (now - fire_at).num_seconds();
        // Defect 4 guard: a live, busy Message-kind session (mid-turn) must
        // not be written into out of band - every interactive send path
        // respects the same busy gate. Only defer within the grace window;
        // once grace is exhausted we fall through to the normal Missed path
        // below instead of deferring forever, so the popup gives the user
        // manual control.
        if lateness < grace_secs && is_message_session_busy(state, &item) {
            continue; // stays Pending; retried next tick (~30s later)
        }
        // Atomic claim (Defects 1 & 3): flips Pending -> Firing and persists
        // BEFORE any fire is attempted. `None` means a concurrent fire_now
        // (or a delete/update) already claimed or removed this item this
        // tick, so there's nothing left for us to do.
        let Some(claimed) = scheduled_items::claim_for_fire(&item.id) else {
            continue;
        };
        let result = if lateness >= grace_secs {
            compute_missed(claimed, now)
        } else {
            compute_fired(state, claimed, now).await
        };
        // Defect 2: only writes back if the item is still the `Firing` record
        // we claimed - a concurrent delete/update wins over this stale
        // write-back instead of being resurrected.
        if scheduled_items::finish_fire(result) {
            changed = true;
        }
    }
    if changed {
        notify_changed(state);
    }
}

/// Defect 4 guard: only `Message`-kind items can collide with an in-flight
/// turn on an existing session (a `NewChat` always spawns fresh, so it never
/// races with one). "Busy" mirrors the exact flag every interactive send path
/// checks before writing into a session - `sessions::registry::Instance::busy`,
/// set by `daemon::lifecycle`'s `set_busy`/`set_busy_false_if_gen` around a
/// turn's lifetime (see `daemon/lifecycle.rs` pump loop).
fn is_message_session_busy(state: &Arc<DaemonState>, item: &ScheduledItem) -> bool {
    match &item.kind {
        ScheduledKind::Message { session_id, .. } => {
            state.registry.get(session_id).map(|inst| inst.busy).unwrap_or(false)
        }
        ScheduledKind::NewChat { .. } => false,
        // Never deferred at this level: `fire_jarvis_hygiene` routes through
        // the jarvis wake queue, which has its own busy check and its own
        // retry-on-next-trigger discipline (see that function's doc comment).
        ScheduledKind::JarvisHygiene => false,
    }
}

/// Fires exactly one item by id right now, regardless of its current
/// `fire_at` - used by the `schedule_fire_now` RPC so "fire now" doesn't wait
/// for the next tick. No-ops if the item is unknown or not Pending (including
/// "not Pending because the tick loop just claimed it" - the same atomic
/// claim that guards against the tick loop racing itself also guards this
/// explicit user action). Has no busy check of its own for `NewChat`/
/// `JarvisHygiene` (neither can collide with a mid-turn session), but a
/// `Message` fire into a busy target still refuses inside `fire_message`.
pub async fn fire_now(state: &Arc<DaemonState>, id: &str) {
    let Some(claimed) = scheduled_items::claim_for_fire(id) else { return };
    let now = Utc::now();
    let result = compute_fired(state, claimed, now).await;
    if scheduled_items::finish_fire(result) {
        notify_changed(state);
    }
}

/// Daemon-side notifier method name; snake_case to match every other
/// notifier method (`instances_changed`, `channels_changed`, ...- see
/// `daemon_link::handle_daemon_notification`). The app-side Tauri event
/// (`scheduled-items-changed`, hyphenated per the rest of that layer's
/// `instances-changed` / `channels-changed` convention) is wired up where the
/// schedule view consumes it (later phase); this only emits the daemon-side
/// notification.
fn notify_changed(state: &Arc<DaemonState>) {
    state.notifier.publish(
        "scheduled_items_changed",
        serde_json::json!({ "items": scheduled_items::list() }),
    );
}

/// Past the grace window: never fires. Recurring items reset to Pending at
/// their next occurrence (computed from `now`, not the missed `fire_at`, so a
/// long-missed daily item doesn't immediately re-fire); one-shots go terminal.
/// Pure (no store I/O) so it's directly unit-testable; the caller persists
/// the returned item via `scheduled_items::upsert`.
fn compute_missed(mut item: ScheduledItem, now: DateTime<Utc>) -> ScheduledItem {
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
async fn compute_fired(state: &Arc<DaemonState>, mut item: ScheduledItem, now: DateTime<Utc>) -> ScheduledItem {
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
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::sessions::scheduled_items::{Recurrence, RecurrenceRule};
    use crate::types::Settings;

    fn test_state() -> Arc<DaemonState> {
        DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()))
    }

    fn make_item(fire_at: DateTime<Utc>, recurrence: Option<Recurrence>) -> ScheduledItem {
        ScheduledItem::new(
            ScheduledKind::Message { session_id: "ghost-session".into(), cwd: "Z:\\does\\not\\exist".into() },
            "hi".into(),
            fire_at.to_rfc3339(),
            recurrence,
        )
    }

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

    #[tokio::test]
    async fn fire_now_unknown_id_is_a_noop() {
        let state = test_state();
        // Must not panic even though the id was never created. Read-only
        // (claim_for_fire on a nonexistent id never writes), so this is safe
        // against the real data dir too.
        fire_now(&state, "totally-unknown-id").await;
    }

    // --- Defect 4: is_message_session_busy (pure - registry is in-memory, no
    // store I/O, so these never touch the real scheduled-items.json) ---

    #[test]
    fn is_message_session_busy_true_when_registry_marks_busy() {
        let state = test_state();
        state.registry.upsert_interactive("sess-live", std::path::Path::new("C:/proj"), "proj-1", "2026-01-01T00:00:00Z");
        state.registry.set_busy("sess-live", true);
        let item = ScheduledItem::new(
            ScheduledKind::Message { session_id: "sess-live".into(), cwd: "C:/proj".into() },
            "hi".into(),
            Utc::now().to_rfc3339(),
            None,
        );
        assert!(is_message_session_busy(&state, &item));
    }

    #[test]
    fn is_message_session_busy_false_when_registry_not_busy() {
        let state = test_state();
        state.registry.upsert_interactive("sess-idle", std::path::Path::new("C:/proj"), "proj-1", "2026-01-01T00:00:00Z");
        let item = ScheduledItem::new(
            ScheduledKind::Message { session_id: "sess-idle".into(), cwd: "C:/proj".into() },
            "hi".into(),
            Utc::now().to_rfc3339(),
            None,
        );
        assert!(!is_message_session_busy(&state, &item));
    }

    #[test]
    fn is_message_session_busy_false_when_session_unknown() {
        let state = test_state();
        let item = make_item(Utc::now(), None); // "ghost-session", never registered
        assert!(!is_message_session_busy(&state, &item));
    }

    #[test]
    fn is_message_session_busy_false_for_new_chat_kind_regardless_of_registry() {
        let state = test_state();
        let item = ScheduledItem::new(
            ScheduledKind::NewChat {
                cwd: "C:/proj".into(),
                model: "opus".into(),
                effort: "high".into(),
                account_id: None,
                placeholder_id: None,
                character_id: None,
                auto_accept: false,
            },
            "hi".into(),
            Utc::now().to_rfc3339(),
            None,
        );
        assert!(!is_message_session_busy(&state, &item), "NewChat never spawns into an existing turn, so it needs no busy check");
    }

    #[test]
    fn is_message_session_busy_false_for_jarvis_hygiene_kind_regardless_of_registry() {
        let state = test_state();
        let item = ScheduledItem::new(ScheduledKind::JarvisHygiene, "hi".into(), Utc::now().to_rfc3339(), None);
        assert!(!is_message_session_busy(&state, &item), "JarvisHygiene defers to the wake queue, not the tick's busy guard");
    }
}
