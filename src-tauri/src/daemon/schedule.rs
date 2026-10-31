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

use super::meeting_monitor::{holds_for_meeting, MeetingSnapshot, SCHEDULE_LINGER, SCHEDULE_LOOKAHEAD_SECS};
use super::schedule_fire;
use super::schedule_guard::{self, GuardVerdict};
use crate::daemon::state::DaemonState;
use crate::sessions::scheduled_items::{self, ScheduledItem, ScheduledKind, ScheduledStatus, SkippedFire};
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
    let started_at = Utc::now();
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
            tick(&state, started_at).await;
        }
    });
}

/// How late an item is for grace purposes. A one-shot `Message` (a `this_chat`
/// wake-up) whose fire time passed while the daemon was not running has its
/// downtime credited: lateness counts from `max(fire_at, daemon_started_at)`,
/// so a PC that was off for hours still delivers the nudge once on the next
/// start instead of marking it Missed. The prompt is self-contained by design,
/// so a late delivery is still useful.
///
/// Anchored on the daemon's start rather than "the first tick" so an item
/// deferred by the busy guard on that first tick keeps its credit on later
/// ticks. Only `Message` one-shots get it: a `NewChat` or recurring item stays
/// on the real lateness (recurring ones keep their next-occurrence behavior),
/// and an item that went overdue while the daemon was up has `fire_at` after
/// `daemon_started_at`, so it is judged exactly as before.
fn grace_lateness_secs(
    item: &ScheduledItem,
    fire_at: DateTime<Utc>,
    now: DateTime<Utc>,
    daemon_started_at: DateTime<Utc>,
) -> i64 {
    let one_shot_message = item.recurrence.is_none() && matches!(item.kind, ScheduledKind::Message { .. });
    let anchor = if one_shot_message { fire_at.max(daemon_started_at) } else { fire_at };
    (now - anchor).num_seconds()
}

/// Whether the meeting gate keeps this due item waiting. Waiting leaves it
/// Pending and unclaimed (the next tick asks again), so it is not a skip and
/// never touches the guard.
fn waits_for_meeting(item: &ScheduledItem, snapshot: &MeetingSnapshot, fire_at: DateTime<Utc>, now: DateTime<Utc>) -> bool {
    item.waits_for_meeting() && holds_for_meeting(snapshot, fire_at, now)
}

/// Lateness of a gated item, or `None` while the meeting still holds it. Time
/// spent held is not lateness: the grace clock restarts from the last moment a
/// meeting was seen (never earlier than `fire_at`), so an item the gate just
/// released, by the call ending or by the max wait, still fires instead of being
/// Missed for the hours it waited. With no meeting seen since it came due the
/// anchor stays `fire_at`, so it ages out exactly like an ungated item.
fn gated_lateness_secs(
    item: &ScheduledItem,
    snapshot: &MeetingSnapshot,
    fire_at: DateTime<Utc>,
    now: DateTime<Utc>,
    daemon_started_at: DateTime<Utc>,
) -> Option<i64> {
    if waits_for_meeting(item, snapshot, fire_at, now) {
        return None;
    }
    let anchor = snapshot.last_active.map_or(fire_at, |t| t.max(fire_at));
    Some(grace_lateness_secs(item, anchor, now, daemon_started_at))
}

/// A meeting reading older than this is taken again before a gated item is
/// judged: a slow sample ahead of it in the tick can take long enough for a
/// call to have started or ended.
const MEETING_SAMPLE_MAX_AGE: Duration = Duration::from_secs(5);

fn meeting_sample_is_stale(age: Duration) -> bool {
    age > MEETING_SAMPLE_MAX_AGE
}

/// Starts the meeting poller ahead of time for any gated item about to come
/// due, so the debounce has samples behind it when the item is judged.
fn demand_meeting_for_upcoming(state: &Arc<DaemonState>, items: &[ScheduledItem], now: DateTime<Utc>) {
    let upcoming = items.iter().any(|it| {
        it.waits_for_meeting()
            && matches!(it.status, ScheduledStatus::Pending)
            && DateTime::parse_from_rfc3339(&it.fire_at)
                .is_ok_and(|t| (t.with_timezone(&Utc) - now).num_seconds() <= SCHEDULE_LOOKAHEAD_SECS)
    });
    if upcoming {
        state.meeting.demand(SCHEDULE_LINGER);
    }
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

/// An item this tick decided to act on, not yet claimed.
struct Due {
    item: ScheduledItem,
    /// The `now` its lateness was judged against.
    now: DateTime<Utc>,
    /// Past the grace window: it goes to Missed and its guard never runs.
    past_grace: bool,
}

/// One scheduler tick: evaluate every Pending item against `now`.
async fn tick(state: &Arc<DaemonState>, daemon_started_at: DateTime<Utc>) {
    let now = Utc::now();
    let grace_secs = state
        .settings
        .snapshot()
        .schedule_grace_secs
        .map(|s| s as i64)
        .unwrap_or(DEFAULT_GRACE_SECS);
    let mut changed = false;
    let items = scheduled_items::list();
    demand_meeting_for_upcoming(state, &items, now);
    // Read only when a gated item is actually due, and reused while fresh.
    let mut meeting: Option<(MeetingSnapshot, std::time::Instant)> = None;
    let mut due: Vec<Due> = Vec::new();
    for item in items {
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
        let (now, lateness) = if item.waits_for_meeting() {
            let snapshot = match meeting {
                Some((s, taken)) if !meeting_sample_is_stale(taken.elapsed()) => s,
                _ => {
                    let s = state.meeting.sample_blocking().await;
                    meeting = Some((s, std::time::Instant::now()));
                    s
                }
            };
            // The tick's `now` may predate an earlier item's meeting sample.
            let now = Utc::now();
            match gated_lateness_secs(&item, &snapshot, fire_at, now, daemon_started_at) {
                Some(lateness) => (now, lateness),
                None => continue, // stays Pending; asked again next tick
            }
        } else {
            (now, grace_lateness_secs(&item, fire_at, now, daemon_started_at))
        };
        // Defect 4 guard: a live, busy Message-kind session (mid-turn) must
        // not be written into out of band - every interactive send path
        // respects the same busy gate. Only defer within the grace window;
        // once grace is exhausted we fall through to the normal Missed path
        // below instead of deferring forever, so the popup gives the user
        // manual control.
        if lateness < grace_secs && is_message_session_busy(state, &item) {
            continue; // stays Pending; retried next tick (~30s later)
        }
        due.push(Due { item, now, past_grace: lateness >= grace_secs });
    }
    // Guards run side by side and BEFORE the claim: run inline per item, each
    // slow one (up to its 30s timeout) held every other due item behind it,
    // and running them after the claim would leave the row on "Firing" for the
    // whole check. A verdict is only ever a decision about whether to send;
    // the send itself still waits for the claim below.
    let verdicts = guard_verdicts(due.iter().map(|d| (!d.past_grace).then_some(&d.item))).await;
    for (due, pre_verdict) in due.into_iter().zip(verdicts) {
        let Due { item, now, past_grace } = due;
        // Atomic claim (Defects 1 & 3): flips Pending -> Firing and persists
        // BEFORE any fire is attempted. `None` means a concurrent fire_now
        // (or a delete/update) already claimed or removed this item this
        // tick, so there's nothing left for us to do.
        let Some(claimed) = claim_unless_busy(state, &item, past_grace, scheduled_items::claim_for_fire) else {
            continue;
        };
        let result = if past_grace {
            compute_missed(claimed, now)
        } else if guard_of(&claimed) == guard_of(&item) {
            apply_guard_verdict(state, claimed, now, pre_verdict).await
        } else {
            // Edited while the guard ran: that verdict belongs to the old command.
            compute_guarded(state, claimed, now).await
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

/// The claim step of one due item, with the busy gate re-applied. The gate in
/// the collection loop runs before ANY due item has fired, so two items aimed
/// at the same idle session both pass it; the first fire then marks the session
/// busy and the second would claim, hit `fire_message`'s busy refusal and be
/// recorded as a failure (a one-shot goes Failed, a recurring one loses the
/// occurrence). Checking again right before the claim, after the earlier items
/// in this tick have fired, leaves such an item Pending for the next tick.
/// `claim` is injected because the real one writes the on-disk item store.
fn claim_unless_busy(
    state: &Arc<DaemonState>,
    item: &ScheduledItem,
    past_grace: bool,
    claim: impl FnOnce(&str) -> Option<ScheduledItem>,
) -> Option<ScheduledItem> {
    // Past grace the item is Missed, never sent, so a busy target is irrelevant.
    if !past_grace && is_message_session_busy(state, item) {
        return None;
    }
    claim(&item.id)
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
/// notifier method (`instances_changed`, ...- see
/// `daemon_link::handle_daemon_notification`). The app-side Tauri event
/// (`scheduled-items-changed`, hyphenated per the rest of that layer's
/// `instances-changed` convention) is wired up where the
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

/// The scheduled (not manual) firing path: runs the item's guard first, and a
/// guard that says skip ends the firing here without creating a chat. `fire_now`
/// bypasses this on purpose - a click on Fire now / Retry is an explicit "run
/// it", and a guard that answered "already ran" must not swallow it.
async fn compute_guarded(state: &Arc<DaemonState>, item: ScheduledItem, now: DateTime<Utc>) -> ScheduledItem {
    let verdict = guard_verdict(&item, now).await;
    apply_guard_verdict(state, item, now, verdict).await
}

/// Runs the item's guard, if it has one. `None` means there was nothing to run.
async fn guard_verdict(item: &ScheduledItem, now: DateTime<Utc>) -> Option<GuardVerdict> {
    let (command, cwd) = guard_of(item)?;
    let fire_date = DateTime::parse_from_rfc3339(&item.fire_at)
        .map(|dt| dt.with_timezone(&chrono::Local).format("%Y-%m-%d").to_string())
        .unwrap_or_else(|_| now.with_timezone(&chrono::Local).format("%Y-%m-%d").to_string());
    Some(schedule_guard::run(&command, &cwd, &item.id, &fire_date).await)
}

/// One verdict per input slot (a `None` slot runs no guard), taken concurrently
/// so N slow guards cost the slowest one rather than their sum.
async fn guard_verdicts<'a>(items: impl Iterator<Item = Option<&'a ScheduledItem>>) -> Vec<Option<GuardVerdict>> {
    let now = Utc::now();
    futures_util::future::join_all(items.map(|slot| async move {
        match slot {
            Some(item) => guard_verdict(item, now).await,
            None => None,
        }
    }))
    .await
}

async fn apply_guard_verdict(
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
fn guard_of(item: &ScheduledItem) -> Option<(String, std::path::PathBuf)> {
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
fn compute_skipped(mut item: ScheduledItem, now: DateTime<Utc>, reason: String) -> ScheduledItem {
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
    use crate::daemon::meeting_monitor::{AFTER_MEETING_DEBOUNCE_SECS, AFTER_MEETING_MAX_WAIT_SECS};
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

    // --- grace_lateness_secs: the downtime credit, pure so no store I/O ---

    const GRACE: i64 = DEFAULT_GRACE_SECS;

    #[test]
    fn this_chat_one_shot_overdue_across_downtime_is_inside_grace_on_the_first_tick() {
        let now = Utc::now();
        let started = now - chrono::Duration::seconds(30);
        // Fire time was ~2h before the daemon came back up.
        let fire_at = started - chrono::Duration::hours(2);
        let item = make_item(fire_at, None);
        let lateness = grace_lateness_secs(&item, fire_at, now, started);
        assert!(lateness < GRACE, "downtime must not count against grace, got {lateness}");
        assert_eq!(lateness, 30, "counted from the daemon's start, not the original fire time");
    }

    #[test]
    fn this_chat_one_shot_that_went_overdue_while_the_daemon_was_up_is_still_missed() {
        let now = Utc::now();
        let started = now - chrono::Duration::hours(5);
        let fire_at = now - chrono::Duration::seconds(GRACE + 60);
        let item = make_item(fire_at, None);
        let lateness = grace_lateness_secs(&item, fire_at, now, started);
        assert!(lateness >= GRACE, "mid-run overdue keeps the grace/Missed path, got {lateness}");
    }

    #[test]
    fn downtime_credit_survives_later_ticks_so_a_busy_deferral_is_not_missed() {
        let started = Utc::now() - chrono::Duration::minutes(10);
        let fire_at = started - chrono::Duration::hours(8);
        let item = make_item(fire_at, None);
        let lateness = grace_lateness_secs(&item, fire_at, Utc::now(), started);
        assert_eq!(lateness, 600);
    }

    #[test]
    fn recurring_and_new_chat_items_get_no_downtime_credit() {
        let now = Utc::now();
        let started = now - chrono::Duration::seconds(30);
        let fire_at = started - chrono::Duration::hours(2);
        let rec = Recurrence { time: "09:00".into(), rule: RecurrenceRule::Daily };
        let recurring = make_item(fire_at, Some(rec));
        assert!(grace_lateness_secs(&recurring, fire_at, now, started) >= GRACE);
        let new_chat = ScheduledItem::new(
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
            fire_at.to_rfc3339(),
            None,
        );
        assert!(grace_lateness_secs(&new_chat, fire_at, now, started) >= GRACE);
    }

    // --- pre-fire guard ---

    fn guarded(guard: &str, cwd: &str, recurrence: Option<Recurrence>) -> ScheduledItem {
        let mut item = ScheduledItem::new(
            ScheduledKind::Message { session_id: "ghost-session".into(), cwd: cwd.into() },
            "hi".into(),
            (Utc::now() - chrono::Duration::minutes(1)).to_rfc3339(),
            recurrence,
        );
        item.guard = Some(guard.to_string());
        item
    }

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

    // --- after_meeting gate ---

    fn gated(fire_at: DateTime<Utc>) -> ScheduledItem {
        let mut item = make_item(fire_at, None);
        item.after_meeting = Some(true);
        item
    }

    fn mic() -> crate::meeting::Sources {
        crate::meeting::Sources { mic: true, ..Default::default() }
    }

    fn monitor() -> crate::daemon::meeting_monitor::MeetingMonitor {
        use crate::meeting::SignalSource;
        struct Off;
        impl SignalSource for Off {
            fn camera_in_use(&self) -> bool {
                false
            }
            fn mic_in_use(&self) -> bool {
                false
            }
            fn meeting_app_audio_active(&self, _: &[String]) -> bool {
                false
            }
        }
        crate::daemon::meeting_monitor::MeetingMonitor::with_source(Box::new(Off))
    }

    #[test]
    fn a_gated_item_does_not_fire_during_a_meeting_and_fires_once_the_debounce_has_passed() {
        let fire_at = Utc::now() - chrono::Duration::minutes(2);
        let item = gated(fire_at);
        let m = monitor();
        let t = fire_at + chrono::Duration::minutes(1);

        m.record(mic(), t);
        assert!(waits_for_meeting(&item, &m.snapshot(), fire_at, t + chrono::Duration::seconds(30)), "during the call");

        let ended = t + chrono::Duration::minutes(20);
        m.record(mic(), ended);
        m.record(Default::default(), ended + chrono::Duration::seconds(3));
        let soon = ended + chrono::Duration::seconds(AFTER_MEETING_DEBOUNCE_SECS - 1);
        assert!(waits_for_meeting(&item, &m.snapshot(), fire_at, soon), "inside the gap between back-to-back calls");

        let after = ended + chrono::Duration::seconds(AFTER_MEETING_DEBOUNCE_SECS);
        assert!(!waits_for_meeting(&item, &m.snapshot(), fire_at, after), "released after the quiet window");
    }

    #[test]
    fn an_ungated_item_never_waits_on_a_meeting() {
        let fire_at = Utc::now() - chrono::Duration::minutes(2);
        let m = monitor();
        m.record(mic(), fire_at);
        assert!(!waits_for_meeting(&make_item(fire_at, None), &m.snapshot(), fire_at, fire_at));
    }

    #[test]
    fn a_gated_item_stops_waiting_at_the_max_wait_even_in_a_meeting() {
        let fire_at = Utc::now() - chrono::Duration::hours(4);
        let m = monitor();
        let now = fire_at + chrono::Duration::seconds(AFTER_MEETING_MAX_WAIT_SECS);
        m.record(mic(), now);
        assert!(!waits_for_meeting(&gated(fire_at), &m.snapshot(), fire_at, now));
    }

    #[test]
    fn a_gated_item_two_hours_late_with_no_meeting_is_missed_like_an_ungated_one() {
        let now = Utc::now();
        let started = now - chrono::Duration::hours(10);
        let fire_at = now - chrono::Duration::hours(2);
        let snapshot = monitor().snapshot();
        let gated_lateness = gated_lateness_secs(&gated(fire_at), &snapshot, fire_at, now, started).expect("no meeting holds it");
        let ungated_lateness = grace_lateness_secs(&make_item(fire_at, None), fire_at, now, started);
        assert_eq!(gated_lateness, ungated_lateness);
        assert!(gated_lateness >= GRACE, "past the plain grace window, so the tick marks it Missed");
    }

    #[test]
    fn a_gated_item_held_by_a_meeting_two_hours_late_is_not_judged_at_all() {
        let now = Utc::now();
        let started = now - chrono::Duration::hours(10);
        let fire_at = now - chrono::Duration::hours(2);
        let m = monitor();
        m.record(mic(), now);
        assert_eq!(gated_lateness_secs(&gated(fire_at), &m.snapshot(), fire_at, now, started), None);
    }

    #[test]
    fn a_gated_item_released_after_a_long_hold_fires_instead_of_being_missed() {
        let started = Utc::now() - chrono::Duration::hours(10);
        let fire_at = Utc::now() - chrono::Duration::hours(4);

        // The max wait lets go of a meeting that is still reported.
        let at_max = fire_at + chrono::Duration::seconds(AFTER_MEETING_MAX_WAIT_SECS);
        let m = monitor();
        m.record(mic(), at_max);
        let lateness = gated_lateness_secs(&gated(fire_at), &m.snapshot(), fire_at, at_max, started).expect("released");
        assert!(lateness < GRACE, "the hold does not count as lateness, got {lateness}");

        // The call ended two hours in and the debounce has passed.
        let ended = fire_at + chrono::Duration::hours(2);
        let m = monitor();
        m.record(mic(), ended);
        m.record(Default::default(), ended + chrono::Duration::seconds(3));
        let after = ended + chrono::Duration::seconds(AFTER_MEETING_DEBOUNCE_SECS);
        let lateness = gated_lateness_secs(&gated(fire_at), &m.snapshot(), fire_at, after, started).expect("released");
        assert!(lateness < GRACE, "got {lateness}");
    }

    #[test]
    fn a_meeting_that_ended_before_the_item_came_due_does_not_shift_its_grace() {
        let now = Utc::now();
        let started = now - chrono::Duration::hours(10);
        let fire_at = now - chrono::Duration::hours(2);
        let m = monitor();
        m.record(mic(), fire_at - chrono::Duration::hours(1));
        m.record(Default::default(), fire_at - chrono::Duration::minutes(59));
        let lateness = gated_lateness_secs(&gated(fire_at), &m.snapshot(), fire_at, now, started).expect("not held");
        assert_eq!(lateness, 2 * 3600);
    }

    #[test]
    fn a_meeting_reading_goes_stale_after_a_few_seconds() {
        assert!(!meeting_sample_is_stale(Duration::from_secs(0)));
        assert!(!meeting_sample_is_stale(MEETING_SAMPLE_MAX_AGE));
        assert!(meeting_sample_is_stale(MEETING_SAMPLE_MAX_AGE + Duration::from_millis(1)));
        assert!(meeting_sample_is_stale(Duration::from_secs(30)), "after a guard command's worth of time");
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

    fn message_to(session_id: &str) -> ScheduledItem {
        ScheduledItem::new(
            ScheduledKind::Message { session_id: session_id.into(), cwd: "C:/proj".into() },
            "hi".into(),
            Utc::now().to_rfc3339(),
            None,
        )
    }

    #[test]
    fn a_second_due_message_to_the_same_session_stays_pending_once_the_first_has_fired() {
        let state = test_state();
        state.registry.upsert_interactive("shared", std::path::Path::new("C:/proj"), "proj-1", "2026-01-01T00:00:00Z");
        let (a, b) = (message_to("shared"), message_to("shared"));
        // Both passed the collection loop's gate: nothing had fired yet.
        assert!(!is_message_session_busy(&state, &a) && !is_message_session_busy(&state, &b));

        let claimed_a = claim_unless_busy(&state, &a, false, |id| {
            // Stands in for A's fire, which marks the session busy.
            state.registry.set_busy("shared", true);
            Some(ScheduledItem { id: id.to_string(), ..a.clone() })
        });
        assert!(claimed_a.is_some(), "the first item claims normally");

        let mut b_claim_attempted = false;
        let claimed_b = claim_unless_busy(&state, &b, false, |_| {
            b_claim_attempted = true;
            Some(b.clone())
        });
        assert!(claimed_b.is_none(), "B is left for the next tick");
        assert!(!b_claim_attempted, "B must not be claimed: a claimed row can only be finished as fired or failed");
    }

    #[test]
    fn a_busy_target_does_not_stop_a_past_grace_item_from_going_missed() {
        let state = test_state();
        state.registry.upsert_interactive("busy-s", std::path::Path::new("C:/proj"), "proj-1", "2026-01-01T00:00:00Z");
        state.registry.set_busy("busy-s", true);
        let item = message_to("busy-s");
        assert!(claim_unless_busy(&state, &item, true, |_| Some(item.clone())).is_some());
    }

    #[test]
    fn an_idle_target_is_claimed() {
        let state = test_state();
        state.registry.upsert_interactive("idle-s", std::path::Path::new("C:/proj"), "proj-1", "2026-01-01T00:00:00Z");
        let item = message_to("idle-s");
        assert!(claim_unless_busy(&state, &item, false, |_| Some(item.clone())).is_some());
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
