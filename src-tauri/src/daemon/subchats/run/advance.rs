//! What a run does by itself when a sub settles (pc-1804 step 2).
//!
//! A lane starts through `held.rs` (its `after` chain), so nothing here starts a
//! sub. This reads every sub step again, saves the new statuses and wakes the main
//! chat, and only for what needs it: a main step that is next, a blocked step, or
//! the end of the run (one wake). A clean finish with more lanes behind it wakes
//! nobody, and the `report_back` wake of a sub that belongs to a run is turned off
//! (`wake::on_finished` asks [`tracks`]), so the run is the only thing that wakes
//! for it.
//!
//! Four things call [`advance`]: a finish (`finished_rest`), an end (the registry's
//! ended hook `on_chat_ended`, and `end_sub` again once a held sub's hold is released),
//! the 60 second tick, and the boot pass. The tick and the boot pass are
//! `held::sweep`, which both already run; the tick is also what notices a merge
//! that landed late, since nothing fires when `merge_followup` resolves.
//!
//! A wake fires once per alert. [`Run::seen`] holds the alerts the main chat knows
//! of, a tool result it read counts as telling it (`Cx::update` marks them), and an
//! alert that cleared is dropped from it so a later one wakes again.

use super::action::real_probe;
use super::*;
use crate::daemon::state::DaemonState;
use crate::daemon::subchats::{family, wake};
use std::sync::Arc;

/// What the main chat should hear about: a main step that is ready, a blocked
/// step, and the end of the run. Built from ids, so the same state gives the same
/// list.
pub(super) fn alerts(run: &Run) -> Vec<String> {
    if run.status == RunStatus::Stopped {
        return Vec::new();
    }
    let mut out: Vec<String> = run
        .steps
        .iter()
        .filter_map(|s| match (s.owner, s.status) {
            (Owner::Main, StepStatus::Ready) => Some(format!("ready:{}", s.id)),
            (_, StepStatus::Blocked) => Some(format!("blocked:{}", s.id)),
            _ => None,
        })
        .collect();
    if run.status == RunStatus::Done {
        out.push("end".to_string());
    }
    out
}

impl Run {
    /// The main chat has read the run as it stands: nothing in it needs a wake.
    pub(super) fn mark_seen(&mut self) {
        self.seen = alerts(self);
    }
}

/// Settles the run of `main` against `probe`, stores it, and returns it with the
/// alerts the main chat has not heard. `None` when there is no run, it was stopped,
/// nothing is new, or the file could not be read or written now (the next pass
/// tries again, and a wake is never sent for a state that was not saved).
pub(super) fn advance_in(root: &Path, main: &str, probe: &dyn Fn(&str) -> SubProbe) -> Option<(Run, Vec<String>)> {
    let pass = pass_in(root, main, probe)?;
    (!pass.fresh.is_empty()).then_some((pass.run, pass.fresh))
}

/// One settle of a stored run: the run as saved, the alerts the main chat has not
/// heard, and whether the file changed (the Run card re-reads it then, wake or none).
pub(super) struct Pass {
    pub run: Run,
    pub fresh: Vec<String>,
    pub saved: bool,
}

pub(super) fn pass_in(root: &Path, main: &str, probe: &dyn Fn(&str) -> SubProbe) -> Option<Pass> {
    let _g = FILE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let mut run = try_load_in(root, main).ok().flatten()?;
    if run.status == RunStatus::Stopped {
        return None;
    }
    let moved = settle(&mut run, probe);
    let now = alerts(&run);
    let fresh: Vec<String> = now.iter().filter(|a| !run.seen.contains(a)).cloned().collect();
    let saved = moved || run.seen != now;
    if saved {
        run.seen = now;
        if let Err(e) = save_in(root, &run) {
            log::warn!("subchats: could not save run {}: {e}", run.id);
            return None;
        }
    }
    Some(Pass { run, fresh, saved })
}

/// The wake text. Ids and the main chat's own titles only: a step's note carries
/// words a sub wrote, and `is_meta` text is read as the app's own, so the main chat
/// reads the reason through `run_plan status`, a tool result.
pub(super) fn notice(run: &Run, fresh: &[String]) -> String {
    let title = |id: &str| run.step(id).map(|s| wake::safe_name(&s.title)).unwrap_or_default();
    let mut parts: Vec<String> = Vec::new();
    for a in fresh {
        match a.split_once(':') {
            Some(("ready", id)) => parts.push(format!("Step {id} \"{}\" is ready: it is your turn.", title(id))),
            Some(("blocked", id)) => parts.push(format!("Step {id} \"{}\" is blocked.", title(id))),
            _ if a == "end" => parts.push("Every step is done or skipped: the run is finished.".to_string()),
            _ => {}
        }
    }
    format!(
        "Run {} \"{}\": {} Read it with run_plan status: close your own step with done, and for a blocked step either skip it or tell Joe.",
        run.id,
        wake::safe_name(&run.title),
        parts.join(" ")
    )
}

/// [`advance_in`] against the real subs, and the wake it asks for.
pub fn advance(state: &Arc<DaemonState>, main: &str) {
    let Some(root) = decisions::data_root() else { return };
    advance_with(state, &root, main, &real_probe(state));
}

/// [`advance`] with the probe injected: announces a changed file to the Run card, then
/// wakes the main chat for what it has not heard.
pub(super) fn advance_with(state: &Arc<DaemonState>, root: &Path, main: &str, probe: &dyn Fn(&str) -> SubProbe) {
    let Some(pass) = pass_in(root, main, probe) else { return };
    if pass.saved {
        announce(state, main, Some(&pass.run));
    }
    if !pass.fresh.is_empty() {
        wake::wake_main_chat(state, main, notice(&pass.run, &pass.fresh));
    }
}

/// The hook for "a sub finished or ended": advances the run it belongs to. Called
/// for every sub, so a chat with no run costs one path check.
pub fn on_sub_settled(state: &Arc<DaemonState>, sub_id: &str) {
    let Some(main) = family::main_of(state, sub_id) else { return };
    let Some(root) = decisions::data_root() else { return };
    if path_in(&root, &main).exists() {
        advance(state, &main);
    }
}

/// Whether `sub_id` is a step of a run of `main` that is not stopped and has not
/// settled yet: its finish is then the run's to act on, not a `report_back` wake.
/// A step that is already done (a lane nudged for another round) is read as an
/// ordinary sub again, since the run is past it.
pub fn tracks(main: &str, sub_id: &str) -> bool {
    let Some(root) = decisions::data_root() else { return false };
    load_in(&root, main).is_some_and(|r| r.status != RunStatus::Stopped && r.steps.iter().any(|s| s.sub_id.as_deref() == Some(sub_id) && !s.status.settled()))
}

/// Set once the registry is restored. The watchdog's first tick fires at once, before
/// that: probing then reads every sub as gone ("it no longer exists"), so each step
/// would be saved blocked and the main chat told so.
static BOOTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Called by `held::on_boot`, after the registry snapshot is back.
pub fn mark_booted() {
    BOOTED.store(true, std::sync::atomic::Ordering::SeqCst);
}

/// [`advance_all`] once the registry is restored; the tick before that does nothing.
pub fn advance_all_after_boot(state: &Arc<DaemonState>) {
    advance_all_if(state, BOOTED.load(std::sync::atomic::Ordering::SeqCst));
}

pub(super) fn advance_all_if(state: &Arc<DaemonState>, booted: bool) {
    if booted {
        advance_all(state);
    }
}

/// Every open run, advanced. The tick and the boot pass: a finish that happened
/// while the daemon was down, a merge that landed late, or an event that never
/// arrived is found here.
pub fn advance_all(state: &Arc<DaemonState>) {
    advance_all_at(state, chrono::Utc::now().timestamp_millis());
}

/// [`advance_all`] at `now_ms`, which the main-step watch reads its clocks against.
pub(super) fn advance_all_at(state: &Arc<DaemonState>, now_ms: i64) {
    let Some(root) = decisions::data_root() else { return };
    let Ok(dir) = std::fs::read_dir(root.join("subchats")) else { return };
    let mut mains: Vec<String> = Vec::new();
    for entry in dir.flatten() {
        let path = entry.path();
        if !path.file_name().is_some_and(|n| n.to_string_lossy().ends_with(".run.json")) {
            continue;
        }
        let Some(run) = std::fs::read_to_string(&path).ok().and_then(|t| serde_json::from_str::<Run>(&t).ok()) else { continue };
        // Only an open run can change by itself, and a done one whose end the main
        // chat has not heard of (a pre-read settled it and its call was refused);
        // a done one it knows of is reopened by `add`, which settles it then.
        let pending = run.status == RunStatus::Open || (run.status == RunStatus::Done && !run.seen.iter().any(|a| a == "end"));
        if pending && !run.main_id.is_empty() && path_in(&root, &run.main_id) == path {
            mains.push(run.main_id);
        }
    }
    for main in mains {
        advance(state, &main);
        // After the advance: a step it just made ready starts its clock now.
        super::watch::watch_at(state, &root, &main, now_ms);
    }
}
