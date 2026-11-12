//! The after-meeting gate: whether a due item waits for a call to end, how late it
//! is once released, and the meeting-reading freshness the tick relies on.

use crate::daemon::meeting_monitor::{holds_for_meeting, MeetingSnapshot, SCHEDULE_LINGER, SCHEDULE_LOOKAHEAD_SECS};
use crate::daemon::state::DaemonState;
use crate::sessions::scheduled_items::{ScheduledItem, ScheduledKind, ScheduledStatus};
use chrono::{DateTime, Utc};
use std::sync::Arc;
use std::time::Duration;

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
pub(super) fn grace_lateness_secs(
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
pub(super) fn waits_for_meeting(item: &ScheduledItem, snapshot: &MeetingSnapshot, fire_at: DateTime<Utc>, now: DateTime<Utc>) -> bool {
    item.waits_for_meeting() && holds_for_meeting(snapshot, fire_at, now)
}

/// Lateness of a gated item, or `None` while the meeting still holds it. Time
/// spent held is not lateness: the grace clock restarts from the last moment a
/// meeting was seen (never earlier than `fire_at`), so an item the gate just
/// released, by the call ending or by the max wait, still fires instead of being
/// Missed for the hours it waited. With no meeting seen since it came due the
/// anchor stays `fire_at`, so it ages out exactly like an ungated item.
pub(super) fn gated_lateness_secs(
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

pub(super) fn meeting_sample_is_stale(age: Duration) -> bool {
    age > MEETING_SAMPLE_MAX_AGE
}

/// Starts the meeting poller ahead of time for any gated item about to come
/// due, so the debounce has samples behind it when the item is judged.
pub(super) fn demand_meeting_for_upcoming(state: &Arc<DaemonState>, items: &[ScheduledItem], now: DateTime<Utc>) {
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

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::test_support::{gated, make_item};
    use super::super::DEFAULT_GRACE_SECS;
    use crate::daemon::meeting_monitor::{AFTER_MEETING_DEBOUNCE_SECS, AFTER_MEETING_MAX_WAIT_SECS};
    use crate::sessions::scheduled_items::{Recurrence, RecurrenceRule};

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
                subchats_on: false,
            },
            "hi".into(),
            fire_at.to_rfc3339(),
            None,
        );
        assert!(grace_lateness_secs(&new_chat, fire_at, now, started) >= GRACE);
    }

    // --- after_meeting gate ---

    fn mic() -> crate::meeting::Sources {
        crate::meeting::Sources { mic: true, ..Default::default() }
    }

    fn monitor() -> crate::daemon::meeting_monitor::MeetingMonitor {
        crate::daemon::meeting_monitor::MeetingMonitor::with_source(Box::new(crate::meeting::test_support::Fixed(Default::default())))
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
}
