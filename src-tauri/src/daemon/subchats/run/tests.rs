use super::action::{run_with, SpawnCall};
use super::*;
use crate::daemon::session::new_session_map;
use crate::daemon::settings_cache::SettingsCache;
use crate::daemon::state::DaemonState;
use crate::daemon::subchats::held::{self, Held, LaunchSpec};
use crate::daemon::subchats::{store_sub_brief, TempDataDir};
use crate::types::Settings;
use serde_json::{json, Value};
use std::sync::Arc;

const MAIN: &str = "rp-main";

fn state() -> Arc<DaemonState> {
    DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()))
}

/// A mode-on main chat in a scratch data folder.
fn main_chat(st: &DaemonState) {
    st.registry.upsert_interactive(MAIN, &std::env::current_dir().unwrap(), "proj", "2026-11-21T00:00:00Z");
    crate::sessions::chat_config::set_subchats_on(MAIN, true);
}

fn step(id: &str, owner: Owner, after: &[&str]) -> Step {
    Step { id: id.into(), title: id.into(), owner, after: after.iter().map(|s| s.to_string()).collect(), ..Default::default() }
}

fn lane(name: &str, after: &[&str]) -> Value {
    json!({
        "title": name, "after": after,
        "spawn": {"name": name, "task": format!("do {name}"), "goal": "g", "done_when": "d", "writes": false},
    })
}

fn plan_args() -> Value {
    json!({
        "action": "create", "title": "Finish todos", "goal": "\"finish the backlog\"",
        "steps": [
            lane("lane-a", &[]),
            {"id": "s2", "title": "lane-a2", "after": ["s1"], "spawn": {"name": "lane-a2", "task": "t", "goal": "g", "done_when": "d", "writes": false}},
            {"id": "s3", "title": "Release", "owner": "main", "after": ["s2"], "todo_ids": ["pc-1"]},
        ],
    })
}

type Calls = Arc<std::sync::Mutex<Vec<(String, Option<String>, String, Option<String>)>>>;

/// A spawn that records (name, after, cwd, effort) and answers like `spawn_chat`: a sub that
/// waits for another comes back queued. `fail_on` names a sub whose spawn is refused.
fn spawner(calls: &Calls, fail_on: Option<&'static str>) -> impl Fn(SpawnCall) -> std::future::Ready<Value> {
    let calls = calls.clone();
    move |c: SpawnCall| {
        calls.lock().unwrap().push((c.name.clone(), c.args.after.clone(), c.cwd.clone(), c.effort.clone()));
        if fail_on == Some(c.name.as_str()) {
            return std::future::ready(json!({"ok": false, "error": "the start cap is reached"}));
        }
        let mut out = json!({"ok": true, "session_id": format!("sid-{}", c.name)});
        if c.args.after.is_some() {
            out["queued"] = json!(true);
        }
        std::future::ready(out)
    }
}

/// A sub the test has said nothing about is read as the daemon would: waiting when it
/// was registered behind another sub (a held lane), else running.
fn probe_of(map: &Probes, calls: &Calls) -> impl Fn(&str) -> SubProbe + Sync {
    let (map, calls) = (map.clone(), calls.clone());
    move |sub| {
        if let Some(p) = map.lock().unwrap().get(sub) {
            return p.clone();
        }
        let held = calls.lock().unwrap().iter().any(|(name, after, _, _)| format!("sid-{name}") == sub && after.is_some());
        if held { SubProbe::Waiting } else { SubProbe::Running }
    }
}

type Probes = Arc<std::sync::Mutex<std::collections::HashMap<String, SubProbe>>>;

// ---- graph ----

#[test]
fn order_puts_a_step_after_what_it_waits_for_whatever_order_it_was_written_in() {
    let new = vec![step("c", Owner::Main, &["b"]), step("b", Owner::Sub, &["a"]), step("a", Owner::Sub, &[])];
    assert_eq!(order(&[], &new).unwrap(), vec![2, 1, 0]);
}

#[test]
fn order_refuses_a_loop_a_missing_step_a_repeat_and_a_sub_waiting_for_a_main_step() {
    let e = order(&[], &[step("a", Owner::Sub, &["b"]), step("b", Owner::Sub, &["a"])]).unwrap_err();
    assert!(e.contains("circle") && e.contains('a') && e.contains('b'), "{e}");
    let e = order(&[], &[step("a", Owner::Sub, &["ghost"])]).unwrap_err();
    assert!(e.contains("ghost") && e.contains("not a step"), "{e}");
    let e = order(&[], &[step("a", Owner::Sub, &["a"])]).unwrap_err();
    assert!(e.contains("waits for itself"), "{e}");
    let e = order(&[], &[step("a", Owner::Sub, &[]), step("a", Owner::Main, &[])]).unwrap_err();
    assert!(e.contains("used twice"), "{e}");
    let e = order(&[], &[step("Bad Id", Owner::Sub, &[])]).unwrap_err();
    assert!(e.contains("not usable"), "{e}");
    let e = order(&[], &[step("m", Owner::Main, &[]), step("a", Owner::Sub, &["m"])]).unwrap_err();
    assert!(e.contains("main step") && e.contains("run_plan add"), "{e}");
}

#[test]
fn order_lets_a_new_step_wait_for_a_step_the_run_already_holds() {
    let old = vec![step("s1", Owner::Sub, &[])];
    assert_eq!(order(&old, &[step("s2", Owner::Sub, &["s1"])]).unwrap(), vec![0]);
    assert!(order(&old, &[step("s1", Owner::Sub, &[])]).unwrap_err().contains("used twice"));
}

// ---- settle ----

fn run_of(steps: Vec<Step>) -> Run {
    Run { id: "run-1".into(), main_id: MAIN.into(), steps, ..Default::default() }
}

#[test]
fn a_main_step_is_ready_only_when_every_step_it_waits_for_is_done_or_skipped() {
    let mut a = step("s1", Owner::Sub, &[]);
    a.sub_id = Some("A".into());
    let mut b = step("s2", Owner::Sub, &[]);
    b.sub_id = Some("B".into());
    let mut run = run_of(vec![a, b, step("s3", Owner::Main, &["s1", "s2"]), step("s4", Owner::Main, &["s3"])]);
    let a_done = |s: &str| if s == "A" { SubProbe::Done } else { SubProbe::Running };
    assert!(settle(&mut run, &a_done));
    assert_eq!(run.step("s3").unwrap().status, StepStatus::Waiting, "B still runs");
    assert_eq!(run.step("s2").unwrap().status, StepStatus::Running);
    assert!(settle(&mut run, &|_| SubProbe::Done));
    assert_eq!(run.step("s3").unwrap().status, StepStatus::Ready);
    assert_eq!(run.step("s4").unwrap().status, StepStatus::Waiting, "waits for the main step");
    run.steps[2].status = StepStatus::Done;
    settle(&mut run, &|_| SubProbe::Done);
    assert_eq!(run.step("s4").unwrap().status, StepStatus::Ready);
    assert_eq!(run.status, RunStatus::Open);
    run.steps[3].status = StepStatus::Skipped;
    settle(&mut run, &|_| SubProbe::Done);
    assert_eq!(run.status, RunStatus::Done, "every step done or skipped");
}

#[test]
fn a_done_sub_step_stays_done_and_a_blocked_one_keeps_the_reason() {
    let mut a = step("s1", Owner::Sub, &[]);
    a.sub_id = Some("A".into());
    let mut b = step("s2", Owner::Sub, &[]);
    b.sub_id = Some("B".into());
    let mut run = run_of(vec![a, b]);
    settle(&mut run, &|s| if s == "A" { SubProbe::Done } else { SubProbe::Blocked("it finished as \"Blocked on auth\"".into()) });
    // The sub row going back to work (a follow-up) never un-does a finished step.
    settle(&mut run, &|_| SubProbe::Running);
    assert_eq!(run.step("s1").unwrap().status, StepStatus::Done);
    assert_eq!(run.step("s2").unwrap().status, StepStatus::Running, "a blocked lane that went back to work is read again");
    settle(&mut run, &|_| SubProbe::Blocked("it was ended before it finished".into()));
    assert_eq!(run.step("s2").unwrap().status, StepStatus::Blocked);
    assert_eq!(run.step("s2").unwrap().note, "it was ended before it finished");
}

#[test]
fn a_stopped_run_is_never_touched_and_adding_a_step_to_a_done_run_reopens_it() {
    let mut run = run_of(vec![step("s1", Owner::Main, &[])]);
    run.steps[0].status = StepStatus::Done;
    settle(&mut run, &|_| SubProbe::Done);
    assert_eq!(run.status, RunStatus::Done);
    run.steps.push(step("s2", Owner::Main, &["s1"]));
    settle(&mut run, &|_| SubProbe::Done);
    assert_eq!(run.status, RunStatus::Open);
    assert_eq!(run.step("s2").unwrap().status, StepStatus::Ready);
    run.status = RunStatus::Stopped;
    run.steps[1].status = StepStatus::Waiting;
    assert!(!settle(&mut run, &|_| SubProbe::Done));
    assert_eq!(run.steps[1].status, StepStatus::Waiting);
}

// ---- store ----

#[test]
fn an_old_or_partial_run_file_still_loads_and_an_unreadable_one_is_kept_aside() {
    let _d = TempDataDir::new();
    let root = decisions::data_root().unwrap();
    std::fs::create_dir_all(root.join("subchats")).unwrap();
    // A file from a build with fewer fields, and a step with only an id.
    std::fs::write(path_in(&root, MAIN), r#"{"id":"run-old","steps":[{"id":"s1"}]}"#).unwrap();
    let run = load_in(&root, MAIN).expect("a partial file loads");
    assert_eq!((run.id.as_str(), run.steps.len(), run.status), ("run-old", 1, RunStatus::Open));
    assert_eq!(run.steps[0].owner, Owner::Sub);

    std::fs::write(path_in(&root, MAIN), "{ not json").unwrap();
    assert!(load_in(&root, MAIN).is_none());
    let kept = std::fs::read_dir(root.join("subchats")).unwrap().flatten().any(|e| e.file_name().to_string_lossy().contains(".run.json.bad"));
    assert!(kept, "the unreadable text is kept as .bad, never read as empty");
}

// ---- the tool ----

async fn call(st: &Arc<DaemonState>, who: &str, args: Value, calls: &Calls, probes: &Probes) -> Value {
    run_with(st, who, &args, spawner(calls, None), &probe_of(probes, calls)).await
}

fn fixtures() -> (TempDataDir, Arc<DaemonState>, Calls, Probes) {
    let d = TempDataDir::new();
    let st = state();
    main_chat(&st);
    (d, st, Calls::default(), Probes::default())
}

#[tokio::test]
async fn create_registers_each_lane_after_the_sub_it_waits_for_and_stores_the_plan() {
    let (_d, st, calls, probes) = fixtures();
    let out = call(&st, MAIN, plan_args(), &calls, &probes).await;
    assert_eq!(out["ok"], json!(true), "{out}");
    // Dependency order, and the second lane waits for the FIRST lane's sub id.
    let seen = calls.lock().unwrap().clone();
    assert_eq!(seen.len(), 2, "the main step registers nothing: {seen:?}");
    assert_eq!((seen[0].0.as_str(), seen[0].1.as_deref()), ("lane-a", None));
    assert_eq!((seen[1].0.as_str(), seen[1].1.as_deref()), ("lane-a2", Some("sid-lane-a")));
    assert_eq!(seen[0].2, std::env::current_dir().unwrap().to_string_lossy(), "a lane runs in the main chat's folder unless it names one");

    let steps = out["run"]["steps"].as_array().unwrap();
    assert_eq!(steps.len(), 3);
    assert_eq!(steps[0]["status"], json!("running"));
    assert_eq!(steps[1]["status"], json!("waiting"), "queued behind the first lane");
    assert_eq!(steps[2]["status"], json!("waiting"));
    assert_eq!(steps[2]["todo_ids"], json!(["pc-1"]));
    assert!(steps[0].get("spawn").is_none(), "the reading shows no briefs");

    let root = decisions::data_root().unwrap();
    let stored = load_in(&root, MAIN).expect("the plan is on disk");
    assert_eq!(stored.goal, "\"finish the backlog\"");
    assert_eq!(stored.step("s2").unwrap().sub_id.as_deref(), Some("sid-lane-a2"));
    assert_eq!(stored.step("s1").unwrap().spawn.as_ref().unwrap().task.as_deref(), Some("do lane-a"));
}

#[tokio::test]
async fn status_settles_the_steps_from_their_subs_and_names_the_main_steps_that_are_ready() {
    let (_d, st, calls, probes) = fixtures();
    call(&st, MAIN, plan_args(), &calls, &probes).await;
    probes.lock().unwrap().insert("sid-lane-a".into(), SubProbe::Done);
    probes.lock().unwrap().insert("sid-lane-a2".into(), SubProbe::Done);
    let out = call(&st, MAIN, json!({"action": "status"}), &calls, &probes).await;
    assert_eq!(out["run"]["yours"], json!(["s3"]), "{out}");
    assert_eq!(out["run"]["done"], json!(2));
    let closed = call(&st, MAIN, json!({"action": "done", "step": "s3"}), &calls, &probes).await;
    assert_eq!(closed["run"]["status"], json!("done"));
    assert_eq!(closed["run"]["yours"], json!([]));
    // Read again from disk, not from memory.
    let again = call(&st, MAIN, json!({"action": "status"}), &calls, &probes).await;
    assert_eq!(again["run"]["status"], json!("done"));
}

/// The `run_plan_changed` frames waiting on `rx`, as (run id, status).
fn card_frames(rx: &mut tokio::sync::broadcast::Receiver<Value>) -> Vec<(Value, Value)> {
    let mut out = Vec::new();
    while let Ok(frame) = rx.try_recv() {
        if frame["method"] == "run_plan_changed" && frame["params"]["session_id"] == MAIN {
            out.push((frame["params"]["run_id"].clone(), frame["params"]["status"].clone()));
        }
    }
    out
}

#[tokio::test]
async fn creating_a_plan_and_closing_a_step_each_announce_the_run_to_the_card() {
    let (_d, st, calls, probes) = fixtures();
    let mut rx = st.notifier.subscribe();
    call(&st, MAIN, plan_args(), &calls, &probes).await;
    let made = card_frames(&mut rx);
    assert_eq!(made.len(), 1, "{made:?}");
    assert_eq!(made[0].1, json!("open"));
    let run_id = made[0].0.clone();
    assert!(run_id.is_string());

    probes.lock().unwrap().insert("sid-lane-a".into(), SubProbe::Done);
    probes.lock().unwrap().insert("sid-lane-a2".into(), SubProbe::Done);
    call(&st, MAIN, json!({"action": "done", "step": "s3"}), &calls, &probes).await;
    let closed = card_frames(&mut rx);
    assert!(!closed.is_empty(), "closing the last step is a change the card shows");
    assert_eq!(closed.last().unwrap(), &(run_id, json!("done")));
}

#[tokio::test]
async fn a_refused_call_announces_nothing() {
    let (_d, st, calls, probes) = fixtures();
    let mut thin = plan_args();
    thin["steps"][1]["spawn"] = json!({"name": "lane-a2"});
    let mut rx = st.notifier.subscribe();
    call(&st, MAIN, thin, &calls, &probes).await;
    assert!(card_frames(&mut rx).is_empty(), "a plan that registers nothing changes nothing");
    call(&st, MAIN, plan_args(), &calls, &probes).await;
    card_frames(&mut rx);
    call(&st, MAIN, json!({"action": "done", "step": "s9"}), &calls, &probes).await;
    assert!(card_frames(&mut rx).is_empty(), "a refused step id changes nothing");
}

#[tokio::test]
async fn a_refused_plan_registers_nothing() {
    let (_d, st, calls, probes) = fixtures();
    let mut thin = plan_args();
    thin["steps"][1]["spawn"] = json!({"name": "lane-a2"});
    let out = call(&st, MAIN, thin, &calls, &probes).await;
    assert_eq!(out["ok"], json!(false));
    let err = out["error"].as_str().unwrap();
    assert!(err.contains("step s2") && err.contains("task") && err.contains("done_when"), "the brief rules name the step and the fields: {err}");

    let mut looped = plan_args();
    looped["steps"][0]["after"] = json!(["s2"]);
    assert!(call(&st, MAIN, looped, &calls, &probes).await["error"].as_str().unwrap().contains("circle"));

    let mut twin = plan_args();
    twin["steps"][1]["spawn"]["name"] = json!("LANE-A");
    assert!(call(&st, MAIN, twin, &calls, &probes).await["error"].as_str().unwrap().contains("already exists"));

    let mut opus_writer = plan_args();
    opus_writer["steps"][0]["spawn"] = json!({"name": "w", "task": "t", "goal": "g", "done_when": "d", "writes": true, "files": ["src/"], "model": "opus", "effort": "high"});
    assert!(call(&st, MAIN, opus_writer, &calls, &probes).await["error"].as_str().unwrap().contains("Opus"));

    let mut no_goal = plan_args();
    no_goal["goal"] = json!("  ");
    assert!(call(&st, MAIN, no_goal, &calls, &probes).await["error"].as_str().unwrap().contains("goal is missing"));

    assert!(calls.lock().unwrap().is_empty(), "every check runs before the first lane is registered");
    assert!(load_in(&decisions::data_root().unwrap(), MAIN).is_none(), "and no plan is stored");
}

#[tokio::test]
async fn only_a_main_chat_with_the_mode_on_may_hold_a_plan_and_one_run_is_open_at_a_time() {
    let (_d, st, calls, probes) = fixtures();
    st.registry.upsert_interactive("rp-plain", &std::env::current_dir().unwrap(), "proj", "2026-11-21T00:00:00Z");
    let off = call(&st, "rp-plain", plan_args(), &calls, &probes).await;
    assert!(off["error"].as_str().unwrap().contains("Use subchats"), "{off}");

    st.registry.upsert_interactive("rp-sub", &std::env::current_dir().unwrap(), "proj", "2026-11-21T00:00:00Z");
    st.registry.set_subchat_of("rp-sub", Some(MAIN.into()));
    store_sub_brief("rp-sub", MAIN);
    let sub = call(&st, "rp-sub", plan_args(), &calls, &probes).await;
    assert!(sub["error"].as_str().unwrap().contains("main chat"), "{sub}");

    assert_eq!(call(&st, MAIN, plan_args(), &calls, &probes).await["ok"], json!(true));
    let second = call(&st, MAIN, plan_args(), &calls, &probes).await;
    assert!(second["error"].as_str().unwrap().contains("still open") && second["error"].as_str().unwrap().contains("run_plan stop"), "{second}");
}

#[tokio::test]
async fn a_spawn_that_fails_midway_keeps_the_lanes_before_it_and_names_the_rest() {
    let (_d, st, calls, probes) = fixtures();
    let out = run_with(&st, MAIN, &plan_args(), spawner(&calls, Some("lane-a2")), &probe_of(&probes, &calls)).await;
    assert_eq!(out["ok"], json!(false), "{out}");
    let err = out["error"].as_str().unwrap();
    assert!(err.contains("start cap") && err.contains("s2") && err.contains("s3") && err.contains("run_plan add"), "{err}");
    assert_eq!(out["run"]["steps"].as_array().unwrap().len(), 1, "the lane that registered is held");
    let stored = load_in(&decisions::data_root().unwrap(), MAIN).unwrap();
    assert_eq!(stored.steps.len(), 1);

    // The fix: add the left-out steps; a new lane may wait for a step already held.
    let add = json!({"action": "add", "steps": [
        {"id": "s2", "title": "lane-a2", "after": ["s1"], "spawn": {"name": "lane-a2", "task": "t", "goal": "g", "done_when": "d", "writes": false}},
        {"id": "s3", "title": "Release", "owner": "main", "after": ["s2"]},
    ]});
    let fixed = call(&st, MAIN, add, &calls, &probes).await;
    assert_eq!(fixed["ok"], json!(true), "{fixed}");
    assert_eq!(fixed["run"]["steps"].as_array().unwrap().len(), 3);
    assert_eq!(calls.lock().unwrap().last().unwrap().1.as_deref(), Some("sid-lane-a"), "the added lane waits for the held lane's sub");
}

#[tokio::test]
async fn add_numbers_new_steps_on_and_refuses_a_stopped_run() {
    let (_d, st, calls, probes) = fixtures();
    call(&st, MAIN, plan_args(), &calls, &probes).await;
    let add = json!({"action": "add", "steps": [{"title": "Fix findings", "owner": "main", "after": ["s3"]}]});
    let out = call(&st, MAIN, add.clone(), &calls, &probes).await;
    assert_eq!(out["run"]["steps"][3]["id"], json!("s4"), "{out}");
    let bad = call(&st, MAIN, json!({"action": "add", "steps": [{"title": "x", "owner": "main", "after": ["s9"]}]}), &calls, &probes).await;
    assert!(bad["error"].as_str().unwrap().contains("s9"), "{bad}");

    call(&st, MAIN, json!({"action": "stop"}), &calls, &probes).await;
    let after_stop = call(&st, MAIN, add, &calls, &probes).await;
    assert!(after_stop["error"].as_str().unwrap().contains("stopped"), "{after_stop}");
}

#[tokio::test]
async fn done_is_for_main_steps_and_skip_is_for_main_steps_and_blocked_lanes() {
    let (_d, st, calls, probes) = fixtures();
    call(&st, MAIN, plan_args(), &calls, &probes).await;
    let sub_done = call(&st, MAIN, json!({"action": "done", "step": "s1"}), &calls, &probes).await;
    assert!(sub_done["error"].as_str().unwrap().contains("sub step"), "{sub_done}");
    let ghost = call(&st, MAIN, json!({"action": "done", "step": "s9"}), &calls, &probes).await;
    assert!(ghost["error"].as_str().unwrap().contains("no step s9") && ghost["error"].as_str().unwrap().contains("s1, s2, s3"), "{ghost}");
    let running = call(&st, MAIN, json!({"action": "skip", "step": "s1"}), &calls, &probes).await;
    assert!(running["error"].as_str().unwrap().contains("only a blocked"), "{running}");

    probes.lock().unwrap().insert("sid-lane-a".into(), SubProbe::Blocked("it finished as \"Blocked\"".into()));
    let blocked = call(&st, MAIN, json!({"action": "status"}), &calls, &probes).await;
    assert_eq!(blocked["run"]["steps"][0]["status"], json!("blocked"));
    let skipped = call(&st, MAIN, json!({"action": "skip", "step": "s1", "note": "Joe said go on without it"}), &calls, &probes).await;
    assert_eq!(skipped["run"]["steps"][0]["status"], json!("skipped"), "{skipped}");
    assert_eq!(skipped["run"]["steps"][0]["note"], json!("Joe said go on without it"));
}

#[tokio::test]
async fn stop_drops_lanes_that_never_started_and_leaves_working_ones() {
    let (_d, st, calls, probes) = fixtures();
    call(&st, MAIN, plan_args(), &calls, &probes).await;
    // s2's sub is held for real: a registry row plus a hold entry.
    st.registry.upsert_interactive("sid-lane-a2", &std::env::current_dir().unwrap(), "proj", "2026-11-21T00:00:00Z");
    st.registry.set_subchat_of("sid-lane-a2", Some(MAIN.into()));
    store_sub_brief("sid-lane-a2", MAIN);
    held::hold(
        &st,
        Held { sub_id: "sid-lane-a2".into(), reason: "waiting for lane-a".into(), after: Some("sid-lane-a".into()), after_name: "lane-a".into(), cleared: Vec::new(), launch: LaunchSpec::default() },
    )
    .unwrap();
    let out = call(&st, MAIN, json!({"action": "stop"}), &calls, &probes).await;
    assert_eq!(out["ok"], json!(true), "{out}");
    assert_eq!(out["dropped"], json!(["lane-a2"]));
    assert_eq!(out["still_working"], json!(["lane-a"]));
    assert_eq!(out["run"]["status"], json!("stopped"));
    assert!(!held::is_held("sid-lane-a2"), "the held lane is released");
    // `cancel` is the same action.
    let again = call(&st, MAIN, json!({"action": "cancel"}), &calls, &probes).await;
    assert_eq!(again["ok"], json!(true));
}

#[tokio::test]
async fn a_stopped_run_is_replaced_by_a_new_create() {
    let (_d, st, calls, probes) = fixtures();
    call(&st, MAIN, plan_args(), &calls, &probes).await;
    call(&st, MAIN, json!({"action": "stop"}), &calls, &probes).await;
    let mut next = plan_args();
    next["title"] = json!("Second job");
    next["steps"] = json!([lane("other-lane", &[])]);
    let out = call(&st, MAIN, next, &calls, &probes).await;
    assert_eq!(out["ok"], json!(true), "{out}");
    assert_eq!(out["run"]["title"], json!("Second job"));
    assert_eq!(out["run"]["steps"].as_array().unwrap().len(), 1);
}

/// Nothing settles a run in the background yet, so an action reads the subs itself: the
/// stored statuses are one tool call old.
#[tokio::test]
async fn stop_records_a_lane_that_finished_since_the_last_call_as_done_not_skipped() {
    let (_d, st, calls, probes) = fixtures();
    call(&st, MAIN, plan_args(), &calls, &probes).await;
    // The lanes finish after the last call: the file still says running and waiting.
    probes.lock().unwrap().insert("sid-lane-a".into(), SubProbe::Done);
    probes.lock().unwrap().insert("sid-lane-a2".into(), SubProbe::Done);
    let stopped = call(&st, MAIN, json!({"action": "stop"}), &calls, &probes).await;
    let steps = stopped["run"]["steps"].as_array().unwrap();
    assert_eq!(steps[0]["status"], json!("done"), "a finished lane is not recorded as skipped: {stopped}");
    assert_eq!(steps[1]["status"], json!("done"), "{stopped}");
    assert_eq!(steps[2]["status"], json!("skipped"), "the main step was still to do");
}

/// A lane that blocked after the last call can be skipped without a status call first.
#[tokio::test]
async fn skip_sees_a_lane_that_blocked_since_the_last_call() {
    let (_d, st, calls, probes) = fixtures();
    call(&st, MAIN, plan_args(), &calls, &probes).await;
    probes.lock().unwrap().insert("sid-lane-a".into(), SubProbe::Blocked("it finished as \"Blocked\"".into()));
    let skipped = call(&st, MAIN, json!({"action": "skip", "step": "s1"}), &calls, &probes).await;
    assert_eq!(skipped["run"]["steps"][0]["status"], json!("skipped"), "{skipped}");
}

/// A run whose steps finished does not block the next create, though the file still says open.
#[tokio::test]
async fn a_run_that_finished_since_the_last_call_does_not_block_the_next_create() {
    let (_d, st, calls, probes) = fixtures();
    // Lanes only: no main step whose `done` would rewrite the file as finished.
    let mut lanes = plan_args();
    lanes["steps"] = json!([lane("lane-a", &[]), lane("lane-b", &["s1"])]);
    call(&st, MAIN, lanes, &calls, &probes).await;
    probes.lock().unwrap().insert("sid-lane-a".into(), SubProbe::Done);
    probes.lock().unwrap().insert("sid-lane-b".into(), SubProbe::Done);
    let mut next = plan_args();
    next["steps"] = json!([lane("other-lane", &[])]);
    assert_eq!(call(&st, MAIN, next, &calls, &probes).await["ok"], json!(true));
}

#[tokio::test]
async fn a_spawn_key_the_tool_does_not_take_is_refused_by_name() {
    let (_d, st, calls, probes) = fixtures();
    for key in ["after", "machine", "plain", "continue_from"] {
        let mut args = plan_args();
        args["steps"][0]["spawn"][key] = json!("x");
        let out = call(&st, MAIN, args, &calls, &probes).await;
        assert_eq!(out["ok"], json!(false), "{key}: {out}");
        let err = out["error"].as_str().unwrap();
        assert!(err.contains(&format!("{key:?}")) && err.contains("step 1") && err.contains("done_when"), "{key}: {err}");
    }
    assert!(calls.lock().unwrap().is_empty(), "a refused plan registers nothing");
}

#[tokio::test]
async fn a_step_key_the_tool_does_not_take_is_refused_by_name() {
    let (_d, st, calls, probes) = fixtures();
    for key in ["task", "depends_on", "writes"] {
        let mut args = plan_args();
        args["steps"][1][key] = json!("x");
        let out = call(&st, MAIN, args, &calls, &probes).await;
        assert_eq!(out["ok"], json!(false), "{key}: {out}");
        let err = out["error"].as_str().unwrap();
        assert!(err.contains(&format!("{key:?}")) && err.contains("step 2") && err.contains("inside spawn"), "{key}: {err}");
    }
    assert!(calls.lock().unwrap().is_empty(), "a refused plan registers nothing");
}

#[tokio::test]
async fn stopping_a_finished_run_leaves_it_done_so_it_can_still_take_a_step() {
    let (_d, st, calls, probes) = fixtures();
    let mut lanes = plan_args();
    lanes["steps"] = json!([lane("lane-a", &[])]);
    call(&st, MAIN, lanes, &calls, &probes).await;
    probes.lock().unwrap().insert("sid-lane-a".into(), SubProbe::Done);
    let stopped = call(&st, MAIN, json!({"action": "stop"}), &calls, &probes).await;
    assert_eq!(stopped["run"]["status"], json!("done"), "{stopped}");
    let add = call(&st, MAIN, json!({"action": "add", "steps": [{"title": "Fix", "owner": "main"}]}), &calls, &probes).await;
    assert_eq!(add["ok"], json!(true), "{add}");
    assert_eq!(add["run"]["status"], json!("open"), "a step added to a finished run reopens it");
}

/// The tool refuses any spawn key outside `SPAWN_KEYS`, so a field added to `SpawnSpec`
/// alone would be refused at the door.
#[test]
fn the_accepted_spawn_keys_are_the_fields_of_the_spawn_spec() {
    let mut have: Vec<String> = serde_json::to_value(SpawnSpec::default()).unwrap().as_object().unwrap().keys().cloned().collect();
    let mut want: Vec<String> = super::action::SPAWN_KEYS.iter().map(|k| k.to_string()).collect();
    have.sort();
    want.sort();
    assert_eq!(have, want);
}

#[tokio::test]
async fn a_gate_step_needs_only_its_prompt_and_runs_on_the_high_tier() {
    let (_d, st, calls, probes) = fixtures();
    let args = json!({"action": "create", "title": "t", "goal": "g", "steps": [
        lane("lane-a", &[]),
        {"id": "gate", "title": "Review", "after": ["s1"], "spawn": {"name": "review-gate", "gate": true, "prompt": "Run code-check over the merges."}},
    ]});
    let out = call(&st, MAIN, args, &calls, &probes).await;
    assert_eq!(out["ok"], json!(true), "{out}");
    let seen = calls.lock().unwrap().clone();
    assert_eq!(seen[1].1.as_deref(), Some("sid-lane-a"), "the gate waits for the lane");
    assert_eq!(seen[1].3.as_deref(), Some("high"), "a gate is judgement: high effort, never the omitted-effort default");
}

#[tokio::test]
async fn a_gate_step_without_a_prompt_is_refused() {
    let (_d, st, calls, probes) = fixtures();
    let args = json!({"action": "create", "title": "t", "goal": "g", "steps": [{"title": "Review", "spawn": {"name": "g2", "gate": true}}]});
    let refused = call(&st, MAIN, args, &calls, &probes).await;
    assert!(refused["error"].as_str().unwrap().contains("gate: true needs a prompt"), "{refused}");
    assert!(calls.lock().unwrap().is_empty());
}

// ---- a result the main chat read is not woken for again (pc-1804 step 2) ----

#[tokio::test]
async fn a_step_the_main_chat_read_in_a_tool_result_is_not_woken_for_again() {
    let (_d, st, calls, probes) = fixtures();
    call(&st, MAIN, plan_args(), &calls, &probes).await;
    probes.lock().unwrap().insert("sid-lane-a".into(), SubProbe::Done);
    probes.lock().unwrap().insert("sid-lane-a2".into(), SubProbe::Done);
    let out = call(&st, MAIN, json!({"action": "status"}), &calls, &probes).await;
    assert_eq!(out["run"]["yours"], json!(["s3"]));
    let root = decisions::data_root().unwrap();
    let table = probe_of(&probes, &calls);
    assert!(super::advance::advance_in(&root, MAIN, &table).is_none(), "status already told the main chat that s3 is ready");

    // Closing the last step ends the run; the chat that did it needs no end wake.
    call(&st, MAIN, json!({"action": "done", "step": "s3"}), &calls, &probes).await;
    assert!(super::advance::advance_in(&root, MAIN, &table).is_none(), "done told it the run is finished");
}

#[tokio::test]
async fn an_add_or_create_that_is_refused_shows_no_run_so_it_swallows_no_wake() {
    let (_d, st, calls, probes) = fixtures();
    call(&st, MAIN, plan_args(), &calls, &probes).await;
    probes.lock().unwrap().insert("sid-lane-a".into(), SubProbe::Done);
    probes.lock().unwrap().insert("sid-lane-a2".into(), SubProbe::Done);
    let refused = call(&st, MAIN, json!({"action": "add", "steps": []}), &calls, &probes).await;
    assert_eq!(refused["ok"], json!(false));
    assert!(refused.get("run").is_none(), "{refused}");
    let again = call(&st, MAIN, plan_args(), &calls, &probes).await;
    assert_eq!(again["ok"], json!(false), "the run is still open: {again}");
    let root = decisions::data_root().unwrap();
    let table = probe_of(&probes, &calls);
    let (_, fresh) = super::advance::advance_in(&root, MAIN, &table).expect("s3 became ready and no result showed it");
    assert_eq!(fresh, vec!["ready:s3".to_string()]);
}
