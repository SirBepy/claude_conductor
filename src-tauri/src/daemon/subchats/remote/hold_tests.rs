//! A put-away family's visiting subs (pc-1806 step 4), the home's half: an event that
//! arrives while the main chat is away is kept, noted as seen and not drawn, and every kept
//! event is applied in order after the reopen.

use super::events::{CardEvent, Event, SubEvent};
use super::home::{apply, release_all_held_events, release_held_events, Outcome};
use super::records::{self, RemoteState, RemoteSub};
use crate::daemon::session::new_session_map;
use crate::daemon::settings_cache::SettingsCache;
use crate::daemon::state::DaemonState;
use crate::daemon::subchats::finish::FinishRecord;
use crate::daemon::subchats::{card_log, decisions, put_away, TempDataDir};
use crate::types::Settings;
use std::sync::Arc;

const NOW: &str = "2026-11-21T10:00:00Z";

fn state() -> Arc<DaemonState> {
    DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()))
}

/// A main chat row and one remote sub of it on "mac".
fn world(st: &DaemonState, tag: &str) -> (String, String) {
    let (main, sub) = (format!("{tag}-main"), format!("{tag}-sub"));
    st.registry.upsert_interactive(&main, std::path::Path::new("."), "proj", "2026-11-15T00:00:00Z");
    records::record(RemoteSub {
        sub_id: sub.clone(),
        machine_id: "mac".into(),
        main_id: main.clone(),
        name: "port".into(),
        state: RemoteState::Running,
        target: "main".into(),
        ..Default::default()
    })
    .unwrap();
    (main, sub)
}

fn finished(sub: &str, seq: u64) -> SubEvent {
    let record = FinishRecord { round: 1, verdict: "Built".into(), text: "Did the job".into(), decided: vec!["nothing".into()], ruled_out: vec!["nothing".into()], learned: vec!["nothing".into()], ..FinishRecord::default() };
    SubEvent { sub_id: sub.into(), seq, event: Event::Finished { round: 1, record, facts: Default::default(), model: "opus".into(), effort: "high".into() } }
}

fn answer_card(sub: &str, seq: u64, text: &str) -> SubEvent {
    let card = CardEvent { kind: "answer".into(), verdict: "Yes".into(), text: text.into(), ..Default::default() };
    SubEvent { sub_id: sub.into(), seq, event: Event::Card { card } }
}

fn drawn(main: &str) -> usize {
    card_log::read_in(&decisions::data_root().unwrap(), main).len()
}

fn away(st: &DaemonState, main: &str) {
    put_away::put_away(st, main, Vec::new(), NOW).unwrap();
}

#[test]
fn an_event_that_arrives_while_the_chat_is_put_away_is_kept_and_nothing_is_drawn() {
    let _data = TempDataDir::new();
    let st = state();
    let (main, sub) = world(&st, "h1");
    away(&st, &main);

    assert_eq!(apply(&st, "mac", finished(&sub, 10)).unwrap(), Outcome::Held);
    assert_eq!(apply(&st, "mac", answer_card(&sub, 11, "Ship it?")).unwrap(), Outcome::Held);

    assert_eq!(drawn(&main), 0, "no finish card and no answer card while the family is away");
    let rec = records::get(&sub).unwrap();
    assert_eq!((rec.state, rec.last_seq, rec.finished_round), (RemoteState::Running, 11, 0), "the numbers are noted, the finish is not applied");
    assert!(crate::daemon::subchats::finish::read_record_in(&decisions::data_root().unwrap(), &sub).is_none(), "no finish record stored yet");
    assert_eq!(super::held_events::read(&decisions::data_root().unwrap(), &main).unwrap().len(), 2, "both are kept");
}

#[test]
fn a_resend_of_a_kept_event_is_a_duplicate_and_adds_nothing() {
    let _data = TempDataDir::new();
    let st = state();
    let (main, sub) = world(&st, "h2");
    away(&st, &main);
    assert_eq!(apply(&st, "mac", answer_card(&sub, 5, "one")).unwrap(), Outcome::Held);
    assert_eq!(apply(&st, "mac", answer_card(&sub, 5, "one")).unwrap(), Outcome::Duplicate, "the number was noted");
    assert_eq!(super::held_events::read(&decisions::data_root().unwrap(), &main).unwrap().len(), 1);
}

#[test]
fn a_crash_between_keeping_and_noting_the_number_adds_no_second_copy() {
    let _data = TempDataDir::new();
    let st = state();
    let (main, sub) = world(&st, "h3");
    away(&st, &main);
    let root = decisions::data_root().unwrap();
    // The event was kept but its number never noted: the host sends it again.
    super::held_events::hold(&root, &main, "mac", &answer_card(&sub, 5, "one")).unwrap();
    assert_eq!(apply(&st, "mac", answer_card(&sub, 5, "one")).unwrap(), Outcome::Held);
    assert_eq!(super::held_events::read(&root, &main).unwrap().len(), 1, "kept once");
    assert_eq!(records::get(&sub).unwrap().last_seq, 5, "and noted now");
}

#[test]
fn the_kept_events_are_applied_in_order_after_the_reopen_and_not_before() {
    let _data = TempDataDir::new();
    let st = state();
    let (main, sub) = world(&st, "h4");
    away(&st, &main);
    apply(&st, "mac", answer_card(&sub, 10, "first question")).unwrap();
    apply(&st, "mac", finished(&sub, 11)).unwrap();

    assert_eq!(release_held_events(&st, &main), 0, "still away: nothing is released");
    assert_eq!(drawn(&main), 0);

    put_away::reopen(&st, &main).unwrap();
    assert_eq!(release_held_events(&st, &main), 2);

    let kinds: Vec<String> = card_log::read_in(&decisions::data_root().unwrap(), &main).into_iter().map(|c| c.kind).collect();
    let (answer_at, finish_at) = (kinds.iter().position(|k| k == "answer"), kinds.iter().position(|k| k == card_log::KIND_FINISH));
    assert!(answer_at.is_some() && finish_at.is_some() && answer_at < finish_at, "drawn in the order they arrived: {kinds:?}");
    assert_eq!(records::get(&sub).unwrap().state, RemoteState::Finished);
    assert!(super::held_events::read(&decisions::data_root().unwrap(), &main).unwrap().is_empty(), "the list is emptied");
    assert_eq!(release_held_events(&st, &main), 0, "a second pass finds nothing to apply twice");
}

#[test]
fn the_ticks_pass_releases_a_family_that_was_reopened_and_leaves_one_that_is_away() {
    let _data = TempDataDir::new();
    let st = state();
    let (away_main, away_sub) = world(&st, "h5a");
    let (open_main, open_sub) = world(&st, "h5b");
    away(&st, &away_main);
    away(&st, &open_main);
    apply(&st, "mac", answer_card(&away_sub, 1, "a")).unwrap();
    apply(&st, "mac", answer_card(&open_sub, 1, "b")).unwrap();
    put_away::reopen(&st, &open_main).unwrap();

    release_all_held_events(&st);

    assert_eq!(drawn(&open_main), 1, "the reopened family got its card");
    assert_eq!(drawn(&away_main), 0, "the family still away got nothing");
}

#[test]
fn an_event_for_a_family_that_is_not_away_is_applied_at_once() {
    let _data = TempDataDir::new();
    let st = state();
    let (main, sub) = world(&st, "h6");
    assert_eq!(apply(&st, "mac", answer_card(&sub, 1, "now")).unwrap(), Outcome::Applied);
    assert_eq!(drawn(&main), 1);
}

#[test]
fn a_full_list_refuses_the_event_with_an_internal_error_so_the_host_sends_it_again() {
    let _data = TempDataDir::new();
    let st = state();
    let (main, sub) = world(&st, "h7");
    away(&st, &main);
    let root = decisions::data_root().unwrap();
    for seq in 1..=super::held_events::MAX_HELD as u64 {
        assert_eq!(super::held_events::hold(&root, &main, "mac", &answer_card(&sub, seq, "x")).unwrap(), super::held_events::Kept::Kept);
    }
    let err = apply(&st, "mac", answer_card(&sub, 9_999, "one too many")).unwrap_err();
    assert_eq!(err.code, -32603, "an internal error is retried by the host's outbox, a refusal is dropped");
    assert_eq!(records::get(&sub).unwrap().last_seq, 0, "its number is not noted, so the resend is not a duplicate");
}

#[test]
fn a_kept_event_of_a_sub_this_machine_no_longer_hosts_is_dropped_not_retried() {
    let _data = TempDataDir::new();
    let st = state();
    let (main, sub) = world(&st, "h8");
    away(&st, &main);
    apply(&st, "mac", answer_card(&sub, 1, "gone")).unwrap();
    records::remove(&sub).unwrap();
    put_away::reopen(&st, &main).unwrap();
    assert_eq!(release_held_events(&st, &main), 0);
    assert!(super::held_events::read(&decisions::data_root().unwrap(), &main).unwrap().is_empty(), "nothing can apply it, so it does not stay");
    assert_eq!(drawn(&main), 0);
}

#[test]
fn a_live_event_after_the_reopen_waits_behind_the_kept_ones_instead_of_overtaking_them() {
    let _data = TempDataDir::new();
    let st = state();
    let (main, sub) = world(&st, "h11");
    away(&st, &main);
    apply(&st, "mac", answer_card(&sub, 1, "kept first")).unwrap();
    put_away::reopen(&st, &main).unwrap();

    // The tick has not run yet: the live event joins the list, nothing is drawn out of order.
    assert_eq!(apply(&st, "mac", answer_card(&sub, 2, "live")).unwrap(), Outcome::Held);
    assert_eq!(drawn(&main), 0);

    assert_eq!(release_held_events(&st, &main), 2);
    let texts: Vec<String> = card_log::read_in(&decisions::data_root().unwrap(), &main).into_iter().map(|c| c.text).collect();
    assert_eq!(texts.len(), 2);
    assert!(texts[0].contains("kept first") && texts[1].contains("live"), "in arrival order: {texts:?}");
    // The list is empty now, so the next event is applied at once.
    assert_eq!(apply(&st, "mac", answer_card(&sub, 3, "later")).unwrap(), Outcome::Applied);
}

#[test]
fn an_event_that_meets_the_pass_applying_the_same_sub_is_sent_again_not_called_a_duplicate() {
    let _data = TempDataDir::new();
    let st = state();
    let (_main, sub) = world(&st, "h12");
    let _busy = super::home::claim_for_test(&sub);

    let err = apply(&st, "mac", answer_card(&sub, 1, "x")).unwrap_err();

    assert_eq!(err.code, -32603, "an internal error is retried by the host, a duplicate would drop a real event");
    assert_eq!(records::get(&sub).unwrap().last_seq, 0);
}

#[test]
fn an_entry_this_build_cannot_read_survives_taking_another_off_the_list() {
    let _data = TempDataDir::new();
    let root = decisions::data_root().unwrap();
    let main = "h13-main";
    super::held_events::hold(&root, main, "mac", &answer_card("h13-a", 1, "a")).unwrap();
    super::held_events::hold(&root, main, "mac", &answer_card("h13-b", 2, "b")).unwrap();
    // A newer build wrote an entry whose event this build cannot decode.
    let path = root.join("subchats").join(format!("{}.remote-held.json", crate::daemon::subchats::decisions::file_stem(main)));
    let mut all: Vec<serde_json::Value> = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    all.push(serde_json::json!({ "machine_id": "mac", "req": null }));
    std::fs::write(&path, serde_json::to_string(&all).unwrap()).unwrap();

    super::held_events::remove(&root, main, "h13-a", 1).unwrap();

    let left = super::held_events::read(&root, main).unwrap();
    assert_eq!(left.len(), 2, "the other event and the unreadable entry");
    assert!(left.iter().any(|h| h.req.is_none()));
    assert!(super::held_events::any(&root, main), "an event is still waiting");
}

#[tokio::test]
async fn a_message_to_a_visiting_sub_of_a_put_away_chat_is_refused_before_any_call_to_the_host() {
    let _data = TempDataDir::new();
    let st = state();
    let (main, sub) = world(&st, "h10");
    away(&st, &main);
    let rec = records::get(&sub).unwrap();

    let err = super::actions::deliver(&st, &rec, "hello", false, None).await.unwrap_err();

    assert!(err.starts_with(put_away::REFUSAL_PREFIX), "{err}");
    assert!(crate::daemon::subchats::held::is_put_away_refusal(&err), "callers read it as nothing failed");
}

#[test]
fn a_family_put_away_again_while_releasing_keeps_the_rest_kept() {
    let _data = TempDataDir::new();
    let st = state();
    let (main, sub) = world(&st, "h9");
    away(&st, &main);
    apply(&st, "mac", answer_card(&sub, 1, "kept")).unwrap();
    put_away::reopen(&st, &main).unwrap();
    // Away again before the pass runs: the pass must see the gate.
    away(&st, &main);
    assert_eq!(release_held_events(&st, &main), 0);
    assert_eq!(super::held_events::read(&decisions::data_root().unwrap(), &main).unwrap().len(), 1);
}
