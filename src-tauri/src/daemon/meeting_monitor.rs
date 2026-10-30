//! The daemon's own view of "is Joe in a meeting right now".
//!
//! `crate::meeting::start` keeps `AppState.meeting_active` for the app's UI, but
//! the daemon is a separate process and cannot read that flag, so the two
//! consumers that live here (the `in_meeting` MCP tool and the schedule's
//! `after_meeting` gate) read the OS signals through this monitor instead.
//!
//! Nothing is persisted. The state is a live snapshot plus two in-memory
//! timestamps, so no record of when a meeting started or ended survives the
//! process.
//!
//! The poller runs only while a consumer has asked for it recently (`demand`)
//! and exits once the request lapses, so with no tool call and no gated item
//! the daemon does no registry/COM/process work at all.

use crate::meeting::{compute_in_meeting, default_meeting_apps, platform_source, SignalSource, Sources};
use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Same beat as the app-side watcher (`meeting::POLL_INTERVAL`).
const POLL_INTERVAL: Duration = Duration::from_secs(3);

/// How long the poller keeps running after an `in_meeting` call. It keeps the
/// snapshot's `since` honest for a chat that asks again a few minutes later.
pub(crate) const TOOL_LINGER: Duration = Duration::from_secs(10 * 60);

/// How long the poller keeps running after the schedule tick last asked. The
/// tick fires every 30s, so this spans a few missed ticks without letting the
/// poller outlive the last gated item by much.
pub(crate) const SCHEDULE_LINGER: Duration = Duration::from_secs(90);

/// How far ahead of its fire time a gated item starts the poller, so the
/// debounce below has real samples behind it instead of a cold start.
pub(crate) const SCHEDULE_LOOKAHEAD_SECS: i64 = 5 * 60;

/// How long after the last active sample a gated item keeps waiting. Without
/// it, the few seconds between one call ending and the next starting (leave,
/// rejoin, switch app) would read as "meeting over" and fire the item into the
/// next call.
pub(crate) const AFTER_MEETING_DEBOUNCE_SECS: i64 = 20;

/// A gated item stops waiting this long after its fire time even if a meeting
/// is still reported. The detector can latch on (a mic held by an app that is
/// not a call), and an item must not wait on that forever.
pub(crate) const AFTER_MEETING_MAX_WAIT_SECS: i64 = 3 * 60 * 60;

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct MeetingSnapshot {
    pub active: bool,
    pub sources: Sources,
    /// When this process first saw the current meeting, not when the call
    /// really began: a meeting already running at the first sample reads as
    /// starting then.
    pub since: Option<DateTime<Utc>>,
    /// The latest sample that saw a meeting, kept after it ends so the
    /// debounce can measure the silence that followed.
    pub last_active: Option<DateTime<Utc>>,
}

impl MeetingSnapshot {
    /// The `in_meeting` tool's reply.
    pub fn status_json(&self) -> Value {
        json!({
            "active": self.active,
            "sources": self.sources.names(),
            "since": self.since.map(|t| t.to_rfc3339()),
        })
    }
}

/// Whether a due `after_meeting` item keeps waiting. Pure so the timing rules
/// are testable without a clock or an OS.
pub(crate) fn holds_for_meeting(snap: &MeetingSnapshot, fire_at: DateTime<Utc>, now: DateTime<Utc>) -> bool {
    if (now - fire_at).num_seconds() >= AFTER_MEETING_MAX_WAIT_SECS {
        return false;
    }
    if snap.active {
        return true;
    }
    snap.last_active.is_some_and(|t| (now - t).num_seconds() < AFTER_MEETING_DEBOUNCE_SECS)
}

pub struct MeetingMonitor {
    snapshot: Mutex<MeetingSnapshot>,
    // One shared reader so the Windows source keeps its pid-to-name cache
    // across polls; the Mutex also serializes the poller with on-demand samples.
    source: Mutex<Box<dyn SignalSource>>,
    apps: Vec<String>,
    demand_until: Mutex<Option<Instant>>,
    poller_running: AtomicBool,
}

impl MeetingMonitor {
    pub fn new() -> Self {
        Self::with_source(platform_source())
    }

    pub fn with_source(source: Box<dyn SignalSource>) -> Self {
        Self {
            snapshot: Mutex::new(MeetingSnapshot::default()),
            source: Mutex::new(source),
            apps: default_meeting_apps(),
            demand_until: Mutex::new(None),
            poller_running: AtomicBool::new(false),
        }
    }

    #[cfg(test)]
    pub(crate) fn set_source(&self, source: Box<dyn SignalSource>) {
        *self.source.lock().unwrap() = source;
    }

    pub fn snapshot(&self) -> MeetingSnapshot {
        *self.snapshot.lock().unwrap()
    }

    /// Folds one reading into the snapshot. Split from `sample` so the
    /// transition bookkeeping runs in tests without the OS.
    pub(crate) fn record(&self, sources: Sources, now: DateTime<Utc>) -> MeetingSnapshot {
        let active = compute_in_meeting(sources);
        let mut snap = self.snapshot.lock().unwrap();
        if active {
            if !snap.active {
                snap.since = Some(now);
            }
            snap.last_active = Some(now);
        } else if snap.active {
            snap.since = None;
        }
        snap.active = active;
        snap.sources = sources;
        *snap
    }

    /// One reading of the OS signals, recorded. Blocking (registry, COM, a
    /// process snapshot), so async callers go through `sample_blocking`.
    pub fn sample(&self) -> MeetingSnapshot {
        let sources = {
            let source = self.source.lock().unwrap();
            Sources {
                camera: source.camera_in_use(),
                mic: source.mic_in_use(),
                audio: source.meeting_app_audio_active(&self.apps),
            }
        };
        self.record(sources, Utc::now())
    }

    pub async fn sample_blocking(self: &Arc<Self>) -> MeetingSnapshot {
        let monitor = self.clone();
        tokio::task::spawn_blocking(move || monitor.sample())
            .await
            .unwrap_or_else(|_| self.snapshot())
    }

    /// Keeps the poller running for at least `linger` from now, starting it if
    /// it is not already.
    pub fn demand(self: &Arc<Self>, linger: Duration) {
        {
            let until = Instant::now() + linger;
            let mut demand = self.demand_until.lock().unwrap();
            if demand.map_or(true, |cur| until > cur) {
                *demand = Some(until);
            }
        }
        self.start_poller_if_idle();
    }

    fn demanded(&self) -> bool {
        self.demand_until.lock().unwrap().is_some_and(|t| Instant::now() < t)
    }

    fn start_poller_if_idle(self: &Arc<Self>) {
        if !self.start_claim() {
            return;
        }
        let monitor = self.clone();
        std::thread::spawn(move || monitor.poll_loop());
    }

    fn poll_loop(self: Arc<Self>) {
        loop {
            if !self.demanded() {
                // Collapsed to "no meeting" so a stale `active` cannot outlive
                // the poller that would have cleared it. Every consumer samples
                // fresh before it trusts a snapshot, so this never reads as a
                // real "not in a meeting".
                *self.snapshot.lock().unwrap() = MeetingSnapshot::default();
                self.poller_running.store(false, Ordering::Release);
                // A demand that landed between the check above and the store
                // saw `poller_running` still set and started nothing, so take
                // the loop back over instead of leaving that demand unserved.
                if self.demanded() && self.start_claim() {
                    continue;
                }
                return;
            }
            self.sample();
            std::thread::sleep(POLL_INTERVAL);
        }
    }

    fn start_claim(&self) -> bool {
        self.poller_running.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire).is_ok()
    }
}

impl Default for MeetingMonitor {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Duration as Chrono;

    struct Fixed(Sources);
    impl SignalSource for Fixed {
        fn camera_in_use(&self) -> bool {
            self.0.camera
        }
        fn mic_in_use(&self) -> bool {
            self.0.mic
        }
        fn meeting_app_audio_active(&self, _allow: &[String]) -> bool {
            self.0.audio
        }
    }

    fn t0() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-10-30T10:00:00Z").unwrap().with_timezone(&Utc)
    }

    fn mic() -> Sources {
        Sources { mic: true, ..Default::default() }
    }

    #[test]
    fn since_is_stamped_when_a_meeting_starts_and_cleared_when_it_ends() {
        let m = MeetingMonitor::with_source(Box::new(Fixed(Sources::default())));
        assert_eq!(m.record(Sources::default(), t0()).since, None);

        let started = m.record(mic(), t0() + Chrono::seconds(3));
        assert!(started.active);
        assert_eq!(started.since, Some(t0() + Chrono::seconds(3)));

        // A later active sample is the same meeting: `since` must not move.
        let still = m.record(mic(), t0() + Chrono::seconds(60));
        assert_eq!(still.since, Some(t0() + Chrono::seconds(3)));
        assert_eq!(still.last_active, Some(t0() + Chrono::seconds(60)));

        let ended = m.record(Sources::default(), t0() + Chrono::seconds(90));
        assert!(!ended.active);
        assert_eq!(ended.since, None);
        assert_eq!(ended.last_active, Some(t0() + Chrono::seconds(60)), "the debounce measures from the last active sample");
    }

    #[test]
    fn the_tool_reply_has_active_sources_and_since() {
        let snap = MeetingSnapshot {
            active: true,
            sources: Sources { camera: true, mic: false, audio: true },
            since: Some(t0()),
            last_active: Some(t0()),
        };
        assert_eq!(
            snap.status_json(),
            json!({"active": true, "sources": ["camera", "audio"], "since": "2026-10-30T10:00:00+00:00"})
        );
        assert_eq!(
            MeetingSnapshot::default().status_json(),
            json!({"active": false, "sources": [], "since": null}),
            "no meeting: an empty source list and a null since, never a missing key"
        );
    }

    #[test]
    fn sample_reads_the_source_and_records_it() {
        let m = MeetingMonitor::with_source(Box::new(Fixed(Sources { audio: true, ..Default::default() })));
        let snap = m.sample();
        assert!(snap.active);
        assert_eq!(snap.sources.names(), vec!["audio"]);
        assert_eq!(m.snapshot(), snap);
        assert!(snap.since.is_some());
    }

    // --- holds_for_meeting: the debounce / max-wait decision ---

    fn snap(active: bool, last_active: Option<DateTime<Utc>>) -> MeetingSnapshot {
        MeetingSnapshot { active, last_active, ..Default::default() }
    }

    #[test]
    fn an_item_waits_while_a_meeting_is_active() {
        let fire_at = t0();
        assert!(holds_for_meeting(&snap(true, Some(t0())), fire_at, t0() + Chrono::minutes(30)));
    }

    #[test]
    fn an_item_fires_at_once_when_no_meeting_has_been_seen() {
        assert!(!holds_for_meeting(&snap(false, None), t0(), t0() + Chrono::seconds(1)));
    }

    #[test]
    fn an_item_keeps_waiting_through_the_debounce_then_fires() {
        let ended = t0() + Chrono::minutes(10);
        let s = snap(false, Some(ended));
        let just_before = ended + Chrono::seconds(AFTER_MEETING_DEBOUNCE_SECS - 1);
        let at = ended + Chrono::seconds(AFTER_MEETING_DEBOUNCE_SECS);
        assert!(holds_for_meeting(&s, t0(), just_before), "the gap between back-to-back calls must not release it");
        assert!(!holds_for_meeting(&s, t0(), at), "a full quiet window releases it");
    }

    #[test]
    fn the_max_wait_releases_an_item_even_while_a_meeting_is_still_reported() {
        let s = snap(true, Some(t0()));
        let before = t0() + Chrono::seconds(AFTER_MEETING_MAX_WAIT_SECS - 1);
        let at = t0() + Chrono::seconds(AFTER_MEETING_MAX_WAIT_SECS);
        assert!(holds_for_meeting(&s, t0(), before));
        assert!(!holds_for_meeting(&s, t0(), at), "a stuck detector must not hold an item forever");
    }

    // --- the poller lifecycle ---

    #[test]
    fn a_demand_starts_the_poller_and_it_stops_once_the_demand_lapses() {
        let m = Arc::new(MeetingMonitor::with_source(Box::new(Fixed(mic()))));
        assert!(!m.poller_running.load(Ordering::Acquire), "no consumer, no poller");
        m.demand(Duration::from_millis(100));
        assert!(m.poller_running.load(Ordering::Acquire));
        // Sampled right away, not after the first 3s beat.
        let started = Instant::now();
        while !m.snapshot().active && started.elapsed() < Duration::from_secs(5) {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(m.snapshot().active);
        // The poller notices the lapse on its next beat (up to POLL_INTERVAL).
        let waited = Instant::now();
        while m.poller_running.load(Ordering::Acquire) && waited.elapsed() < POLL_INTERVAL + Duration::from_secs(3) {
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(!m.poller_running.load(Ordering::Acquire), "the poller must exit when nothing wants it");
        assert_eq!(m.snapshot(), MeetingSnapshot::default(), "a stopped poller leaves no stale meeting behind");
    }
}
