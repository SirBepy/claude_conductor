//! The `run_plan` tool: `create`, `status`, `add`, `done`, `skip`, `stop`. Every
//! refusal is an `ok:false` naming the fix, because the model reads the result
//! and retries.
//!
//! A sub step is registered through `spawn_chat_or_forward`, the entry a
//! hand-written `spawn_chat` takes, with `after` set to the subs of the steps it
//! waits for, in dependency order. So the brief rules, the tier rules, the cap, the
//! worktree and the hold are the ones a chain of `spawn_chat` calls already has,
//! and `held.rs` starts the lane when its chain is done. No second scheduler.
//!
//! All of a plan's steps are checked BEFORE the first sub is registered (graph,
//! briefs, tiers, names), so the common refusal leaves nothing behind. A spawn that
//! still fails midway (the cap, a worktree) keeps the steps registered so far and
//! drops the rest from the plan, and the result says which.

use super::*;
use crate::daemon::state::DaemonState;
use crate::daemon::subchats::{brief, held, spawn};
use serde::Deserialize;
use serde_json::{json, Value};
use std::future::Future;
use std::sync::Arc;

/// One plan action at a time, across its awaits. The file lock is held only for
/// short sync sections, so a settle from elsewhere never waits on a spawn.
static ACTION_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

pub const NOT_MAIN: &str = "run_plan is for a main chat. A sub does one job: finish it, and say in finish_subchat if more lanes are needed.";
pub const MODE_OFF: &str = "run_plan needs Use subchats on for this chat, since its steps are subs. Turn the mode on, or run the steps yourself.";
pub const NO_RUN: &str = "this chat has no run plan yet: call run_plan with action create, a title, Joe's goal and the steps.";

/// The keys of `SpawnSpec`, the only ones a step's `spawn` may carry.
pub(super) const SPAWN_KEYS: [&str; 16] = [
    "name", "cwd", "prompt", "model", "effort", "task", "goal", "done_when", "writes", "files", "decisions", "report_back", "worktree", "review", "gate", "question",
];

/// The keys of `StepIn`, the only ones a step may carry.
const STEP_KEYS: [&str; 6] = ["id", "title", "owner", "after", "todo_ids", "spawn"];

/// What one sub step's `spawn_chat` is called with.
pub struct SpawnCall {
    pub cwd: String,
    pub prompt: String,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub name: String,
    pub args: brief::SubchatArgs,
}

/// The tool, with the real spawn and the real read of each sub.
pub async fn run(state: &Arc<DaemonState>, caller: &str, args: &Value) -> Value {
    let (st, who) = (state.clone(), caller.to_string());
    let spawn = move |call: SpawnCall| {
        let (st, who) = (st.clone(), who.clone());
        async move {
            crate::daemon::methods::spawn_chat::spawn_chat_or_forward(
                &st,
                &who,
                &call.cwd,
                &call.prompt,
                call.model.as_deref(),
                call.effort.as_deref(),
                Some(&call.name),
                false,
                None,
                &call.args,
            )
            .await
        }
    };
    run_with(state, caller, args, spawn, &real_probe(state)).await
}

/// A sub's state from the registry and the hold file: the same reads `held.rs`
/// makes of a target.
pub(crate) fn real_probe(state: &Arc<DaemonState>) -> impl Fn(&str) -> SubProbe + '_ {
    move |sub| {
        if held::is_held(sub) {
            return SubProbe::Waiting;
        }
        match held::after_state(state, sub) {
            held::AfterState::Clean => SubProbe::Done,
            held::AfterState::Pending => SubProbe::Running,
            held::AfterState::Blocked(why) => SubProbe::Blocked(why),
        }
    }
}

fn refusal(text: impl Into<String>) -> Value {
    json!({"ok": false, "error": text.into()})
}

/// [`run`] with the spawn and the probe injected, so a test starts no `claude`.
pub async fn run_with<F, Fut>(state: &Arc<DaemonState>, caller: &str, args: &Value, spawn: F, probe: &(dyn Fn(&str) -> SubProbe + Sync)) -> Value
where
    F: Fn(SpawnCall) -> Fut,
    Fut: Future<Output = Value>,
{
    let Some(me) = state.registry.get(caller) else { return refusal(format!("unknown session: {caller}")) };
    if crate::daemon::subchats::is_sub(&me) {
        return refusal(NOT_MAIN);
    }
    if !crate::sessions::chat_config::get(caller).is_some_and(|c| c.subchats_on) {
        return refusal(MODE_OFF);
    }
    let Some(root) = decisions::data_root() else { return refusal("the app data folder is not available") };
    let _action = ACTION_LOCK.lock().await;
    let cx = Cx { state, caller, root: &root, cwd: me.cwd.to_string_lossy().to_string(), probe };
    let action = args["action"].as_str().map(str::trim).unwrap_or("");
    match action {
        "create" => cx.create(args, &spawn).await,
        "add" => cx.add(args, &spawn).await,
        "status" => cx.status(),
        "done" => cx.done(args),
        "skip" => cx.skip(args),
        // `cancel` is what the tool's first description called it.
        "stop" | "cancel" => cx.stop(args),
        "" => refusal("action is missing: one of create, status, add, done, skip, stop"),
        other => refusal(format!("action {other:?} is not one of create, status, add, done, skip, stop")),
    }
}

struct Cx<'a> {
    state: &'a Arc<DaemonState>,
    caller: &'a str,
    root: &'a Path,
    /// The main chat's own folder, where a lane runs unless its spawn names one.
    cwd: String,
    probe: &'a (dyn Fn(&str) -> SubProbe + Sync),
}

/// A step as the main chat writes it.
#[derive(Deserialize, Default)]
struct StepIn {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    owner: Option<String>,
    #[serde(default)]
    after: Option<Vec<String>>,
    #[serde(default)]
    todo_ids: Option<Vec<String>>,
    #[serde(default)]
    spawn: Option<SpawnSpec>,
}

fn text(v: &Value) -> String {
    v.as_str().map(str::trim).unwrap_or_default().to_string()
}

fn clean_list(v: Option<Vec<String>>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for s in v.unwrap_or_default() {
        let s = s.trim().to_string();
        if !s.is_empty() && !out.contains(&s) {
            out.push(s);
        }
    }
    out
}

/// The steps a call carries, with ids, titles, owners and names settled. `have` is
/// how many steps the run already holds, so a default id continues the numbering.
fn parse_steps(args: &Value, have: usize) -> Result<Vec<Step>, String> {
    // A key the lane brief does not carry (`after`, `machine`, `plain`,
    // `continue_from`) would be dropped by serde and the lane would start at once
    // on this machine, so it is refused by name.
    if let Some(steps) = args.get("steps").and_then(Value::as_array) {
        for (i, st) in steps.iter().enumerate() {
            // A brief written at step level, or `depends_on` for `after`, would be
            // dropped and the step would run as something else.
            if let Some(bad) = st.as_object().and_then(|o| o.keys().find(|k| !STEP_KEYS.contains(&k.as_str()))) {
                return Err(format!("step {}: a step has no field {bad:?}. A step takes {}; a lane's brief goes inside spawn and what it waits for in after.", i + 1, STEP_KEYS.join(", ")));
            }
            let Some(sp) = st.get("spawn").and_then(Value::as_object) else { continue };
            if let Some(bad) = sp.keys().find(|k| !SPAWN_KEYS.contains(&k.as_str())) {
                return Err(format!("step {}: spawn has no field {bad:?}. A lane's brief takes {}. Order lanes with the step's own `after`, not one inside spawn.", i + 1, SPAWN_KEYS.join(", ")));
            }
        }
    }
    let ins: Vec<StepIn> = match args.get("steps") {
        Some(v) if !v.is_null() => serde_json::from_value(v.clone()).map_err(|e| format!("steps could not be read ({e}): it is a list of {{id, title, owner, after, todo_ids, spawn}}"))?,
        _ => Vec::new(),
    };
    if ins.is_empty() {
        return Err("steps is empty: give at least one step".to_string());
    }
    if have + ins.len() > MAX_STEPS {
        return Err(format!("a run holds at most {MAX_STEPS} steps ({have} already, {} more asked): split the job into two runs, one after the other", ins.len()));
    }
    let mut out = Vec::with_capacity(ins.len());
    for (i, s) in ins.into_iter().enumerate() {
        let id = s.id.as_deref().map(str::trim).filter(|v| !v.is_empty()).map(str::to_string).unwrap_or_else(|| format!("s{}", have + i + 1));
        let title = clip_title(s.title.as_deref().unwrap_or_default());
        if title.is_empty() {
            return Err(format!("step {id} has no title: say in a few words what it is"));
        }
        let owner = match s.owner.as_deref().map(str::trim).filter(|o| !o.is_empty()) {
            Some("sub") => Owner::Sub,
            Some("main") => Owner::Main,
            Some(other) => return Err(format!("step {id}: owner {other:?} is not sub or main")),
            None if s.spawn.is_some() => Owner::Sub,
            None => Owner::Main,
        };
        let spawn = match (owner, s.spawn) {
            (Owner::Sub, None) => return Err(format!("step {id} is a sub step but has no spawn: give its brief (name, task, goal, done_when, writes, files), or owner main if it is your own part")),
            (Owner::Main, Some(_)) => return Err(format!("step {id} is a main step, so it takes no spawn: it is your own part, and run_plan wakes you when it is ready")),
            (Owner::Sub, Some(mut sp)) => {
                let name = sp.name.as_deref().map(str::trim).filter(|n| !n.is_empty()).map(str::to_string).unwrap_or_else(|| title.clone());
                sp.name = Some(name);
                Some(sp)
            }
            (Owner::Main, None) => None,
        };
        out.push(Step {
            id,
            title,
            owner,
            after: clean_list(s.after),
            todo_ids: clean_list(s.todo_ids),
            spawn,
            sub_id: None,
            status: StepStatus::Waiting,
            note: String::new(),
        });
    }
    Ok(out)
}

impl Cx<'_> {
    /// Runs `f` on the freshly read run under the file lock, then settles and saves
    /// it. The run read before an await is never written back. The run is settled
    /// before `f` too: nothing settles it in the background, so the stored statuses
    /// can be older than the subs, and `stop`, `skip` and `create` decide on them.
    fn update<T>(&self, f: impl FnOnce(&mut Run) -> Result<T, String>) -> Result<(T, Run), String> {
        let _g = FILE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let Some(mut run) = try_load_in(self.root, self.caller)? else { return Err(NO_RUN.to_string()) };
        settle(&mut run, self.probe);
        let out = f(&mut run)?;
        settle(&mut run, self.probe);
        save_in(self.root, &run).map_err(|e| format!("could not save the run plan: {e}"))?;
        Ok((out, run))
    }

    fn status(&self) -> Value {
        match self.update(|_| Ok(())) {
            Ok(((), run)) => json!({"ok": true, "run": view(&run)}),
            Err(e) => refusal(e),
        }
    }

    /// A sub step's brief, tier and name checked now, so a refusal leaves no sub behind.
    fn check_sub_steps(&self, old: &[Step], new: &[Step]) -> Result<(), String> {
        let mut taken: Vec<String> = spawn::live_sub_names(self.state, self.caller);
        for s in old.iter().filter(|s| s.owner == Owner::Sub && s.sub_id.is_none()) {
            taken.push(s.sub_name().trim().to_lowercase());
        }
        for s in new.iter().filter(|s| s.owner == Owner::Sub) {
            let spec = s.spawn.as_ref().ok_or_else(|| format!("step {} has no spawn", s.id))?;
            let name = s.sub_name();
            let key = name.trim().to_lowercase();
            if taken.contains(&key) {
                return Err(format!("step {}: a sub named {name:?} already exists in this chat or this plan. A name is how you address a sub, so give this step another one (spawn.name).", s.id));
            }
            taken.push(key);
            let writes = if spec.gate == Some(true) {
                brief::gate_brief(spec.prompt.as_deref(), self.caller).map_err(|e| format!("step {}: {e}", s.id))?;
                true
            } else {
                let b = brief::validate(Some(&name), &spec.to_args(&[]), self.caller).map_err(|e| format!("step {}: {e}", s.id))?;
                b.writes
            };
            let effort = spec.effort.as_deref().or(if spec.gate == Some(true) { Some("high") } else { None });
            spawn::resolve_tier(spec.model.as_deref(), effort, writes).map_err(|e| format!("step {}: {e}", s.id))?;
        }
        Ok(())
    }

    /// Registers the sub steps of `new` (already in dependency order) one by one.
    /// Returns the steps that made it into the plan and, when a spawn failed, why
    /// and which ids were left out. `old` are the steps the run already holds, whose
    /// subs a new step may wait for.
    async fn register<F, Fut>(&self, old: &[Step], new: Vec<Step>, spawn: &F) -> (Vec<Step>, Option<(String, Vec<String>)>)
    where
        F: Fn(SpawnCall) -> Fut,
        Fut: Future<Output = Value>,
    {
        let mut subs: std::collections::HashMap<String, Option<String>> = old.iter().map(|s| (s.id.clone(), s.sub_id.clone())).collect();
        let mut kept: Vec<Step> = Vec::new();
        let mut rest = new.into_iter();
        while let Some(mut step) = rest.next() {
            if step.owner == Owner::Sub {
                let after: Vec<String> = step.after.iter().filter_map(|d| subs.get(d).cloned().flatten()).collect();
                let spec = step.spawn.clone().unwrap_or_default();
                let gate = spec.gate == Some(true);
                let call = SpawnCall {
                    cwd: spec.cwd.clone().filter(|c| !c.trim().is_empty()).unwrap_or_else(|| self.cwd.clone()),
                    prompt: spec.prompt.clone().unwrap_or_default(),
                    model: spec.model.clone(),
                    effort: spec.effort.clone().or_else(|| gate.then(|| "high".to_string())),
                    name: step.sub_name(),
                    args: spec.to_args(&after),
                };
                let result = spawn(call).await;
                let sid = result["session_id"].as_str().filter(|_| result["ok"] == json!(true)).map(str::to_string);
                match sid {
                    Some(sid) => {
                        step.status = if result["queued"] == json!(true) { StepStatus::Waiting } else { StepStatus::Running };
                        step.sub_id = Some(sid);
                    }
                    None => {
                        let why = result["error"].as_str().unwrap_or("it could not be started").to_string();
                        let mut left = vec![step.id.clone()];
                        left.extend(rest.map(|s| s.id));
                        return (kept, Some((format!("step {} ({}) could not be registered: {why}", step.id, step.sub_name()), left)));
                    }
                }
            }
            subs.insert(step.id.clone(), step.sub_id.clone());
            kept.push(step);
        }
        (kept, None)
    }

    async fn create<F, Fut>(&self, args: &Value, spawn: &F) -> Value
    where
        F: Fn(SpawnCall) -> Fut,
        Fut: Future<Output = Value>,
    {
        let title = clip_title(&text(&args["title"]));
        if title.is_empty() {
            return refusal("title is missing: name the job in a few words");
        }
        let goal = clip_goal(&text(&args["goal"]));
        if goal.is_empty() {
            return refusal("goal is missing: Joe's own words for the job, quoted, so a compaction cannot reword them");
        }
        match self.update(|run| {
            if run.status == RunStatus::Open {
                return Err(format!("run {} ({}) is still open. Add to it with run_plan add, or end it with run_plan stop, then create the new one.", run.id, run.title));
            }
            Ok(())
        }) {
            // No run, or a finished or stopped one, is replaced.
            Ok(_) => {}
            Err(e) if e == NO_RUN => {}
            Err(e) => return refusal(e),
        }
        let steps = match parse_steps(args, 0) {
            Ok(s) => s,
            Err(e) => return refusal(e),
        };
        let order = match order(&[], &steps) {
            Ok(o) => o,
            Err(e) => return refusal(e),
        };
        if let Err(e) = self.check_sub_steps(&[], &steps) {
            return refusal(e);
        }
        let mut slots: Vec<Option<Step>> = steps.into_iter().map(Some).collect();
        let ordered: Vec<Step> = order.into_iter().filter_map(|i| slots[i].take()).collect();
        let (kept, failed) = self.register(&[], ordered, spawn).await;
        if kept.is_empty() {
            return refusal(failed.map(|(why, _)| why).unwrap_or_else(|| "no step could be registered".to_string()));
        }
        let mut run = Run {
            id: format!("run-{}", &uuid::Uuid::new_v4().simple().to_string()[..6]),
            main_id: self.caller.to_string(),
            title,
            goal,
            created_at: chrono::Local::now().to_rfc3339(),
            status: RunStatus::Open,
            steps: kept,
        };
        settle(&mut run, self.probe);
        let saved = {
            let _g = FILE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
            save_in(self.root, &run)
        };
        if let Err(e) = saved {
            return refusal(format!("the lanes were registered but the run plan could not be saved: {e}. Read them with subchat list."));
        }
        outcome(&run, failed, "created")
    }

    async fn add<F, Fut>(&self, args: &Value, spawn: &F) -> Value
    where
        F: Fn(SpawnCall) -> Fut,
        Fut: Future<Output = Value>,
    {
        let run = match self.update(|_| Ok(())) {
            Ok(((), run)) => run,
            Err(e) => return refusal(e),
        };
        if run.status == RunStatus::Stopped {
            return refusal(format!("run {} was stopped: create a new run instead of adding to it", run.id));
        }
        let steps = match parse_steps(args, run.steps.len()) {
            Ok(s) => s,
            Err(e) => return refusal(e),
        };
        let order = match order(&run.steps, &steps) {
            Ok(o) => o,
            Err(e) => return refusal(e),
        };
        if let Err(e) = self.check_sub_steps(&run.steps, &steps) {
            return refusal(e);
        }
        let mut slots: Vec<Option<Step>> = steps.into_iter().map(Some).collect();
        let ordered: Vec<Step> = order.into_iter().filter_map(|i| slots[i].take()).collect();
        let (kept, failed) = self.register(&run.steps, ordered, spawn).await;
        if kept.is_empty() {
            return refusal(failed.map(|(why, _)| why).unwrap_or_else(|| "no step could be registered".to_string()));
        }
        match self.update(|run| {
            if run.status == RunStatus::Stopped {
                return Err(format!("run {} was stopped while its lanes were being registered; the new lanes still run, read them with subchat list", run.id));
            }
            run.steps.extend(kept);
            Ok(())
        }) {
            Ok(((), run)) => outcome(&run, failed, "added"),
            Err(e) => refusal(format!("the new lanes were started but the run plan could not take them: {e}")),
        }
    }

    /// The step a call names, or the refusal.
    fn named(args: &Value, run: &Run) -> Result<String, String> {
        let id = text(&args["step"]);
        if id.is_empty() {
            return Err(format!("step is missing: name the step (ids: {})", ids(run)));
        }
        match run.step(&id) {
            Some(_) => Ok(id),
            None => Err(format!("this run has no step {id} (ids: {})", ids(run))),
        }
    }

    fn done(&self, args: &Value) -> Value {
        let result = self.update(|run| {
            let id = Self::named(args, run)?;
            let step = run.steps.iter_mut().find(|s| s.id == id).expect("named step exists");
            if step.owner == Owner::Sub {
                return Err(format!("step {id} is a sub step: it is done when its sub {:?} finishes, the daemon reads that. Only your own (main) steps are closed with done.", step.sub_name()));
            }
            if step.status != StepStatus::Skipped {
                step.status = StepStatus::Done;
            }
            step.note.clear();
            Ok(())
        });
        match result {
            Ok(((), run)) => json!({"ok": true, "run": view(&run)}),
            Err(e) => refusal(e),
        }
    }

    fn skip(&self, args: &Value) -> Value {
        let note = clip(&text(&args["note"]), NOTE_CAP);
        let result = self.update(|run| {
            let id = Self::named(args, run)?;
            let step = run.steps.iter_mut().find(|s| s.id == id).expect("named step exists");
            if step.status.settled() {
                return Ok(());
            }
            if step.owner == Owner::Sub && step.status != StepStatus::Blocked {
                return Err(format!("step {id} is {:?}: only a blocked sub step can be skipped. A lane that has not started is dropped with subchat drop, and one that is working is Joe's to end.", step.status));
            }
            step.status = StepStatus::Skipped;
            step.note = note.clone();
            Ok(())
        });
        match result {
            Ok(((), run)) => json!({"ok": true, "run": view(&run)}),
            Err(e) => refusal(e),
        }
    }

    /// Gives the run up: lanes that never started are dropped, lanes that are
    /// working are left (a started job is Joe's to end) and named.
    fn stop(&self, _args: &Value) -> Value {
        let mut dropped: Vec<String> = Vec::new();
        let mut working: Vec<String> = Vec::new();
        let result = self.update(|run| {
            // A finished run has nothing left to give up; stopping it would only
            // refuse a later `add`.
            if run.status == RunStatus::Done {
                return Ok(());
            }
            for step in run.steps.iter_mut().filter(|s| !s.status.settled()) {
                if step.owner == Owner::Sub {
                    if let Some(sub) = step.sub_id.clone() {
                        if held::is_held(&sub) {
                            held::drop_held(self.state, &sub);
                            dropped.push(step.sub_name());
                            step.note = "dropped before it started".to_string();
                        } else if matches!((self.probe)(&sub), SubProbe::Running) {
                            working.push(step.sub_name());
                            step.note = "still working; the run no longer waits for it".to_string();
                        }
                    }
                }
                step.status = StepStatus::Skipped;
            }
            run.status = RunStatus::Stopped;
            Ok(())
        });
        match result {
            Ok(((), run)) => json!({"ok": true, "run": view(&run), "dropped": dropped, "still_working": working}),
            Err(e) => refusal(e),
        }
    }
}

fn ids(run: &Run) -> String {
    run.steps.iter().map(|s| s.id.as_str()).collect::<Vec<_>>().join(", ")
}

/// A create or add result. A partial one is `ok:false` and still carries the run,
/// so the main chat sees what is held and what to add again.
fn outcome(run: &Run, failed: Option<(String, Vec<String>)>, what: &str) -> Value {
    match failed {
        None => json!({"ok": true, "result": what, "run": view(run)}),
        Some((why, left)) => json!({
            "ok": false,
            "error": format!("{why}. The steps before it are in the run; steps {} were NOT registered: fix the cause and call run_plan add for them (their `after` may name steps already in the run).", left.join(", ")),
            "run": view(run),
        }),
    }
}

/// The run as the main chat reads it: short, no briefs.
pub fn view(run: &Run) -> Value {
    let steps: Vec<Value> = run
        .steps
        .iter()
        .map(|s| {
            let mut v = json!({"id": s.id, "title": s.title, "owner": s.owner, "status": s.status, "after": s.after});
            if !s.todo_ids.is_empty() {
                v["todo_ids"] = json!(s.todo_ids);
            }
            if s.owner == Owner::Sub {
                v["sub"] = json!(s.sub_name());
            }
            if !s.note.is_empty() {
                v["note"] = json!(s.note);
            }
            v
        })
        .collect();
    let yours: Vec<&str> = run.steps.iter().filter(|s| s.owner == Owner::Main && s.status == StepStatus::Ready).map(|s| s.id.as_str()).collect();
    let done = run.steps.iter().filter(|s| s.status.settled()).count();
    json!({
        "id": run.id,
        "title": run.title,
        "goal": run.goal,
        "status": run.status,
        "created_at": run.created_at,
        "steps": steps,
        "done": done,
        "total": run.steps.len(),
        "yours": yours,
    })
}
