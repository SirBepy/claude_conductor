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
use crate::types::now_epoch_ms as now_ms;
use crate::types::Instance;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

pub const KIND_FINISH: &str = "finish";
pub const KIND_BLOCKER: &str = "blocker";
pub const KIND_ALL_FINISHED: &str = "all_finished";
/// A sub's `answer` or `rating` message: what Joe asked, answered in full, so it
/// is drawn in the main chat's window instead of staying in the sub's transcript.
pub const KIND_ANSWER: &str = "answer";
pub const KIND_RATING: &str = "rating";
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
    /// On a finish card: the question of Joe's this round answers. The chat
    /// draws such a card as the answer in his Answers card, under the sub's name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub question: Option<String>,
    /// An answer or rating card's click-to-open details (`[label](#d:id)` links in
    /// its text): the full answer, which the 200-char finish text cannot carry.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub details: Vec<CardDetail>,
    /// The answer's tables and charts, as `send_message` carried them (already
    /// validated by the route; the chat parses them with `message-visuals.ts`).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub visuals: Vec<serde_json::Value>,
    /// The sub retracted this answer with `update_message`; the card stays as a thin pill.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub retracted: bool,
    /// The paired machine the sub ran on, in plain characters, when it was not this one.
    /// A card is a record, so it keeps where the sub ran after the machine goes away.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub machine: Option<String>,
    /// A `blocker` the app drew about a sub (a tree it kept, a refused move), as opposed
    /// to one the sub sent itself. Only these are retracted when the problem is over: a
    /// sub's own blocker is its word, which a landing says nothing about.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub by_app: bool,
}

/// One click-to-open detail of an answer card, as `send_message` carried it.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct CardDetail {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub body_md: String,
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

/// The facts of a sub's report this round. The base is the previous report's
/// head when the log has one for this sub, else the head recorded at spawn.
pub(crate) fn sub_facts(
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
    // A visiting sub's target is a branch of its home machine, so this machine's
    // clone says nothing about whether the commits landed: the home annotates.
    if let Some(b) = brief.as_ref().filter(|b| b.home.is_none()) {
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
    // A visiting sub's main chat is on its home: the card is drawn there.
    if super::is_visiting(sub_id) {
        let event = super::remote::events::CardEvent { kind: KIND_BLOCKER.into(), verdict: card.verdict, tone: card.tone, text: card.text, points: card.points, ..Default::default() };
        super::remote::events::queue_card(state, sub_id, event);
        return None;
    }
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
    blocker_in(root, state, parent, sub_id, card, false)
}

pub fn on_blocker_for(state: &Arc<DaemonState>, parent: &str, sub_id: &str, card: BlockerCard) -> Option<CardEntry> {
    let root = crate::settings::paths::data_dir().ok()?;
    on_blocker_in(&root, state, parent, sub_id, card)
}

/// [`on_blocker`] for a card the app draws about a sub (a tree it kept), so a later
/// [`retract_blockers`] may take it down. `root` is the data dir, `None` for the real one.
pub(crate) fn on_app_blocker(state: &Arc<DaemonState>, sub_id: &str, root: Option<&Path>, card: BlockerCard) -> Option<CardEntry> {
    // A visiting sub's main chat is on its home: the card is drawn there, as `on_blocker` does.
    if root.is_none() && super::is_visiting(sub_id) {
        return on_blocker(state, sub_id, card);
    }
    let parent = state.registry.get(sub_id)?.subchat_of.clone()?;
    match root {
        Some(root) => blocker_in(root, state, &parent, sub_id, card, true),
        None => on_app_blocker_for(state, &parent, sub_id, card),
    }
}

/// [`on_app_blocker`] for a sub that no longer names its main chat (see [`on_blocker_in`]).
pub(crate) fn on_app_blocker_for(state: &Arc<DaemonState>, parent: &str, sub_id: &str, card: BlockerCard) -> Option<CardEntry> {
    let root = crate::settings::paths::data_dir().ok()?;
    blocker_in(&root, state, parent, sub_id, card, true)
}

fn blocker_in(root: &Path, state: &Arc<DaemonState>, parent: &str, sub_id: &str, card: BlockerCard, by_app: bool) -> Option<CardEntry> {
    let inst = state.registry.get(sub_id)?;
    let entry = CardEntry {
        id: format!("blocker-{}", uuid::Uuid::new_v4()),
        ts: now_ms(),
        parent_id: parent.to_string(),
        kind: KIND_BLOCKER.into(),
        sub_id: Some(sub_id.to_string()),
        sub_name: Some(sub_name(&inst)),
        verdict: card.verdict,
        // A blocker is red by kind and the dashboard drops a "good" one as a success
        // notice, so a sub that sends a blocker with tone good keeps the card, not the colour.
        tone: card.tone.filter(|t| t != "good"),
        text: card.text,
        points: card.points,
        by_app,
        ..CardEntry::default()
    };
    store_and_announce(state, root, &entry).then_some(entry)
}

/// The verdicts of the "not merged" blocker cards an older build drew when a landing was
/// refused, before `by_app` existed. A landing makes them untrue whoever wrote them.
const LEGACY_LANDING_VERDICTS: [&str; 2] = ["Not merged", "Merge conflict"];

/// Takes the app's own open `blocker` cards about `sub_id` out of the Waiting on you
/// zone: a problem that is over (its commits landed, it started, the main chat dropped
/// it) must not stay on the dashboard as red, and no card says "all fine" in its place,
/// because a success is nothing Joe waits on. A blocker the sub sent itself is its own
/// word and stays. Marks each card retracted in place and announces the change; the
/// card stays in the log as a thin pill. Returns how many it marked.
pub fn retract_blockers(state: &Arc<DaemonState>, sub_id: &str) -> usize {
    let Ok(root) = crate::settings::paths::data_dir() else { return 0 };
    let Some(parent) = state.registry.get(sub_id).and_then(|i| i.subchat_of.clone()) else { return 0 };
    retract_blockers_in(&root, state, &parent, sub_id)
}

pub(crate) fn retract_blockers_in(root: &Path, state: &Arc<DaemonState>, parent: &str, sub_id: &str) -> usize {
    let _guard = LOG_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let mut n = 0;
    for mut entry in read_in(root, parent) {
        let app_drawn = entry.by_app || LEGACY_LANDING_VERDICTS.contains(&entry.verdict.as_str());
        if entry.kind != KIND_BLOCKER || !app_drawn || entry.retracted || entry.sub_id.as_deref() != Some(sub_id) {
            continue;
        }
        entry.retracted = true;
        if let Err(e) = replace_line(root, parent, &entry) {
            log::warn!("subchats: could not retract blocker card {} for {parent}: {e}", entry.id);
            continue;
        }
        state.notifier.publish(NOTIFY, json!({ "session_id": parent, "card": entry, "replace": true }));
        n += 1;
    }
    n
}

/// What a sub's `answer` or `rating` message carries into the main chat.
#[derive(Clone, Debug, Default)]
pub struct AnswerCard {
    /// [`KIND_ANSWER`] or [`KIND_RATING`].
    pub kind: String,
    pub text: String,
    pub verdict: String,
    pub tone: Option<String>,
    pub points: Vec<String>,
    pub details: Vec<CardDetail>,
    pub visuals: Vec<serde_json::Value>,
    /// The sub's clear rewrite of what Joe asked, when it sent one.
    pub question: Option<String>,
}

/// Every `send_message` a sub made this turn, in send order: the id of the card
/// the daemon drew for it, or `None` for a kind that draws none. `update_message`
/// addresses a message by its 1-based ordinal, newest first, counting the sub's
/// own non-retracted messages (`resolveOrdinalIn` in the frontend); this list lets
/// the daemon resolve the same ordinal for the current turn. An ordinal past the
/// turn's own sends names a message of an earlier turn, which the daemon cannot
/// place, so it is not mirrored.
static TURN_SENDS: Mutex<Option<std::collections::HashMap<String, (u64, Vec<Option<String>>)>>> = Mutex::new(None);

/// Records one passed send of `sub_id` (with the card it drew, if any). A chat that
/// is not a sub is not tracked.
pub fn note_send(state: &DaemonState, sub_id: &str, card_id: Option<String>) {
    if state.registry.get(sub_id).and_then(|i| i.subchat_of).is_none() {
        return;
    }
    let gen = state.registry.current_turn_gen(sub_id);
    let mut map = TURN_SENDS.lock().unwrap_or_else(|p| p.into_inner());
    let slot = map.get_or_insert_with(Default::default).entry(sub_id.to_string()).or_insert((gen, Vec::new()));
    if slot.0 != gen {
        *slot = (gen, Vec::new());
    }
    slot.1.push(card_id);
}

/// Draws a sub's `answer` or `rating` into its main chat. The question is the
/// one the send carried, else the one the main chat handed the sub, which is
/// then spent (the same rule `finish` follows) so the sub's later finish is not a
/// second answer to it. `None` when `sub_id` is not a sub.
pub fn on_answer(state: &Arc<DaemonState>, sub_id: &str, card: AnswerCard) -> Option<CardEntry> {
    // A visiting sub's main chat is on its home: the card is drawn there, with the
    // question this host's brief holds when the send carried none, spent once queued.
    if super::is_visiting(sub_id) {
        return queue_remote_answer(state, sub_id, card);
    }
    let root = crate::settings::paths::data_dir().ok()?;
    let parent = state.registry.get(sub_id)?.subchat_of.clone()?;
    on_answer_in(&root, state, &parent, sub_id, card)
}

pub(crate) fn on_answer_in(
    root: &Path,
    state: &Arc<DaemonState>,
    parent: &str,
    sub_id: &str,
    card: AnswerCard,
) -> Option<CardEntry> {
    let inst = state.registry.get(sub_id)?;
    let brief = crate::sessions::chat_config::get(sub_id).and_then(|c| c.subchat);
    let handed = brief.as_ref().and_then(|b| b.question.clone());
    let question = card.question.filter(|q| !q.trim().is_empty()).or(handed);
    let kind = if card.kind == KIND_RATING { KIND_RATING } else { KIND_ANSWER };
    let entry = CardEntry {
        id: format!("{kind}-{}", uuid::Uuid::new_v4()),
        ts: now_ms(),
        parent_id: parent.to_string(),
        kind: kind.into(),
        sub_id: Some(sub_id.to_string()),
        sub_name: Some(sub_name(&inst)),
        model: Some(inst.model.clone()).filter(|m| !m.is_empty()),
        effort: Some(inst.effort.clone()).filter(|e| !e.is_empty()),
        verdict: card.verdict,
        tone: card.tone,
        text: card.text,
        points: card.points,
        details: card.details,
        visuals: card.visuals,
        question,
        ..CardEntry::default()
    };
    if !store_and_announce(state, root, &entry) {
        return None;
    }
    // Spent only once the card is stored: a failed append leaves the question for the finish to carry.
    if let Some(mut b) = brief.filter(|b| b.question.is_some()) {
        b.question = None;
        crate::sessions::chat_config::set_subchat(sub_id, Some(b));
    }
    Some(entry)
}

/// A visiting sub's `answer` or `rating`: queued for its home, which draws the card. Like
/// the local path, the question is the one the send carried, else the one the brief
/// holds, which is spent only once the event is queued.
fn queue_remote_answer(state: &Arc<DaemonState>, sub_id: &str, card: AnswerCard) -> Option<CardEntry> {
    let brief = crate::sessions::chat_config::get(sub_id).and_then(|c| c.subchat);
    let handed = brief.as_ref().and_then(|b| b.question.clone());
    let question = card.question.filter(|q| !q.trim().is_empty()).or(handed);
    let kind = if card.kind == KIND_RATING { KIND_RATING } else { KIND_ANSWER };
    let event = super::remote::events::CardEvent {
        kind: kind.into(),
        verdict: card.verdict,
        tone: card.tone,
        text: card.text,
        points: card.points,
        details: card.details,
        visuals: card.visuals,
        question,
    };
    if super::remote::events::queue_card(state, sub_id, event) {
        if let Some(mut b) = brief.filter(|b| b.question.is_some()) {
            b.question = None;
            crate::sessions::chat_config::set_subchat(sub_id, Some(b));
        }
    }
    None
}

/// What an `update_message` changes on the card: new text and details, or a retract.
#[derive(Clone, Debug, Default)]
pub struct AnswerUpdate {
    pub text: Option<String>,
    /// `Some` replaces the details (an empty list clears them); `None` keeps them.
    pub details: Option<Vec<CardDetail>>,
    /// `Some` replaces the visuals (an empty list clears them); `None` keeps them.
    pub visuals: Option<Vec<serde_json::Value>>,
    pub retract: bool,
    /// The `message` ordinal the `update_message` carried: 1 is the sub's newest message.
    pub ordinal: u64,
}

/// Rewrites the card the update's ordinal names among `sub_id`'s sends this turn
/// and announces it again. `None` when that message drew no card or belongs to an
/// earlier turn, which the daemon cannot place.
pub fn on_answer_update(state: &Arc<DaemonState>, sub_id: &str, update: AnswerUpdate) -> Option<CardEntry> {
    let root = crate::settings::paths::data_dir().ok()?;
    let parent = state.registry.get(sub_id)?.subchat_of.clone()?;
    on_answer_update_in(&root, state, &parent, sub_id, update)
}

pub(crate) fn on_answer_update_in(
    root: &Path,
    state: &Arc<DaemonState>,
    parent: &str,
    sub_id: &str,
    update: AnswerUpdate,
) -> Option<CardEntry> {
    let gen = state.registry.current_turn_gen(sub_id);
    let id = {
        let mut map = TURN_SENDS.lock().unwrap_or_else(|p| p.into_inner());
        let (at, sends) = map.as_mut()?.get_mut(sub_id)?;
        if *at != gen || update.ordinal < 1 || update.ordinal as usize > sends.len() {
            return None;
        }
        let i = sends.len() - update.ordinal as usize;
        let id = sends[i].clone();
        // A retracted message no longer counts toward the ordinal.
        if update.retract {
            sends.remove(i);
        }
        id?
    };
    let _guard = LOG_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let mut entries = read_in(root, parent);
    let entry = entries.iter_mut().find(|e| e.id == id)?;
    if update.retract {
        entry.retracted = true;
    }
    if let Some(t) = update.text {
        entry.text = t;
    }
    if let Some(d) = update.details {
        entry.details = d;
    }
    if let Some(v) = update.visuals {
        entry.visuals = v;
    }
    let changed = entry.clone();
    if let Err(e) = replace_line(root, parent, &changed) {
        log::warn!("subchats: could not rewrite card {id} for {parent}: {e}");
        return None;
    }
    state.notifier.publish(NOTIFY, json!({ "session_id": parent, "card": changed, "replace": true }));
    Some(changed)
}

/// Replaces the line holding `entry.id` through a temp file, so a crash mid-write
/// leaves the old log. Every other line is kept byte for byte, including one this
/// build cannot parse (a torn write, or a newer build's schema).
fn replace_line(root: &Path, parent: &str, entry: &CardEntry) -> std::io::Result<()> {
    let path = log_path(root, parent).ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "bad parent id"))?;
    let raw = std::fs::read_to_string(&path)?;
    let mut body = String::with_capacity(raw.len());
    for line in raw.lines() {
        let is_it = serde_json::from_str::<CardEntry>(line).is_ok_and(|e| e.id == entry.id);
        body.push_str(&if is_it { serde_json::to_string(entry).map_err(std::io::Error::other)? } else { line.to_string() });
        body.push('\n');
    }
    let tmp = path.with_extension("jsonl.tmp");
    std::fs::write(&tmp, body)?;
    std::fs::rename(&tmp, &path)
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
    let Some(inst) = state.registry.get(sub_id) else { return Vec::new() };
    let Some(parent) = inst.subchat_of.clone() else { return Vec::new() };
    let Some(record) = finish::read_record_in(root, sub_id) else { return Vec::new() };
    let log = read_in(root, &parent);
    let check = super::project::check_mode(state, &inst.cwd);
    let facts = sub_facts(&inst, check, record.reviewer_tool_use_id.as_deref(), &log, transcript.as_deref());
    draw_finish_and_all(root, state, &parent, &sub_name(&inst), &inst.model, &inst.effort, &record, facts, None)
}

/// The finish card of a sub that runs on another machine, from the facts its host
/// computed (this machine can read neither its git nor its transcript), then the
/// "all finished" card if that was the last one. `merged` is what this machine
/// knows of the landing in its own checkout: the host cannot say.
pub(crate) fn draw_remote_finish_at(
    root: &Path,
    state: &Arc<DaemonState>,
    rec: &super::remote::records::RemoteSub,
    mut facts: Facts,
    model: &str,
    effort: &str,
    merged: Option<bool>,
) -> Vec<CardEntry> {
    let Some(record) = finish::read_record_in(root, &rec.sub_id) else { return Vec::new() };
    if !rec.target.is_empty() {
        facts.merged_into = Some(rec.target.clone());
        facts.merged = merged;
    }
    let machine = super::remote::machine_label(state, &rec.machine_id);
    draw_finish_and_all(root, state, &rec.main_id, &remote_sub_name(rec), model, effort, &record, facts, machine)
}

/// How a remote sub's card names it: the name the main chat gave it at spawn.
fn remote_sub_name(rec: &super::remote::records::RemoteSub) -> String {
    match crate::util::text::flat_clip(&rec.name, 80) {
        n if n.is_empty() => rec.sub_id.chars().take(8).collect(),
        n => n,
    }
}

/// What a visiting sub's host sent for a card, already cut by the home.
pub(crate) struct RemoteCard {
    pub kind: String,
    pub text: String,
    pub verdict: String,
    pub tone: Option<String>,
    pub points: Vec<String>,
    pub details: Vec<CardDetail>,
    pub visuals: Vec<serde_json::Value>,
    pub question: Option<String>,
}

/// Draws a remote sub's `blocker`, `answer` or `rating` in its main chat: the same card a
/// local sub draws, with the sub's name from the home's record and the machine it ran on.
/// `None` when it was already stored or the kind is not one that draws.
pub(crate) fn draw_remote_card_at(
    root: &Path,
    state: &Arc<DaemonState>,
    rec: &super::remote::records::RemoteSub,
    card: RemoteCard,
) -> Option<CardEntry> {
    let kind = match card.kind.as_str() {
        KIND_BLOCKER => KIND_BLOCKER,
        KIND_RATING => KIND_RATING,
        KIND_ANSWER => KIND_ANSWER,
        _ => return None,
    };
    let answer = kind != KIND_BLOCKER;
    let entry = CardEntry {
        id: format!("{kind}-{}", uuid::Uuid::new_v4()),
        ts: now_ms(),
        parent_id: rec.main_id.clone(),
        kind: kind.into(),
        sub_id: Some(rec.sub_id.clone()),
        sub_name: Some(remote_sub_name(rec)),
        verdict: card.verdict,
        tone: card.tone,
        text: card.text,
        points: card.points,
        details: if answer { card.details } else { Vec::new() },
        visuals: if answer { card.visuals } else { Vec::new() },
        question: if answer { card.question } else { None },
        machine: super::remote::machine_label(state, &rec.machine_id),
        ..CardEntry::default()
    };
    store_and_announce(state, root, &entry).then_some(entry)
}



/// [`draw_remote_finish_at`] for the finish hook: off the caller's thread, like
/// [`on_finished`], because a card is drawn under the log lock.
pub fn on_remote_finished(state: &Arc<DaemonState>, sub_id: &str, facts: Facts, model: String, effort: String, merged: Option<bool>) {
    let Some(rec) = super::remote::records::get(sub_id) else { return };
    #[cfg(test)]
    {
        if let Some(root) = super::decisions::data_root() {
            draw_remote_finish_at(&root, state, &rec, facts, &model, &effort, merged);
        }
    }
    #[cfg(not(test))]
    {
        let state = state.clone();
        let spawned = std::thread::Builder::new().name("subchat-card".into()).spawn(move || {
            let Ok(root) = crate::settings::paths::data_dir() else { return };
            draw_remote_finish_at(&root, &state, &rec, facts, &model, &effort, merged);
        });
        if let Err(e) = spawned {
            log::warn!("subchats: could not start the card thread for remote sub {sub_id}: {e}");
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn draw_finish_and_all(
    root: &Path,
    state: &Arc<DaemonState>,
    parent: &str,
    name: &str,
    model: &str,
    effort: &str,
    record: &finish::FinishRecord,
    facts: Facts,
    machine: Option<String>,
) -> Vec<CardEntry> {
    let mut drawn = Vec::new();
    let sub_id = record.sub_id.as_str();
    let finish_entry = CardEntry {
        id: format!("finish-{sub_id}-{}", record.round),
        ts: now_ms(),
        parent_id: parent.to_string(),
        kind: KIND_FINISH.into(),
        sub_id: Some(sub_id.to_string()),
        sub_name: Some(name.to_string()),
        round: Some(record.round),
        model: Some(model.to_string()).filter(|m| !m.is_empty()),
        effort: Some(effort.to_string()).filter(|e| !e.is_empty()),
        verdict: if record.verdict.is_empty() { "Finished".into() } else { record.verdict.clone() },
        tone: record.tone.clone(),
        text: record.text.clone(),
        points: record.points.clone(),
        done: record.done.clone(),
        not_done: record.not_done.clone(),
        waiting_on: record.waiting_on.clone(),
        your_move: record.your_move.clone(),
        facts: Some(facts),
        question: record.question.clone(),
        machine,
        ..CardEntry::default()
    };
    if store_and_announce(state, root, &finish_entry) {
        drawn.push(finish_entry);
    }
    // After this sub's own card is stored, and under the log lock from the read to
    // the write: a sibling's thread that stored its card first is then in the sum,
    // and two threads cannot both find the set undrawn and each draw it.
    let _guard = LOG_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(all) = all_finished_entry(state, root, parent) {
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
    // Local rows and subs recorded on other machines: the card is about the whole family.
    let subs = super::family::live_subs(state, parent);
    if subs.is_empty() || subs.iter().any(|m| !m.finished) {
        return None;
    }
    let log = read_in(root, parent);
    let waiting_for_a_card = subs.iter().any(|m| {
        let round = finish::read_record_in(root, &m.sub_id).map_or(0, |r| r.round);
        round > 0 && !log.iter().any(|e| e.id == format!("finish-{}-{round}", m.sub_id))
    });
    if waiting_for_a_card {
        return None;
    }
    let since = log.iter().rposition(|e| e.kind == KIND_ALL_FINISHED).map_or(0, |i| i + 1);
    // Each live sub's latest report in the batch, in the order the subs finished.
    let mut batch: Vec<&CardEntry> = Vec::new();
    for e in log[since..].iter().filter(|e| e.kind == KIND_FINISH) {
        let Some(id) = e.sub_id.as_deref() else { continue };
        if !subs.iter().any(|m| m.sub_id == id) {
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
        on_blocker_at(root.path(), &st, &subs[0], card("a-old", "Merge conflict")).unwrap();
        on_app_blocker(&st, &subs[0], Some(root.path()), card("a1", "Worktree kept")).unwrap();
        on_app_blocker(&st, &subs[0], Some(root.path()), card("a2", "Worktree kept")).unwrap();
        on_app_blocker(&st, &subs[1], Some(root.path()), card("b1", "Worktree kept")).unwrap();
        record(root.path(), &subs[0], 1, "Done");
        st.registry.set_subchat_finished(&subs[0], true);
        draw_finish_at(root.path(), &st, &subs[0], None);
        let mut rx = st.notifier.subscribe();

        assert_eq!(retract_blockers_in(root.path(), &st, &main, &subs[0]), 3, "the two app cards and the old landing card");
        assert_eq!(retract_blockers_in(root.path(), &st, &main, &subs[0]), 0, "once is enough");

        let log = read_in(root.path(), &main);
        let open: Vec<_> = log.iter().filter(|e| e.kind == KIND_BLOCKER && !e.retracted).map(|e| e.text.as_str()).collect();
        assert_eq!(open, vec!["a-sent", "b1"], "the sub's own blocker and another sub's stay");
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
}
