//! The put-away flow (`flow.rs`): what closing a project's main chat does, in order.
//! No child is spawned: `kill_and_wait_for_teardown` returns at once for a row with no
//! session, so the freeze marks are what these read.

use super::flow::{run, Refused, Timing};
use super::*;
use crate::daemon::session::new_session_map;
use crate::daemon::settings_cache::SettingsCache;
use crate::daemon::subchats::TempDataDir;
use crate::types::Settings;
use std::sync::Arc;
use std::time::Duration;

fn fast() -> Timing {
    Timing {
        poll: Duration::from_millis(5),
        quiet_wait: Duration::from_millis(400),
        compaction_wait: Duration::from_millis(400),
        sub_wait: Duration::from_millis(400),
        interrupt_wait: Duration::from_millis(100),
    }
}

/// A daemon whose project `pa` points at main chat `m1`, which has the subchats mode
/// on (the pointer reconcile the flow ends with clears a pointer without it) and three
/// subs: `idle`, `busy` (in a turn) and `done` (called its finish tool).
fn family() -> Arc<DaemonState> {
    let mut s = Settings::default();
    let (id, _) = crate::settings::upsert_project_for_cwd(&mut s, std::path::Path::new(env!("CARGO_MANIFEST_DIR")), "2026-11-12T00:00:00Z");
    s.projects.iter_mut().find(|p| p.id == id).unwrap().id = "pa".into();
    let st = DaemonState::new(new_session_map(), SettingsCache::new(s));
    let at = "2026-11-21T09:00:00Z";
    let cwd = std::path::Path::new(".");
    st.registry.upsert_interactive("m1", cwd, "pa", at);
    for sub in ["idle", "busy", "done"] {
        let id = format!("s-{sub}");
        st.registry.upsert_interactive(&id, cwd, "pa", at);
        st.registry.set_subchat_of(&id, Some("m1".into()));
        st.registry.set_name(&id, sub.to_string());
    }
    st.registry.set_subchat_finished("s-done", true);
    st.registry.set_busy("s-busy", true);
    crate::sessions::chat_config::set_subchats_on("m1", true);
    st.settings.set_project_main_chat("pa", Some("m1"));
    st
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

fn row(st: &DaemonState, id: &str) -> crate::types::Instance {
    st.registry.get(id).unwrap_or_else(|| panic!("{id} has a row"))
}

#[tokio::test]
async fn putting_a_main_chat_away_ends_nothing_and_keeps_the_pointer() {
    let _data = TempDataDir::new();
    let st = family();
    st.registry.set_busy("s-busy", false);

    run(&st, "m1", &fast()).await.expect("put away");

    let main = row(&st, "m1");
    assert!(main.ended_at.is_none() && main.end_reason.is_none(), "the chat is not closed");
    assert!(main.hidden_at.is_some() && is_hidden_family("m1"), "it is hidden and its family is gated");
    assert!(main.frozen, "its child is stopped, as a manual freeze");
    assert!(!main.closing);
    assert_eq!(st.settings.snapshot().projects[0].main_chat_id.as_deref(), Some("m1"), "the pointer is kept");
    // settle_family would end the finished sub and move the running ones to the sidebar.
    for sub in ["s-idle", "s-busy", "s-done"] {
        assert!(row(&st, sub).ended_at.is_none(), "{sub} is not ended");
        assert_eq!(row(&st, sub).subchat_of.as_deref(), Some("m1"), "{sub} stays under its main chat");
    }
}

#[tokio::test]
async fn the_record_names_each_sub_and_what_it_was_doing() {
    let _data = TempDataDir::new();
    let st = family();
    let flow = tokio::spawn({
        let st = st.clone();
        async move { run(&st, "m1", &fast()).await }
    });
    // The busy sub is mid-turn, so the put-away is still waiting on it: the record
    // already holds what was true when the pause began.
    assert!(until(|| is_hidden_family("m1")).await);
    let mut seen = paused_subs("m1");
    seen.sort_by(|a, b| a.sub_id.cmp(&b.sub_id));
    let shape: Vec<(&str, Prior, bool)> = seen.iter().map(|s| (s.sub_id.as_str(), s.prior, s.needs_continue)).collect();
    assert_eq!(
        shape,
        [("s-busy", Prior::Working, true), ("s-done", Prior::Finished, false), ("s-idle", Prior::Idle, false)]
    );
    assert!(seen.iter().all(|s| s.paused_at.is_some() && s.name.is_some()));
    st.registry.set_busy("s-busy", false);
    flow.await.unwrap().expect("put away");
}

#[tokio::test]
async fn a_sub_in_a_turn_is_paused_only_when_the_turn_ends() {
    let _data = TempDataDir::new();
    let st = family();
    let flow = tokio::spawn({
        let st = st.clone();
        async move { run(&st, "m1", &fast()).await }
    });
    assert!(until(|| row(&st, "s-idle").frozen).await, "the idle sub is paused at once");
    tokio::time::sleep(Duration::from_millis(60)).await;
    let busy = row(&st, "s-busy");
    assert!(!busy.frozen, "a turn in progress is never cut");
    assert!(!row(&st, "m1").frozen, "the chat's own child stops after its subs");
    assert!(!row(&st, "s-done").frozen, "a finished sub has no child to stop");

    st.registry.set_busy("s-busy", false);
    flow.await.unwrap().expect("put away");

    let busy = row(&st, "s-busy");
    assert!(busy.frozen, "paused at the turn end");
    assert!(busy.frozen_needs_continue, "a reopen tells it to carry on");
    assert!(!row(&st, "s-idle").frozen_needs_continue, "an idle sub has nothing to continue");
    assert!(row(&st, "m1").frozen);
}

#[tokio::test]
async fn the_gate_closes_before_the_chat_is_quiet() {
    let _data = TempDataDir::new();
    let st = family();
    st.registry.set_busy("s-busy", false);
    st.registry.set_busy("m1", true);
    let flow = tokio::spawn({
        let st = st.clone();
        async move { run(&st, "m1", &fast()).await }
    });
    // The record is the first write: while the chat still sits in its turn, nothing of
    // the family may start or wake.
    assert!(until(|| is_hidden_family("m1")).await, "the family record exists before the wait ends");
    assert!(row(&st, "m1").busy && !row(&st, "m1").frozen);
    assert!(is_gated(&st, "s-idle"), "a sub's start is already refused");
    st.registry.set_busy("m1", false);
    flow.await.unwrap().expect("put away");
}

#[tokio::test]
async fn a_chat_that_stays_in_a_turn_is_not_put_away_and_the_record_is_undone() {
    let _data = TempDataDir::new();
    let st = family();
    st.registry.set_busy("s-busy", false);
    st.registry.set_busy("m1", true);

    let outcome = run(&st, "m1", &Timing { quiet_wait: Duration::from_millis(40), ..fast() }).await;

    assert!(matches!(outcome, Err(Refused::NotQuiet)), "{outcome:?}");
    assert!(!is_hidden_family("m1"), "the gate is open again");
    assert!(read("m1").is_none(), "no record is left holding a family");
    let main = row(&st, "m1");
    assert!(main.hidden_at.is_none() && !main.frozen && main.ended_at.is_none());
    assert!(!row(&st, "s-idle").frozen, "nothing was paused");
}

#[tokio::test]
async fn a_second_put_away_that_gives_up_leaves_the_first_ones_record_alone() {
    let _data = TempDataDir::new();
    let st = family();
    st.registry.set_busy("s-busy", false);
    run(&st, "m1", &fast()).await.expect("first put away");
    // The first pass left its child running (its compaction had not finished): hidden,
    // not frozen, and still in a turn.
    st.registry.set_frozen("m1", false);
    st.registry.set_busy("m1", true);
    assert!(read("m1").is_some_and(|r| !r.subs.is_empty()), "control: the first pass wrote a record");

    let outcome = run(&st, "m1", &Timing { quiet_wait: Duration::from_millis(40), ..fast() }).await;

    assert!(matches!(outcome, Err(Refused::NotQuiet)), "{outcome:?}");
    assert!(is_hidden_family("m1"), "the first put-away still holds the gate");
    assert!(read("m1").is_some_and(|r| !r.subs.is_empty()), "and keeps its record of the paused subs");
    assert!(row(&st, "m1").hidden_at.is_some());
}

#[tokio::test]
async fn a_second_close_while_the_first_runs_starts_no_second_put_away() {
    let _data = TempDataDir::new();
    let st = family();
    st.registry.set_busy("s-busy", false);
    st.registry.set_busy("m1", true);
    let first = tokio::spawn({
        let st = st.clone();
        async move { run(&st, "m1", &fast()).await }
    });
    assert!(until(|| is_hidden_family("m1")).await);

    let second = run(&st, "m1", &fast()).await;

    assert!(matches!(second, Err(Refused::AlreadyRunning)), "{second:?}");
    st.registry.set_busy("m1", false);
    first.await.unwrap().expect("the first put-away finishes");
    // Once it is done and stopped, a third request has nothing to start.
    start(&st, "m1");
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert!(is_hidden_family("m1"));
}

#[tokio::test]
async fn only_an_open_project_main_chat_is_put_away() {
    let _data = TempDataDir::new();
    let st = family();
    st.registry.upsert_interactive("plain", std::path::Path::new("."), "pa", "2026-11-21T09:00:00Z");
    assert!(is_project_main_chat(&st, "m1"));
    assert!(!is_project_main_chat(&st, "plain"), "the pointer does not name it");
    assert!(!is_project_main_chat(&st, "s-idle"), "a sub is never put away on its own");
    assert!(!is_project_main_chat(&st, "ghost"));
    assert!(matches!(run(&st, "plain", &fast()).await, Err(Refused::NotAMainChat)));
    assert!(!is_hidden_family("plain"));

    // A respawn predecessor hands its family to the successor instead.
    st.registry.upsert_interactive("m2", std::path::Path::new("."), "pa", "2026-11-21T09:30:00Z");
    st.registry.set_successor_of("m2", "m1");
    assert!(!is_project_main_chat(&st, "m1"));

    st.registry.mark_ended("m1", crate::types::EndReason::Manual, "2026-11-21T10:00:00Z");
    assert!(!is_project_main_chat(&st, "m1"), "an ended chat has nothing to put away");
}

#[tokio::test]
async fn a_project_main_chat_cannot_respawn_but_any_other_chat_can() {
    let _data = TempDataDir::new();
    let st = family();
    st.registry.upsert_interactive("plain", std::path::Path::new("."), "pa", "2026-11-21T09:00:00Z");
    let refusal = refuse_respawn(&st, "m1").expect_err("the main chat does not respawn");
    assert!(refusal.contains("compacts it in place") && refusal.contains("close_session"), "{refusal}");
    assert!(refuse_respawn(&st, "plain").is_ok());
    assert!(refuse_respawn(&st, "s-idle").is_ok(), "a sub is refused by its own rule elsewhere");
}

#[tokio::test]
async fn pausing_now_stops_a_sub_in_a_turn_and_marks_it_to_continue() {
    let _data = TempDataDir::new();
    let st = family();

    pause_now(&st, "s-busy", &fast()).await;

    let sub = row(&st, "s-busy");
    assert!(sub.frozen, "the sub is stopped");
    assert!(sub.frozen_needs_continue, "its turn was cut, so a reopen continues it");
    assert!(!row(&st, "s-idle").frozen, "only the named sub");
}

// ---- subs on paired machines (pc-1806 step 4) ----------------------------------------------

use crate::daemon::subchats::remote::records::{self as remote_records, RemoteState, RemoteSub};

fn remote_sub(id: &str, machine: &str, state: RemoteState) {
    remote_records::record(RemoteSub { sub_id: id.into(), machine_id: machine.into(), main_id: "m1".into(), name: id.into(), state, ..Default::default() }).unwrap();
}

fn queued_methods(machine: &str) -> Vec<(String, String)> {
    crate::daemon::subchats::remote::outbox::pending_for(machine)
        .into_iter()
        .map(|e| (e.method, e.params["sub_id"].as_str().unwrap_or_default().to_string()))
        .collect()
}

#[tokio::test]
async fn putting_a_main_chat_away_queues_a_pause_for_every_live_sub_on_a_paired_machine() {
    let _data = TempDataDir::new();
    let st = family();
    st.registry.set_busy("s-busy", false);
    remote_sub("r-running", "mac-a", RemoteState::Running);
    remote_sub("r-held", "mac-a", RemoteState::Held);
    remote_sub("r-done", "mac-b", RemoteState::Finished);
    remote_sub("r-ended", "mac-a", RemoteState::Ended);

    run(&st, "m1", &fast()).await.expect("put away");

    let mut on_a = queued_methods("mac-a");
    on_a.sort();
    assert_eq!(on_a, vec![("sub_pause".to_string(), "r-held".to_string()), ("sub_pause".to_string(), "r-running".to_string())], "an ended sub is not paused");
    assert_eq!(queued_methods("mac-b"), vec![("sub_pause".to_string(), "r-done".to_string())], "each machine gets its own subs");
}

#[tokio::test]
async fn the_family_record_lists_the_remote_subs_with_their_machine() {
    let _data = TempDataDir::new();
    let st = family();
    st.registry.set_busy("s-busy", false);
    remote_sub("r-running", "mac-a", RemoteState::Running);

    run(&st, "m1", &fast()).await.expect("put away");

    let listed = paused_subs("m1");
    let remote = listed.iter().find(|s| s.sub_id == "r-running").expect("the remote sub is in the record");
    assert_eq!(remote.machine_id.as_deref(), Some("mac-a"), "a reopen's resume goes to this machine");
    assert_eq!(listed.iter().filter(|s| s.machine_id.is_none()).count(), 3, "the three local subs are listed as before");
}

#[tokio::test]
async fn a_put_away_that_is_undone_for_a_chat_that_never_went_quiet_queues_no_pause() {
    let _data = TempDataDir::new();
    let st = family();
    remote_sub("r-running", "mac-a", RemoteState::Running);
    st.registry.set_busy("m1", true);

    let refused = run(&st, "m1", &fast()).await;

    assert!(matches!(refused, Err(Refused::NotQuiet)));
    assert!(queued_methods("mac-a").is_empty(), "nothing was paused anywhere, so nothing is sent");
}
