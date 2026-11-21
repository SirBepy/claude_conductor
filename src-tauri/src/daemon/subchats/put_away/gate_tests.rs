//! pc-1806 step 2: every start and wake path obeys a put-away family. Each test hides
//! one family, drives one path and checks it refused, deferred or queued instead of
//! starting anything; the same path on an open family is the control where one is cheap.
//!
//! Paths whose private helpers live elsewhere have their test beside them
//! (`repo_channel_wake`, `schedule`, `peer_scope`, `resume_interrupted`, `lifecycle`,
//! `registry::lifecycle`, `methods::lifecycle::put_away_tests`).

use super::*;
use crate::daemon::lifecycle::{self, LifecycleError, StartSessionParams};
use crate::daemon::session::new_session_map;
use crate::daemon::settings_cache::SettingsCache;
use crate::daemon::subchats::held::{self, Held, LaunchSpec};
use crate::daemon::subchats::{store_sub_brief, SubchatArgs, TempDataDir};
use crate::types::Settings;
use chrono::Utc;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

fn state() -> Arc<DaemonState> {
    DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()))
}

fn here() -> PathBuf {
    std::env::current_dir().unwrap()
}

fn row(st: &DaemonState, id: &str) {
    if st.registry.get(id).is_none() {
        st.registry.upsert_interactive(id, &here(), "proj", "2026-11-21T00:00:00Z");
    }
}

fn sub_of(st: &DaemonState, parent: &str, id: &str, name: &str) {
    row(st, parent);
    row(st, id);
    st.registry.set_subchat_of(id, Some(parent.into()));
    st.registry.set_name(id, name.into());
    store_sub_brief(id, parent);
}

/// Puts `main` away with no recorded subs: the gate is what these tests are about.
fn hide(st: &Arc<DaemonState>, main: &str) {
    put_away(st, main, Vec::new(), "2026-11-21T01:00:00Z").unwrap();
}

fn spec() -> LaunchSpec {
    LaunchSpec { cwd: here(), model: "sonnet".into(), effort: "high".into(), account_id: Some("acct".into()), first_message: "go".into() }
}

fn hold_behind(st: &DaemonState, parent: &str, sub: &str, target: &str) {
    sub_of(st, parent, sub, sub);
    held::hold(
        st,
        Held {
            sub_id: sub.into(),
            reason: format!("waiting for {target}"),
            after: Some(target.into()),
            after_name: target.into(),
            cleared: Vec::new(),
            launch: spec(),
        },
    )
    .unwrap();
}

type Calls = Arc<Mutex<Vec<String>>>;

fn launcher(calls: &Calls) -> impl Fn(Arc<DaemonState>, String) -> std::future::Ready<Result<(), String>> {
    let calls = calls.clone();
    move |st, id| {
        calls.lock().unwrap().push(id.clone());
        held::release(&st, &id);
        std::future::ready(Ok(()))
    }
}

fn wakes(st: &DaemonState, main: &str) -> Vec<String> {
    st.repo_channel_wakes.lock().unwrap().get(main).map(|q| q.iter().map(|l| l.text.clone()).collect()).unwrap_or_default()
}

fn params(resume_id: Option<&str>, new_session_id: Option<&str>) -> StartSessionParams {
    StartSessionParams {
        cwd: here(),
        model: "opus".into(),
        effort: "high".into(),
        resume_id: resume_id.map(str::to_string),
        account_id: None,
        fork: false,
        new_session_id: new_session_id.map(str::to_string),
    }
}

fn is_put_away(e: &LifecycleError) -> bool {
    matches!(e, LifecycleError::PutAway(text) if text.starts_with(REFUSAL_PREFIX))
}

// ---- who the gate covers ----------------------------------------------------------

#[test]
fn the_gate_covers_the_main_chat_and_its_subs_and_nobody_else() {
    let _d = TempDataDir::new();
    let st = state();
    sub_of(&st, "g1-main", "g1-sub", "sub");
    row(&st, "g1-plain");
    sub_of(&st, "g1-other", "g1-other-sub", "other");
    assert!(!is_gated(&st, "g1-main") && !is_gated(&st, "g1-sub"));

    hide(&st, "g1-main");

    assert_eq!(family_main(&st, "g1-sub"), "g1-main");
    assert_eq!(family_main(&st, "g1-main"), "g1-main");
    assert!(is_gated(&st, "g1-main") && is_gated(&st, "g1-sub"));
    assert!(!is_gated(&st, "g1-plain") && !is_gated(&st, "g1-other") && !is_gated(&st, "g1-other-sub"));
    assert!(!is_gated(&st, "unknown"));
}

// ---- spawn, wake and send in lifecycle ----------------------------------------------

#[tokio::test]
async fn a_spawn_for_a_put_away_chat_a_sub_or_a_new_sub_of_it_is_refused_before_any_account_work() {
    let _d = TempDataDir::new();
    let st = state();
    sub_of(&st, "sp-main", "sp-sub", "sub");
    hide(&st, "sp-main");

    // The main chat and a sub resumed by id, and a brand-new sub whose row does not exist yet.
    for (resume, new_id, parent) in [(Some("sp-main"), None, None), (Some("sp-sub"), None, None), (None, Some("sp-new"), Some("sp-main"))] {
        let err = lifecycle::spawn_session_as(&st, params(resume, new_id), parent).await.err().expect("refused");
        assert!(is_put_away(&err), "{resume:?} {new_id:?}: {err:?}");
    }
    assert!(st.sessions.is_empty(), "nothing was started");
}

#[tokio::test]
async fn a_send_that_would_respawn_a_put_away_chat_is_refused_on_every_send_door() {
    let _d = TempDataDir::new();
    let st = state();
    sub_of(&st, "sd-main", "sd-sub", "sub");
    hide(&st, "sd-main");

    for id in ["sd-main", "sd-sub"] {
        let a = lifecycle::send_message_with_respawn(&st, id, "hi", false).await.err().expect("refused");
        let b = lifecycle::send_message_with_respawn_and_author(&st, id, "hi", "author").await.err().expect("refused");
        let c = lifecycle::send_message_with_respawn_meta_and_author(&st, id, "hi", "author").await.err().expect("refused");
        assert!(is_put_away(&a) && is_put_away(&b) && is_put_away(&c), "{id}: {a:?} {b:?} {c:?}");
    }
}

#[test]
fn an_idle_freeze_of_a_put_away_member_is_not_woken_and_an_open_family_still_wakes() {
    let _d = TempDataDir::new();
    let st = state();
    sub_of(&st, "wk-main", "wk-sub", "sub");
    sub_of(&st, "wk-open-main", "wk-open-sub", "open");
    for id in ["wk-sub", "wk-open-sub"] {
        st.registry.set_frozen(id, true);
        st.registry.set_auto_frozen(id, true);
        assert!(crate::daemon::subchats::idle_freeze::mark(id));
    }
    hide(&st, "wk-main");

    assert!(!crate::daemon::subchats::idle_freeze::wake(&st, "wk-sub"), "the family stays asleep");
    assert!(st.registry.get("wk-sub").unwrap().frozen);
    assert!(crate::daemon::subchats::idle_freeze::wake(&st, "wk-open-sub"), "control: an open family wakes");
}

#[test]
fn continuing_a_sub_of_a_put_away_chat_clears_neither_its_freeze_nor_its_finished_mark() {
    let _d = TempDataDir::new();
    let st = state();
    sub_of(&st, "pc-main", "pc-sub", "sub");
    st.registry.set_subchat_finished("pc-sub", true);
    st.registry.set_frozen("pc-sub", true);
    hide(&st, "pc-main");

    let err = crate::daemon::subchats::resume::prepare_continue(&st, "pc-sub").err().expect("refused");
    assert!(matches!(&err, crate::daemon::subchats::ContinueError::Send(e) if is_put_away(e)), "{err:?}");
    let row = st.registry.get("pc-sub").unwrap();
    assert!(row.frozen && row.subchat_finished, "a refusal changes nothing");
}

// ---- held starts ------------------------------------------------------------------------

#[tokio::test]
async fn an_after_release_records_the_cleared_target_but_launches_nothing_while_put_away_and_does_after_a_reopen() {
    let _d = TempDataDir::new();
    let st = state();
    sub_of(&st, "ar-main", "ar-first", "first");
    st.registry.set_subchat_finished("ar-first", true);
    hold_behind(&st, "ar-main", "ar-next", "ar-first");
    hide(&st, "ar-main");
    let seen: Calls = Arc::new(Mutex::new(Vec::new()));

    held::release_ready(&st, launcher(&seen)).await;

    assert!(seen.lock().unwrap().is_empty(), "nothing starts");
    assert!(held::is_held("ar-next"), "the hold stays");
    let entry = held::all().into_iter().find(|h| h.sub_id == "ar-next").unwrap();
    assert_eq!(entry.cleared, vec!["ar-first".to_string()], "the finished target is recorded");

    reopen(&st, "ar-main").unwrap();
    held::release_ready(&st, launcher(&seen)).await;
    assert_eq!(seen.lock().unwrap().clone(), vec!["ar-next".to_string()], "a reopen releases it");
}

#[tokio::test]
async fn a_target_that_ended_blocked_raises_no_card_for_a_put_away_family() {
    let _d = TempDataDir::new();
    let st = state();
    sub_of(&st, "bl-main", "bl-first", "first");
    st.registry.mark_ended("bl-first", crate::types::EndReason::Manual, "2026-11-21T00:30:00Z");
    hold_behind(&st, "bl-main", "bl-next", "bl-first");
    hide(&st, "bl-main");
    let seen: Calls = Arc::new(Mutex::new(Vec::new()));

    held::release_ready(&st, launcher(&seen)).await;

    let cards: Vec<_> = st.list_prompts().await.into_iter().filter(|p| p["payload"]["card_kind"] == held::CARD_KIND).collect();
    assert!(cards.is_empty() && seen.lock().unwrap().is_empty(), "{cards:?}");
}

#[tokio::test]
async fn a_held_start_by_any_other_door_is_refused_and_keeps_the_hold() {
    let _d = TempDataDir::new();
    let st = state();
    sub_of(&st, "lc-main", "lc-first", "first");
    hold_behind(&st, "lc-main", "lc-next", "lc-first");
    hide(&st, "lc-main");

    let err = held::launch_held(&st, "lc-next").await.err().expect("refused");
    assert!(err.starts_with(REFUSAL_PREFIX), "{err}");
    assert!(held::is_held("lc-next"), "a refusal keeps the hold");
}

#[test]
fn a_put_away_main_chat_plans_and_registers_no_sub() {
    let _d = TempDataDir::new();
    let st = state();
    sub_of(&st, "rg-first-main", "rg-header", "header");
    let cfg = crate::sessions::chat_config::ChatConfig { subchats_on: true, ..Default::default() };
    let args = SubchatArgs {
        task: Some("Footer".into()),
        goal: Some("g".into()),
        done_when: Some("d".into()),
        writes: Some(false),
        after: Some("header".into()),
        ..Default::default()
    };
    let cwd = here().to_string_lossy().to_string();
    // A plan made before the pause, registered after it: the registering door is its own gate.
    let mut plan = crate::daemon::subchats::spawn::plan(&st, "rg-first-main", &cfg, &cwd, None, None, None, Some("footer"), &args, &[])
        .unwrap()
        .unwrap();
    hide(&st, "rg-first-main");

    let planned = crate::daemon::subchats::spawn::plan(&st, "rg-first-main", &cfg, &cwd, None, None, None, Some("footer-2"), &args, &[]);
    assert!(planned.err().is_some_and(|e| e.starts_with(REFUSAL_PREFIX)), "planning is refused");
    let registered = held::register_row(&st, "rg-first-main", Some("footer"), &cfg, spec(), &mut plan);
    assert!(registered.err().is_some_and(|e| e.starts_with(REFUSAL_PREFIX)), "registering is refused");
    assert!(st.registry.list().iter().all(|i| i.name.as_deref() != Some("footer")), "no row was made");
}

#[tokio::test]
async fn a_writer_queue_launch_is_taken_out_of_line_with_its_hold_kept_and_a_reopen_requeues_it() {
    let _d = TempDataDir::new();
    let st = state();
    sub_of(&st, "wq-main", "wq-sub", "writer");
    held::hold(
        &st,
        Held { sub_id: "wq-sub".into(), reason: "waiting for the writer slot".into(), after: None, after_name: String::new(), cleared: Vec::new(), launch: spec() },
    )
    .unwrap();
    crate::daemon::subchats::writers::forget_project_for_test(&here());
    crate::daemon::subchats::writers::queue_behind_for_test(&here(), "someone-else", "wq-sub");
    hide(&st, "wq-main");

    crate::daemon::subchats::writers::run_start(&st, crate::daemon::subchats::writers::Start::Launch { sub_id: "wq-sub".into() }).await;

    assert!(held::is_held("wq-sub"), "the recipe stays");
    assert!(!held::parked("wq-sub"), "a gated start is not a failed start: no park");
    let cards: Vec<_> = st.list_prompts().await.into_iter().filter(|p| p["payload"]["card_kind"] == held::CARD_KIND).collect();
    assert!(cards.is_empty(), "and no card: {cards:?}");
    crate::daemon::subchats::writers::forget_project_for_test(&here());
}

// ---- wakes of the main chat --------------------------------------------------------------

#[tokio::test]
async fn every_sub_wake_of_a_put_away_main_chat_folds_into_one_row_and_starts_no_drain() {
    let _d = TempDataDir::new();
    let st = state();
    sub_of(&st, "wm-main", "wm-sub", "sub");
    hide(&st, "wm-main");

    for n in 0..4 {
        crate::daemon::subchats::wake::wake_main_chat(&st, "wm-main", format!("Sub finished {n}"));
    }

    let lines = wakes(&st, "wm-main");
    assert_eq!(lines.len(), 1, "{lines:?}");
    assert!(lines[0].starts_with("4 subs changed while this chat was put away."), "{}", lines[0]);
    assert!(!lines[0].contains("finished"), "no per-sub text rides the folded row");
    assert!(st.repo_channel_wakes.lock().unwrap()["wm-main"][0].code_built, "it is a daemon notice, kept on disk with the others");
}

#[test]
fn a_wake_of_an_open_main_chat_is_unchanged() {
    let _d = TempDataDir::new();
    let st = state();
    row(&st, "wo-main");
    crate::daemon::subchats::wake::wake_main_chat(&st, "wo-main", "Sub finished 1".into());
    crate::daemon::subchats::wake::wake_main_chat(&st, "wo-main", "Sub finished 2".into());
    assert_eq!(wakes(&st, "wo-main"), vec!["Sub finished 1".to_string(), "Sub finished 2".to_string()]);
}

#[test]
fn a_problem_report_for_a_sub_of_a_put_away_chat_folds_into_the_one_row() {
    let _d = TempDataDir::new();
    let st = state();
    sub_of(&st, "pl-main", "pl-sub", "sub");
    hide(&st, "pl-main");

    assert!(crate::daemon::subchats::plumbing::report_here(
        &st,
        "pl-sub",
        crate::daemon::subchats::plumbing::Problem::CouldNotStart,
        "no account".into(),
        Vec::new()
    ));

    let lines = wakes(&st, "pl-main");
    assert_eq!(lines.len(), 1, "{lines:?}");
    assert!(lines[0].starts_with("1 sub changed while this chat was put away."), "{}", lines[0]);
}

// ---- the auto-close of a finished sub -----------------------------------------------------

#[tokio::test]
async fn a_finished_sub_a_live_held_sub_still_waits_for_is_not_closed_and_is_once_the_wait_is_settled() {
    let _d = TempDataDir::new();
    let root = tempfile::tempdir().unwrap();
    let st = state();
    let now = Utc::now();
    sub_of(&st, "ac-main", "ac-first", "first");
    st.registry.set_subchat_finished("ac-first", true);
    let record = crate::daemon::subchats::finish::FinishRecord {
        sub_id: "ac-first".into(),
        finished_at: (now - chrono::Duration::hours(20)).to_rfc3339(),
        ..Default::default()
    };
    crate::daemon::subchats::finish::write_record_in(root.path(), &record).unwrap();
    hold_behind(&st, "ac-main", "ac-next", "ac-first");

    let due = crate::daemon::subchats::auto_close::due(&st, root.path(), now).await;
    assert!(!due.contains(&"ac-first".to_string()), "something still waits for it: {due:?}");

    // The wait recorded it as finished cleanly: closing it now costs the waiter nothing.
    let mut entry = held::all().into_iter().find(|h| h.sub_id == "ac-next").unwrap();
    entry.cleared = vec!["ac-first".into()];
    held::hold(&st, entry).unwrap();
    let due = crate::daemon::subchats::auto_close::due(&st, root.path(), now).await;
    assert!(due.contains(&"ac-first".to_string()), "{due:?}");
}
