use super::*;
use crate::daemon::subchats::finish::FinishRecord;
use crate::daemon::session::new_session_map;
use crate::daemon::settings_cache::SettingsCache;
use crate::daemon::subchats::git::test_repo::{git as run, init, transcript};
use crate::types::Settings;

fn state() -> Arc<DaemonState> {
    DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()))
}

/// A main chat and `names` subs, all in `cwd`. Ids carry `tag` so the
/// process-wide tables never mix two tests up.
fn world(st: &DaemonState, tag: &str, cwd: &Path, names: &[&str]) -> (String, Vec<String>) {
    let main = format!("{tag}-main");
    st.registry.upsert_interactive(&main, cwd, "proj", "2026-11-05T00:00:00Z");
    let subs = names
        .iter()
        .map(|n| {
            let id = format!("{tag}-{n}");
            st.registry.upsert_interactive(&id, cwd, "proj", "2026-11-05T00:00:00Z");
            st.registry.set_subchat_of(&id, Some(main.clone()));
            st.registry.set_name(&id, (*n).to_string());
            id
        })
        .collect();
    (main, subs)
}

fn record(root: &Path, sub: &str, round: u32, verdict: &str) {
    let rec = FinishRecord {
        sub_id: sub.into(),
        parent_id: None,
        round,
        verdict: verdict.into(),
        text: "Header done".into(),
        done: vec!["header".into()],
        decided: vec!["nothing".into()],
        ruled_out: vec!["nothing".into()],
        ..FinishRecord::default()
    };
    let dir = root.join("subchats");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join(format!("{sub}.finish.json")), serde_json::to_string(&rec).unwrap()).unwrap();
}

fn finish_sub(st: &Arc<DaemonState>, root: &Path, sub: &str, round: u32) -> Vec<CardEntry> {
    finish_sub_with(st, root, sub, round, None)
}

fn finish_sub_with(st: &Arc<DaemonState>, root: &Path, sub: &str, round: u32, transcript: Option<PathBuf>) -> Vec<CardEntry> {
    record(root, sub, round, "Built, not pushed");
    st.registry.set_subchat_finished(sub, true);
    draw_finish_at(root, st, sub, transcript)
}

#[test]
fn a_finish_that_answers_a_question_carries_it_on_its_card_and_one_that_does_not_has_no_key() {
    let _data = crate::daemon::subchats::TempDataDir::new();
    let st = state();
    let (_main, subs) = world(&st, "ansq", Path::new("."), &["ime", "header"]);
    let root = tempfile::tempdir().unwrap();
    let dir = root.path().join("subchats");
    std::fs::create_dir_all(&dir).unwrap();
    let rec = FinishRecord {
        sub_id: subs[0].clone(),
        round: 1,
        verdict: "The composer grabs focus on open".into(),
        question: Some("Why does Gboard swipe fail?".into()),
        ..FinishRecord::default()
    };
    std::fs::write(dir.join(format!("{}.finish.json", subs[0])), serde_json::to_string(&rec).unwrap()).unwrap();
    st.registry.set_subchat_finished(&subs[0], true);
    let drawn = draw_finish_at(root.path(), &st, &subs[0], None);
    let card = drawn.iter().find(|e| e.kind == KIND_FINISH).unwrap();
    assert_eq!(card.question.as_deref(), Some("Why does Gboard swipe fail?"));

    let plain = finish_sub(&st, root.path(), &subs[1], 1);
    let card = plain.iter().find(|e| e.kind == KIND_FINISH).unwrap();
    assert!(card.question.is_none());
    let json = serde_json::to_value(card).unwrap();
    assert!(json.get("question").is_none(), "a job's finish is not drawn as an answer: {json}");
}

#[test]
fn a_finish_appends_a_card_with_facts_from_code_and_broadcasts_it() {
    let _data = crate::daemon::subchats::TempDataDir::new();
    let (dir, repo) = init();
    let st = state();
    let (main, subs) = world(&st, "fin", &repo, &["header"]);
    let base = crate::daemon::subchats::git::head(&repo).unwrap();
    crate::daemon::subchats::store_sub_brief(&subs[0], &main);
    let mut brief = crate::sessions::chat_config::get(&subs[0]).unwrap().subchat.unwrap();
    brief.git_head_at_spawn = Some(base);
    crate::sessions::chat_config::set_subchat(&subs[0], Some(brief));
    std::fs::write(repo.join("h.txt"), "h\n").unwrap();
    run(&repo, &["add", "h.txt"]);
    run(&repo, &["commit", "-q", "-m", "h"]);
    let tp = transcript(dir.path(), &[("Write", &repo.join("h.txt"))]);
    let root = tempfile::tempdir().unwrap();
    let mut rx = st.notifier.subscribe();

    st.registry.set_model_effort(&subs[0], "sonnet", "high");
    record(root.path(), &subs[0], 1, "Built, not pushed");
    st.registry.set_subchat_finished(&subs[0], true);
    let drawn = draw_finish_at(root.path(), &st, &subs[0], Some(tp));

    let finish = drawn.iter().find(|e| e.kind == KIND_FINISH).expect("finish card drawn");
    assert_eq!(finish.parent_id, main);
    assert_eq!(finish.sub_name.as_deref(), Some("header"));
    assert_eq!((finish.model.as_deref(), finish.effort.as_deref()), (Some("sonnet"), Some("high")), "the tier shows on the card");
    assert_eq!(finish.verdict, "Built, not pushed");
    let facts = finish.facts.as_ref().unwrap();
    assert_eq!(facts.commits, Some(1), "from git, not from the sub's words");
    assert_eq!(facts.since, facts::SINCE_SPAWN);
    assert_eq!(facts.test.state, "unknown", "no test run in the transcript is unknown, not passed");
    let stored = read_in(root.path(), &main);
    assert_eq!(stored.iter().filter(|e| e.kind == KIND_FINISH).count(), 1);
    let frame = rx.try_recv().expect("the card was broadcast");
    assert_eq!(frame["method"], NOTIFY);
    assert_eq!(frame["params"]["session_id"], main.as_str());
    assert_eq!(frame["params"]["card"]["sub_name"], "header");
}

/// A repo tracking a bare remote, with a gate sub and a plain sub of the same main chat.
fn gate_world(tag: &str) -> (tempfile::TempDir, std::path::PathBuf, tempfile::TempDir, Arc<DaemonState>, String, String) {
    let (dir, repo) = init();
    let remote = tempfile::tempdir().unwrap();
    run(remote.path(), &["init", "-q", "--bare"]);
    run(&repo, &["remote", "add", "origin", &remote.path().to_string_lossy()]);
    run(&repo, &["push", "-q", "-u", "origin", "HEAD:refs/heads/main"]);
    std::fs::write(repo.join("w.txt"), "unpushed\n").unwrap();
    run(&repo, &["add", "w.txt"]);
    run(&repo, &["commit", "-q", "-m", "w"]);
    let st = state();
    let (main, subs) = world(&st, tag, &repo, &["gate", "plain"]);
    let mut gate = crate::daemon::subchats::brief::gate_brief(Some("push"), &main).unwrap();
    gate.upstream_at_spawn = crate::daemon::subchats::git::upstream(&repo);
    gate.git_head_at_spawn = crate::daemon::subchats::git::head(&repo);
    crate::sessions::chat_config::set_subchat(&subs[0], Some(gate));
    crate::daemon::subchats::store_sub_brief(&subs[1], &main);
    let mut plain = crate::sessions::chat_config::get(&subs[1]).unwrap().subchat.unwrap();
    plain.git_head_at_spawn = crate::daemon::subchats::git::head(&repo);
    crate::sessions::chat_config::set_subchat(&subs[1], Some(plain));
    (dir, repo, remote, st, subs[0].clone(), subs[1].clone())
}

fn finish_facts(st: &Arc<DaemonState>, sub: &str) -> Facts {
    let root = tempfile::tempdir().unwrap();
    record(root.path(), sub, 1, "Pushed");
    st.registry.set_subchat_finished(sub, true);
    let drawn = draw_finish_at(root.path(), st, sub, None);
    drawn.into_iter().find(|e| e.kind == KIND_FINISH).expect("finish card").facts.expect("facts")
}

#[test]
fn a_gate_finish_card_says_pushed_from_git_and_a_plain_sub_beside_it_does_not() {
    let _data = crate::daemon::subchats::TempDataDir::new();
    let (_dir, repo, _remote, st, gate, plain) = gate_world("gp");
    // The gate ended without pushing: the upstream is where it started.
    assert_eq!(finish_facts(&st, &gate).pushed, Some(false));
    run(&repo, &["push", "-q", "origin", "HEAD:refs/heads/main"]);
    st.registry.set_subchat_finished(&gate, false);
    assert_eq!(finish_facts(&st, &gate).pushed, Some(true), "the upstream moved and holds HEAD");
    // The plain sub made no commit of its own since spawn, so it makes no push claim at all.
    assert_eq!(finish_facts(&st, &plain).pushed, None);
}

#[test]
fn drawing_the_same_report_twice_stores_one_card() {
    let st = state();
    let root = tempfile::tempdir().unwrap();
    let (main, subs) = world(&st, "dup", Path::new("."), &["a"]);
    record(root.path(), &subs[0], 1, "v");
    st.registry.set_subchat_finished(&subs[0], true);
    draw_finish_at(root.path(), &st, &subs[0], None);
    assert!(draw_finish_at(root.path(), &st, &subs[0], None).is_empty(), "nothing new the second time");
    assert_eq!(read_in(root.path(), &main).iter().filter(|e| e.kind == KIND_FINISH).count(), 1);
}

#[test]
fn a_blocker_from_a_sub_appends_a_card_and_a_progress_message_does_not() {
    let st = state();
    let root = tempfile::tempdir().unwrap();
    let (main, subs) = world(&st, "blk", Path::new("."), &["header"]);
    let drawn = on_blocker_at(
        root.path(),
        &st,
        &subs[0],
        BlockerCard { text: "The design file is missing".into(), verdict: "Blocked on the design".into(), tone: Some("bad".into()), points: vec![] },
    )
    .expect("a sub's blocker is drawn");
    assert_eq!((drawn.kind.as_str(), drawn.sub_name.as_deref()), (KIND_BLOCKER, Some("header")));
    assert!(drawn.facts.is_none(), "a blocker is the sub's own word, so it carries no facts");
    assert_eq!(read_in(root.path(), &main).len(), 1);
    // A chat that is not a sub has no main chat to draw into.
    st.registry.upsert_interactive("blk-plain", Path::new("."), "proj", "2026-11-05T00:00:00Z");
    assert!(on_blocker_at(root.path(), &st, "blk-plain", BlockerCard::default()).is_none());
    assert_eq!(read_in(root.path(), "blk-plain").len(), 0);
}

#[test]
fn a_blocker_never_carries_the_good_tone_the_dashboard_reads_as_a_success_notice() {
    let st = state();
    let root = tempfile::tempdir().unwrap();
    let (_main, subs) = world(&st, "tone", Path::new("."), &["a"]);
    let card = |tone: &str| BlockerCard { text: "t".into(), verdict: "v".into(), tone: Some(tone.into()), points: vec![] };
    assert_eq!(on_blocker_at(root.path(), &st, &subs[0], card("good")).unwrap().tone, None, "the card stays, the colour goes");
    assert_eq!(on_blocker_at(root.path(), &st, &subs[0], card("bad")).unwrap().tone.as_deref(), Some("bad"));
}

#[test]
fn retracting_takes_down_only_the_apps_blockers_of_that_sub_and_announces_each() {
    let st = state();
    let root = tempfile::tempdir().unwrap();
    let (main, subs) = world(&st, "ret", Path::new("."), &["a", "b"]);
    let card = |t: &str, v: &str| BlockerCard { text: t.into(), verdict: v.into(), tone: Some("bad".into()), points: vec![] };
    let sent = on_blocker_at(root.path(), &st, &subs[0], card("a-sent", "Needs a key")).unwrap();
    assert!(!sent.by_app);
    // A card an older build drew has no `by_app`, only its landing verdict.
    // Every refusal wording of `worktree.rs` and `remote/land.rs` is listed, so a
    // deleted arm of `is_legacy_landing_card` turns this red.
    let legacy = [
        ("Its commits conflict with master. Nothing was merged, and its worktree keeps every commit.", "Merge conflict"),
        ("Its commits conflict with master. Nothing was merged, and the commits are safe on its branch on Mac.", "Merge conflict"),
        ("Its worktree folder C:/w is gone, so its commits could not be merged.", "Not merged"),
        ("Branch sub/x no longer exists, so there is nothing to merge.", "Not merged"),
        ("The branch master no longer exists here.", "Not merged"),
        ("The checkout C:/p is gone, so the commits could not be merged.", "Not merged"),
        ("The main checkout is on branch dev now, but this sub started from master.", "Not merged"),
        ("The main checkout is not on master any more, so nothing was merged.", "Not merged"),
        ("The main checkout has uncommitted changes in files this sub also changed.", "Not merged"),
        ("master kept moving while the merge ran.", "Not merged"),
        ("master kept moving while the merge ran. Merge again.", "Not merged"),
        ("master has moved too far from where the sub started for a machine link to carry it: x", "Not merged"),
        ("The other machine did not name a commit for the sub's branch.", "Not merged"),
        ("The bundle from the other machine could not be read: x", "Not merged"),
        ("The bundle's head is not the commit the other machine named, so nothing was merged.", "Not merged"),
        ("The sub's commits could not be imported: x", "Not merged"),
        ("The sub's branch does not build on the target tip that was sent, so nothing was merged.", "Not merged"),
        ("Mac would not bring the sub's branch up to date: x", "Not merged"),
        ("Mac would not hand over the sub's branch: x", "Not merged"),
        ("Its branch could not be brought up to date with master: x. Nothing was merged.", "Not merged"),
        ("git refused to fast-forward master: x. Nothing was changed there.", "Not merged"),
        ("The machine that hosts this sub is not paired any more, so its commits could not be fetched.", "Not merged"),
        ("The merge did not run: task 7 panicked with message x", "Not merged"),
        ("Mac could not be reached (timed out), so the commits could not be fetched. They are safe.", "Not merged (unreachable)"),
    ];
    for (text, verdict) in legacy {
        on_blocker_at(root.path(), &st, &subs[0], card(text, verdict)).unwrap();
    }
    // A sub that sends a blocker under the same verdict is still speaking for itself,
    // even when its words start like the daemon's.
    let own = ["a-own-not-merged", "The checkout is dirty, I could not merge", "The merge did not run: tests failed", "The branch is broken", "The machine is slow"];
    for text in own {
        on_blocker_at(root.path(), &st, &subs[0], card(text, "Not merged")).unwrap();
    }
    on_app_blocker(&st, &subs[0], Some(root.path()), card("a1", "Worktree kept")).unwrap();
    on_app_blocker(&st, &subs[0], Some(root.path()), card("a2", "Worktree kept")).unwrap();
    on_app_blocker(&st, &subs[1], Some(root.path()), card("b1", "Worktree kept")).unwrap();
    record(root.path(), &subs[0], 1, "Done");
    st.registry.set_subchat_finished(&subs[0], true);
    draw_finish_at(root.path(), &st, &subs[0], None);
    let mut rx = st.notifier.subscribe();

    assert_eq!(retract_blockers_in(root.path(), &st, &main, &subs[0]), 2 + legacy.len(), "the two app cards and every old landing card");
    assert_eq!(retract_blockers_in(root.path(), &st, &main, &subs[0]), 0, "once is enough");

    let log = read_in(root.path(), &main);
    let open: Vec<_> = log.iter().filter(|e| e.kind == KIND_BLOCKER && !e.retracted).map(|e| e.text.as_str()).collect();
    let mut want = vec!["a-sent"];
    want.extend(own);
    want.push("b1");
    assert_eq!(open, want, "the sub's own blockers, even under a landing verdict, and another sub's stay");
    assert!(log.iter().any(|e| e.kind == KIND_FINISH), "the finish card is untouched");
    let frame = rx.try_recv().expect("the change was announced");
    assert_eq!((frame["method"].as_str(), frame["params"]["replace"].as_bool(), frame["params"]["card"]["retracted"].as_bool()), (Some(NOTIFY), Some(true), Some(true)));
}

#[test]
fn a_sub_answer_without_its_own_question_takes_the_handed_one_and_spends_it() {
    let _data = crate::daemon::subchats::TempDataDir::new();
    let st = state();
    let root = tempfile::tempdir().unwrap();
    let (main, subs) = world(&st, "ansx", Path::new("."), &["a", "b"]);
    for s in &subs {
        crate::daemon::subchats::store_sub_brief(s, &main);
        let mut b = crate::sessions::chat_config::get(s).unwrap().subchat.unwrap();
        b.question = Some("Why X?".into());
        crate::sessions::chat_config::set_subchat(s, Some(b));
    }
    let ans = |sub: &str, question: Option<&str>, kind: &str| {
        on_answer_in(
            root.path(),
            &st,
            &main,
            sub,
            AnswerCard { kind: kind.into(), text: "t".into(), verdict: "v".into(), question: question.map(Into::into), ..AnswerCard::default() },
        )
        .expect("drawn")
    };
    let card = ans(&subs[0], None, KIND_ANSWER);
    assert_eq!((card.kind.as_str(), card.question.as_deref()), (KIND_ANSWER, Some("Why X?")));
    let brief = crate::sessions::chat_config::get(&subs[0]).unwrap().subchat.unwrap();
    assert!(brief.question.is_none(), "spent, so the sub's finish is not a second answer to it");
    // The sub's own wording wins, and the handed question is spent all the same.
    let card = ans(&subs[1], Some("Own words?"), KIND_RATING);
    assert_eq!((card.kind.as_str(), card.question.as_deref()), (KIND_RATING, Some("Own words?")));
    assert!(crate::sessions::chat_config::get(&subs[1]).unwrap().subchat.unwrap().question.is_none());
    // No question anywhere: the card carries none, and an old line without the new fields still loads.
    let card = ans(&subs[0], None, KIND_ANSWER);
    assert!(card.question.is_none());
    let old: CardEntry = serde_json::from_str(r#"{"id":"x","kind":"blocker"}"#).unwrap();
    assert!(old.details.is_empty() && !old.retracted);
}

/// A follow-up question held mid-turn sits on the brief, but its text has not reached the
/// sub: an answer the sub sends this turn is about the earlier work, so it must not carry
/// the question or spend it (the round that gets the held text answers it, as a finish does).
#[test]
fn an_answer_sent_while_the_question_text_is_still_held_leaves_the_question_for_its_round() {
    let _data = crate::daemon::subchats::TempDataDir::new();
    let st = state();
    let root = tempfile::tempdir().unwrap();
    let (main, subs) = world(&st, "anshold", Path::new("."), &["a"]);
    let sub = &subs[0];
    crate::daemon::subchats::store_sub_brief(sub, &main);
    let mut b = crate::sessions::chat_config::get(sub).unwrap().subchat.unwrap();
    b.question = Some("Is the design too far behind?".into());
    crate::sessions::chat_config::set_subchat(sub, Some(b));
    crate::daemon::subchats::followup::add(sub, &format!("also the footer\n\n{}Is the design too far behind?", crate::daemon::subchats::brief::QUESTION_JOB));
    let answer = || AnswerCard { kind: KIND_ANSWER.into(), text: "t".into(), verdict: "v".into(), ..AnswerCard::default() };
    let card = on_answer_in(root.path(), &st, &main, sub, answer()).expect("drawn");
    assert!(card.question.is_none(), "this answer is about the earlier work");
    let brief = crate::sessions::chat_config::get(sub).unwrap().subchat.unwrap();
    assert_eq!(brief.question.as_deref(), Some("Is the design too far behind?"), "kept for the round the held text starts");
    // The held text reaches the sub: its next answer carries the question and spends it.
    crate::daemon::subchats::followup::take_all_in(&crate::daemon::subchats::decisions::data_root().unwrap(), sub);
    let card = on_answer_in(root.path(), &st, &main, sub, answer()).expect("drawn");
    assert_eq!(card.question.as_deref(), Some("Is the design too far behind?"));
    assert!(crate::sessions::chat_config::get(sub).unwrap().subchat.unwrap().question.is_none());
}

#[test]
fn an_update_rewrites_only_its_own_line_and_keeps_a_line_this_build_cannot_read() {
    let _data = crate::daemon::subchats::TempDataDir::new();
    let st = state();
    let root = tempfile::tempdir().unwrap();
    let (main, subs) = world(&st, "upd", Path::new("."), &["a"]);
    let card = on_answer_in(root.path(), &st, &main, &subs[0], AnswerCard { kind: KIND_ANSWER.into(), text: "old".into(), verdict: "v".into(), ..AnswerCard::default() }).unwrap();
    note_send(&st, &subs[0], Some(card.id.clone()));
    let path = log_path(root.path(), &main).unwrap();
    let mut raw = std::fs::read_to_string(&path).unwrap();
    raw.push_str("{this line is torn\n");
    std::fs::write(&path, raw).unwrap();
    let upd = |ordinal, text: &str| on_answer_update_in(
        root.path(), &st, &main, &subs[0],
        AnswerUpdate { text: Some(text.into()), ordinal, ..AnswerUpdate::default() },
    );
    assert!(upd(2, "no such message").is_none() && upd(0, "no such message").is_none());
    assert_eq!(upd(1, "new").unwrap().text, "new");
    let after = std::fs::read_to_string(&path).unwrap();
    assert!(after.contains("{this line is torn"), "an unreadable line survives the rewrite: {after}");
    assert_eq!(read_in(root.path(), &main)[0].text, "new");
    // A send that drew no card still takes an ordinal, so the answer is now message 2.
    note_send(&st, &subs[0], None);
    assert!(upd(1, "x").is_none(), "message 1 is the one that drew no card");
    assert_eq!(upd(2, "newer").unwrap().text, "newer");
}

#[test]
fn the_main_agents_row_session_and_turn_gain_nothing_from_a_card() {
    let st = state();
    let root = tempfile::tempdir().unwrap();
    let (main, subs) = world(&st, "quiet", Path::new("."), &["header"]);
    let before = serde_json::to_value(st.registry.get(&main).unwrap()).unwrap();
    let gen = st.registry.current_turn_gen(&main);
    on_blocker_at(root.path(), &st, &subs[0], BlockerCard { text: "t".into(), verdict: "v".into(), ..BlockerCard::default() }).unwrap();
    finish_sub(&st, root.path(), &subs[0], 1);
    let after = serde_json::to_value(st.registry.get(&main).unwrap()).unwrap();
    assert_eq!(before, after, "the main chat's registry row is untouched");
    assert_eq!(st.registry.current_turn_gen(&main), gen, "no turn was opened for it");
    assert!(st.sessions.is_empty(), "no live session received anything");
}

#[test]
fn the_all_finished_card_waits_for_every_sub_and_draws_once_per_set() {
    let st = state();
    let root = tempfile::tempdir().unwrap();
    let (main, subs) = world(&st, "all", Path::new("."), &["a", "b"]);
    let first = finish_sub(&st, root.path(), &subs[0], 1);
    assert!(first.iter().all(|e| e.kind != KIND_ALL_FINISHED), "b is still running");
    let second = finish_sub(&st, root.path(), &subs[1], 1);
    let all = second.iter().find(|e| e.kind == KIND_ALL_FINISHED).expect("every sub is finished");
    assert_eq!(all.verdict, "All 2 subs finished");
    assert_eq!(all.sum.as_ref().unwrap().subs, 2);
    // The same set never draws twice.
    assert!(draw_finish_at(root.path(), &st, &subs[1], None).iter().all(|e| e.kind != KIND_ALL_FINISHED));
    // A continued sub that finishes again is a new set, so a new card.
    st.registry.set_subchat_finished(&subs[0], false);
    assert!(all_finished_entry(&st, root.path(), &main).is_none(), "a continued sub is running again");
    let third = finish_sub(&st, root.path(), &subs[0], 2);
    assert!(third.iter().any(|e| e.kind == KIND_ALL_FINISHED), "round 2 is a new set");
    assert_eq!(read_in(root.path(), &main).iter().filter(|e| e.kind == KIND_ALL_FINISHED).count(), 2);
}

/// The first real runs showed "All 2 ... 4 ... 8 ... 9 ... 21 ... 28 subs finished" on one
/// main chat: each card counted every sub it had ever had. A card counts the batch
/// since the previous one.
#[test]
fn the_all_finished_card_counts_the_batch_since_the_last_card_not_the_lifetime() {
    let st = state();
    let root = tempfile::tempdir().unwrap();
    let (main, first) = world(&st, "batch", Path::new("."), &["a", "b"]);
    finish_sub(&st, root.path(), &first[0], 1);
    let done = finish_sub(&st, root.path(), &first[1], 1);
    assert_eq!(done.iter().find(|e| e.kind == KIND_ALL_FINISHED).unwrap().verdict, "All 2 subs finished");

    // Three more subs in the same main chat; the first two are still there, finished.
    let mut later = Vec::new();
    for n in ["c", "d", "e"] {
        let id = format!("batch-{n}");
        st.registry.upsert_interactive(&id, Path::new("."), "proj", "2026-11-05T00:00:00Z");
        st.registry.set_subchat_of(&id, Some(main.clone()));
        st.registry.set_name(&id, n.to_string());
        later.push(id);
    }
    finish_sub(&st, root.path(), &later[0], 1);
    finish_sub(&st, root.path(), &later[1], 1);
    assert_eq!(read_in(root.path(), &main).iter().filter(|e| e.kind == KIND_ALL_FINISHED).count(), 1, "one sub is still running");
    let done = finish_sub(&st, root.path(), &later[2], 1);
    let all = done.iter().find(|e| e.kind == KIND_ALL_FINISHED).expect("the last running sub finished");
    assert_eq!(all.verdict, "All 3 subs finished", "not All 5");
    assert_eq!(all.sum.as_ref().unwrap().subs, 3);
    // Drawn once: asking again with nothing new says nothing.
    assert!(all_finished_entry(&st, root.path(), &main).is_none());
    assert!(draw_finish_at(root.path(), &st, &later[2], None).iter().all(|e| e.kind != KIND_ALL_FINISHED));
}

fn stored_finish(st: &Arc<DaemonState>, root: &Path, sub: &str, facts: Facts) {
    record(root, sub, 1, "Done");
    let inst = st.registry.get(sub).unwrap();
    let entry = CardEntry {
        id: format!("finish-{sub}-1"),
        ts: now_ms(),
        parent_id: inst.subchat_of.clone().unwrap(),
        kind: KIND_FINISH.into(),
        sub_id: Some(sub.to_string()),
        sub_name: Some(sub_name(&inst)),
        round: Some(1),
        verdict: "Done".into(),
        facts: Some(facts),
        ..CardEntry::default()
    };
    assert!(store_and_announce(st, root, &entry));
    st.registry.set_subchat_finished(sub, true);
}

/// One sub's merge was refused. The card must not say the work is in: its commits
/// are not counted as landed, "1 not merged" is stated, and the tone shows it.
#[test]
fn a_sub_whose_merge_was_refused_is_named_and_its_commits_are_not_counted_as_landed() {
    let st = state();
    let root = tempfile::tempdir().unwrap();
    let (main, subs) = world(&st, "unmerged", Path::new("."), &["landed", "refused"]);
    stored_finish(&st, root.path(), &subs[0], Facts { commits: Some(1), files_changed: Some(2), merged: Some(true), ..Facts::default() });
    stored_finish(&st, root.path(), &subs[1], Facts { commits: Some(3), files_changed: Some(5), merged: Some(false), ..Facts::default() });
    let all = all_finished_entry(&st, root.path(), &main).expect("both subs are finished");
    let sum = all.sum.as_ref().unwrap();
    assert_eq!((sum.commits, sum.files_changed, sum.not_merged), (1, 2, 1), "only what landed is counted: {sum:?}");
    assert!(all.text.contains("1 not merged"), "{}", all.text);
    assert_eq!(all.tone.as_deref(), Some("bad"), "the card does not claim all is fine");
    // The same two subs, both landed, are not marked.
    let st2 = state();
    let root2 = tempfile::tempdir().unwrap();
    let (main2, subs2) = world(&st2, "merged", Path::new("."), &["x", "y"]);
    for s in &subs2 {
        stored_finish(&st2, root2.path(), s, Facts { commits: Some(1), files_changed: Some(1), merged: Some(true), ..Facts::default() });
    }
    let ok = all_finished_entry(&st2, root2.path(), &main2).unwrap();
    assert!(ok.tone.is_none() && !ok.text.contains("not merged"), "{ok:?}");
}

#[test]
fn a_new_sub_still_running_blocks_the_all_finished_card() {
    let st = state();
    let root = tempfile::tempdir().unwrap();
    let (main, subs) = world(&st, "run", Path::new("."), &["a", "late"]);
    finish_sub(&st, root.path(), &subs[0], 1);
    assert!(read_in(root.path(), &main).iter().all(|e| e.kind != KIND_ALL_FINISHED));
    assert!(!st.registry.get(&subs[1]).unwrap().subchat_finished);
}

/// Both subs have finished, but b's card thread is slower than a's: a's draw
/// runs before b's finish card is stored. The card a draws then counts b as
/// unknown, and b's own draw must put it right.
#[test]
fn an_all_finished_card_that_understated_a_slower_sub_is_corrected_when_its_card_lands() {
    let st = state();
    let root = tempfile::tempdir().unwrap();
    let (main, subs) = world(&st, "late", Path::new("."), &["a", "b"]);
    for s in &subs {
        record(root.path(), s, 1, "Built");
        st.registry.set_subchat_finished(s, true);
    }
    draw_finish_at(root.path(), &st, &subs[0], None);
    draw_finish_at(root.path(), &st, &subs[1], None);
    let cards = read_in(root.path(), &main);
    let last = cards.iter().rev().find(|e| e.kind == KIND_ALL_FINISHED).expect("an all-finished card");
    // A sub with a stored finish card has facts and counts as unreviewed here; one
    // with none counts as nothing at all, so 2 means both cards were in the sum.
    assert_eq!(last.sum.as_ref().unwrap().unreviewed, 2, "the latest all-finished card counts both subs: {last:?}");
}

#[test]
fn finishes_drawn_at_the_same_moment_never_leave_two_cards_for_one_set() {
    let st = state();
    let root = tempfile::tempdir().unwrap();
    let names = ["a", "b", "c", "d", "e", "f"];
    let (main, subs) = world(&st, "race", Path::new("."), &names);
    for s in &subs {
        record(root.path(), s, 1, "Built");
        st.registry.set_subchat_finished(s, true);
    }
    let threads: Vec<_> = subs
        .iter()
        .map(|s| {
            let (st, root, s) = (st.clone(), root.path().to_path_buf(), s.clone());
            std::thread::spawn(move || draw_finish_at(&root, &st, &s, None))
        })
        .collect();
    for t in threads {
        t.join().unwrap();
    }
    let cards = read_in(root.path(), &main);
    let all: Vec<&CardEntry> = cards.iter().filter(|e| e.kind == KIND_ALL_FINISHED).collect();
    let mut keys: Vec<&str> = all.iter().filter_map(|e| e.set_key.as_deref()).collect();
    let before = keys.len();
    keys.sort_unstable();
    keys.dedup();
    assert_eq!(keys.len(), before, "one card per set of reports, however the threads interleave");
    assert_eq!(all.last().unwrap().sum.as_ref().unwrap().unreviewed, 6, "the last card counts every sub");
}

#[test]
fn the_second_report_of_a_continued_sub_counts_since_its_previous_report() {
    let _data = crate::daemon::subchats::TempDataDir::new();
    let (dir, repo) = init();
    let st = state();
    let root = tempfile::tempdir().unwrap();
    let (main, subs) = world(&st, "round", &repo, &["a"]);
    // The sub's own edits are what scope its counts: without them the whole range is a peer's too.
    let tp = transcript(dir.path(), &[("Write", &repo.join("one.txt")), ("Write", &repo.join("two.txt"))]);
    crate::daemon::subchats::store_sub_brief(&subs[0], &main);
    let mut brief = crate::sessions::chat_config::get(&subs[0]).unwrap().subchat.unwrap();
    brief.git_head_at_spawn = crate::daemon::subchats::git::head(&repo);
    crate::sessions::chat_config::set_subchat(&subs[0], Some(brief));
    for n in ["one.txt", "two.txt"] {
        std::fs::write(repo.join(n), n).unwrap();
        run(&repo, &["add", n]);
        run(&repo, &["commit", "-q", "-m", n]);
        if n == "one.txt" {
            finish_sub_with(&st, root.path(), &subs[0], 1, Some(tp.clone()));
            st.registry.set_subchat_finished(&subs[0], false);
        }
    }
    let drawn = finish_sub_with(&st, root.path(), &subs[0], 2, Some(tp));
    let facts = drawn[0].facts.as_ref().unwrap();
    assert_eq!(facts.since, facts::SINCE_LAST_REPORT);
    assert_eq!(facts.commits, Some(1), "only the commit made after the first report");
    let first = read_in(root.path(), &main).into_iter().find(|e| e.round == Some(1)).unwrap();
    assert_eq!(first.facts.unwrap().commits, Some(1), "the first card kept its own count");
}

#[test]
fn on_finished_draws_through_the_real_hook_when_a_root_is_registered() {
    let st = state();
    let root = tempfile::tempdir().unwrap();
    let (main, subs) = world(&st, "hook", Path::new("."), &["a"]);
    record(root.path(), &subs[0], 1, "Built");
    st.registry.set_subchat_finished(&subs[0], true);
    seam::set(&subs[0], root.path().to_path_buf(), None);
    crate::daemon::subchats::on_finished(&st, &subs[0]);
    assert_eq!(read_in(root.path(), &main).iter().filter(|e| e.kind == KIND_FINISH).count(), 1);
}

#[test]
fn sum_text_states_totals_and_names_what_is_unknown() {
    let s = SumFacts { subs: 3, commits: 5, files_changed: 12, tests_passed: 2, tests_unknown: 1, unpushed: 1, unknown_subs: 1, ..SumFacts::default() };
    let t = sum_text(&s);
    assert!(t.contains("5 commits, 12 files changed") && t.contains("tests 2 passed, 1 unknown"), "{t}");
    assert!(t.contains("1 not pushed") && t.contains("1 sub unknown"), "{t}");
    assert!(!t.contains('\u{2014}'));
}

#[test]
fn a_log_id_that_could_leave_the_folder_is_refused() {
    let root = Path::new("/data");
    assert!(log_path(root, "../x").is_none());
    assert!(log_path(root, "").is_none());
    assert!(log_path(root, "abc-123").is_some());
    assert!(read_in(root, "../x").is_empty());
}
