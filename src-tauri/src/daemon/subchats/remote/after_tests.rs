use super::super::test_support::*;
use super::*;
use crate::daemon::subchats::held::test_support::finish_record;
use crate::daemon::subchats::TempDataDir;
use std::path::Path;

const TS: &str = "2026-11-16T00:00:00Z";

fn state_with_main(main: &str) -> Arc<DaemonState> {
    let st = state_with_projects(&[]);
    st.registry.upsert_interactive(main, Path::new("."), "proj", TS);
    st
}

fn target(id: &str, main: &str, state: RemoteState) {
    records::record(RemoteSub { sub_id: id.into(), machine_id: "mac".into(), main_id: main.into(), name: id.into(), state, ..Default::default() }).unwrap();
}

/// A sub registered on its host and waiting for `after`.
fn waiting_for(id: &str, main: &str, after: &[&str]) {
    records::record(RemoteSub {
        sub_id: id.into(),
        machine_id: "mac".into(),
        main_id: main.into(),
        name: id.into(),
        state: RemoteState::Held,
        after: after.join("\n"),
        after_name: after.join("\n"),
        ..Default::default()
    })
    .unwrap();
}

/// A start that records the subs it was asked for and says `reply`.
fn starter(calls: &Arc<Mutex<Vec<String>>>, reply: Result<(), String>) -> impl Fn(Arc<DaemonState>, RemoteSub) -> std::future::Ready<Result<(), String>> {
    let calls = calls.clone();
    move |_, rec| {
        calls.lock().unwrap().push(rec.sub_id);
        std::future::ready(reply.clone())
    }
}

#[tokio::test]
async fn a_held_remote_sub_starts_when_every_target_finished_clean_and_not_before() {
    let _data = TempDataDir::new();
    let st = state_with_main("ah-main");
    target("ah-t1", "ah-main", RemoteState::Running);
    target("ah-t2", "ah-main", RemoteState::Finished);
    finish_record("ah-t2", "Done", None);
    waiting_for("ah-w", "ah-main", &["ah-t1", "ah-t2"]);
    let calls = Arc::new(Mutex::new(Vec::new()));

    release_ready(&st, starter(&calls, Ok(()))).await;
    assert!(calls.lock().unwrap().is_empty(), "one target still runs");
    assert_eq!(records::get("ah-w").unwrap().cleared, vec!["ah-t2".to_string()], "the clean one is remembered");

    target("ah-t1", "ah-main", RemoteState::Finished);
    finish_record("ah-t1", "Done", None);
    release_ready(&st, starter(&calls, Ok(()))).await;
    assert_eq!(calls.lock().unwrap().as_slice(), ["ah-w".to_string()]);
}

/// pc-1806 step 2: the home's pass over its remote subs records what finished but starts
/// nothing while the main chat is put away, and a reopen starts it.
#[tokio::test]
async fn a_remote_sub_of_a_put_away_main_chat_is_not_started_and_is_after_a_reopen() {
    let _data = TempDataDir::new();
    let st = state_with_main("ap-main");
    target("ap-t", "ap-main", RemoteState::Finished);
    finish_record("ap-t", "Done", None);
    waiting_for("ap-w", "ap-main", &["ap-t"]);
    crate::daemon::subchats::put_away::put_away(&st, "ap-main", Vec::new(), "2026-11-21T01:00:00Z").unwrap();
    let calls = Arc::new(Mutex::new(Vec::new()));

    release_ready(&st, starter(&calls, Ok(()))).await;
    assert!(calls.lock().unwrap().is_empty(), "nothing is started on the host");
    assert_eq!(records::get("ap-w").unwrap().state, RemoteState::Held, "the hold stays");
    assert_eq!(records::get("ap-w").unwrap().cleared, vec!["ap-t".to_string()], "the clean target is remembered");

    crate::daemon::subchats::put_away::reopen(&st, "ap-main").unwrap();
    release_ready(&st, starter(&calls, Ok(()))).await;
    assert_eq!(calls.lock().unwrap().as_slice(), ["ap-w".to_string()]);
}

/// pc-1806 step 2: the other doors into a remote start (retry, a "Start it anyway" answer,
/// the stall wake) refuse or stay quiet for a put-away family, and change nothing.
#[tokio::test]
async fn the_remote_start_doors_leave_a_put_away_sub_held_unparked_and_unreported() {
    let _data = TempDataDir::new();
    let st = state_with_main("ad-main");
    target("ad-t", "ad-main", RemoteState::Finished);
    finish_record("ad-t", "Done", None);
    waiting_for("ad-w", "ad-main", &["ad-t"]);
    crate::daemon::subchats::put_away::put_away(&st, "ad-main", Vec::new(), "2026-11-21T01:00:00Z").unwrap();
    let rec = records::get("ad-w").unwrap();

    let started = actions::start(&st, &rec).await.err().expect("refused");
    assert!(started.starts_with(crate::daemon::subchats::put_away::REFUSAL_PREFIX), "{started}");
    let retried = retry(&st, &rec).await.err().expect("refused");
    assert!(retried.starts_with(crate::daemon::subchats::put_away::REFUSAL_PREFIX), "{retried}");
    let direct = actions::retry(&st, &rec).await.err().expect("refused");
    assert!(direct.starts_with(crate::daemon::subchats::put_away::REFUSAL_PREFIX), "{direct}");
    // Parked first: a door that unparked before refusing would show here.
    set_parked("ad-w", true);
    apply_answer(&st, "ad-w", CardAnswer::Picked(held::START_ANYWAY.into())).await;
    assert!(parked("ad-w"), "the answer left the park alone");
    let now = crate::daemon::subchats::queued::start_now(&st, "ad-w").await.err().expect("refused");
    assert!(now.starts_with(crate::daemon::subchats::put_away::REFUSAL_PREFIX), "{now}");
    assert!(parked("ad-w"), "Start now left the park alone");
    // Unparked so the stall pass below looks at it.
    set_parked("ad-w", false);

    assert_eq!(records::get("ad-w").unwrap().state, RemoteState::Held, "the hold stays");
    assert!(plumbing::current("ad-w").is_none(), "and files no problem");
    let t0 = Utc::now();
    assert!(stalled_tick(&st, t0).is_empty());
    assert!(stalled_tick(&st, t0 + chrono::Duration::minutes(30)).is_empty(), "a withheld start is not a stall");
}

/// A target that finished clean and was closed afterwards while a sibling still runs is
/// not "ended before it finished": the cleared mark is what says so.
#[tokio::test]
async fn a_target_that_finished_clean_and_was_closed_later_does_not_block_the_wait() {
    let _data = TempDataDir::new();
    let st = state_with_main("ac-main");
    target("ac-t1", "ac-main", RemoteState::Finished);
    finish_record("ac-t1", "Done", None);
    target("ac-t2", "ac-main", RemoteState::Running);
    waiting_for("ac-w", "ac-main", &["ac-t1", "ac-t2"]);
    let calls = Arc::new(Mutex::new(Vec::new()));
    release_ready(&st, starter(&calls, Ok(()))).await;
    target("ac-t1", "ac-main", RemoteState::Ended);
    release_ready(&st, starter(&calls, Ok(()))).await;
    assert!(calls.lock().unwrap().is_empty(), "still pending on the sibling, and not blocked by the closed one");
    assert!(st.list_prompts().await.iter().all(|p| p["payload"]["card_kind"] != held::CARD_KIND));
}

#[tokio::test]
async fn a_target_that_ended_blocked_asks_joe_once_and_starts_nothing() {
    let _data = TempDataDir::new();
    let st = state_with_main("ab-main");
    target("ab-t", "ab-main", RemoteState::Finished);
    finish_record("ab-t", "Blocked on the design", None);
    waiting_for("ab-w", "ab-main", &["ab-t"]);
    let calls = Arc::new(Mutex::new(Vec::new()));
    release_ready(&st, starter(&calls, Ok(()))).await;
    release_ready(&st, starter(&calls, Ok(()))).await;
    assert!(calls.lock().unwrap().is_empty());
    let cards: Vec<_> = st.list_prompts().await.into_iter().filter(|p| p["payload"]["card_kind"] == held::CARD_KIND).collect();
    assert_eq!(cards.len(), 1, "asked once, not every pass");
    let payload = &cards[0]["payload"];
    assert_eq!((payload["sub_id"].as_str(), payload["display_session_id"].as_str()), (Some("ab-w"), Some("ab-main")));
    assert!(payload["questions"][0]["question"].as_str().unwrap().contains("ab-t"), "{payload}");
    // Skipping parks it: no more passes start it or ask again until a restart or a retry.
    apply_answer(&st, "ab-w", CardAnswer::Skipped).await;
    assert!(parked("ab-w"));
    set_parked("ab-w", false);
}

#[tokio::test]
async fn a_refused_start_is_plumbing_for_the_main_chat_and_a_silent_host_is_retried() {
    let _data = TempDataDir::new();
    let st = state_with_main("af-main");
    target("af-t", "af-main", RemoteState::Finished);
    finish_record("af-t", "Done", None);
    waiting_for("af-w", "af-main", &["af-t"]);
    let calls = Arc::new(Mutex::new(Vec::new()));

    // The host does not answer: nothing is said, and the next pass tries again.
    let silent = Err(format!("Mac {}timed out). The sub keeps running there: try again when it is back.", actions::UNREACHABLE));
    release_ready(&st, starter(&calls, silent)).await;
    assert!(!parked("af-w"));
    assert!(plumbing::current("af-w").is_none());

    // The host refuses: the main chat is told, and the sub waits for `subchat retry`.
    release_ready(&st, starter(&calls, Err("no worktree".into()))).await;
    assert_eq!(calls.lock().unwrap().len(), 2);
    assert!(parked("af-w"));
    assert_eq!(plumbing::current("af-w").map(|p| p.problem), Some(Problem::CouldNotStart));
    release_ready(&st, starter(&calls, Ok(()))).await;
    assert_eq!(calls.lock().unwrap().len(), 2, "parked: not tried again by the pass");
    set_parked("af-w", false);
}

/// A sub that waited five minutes with nothing in its way wakes its main chat once.
#[tokio::test]
async fn a_remote_sub_that_waits_with_nothing_in_its_way_wakes_the_main_chat_once() {
    let _data = TempDataDir::new();
    let st = state_with_main("aw-main");
    target("aw-t", "aw-main", RemoteState::Finished);
    finish_record("aw-t", "Done", None);
    waiting_for("aw-w", "aw-main", &["aw-t"]);
    let t0 = Utc::now();
    assert!(stalled_tick(&st, t0).is_empty(), "just seen");
    assert!(stalled_tick(&st, t0 + chrono::Duration::minutes(4)).is_empty());
    assert_eq!(stalled_tick(&st, t0 + chrono::Duration::minutes(6)), ["aw-w".to_string()]);
    assert!(stalled_tick(&st, t0 + chrono::Duration::minutes(9)).is_empty(), "once");
    let text = st.repo_channel_wakes.lock().unwrap().get("aw-main").unwrap()[0].text.clone();
    assert!(text.contains("has not started") && text.contains("aw-w"), "{text}");

    // A sub whose target still runs is waiting as it should.
    target("aw-t2", "aw-main", RemoteState::Running);
    waiting_for("aw-w2", "aw-main", &["aw-t2"]);
    assert!(stalled_tick(&st, t0 + chrono::Duration::minutes(30)).iter().all(|s| s != "aw-w2"));
}

/// A target whose commits are still being fetched and merged has not landed: a sub that
/// started now would be caught up to a target without them.
#[test]
fn a_target_whose_landing_is_running_is_not_done_and_a_finish_numbered_after_the_end_still_counts() {
    let _data = TempDataDir::new();
    target("al-t", "al-main", RemoteState::Finished);
    finish_record("al-t", "Done", None);
    let st = state_with_main("al-main");
    assert_eq!(held::after_state(&st, "al-t"), AfterState::Clean);
    {
        let _landing = crate::daemon::subchats::merge_followup::claim_landing("al-t").expect("free");
        assert_eq!(held::after_state(&st, "al-t"), AfterState::Pending, "landing");
    }
    assert_eq!(held::after_state(&st, "al-t"), AfterState::Clean, "landed");

    // The host numbers the end of a chat before a finish it builds on a thread: ended, but it finished.
    records::update("al-t", |r| {
        r.state = RemoteState::Ended;
        r.finished_after_end = true;
    })
    .unwrap();
    assert_eq!(held::after_state(&st, "al-t"), AfterState::Clean);
    records::update("al-t", |r| r.finished_after_end = false).unwrap();
    assert!(matches!(held::after_state(&st, "al-t"), AfterState::Blocked(_)), "ended on purpose");
}

/// A pass never starts a sub another caller (the menu, `subchat retry`) is starting.
#[tokio::test]
async fn a_sub_someone_else_is_starting_is_left_to_them() {
    let _data = TempDataDir::new();
    let st = state_with_main("as-main");
    target("as-t", "as-main", RemoteState::Finished);
    finish_record("as-t", "Done", None);
    waiting_for("as-w", "as-main", &["as-t"]);
    let calls = Arc::new(Mutex::new(Vec::new()));
    let mine = claim("as-w").expect("free");
    release_ready(&st, starter(&calls, Ok(()))).await;
    assert!(calls.lock().unwrap().is_empty());
    assert!(claim("as-w").is_none(), "taken once");
    drop(mine);
}

/// The pass works from a snapshot: a sub whose start finished since (another caller took it
/// while the pass started the one before) is read again and left alone.
#[tokio::test]
async fn a_sub_started_since_the_snapshot_is_not_started_again() {
    let _data = TempDataDir::new();
    let st = state_with_main("ar-main");
    target("ar-t", "ar-main", RemoteState::Finished);
    finish_record("ar-t", "Done", None);
    waiting_for("ar-w1", "ar-main", &["ar-t"]);
    waiting_for("ar-w2", "ar-main", &["ar-t"]);
    let calls = Arc::new(Mutex::new(Vec::new()));
    let seen = calls.clone();
    // Starting the first sub is what starts the second one elsewhere.
    let start = move |_: Arc<DaemonState>, rec: RemoteSub| {
        seen.lock().unwrap().push(rec.sub_id.clone());
        records::update_state("ar-w2", RemoteState::Running).unwrap();
        std::future::ready(Ok(()))
    };
    release_ready(&st, start).await;
    assert_eq!(calls.lock().unwrap().as_slice(), ["ar-w1".to_string()]);
}

#[test]
fn only_a_held_sub_with_something_to_wait_for_is_waiting() {
    let _data = TempDataDir::new();
    target("ao-run", "ao-main", RemoteState::Running);
    waiting_for("ao-held", "ao-main", &["ao-run"]);
    // Registered on its host and held without an `after`: nothing here starts it.
    records::record(RemoteSub { sub_id: "ao-bare".into(), machine_id: "mac".into(), main_id: "ao-main".into(), state: RemoteState::Held, ..Default::default() }).unwrap();
    let ids: Vec<String> = waiting().into_iter().map(|r| r.sub_id).collect();
    assert_eq!(ids, ["ao-held".to_string()]);
}
