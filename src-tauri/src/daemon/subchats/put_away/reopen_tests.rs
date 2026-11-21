//! Tests for `reopen.rs` (pc-1806 step 6): the reopen opens the gate for the main chat only, the
//! "Continue the plan?" answer deals with each paused sub, and "No" never turns a good `after`
//! chain into a Blocked card. No child is spawned: a row with no session is what these read,
//! and no sub that "needs a continue" is resumed here (the send would respawn a real `claude`).
//! Ids are unique to this file: the put-away flow's running set is process-wide.

use super::flow::{run, Timing};
use super::*;
use crate::daemon::session::new_session_map;
use crate::daemon::settings_cache::SettingsCache;
use crate::daemon::subchats::held::{self, Held, LaunchSpec};
use crate::daemon::subchats::{store_sub_brief, TempDataDir};
use crate::types::Settings;
use std::sync::{Arc, Mutex};
use std::time::Duration;

const M: &str = "ro-main";
const AT: &str = "2026-11-21T09:00:00Z";

fn state() -> Arc<DaemonState> {
    let mut s = Settings::default();
    let (id, _) = crate::settings::upsert_project_for_cwd(&mut s, std::path::Path::new(env!("CARGO_MANIFEST_DIR")), "2026-11-12T00:00:00Z");
    s.projects.iter_mut().find(|p| p.id == id).unwrap().id = "pa".into();
    DaemonState::new(new_session_map(), SettingsCache::new(s))
}

fn here() -> std::path::PathBuf {
    std::env::current_dir().unwrap()
}

fn paused(id: &str, prior: Prior) -> PausedSub {
    PausedSub {
        sub_id: id.into(),
        name: Some(id.trim_start_matches("ro-").to_string()),
        prior,
        needs_continue: prior == Prior::Working,
        paused_at: Some(AT.into()),
        machine_id: None,
    }
}

fn spec() -> LaunchSpec {
    LaunchSpec { cwd: here(), model: "sonnet".into(), effort: "high".into(), account_id: Some("acct".into()), first_message: "go".into() }
}

/// A put-away family: main `ro-main` (frozen, hidden) with `ro-busy` (was in a turn), `ro-idle`,
/// `ro-done` (finished), `ro-gone` (ended since) and `ro-held` (never started, waits for `ro-idle`).
/// The busy sub's row carries no continue mark, so a resume never sends it a message.
fn put_away_family() -> Arc<DaemonState> {
    let st = state();
    st.registry.upsert_interactive(M, &here(), "pa", AT);
    for id in ["ro-busy", "ro-idle", "ro-done", "ro-gone", "ro-held"] {
        st.registry.upsert_interactive(id, &here(), "pa", AT);
        st.registry.set_subchat_of(id, Some(M.into()));
        st.registry.set_name(id, id.trim_start_matches("ro-").to_string());
        store_sub_brief(id, M);
    }
    for id in ["ro-busy", "ro-idle"] {
        st.registry.set_frozen(id, true);
    }
    st.registry.set_subchat_finished("ro-done", true);
    st.registry.mark_ended("ro-gone", crate::types::EndReason::Manual, AT);
    st.registry.set_frozen(M, true);
    held::hold(
        &st,
        Held {
            sub_id: "ro-held".into(),
            reason: "waiting for idle".into(),
            after: Some("ro-idle".into()),
            after_name: "idle".into(),
            cleared: Vec::new(),
            launch: spec(),
        },
    )
    .unwrap();
    put_away(
        &st,
        M,
        vec![
            paused("ro-busy", Prior::Working),
            paused("ro-idle", Prior::Idle),
            paused("ro-done", Prior::Finished),
            paused("ro-gone", Prior::Idle),
            paused("ro-held", Prior::Held),
        ],
        "2026-11-21T10:00:00Z",
    )
    .unwrap();
    st
}

fn no_wait() -> ResumeTiming {
    ResumeTiming { gap: Duration::ZERO, poll: Duration::from_millis(1), cap_wait: Duration::ZERO }
}

fn row(st: &DaemonState, id: &str) -> crate::types::Instance {
    st.registry.get(id).unwrap_or_else(|| panic!("{id} has a row"))
}

fn waiting_ids() -> Vec<String> {
    let mut ids: Vec<String> = awaiting(M).unwrap().into_iter().map(|s| s.sub_id).collect();
    ids.sort();
    ids
}

fn listed(view: &serde_json::Value) -> Vec<String> {
    let mut ids: Vec<String> = view["paused"].as_array().unwrap().iter().map(|s| s["sub_id"].as_str().unwrap().to_string()).collect();
    ids.sort();
    ids
}

async fn blocked_cards(st: &DaemonState) -> Vec<serde_json::Value> {
    st.list_prompts().await.into_iter().filter(|p| p["payload"]["card_kind"] == held::CARD_KIND).collect()
}

async fn until(mut done: impl FnMut() -> bool) -> bool {
    for _ in 0..400 {
        if done() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    false
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

// ---- the reopen --------------------------------------------------------------------------

#[tokio::test]
async fn a_reopen_wakes_the_main_chat_only_and_keeps_every_sub_with_work_held() {
    let _d = TempDataDir::new();
    let st = put_away_family();
    assert!(is_gated(&st, M), "control: put away, the main chat is gated");

    let view = reopen_main(&st, M).await.expect("reopen");

    let main = row(&st, M);
    assert!(main.hidden_at.is_none() && !main.frozen, "the main chat is awake for the user's message");
    assert!(!is_gated(&st, M), "the gate is open for it");
    assert_eq!(view["hidden"], false);
    assert_eq!(listed(&view), ["ro-busy", "ro-held", "ro-idle"], "the question lists what has work left");
    for sub in ["ro-busy", "ro-idle", "ro-held"] {
        assert!(is_gated(&st, sub), "{sub} stays held until the answer");
    }
    assert!(row(&st, "ro-idle").frozen && row(&st, "ro-busy").frozen, "nothing resumed yet");
    assert!(held::is_held("ro-held"), "its hold stays");
    assert!(holds_wakes(&st, M), "wakes stay queued until the answer");
}

#[tokio::test]
async fn the_view_says_what_each_sub_waits_for_and_whether_it_was_cut_mid_turn() {
    let _d = TempDataDir::new();
    let st = put_away_family();
    let view = reopen_main(&st, M).await.unwrap();
    let find = |id: &str| view["paused"].as_array().unwrap().iter().find(|s| s["sub_id"] == id).cloned().unwrap();
    assert_eq!(find("ro-held")["after"], serde_json::json!(["ro-idle"]));
    assert_eq!(find("ro-held")["prior"], "held");
    assert_eq!(find("ro-busy")["needs_continue"], true);
    assert_eq!(find("ro-busy")["after"], serde_json::json!([]));
}

#[tokio::test]
async fn a_sub_with_nothing_to_resume_is_dealt_with_at_the_reopen() {
    let _d = TempDataDir::new();
    let st = put_away_family();
    reopen_main(&st, M).await.unwrap();
    let ids = waiting_ids();
    assert!(!ids.contains(&"ro-done".to_string()), "a finished sub has nothing to resume");
    assert!(!ids.contains(&"ro-gone".to_string()), "an ended sub has nothing to resume");
    assert!(!is_gated(&st, "ro-done") && !is_gated(&st, "ro-gone"));
}

#[tokio::test]
async fn a_reopen_with_nothing_waiting_ends_the_pause_at_once() {
    let _d = TempDataDir::new();
    let st = state();
    st.registry.upsert_interactive(M, &here(), "pa", AT);
    st.registry.upsert_interactive("ro-done", &here(), "pa", AT);
    st.registry.set_subchat_of("ro-done", Some(M.into()));
    st.registry.set_subchat_finished("ro-done", true);
    st.registry.set_frozen(M, true);
    put_away(&st, M, vec![paused("ro-done", Prior::Finished)], "2026-11-21T10:00:00Z").unwrap();

    let view = reopen_main(&st, M).await.unwrap();

    assert_eq!(listed(&view), Vec::<String>::new());
    assert!(read(M).is_none(), "no record is left to hold anything");
    assert!(!holds_wakes(&st, M));
}

#[tokio::test]
async fn reopening_a_chat_that_is_not_put_away_only_reports_what_waits() {
    let _d = TempDataDir::new();
    let st = state();
    st.registry.upsert_interactive(M, &here(), "pa", AT);
    st.registry.set_frozen(M, true);
    let view = reopen_main(&st, M).await.unwrap();
    assert_eq!(listed(&view), Vec::<String>::new());
    assert!(row(&st, M).frozen, "a chat the user froze by hand is not woken by a reopen that had nothing to open");
}

#[tokio::test]
async fn a_reopen_is_refused_while_the_put_away_is_still_running() {
    let _d = TempDataDir::new();
    let st = state();
    let busy = "ro-busy-main";
    st.registry.upsert_interactive(busy, &here(), "pa", AT);
    crate::sessions::chat_config::set_subchats_on(busy, true);
    st.settings.set_project_main_chat("pa", Some(busy));
    st.registry.set_busy(busy, true);
    let timing = Timing {
        poll: Duration::from_millis(5),
        quiet_wait: Duration::from_secs(5),
        compaction_wait: Duration::from_millis(400),
        sub_wait: Duration::from_millis(400),
        interrupt_wait: Duration::from_millis(100),
    };
    let flow = tokio::spawn({
        let st = st.clone();
        async move { run(&st, busy, &timing).await }
    });
    assert!(until(|| is_hidden_family(busy)).await, "the put-away wrote its record and now waits for the turn");

    let refused = reopen_main(&st, busy).await;

    assert!(matches!(refused, Err(ReopenError::BeingPutAway)), "{refused:?}");
    assert!(is_hidden_family(busy), "nothing was opened");
    st.registry.set_busy(busy, false);
    flow.await.unwrap().expect("put away");
}

// ---- the answer: Yes ---------------------------------------------------------------------

#[tokio::test]
async fn yes_resumes_every_waiting_sub_and_ends_the_pause() {
    let _d = TempDataDir::new();
    let st = put_away_family();
    reopen_main(&st, M).await.unwrap();

    let plan = begin_resume(&st, M, &[]).expect("answer");
    assert_eq!((plan.ended(), plan.resuming()), (0, 3));
    run_resume(&st, plan, &no_wait()).await;

    assert!(!row(&st, "ro-idle").frozen && !row(&st, "ro-busy").frozen, "both woke");
    assert!(read(M).is_none(), "the record is gone");
    assert!(!is_gated(&st, "ro-held") && !holds_wakes(&st, M), "nothing is held any more");
    assert!(held::is_held("ro-held"), "a held sub starts through its own `after`, not here");
}

#[tokio::test]
async fn a_second_answer_while_one_is_being_applied_is_refused() {
    let _d = TempDataDir::new();
    let st = put_away_family();
    reopen_main(&st, M).await.unwrap();
    let first = begin_resume(&st, M, &[]).expect("answer");
    assert!(begin_resume(&st, M, &[]).is_err(), "one answer at a time");
    drop(first);
    assert!(begin_resume(&st, M, &[]).is_ok(), "the next one is let in once the first is done");
}

#[tokio::test]
async fn an_answer_while_the_family_is_put_away_is_refused_and_changes_nothing() {
    let _d = TempDataDir::new();
    let st = put_away_family();
    let refused = begin_resume(&st, M, &["ro-idle".to_string()]).err().expect("refused");
    assert!(refused.starts_with(REFUSAL_PREFIX), "{refused}");
    assert!(is_hidden_family(M) && row(&st, "ro-idle").frozen && row(&st, "ro-idle").ended_at.is_none(), "nothing resumed or ended");
}

#[tokio::test]
async fn the_question_is_not_listed_again_while_an_answer_is_being_applied() {
    let _d = TempDataDir::new();
    let st = put_away_family();
    reopen_main(&st, M).await.unwrap();
    assert_eq!(listed(&paused_view(&st, M)).len(), 3, "control: the question lists three");

    let plan = begin_resume(&st, M, &[]).expect("answer");

    assert!(listed(&paused_view(&st, M)).is_empty(), "a question drawn now would list subs already on their way");
    assert!(read(M).is_some(), "the record is not settled behind the resume's back");
    assert!(listed(&settle(&st, M)).is_empty());
    assert!(read(M).is_some(), "settle leaves a running answer alone");
    drop(plan);
}

#[tokio::test]
async fn a_chat_put_away_again_mid_resume_keeps_the_rest_paused_and_their_continue_marks() {
    let _d = TempDataDir::new();
    let st = put_away_family();
    reopen_main(&st, M).await.unwrap();
    let plan = begin_resume(&st, M, &[]).expect("answer");
    // The user closes the main chat again before the stagger reaches the subs.
    put_away(&st, M, vec![paused("ro-busy", Prior::Working), paused("ro-idle", Prior::Idle)], "2026-11-21T11:00:00Z").unwrap();

    run_resume(&st, plan, &no_wait()).await;

    assert!(is_hidden_family(M), "the pause is back and nothing lifted it");
    assert!(row(&st, "ro-idle").frozen && row(&st, "ro-busy").frozen, "nothing was woken into a refused send");
    assert!(is_gated(&st, "ro-idle"));
}

#[tokio::test]
async fn a_question_nobody_can_answer_any_more_ends_the_pause_so_wakes_are_not_held_for_good() {
    let _d = TempDataDir::new();
    let st = state();
    st.registry.upsert_interactive(M, &here(), "pa", AT);
    st.registry.upsert_interactive("ro-busy", &here(), "pa", AT);
    st.registry.set_subchat_of("ro-busy", Some(M.into()));
    st.registry.set_frozen("ro-busy", true);
    st.registry.set_frozen(M, true);
    put_away(&st, M, vec![paused("ro-busy", Prior::Working)], "2026-11-21T10:00:00Z").unwrap();
    let view = reopen_main(&st, M).await.unwrap();
    assert_eq!(listed(&view), ["ro-busy"], "control: it asks");
    assert!(holds_wakes(&st, M));

    // The only sub it would ask about is ended before the answer.
    crate::daemon::subchats::resume::end_sub(&st, "ro-busy");
    let view = settle(&st, M);

    assert!(listed(&view).is_empty(), "no question is drawn");
    assert!(read(M).is_none(), "the record is gone");
    assert!(!holds_wakes(&st, M) && !is_gated(&st, "ro-busy"), "nothing is held for good");
}

// ---- the answer: No ----------------------------------------------------------------------

#[tokio::test]
async fn no_ends_the_named_subs_and_a_sub_that_waited_on_one_runs_without_a_blocked_card() {
    let _d = TempDataDir::new();
    let st = put_away_family();
    reopen_main(&st, M).await.unwrap();

    // Stop ro-idle, but not ro-held, which waits for it.
    let plan = begin_resume(&st, M, &["ro-idle".to_string()]).expect("answer");

    assert_eq!((plan.ended(), plan.resuming()), (1, 2));
    assert!(row(&st, "ro-idle").ended_at.is_some(), "the named sub is ended");
    let entry = held::all().into_iter().find(|h| h.sub_id == "ro-held").expect("its hold stays");
    assert_eq!(entry.cleared, vec!["ro-idle".to_string()], "the ended target reads as satisfied");
    // The sweep the end spawned runs now, while the dependent is still held by the pause.
    tokio::time::sleep(Duration::from_millis(60)).await;
    assert!(blocked_cards(&st).await.is_empty(), "ending a target raises no Blocked card");
    assert!(held::is_held("ro-held"), "and the dependent has not been started or dropped");

    // What the resume does for these two, without its production sweep: leave the gate, then one pass.
    resolve(M, &["ro-busy".to_string(), "ro-held".to_string()]).unwrap();
    let seen: Calls = Arc::new(Mutex::new(Vec::new()));
    held::release_ready(&st, launcher(&seen)).await;

    assert_eq!(seen.lock().unwrap().clone(), vec!["ro-held".to_string()], "the dependent starts");
    assert!(blocked_cards(&st).await.is_empty(), "and still no card");
    drop(plan);
}

#[tokio::test]
async fn without_the_cleared_mark_the_same_end_would_have_blocked_the_dependent() {
    let _d = TempDataDir::new();
    let st = put_away_family();
    reopen_main(&st, M).await.unwrap();
    // Control: ending the target by hand, with no `release_dependents`, is what a Blocked card is made of.
    crate::daemon::subchats::resume::end_sub(&st, "ro-idle");
    tokio::time::sleep(Duration::from_millis(60)).await;
    resolve(M, &["ro-busy".to_string(), "ro-held".to_string()]).unwrap();
    let seen: Calls = Arc::new(Mutex::new(Vec::new()));
    held::release_ready(&st, launcher(&seen)).await;
    assert!(seen.lock().unwrap().is_empty(), "it does not start");
    assert_eq!(blocked_cards(&st).await.len(), 1, "it asks instead");
}

#[tokio::test]
async fn no_can_end_a_target_and_the_sub_waiting_on_it_together() {
    let _d = TempDataDir::new();
    let st = put_away_family();
    reopen_main(&st, M).await.unwrap();

    let plan = begin_resume(&st, M, &["ro-idle".to_string(), "ro-held".to_string()]).expect("answer");

    assert_eq!((plan.ended(), plan.resuming()), (2, 1));
    assert!(!held::is_held("ro-held"), "its hold was dropped with it");
    assert!(row(&st, "ro-held").ended_at.is_some());
    assert_eq!(waiting_ids(), ["ro-busy"], "only the sub that resumes still waits");
    tokio::time::sleep(Duration::from_millis(60)).await;
    assert!(blocked_cards(&st).await.is_empty());
}

#[tokio::test]
async fn an_id_the_family_does_not_wait_on_is_never_ended() {
    let _d = TempDataDir::new();
    let st = put_away_family();
    st.registry.upsert_interactive("ro-stranger", &here(), "pa", AT);
    reopen_main(&st, M).await.unwrap();

    let plan = begin_resume(&st, M, &["ro-stranger".to_string(), "ro-done".to_string()]).expect("answer");

    assert_eq!(plan.ended(), 0, "neither id is a waiting sub of this family");
    assert!(row(&st, "ro-stranger").ended_at.is_none() && row(&st, "ro-done").ended_at.is_none());
}

// ---- the record --------------------------------------------------------------------------

#[test]
fn resolve_drops_the_record_with_its_last_sub_and_does_nothing_while_put_away() {
    let _d = TempDataDir::new();
    let st = put_away_family();
    resolve(M, &["ro-busy".to_string()]).unwrap();
    assert_eq!(paused_subs(M).len(), 5, "while put away the list is the pause's own, untouched");

    reopen(&st, M).unwrap();
    resolve(M, &["ro-busy".to_string(), "ro-idle".to_string(), "ro-done".to_string()]).unwrap();
    assert_eq!(waiting_ids(), ["ro-gone", "ro-held"]);
    assert!(!is_paused_sub(M, "ro-busy") && is_paused_sub(M, "ro-held"));
    resolve(M, &["ro-gone".to_string(), "ro-held".to_string(), "unknown".to_string()]).unwrap();
    assert!(read(M).is_none(), "nothing waits, so the record goes");
    assert!(!is_gated(&st, "ro-held"));
}

#[test]
fn a_sub_started_after_the_reopen_is_not_held_by_the_old_pause() {
    let _d = TempDataDir::new();
    let st = put_away_family();
    st.registry.upsert_interactive("ro-new", &here(), "pa", AT);
    st.registry.set_subchat_of("ro-new", Some(M.into()));
    reopen(&st, M).unwrap();
    assert!(is_gated(&st, "ro-idle"), "a sub the pause froze stays held");
    assert!(!is_gated(&st, "ro-new"), "one the pause never saw is free");
}
