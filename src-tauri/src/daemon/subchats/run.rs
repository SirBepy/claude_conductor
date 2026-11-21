//! Run plans (pc-1804): one job of many subs, held by the daemon so it survives
//! a compaction. The main chat writes the plan once, with every lane's brief;
//! sub steps ride `held.rs` `after` (no second scheduler) and a step that is the
//! main chat's own (review triage, release) is a row that turns `ready` when what
//! it waits for is done.
//!
//! This file is the store, the types and the rules that need no daemon: the
//! graph checks and [`settle`], which reads each step from the state of its sub.
//! `run/action.rs` is the `run_plan` tool (create, status, add, done, skip, stop),
//! which registers sub steps through the same `spawn_chat` path a hand-written
//! `after` chain takes. `run/advance.rs` is what fires when a step settles: it
//! reads the subs again on a finish, an end, the 60 second tick and the boot pass,
//! and wakes the main chat only for a main step that is next, a blocked step, or
//! the end of the run.
//!
//! Store: `<data_dir>/subchats/<main>.run.json`, one run per main chat, next to
//! its decisions log. Every field has `#[serde(default)]`, and an unreadable file
//! is kept as `.bad` beside it and never read as empty (the rule of `held.json`),
//! so a writer stops on a file it cannot read instead of replacing it.

mod action;
mod advance;
#[cfg(test)]
mod advance_tests;
#[cfg(test)]
mod tests;

pub use action::run;
pub use advance::{advance_all, advance_all_after_boot, mark_booted, on_sub_settled, tracks};

use super::{decisions, jsonfile};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Steps one run holds. A run is one job, not a chat's memory: past this the plan
/// is no longer something the main chat can hold in its head or Joe can read.
pub const MAX_STEPS: usize = 40;
const TITLE_CAP: usize = 80;
const GOAL_CAP: usize = 600;
const ID_CAP: usize = 20;
const NOTE_CAP: usize = 160;

/// Serializes every read-modify-write of every run file. Held for short, sync
/// sections only: `action` re-reads the run under it after an await, so a settle
/// that ran meanwhile is never overwritten.
static FILE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RunStatus {
    #[default]
    Open,
    /// Every step done or skipped.
    Done,
    /// The main chat gave the run up.
    Stopped,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Owner {
    /// A hidden sub does it; the daemon starts it when its chain is done.
    #[default]
    Sub,
    /// The main chat's own part (triage, release, a question for Joe).
    Main,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum StepStatus {
    /// Something it waits for is not done.
    #[default]
    Waiting,
    /// A main step whose steps are done: it is the main chat's turn.
    Ready,
    Running,
    Done,
    /// Its sub ended blocked or was ended.
    Blocked,
    Skipped,
}

impl StepStatus {
    /// Nothing more happens to the step.
    pub fn settled(self) -> bool {
        matches!(self, StepStatus::Done | StepStatus::Skipped)
    }
}

/// What a sub step's `spawn_chat` carries, written at plan time. A run takes
/// no `machine`, `continue_from`, `plain` or `after` of its own: where a lane runs
/// is the main chat's project, and what it waits for is the step's `after`.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct SpawnSpec {
    /// The sub's name; the step's title when left out.
    #[serde(default)]
    pub name: Option<String>,
    /// The project folder; the main chat's own when left out.
    #[serde(default)]
    pub cwd: Option<String>,
    /// A gate's whole first message, or extra context under a normal brief.
    #[serde(default)]
    pub prompt: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
    #[serde(default)]
    pub task: Option<String>,
    #[serde(default)]
    pub goal: Option<String>,
    #[serde(default)]
    pub done_when: Option<String>,
    #[serde(default)]
    pub writes: Option<bool>,
    #[serde(default)]
    pub files: Option<Vec<String>>,
    #[serde(default)]
    pub decisions: Option<String>,
    #[serde(default)]
    pub report_back: Option<bool>,
    #[serde(default)]
    pub worktree: Option<bool>,
    #[serde(default)]
    pub review: Option<bool>,
    /// A push gate (needs only `prompt`).
    #[serde(default)]
    pub gate: Option<bool>,
    #[serde(default)]
    pub question: Option<String>,
}

impl SpawnSpec {
    /// The brief fields `spawn_chat` reads, with `after` the sub ids this step waits for.
    pub fn to_args(&self, after: &[String]) -> super::brief::SubchatArgs {
        super::brief::SubchatArgs {
            task: self.task.clone(),
            goal: self.goal.clone(),
            done_when: self.done_when.clone(),
            writes: self.writes,
            files: self.files.clone(),
            decisions: self.decisions.clone(),
            report_back: self.report_back,
            worktree: self.worktree,
            after: (!after.is_empty()).then(|| after.join("\n")),
            review: self.review,
            gate: self.gate,
            question: self.question.clone(),
            ..Default::default()
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct Step {
    /// `s1`, `s2`, ...: how `after` and every later call name the step.
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub owner: Owner,
    /// The steps that must be done (or skipped) first.
    #[serde(default)]
    pub after: Vec<String>,
    /// The todo ids the step closes, for the Run card and the end report.
    #[serde(default)]
    pub todo_ids: Vec<String>,
    /// A sub step's launch recipe. Kept so a later step can show or redo it.
    #[serde(default)]
    pub spawn: Option<SpawnSpec>,
    /// The sub the step runs as, once it is registered.
    #[serde(default)]
    pub sub_id: Option<String>,
    #[serde(default)]
    pub status: StepStatus,
    /// Why the step is blocked, in the sub's or the daemon's words.
    #[serde(default)]
    pub note: String,
}

impl Step {
    /// The sub's name: what `spawn_chat` calls it and what a card says.
    pub fn sub_name(&self) -> String {
        self.spawn.as_ref().and_then(|s| s.name.clone()).filter(|n| !n.trim().is_empty()).unwrap_or_else(|| self.title.clone())
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct Run {
    /// `run-` and six characters; never reused.
    #[serde(default)]
    pub id: String,
    /// The main chat that owns the run.
    #[serde(default)]
    pub main_id: String,
    #[serde(default)]
    pub title: String,
    /// Joe's own words for the job, so a compaction cannot reword them.
    #[serde(default)]
    pub goal: String,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub status: RunStatus,
    /// Dependency order: a step comes after every step it waits for.
    #[serde(default)]
    pub steps: Vec<Step>,
    /// The alerts (`advance::alerts`) the main chat already knows of, from a wake
    /// that was queued or from a tool result it read. A wake fires only for one not
    /// listed here, and an alert that cleared is dropped, so it can fire again.
    #[serde(default)]
    pub seen: Vec<String>,
}

impl Run {
    pub fn step(&self, id: &str) -> Option<&Step> {
        self.steps.iter().find(|s| s.id == id)
    }
}

pub(crate) fn path_in(root: &Path, main: &str) -> PathBuf {
    root.join("subchats").join(format!("{}.run.json", decisions::file_stem(main)))
}

/// The stored run. `Ok(None)` is no file, or one that did not parse (kept as
/// `.bad` first, see `jsonfile::read_json_guarded`); `Err` is a file that exists
/// but cannot be read now, which a writer must stop on.
pub(crate) fn try_load_in(root: &Path, main: &str) -> Result<Option<Run>, String> {
    let path = path_in(root, main);
    match jsonfile::read_json_guarded(&path) {
        Ok(Some((raw, value))) => match serde_json::from_value::<Run>(value) {
            Ok(run) => Ok(Some(run)),
            Err(e) => {
                jsonfile::keep_bad_copy(&path, &raw, &e.to_string());
                Ok(None)
            }
        },
        Ok(None) => Ok(None),
        Err(e) => Err(format!("could not read the run plan, nothing was changed: {e}")),
    }
}

/// For a read-only caller, where a failed read shows no run.
pub fn load_in(root: &Path, main: &str) -> Option<Run> {
    let _g = FILE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    try_load_in(root, main).ok().flatten()
}

pub(crate) fn save_in(root: &Path, run: &Run) -> std::io::Result<()> {
    jsonfile::write_json(&path_in(root, &run.main_id), run)
}

/// A sub step's sub, as far as the daemon can tell. [`settle`] reads it through a
/// closure so the rules are tested without a registry.
#[derive(Clone, Debug, PartialEq)]
pub enum SubProbe {
    /// Held: waiting for what it was told to wait for, or for the writer slot.
    Waiting,
    Running,
    /// Finished and nothing said it was blocked.
    Done,
    /// Ended blocked, or was ended; the string says how.
    Blocked(String),
}

/// Brings every step up to date and returns whether anything changed. A sub step
/// follows its sub (`Done` is final); a main step is `ready` when everything it
/// waits for is done or skipped. The run is `done` when every step is, and open
/// again when a step was added to a finished run. A stopped run is never touched.
pub fn settle(run: &mut Run, probe: &dyn Fn(&str) -> SubProbe) -> bool {
    if run.status == RunStatus::Stopped {
        return false;
    }
    let before = run.clone();
    for step in run.steps.iter_mut().filter(|s| s.owner == Owner::Sub && !s.status.settled()) {
        let Some(sub) = step.sub_id.clone() else { continue };
        match probe(&sub) {
            SubProbe::Waiting => (step.status, step.note) = (StepStatus::Waiting, String::new()),
            SubProbe::Running => (step.status, step.note) = (StepStatus::Running, String::new()),
            SubProbe::Done => (step.status, step.note) = (StepStatus::Done, String::new()),
            SubProbe::Blocked(why) => (step.status, step.note) = (StepStatus::Blocked, clip(&why, NOTE_CAP)),
        }
    }
    // Steps are stored in dependency order, so one pass sees a main step's main
    // steps already settled; a step added out of order still converges.
    for _ in 0..run.steps.len().max(1) {
        let done: HashSet<String> = run.steps.iter().filter(|s| s.status.settled()).map(|s| s.id.clone()).collect();
        let mut moved = false;
        for step in run.steps.iter_mut().filter(|s| s.owner == Owner::Main && !s.status.settled()) {
            let want = if step.after.iter().all(|a| done.contains(a)) { StepStatus::Ready } else { StepStatus::Waiting };
            if step.status != want {
                step.status = want;
                moved = true;
            }
        }
        if !moved {
            break;
        }
    }
    let all_settled = !run.steps.is_empty() && run.steps.iter().all(|s| s.status.settled());
    run.status = if all_settled { RunStatus::Done } else { RunStatus::Open };
    *run != before
}

/// The ids of `new` in an order that never puts a step before one it waits for.
/// `old` are the steps already in the run. Ids must be new and plain, every `after`
/// must name a step of `old` or `new`, a step cannot wait for itself, and a sub
/// step cannot wait for a main step (the daemon starts a held sub when a SUB
/// finishes; start such a lane with `add` once the main step is done).
pub fn order(old: &[Step], new: &[Step]) -> Result<Vec<usize>, String> {
    let mut known: HashMap<&str, Owner> = old.iter().map(|s| (s.id.as_str(), s.owner)).collect();
    for s in new {
        if s.id.is_empty() || s.id.chars().count() > ID_CAP || !s.id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '-' | '_')) {
            return Err(format!("step id {:?} is not usable: use up to {ID_CAP} lowercase letters, digits, - or _ (s1, s2, ... when you leave it out)", s.id));
        }
        if known.insert(s.id.as_str(), s.owner).is_some() {
            return Err(format!("step id {} is used twice: every step needs its own id", s.id));
        }
    }
    for s in new {
        for dep in &s.after {
            if dep == &s.id {
                return Err(format!("step {} waits for itself", s.id));
            }
            match known.get(dep.as_str()) {
                None => return Err(format!("step {} waits for {dep}, which is not a step of this run (ids: {})", s.id, known.keys().copied().collect::<std::collections::BTreeSet<_>>().into_iter().collect::<Vec<_>>().join(", "))),
                Some(Owner::Main) if s.owner == Owner::Sub => {
                    return Err(format!("sub step {} waits for {dep}, which is a main step: the daemon only starts a lane when a sub finishes. Add this lane with run_plan add once {dep} is done, or make it wait for the sub step before {dep}", s.id));
                }
                Some(_) => {}
            }
        }
    }
    // Kahn's algorithm over `new`; a dependency on an old step is already met.
    let in_new: HashSet<&str> = new.iter().map(|s| s.id.as_str()).collect();
    let mut placed: HashSet<&str> = HashSet::new();
    let mut out: Vec<usize> = Vec::with_capacity(new.len());
    while out.len() < new.len() {
        let before = out.len();
        for (i, s) in new.iter().enumerate() {
            if placed.contains(s.id.as_str()) {
                continue;
            }
            if s.after.iter().all(|d| !in_new.contains(d.as_str()) || placed.contains(d.as_str())) {
                placed.insert(s.id.as_str());
                out.push(i);
            }
        }
        if out.len() == before {
            let stuck: Vec<&str> = new.iter().filter(|s| !placed.contains(s.id.as_str())).map(|s| s.id.as_str()).collect();
            return Err(format!("these steps wait for each other in a circle: {}. Break the loop: a step can only wait for steps that finish before it", stuck.join(", ")));
        }
    }
    Ok(out)
}

pub(crate) fn clip(text: &str, cap: usize) -> String {
    let one = decisions::one_line(text);
    if one.chars().count() <= cap {
        return one;
    }
    let cut: String = one.chars().take(cap).collect();
    format!("{cut}...")
}

pub(crate) fn clip_title(text: &str) -> String {
    clip(text, TITLE_CAP)
}

pub(crate) fn clip_goal(text: &str) -> String {
    clip(text, GOAL_CAP)
}
