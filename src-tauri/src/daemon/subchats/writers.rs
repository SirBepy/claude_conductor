//! The writer slot: under "Subs changing files: One at a time", one sub per
//! project edits files at a time (spec section 7). Cognition's rule applies:
//! writes stay single-threaded. Read-only subs run freely. So does a writer in
//! its own worktree (`worktree`), which cannot collide with anyone. A gate sub
//! pushes from the main checkout, so it takes the slot like any writer and
//! queues behind one: pushing while another sub is mid-write is what the slot
//! prevents. Under "Worktree each" writers hold no slot, and a gate takes a
//! project-wide slot that only other gates contend for, after the merges in flight.
//!
//! Who is in the slot, per project (`project_key` of the sub's folder):
//! - `holder`: the one sub allowed to edit now.
//! - `queue`: subs waiting, in order, of two kinds. A [`Kind::Launch`] is a sub
//!   held at spawn: its row and brief exist and no child has started. Its recipe
//!   (the first message, the tier, the account) lives in [`super::held`], the
//!   one place a registered sub with no child is kept, so it shows in the list,
//!   holds no cap slot (it has no process), is exempt from the dead and ceiling
//!   sweeps and survives a restart there. A [`Kind::Wake`] is a sub that is already running
//!   (a follow-up with `writes: true`, a continued writer, or one that lost the
//!   slot while it waited on Joe): it carries on read-only and is woken when the
//!   slot reaches it.
//!
//! The slot is enforced where a write happens, not where it is asked for: a
//! sub's `PreToolUse` hook (`hooks_server::subchat_write_guard`) asks
//! [`check_write`] before every Edit, Write and NotebookEdit. A sub that does
//! not hold the slot is refused and queued right there, so a path that forgot
//! to ask for the slot (a restart, a continue, a crash, a sub started by
//! `after`) is still covered. It is a guard, not a sandbox: Bash can still write.
//!
//! A holder lets go on finish, end, crash and "Move to sidebar", and while it
//! waits on Joe with its own work committed (it takes the slot again, or queues
//! for it, at its next write). When Joe answers and another sub has the slot by
//! then, the answering sub is NOT held back: it is told at its first write
//! attempt, queued as a Wake, and woken when the slot is free. Holding its
//! answer instead would mean holding a card answer already delivered.
//!
//! Only the Launch entries outlive a restart (through the held file), because a
//! restart ends every turn: the holder's process is gone, and a Wake entry has no
//! intent left to carry out (the sub takes the slot again at its next write). At
//! boot the Launch queue is rebuilt from the held set and its head starts if the
//! slot is free.

use super::held::{self, Held, LaunchSpec, Why};
use super::project;
use super::spawn::SubPlan;
use super::{resume, tool, ContinueError};
use crate::daemon::state::DaemonState;
use crate::sessions::chat_config::ChatConfig;
use crate::settings::identity::project_key;
use crate::types::SubchatWriters;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::{Arc, Mutex};

/// What a woken sub is told when the slot reaches it. A constant, never built
/// from anything a sub wrote, so it is safe as `is_meta` text.
pub const SLOT_FREE_TEXT: &str = "The writer slot is yours now: no other sub is editing files in this project. Carry on with your edits.";

/// The words a waiting sub's row shows.
pub const QUEUED_TEXT: &str = "waiting for the writer before it";

/// Refusal for an edit by a sub that was spawned read-only. Says it is a guard
/// and not a sandbox, and names the way to write access.
pub const READ_ONLY_REFUSAL: &str = "This sub is read-only (its brief said writes: false), so Edit, Write and NotebookEdit are refused. This is a guard, not a sandbox: Bash could still write a file, but do not use it to get around this. If the job needs file changes, finish with finish_subchat and say so: the main chat then sends you a follow-up with writes: true, which gives you write access.";

/// Suffix of the slot a gate sub uses under "Worktree each", where writers do
/// not use a slot at all: only other gates contend for it.
const GATE_SLOT: &str = "#gate";

/// Which slot a sub with this brief takes, `None` when none applies.
///
/// A read-only sub never takes one. A worktree sub never does either, because its
/// own tree is what keeps it from colliding: that is read from the brief's stored
/// tree, not from the project setting, since a sub spawned before the setting
/// changed (or in a folder that could not have a worktree) still shares the main
/// checkout and must queue. A gate sub pushes from the main checkout, so it takes
/// the project's slot like any writer; under "Worktree each", where writers hold
/// none, it takes a project-wide slot of its own that only other gates contend
/// for. Every gate waits for merges in flight before it starts, so it pushes what
/// the worktree subs just landed.
fn slot_key(mode: SubchatWriters, brief: &super::SubchatBrief, cwd: &Path) -> Option<String> {
    if !brief.writes || (brief.worktree_at.is_some() && !brief.gate) {
        return None;
    }
    let key = project_key(cwd);
    Some(if brief.gate && mode == SubchatWriters::WorktreeEach { format!("{key}{GATE_SLOT}") } else { key })
}

/// The project key a slot key belongs to, for the merge wait.
fn repo_of(slot_key: &str) -> String {
    slot_key.strip_suffix(GATE_SLOT).unwrap_or(slot_key).to_string()
}

#[derive(Clone, Debug, PartialEq)]
enum Kind {
    /// Unstarted: [`held::launch_held`] starts its child when the slot arrives.
    Launch,
    /// Running: wake it when the slot arrives.
    Wake,
}

#[derive(Clone, Debug)]
struct Entry {
    sub_id: String,
    kind: Kind,
    /// A gate: it does not take the slot while a worktree sub's merge into the
    /// same repo is still running.
    after_merges: bool,
}

#[derive(Default)]
struct Slot {
    /// The project key whose merges an `after_merges` entry waits for.
    repo: String,
    holder: Option<String>,
    /// When a spawn took the slot for a child whose row does not exist yet. A
    /// spawn spends seconds between claiming the slot and registering its row,
    /// and a holder with no row would otherwise read as stale and be dropped.
    claimed_at: Option<std::time::Instant>,
    queue: Vec<Entry>,
}

/// How long a claim without a row is believed. A spawn that has not registered
/// its row by then failed without releasing.
const CLAIM_GRACE: std::time::Duration = std::time::Duration::from_secs(120);

impl Slot {
    /// Drops a holder that is no longer a live sub, so a missed release cannot
    /// hold a project's slot forever.
    fn heal(&mut self, state: &DaemonState) {
        let Some(h) = self.holder.as_deref() else { return };
        let pending = state.registry.get(h).is_none() && self.claimed_at.is_some_and(|t| t.elapsed() < CLAIM_GRACE);
        if !alive(state, h) && !pending {
            self.holder = None;
        }
    }
}

/// project key -> slot. Process-wide like `runtime`, so the lanes that edit
/// `DaemonState` do not collide here; a project key is a folder, and a daemon has
/// one registry, so nothing else keys it.
static TABLE: Mutex<BTreeMap<String, Slot>> = Mutex::new(BTreeMap::new());

fn table() -> std::sync::MutexGuard<'static, BTreeMap<String, Slot>> {
    TABLE.lock().unwrap_or_else(|p| p.into_inner())
}

/// What the work of starting a sub the slot just reached looks like.
#[derive(Clone, Debug, PartialEq)]
pub enum Start {
    /// Start the held sub's child, with the recipe `held` keeps.
    Launch { sub_id: String },
    Wake { sub_id: String },
}

/// What a spawn decided about the slot, made before any child exists.
#[derive(Clone, Debug)]
pub struct SpawnDecision {
    /// The session id the sub will have, minted here so a queued sub's row and its
    /// later child share it.
    pub sid: String,
    /// True when the child must NOT start now: the slot is taken.
    pub queued: bool,
}

/// The answer to asking for the slot.
#[derive(Clone, Debug, PartialEq)]
pub enum SlotOutcome {
    Granted,
    Queued {
        /// Name of the sub holding the slot, or the head of the queue.
        behind: String,
        /// 1 is next.
        position: usize,
    },
}

/// What the write guard decides for one Edit, Write or NotebookEdit.
#[derive(Clone, Debug, PartialEq)]
pub enum WriteCheck {
    Allow,
    /// The sub was spawned read-only.
    ReadOnly,
    /// Another sub holds the slot; this one is now queued for it.
    Wait { holder: String },
}

fn label_of(state: &DaemonState, sub_id: &str) -> String {
    state.registry.get(sub_id).map(|i| tool::label(&i)).unwrap_or_else(|| sub_id.chars().take(8).collect())
}

/// A holder or queued sub that is still a live sub: it has a row, is a sub, is
/// not ended and not finished.
fn alive(state: &DaemonState, sub_id: &str) -> bool {
    state
        .registry
        .get(sub_id)
        .is_some_and(|i| i.subchat_of.is_some() && i.ended_at.is_none() && i.end_reason.is_none() && !i.subchat_finished)
}

/// Whether this daemon's registry knows anyone in the slot. A daemon has one
/// registry and every sub in the table is its own, so this is always true in
/// production; it keeps a sweep or a restore run against one registry from
/// judging the slots another registry in the same process (a parallel unit test)
/// put there.
fn is_known(state: &DaemonState, slot: &Slot) -> bool {
    slot.holder
        .as_deref()
        .into_iter()
        .chain(slot.queue.iter().map(|e| e.sub_id.as_str()))
        .any(|id| state.registry.get(id).is_some())
}

/// Moves the queue's head into an empty slot, repeatedly past stale entries.
/// Returns what to start. Caller holds the table lock.
fn advance_locked(state: &DaemonState, slot: &mut Slot) -> Vec<Start> {
    let mut starts = Vec::new();
    slot.heal(state);
    while slot.holder.is_none() && !slot.queue.is_empty() {
        // Nobody behind a gate overtakes it: the queue stays in order.
        if slot.queue[0].after_merges && super::worktree::merging(&slot.repo) {
            break;
        }
        let entry = slot.queue.remove(0);
        if !alive(state, &entry.sub_id) {
            // A queued row that ended by a path that did not call `release`: its
            // recipe is forgotten too, so it can never start later.
            clear_wait(state, &entry);
            continue;
        }
        slot.holder = Some(entry.sub_id.clone());
        starts.push(match entry.kind {
            Kind::Launch => Start::Launch { sub_id: entry.sub_id },
            Kind::Wake => {
                state.registry.set_waiting_for(&entry.sub_id, None);
                Start::Wake { sub_id: entry.sub_id }
            }
        });
    }
    starts
}

/// Takes a queued entry's "waiting" state off its row and, for an unstarted sub,
/// forgets its held recipe.
fn clear_wait(state: &DaemonState, entry: &Entry) {
    match entry.kind {
        Kind::Launch => {
            held::release(state, &entry.sub_id);
        }
        Kind::Wake => {
            state.registry.set_waiting_for(&entry.sub_id, None);
        }
    }
}

fn queue_position(slot: &Slot, sub_id: &str) -> Option<usize> {
    slot.queue.iter().position(|e| e.sub_id == sub_id).map(|i| i + 1)
}

fn behind(state: &DaemonState, slot: &Slot) -> String {
    slot.holder.as_deref().map(|h| label_of(state, h)).unwrap_or_else(|| "another sub".to_string())
}

/// The slot `table` holds for `key`, made on first use.
fn slot_in<'a>(table: &'a mut BTreeMap<String, Slot>, key: &str) -> &'a mut Slot {
    let slot = table.entry(key.to_string()).or_default();
    if slot.repo.is_empty() {
        slot.repo = repo_of(key);
    }
    slot
}

/// Decides the slot for a sub about to be spawned. A read-only sub and a
/// worktree sub (see [`slot_key`]) are never held. A writer takes a free slot at
/// once, or joins the queue as an unstarted Launch and must then be registered
/// with [`register_queued`]. A gate also queues while a merge is running.
pub fn decide_spawn(state: &DaemonState, brief: &super::SubchatBrief, cwd: &Path) -> SpawnDecision {
    let sid = uuid::Uuid::new_v4().to_string();
    let Some(key) = slot_key(project::writers_mode(state, cwd), brief, cwd) else {
        return SpawnDecision { sid, queued: false };
    };
    let mut table = table();
    let slot = slot_in(&mut table, &key);
    slot.heal(state);
    let merge_wait = brief.gate && super::worktree::merging(&slot.repo);
    if slot.holder.is_none() && slot.queue.is_empty() && !merge_wait {
        slot.holder = Some(sid.clone());
        slot.claimed_at = Some(std::time::Instant::now());
        return SpawnDecision { sid, queued: false };
    }
    slot.queue.push(Entry { sub_id: sid.clone(), kind: Kind::Launch, after_merges: brief.gate });
    SpawnDecision { sid, queued: true }
}

/// Registers the row of a sub [`decide_spawn`] queued and hands its recipe to
/// [`held`], which keeps it across a restart and starts it on request. No child
/// is started. `after` is left unset on the held entry, so the `after` pass
/// ([`held::release_ready`]) never starts it: the slot does.
pub async fn register_queued(
    state: &Arc<DaemonState>,
    caller_session_id: &str,
    name: Option<&str>,
    inherited: &ChatConfig,
    mut spec: LaunchSpec,
    plan: &mut SubPlan,
    sid: &str,
) -> Result<String, String> {
    let default_account_id = state.settings.snapshot().default_account_id;
    let account = crate::accounts::resolve_account(spec.account_id.as_deref(), default_account_id.as_deref()).map_err(|e| {
        release_entry_only(state, sid);
        e.to_string()
    })?;
    spec.account_id = Some(account.id);
    register_queued_row(state, caller_session_id, name, inherited, spec, plan, sid)
}

/// [`register_queued`] once the account is resolved, so a test needs no accounts file.
pub(crate) fn register_queued_row(
    state: &Arc<DaemonState>,
    caller_session_id: &str,
    name: Option<&str>,
    inherited: &ChatConfig,
    spec: LaunchSpec,
    plan: &mut SubPlan,
    sid: &str,
) -> Result<String, String> {
    held::register_held_row(state, caller_session_id, name, inherited, spec, plan, sid.to_string(), QUEUED_TEXT.to_string(), None)
        .inspect_err(|_| release_entry_only(state, sid))
}

/// Asks for the writer slot for a running or finished sub: the one door
/// `subchat send` with `writes: true` calls, and what a continued writer calls
/// when it wakes. Granted when the slot is free or already this sub's; otherwise
/// the sub joins the queue as a Wake and keeps running read-only.
pub fn request_slot(state: &Arc<DaemonState>, sub_id: &str) -> SlotOutcome {
    let Some(inst) = state.registry.get(sub_id) else { return SlotOutcome::Granted };
    let Some(brief) = crate::sessions::chat_config::get(sub_id).and_then(|c| c.subchat) else { return SlotOutcome::Granted };
    let Some(key) = slot_key(project::writers_mode(state, &inst.cwd), &brief, &inst.cwd) else {
        return SlotOutcome::Granted;
    };
    let mut table = table();
    let slot = slot_in(&mut table, &key);
    slot.heal(state);
    if slot.holder.as_deref() == Some(sub_id) {
        return SlotOutcome::Granted;
    }
    if let Some(position) = queue_position(slot, sub_id) {
        return SlotOutcome::Queued { behind: behind(state, slot), position };
    }
    if slot.holder.is_none() && slot.queue.is_empty() {
        slot.holder = Some(sub_id.to_string());
        return SlotOutcome::Granted;
    }
    slot.queue.push(Entry { sub_id: sub_id.to_string(), kind: Kind::Wake, after_merges: brief.gate });
    let outcome = SlotOutcome::Queued { behind: behind(state, slot), position: slot.queue.len() };
    drop(table);
    state.registry.set_waiting_for(sub_id, Some(QUEUED_TEXT.to_string()));
    crate::daemon::machines::publish_instances_changed(state);
    outcome
}

/// The `PreToolUse` check for Edit, Write and NotebookEdit by a sub. `Allow` also
/// for anything that is not a sub or has no brief: this guard never blocks a chat
/// it does not manage. A gate sub is a writer here: its brief has `writes: true`
/// and no `files`, which is why the guard reads `writes` and never the file list.
pub fn check_write(state: &Arc<DaemonState>, sub_id: &str) -> WriteCheck {
    let Some(inst) = state.registry.get(sub_id) else { return WriteCheck::Allow };
    if !super::is_sub(&inst) {
        return WriteCheck::Allow;
    }
    let Some(brief) = crate::sessions::chat_config::get(sub_id).and_then(|c| c.subchat) else {
        return WriteCheck::Allow;
    };
    if !brief.writes {
        return WriteCheck::ReadOnly;
    }
    match request_slot(state, sub_id) {
        SlotOutcome::Granted => WriteCheck::Allow,
        SlotOutcome::Queued { behind, .. } => WriteCheck::Wait { holder: behind },
    }
}

/// What the guard says to a sub that must wait.
pub fn wait_refusal(holder: &str) -> String {
    format!(
        "Another sub (\"{holder}\") holds this project's writer slot, so your edit is refused: only one sub changes files at a time. You are queued. Do not edit files and do not look for another way to write them. Read, plan and test what you can, then end your turn without calling finish_subchat: while you are queued, ending a turn is not counted as unfinished, and you are sent a message the moment the slot is yours."
    )
}

/// The name of the sub holding the slot `sub_id` is queued for, while it waits in
/// any slot's queue (a running sub woken later, or one not started yet). `None`
/// once the slot is its own or it waits for nothing. The Stop hook and the stall
/// sweeps read it: a queued sub ending its turn is doing what the guard told it.
/// A slot whose holder is gone (a release that never came) does not count: the
/// sweep starts the next sub there, and until then the sub is judged as usual,
/// so a missed release can never hide a stall.
pub fn waiting_behind(state: &DaemonState, sub_id: &str) -> Option<String> {
    let mut table = table();
    let slot = table.values_mut().find(|s| s.queue.iter().any(|e| e.sub_id == sub_id))?;
    slot.heal(state);
    slot.holder.as_ref()?;
    Some(behind(state, slot))
}

/// Lets go of everything `sub_id` holds or waits for, and starts whoever is next.
/// Called when a sub finishes, ends, crashes, moves to the sidebar, or waits on
/// Joe with its work committed. A sub still waiting as an unstarted Launch loses
/// its held recipe too: it was ended, and must never start later.
pub fn release(state: &Arc<DaemonState>, sub_id: &str) {
    let starts = leave(state, sub_id, true);
    finish_release(state, starts);
}

/// [`release`] without forgetting a held recipe: a launch that failed keeps its
/// held entry, so Joe's "Try again" can still start it.
fn release_entry_only(state: &Arc<DaemonState>, sub_id: &str) {
    let starts = leave(state, sub_id, false);
    finish_release(state, starts);
}

fn finish_release(state: &Arc<DaemonState>, starts: Vec<Start>) {
    if !starts.is_empty() {
        crate::daemon::machines::publish_instances_changed(state);
    }
    run_starts(state, starts);
}

fn leave(state: &Arc<DaemonState>, sub_id: &str, forget_recipe: bool) -> Vec<Start> {
    let key = state.registry.get(sub_id).map(|i| project_key(&i.cwd));
    let mut starts = Vec::new();
    let mut removed: Vec<Entry> = Vec::new();
    {
        let mut table = table();
        for (k, slot) in table.iter_mut() {
            let owns = slot.holder.as_deref() == Some(sub_id) || slot.queue.iter().any(|e| e.sub_id == sub_id);
            // A row that is gone cannot name its project, so every slot is searched.
            if !owns && key.as_deref() != Some(k.as_str()) {
                continue;
            }
            if slot.holder.as_deref() == Some(sub_id) {
                slot.holder = None;
            }
            slot.queue.retain(|e| {
                if e.sub_id == sub_id {
                    removed.push(e.clone());
                    false
                } else {
                    true
                }
            });
            starts.extend(advance_locked(state, slot));
        }
    }
    for entry in &removed {
        match entry.kind {
            Kind::Launch if !forget_recipe => {}
            _ => clear_wait(state, entry),
        }
    }
    starts
}

/// A sub just posted a question card for Joe. If it holds the slot and every
/// file it edited is committed, it lets the slot go while it waits, so the next
/// sub can start; it takes the slot again at its next write. Uncommitted work
/// keeps it: letting a second writer into the tree beside half-written files is
/// what the slot prevents.
pub async fn on_waiting_on_joe(state: &Arc<DaemonState>, sub_id: &str) {
    let transcript = crate::context_status::resolve_transcript(&state.registry, sub_id);
    on_waiting_on_joe_with(state, sub_id, transcript).await;
}

pub(crate) async fn on_waiting_on_joe_with(state: &Arc<DaemonState>, sub_id: &str, transcript: Option<std::path::PathBuf>) {
    let Some(inst) = state.registry.get(sub_id) else { return };
    // Any slot, not the project's: a gate under "Worktree each" holds its own.
    if !table().values().any(|s| s.holder.as_deref() == Some(sub_id)) {
        return;
    }
    let cwd = inst.cwd.clone();
    let dirty = match transcript {
        Some(t) => tokio::task::spawn_blocking(move || super::git::own_uncommitted(&t, &cwd)).await.unwrap_or_default(),
        None => Vec::new(),
    };
    if dirty.is_empty() {
        release(state, sub_id);
    }
}

/// The sub holding the slot of the project `cwd` is in.
pub fn holder_of(cwd: &Path) -> Option<String> {
    table().get(&project_key(cwd)).and_then(|s| s.holder.clone())
}

/// The gate sub holding the project-wide gate slot that "Worktree each" uses.
pub fn gate_holder_of(cwd: &Path) -> Option<String> {
    table().get(&format!("{}{GATE_SLOT}", project_key(cwd))).and_then(|s| s.holder.clone())
}

/// The subs waiting for the slot of the project `cwd` is in, next first.
pub fn queue_of(cwd: &Path) -> Vec<String> {
    table().get(&project_key(cwd)).map(|s| s.queue.iter().map(|e| e.sub_id.clone()).collect()).unwrap_or_default()
}

/// Whether an unstarted sub held for the slot has nothing left in its way: no
/// queue entry names it (it can never be reached), or its slot has no live holder
/// and it is first in line. A sub behind a live holder or another waiter is
/// waiting as it should.
pub fn nothing_in_the_way(state: &DaemonState, sub_id: &str) -> bool {
    let table = table();
    let Some(slot) = table.values().find(|s| s.queue.iter().any(|e| e.sub_id == sub_id)) else { return true };
    // A holder with no row yet is a spawn still registering it: in the way.
    let holder_live = slot.holder.as_deref().is_some_and(|h| alive(state, h) || state.registry.get(h).is_none());
    let merge_wait = slot.queue.first().is_some_and(|e| e.after_merges) && super::worktree::merging(&slot.repo);
    !holder_live && !merge_wait && queue_position(slot, sub_id) == Some(1)
}

/// True while `sub_id` is an unstarted Launch entry.
pub fn is_unstarted(sub_id: &str) -> bool {
    table().values().any(|s| s.queue.iter().any(|e| e.sub_id == sub_id && e.kind == Kind::Launch))
}

/// What `spawn_chat` adds to its result when the sub was held. The sub's own card
/// shows Joe it is waiting, so the note tells the main chat not to repeat it.
/// `None` for a sub that started.
pub fn spawn_note(state: &DaemonState, sub_id: &str) -> Option<Value> {
    let tree_note = super::worktree::take_note(sub_id);
    let queued = queued_note(state, sub_id);
    match (queued, tree_note) {
        (Some(mut q), Some(t)) => {
            q["worktree_note"] = json!(t);
            Some(q)
        }
        (Some(q), None) => Some(q),
        (None, Some(t)) => Some(json!({ "worktree": super::worktree::is_worktree_sub(sub_id), "note": t })),
        (None, None) => None,
    }
}

fn queued_note(state: &DaemonState, sub_id: &str) -> Option<Value> {
    if !is_unstarted(sub_id) {
        return None;
    }
    let inst = state.registry.get(sub_id)?;
    let brief = crate::sessions::chat_config::get(sub_id).and_then(|c| c.subchat)?;
    let table = table();
    let slot = table.get(&slot_key(project::writers_mode(state, &inst.cwd), &brief, &inst.cwd)?)?;
    let position = queue_position(slot, sub_id)?;
    Some(json!({
        "queued": true,
        "queue_position": position,
        "note": queued_text(&behind(state, slot), brief.gate),
    }))
}

/// The queue note's text. A gate waits for the writer slot like any writer, so
/// when the main chat has told that writer to hold its commit until the gate
/// pushes, neither can ever move: the extra sentence says not to.
fn queued_text(behind: &str, gate: bool) -> String {
    let mut note = format!(
        "Queued, not started: only one sub changes files at a time in this project and \"{behind}\" has the writer slot. This sub starts by itself when it is free, in queue order, and you are not woken when it starts. This sub's own card already shows Joe it is waiting, so send no message or card of your own about it. Only when Joe's window shows no card for it, say so in one short line, and that he can say \"use worktrees\" to run writers side by side."
    );
    if gate {
        note.push_str(" This sub is a gate and waits for the writer to finish: do not tell that writer to hold back its commit or push until the gate pushes, or neither will ever start.");
    }
    note
}

/// The text `subchat send` adds when a follow-up put a sub in the queue.
pub fn send_note(sub_name: &str, behind: &str) -> String {
    format!(
        "{sub_name} is queued for the writer slot behind {behind}: it got the message and can read and plan, but its edits are refused until the slot is free, and it is woken then. The sub's own card already shows Joe it is waiting, so send no message or card of your own about it unless his window shows no card for it, and then one short line."
    )
}

// ---- starting the next sub ------------------------------------------------------

/// Runs what [`advance_locked`] returned. Detached: a launch respawns a child,
/// and awaiting that inside a pump handler is the self-referential future
/// `jarvis_wake::spawn_drain` documents. With no runtime (a sync unit test) the
/// start is logged and skipped.
fn run_starts(state: &Arc<DaemonState>, starts: Vec<Start>) {
    for start in starts {
        match tokio::runtime::Handle::try_current() {
            Ok(handle) => {
                let state = state.clone();
                handle.spawn(async move { run_start(&state, start).await });
            }
            Err(_) => log::warn!("subchats: no runtime to run {start:?}; it is left holding the slot"),
        }
    }
}

pub(crate) async fn run_start(state: &Arc<DaemonState>, start: Start) {
    match start {
        Start::Launch { sub_id } => {
            if let Err(e) = held::launch_held(state, &sub_id).await {
                log::warn!("subchats: could not start queued sub {sub_id}: {e}");
                // The next sub in line must not be stuck behind one that never
                // started. The held recipe stays, so Joe's "Try again" on the card
                // still starts it (and it takes the slot again at its first write).
                release_entry_only(state, &sub_id);
                if let Some(entry) = held::all().into_iter().find(|h: &Held| h.sub_id == sub_id) {
                    held::raise_decision(state, &entry, Why::LaunchFailed(e)).await;
                    held::set_parked(&sub_id, true);
                }
            }
        }
        Start::Wake { sub_id } => wake(state, &sub_id).await,
    }
}

/// Tells a running sub the slot is its own. A sub mid-turn gets the text at its
/// next step through the held queue; an idle one is nudged.
async fn wake(state: &Arc<DaemonState>, sub_id: &str) {
    let busy_live = state.registry.get(sub_id).is_some_and(|i| i.busy) && state.sessions.contains_key(sub_id);
    if !busy_live {
        if let Err(e) = resume::nudge(state, sub_id, SLOT_FREE_TEXT).await {
            log::warn!("subchats: could not tell {sub_id} the writer slot is free: {e}");
        }
        return;
    }
    let item = tool::hold(state, sub_id, SLOT_FREE_TEXT);
    let owner = state.clone();
    tool::flush_when_idle(
        state,
        sub_id,
        item,
        std::time::Duration::from_secs(2),
        move |id, text| {
            let state = owner.clone();
            async move { resume::nudge(&state, &id, &text).await.map_err(ContinueError::Send) }
        },
    )
    .await;
}

/// The 60 second tick's safety net: drops a holder or waiter that no longer is a
/// live sub (a path that ended it without calling [`release`]) and starts whoever
/// is next. Cheap when nothing is queued.
pub fn sweep(state: &Arc<DaemonState>) {
    let mut starts = Vec::new();
    let mut stale: Vec<Entry> = Vec::new();
    {
        let mut table = table();
        for slot in table.values_mut() {
            if !is_known(state, slot) {
                continue;
            }
            slot.queue.retain(|e| {
                let keep = alive(state, &e.sub_id);
                if !keep {
                    stale.push(e.clone());
                }
                keep
            });
            starts.extend(advance_locked(state, slot));
        }
        table.retain(|_, s| s.holder.is_some() || !s.queue.is_empty());
    }
    for entry in &stale {
        clear_wait(state, entry);
    }
    finish_release(state, starts);
}

// ---- restart --------------------------------------------------------------------

/// Rebuilds the Launch queue at boot from the held set (rows `after` does not
/// own) and starts the head of each project whose slot is free, which after a
/// restart is every one. Rows that ended or vanished are skipped: [`held`]'s own
/// pass forgets their recipe.
pub fn restore(state: &Arc<DaemonState>) {
    let starts = restore_inner(state);
    run_starts(state, starts);
    super::worktree::restore(state);
}

/// Puts a held writer that no queue entry names back in line, as at boot, and
/// starts the head if the slot is free. For a hold [`held::recover_lost`] rebuilt
/// while the daemon runs; an entry already queued or holding is left as it is.
pub(crate) fn requeue_held(state: &Arc<DaemonState>) {
    let starts = restore_inner(state);
    finish_release(state, starts);
}

pub(crate) fn restore_inner(state: &Arc<DaemonState>) -> Vec<Start> {
    let mut starts = Vec::new();
    let mut table = table();
    for h in held::all().into_iter().filter(|h| h.after.is_none()) {
        let Some(inst) = state.registry.get(&h.sub_id).filter(|i| alive(state, &i.session_id)) else { continue };
        // Anything held without an `after` is a writer by construction, whatever
        // its brief says now.
        let brief = crate::sessions::chat_config::get(&h.sub_id).and_then(|c| c.subchat);
        let (key, gate) = match brief {
            Some(mut b) => {
                b.writes = true;
                (slot_key(project::writers_mode(state, &inst.cwd), &b, &inst.cwd), b.gate)
            }
            None => (Some(project_key(&inst.cwd)), false),
        };
        // A worktree sub waits for its tree, not for a slot (`worktree::restore`).
        let Some(key) = key else { continue };
        let slot = slot_in(&mut table, &key);
        if slot.queue.iter().any(|e| e.sub_id == h.sub_id) || slot.holder.as_deref() == Some(h.sub_id.as_str()) {
            continue;
        }
        slot.queue.push(Entry { sub_id: h.sub_id, kind: Kind::Launch, after_merges: gate });
    }
    for slot in table.values_mut() {
        if !is_known(state, slot) {
            continue;
        }
        starts.extend(advance_locked(state, slot));
    }
    starts
}

#[cfg(test)]
pub(crate) fn forget_project_for_test(cwd: &Path) {
    table().remove(&project_key(cwd));
}

/// Queues `waiter` behind `holder` in the slot of `cwd` as a running sub woken
/// later, for tests outside this module that need a sub waiting on the slot. The
/// holder is a fresh claim, so it counts as live without a sub row of its own.
#[cfg(test)]
pub(crate) fn queue_behind_for_test(cwd: &Path, holder: &str, waiter: &str) {
    let mut table = table();
    let slot = slot_in(&mut table, &project_key(cwd));
    slot.holder = Some(holder.to_string());
    slot.claimed_at = Some(std::time::Instant::now());
    slot.queue.push(Entry { sub_id: waiter.to_string(), kind: Kind::Wake, after_merges: false });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::daemon::subchats::{git::test_repo, store_sub_brief, SubchatArgs, SubchatBrief, TempDataDir};
    use crate::types::Settings;
    use std::path::PathBuf;

    fn state() -> Arc<DaemonState> {
        DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()))
    }

    /// A parent plus a sub in `cwd`. `writes` is stored on its brief.
    fn sub(st: &DaemonState, tag: &str, cwd: &Path, writes: bool) -> String {
        let (parent, id) = (format!("{tag}-main"), format!("{tag}-sub"));
        st.registry.upsert_interactive(&parent, cwd, "proj", "2026-11-05T00:00:00Z");
        st.registry.upsert_interactive(&id, cwd, "proj", "2026-11-05T00:00:00Z");
        st.registry.set_subchat_of(&id, Some(parent.clone()));
        st.registry.set_name(&id, tag.to_string());
        store_sub_brief(&id, &parent);
        set_writes(&id, writes);
        id
    }

    fn set_writes(id: &str, writes: bool) {
        let mut brief: SubchatBrief = crate::sessions::chat_config::get(id).unwrap().subchat.unwrap();
        brief.writes = writes;
        crate::sessions::chat_config::set_subchat(id, Some(brief));
    }

    fn set_gate(id: &str) {
        let mut brief: SubchatBrief = crate::sessions::chat_config::get(id).unwrap().subchat.unwrap();
        brief.gate = true;
        brief.writes = true;
        brief.files = Vec::new();
        crate::sessions::chat_config::set_subchat(id, Some(brief));
    }

    fn brief(writes: bool) -> SubchatBrief {
        serde_json::from_str(&format!(r#"{{"parent":"m","task":"t","goal":"g","done_when":"d","writes":{writes}}}"#)).unwrap()
    }

    /// A project folder of its own, so no test shares a slot with another.
    fn project() -> (tempfile::TempDir, PathBuf) {
        test_repo::init()
    }

    fn spec(cwd: &Path, first: &str) -> LaunchSpec {
        LaunchSpec {
            cwd: cwd.to_path_buf(),
            model: "sonnet".into(),
            effort: "high".into(),
            account_id: Some("acct".into()),
            first_message: first.into(),
        }
    }

    /// Takes the slot for a writer the way a spawn does, then registers its row;
    /// a queued one gets its held recipe, as `register_queued` stores it.
    fn spawn_writer(st: &DaemonState, tag: &str, cwd: &Path, first: &str) -> (String, bool) {
        let d = decide_spawn(st, &brief(true), cwd);
        let (parent, id) = (format!("{tag}-main"), d.sid.clone());
        st.registry.upsert_interactive(&parent, cwd, "proj", "2026-11-05T00:00:00Z");
        st.registry.upsert_interactive(&id, cwd, "proj", "2026-11-05T00:00:00Z");
        st.registry.set_subchat_of(&id, Some(parent.clone()));
        st.registry.set_name(&id, tag.to_string());
        store_sub_brief(&id, &parent);
        set_writes(&id, true);
        if d.queued {
            held::hold(
                st,
                Held { sub_id: id.clone(), reason: QUEUED_TEXT.into(), after: None, after_name: String::new(), launch: spec(cwd, first) },
            )
            .unwrap();
        }
        (id, d.queued)
    }

    /// The slot reads the row, not the process: a finished holder whose `claude`
    /// is still running (dash-answers on 2026-11-10 kept pid 27316 after its
    /// finish) is not alive to the slot, so it never holds it for good.
    #[test]
    fn a_finished_holder_lets_the_next_writer_in_whatever_its_process_does() {
        let _data = TempDataDir::new();
        let (_d, root) = project();
        let st = state();
        let (first, _) = spawn_writer(&st, "linger-a", &root, "A");
        let (next, queued) = spawn_writer(&st, "linger-b", &root, "B");
        assert!(queued);
        assert!(!nothing_in_the_way(&st, &next), "a live holder is in the way");
        st.registry.set_subchat_finished(&first, true);
        assert!(nothing_in_the_way(&st, &next), "a finished holder is not");
        let starts = {
            let mut t = table();
            advance_locked(&st, t.get_mut(&project_key(&root)).unwrap())
        };
        assert_eq!(starts, vec![Start::Launch { sub_id: next.clone() }]);
        assert!(nothing_in_the_way(&st, "linger-nobody"), "a sub no queue names can never be reached");
    }

    #[test]
    fn a_read_only_sub_never_takes_the_slot_and_a_writer_takes_a_free_one() {
        let _data = TempDataDir::new();
        let (_d, root) = project();
        let st = state();
        let ro = decide_spawn(&st, &brief(false), &root);
        assert!(!ro.queued);
        assert_eq!(holder_of(&root), None, "a read-only sub holds nothing");
        let w = decide_spawn(&st, &brief(true), &root);
        assert!(!w.queued);
        assert_eq!(holder_of(&root).as_deref(), Some(w.sid.as_str()));
    }

    #[test]
    fn a_gate_on_an_idle_project_takes_the_slot_at_once_and_is_not_read_as_read_only() {
        let _data = TempDataDir::new();
        let (_d, root) = project();
        let st = state();
        let mut gate = brief(true);
        gate.gate = true;
        let d = decide_spawn(&st, &gate, &root);
        assert!(!d.queued, "nobody is writing");
        assert_eq!(holder_of(&root).as_deref(), Some(d.sid.as_str()), "it holds the slot while it pushes");
        release(&st, &d.sid);
        let g = sub(&st, "gate-g", &root, true);
        set_gate(&g);
        assert_eq!(check_write(&st, &g), WriteCheck::Allow, "empty files is not read as writes nothing: the free slot is its");
        assert_eq!(holder_of(&root).as_deref(), Some(g.as_str()));
    }

    /// The notes once said "Tell Joe it is waiting", and the main chat then sent a
    /// card next to the sub's own card saying the same thing (2026-11-11).
    #[test]
    fn queue_notes_do_not_tell_the_main_chat_to_message_joe() {
        let spawn = queued_text("alerts-build", false);
        let send = send_note("Header", "Footer");
        for note in [&spawn, &send] {
            assert!(!note.contains("Tell Joe"), "{note}");
            assert!(note.contains("send no message or card of your own"), "{note}");
            assert!(note.contains("window shows no card for it"), "{note}");
        }
        assert!(spawn.contains("use worktrees"), "the worktrees offer rides on the one fallback line: {spawn}");
    }

    #[test]
    fn a_queued_gate_is_told_not_to_make_the_writer_hold_back_its_commit() {
        let writer = queued_text("alerts-build", false);
        assert!(writer.contains("\"alerts-build\" has the writer slot"), "{writer}");
        assert!(!writer.contains("gate"), "a plain writer gets no gate advice: {writer}");
        let gate = queued_text("alerts-build", true);
        assert!(gate.starts_with(&writer), "the gate sentence is added, nothing is replaced");
        assert!(gate.contains("do not tell that writer to hold back its commit or push until the gate pushes"), "{gate}");
    }

    #[test]
    fn the_note_of_a_gate_queued_behind_a_writer_carries_the_gate_sentence() {
        let _data = TempDataDir::new();
        let (_d, root) = project();
        let st = state();
        let (_writer, queued) = spawn_writer(&st, "writer", &root, "do A");
        assert!(!queued);
        let mut gate_brief = brief(true);
        gate_brief.gate = true;
        let d = decide_spawn(&st, &gate_brief, &root);
        assert!(d.queued, "the writer holds the slot");
        let (parent, id) = ("gate-main".to_string(), d.sid.clone());
        st.registry.upsert_interactive(&parent, &root, "proj", "2026-11-05T00:00:00Z");
        st.registry.upsert_interactive(&id, &root, "proj", "2026-11-05T00:00:00Z");
        st.registry.set_subchat_of(&id, Some(parent.clone()));
        st.registry.set_name(&id, "gate".to_string());
        store_sub_brief(&id, &parent);
        set_gate(&id);
        held::hold(
            &st,
            Held { sub_id: id.clone(), reason: QUEUED_TEXT.into(), after: None, after_name: String::new(), launch: spec(&root, "push") },
        )
        .unwrap();
        let note = spawn_note(&st, &id).expect("a queued gate reports it");
        assert!(note["note"].as_str().unwrap().contains("hold back its commit"), "{note}");
    }

    #[test]
    fn a_second_writer_is_queued_and_the_tool_result_says_so() {
        let _data = TempDataDir::new();
        let (_d, root) = project();
        let st = state();
        let (first, q1) = spawn_writer(&st, "first", &root, "do A");
        assert!(!q1);
        let (second, q2) = spawn_writer(&st, "second", &root, "do B");
        assert!(q2, "the slot is taken");
        assert_eq!(queue_of(&root), vec![second.clone()]);
        let note = spawn_note(&st, &second).expect("a queued sub reports it");
        assert_eq!(note["queued"], true);
        let text = note["note"].as_str().unwrap();
        assert!(text.contains("Queued, not started") && text.contains("first") && text.contains("not woken"), "{text}");
        assert!(text.contains("use worktrees"), "Joe can ask for worktrees: {text}");
        assert!(spawn_note(&st, &first).is_none(), "a sub that started has nothing to say");
        assert!(!text.contains('\u{2014}'));
    }

    #[test]
    fn registering_a_queued_writer_holds_it_through_held_without_an_after_and_counts_it_toward_the_cap() {
        let _data = TempDataDir::new();
        let (_d, root) = project();
        let st = state();
        let (_first, _) = spawn_writer(&st, "reg-a", &root, "A");
        st.registry.upsert_interactive("reg-main", &root, "proj", "2026-11-05T00:00:00Z");
        let cfg = ChatConfig { subchats_on: true, ..Default::default() };
        let args = SubchatArgs {
            task: Some("Footer".into()),
            goal: Some("g".into()),
            done_when: Some("d".into()),
            writes: Some(true),
            files: Some(vec!["footer.ts".into()]),
            ..Default::default()
        };
        let mut plan = super::super::spawn::plan(&st, "reg-main", &cfg, &root.to_string_lossy(), None, None, None, Some("footer"), &args, &[])
            .unwrap()
            .unwrap();
        let decision = decide_spawn(&st, &plan.brief, &root);
        assert!(decision.queued);
        let first_message = plan.first_message.clone();
        let sid = register_queued_row(&st, "reg-main", Some("footer"), &cfg, spec(&root, &first_message), &mut plan, &decision.sid).unwrap();
        assert_eq!(sid, decision.sid, "the row has the id the slot queued");
        let inst = st.registry.get(&sid).unwrap();
        assert_eq!(inst.progress.waiting_for.as_deref(), Some(QUEUED_TEXT));
        assert_eq!(super::super::tool::status_word(&inst), "queued");
        assert!(super::super::spawn::running_subs(&st.registry, "reg-main").iter().any(|i| i.session_id == sid), "it is an unfinished sub (closing waits on it) but holds no cap slot");
        assert!(!super::super::spawn::started_subs(&st, "reg-main").iter().any(|i| i.session_id == sid));
        let entry = held::all().into_iter().find(|h| h.sub_id == sid).expect("held keeps the recipe");
        assert_eq!(entry.after, None, "release_ready must leave a writer-queue hold alone");
        assert!(entry.launch.first_message.contains("Footer"));
        assert!(held::is_held(&sid), "so the dead and ceiling sweeps leave it alone");
    }

    #[test]
    fn a_registration_that_fails_gives_the_slot_entry_back() {
        let _data = TempDataDir::new();
        let (_d, root) = project();
        let st = state();
        let (_first, _) = spawn_writer(&st, "badreg-a", &root, "A");
        st.registry.upsert_interactive("badreg-main", &root, "proj", "2026-11-05T00:00:00Z");
        let cfg = ChatConfig { subchats_on: true, ..Default::default() };
        let args = SubchatArgs {
            task: Some("t".into()),
            goal: Some("g".into()),
            done_when: Some("d".into()),
            writes: Some(true),
            files: Some(vec!["a.ts".into()]),
            ..Default::default()
        };
        let mut plan = super::super::spawn::plan(&st, "badreg-main", &cfg, &root.to_string_lossy(), None, None, None, Some("n"), &args, &[])
            .unwrap()
            .unwrap();
        let decision = decide_spawn(&st, &plan.brief, &root);
        assert_eq!(queue_of(&root), vec![decision.sid.clone()]);
        let mut gone = spec(&root, "x");
        gone.cwd = std::env::temp_dir().join(format!("cc-writers-missing-{}", uuid::Uuid::new_v4()));
        assert!(register_queued_row(&st, "badreg-main", Some("n"), &cfg, gone, &mut plan, &decision.sid).is_err());
        assert!(queue_of(&root).is_empty(), "a sub that could not be registered is not left in line");
    }

    #[test]
    fn a_queued_sub_holds_no_cap_slot_and_shows_as_queued() {
        let _data = TempDataDir::new();
        let (_d, root) = project();
        let st = state();
        spawn_writer(&st, "cap1", &root, "A");
        let (second, _) = spawn_writer(&st, "cap1b", &root, "B");
        let row = st.registry.get(&second).unwrap();
        assert_eq!(row.progress.waiting_for.as_deref(), Some(QUEUED_TEXT));
        assert!(
            !super::super::spawn::started_subs(&st, "cap1b-main").iter().any(|i| i.session_id == second),
            "an unstarted sub has no process, so it holds no cap slot"
        );
        assert_eq!(tool::status_word(&row), "queued");
    }

    #[tokio::test]
    async fn the_queued_sub_starts_when_the_first_finishes_without_waking_the_main_agent() {
        let _data = TempDataDir::new();
        let (_d, root) = project();
        let st = state();
        let (first, _) = spawn_writer(&st, "chain", &root, "do A");
        let (second, queued) = spawn_writer(&st, "chain2", &root, "do B");
        assert!(queued);
        assert_eq!(queue_of(&root), vec![second.clone()]);
        release(&st, &first);
        assert_eq!(holder_of(&root).as_deref(), Some(second.as_str()), "the head took the slot");
        assert!(queue_of(&root).is_empty());
        // The start is a launch of the held sub and nothing else: no message to the
        // main chat and no wake for the main agent.
        assert!(super::super::back::peek("chain2-main").is_none());
        assert!(st.repo_channel_wakes.lock().unwrap().values().all(|q| q.is_empty()));
    }

    #[test]
    fn advance_hands_out_the_head_as_a_launch_in_queue_order() {
        let _data = TempDataDir::new();
        let (_d, root) = project();
        let st = state();
        let (_first, _) = spawn_writer(&st, "ord", &root, "A");
        let (b, _) = spawn_writer(&st, "ord-b", &root, "message for B");
        let (c, _) = spawn_writer(&st, "ord-c", &root, "message for C");
        assert_eq!(queue_of(&root), vec![b.clone(), c.clone()]);
        let starts = {
            let mut table = table();
            let slot = table.get_mut(&project_key(&root)).unwrap();
            slot.holder = None;
            advance_locked(&st, slot)
        };
        assert_eq!(starts, vec![Start::Launch { sub_id: b.clone() }]);
        assert_eq!(held::all().into_iter().find(|h| h.sub_id == b).unwrap().launch.first_message, "message for B");
        assert_eq!(queue_of(&root), vec![c], "only one sub holds the slot at a time");
    }

    #[tokio::test]
    async fn a_writer_waiting_on_joe_with_its_work_committed_lets_the_queued_one_start() {
        let _data = TempDataDir::new();
        let (dir, root) = project();
        let st = state();
        let (header, _) = spawn_writer(&st, "hdr", &root, "A");
        let (footer, queued) = spawn_writer(&st, "ftr", &root, "B");
        assert!(queued);
        let mine = root.join("header.txt");
        std::fs::write(&mine, "x").unwrap();
        test_repo::git(&root, &["add", "header.txt"]);
        test_repo::git(&root, &["commit", "-q", "-m", "header"]);
        let tp = test_repo::transcript(dir.path(), &[("Write", &mine)]);
        on_waiting_on_joe_with(&st, &header, Some(tp)).await;
        assert_eq!(holder_of(&root).as_deref(), Some(footer.as_str()), "the footer took the released slot");
    }

    #[tokio::test]
    async fn a_writer_waiting_on_joe_with_uncommitted_work_keeps_the_slot() {
        let _data = TempDataDir::new();
        let (dir, root) = project();
        let st = state();
        let (header, _) = spawn_writer(&st, "hdr-dirty", &root, "A");
        let (footer, _) = spawn_writer(&st, "ftr-dirty", &root, "B");
        let mine = root.join("half-written.txt");
        std::fs::write(&mine, "x").unwrap();
        let tp = test_repo::transcript(dir.path(), &[("Write", &mine)]);
        on_waiting_on_joe_with(&st, &header, Some(tp)).await;
        assert_eq!(holder_of(&root).as_deref(), Some(header.as_str()), "the queued one stays queued until he answers");
        assert_eq!(queue_of(&root), vec![footer]);
    }

    #[tokio::test]
    async fn the_writer_takes_the_slot_back_when_joe_answers_if_it_is_free_and_otherwise_is_told_at_its_next_write() {
        let _data = TempDataDir::new();
        let (dir, root) = project();
        let st = state();
        let (header, _) = spawn_writer(&st, "ans-h", &root, "A");
        // Released while waiting, nobody queued: nothing holds the slot.
        let tp = test_repo::transcript(dir.path(), &[]);
        on_waiting_on_joe_with(&st, &header, Some(tp)).await;
        assert_eq!(holder_of(&root), None);
        // He answers; its next write takes the free slot back.
        assert_eq!(check_write(&st, &header), WriteCheck::Allow);
        assert_eq!(holder_of(&root).as_deref(), Some(header.as_str()));
        // Released again, and this time another writer takes the slot meanwhile.
        on_waiting_on_joe_with(&st, &header, Some(test_repo::transcript(dir.path(), &[]))).await;
        let (other, queued) = spawn_writer(&st, "ans-o", &root, "B");
        assert!(!queued, "the slot was free");
        // He answers: the answering sub is NOT held back, it is told at its write.
        match check_write(&st, &header) {
            WriteCheck::Wait { holder } => assert_eq!(holder, "ans-o"),
            other => panic!("expected to wait, got {other:?}"),
        }
        assert_eq!(queue_of(&root), vec![header.clone()], "it waits its turn as a woken sub");
        assert_eq!(st.registry.get(&header).unwrap().progress.waiting_for.as_deref(), Some(QUEUED_TEXT));
        // The other sub finishes: the answering one gets the slot and a wake.
        let starts = {
            let mut table = table();
            let slot = table.get_mut(&project_key(&root)).unwrap();
            assert_eq!(slot.holder.as_deref(), Some(other.as_str()));
            slot.holder = None;
            advance_locked(&st, slot)
        };
        assert_eq!(starts, vec![Start::Wake { sub_id: header.clone() }]);
        assert!(st.registry.get(&header).unwrap().progress.waiting_for.is_none(), "no longer waiting");
        assert_eq!(check_write(&st, &header), WriteCheck::Allow);
    }

    #[tokio::test]
    async fn the_slot_is_released_on_end_crash_and_move_to_sidebar() {
        let _data = TempDataDir::new();
        let (_d, root) = project();
        let st = state();
        for (tag, how) in [("rel-end", "end"), ("rel-crash", "crash"), ("rel-move", "move")] {
            let (holder, _) = spawn_writer(&st, tag, &root, "A");
            let (next, queued) = spawn_writer(&st, &format!("{tag}-n"), &root, "B");
            assert!(queued, "{how}");
            match how {
                "end" => {
                    // `end_sub` is what Joe's "End it" and the stalled card call.
                    super::super::end_sub(&st, &holder);
                }
                "crash" => {
                    // A mid-turn death nobody asked for, through the pump's own hook.
                    assert!(super::super::turn_end::note_death(&st, &holder, false, true, None).is_some());
                }
                _ => {
                    super::super::move_to_sidebar(&st, &holder).await.unwrap();
                }
            }
            assert_eq!(holder_of(&root).as_deref(), Some(next.as_str()), "{how}: the next sub has the slot");
            release(&st, &next);
            assert_eq!(holder_of(&root), None);
        }
    }

    #[test]
    fn a_finished_writer_that_is_continued_takes_the_slot_again_the_same_way() {
        let _data = TempDataDir::new();
        let (_d, root) = project();
        let st = state();
        let (w, _) = spawn_writer(&st, "cont", &root, "A");
        st.registry.set_subchat_finished(&w, true);
        release(&st, &w);
        assert_eq!(holder_of(&root), None, "finishing let go");
        st.registry.set_subchat_finished(&w, false);
        assert_eq!(request_slot(&st, &w), SlotOutcome::Granted, "continuing asks for it");
        assert_eq!(holder_of(&root).as_deref(), Some(w.as_str()));
        // And with the slot taken, the continued one queues.
        release(&st, &w);
        let (other, _) = spawn_writer(&st, "cont-o", &root, "B");
        let _ = other;
        match request_slot(&st, &w) {
            SlotOutcome::Queued { behind, position } => assert_eq!((behind.as_str(), position), ("cont-o", 1)),
            o => panic!("{o:?}"),
        }
    }

    #[test]
    fn a_follow_up_with_writes_true_queues_the_sub_when_the_slot_is_taken() {
        let _data = TempDataDir::new();
        let (_d, root) = project();
        let st = state();
        let (_holder, _) = spawn_writer(&st, "fu-h", &root, "A");
        let reader = sub(&st, "fu-r", &root, false);
        set_writes(&reader, true);
        match request_slot(&st, &reader) {
            SlotOutcome::Queued { behind, position } => assert_eq!((behind.as_str(), position), ("fu-h", 1)),
            o => panic!("{o:?}"),
        }
        assert_eq!(st.registry.get(&reader).unwrap().progress.waiting_for.as_deref(), Some(QUEUED_TEXT));
        assert!(matches!(request_slot(&st, &reader), SlotOutcome::Queued { position: 1, .. }), "asking twice does not queue twice");
        assert_eq!(queue_of(&root).len(), 1);
    }

    #[test]
    fn a_read_only_sub_has_its_edits_refused_and_a_writer_does_not() {
        let _data = TempDataDir::new();
        let (_d, root) = project();
        let st = state();
        let reader = sub(&st, "guard-r", &root, false);
        assert_eq!(check_write(&st, &reader), WriteCheck::ReadOnly);
        let writer = sub(&st, "guard-w", &root, true);
        assert_eq!(check_write(&st, &writer), WriteCheck::Allow);
        assert!(READ_ONLY_REFUSAL.contains("guard, not a sandbox") && READ_ONLY_REFUSAL.contains("writes: true"));
        assert!(!READ_ONLY_REFUSAL.contains('\u{2014}') && !wait_refusal("x").contains('\u{2014}'));
    }

    #[test]
    fn a_sub_that_writes_without_holding_the_slot_is_refused() {
        let _data = TempDataDir::new();
        let (_d, root) = project();
        let st = state();
        let holder = sub(&st, "nh-a", &root, true);
        assert_eq!(check_write(&st, &holder), WriteCheck::Allow);
        let other = sub(&st, "nh-b", &root, true);
        match check_write(&st, &other) {
            WriteCheck::Wait { holder } => assert_eq!(holder, "nh-a"),
            o => panic!("{o:?}"),
        }
        assert!(wait_refusal("nh-a").contains("nh-a") && wait_refusal("nh-a").contains("queued"));
    }

    #[test]
    fn a_chat_that_is_not_a_sub_is_never_guarded() {
        let _data = TempDataDir::new();
        let (_d, root) = project();
        let st = state();
        st.registry.upsert_interactive("plain-chat", &root, "proj", "2026-11-05T00:00:00Z");
        assert_eq!(check_write(&st, "plain-chat"), WriteCheck::Allow);
        assert_eq!(check_write(&st, "unknown-chat"), WriteCheck::Allow);
        assert_eq!(holder_of(&root), None, "a plain chat takes no slot");
    }

    #[test]
    fn a_stale_holder_does_not_hold_the_slot_forever() {
        let _data = TempDataDir::new();
        let (_d, root) = project();
        let st = state();
        let (stale, _) = spawn_writer(&st, "stale", &root, "A");
        // Ended by a path that never called `release`.
        st.registry.mark_ended(&stale, crate::types::EndReason::Manual, "2026-11-05T01:00:00Z");
        let (fresh, queued_fresh) = spawn_writer(&st, "stale-f", &root, "B");
        assert!(!queued_fresh, "a dead holder is dropped, so the slot was free");
        // The sweep also starts a queued sub behind a holder that ended unnoticed.
        let (next, queued) = spawn_writer(&st, "stale-n", &root, "C");
        assert!(queued);
        st.registry.mark_ended(&fresh, crate::types::EndReason::Manual, "2026-11-05T01:00:00Z");
        sweep(&st);
        assert_eq!(holder_of(&root).as_deref(), Some(next.as_str()));
    }

    #[test]
    fn the_queue_survives_a_restart_through_held_and_the_head_starts_when_the_slot_is_free() {
        let _data = TempDataDir::new();
        let (_d, root) = project();
        let st = state();
        let (_holder, _) = spawn_writer(&st, "boot-h", &root, "A");
        let (b, _) = spawn_writer(&st, "boot-b", &root, "message for B");
        let (c, _) = spawn_writer(&st, "boot-c", &root, "message for C");
        // The daemon restarts: the in-memory table is gone, the rows were restored
        // from the snapshot, and the held file still has the recipes.
        forget_project_for_test(&root);
        let starts = restore_inner(&st);
        assert_eq!(starts, vec![Start::Launch { sub_id: b.clone() }], "nothing holds the slot after a restart, so the head starts");
        assert_eq!(queue_of(&root), vec![c.clone()]);
        assert_eq!(holder_of(&root).as_deref(), Some(b.as_str()));
        assert!(held::all().iter().any(|h| h.sub_id == b && h.launch.first_message == "message for B"), "its recipe is still there to launch from");
    }

    #[test]
    fn a_restored_entry_whose_row_is_ended_never_starts() {
        let _data = TempDataDir::new();
        let (_d, root) = project();
        let st = state();
        let (_holder, _) = spawn_writer(&st, "drop-h", &root, "A");
        let (ended, _) = spawn_writer(&st, "drop-e", &root, "C");
        forget_project_for_test(&root);
        st.registry.mark_ended(&ended, crate::types::EndReason::Manual, "2026-11-05T01:00:00Z");
        let starts = restore_inner(&st);
        assert!(starts.iter().all(|s| !matches!(s, Start::Launch { sub_id } if sub_id == &ended)), "an ended sub never starts");
        assert!(queue_of(&root).is_empty());
    }

    #[tokio::test]
    async fn a_queued_sub_is_not_called_dead_by_the_sweep() {
        use super::super::stuck::{sweep_dead, Env};
        let _data = TempDataDir::new();
        let (_d, root) = project();
        let st = state();
        let (_holder, _) = spawn_writer(&st, "dead-h", &root, "A");
        let (queued, _) = spawn_writer(&st, "dead-q", &root, "B");
        let none = |_: &crate::types::Instance| None;
        let never_live = |_: &str| false;
        let env = |now| Env { now, resumed_at: None, transcript_mtime: &none, is_live: &never_live };
        let t0 = chrono::Utc::now();
        // Twice, past the grace period: a childless sub that was not held would be carded.
        sweep_dead(&st, &env(t0)).await;
        let carded = sweep_dead(&st, &env(t0 + chrono::Duration::minutes(5))).await;
        assert!(!carded.contains(&queued), "a held sub has no child on purpose: {carded:?}");
        assert!(st.list_prompts().await.iter().all(|p| p["payload"]["sub_id"] != queued.as_str()));
    }

    #[tokio::test]
    async fn the_after_pass_leaves_a_writer_queue_hold_alone() {
        let _data = TempDataDir::new();
        let (_d, root) = project();
        let st = state();
        let (_holder, _) = spawn_writer(&st, "after-h", &root, "A");
        let (queued, _) = spawn_writer(&st, "after-q", &root, "B");
        let started = Arc::new(Mutex::new(Vec::<String>::new()));
        let seen = started.clone();
        held::release_ready(&st, move |_st, id| {
            seen.lock().unwrap().push(id);
            std::future::ready(Ok(()))
        })
        .await;
        assert!(started.lock().unwrap().is_empty(), "only the slot starts it");
        assert!(held::is_held(&queued));
    }

    #[tokio::test]
    async fn a_follow_up_to_a_queued_sub_is_refused_because_it_has_not_started() {
        let _data = TempDataDir::new();
        let (_d, root) = project();
        let st = state();
        let (_holder, _) = spawn_writer(&st, "fol-h", &root, "A");
        let (queued, _) = spawn_writer(&st, "fol-q", &root, "B");
        let err = super::super::continue_sub(&st, &queued, "also fix the footer").await.unwrap_err();
        assert!(matches!(err, ContinueError::Held(_)), "{err:?}");
        assert!(!st.registry.get(&queued).unwrap().busy, "no turn was opened");
    }

    #[tokio::test]
    async fn a_launch_that_fails_releases_the_slot_to_the_next_sub_keeps_the_recipe_and_asks_joe() {
        let _data = TempDataDir::new();
        let (_d, root) = project();
        let st = state();
        let (first, _) = spawn_writer(&st, "fail-1", &root, "A");
        let (second, _) = spawn_writer(&st, "fail-2", &root, "B");
        let (third, _) = spawn_writer(&st, "fail-3", &root, "C");
        // The first finishes: the second is handed the slot. Its launch fails (a
        // unit test has no account or `claude`), which must not strand the third.
        {
            let mut table = table();
            let slot = table.get_mut(&project_key(&root)).unwrap();
            assert_eq!(slot.holder.as_deref(), Some(first.as_str()));
            slot.holder = Some(second.clone());
            slot.queue.retain(|e| e.sub_id != second);
        }
        run_start(&st, Start::Launch { sub_id: second.clone() }).await;
        // The failed start released the slot, so the third was handed it and its own
        // launch was tried (and failed the same way): both are carded.
        for _ in 0..50 {
            tokio::task::yield_now().await;
        }
        let cards = st.list_prompts().await;
        for (id, what) in [(&second, "the one that failed"), (&third, "the one behind it")] {
            assert!(cards.iter().any(|p| p["payload"]["sub_id"] == id.as_str()), "Joe is told {what} never started");
        }
        assert!(held::is_held(&second), "the recipe stays, so Try again can start it");
        assert_ne!(holder_of(&root).as_deref(), Some(second.as_str()));
    }

    fn tree_info() -> crate::daemon::subchats::WorktreeInfo {
        crate::daemon::subchats::WorktreeInfo {
            cwd: "C:/x/.claude/worktrees/sub-1".into(),
            path: "C:/x/.claude/worktrees/sub-1".into(),
            branch: "sub/1".into(),
            target: "main".into(),
            repo: "C:/x".into(),
            base: None,
        }
    }

    #[test]
    fn a_worktree_sub_has_no_slot_and_a_read_only_sub_has_none_either() {
        let (_d, root) = project();
        let mut writer = brief(true);
        for mode in [SubchatWriters::OneAtATime, SubchatWriters::WorktreeEach] {
            assert!(slot_key(mode, &writer, &root).is_some(), "a writer on the main checkout shares the slot under {mode:?}: a folder that could not have a worktree falls back to it");
            assert!(slot_key(mode, &brief(false), &root).is_none(), "a read-only sub holds nothing");
        }
        writer.worktree_at = Some(tree_info());
        assert!(slot_key(SubchatWriters::OneAtATime, &writer, &root).is_none(), "its own tree is what keeps it apart");
        assert!(slot_key(SubchatWriters::WorktreeEach, &writer, &root).is_none());
    }

    #[test]
    fn a_worktree_writer_never_queues_behind_a_writer_on_the_main_checkout() {
        let _data = TempDataDir::new();
        let (_d, root) = project();
        let st = state();
        let (_holder, queued) = spawn_writer(&st, "wt-holder", &root, "A");
        assert!(!queued);
        let mut b = brief(true);
        b.worktree_at = Some(tree_info());
        let d = decide_spawn(&st, &b, &root);
        assert!(!d.queued, "two writers run at once when one has a worktree");
        assert_eq!(queue_of(&root), Vec::<String>::new());
    }

    /// A gate pushes from the main checkout, so under "One at a time" it takes the
    /// slot like any writer and waits for one that is mid-write.
    #[test]
    fn a_gate_queues_behind_a_writer_under_one_at_a_time_and_a_writer_queues_behind_the_gate() {
        let _data = TempDataDir::new();
        let (_d, root) = project();
        let st = state();
        let (writer, _) = spawn_writer(&st, "gate-h", &root, "A");
        let mut gate = brief(true);
        gate.gate = true;
        let d = decide_spawn(&st, &gate, &root);
        assert!(d.queued, "pushing while another sub is mid-write is what the slot prevents");
        assert_eq!(queue_of(&root), vec![d.sid.clone()]);
        // The writer finishes: the gate is handed the slot.
        st.registry.upsert_interactive(&d.sid, &root, "proj", "2026-11-05T00:00:00Z");
        st.registry.set_subchat_of(&d.sid, Some("gate-h-main".into()));
        store_sub_brief(&d.sid, "gate-h-main");
        set_gate(&d.sid);
        st.registry.set_subchat_finished(&writer, true);
        let mut table_guard = table();
        let slot = table_guard.get_mut(&project_key(&root)).unwrap();
        let starts = advance_locked(&st, slot);
        assert_eq!(starts, vec![Start::Launch { sub_id: d.sid.clone() }]);
        assert_eq!(slot.holder.as_deref(), Some(d.sid.as_str()));
        drop(table_guard);
        // And it is a writer to the guard: empty files is not read as writes nothing.
        assert_eq!(check_write(&st, &d.sid), WriteCheck::Allow, "it holds the slot");
        let (_late, late_queued) = spawn_writer(&st, "gate-late", &root, "B");
        assert!(late_queued, "a writer waits for the gate to finish its push");
    }

    #[test]
    fn a_gate_that_does_not_hold_the_slot_is_told_to_wait_not_read_as_read_only() {
        let _data = TempDataDir::new();
        let (_d, root) = project();
        let st = state();
        let (_writer, _) = spawn_writer(&st, "gate-w", &root, "A");
        let g = sub(&st, "gate-g2", &root, true);
        set_gate(&g);
        assert!(matches!(check_write(&st, &g), WriteCheck::Wait { .. }), "empty files must not read as read-only, and it must not edit beside a writer");
    }

    fn worktree_each_project(root: &Path) -> Arc<DaemonState> {
        let mut settings = Settings::default();
        let raw = json!({
            "id": "p1", "path": root, "name": "p", "created_at": "2026-11-05T00:00:00Z",
            "subchat_writers": "worktree_each",
        });
        settings.projects.push(serde_json::from_value(raw).unwrap());
        DaemonState::new(new_session_map(), SettingsCache::new(settings))
    }

    /// Under "Worktree each" writers hold no slot, so a gate takes a project-wide
    /// slot that only other gates contend for.
    #[test]
    fn under_worktree_each_a_gate_contends_only_with_other_gates() {
        let _data = TempDataDir::new();
        let (_d, root) = project();
        let st = worktree_each_project(&root);
        let mut gate = brief(true);
        gate.gate = true;
        let first = decide_spawn(&st, &gate, &root);
        assert!(!first.queued);
        assert_eq!(gate_holder_of(&root).as_deref(), Some(first.sid.as_str()));
        assert_eq!(holder_of(&root), None, "the project's own slot is untouched");
        let mut writer = brief(true);
        writer.worktree_at = Some(tree_info());
        assert!(!decide_spawn(&st, &writer, &root).queued, "a worktree writer runs beside the gate");
        let second = decide_spawn(&st, &gate, &root);
        assert!(second.queued, "a second gate waits for the first");
    }

    #[test]
    fn a_gate_waits_for_a_merge_in_flight_and_starts_when_it_ends() {
        let _data = TempDataDir::new();
        let (_d, root) = project();
        let st = worktree_each_project(&root);
        let key = project_key(&root);
        super::super::worktree::begin_merge_for_test(&key);
        let mut gate = brief(true);
        gate.gate = true;
        let d = decide_spawn(&st, &gate, &root);
        assert!(d.queued, "the worktree sub's commits are not in the main checkout yet");
        st.registry.upsert_interactive(&d.sid, &root, "proj", "2026-11-05T00:00:00Z");
        st.registry.set_subchat_of(&d.sid, Some("g-main".into()));
        store_sub_brief(&d.sid, "g-main");
        set_gate(&d.sid);
        sweep(&st);
        assert_eq!(gate_holder_of(&root), None, "still merging");
        super::super::worktree::end_merge_for_test(&key);
        sweep(&st);
        assert_eq!(gate_holder_of(&root).as_deref(), Some(d.sid.as_str()), "it runs after the merge");
    }
}
