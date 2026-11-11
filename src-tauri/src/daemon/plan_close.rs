//! Closing a chat's plan before its job ends. The model is told to tick every
//! `write_plan` step as it goes, and often does not: of 1,584 transcripts that
//! called `write_plan` (read 2026-11-11), 574 ended their job (a `done` status
//! or a report) with the last plan still holding `pending` or `active` steps,
//! on Opus and Sonnet alike (Sonnet 5.5 closed only 48 of 382). The dashboard's
//! Plan card then shows a finished job as still running.
//!
//! So the job end itself checks: a `report_turn_status(done)` or a sub's
//! `finish_subchat` is refused once, naming the open steps, while the plan the
//! same turn wrote has any. The refusal is the tool's own result, so the model
//! fixes the plan in the same turn. It never loops: a second end goes through.
//! Only the turn that wrote the plan is checked (the registry drops a plan when
//! the next turn opens, for the same reason): a plan left paused on Joe, or
//! abandoned, never refuses a later, unrelated job's end. A
//! `question`/`waiting`/`working` status never ends a job.

use crate::types::PlanStepSnapshot;
use std::collections::HashMap;
use std::sync::Mutex;

/// Steps named in a refusal; the rest are counted.
const NAMED_MAX: usize = 5;

#[derive(Default)]
struct Track {
    /// The latest plan's steps that are still `pending` or `active`: text, status.
    open: Vec<(String, String)>,
    /// The turn that wrote it; a job end in any other turn is not checked.
    turn_gen: u64,
    /// A refusal was already given for it.
    warned: bool,
}

#[derive(Default)]
pub struct PlanCloseGate {
    inner: Mutex<HashMap<String, Track>>,
}

impl PlanCloseGate {
    pub fn new() -> Self {
        Self::default()
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

    /// A job end (`done`, `finish_subchat`): the refusal to send back, or None to
    /// let it through. `retry` names the tool to call again.
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
    fn names_at_most_five_steps_and_counts_the_rest() {
        let gate = PlanCloseGate::new();
        let steps: Vec<_> = (1..=8).map(|i| step(&format!("S{i}"), "pending")).collect();
        gate.record("s", 1, &steps);
        let msg = gate.check_end("s", 1, "report_turn_status").unwrap();
        assert!(msg.contains("8 open steps") && msg.contains("\"S5\"") && !msg.contains("\"S6\"") && msg.contains("3 more"), "{msg}");
    }
}
