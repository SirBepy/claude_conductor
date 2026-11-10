//! In-memory per-sub bookkeeping that never needs to outlive the daemon: a
//! finish that was accepted mid-turn and commits at turn end, where a sub is in
//! the Stop hook's block-then-nudge-then-card sequence, and which turn gen last
//! reached its result line. A process-wide table (keyed by sub id, ids are unique) rather
//! than a `DaemonState` field, so the lanes that edit that struct do not
//! collide here.
//!
//! Nothing here is persisted on purpose: a restart ends every turn, so a
//! pending finish or a half-run nudge sequence has nothing left to apply to.
//! The one exception, that a death card was already announced, lives in
//! [`super::announced`].

use super::finish::FinishRecord;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

/// Where a sub is in the sequence the Stop hook runs when it ends a turn
/// without finishing and with nothing pending (spec section 9).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum SubStage {
    /// Nothing has been done about it yet.
    #[default]
    Fresh,
    /// The Stop hook has used its one block.
    Blocked,
    /// The daemon has nudged once; the next unfinished end goes to Joe.
    Nudged,
}

#[derive(Default)]
struct Entry {
    pending_finish: Option<FinishRecord>,
    stage: SubStage,
    nudge_due: bool,
    /// `turn_gen` of the last turn whose result line the pump saw, for the stuck
    /// check: a gen the registry holds past this is a turn still open. The
    /// busy watchdog clears `busy` after 20 silent minutes, so `busy` alone
    /// cannot say a turn is still open at the 30 minute mark.
    last_ended_gen: Option<u64>,
    /// The activity stamp a stuck card was already raised for, so one silent
    /// stretch raises one card even after Joe answers it.
    stuck_carded_for: Option<chrono::DateTime<chrono::Utc>>,
    /// Whether this stretch of the sub's life has been shown the decisions log
    /// yet. A new sub starts undelivered, and `reset` (a continue, a finish)
    /// starts a new stretch.
    decisions_delivered: bool,
    /// Text for the next due nudge when it is not [`super::NUDGE_TEXT`]: a finish
    /// dropped at commit has to say why, since the sub did call `finish_subchat`.
    nudge_text: Option<&'static str>,
    /// First sweep that found this sub with no live child and no finish. A card
    /// goes up only if it is still childless a grace period later, so a respawn
    /// in progress is not mistaken for a death.
    childless_since: Option<chrono::DateTime<chrono::Utc>>,
    /// A "its process died" card was already raised for this stretch without a
    /// child, so the sweep and the exit handler do not both raise one and Joe's
    /// answer to it is not asked again every tick.
    death_carded: bool,
    /// A `continue_sub` is between its checks and its send. The respawn window
    /// has no live child, so the `Busy` check cannot see a second caller.
    continuing: bool,
}

#[derive(Default)]
pub struct Runtime {
    subs: Mutex<HashMap<String, Entry>>,
}

impl Runtime {
    fn with<R>(&self, sub_id: &str, f: impl FnOnce(&mut Entry) -> R) -> R {
        let mut subs = self.subs.lock().unwrap_or_else(|p| p.into_inner());
        f(subs.entry(sub_id.to_string()).or_default())
    }

    /// An accepted `finish_subchat` waits here until the turn ends.
    pub fn set_pending_finish(&self, sub_id: &str, record: FinishRecord) {
        self.with(sub_id, |e| e.pending_finish = Some(record));
    }

    pub fn finish_pending(&self, sub_id: &str) -> bool {
        self.with(sub_id, |e| e.pending_finish.is_some())
    }

    /// Consumes the request: it commits once, or is dropped, never both.
    pub fn take_pending_finish(&self, sub_id: &str) -> Option<FinishRecord> {
        self.with(sub_id, |e| e.pending_finish.take())
    }

    pub fn stage(&self, sub_id: &str) -> SubStage {
        self.with(sub_id, |e| e.stage)
    }

    pub fn set_stage(&self, sub_id: &str, stage: SubStage) {
        self.with(sub_id, |e| e.stage = stage);
    }

    pub fn set_nudge_due(&self, sub_id: &str) {
        self.with(sub_id, |e| e.nudge_due = true);
    }

    pub fn take_nudge_due(&self, sub_id: &str) -> bool {
        self.with(sub_id, |e| std::mem::take(&mut e.nudge_due))
    }

    pub fn note_turn_end(&self, sub_id: &str, gen: u64) {
        self.with(sub_id, |e| e.last_ended_gen = Some(gen));
    }

    pub fn last_ended_gen(&self, sub_id: &str) -> Option<u64> {
        self.with(sub_id, |e| e.last_ended_gen)
    }

    pub fn mark_stuck_carded(&self, sub_id: &str, last_activity: chrono::DateTime<chrono::Utc>) {
        self.with(sub_id, |e| e.stuck_carded_for = Some(last_activity));
    }

    pub fn stuck_carded_for(&self, sub_id: &str) -> Option<chrono::DateTime<chrono::Utc>> {
        self.with(sub_id, |e| e.stuck_carded_for)
    }

    /// True once per stretch: the sub's first prompt, and the first one after a
    /// continue, are when it is shown the decisions log. Spent even when the
    /// log was empty, so a later prompt in the same stretch does not repeat it.
    pub fn take_decisions_due(&self, sub_id: &str) -> bool {
        self.with(sub_id, |e| !std::mem::replace(&mut e.decisions_delivered, true))
    }

    /// Arms the next due nudge with its own wording (see `Entry::nudge_text`).
    pub fn set_nudge_text(&self, sub_id: &str, text: &'static str) {
        self.with(sub_id, |e| e.nudge_text = Some(text));
    }

    pub fn take_nudge_text(&self, sub_id: &str) -> Option<&'static str> {
        self.with(sub_id, |e| e.nudge_text.take())
    }

    /// Drops a nudge that was armed for a turn end that will never come.
    pub fn disarm_nudge(&self, sub_id: &str) {
        self.with(sub_id, |e| {
            e.nudge_due = false;
            e.nudge_text = None;
        });
    }

    /// Records that the sub has no live child and returns when that was first
    /// seen, so the caller can wait out a grace period.
    pub fn note_childless(&self, sub_id: &str, now: chrono::DateTime<chrono::Utc>) -> chrono::DateTime<chrono::Utc> {
        self.with(sub_id, |e| *e.childless_since.get_or_insert(now))
    }

    /// A live child was seen: the sub is not dead, and a later death is a new one.
    pub fn clear_childless(&self, sub_id: &str) {
        self.with(sub_id, |e| {
            e.childless_since = None;
            e.death_carded = false;
        });
        super::announced::forget(sub_id);
    }

    pub fn death_carded(&self, sub_id: &str) -> bool {
        self.with(sub_id, |e| e.death_carded)
    }

    /// Also recorded in [`super::announced`], the one part of a death that
    /// outlives the daemon, so a restart asks again without ringing again.
    pub fn mark_death_carded(&self, sub_id: &str) {
        self.with(sub_id, |e| e.death_carded = true);
        super::announced::mark(sub_id);
    }

    /// Claims the sub for one `continue_sub`. `None` while another holds it. The
    /// claim lasts until the guard drops, which covers the respawn window.
    pub fn begin_continue(&'static self, sub_id: &str) -> Option<ContinueGuard> {
        let claimed = self.with(sub_id, |e| !std::mem::replace(&mut e.continuing, true));
        claimed.then(|| ContinueGuard { runtime: self, sub_id: sub_id.to_string() })
    }

    /// A sub that goes on with its life (continued, finished for good, ended)
    /// starts its sequence over, and is shown the decisions log again.
    pub fn reset(&self, sub_id: &str) {
        self.with(sub_id, |e| {
            e.stage = SubStage::Fresh;
            e.nudge_due = false;
            e.decisions_delivered = false;
            e.nudge_text = None;
            e.childless_since = None;
            e.death_carded = false;
        });
        super::announced::forget(sub_id);
    }
}

/// Releases the sub's `continue_sub` claim on drop, so an early return or a
/// failed send never leaves it held.
pub struct ContinueGuard {
    runtime: &'static Runtime,
    sub_id: String,
}

impl Drop for ContinueGuard {
    fn drop(&mut self) {
        self.runtime.with(&self.sub_id, |e| e.continuing = false);
    }
}

static RUNTIME: OnceLock<Runtime> = OnceLock::new();

pub fn runtime() -> &'static Runtime {
    RUNTIME.get_or_init(Runtime::default)
}
