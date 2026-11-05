//! The cards a sub puts in its main chat's window: its verdict when it finishes,
//! a `blocker` it sends, and one "all finished" card when the last running sub
//! is done. Drawn by code from the finish record and from git and the
//! transcript (`facts.rs`), never by the main agent.
//!
//! Cards are stored per main chat in `<data_dir>/subchats/<parent_id>.cards.jsonl`,
//! one JSON line each. A chat's own cards live in its own transcript and nothing
//! else is stored, so a sub's card has no other home: reopening the main chat
//! reads this file instead of every sub's transcript. The line holds card fields
//! and facts only, so it stays small.
//!
//! The main agent is not told. Nothing here touches its registry row, its
//! session or its transcript: a card is a file append plus a `subchat_card`
//! notifier frame, and the chat reads the file and renders the card itself.

use super::facts::{self, Facts, SumFacts};
use super::finish;
use crate::daemon::state::DaemonState;
use crate::types::Instance;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

pub const KIND_FINISH: &str = "finish";
pub const KIND_BLOCKER: &str = "blocker";
pub const KIND_ALL_FINISHED: &str = "all_finished";

/// The notifier frame a drawn card is announced on. The chat re-reads the log
/// when it sees one for its own id, so a dropped frame costs a refresh at most.
pub const NOTIFY: &str = "subchat_card";

/// One line of the log. Every field is `#[serde(default)]` so a line written by
/// an older build still loads.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct CardEntry {
    #[serde(default)]
    pub id: String,
    /// Unix milliseconds. The chat merges cards into its timeline by this.
    #[serde(default)]
    pub ts: i64,
    #[serde(default)]
    pub parent_id: String,
    /// [`KIND_FINISH`], [`KIND_BLOCKER`] or [`KIND_ALL_FINISHED`].
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub sub_id: Option<String>,
    #[serde(default)]
    pub sub_name: Option<String>,
    /// Which finish of a continued sub this is.
    #[serde(default)]
    pub round: Option<u32>,
    #[serde(default)]
    pub verdict: String,
    #[serde(default)]
    pub tone: Option<String>,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub points: Vec<String>,
    #[serde(default)]
    pub done: Vec<String>,
    #[serde(default)]
    pub not_done: Vec<String>,
    #[serde(default)]
    pub waiting_on: Vec<String>,
    #[serde(default)]
    pub your_move: Vec<String>,
    /// A finish card's facts. Absent on a blocker, which is the sub's own word
    /// and carries nothing code could back.
    #[serde(default)]
    pub facts: Option<Facts>,
    /// An "all finished" card's totals.
    #[serde(default)]
    pub sum: Option<SumFacts>,
    /// Which `sub:round` pairs an "all finished" card covers, so the same set
    /// never draws a second one.
    #[serde(default)]
    pub set_key: Option<String>,
}

/// Serializes the read-check-append of the log within the process: two subs
/// finishing together must not both see "not drawn yet" and draw twice.
static LOG_LOCK: Mutex<()> = Mutex::new(());

fn log_path(root: &Path, parent: &str) -> Option<PathBuf> {
    if parent.is_empty() || parent.contains(['/', '\\', '.']) {
        return None;
    }
    Some(root.join("subchats").join(format!("{parent}.cards.jsonl")))
}

/// A main chat's cards, oldest first. A line that does not parse is skipped
/// rather than failing the log.
pub fn read_in(root: &Path, parent: &str) -> Vec<CardEntry> {
    let Some(path) = log_path(root, parent) else { return Vec::new() };
    let Ok(raw) = std::fs::read_to_string(path) else { return Vec::new() };
    raw.lines().filter_map(|l| serde_json::from_str(l).ok()).collect()
}

pub fn read(parent: &str) -> Vec<CardEntry> {
    crate::settings::paths::data_dir().map(|r| read_in(&r, parent)).unwrap_or_default()
}

fn append(root: &Path, entry: &CardEntry) -> std::io::Result<()> {
    use std::io::Write;
    let path = log_path(root, &entry.parent_id)
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "bad parent id"))?;
    std::fs::create_dir_all(path.parent().unwrap_or(root))?;
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(path)?;
    writeln!(f, "{}", serde_json::to_string(entry).map_err(std::io::Error::other)?)
}

/// Appends `entry` unless the log already holds its id, then announces it.
/// Returns whether it was new.
fn store_and_announce(state: &DaemonState, root: &Path, entry: &CardEntry) -> bool {
    let _guard = LOG_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    if read_in(root, &entry.parent_id).iter().any(|e| e.id == entry.id) {
        return false;
    }
    if let Err(e) = append(root, entry) {
        log::warn!("subchats: could not store card {} for {}: {e}", entry.id, entry.parent_id);
        return false;
    }
    state.notifier.publish(NOTIFY, json!({ "session_id": entry.parent_id, "card": entry }));
    true
}

/// How a card names its sub: the title, else the brief's task cut short, else
/// the id's head. Joe does not read the sub, so the card has to say which job it is.
fn sub_name(inst: &Instance) -> String {
    if let Some(n) = inst.name.as_deref().map(str::trim).filter(|n| !n.is_empty()) {
        return n.to_string();
    }
    let task = crate::sessions::chat_config::get(&inst.session_id)
        .and_then(|c| c.subchat)
        .map(|b| b.task.trim().chars().take(40).collect::<String>())
        .filter(|t| !t.is_empty());
    task.unwrap_or_else(|| inst.session_id.chars().take(8).collect())
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// The facts of a sub's report this round. The base is the previous report's
/// head when the log has one for this sub, else the head recorded at spawn.
pub(super) fn sub_facts(
    inst: &Instance,
    reviewer_tool_use_id: Option<&str>,
    log: &[CardEntry],
    transcript: Option<&Path>,
) -> Facts {
    let brief = crate::sessions::chat_config::get(&inst.session_id).and_then(|c| c.subchat);
    let previous_head = log
        .iter()
        .rev()
        .find(|e| e.kind == KIND_FINISH && e.sub_id.as_deref() == Some(&inst.session_id))
        .and_then(|e| e.facts.as_ref())
        .and_then(|f| f.head.clone());
    let (base, since) = match (&previous_head, brief.as_ref().and_then(|b| b.git_head_at_spawn.as_ref())) {
        (Some(prev), _) => (Some(prev.clone()), facts::SINCE_LAST_REPORT),
        (None, Some(spawn)) => (Some(spawn.clone()), facts::SINCE_SPAWN),
        (None, None) => (None, facts::SINCE_SPAWN),
    };
    facts::compute(&facts::Inputs {
        cwd: &inst.cwd,
        transcript,
        base: base.as_deref(),
        since,
        reviewer_tool_use_id,
        review_required: brief.map_or(true, |b| b.review),
    })
}

/// What a sub's `blocker` message carries into the main chat.
#[derive(Clone, Debug, Default)]
pub struct BlockerCard {
    pub text: String,
    pub verdict: String,
    pub tone: Option<String>,
    pub points: Vec<String>,
}

/// Draws a sub's `blocker` into its main chat. Any other kind stays in the sub,
/// so the caller checks the kind. `None` when `sub_id` is not a sub.
pub fn on_blocker(state: &Arc<DaemonState>, sub_id: &str, card: BlockerCard) -> Option<CardEntry> {
    let root = crate::settings::paths::data_dir().ok()?;
    on_blocker_at(&root, state, sub_id, card)
}

pub(crate) fn on_blocker_at(
    root: &Path,
    state: &Arc<DaemonState>,
    sub_id: &str,
    card: BlockerCard,
) -> Option<CardEntry> {
    let inst = state.registry.get(sub_id)?;
    let parent = inst.subchat_of.clone()?;
    let entry = CardEntry {
        id: format!("blocker-{}", uuid::Uuid::new_v4()),
        ts: now_ms(),
        parent_id: parent,
        kind: KIND_BLOCKER.into(),
        sub_id: Some(sub_id.to_string()),
        sub_name: Some(sub_name(&inst)),
        verdict: card.verdict,
        tone: card.tone,
        text: card.text,
        points: card.points,
        ..CardEntry::default()
    };
    store_and_announce(state, root, &entry).then_some(entry)
}

/// The hook `subchats::on_finished` calls. The card needs git and a transcript
/// read, and `on_finished` runs inside the pump's result handler, so the work
/// goes to its own thread rather than blocking a turn end.
pub fn on_finished(state: &Arc<DaemonState>, sub_id: &str) {
    #[cfg(test)]
    {
        // Tests that finish a sub do not own the real data dir; only one that
        // registered a scratch root draws.
        if let Some((root, transcript)) = seam::get(sub_id) {
            draw_finish_at(&root, state, sub_id, transcript);
        }
    }
    #[cfg(not(test))]
    {
        let (state, id) = (state.clone(), sub_id.to_string());
        let spawned = std::thread::Builder::new().name("subchat-card".into()).spawn(move || {
            let Ok(root) = crate::settings::paths::data_dir() else { return };
            let transcript = crate::context_status::resolve_transcript(&state.registry, &id);
            draw_finish_at(&root, &state, &id, transcript);
        });
        if let Err(e) = spawned {
            log::warn!("subchats: could not start the card thread for {sub_id}: {e}");
        }
    }
}

/// Draws the finish card for `sub_id`'s latest report, then the "all finished"
/// card when that was the last running sub. Blocking. Returns what was drawn.
pub(crate) fn draw_finish_at(
    root: &Path,
    state: &Arc<DaemonState>,
    sub_id: &str,
    transcript: Option<PathBuf>,
) -> Vec<CardEntry> {
    let mut drawn = Vec::new();
    let Some(inst) = state.registry.get(sub_id) else { return drawn };
    let Some(parent) = inst.subchat_of.clone() else { return drawn };
    let Some(record) = finish::read_record_in(root, sub_id) else { return drawn };
    let log = read_in(root, &parent);
    let facts = sub_facts(&inst, record.reviewer_tool_use_id.as_deref(), &log, transcript.as_deref());
    let finish_entry = CardEntry {
        id: format!("finish-{sub_id}-{}", record.round),
        ts: now_ms(),
        parent_id: parent.clone(),
        kind: KIND_FINISH.into(),
        sub_id: Some(sub_id.to_string()),
        sub_name: Some(sub_name(&inst)),
        round: Some(record.round),
        verdict: if record.verdict.is_empty() { "Finished".into() } else { record.verdict.clone() },
        tone: record.tone.clone(),
        text: record.text.clone(),
        points: record.points.clone(),
        done: record.done.clone(),
        not_done: record.not_done.clone(),
        waiting_on: record.waiting_on.clone(),
        your_move: record.your_move.clone(),
        facts: Some(facts),
        ..CardEntry::default()
    };
    if store_and_announce(state, root, &finish_entry) {
        drawn.push(finish_entry);
    }
    if let Some(all) = all_finished_entry(state, root, &parent) {
        if store_and_announce(state, root, &all) {
            drawn.push(all);
        }
    }
    drawn
}

/// "A, B and C" style count line for the all-finished card. Only what could be
/// summed is stated, with the unknown named beside it.
fn sum_text(s: &SumFacts) -> String {
    let mut parts = vec![format!("{} commit{}, {} file{} changed", s.commits, plural(s.commits), s.files_changed, plural(s.files_changed))];
    let mut tests = Vec::new();
    if s.tests_passed > 0 {
        tests.push(format!("{} passed", s.tests_passed));
    }
    if s.tests_failed > 0 {
        tests.push(format!("{} failed", s.tests_failed));
    }
    if s.tests_unknown > 0 {
        tests.push(format!("{} unknown", s.tests_unknown));
    }
    if !tests.is_empty() {
        parts.push(format!("tests {}", tests.join(", ")));
    }
    if s.uncommitted > 0 {
        parts.push(format!("{} uncommitted", s.uncommitted));
    }
    if s.unpushed > 0 {
        parts.push(format!("{} not pushed", s.unpushed));
    }
    if s.unknown_subs > 0 {
        parts.push(format!("{} sub{} unknown", s.unknown_subs, plural(s.unknown_subs)));
    }
    parts.join(", ")
}

fn plural(n: u32) -> &'static str {
    if n == 1 { "" } else { "s" }
}

/// The "all finished" card, when every live sub of `parent` is finished and no
/// card was already drawn for this exact set of reports. A continued sub that
/// finishes again has a new round, so it makes a new set; a sub still running
/// blocks the card.
fn all_finished_entry(state: &DaemonState, root: &Path, parent: &str) -> Option<CardEntry> {
    let subs: Vec<Instance> = state
        .registry
        .list()
        .into_iter()
        .filter(|i| i.subchat_of.as_deref() == Some(parent) && i.ended_at.is_none() && i.end_reason.is_none())
        .collect();
    if subs.is_empty() || subs.iter().any(|i| !i.subchat_finished) {
        return None;
    }
    let mut pairs: Vec<String> = subs
        .iter()
        .map(|i| format!("{}:{}", i.session_id, finish::read_record_in(root, &i.session_id).map_or(0, |r| r.round)))
        .collect();
    pairs.sort();
    let key = pairs.join(",");
    let log = read_in(root, parent);
    if log.iter().rev().find(|e| e.kind == KIND_ALL_FINISHED).and_then(|e| e.set_key.as_deref()) == Some(key.as_str()) {
        return None;
    }
    // Each sub's latest finish card is where its facts were stored.
    let latest: Vec<Option<&Facts>> = subs
        .iter()
        .map(|i| {
            log.iter()
                .rev()
                .find(|e| e.kind == KIND_FINISH && e.sub_id.as_deref() == Some(i.session_id.as_str()))
                .and_then(|e| e.facts.as_ref())
        })
        .collect();
    let sum = facts::sum(&latest);
    let n = sum.subs;
    Some(CardEntry {
        id: format!("all-{parent}-{}", now_ms()),
        ts: now_ms(),
        parent_id: parent.to_string(),
        kind: KIND_ALL_FINISHED.into(),
        verdict: if n == 1 { "1 sub finished".into() } else { format!("All {n} subs finished") },
        // Code can say what failed or is left over, never that the work is right.
        tone: (sum.tests_failed > 0 || sum.uncommitted > 0).then(|| "bad".to_string()),
        text: sum_text(&sum),
        sum: Some(sum),
        set_key: Some(key),
        ..CardEntry::default()
    })
}

/// Lets a test choose where `on_finished` draws, per sub id, so a test that
/// drives the real hook never writes into the real data dir.
#[cfg(test)]
pub(crate) mod seam {
    use std::collections::HashMap;
    use std::path::PathBuf;
    use std::sync::Mutex;

    static ROOTS: Mutex<Option<HashMap<String, (PathBuf, Option<PathBuf>)>>> = Mutex::new(None);

    pub fn set(sub_id: &str, root: PathBuf, transcript: Option<PathBuf>) {
        ROOTS.lock().unwrap_or_else(|p| p.into_inner()).get_or_insert_with(HashMap::new).insert(sub_id.to_string(), (root, transcript));
    }

    pub(super) fn get(sub_id: &str) -> Option<(PathBuf, Option<PathBuf>)> {
        ROOTS.lock().unwrap_or_else(|p| p.into_inner()).as_ref()?.get(sub_id).cloned()
    }
}

#[cfg(test)]
mod tests {
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
        record(root, sub, round, "Built, not pushed");
        st.registry.set_subchat_finished(sub, true);
        draw_finish_at(root, st, sub, None)
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

        record(root.path(), &subs[0], 1, "Built, not pushed");
        st.registry.set_subchat_finished(&subs[0], true);
        let drawn = draw_finish_at(root.path(), &st, &subs[0], Some(tp));

        let finish = drawn.iter().find(|e| e.kind == KIND_FINISH).expect("finish card drawn");
        assert_eq!(finish.parent_id, main);
        assert_eq!(finish.sub_name.as_deref(), Some("header"));
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

    #[test]
    fn a_new_sub_still_running_blocks_the_all_finished_card() {
        let st = state();
        let root = tempfile::tempdir().unwrap();
        let (main, subs) = world(&st, "run", Path::new("."), &["a", "late"]);
        finish_sub(&st, root.path(), &subs[0], 1);
        assert!(read_in(root.path(), &main).iter().all(|e| e.kind != KIND_ALL_FINISHED));
        assert!(!st.registry.get(&subs[1]).unwrap().subchat_finished);
    }

    #[test]
    fn the_second_report_of_a_continued_sub_counts_since_its_previous_report() {
        let _data = crate::daemon::subchats::TempDataDir::new();
        let (_dir, repo) = init();
        let st = state();
        let root = tempfile::tempdir().unwrap();
        let (main, subs) = world(&st, "round", &repo, &["a"]);
        crate::daemon::subchats::store_sub_brief(&subs[0], &main);
        let mut brief = crate::sessions::chat_config::get(&subs[0]).unwrap().subchat.unwrap();
        brief.git_head_at_spawn = crate::daemon::subchats::git::head(&repo);
        crate::sessions::chat_config::set_subchat(&subs[0], Some(brief));
        for n in ["one.txt", "two.txt"] {
            std::fs::write(repo.join(n), n).unwrap();
            run(&repo, &["add", n]);
            run(&repo, &["commit", "-q", "-m", n]);
            if n == "one.txt" {
                finish_sub(&st, root.path(), &subs[0], 1);
                st.registry.set_subchat_finished(&subs[0], false);
            }
        }
        let drawn = finish_sub(&st, root.path(), &subs[0], 2);
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
}
