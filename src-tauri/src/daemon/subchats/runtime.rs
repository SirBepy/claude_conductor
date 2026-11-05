//! In-memory per-sub bookkeeping that never needs to outlive the daemon: a
//! finish that was accepted mid-turn and commits at turn end, where a sub is in
//! the Stop hook's block-then-nudge-then-card sequence, and which turn gen last
//! reached its result line. A process-wide table (keyed by sub id, ids are unique) rather
//! than a `DaemonState` field, so the lanes that edit that struct do not
//! collide here.
//!
//! Nothing here is persisted on purpose: a restart ends every turn, so a
//! pending finish or a half-run nudge sequence has nothing left to apply to.

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

    /// A sub that goes on with its life (continued, finished for good, ended)
    /// starts its sequence over, and is shown the decisions log again.
    pub fn reset(&self, sub_id: &str) {
        self.with(sub_id, |e| {
            e.stage = SubStage::Fresh;
            e.nudge_due = false;
            e.decisions_delivered = false;
        });
    }
}

static RUNTIME: OnceLock<Runtime> = OnceLock::new();

pub fn runtime() -> &'static Runtime {
    RUNTIME.get_or_init(Runtime::default)
}
