//! A run plan across a compaction and a respawn (pc-1804 step 4).
//!
//! A compaction keeps the chat and its id, so the run file stays where it is; the
//! summary may blur the plan though, so [`plan_lines`] is what the `/compact` focus
//! and the `SessionStart` hook text both carry (`subchats/compaction/context.rs`).
//! A `respawn` makes a new chat id: [`move_run`] hands the file to the successor
//! (`closing::move_family`), or every wake and the tick would still go to the ended
//! predecessor.

use super::*;
use crate::daemon::subchats::wake;

/// `old`'s run file under the successor's name, and the wake that tells the successor.
/// See [`move_run_in`] for the file; the wake is only for an open run, since a
/// respawned chat starts with `SessionStart` source `startup`, which the compaction
/// hook never answers with the plan, so the plan would otherwise go unmentioned.
pub fn move_run(state: &std::sync::Arc<crate::daemon::state::DaemonState>, old: &str, new: &str) {
    let Some(root) = decisions::data_root() else { return };
    if let Some(run) = move_run_in(&root, old, new) {
        wake::wake_main_chat(state, new, handover_notice(&run));
    }
}

/// Ids and the main chat's own titles only, like every run wake. It names what stands
/// on the plan now (a main step that is ready, a blocked step), because `Run.seen` is
/// kept across the move: the tick then adds no second wake for the same state.
pub(super) fn handover_notice(run: &Run) -> String {
    let done = run.steps.iter().filter(|s| s.status.settled()).count();
    let list = |status: StepStatus, owner: Option<Owner>| -> String {
        run.steps
            .iter()
            .filter(|s| s.status == status && owner.is_none_or(|o| s.owner == o))
            .map(|s| format!("{} \"{}\"", s.id, wake::safe_name(&s.title)))
            .collect::<Vec<_>>()
            .join(", ")
    };
    let (ready, blocked) = (list(StepStatus::Ready, Some(Owner::Main)), list(StepStatus::Blocked, None));
    let mut standing = String::new();
    if !ready.is_empty() {
        standing.push_str(&format!(" Your turn on: {ready}."));
    }
    if !blocked.is_empty() {
        standing.push_str(&format!(" Blocked: {blocked}."));
    }
    format!(
        "Run {} \"{}\" came with you from your predecessor chat: {done} of {} steps done.{standing} The app keeps it running; read it with run_plan status and close your own steps with run_plan done.",
        run.id,
        wake::safe_name(&run.title),
        run.steps.len()
    )
}

/// Moves the file: the run's own `main_id` is rewritten (the tick reads the owner from
/// it). `seen` is kept: an alert the predecessor heard stands on the plan still, and the
/// handover wake names it, so the tick must not wake the successor for it again (and a
/// finished run's `end` mark must not go, or the successor would be woken for a run it
/// never had). Returns the run when an open one was moved now. Re-runnable: a step that
/// stopped between the write and the removal is finished by the next call, and a
/// successor that already holds a different run keeps it (the old file stays, as
/// `decisions` leaves a log it will not overwrite).
pub(crate) fn move_run_in(root: &Path, old: &str, new: &str) -> Option<Run> {
    if old == new {
        return None;
    }
    let _g = FILE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let from = path_in(root, old);
    if !from.exists() {
        return None;
    }
    let mut run = match try_load_in(root, old) {
        Ok(Some(run)) => run,
        Ok(None) => return None,
        Err(e) => {
            log::warn!("subchats: could not move the run plan {old} -> {new}: {e}");
            return None;
        }
    };
    let to = path_in(root, new);
    if to.exists() {
        // The write landed and the removal did not: finish the move.
        if try_load_in(root, new).ok().flatten().is_some_and(|r| r.id == run.id) {
            let _ = std::fs::remove_file(&from);
        } else {
            log::warn!("subchats: not moving the run plan {old} -> {new}: the destination already has a run");
        }
        return None;
    }
    run.main_id = new.to_string();
    let open = run.status == RunStatus::Open;
    match save_in(root, &run) {
        Ok(()) => {
            if let Err(e) = std::fs::remove_file(&from) {
                log::warn!("subchats: moved run {} to {new} but could not remove the old file: {e}", run.id);
            }
            open.then_some(run)
        }
        Err(e) => {
            log::warn!("subchats: could not move run {} to {new}: {e}", run.id);
            None
        }
    }
}

/// The plan as it stands, one line per step, for text the chat reads after it forgot
/// the plan. `None` unless the run is open: a finished or stopped one needs no carrying
/// (the end wake and `run_plan status` cover a finished one). Only the main chat's own
/// words and ids go in: a step's `note` is sub-written and stays behind `run_plan status`.
pub fn plan_lines(run: &Run) -> Option<String> {
    if run.status != RunStatus::Open {
        return None;
    }
    let done = run.steps.iter().filter(|s| s.status.settled()).count();
    let mut out = format!("Run {} \"{}\": {done} of {} steps done.", run.id, wake::safe_name(&run.title), run.steps.len());
    if !run.goal.trim().is_empty() {
        out.push_str(&format!("\nGoal, as stored when the plan was made: {}", run.goal));
    }
    for s in &run.steps {
        let who = match s.owner {
            Owner::Main => "yours".to_string(),
            Owner::Sub => format!("sub \"{}\"", wake::safe_name(&s.sub_name())),
        };
        let wait = if s.after.is_empty() { String::new() } else { format!(", after {}", s.after.join(" ")) };
        let turn = if s.owner == Owner::Main && s.status == StepStatus::Ready { " <- your turn" } else { "" };
        out.push_str(&format!("\n- {} \"{}\" ({who}, {}{wait}){turn}", s.id, wake::safe_name(&s.title), status_word(s.status)));
    }
    Some(out)
}

fn status_word(s: StepStatus) -> &'static str {
    match s {
        StepStatus::Waiting => "waiting",
        StepStatus::Ready => "ready",
        StepStatus::Running => "running",
        StepStatus::Done => "done",
        StepStatus::Blocked => "blocked",
        StepStatus::Skipped => "skipped",
    }
}

/// [`plan_lines`] for `main`'s stored run.
pub fn live_plan(main: &str) -> Option<String> {
    let root = decisions::data_root()?;
    plan_lines(&load_in(&root, main)?)
}
