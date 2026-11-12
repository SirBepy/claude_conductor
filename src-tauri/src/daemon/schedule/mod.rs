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

mod gate;
mod guard;
mod outcome;
#[cfg(test)]
mod test_support;

use super::meeting_monitor::MeetingSnapshot;
use super::schedule_fire;
use crate::daemon::state::DaemonState;
use crate::sessions::scheduled_items::{self, ScheduledItem, ScheduledKind, ScheduledStatus};
use gate::{demand_meeting_for_upcoming, gated_lateness_secs, grace_lateness_secs, meeting_sample_is_stale};
pub use outcome::next_stagger_slot;
pub(crate) use outcome::RATE_LIMITED_PREFIX;
#[cfg(test)]
pub(crate) use outcome::parse_rate_limited;
use outcome::{compute_fired, compute_missed};
use guard::{apply_guard_verdict, compute_guarded, guard_of, guard_verdicts};
use chrono::{DateTime, Utc};
use std::sync::Arc;
use std::time::Duration;

const TICK_SECS: u64 = 30;
const SLEEP_CHUNK_SECS: u64 = 15;
/// Fallback grace window when `Settings.schedule_grace_secs` is unset.
const DEFAULT_GRACE_SECS: i64 = 3600;

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


#[cfg(test)]
mod tests {
    use super::*;
    use super::test_support::{make_item, test_state};


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
                subchats_on: false,
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
