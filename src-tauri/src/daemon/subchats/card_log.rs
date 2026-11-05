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
/// When-done answered a sub's question with the first option while Joe was away.
pub const KIND_WHEN_DONE: &str = "when_done";

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
    /// The model and effort the sub ran this round at. The card is a record of one
    /// report, so it keeps the tier it was written under even after Joe changes it;
    /// the chat prints them as a quiet "Sonnet high" beside the sub's name.
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
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
    store_locked(state, root, entry)
}

/// [`store_and_announce`] for a caller that already holds [`LOG_LOCK`].
fn store_locked(state: &DaemonState, root: &Path, entry: &CardEntry) -> bool {
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
    check: crate::types::SubchatCheck,
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
    let (mut base, since) = match (&previous_head, brief.as_ref().and_then(|b| b.git_head_at_spawn.as_ref())) {
        (Some(prev), _) => (Some(prev.clone()), facts::SINCE_LAST_REPORT),
        (None, Some(spawn)) => (Some(spawn.clone()), facts::SINCE_SPAWN),
        (None, None) => (None, facts::SINCE_SPAWN),
    };
    // A worktree sub's branch is rebased onto its target, which rewrites history
    // under any earlier head: its own base moves with each update instead.
    if let Some(tree_base) = brief.as_ref().and_then(|b| b.worktree_at.as_ref()).and_then(|w| w.base.clone()) {
        base = Some(tree_base);
    }
    // A gate sub's push is measured against the upstream it started from; any
    // other sub keeps the commit-based reading of "pushed".
    let gate = brief
        .as_ref()
        .filter(|b| b.gate)
        .map(|b| facts::GateBase { upstream_before: b.upstream_at_spawn.as_deref() });
    let mut computed = facts::compute(&facts::Inputs {
        cwd: &inst.cwd,
        transcript,
        base: base.as_deref(),
        since,
        reviewer_tool_use_id,
        review_required: super::project::review_required(check, brief.as_ref()),
        gate,
    });
    if let Some(b) = brief.as_ref() {
        super::worktree::annotate(&mut computed, b);
    }
    computed
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
    let parent = state.registry.get(sub_id)?.subchat_of.clone()?;
    on_blocker_in(root, state, &parent, sub_id, card)
}

/// [`on_blocker_at`] for a sub that no longer names its main chat in the
/// registry: one just moved to the sidebar still has something to say to the
/// window it left, so the caller passes the chat it had.
pub(crate) fn on_blocker_in(
    root: &Path,
    state: &Arc<DaemonState>,
    parent: &str,
    sub_id: &str,
    card: BlockerCard,
) -> Option<CardEntry> {
    let inst = state.registry.get(sub_id)?;
    let entry = CardEntry {
        id: format!("blocker-{}", uuid::Uuid::new_v4()),
        ts: now_ms(),
        parent_id: parent.to_string(),
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

pub fn on_blocker_for(state: &Arc<DaemonState>, parent: &str, sub_id: &str, card: BlockerCard) -> Option<CardEntry> {
    let root = crate::settings::paths::data_dir().ok()?;
    on_blocker_in(&root, state, parent, sub_id, card)
}

/// Draws the card that tells Joe when-done answered a sub's question for him.
/// When-done auto-answers with the first option so the machine can sleep, and
/// the answer would otherwise leave no trace in the window Joe reads. Goes
/// through the card log rather than `raise_card`, since a question card waits
/// for an answer that never comes. `None` when `sub_id` is not a sub.
pub fn on_when_done_answer(state: &Arc<DaemonState>, sub_id: &str, question: &str, answer: &str) -> Option<CardEntry> {
    let root = crate::settings::paths::data_dir().ok()?;
    on_when_done_answer_at(&root, state, sub_id, question, answer)
}

pub(crate) fn on_when_done_answer_at(
    root: &Path,
    state: &Arc<DaemonState>,
    sub_id: &str,
    question: &str,
    answer: &str,
) -> Option<CardEntry> {
    let inst = state.registry.get(sub_id)?;
    let parent = inst.subchat_of.clone()?;
    let entry = CardEntry {
        id: format!("when-done-{}", uuid::Uuid::new_v4()),
        ts: now_ms(),
        parent_id: parent,
        kind: KIND_WHEN_DONE.into(),
        sub_id: Some(sub_id.to_string()),
        sub_name: Some(sub_name(&inst)),
        verdict: "When-done answered".into(),
        tone: Some("neutral".into()),
        text: format!("While you were away, when-done answered the question \"{question}\" with its first option: {answer}."),
        ..CardEntry::default()
    };
    store_and_announce(state, root, &entry).then_some(entry)
}

/// Moves a main chat's cards to the chat that took over (`respawn`), rewriting
/// each entry's `parent_id`. Re-runnable: an entry the destination already holds
/// is skipped, so a move that stopped half way finishes on the next call without
/// doubling a card.
pub fn move_log(old_parent: &str, new_parent: &str) {
    if let Ok(root) = crate::settings::paths::data_dir() {
        move_log_in(&root, old_parent, new_parent);
    }
}

pub(crate) fn move_log_in(root: &Path, old_parent: &str, new_parent: &str) {
    if old_parent == new_parent {
        return;
    }
    let _guard = LOG_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let (Some(from), Some(_)) = (log_path(root, old_parent), log_path(root, new_parent)) else { return };
    if !from.exists() {
        return;
    }
    let held: std::collections::HashSet<String> = read_in(root, new_parent).into_iter().map(|e| e.id).collect();
    for mut entry in read_in(root, old_parent) {
        if held.contains(&entry.id) {
            continue;
        }
        entry.parent_id = new_parent.to_string();
        if let Err(e) = append(root, &entry) {
            // Leave the old file in place: the next run finishes the move.
            log::warn!("subchats: could not move card {} to {new_parent}: {e}", entry.id);
            return;
        }
    }
    if let Err(e) = std::fs::remove_file(&from) {
        log::warn!("subchats: moved {old_parent}'s cards but could not remove the old file: {e}");
    }
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
    let check = super::project::check_mode(state, &inst.cwd);
    let facts = sub_facts(&inst, check, record.reviewer_tool_use_id.as_deref(), &log, transcript.as_deref());
    let finish_entry = CardEntry {
        id: format!("finish-{sub_id}-{}", record.round),
        ts: now_ms(),
        parent_id: parent.clone(),
        kind: KIND_FINISH.into(),
        sub_id: Some(sub_id.to_string()),
        sub_name: Some(sub_name(&inst)),
        round: Some(record.round),
        model: Some(inst.model.clone()).filter(|m| !m.is_empty()),
        effort: Some(inst.effort.clone()).filter(|e| !e.is_empty()),
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
    // After this sub's own card is stored, and under the log lock from the read to
    // the write: a sibling's thread that stored its card first is then in the sum,
    // and two threads cannot both find the set undrawn and each draw it.
    let _guard = LOG_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(all) = all_finished_entry(state, root, &parent) {
        if store_locked(state, root, &all) {
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
    if s.not_merged > 0 {
        parts.push(format!("{} not merged", s.not_merged));
    }
    if s.unknown_subs > 0 {
        parts.push(format!("{} sub{} unknown", s.unknown_subs, plural(s.unknown_subs)));
    }
    parts.join(", ")
}

fn plural(n: u32) -> &'static str {
    if n == 1 { "" } else { "s" }
}

/// The "all finished" card: drawn once, when the last running sub of `parent`
/// finishes, for the batch of reports since the previous such card. Only that
/// batch is summed, so a long-lived main chat does not report its whole history
/// each time, and a continued sub that finishes again starts a batch of its own.
///
/// A report counts once its finish card is in the log, so the card waits for the
/// sub whose card thread has not landed yet: that thread calls this again right
/// after storing its card and draws it, which is also why no set is ever drawn
/// twice. A sub whose merge was refused is named in the totals as not merged and
/// its commits are left out of them, and the card's tone says so.
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
    let log = read_in(root, parent);
    let waiting_for_a_card = subs.iter().any(|i| {
        let round = finish::read_record_in(root, &i.session_id).map_or(0, |r| r.round);
        round > 0 && !log.iter().any(|e| e.id == format!("finish-{}-{round}", i.session_id))
    });
    if waiting_for_a_card {
        return None;
    }
    let since = log.iter().rposition(|e| e.kind == KIND_ALL_FINISHED).map_or(0, |i| i + 1);
    // Each live sub's latest report in the batch, in the order the subs finished.
    let mut batch: Vec<&CardEntry> = Vec::new();
    for e in log[since..].iter().filter(|e| e.kind == KIND_FINISH) {
        let Some(id) = e.sub_id.as_deref() else { continue };
        if !subs.iter().any(|i| i.session_id == id) {
            continue;
        }
        batch.retain(|b| b.sub_id.as_deref() != Some(id));
        batch.push(e);
    }
    if batch.is_empty() {
        return None;
    }
    let key = batch.iter().map(|e| e.id.as_str()).collect::<Vec<_>>().join(",");
    let latest: Vec<Option<&Facts>> = batch.iter().map(|e| e.facts.as_ref()).collect();
    let sum = facts::sum(&latest);
    let n = sum.subs;
    Some(CardEntry {
        id: format!("all-{parent}-{}", now_ms()),
        ts: now_ms(),
        parent_id: parent.to_string(),
        kind: KIND_ALL_FINISHED.into(),
        verdict: if n == 1 { "1 sub finished".into() } else { format!("All {n} subs finished") },
        // Code can say what failed or is left over, never that the work is right.
        tone: (sum.tests_failed > 0 || sum.uncommitted > 0 || sum.not_merged > 0).then(|| "bad".to_string()),
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
        finish_sub_with(st, root, sub, round, None)
    }

    fn finish_sub_with(st: &Arc<DaemonState>, root: &Path, sub: &str, round: u32, transcript: Option<PathBuf>) -> Vec<CardEntry> {
        record(root, sub, round, "Built, not pushed");
        st.registry.set_subchat_finished(sub, true);
        draw_finish_at(root, st, sub, transcript)
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
}
