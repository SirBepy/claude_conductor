//! Closing a chat's plan before its job ends. The model is told to tick every
//! `write_plan` step as it goes, and often does not: of 1,584 transcripts that
//! called `write_plan` (read 2026-11-11), 574 ended their job (a `done` status
//! or a report) with the last plan still holding `pending` or `active` steps,
//! on Opus and Sonnet alike (Sonnet 5.5 closed only 48 of 382). The dashboard's
//! Plan card then shows a finished job as still running.
//!
//! So the job end itself checks: a `report_turn_status(done)` is refused once,
//! naming the open steps, while the plan the same turn wrote has any. The
//! refusal is the tool's own result, so the model
//! fixes the plan in the same turn. It never loops: a second end goes through.
//! Only the turn that wrote the plan is checked (the registry drops a plan when
//! the next turn opens, for the same reason): a plan left paused on Joe, or
//! abandoned, never refuses a later, unrelated job's end. A
//! `question`/`waiting`/`working` status never ends a job.
//!
//! The same gate also holds the queue-all check ([`PlanCloseGate::check_queue_all`]): a main
//! chat with subs on that ends a turn (any status but `question`) with a plan of open rows,
//! or three hand-started subs, and no run plan, is refused once. On 2026-11-26 the ZNG hub
//! kept its plan in chat text behind a trigger that never fired and sat idle for 1h50m and
//! 84 min while reporting `working`, which `check_end` never looks at. A plan in a run is
//! the only one the daemon can read, so the refusal sends the model to `run_plan`.
//!
//! A sub's `finish_subchat` does not take that refusal: [`PlanCloseGate::close_open`]
//! empties the gate's open steps, and the finish's commit ticks the registry plan done
//! (`subchats::finish::close_open_plan_steps`), because each refusal was a whole extra
//! call at the sub's full context and its only answer was a tick.

use crate::types::PlanStepSnapshot;
use std::collections::HashMap;
use std::sync::Mutex;

/// Steps named in a refusal; the rest are counted.
const NAMED_MAX: usize = 5;

/// Open plan rows in the turn that make a main chat's turn end check for a run plan.
const OPEN_ROWS_MIN: usize = 2;

/// Hand-started subs in one turn that do the same: `run_plan` is for three or more jobs.
const SPAWNS_MIN: usize = 3;

#[derive(Default)]
struct Track {
    /// The latest plan's steps that are still `pending` or `active`: text, status.
    open: Vec<(String, String)>,
    /// The turn that wrote it; a job end in any other turn is not checked.
    turn_gen: u64,
    /// A refusal was already given for it.
    warned: bool,
}

/// What a main chat's turn did toward queueing its work.
#[derive(Default)]
struct QueueTrack {
    turn_gen: u64,
    /// Subs this turn started with a hand-written `spawn_chat` (a run plan's steps do not count).
    spawned: usize,
    /// The queue-all refusal was already given this turn.
    warned: bool,
}

#[derive(Default)]
pub struct PlanCloseGate {
    inner: Mutex<HashMap<String, Track>>,
    queue: Mutex<HashMap<String, QueueTrack>>,
}

impl PlanCloseGate {
    pub fn new() -> Self {
        Self::default()
    }

    /// A main chat started a sub by hand in turn `turn_gen`.
    pub fn note_spawn(&self, session_id: &str, turn_gen: u64) {
        let mut guard = self.queue.lock().unwrap();
        let t = guard.entry(session_id.to_string()).or_default();
        if t.turn_gen != turn_gen {
            *t = QueueTrack { turn_gen, ..Default::default() };
        }
        t.spawned += 1;
    }

    /// The turn-end half of "queue the whole plan at once": for a main chat with subs on, the
    /// refusal to send back (once per turn) when this turn wrote a plan with
    /// [`OPEN_ROWS_MIN`] or more open rows, or started [`SPAWNS_MIN`] subs by hand, and the
    /// chat holds no open run plan. The daemon cannot read a plan held in chat text, so it
    /// sends the model to `run_plan`, where every sub step is registered up front. Not for a
    /// `question` status: the caller never asks.
    pub fn check_queue_all(&self, session_id: &str, turn_gen: u64, run_open: bool) -> Option<String> {
        if run_open {
            return None;
        }
        let open_rows = {
            let guard = self.inner.lock().unwrap();
            guard.get(session_id).filter(|t| t.turn_gen == turn_gen).map_or(0, |t| t.open.len())
        };
        let mut guard = self.queue.lock().unwrap();
        let t = guard.entry(session_id.to_string()).or_default();
        if t.turn_gen != turn_gen {
            *t = QueueTrack { turn_gen, ..Default::default() };
        }
        if t.warned || (open_rows < OPEN_ROWS_MIN && t.spawned < SPAWNS_MIN) {
            return None;
        }
        t.warned = true;
        Some(queue_all_refusal(open_rows, t.spawned))
    }

    /// Every accepted `write_plan` call, with the turn it came in.
    pub fn record(&self, session_id: &str, turn_gen: u64, steps: &[PlanStepSnapshot]) {
        let open = steps
            .iter()
            .filter(|s| s.status == "pending" || s.status == "active")
            .map(|s| (s.text.clone(), s.status.clone()))
            .collect();
        let mut guard = self.inner.lock().unwrap();
        guard.insert(session_id.to_string(), Track { open, turn_gen, warned: false });
    }

    /// The chat ended: drop its plan track so the map holds only live chats.
    pub fn forget(&self, session_id: &str) {
        self.inner.lock().unwrap().remove(session_id);
        self.queue.lock().unwrap().remove(session_id);
    }

    /// A job end that closes the plan itself instead of refusing (a sub's
    /// `finish_subchat`): how many steps of this turn's plan were still open, which are
    /// now none, or `None` when nothing was open or the plan is another turn's. The
    /// gate no longer holds them, so `check_end` cannot refuse for them. Showing them done is
    /// the caller's job, and a sub's finish does it at commit.
    pub fn close_open(&self, session_id: &str, turn_gen: u64) -> Option<usize> {
        let mut guard = self.inner.lock().unwrap();
        let track = guard.get_mut(session_id)?;
        if track.open.is_empty() || track.turn_gen != turn_gen {
            return None;
        }
        Some(std::mem::take(&mut track.open).len())
    }

    /// A `report_turn_status(done)` job end: the refusal to send back, or None to
    /// let it through. `retry` names the tool to call again. A sub's
    /// `finish_subchat` never comes here: it takes `close_open`.
    pub fn check_end(&self, session_id: &str, turn_gen: u64, retry: &str) -> Option<String> {
        let mut guard = self.inner.lock().unwrap();
        let track = guard.get_mut(session_id)?;
        if track.open.is_empty() || track.warned || track.turn_gen != turn_gen {
            return None;
        }
        track.warned = true;
        Some(refusal(&track.open, retry))
    }
}

fn queue_all_refusal(open_rows: usize, spawned: usize) -> String {
    let seen = match (open_rows >= OPEN_ROWS_MIN, spawned >= SPAWNS_MIN) {
        (true, true) => format!("a plan with {open_rows} open rows and {spawned} subs started by hand"),
        (true, false) => format!("a plan with {open_rows} open rows"),
        _ => format!("{spawned} subs started by hand"),
    };
    format!(
        "Not ended yet: this turn left {seen}, and this chat holds no run plan. A plan kept in chat text starts nothing by itself, and a job \"held until the others finish\" is never started: no sub finish wakes you for it. \
         Queue every job that is not running or queued yet now: run_plan create for 3 or more jobs (order is after, never a hold; a job whose brief needs an earlier result is a main step after the sub that makes it), spawn_chat with after for fewer. \
         If every job is already running or queued, or the rows are your own steps or wait on Joe, call report_turn_status again.",
    )
}

fn refusal(open: &[(String, String)], retry: &str) -> String {
    let mut named: Vec<String> = open.iter().take(NAMED_MAX).map(|(t, s)| format!("\"{t}\" ({s})")).collect();
    if open.len() > NAMED_MAX {
        named.push(format!("{} more", open.len() - NAMED_MAX));
    }
    let n = open.len();
    format!(
        "Not ended yet: your plan still has {n} open step{}: {}. The chat's Plan card would show this finished job as still running. \
         Call write_plan once more with each of them marked done, or skipped if it was dropped, then call {retry} again. \
         If the work is really still going, report status working, question or waiting instead.",
        if n == 1 { "" } else { "s" },
        named.join(", "),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn step(text: &str, status: &str) -> PlanStepSnapshot {
        PlanStepSnapshot { text: text.to_string(), status: status.to_string() }
    }

    #[test]
    fn forgetting_a_chat_drops_its_plan_track() {
        let g = PlanCloseGate::new();
        g.record("a", 1, &[step("Read", "pending")]);
        g.record("b", 1, &[step("Read", "pending")]);
        g.forget("a");
        assert_eq!(g.inner.lock().unwrap().len(), 1);
        assert!(g.check_end("a", 1, "x").is_none());
        assert!(g.check_end("b", 1, "x").is_some());
    }

    #[test]
    fn refuses_a_job_end_once_while_steps_are_open_then_lets_the_second_through() {
        let gate = PlanCloseGate::new();
        gate.record("s", 7, &[step("Read", "done"), step("Commit", "active"), step("Push", "pending")]);
        let msg = gate.check_end("s", 7, "report_turn_status").expect("refused");
        assert!(msg.contains("2 open steps"), "{msg}");
        assert!(msg.contains("\"Commit\" (active)") && msg.contains("\"Push\" (pending)"), "{msg}");
        assert!(msg.contains("call report_turn_status again"), "{msg}");
        // It ends again without fixing it: through, never a loop.
        assert_eq!(gate.check_end("s", 7, "report_turn_status"), None);
        assert_eq!(gate.check_end("s", 7, "report_turn_status"), None);
    }

    #[test]
    fn a_later_turn_is_never_refused_for_a_plan_an_earlier_turn_left_open() {
        let gate = PlanCloseGate::new();
        // Written, then paused on Joe: the turn ended with a question.
        gate.record("s", 3, &[step("Read", "active"), step("Ship", "pending")]);
        assert_eq!(gate.check_end("s", 4, "report_turn_status"), None);
        assert_eq!(gate.check_end("s", 9, "finish_subchat"), None);
    }

    #[test]
    fn a_plan_closed_by_write_plan_ends_without_a_refusal() {
        let gate = PlanCloseGate::new();
        gate.record("s", 1, &[step("Read", "active")]);
        gate.record("s", 1, &[step("Read", "done")]);
        assert_eq!(gate.check_end("s", 1, "finish_subchat"), None);
        gate.record("t", 1, &[step("Read", "done"), step("Dropped", "skipped")]);
        assert_eq!(gate.check_end("t", 1, "finish_subchat"), None);
    }

    #[test]
    fn close_open_reports_the_open_steps_once_and_leaves_nothing_to_refuse() {
        let gate = PlanCloseGate::new();
        gate.record("s", 5, &[step("Read", "done"), step("Commit", "active"), step("Push", "pending")]);
        assert_eq!(gate.close_open("s", 4), None, "another turn's plan is not this job end's to close");
        assert_eq!(gate.close_open("s", 5), Some(2));
        assert_eq!(gate.close_open("s", 5), None, "closed once");
        assert_eq!(gate.check_end("s", 5, "finish_subchat"), None, "nothing is left to refuse for");
        assert_eq!(gate.close_open("none", 5), None);
    }

    #[test]
    fn a_chat_with_no_plan_is_never_refused() {
        assert_eq!(PlanCloseGate::new().check_end("none", 1, "report_turn_status"), None);
    }

    #[test]
    fn a_new_plan_after_a_refused_one_is_checked_again() {
        let gate = PlanCloseGate::new();
        gate.record("s", 1, &[step("A", "active")]);
        assert!(gate.check_end("s", 1, "report_turn_status").is_some());
        assert_eq!(gate.check_end("s", 1, "report_turn_status"), None);
        gate.record("s", 2, &[step("B", "pending")]);
        let msg = gate.check_end("s", 2, "finish_subchat").expect("the new plan is open");
        assert!(msg.contains("1 open step:") && msg.contains("call finish_subchat again"), "{msg}");
    }

    #[test]
    fn queue_all_refuses_a_turn_end_once_while_the_plan_has_open_rows_and_no_run() {
        let gate = PlanCloseGate::new();
        gate.record("m", 4, &[step("Reply to Stevan", "active"), step("Tickets 3-9", "pending"), step("Done", "done")]);
        let msg = gate.check_queue_all("m", 4, false).expect("refused");
        assert!(msg.contains("a plan with 2 open rows") && msg.contains("run_plan create"), "{msg}");
        assert_eq!(gate.check_queue_all("m", 4, false), None, "once per turn, never a loop");
        // The next turn writes the same kind of plan: checked again.
        gate.record("m", 5, &[step("A", "pending"), step("B", "pending")]);
        assert!(gate.check_queue_all("m", 5, false).is_some());
    }

    #[test]
    fn queue_all_lets_through_an_open_run_a_single_row_and_another_turns_plan() {
        let gate = PlanCloseGate::new();
        gate.record("m", 4, &[step("A", "pending"), step("B", "pending")]);
        assert_eq!(gate.check_queue_all("m", 4, true), None, "the plan is in a run");
        gate.record("one", 4, &[step("A", "active")]);
        assert_eq!(gate.check_queue_all("one", 4, false), None, "one row is not a plan to queue");
        gate.record("old", 3, &[step("A", "pending"), step("B", "pending")]);
        assert_eq!(gate.check_queue_all("old", 4, false), None, "an earlier turn's plan is never checked");
        assert_eq!(gate.check_queue_all("none", 1, false), None);
    }

    #[test]
    fn queue_all_counts_hand_started_subs_per_turn() {
        let gate = PlanCloseGate::new();
        for _ in 0..2 {
            gate.note_spawn("m", 7);
        }
        assert_eq!(gate.check_queue_all("m", 7, false), None, "two subs are below the run_plan size");
        gate.note_spawn("m", 7);
        let msg = gate.check_queue_all("m", 7, false).expect("refused");
        assert!(msg.contains("3 subs started by hand"), "{msg}");
        assert_eq!(gate.check_queue_all("m", 7, false), None);
        // A new turn starts the count over.
        gate.note_spawn("m", 8);
        assert_eq!(gate.check_queue_all("m", 8, false), None);
        gate.note_spawn("x", 1);
        gate.note_spawn("x", 1);
        gate.note_spawn("x", 1);
        assert_eq!(gate.check_queue_all("x", 1, true), None, "an open run covers them");
        gate.forget("x");
        assert_eq!(gate.check_queue_all("x", 1, false), None, "forgotten chats start clean");
    }

    #[test]
    fn names_at_most_five_steps_and_counts_the_rest() {
        let gate = PlanCloseGate::new();
        let steps: Vec<_> = (1..=8).map(|i| step(&format!("S{i}"), "pending")).collect();
        gate.record("s", 1, &steps);
        let msg = gate.check_end("s", 1, "report_turn_status").unwrap();
        assert!(msg.contains("8 open steps") && msg.contains("\"S5\"") && !msg.contains("\"S6\"") && msg.contains("3 more"), "{msg}");
    }
}
