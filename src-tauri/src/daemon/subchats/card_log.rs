//! The cards a sub puts in its main chat's window: its verdict when it finishes,
//! a `blocker` it sends, and one "all finished" card when the last running sub
//! is done. Drawn by code from the finish record and from git and the
//! transcript (`facts/`), never by the main agent.
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

/// A visiting sub's card that could not be queued for its home: nothing will draw it there.
/// The caller says so to the sub, which can send it again.
#[derive(Debug, PartialEq, Eq)]
pub struct CardLost;

/// `Ok` when `queued`; else the card is lost: logged as an error (the release report reads
/// those) and returned so the sub is told.
fn lost_unless(queued: bool, sub_id: &str) -> Result<(), CardLost> {
    if queued {
        return Ok(());
    }
    log::error!("subchats: a card of visiting sub {sub_id} could not be queued for its home and was not drawn");
    Err(CardLost)
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

/// How a remote sub's card names it: the name the main chat gave it at spawn.
fn remote_sub_name(rec: &super::remote::records::RemoteSub) -> String {
    match crate::util::text::flat_clip(&rec.name, 80) {
        n if n.is_empty() => rec.sub_id.chars().take(8).collect(),
        n => n,
    }
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

mod answers;
mod blockers;
mod remote_cards;
mod reports;
#[cfg(test)]
mod tests;

pub use answers::*;
pub use blockers::*;
pub(crate) use remote_cards::*;
pub use reports::*;
