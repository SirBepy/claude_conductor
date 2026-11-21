//! The writer slot (spec section 7). Every writing sub gets its own git worktree
//! (`worktree`) and holds no slot, because its own tree is what keeps it from
//! colliding. The slot is what is left for the subs that share the main
//! checkout: a writer in a folder that cannot have a worktree (not a repo, a
//! detached `HEAD`) or one spawned before every writer got a tree, which queue
//! one at a time (Cognition's rule: writes stay single-threaded), and a gate sub,
//! which pushes from the main checkout and takes a project-wide slot that only
//! other gates contend for, after the merges in flight. Read-only subs run freely.
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
use super::spawn::SubPlan;
use super::{resume, tool, ContinueError};
use crate::daemon::state::DaemonState;
use crate::sessions::chat_config::ChatConfig;
use crate::settings::identity::project_key;
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

/// Suffix of the slot a gate sub uses. Writers in their own worktree hold no
/// slot at all, so only other gates contend for it.
const GATE_SLOT: &str = "#gate";

/// Which slot a sub with this brief takes, `None` when none applies.
///
/// A read-only sub never takes one. A worktree sub never does either, because its
/// own tree is what keeps it from colliding: that is read from the brief's stored
/// tree, since a sub in a folder that could not have a worktree (or one spawned
/// before every writer got one) still shares the main checkout and must queue. A
/// gate sub pushes from the main checkout and takes a project-wide slot of its
/// own that only other gates contend for. Every gate waits for merges in flight
/// before it starts, so it pushes what the worktree subs just landed.
///
/// A writer that fell back to the main checkout (`Prepare::Unusable`: no repo, a
/// detached `HEAD`, no commit yet) stays out of the gate's slot on purpose. A push
/// sends commits of a branch, and such a checkout has no branch for the writer's
/// edits to land on (uncommitted edits are never pushed, and commits on a detached
/// `HEAD` belong to no branch), so a gate on it has nothing to wait for. `a_gate_and_a_main_checkout_writer_never_queue_behind_each_other`
/// pins it.
fn slot_key(brief: &super::SubchatBrief, cwd: &Path) -> Option<String> {
    if !brief.writes || (brief.worktree_at.is_some() && !brief.gate) {
        return None;
    }
    let key = project_key(cwd);
    Some(if brief.gate { format!("{key}{GATE_SLOT}") } else { key })
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
            Kind::Launch => {
                // It holds the slot and is being started: no longer a place in line.
                state.registry.set_queue_place(&entry.sub_id, None);
                Start::Launch { sub_id: entry.sub_id }
            }
            Kind::Wake => {
                state.registry.set_waiting_for(&entry.sub_id, None);
                Start::Wake { sub_id: entry.sub_id }
            }
        });
    }
    stamp_places(state, slot);
    starts
}

/// Writes each queued entry's place in line (1 = next) and the sub it waits behind
/// onto its row, for the dashboard's hover card. The place is a fact of the queue
/// that moves whenever someone ahead leaves, so every queue change ends here.
/// Returns whether any row changed.
fn stamp_places(state: &DaemonState, slot: &Slot) -> bool {
    let who = behind(state, slot);
    let mut changed = false;
    for (i, entry) in slot.queue.iter().enumerate() {
        changed |= state.registry.set_queue_place(&entry.sub_id, Some((i as u32 + 1, who.clone())));
    }
    changed
}

/// [`stamp_places`] for the slot `sub_id` queues in, for a row registered after its
/// entry joined the queue ([`decide_spawn`] pushes before the row exists).
pub(crate) fn stamp_places_of(state: &DaemonState, sub_id: &str) -> bool {
    let table = table();
    table.values().find(|s| s.queue.iter().any(|e| e.sub_id == sub_id)).is_some_and(|slot| stamp_places(state, slot))
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
    let Some(key) = slot_key(brief, cwd) else {
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
    let registered =
        held::register_held_row(state, caller_session_id, name, inherited, spec, plan, sid.to_string(), QUEUED_TEXT.to_string(), None)
            .inspect_err(|_| release_entry_only(state, sid))?;
    // The row went out before its place was known; send it again with the place.
    if stamp_places_of(state, sid) {
        crate::daemon::machines::publish_instances_changed(state);
    }
    Ok(registered)
}

/// Asks for the writer slot for a running or finished sub: the one door
/// `subchat send` with `writes: true` calls, and what a continued writer calls
/// when it wakes. Granted when the slot is free or already this sub's; otherwise
/// the sub joins the queue as a Wake and keeps running read-only.
pub fn request_slot(state: &Arc<DaemonState>, sub_id: &str) -> SlotOutcome {
    let Some(inst) = state.registry.get(sub_id) else { return SlotOutcome::Granted };
    let Some(brief) = crate::sessions::chat_config::get(sub_id).and_then(|c| c.subchat) else { return SlotOutcome::Granted };
    let Some(key) = slot_key(&brief, &inst.cwd) else {
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
    // After the wait is marked, and only if the entry is still queued: a start that
    // slipped in between has already cleared it, and a place stamped before that
    // would outlive the wait.
    stamp_places_of(state, sub_id);
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
    let (starts, changed) = leave(state, sub_id, true);
    finish_release(state, starts, changed);
}

/// [`release`] without forgetting a held recipe: a launch that failed keeps its
/// held entry, so the main chat's `subchat retry` can still start it.
fn release_entry_only(state: &Arc<DaemonState>, sub_id: &str) {
    skip_queue(state, sub_id);
}

/// Takes `sub_id` out of every writer queue and slot without forgetting its held
/// recipe, and starts whoever is next: for a sub Joe starts ahead of its turn.
pub(crate) fn skip_queue(state: &Arc<DaemonState>, sub_id: &str) {
    let (starts, changed) = leave(state, sub_id, false);
    finish_release(state, starts, changed);
}

/// `changed`: the queue moved (someone left it or let go of the slot), so the rows
/// behind carry a new place even when nobody started.
fn finish_release(state: &Arc<DaemonState>, starts: Vec<Start>, changed: bool) {
    if changed || !starts.is_empty() {
        crate::daemon::machines::publish_instances_changed(state);
    }
    run_starts(state, starts);
}

/// Returns what to start and whether `sub_id` held or waited in any slot.
fn leave(state: &Arc<DaemonState>, sub_id: &str, forget_recipe: bool) -> (Vec<Start>, bool) {
    let key = state.registry.get(sub_id).map(|i| project_key(&i.cwd));
    let mut starts = Vec::new();
    let mut removed: Vec<Entry> = Vec::new();
    let mut owned = false;
    {
        let mut table = table();
        for (k, slot) in table.iter_mut() {
            let owns = slot.holder.as_deref() == Some(sub_id) || slot.queue.iter().any(|e| e.sub_id == sub_id);
            owned |= owns;
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
            // Still held, but no longer in line: the place it had is stale.
            Kind::Launch if !forget_recipe => {
                state.registry.set_queue_place(&entry.sub_id, None);
            }
            _ => clear_wait(state, entry),
        }
    }
    (starts, owned)
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
    // Any slot, not the project's: a gate holds its own.
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
#[cfg(test)]
pub fn holder_of(cwd: &Path) -> Option<String> {
    table().get(&project_key(cwd)).and_then(|s| s.holder.clone())
}

/// The gate sub holding the project-wide gate slot.
#[cfg(test)]
pub fn gate_holder_of(cwd: &Path) -> Option<String> {
    table().get(&format!("{}{GATE_SLOT}", project_key(cwd))).and_then(|s| s.holder.clone())
}

/// The subs waiting for the slot of the project `cwd` is in, next first.
#[cfg(test)]
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
    let slot = table.get(&slot_key(&brief, &inst.cwd)?)?;
    let position = queue_position(slot, sub_id)?;
    Some(json!({
        "queued": true,
        "queue_position": position,
        "note": queued_text(&behind(state, slot), brief.gate),
    }))
}

/// The queue note's text. Only a sub on the main checkout queues: a gate behind
/// another gate or a merge in flight, or a writer the project could not give a
/// worktree.
fn queued_text(behind: &str, gate: bool) -> String {
    let why = if gate {
        format!("only one gate sub pushes from the main checkout at a time, after the commits of finished subs are merged, and \"{behind}\" is ahead of it")
    } else {
        format!("this sub has no worktree of its own, so it shares the main checkout, where only one sub changes files at a time, and \"{behind}\" has the writer slot")
    };
    format!(
        "Queued, not started: {why}. This sub starts by itself when it is free, in queue order, and you are not woken when it starts. This sub's own card already shows Joe it is waiting, so send no message or card of your own about it. Only when Joe's window shows no card for it, say so in one short line."
    )
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
    // A put-away family takes neither a launch nor a "slot is free" nudge. A launch is
    // taken out of the line with its recipe kept, so a reopen's `requeue_held` puts it
    // back and starts the head; a nudge for a sub that already runs is left undelivered
    // (the sub keeps the slot it was granted), for the reopen to repeat.
    let (Start::Launch { sub_id } | Start::Wake { sub_id }) = &start;
    if super::put_away::is_gated(state, sub_id) {
        if matches!(start, Start::Launch { .. }) {
            skip_queue(state, sub_id);
        }
        return;
    }
    match start {
        Start::Launch { sub_id } => {
            if let Err(e) = held::launch_held(state, &sub_id).await {
                log::warn!("subchats: could not start queued sub {sub_id}: {e}");
                // A sub that ended while it started has nothing left to retry, and
                // its main chat was not waiting for it.
                if e == held::ENDED_BEFORE_START {
                    held::release(state, &sub_id);
                    release_entry_only(state, &sub_id);
                    return;
                }
                // The next sub in line must not be stuck behind one that never
                // started. The held recipe stays, so the main chat's `subchat retry`
                // still starts it (and it takes the slot again at its first write).
                release_entry_only(state, &sub_id);
                // A gate that closed since the check above: the hold stays, nothing failed.
                if held::is_put_away_refusal(&e) {
                    return;
                }
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
    finish_release(state, starts, !stale.is_empty());
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
/// starts the head if the slot is free. For a hold [`lost_hold::recover_lost`] rebuilt
/// while the daemon runs; an entry already queued or holding is left as it is.
pub(crate) fn requeue_held(state: &Arc<DaemonState>) {
    let starts = restore_inner(state);
    // The rebuilt entries just got their places.
    finish_release(state, starts, true);
}

pub(crate) fn restore_inner(state: &Arc<DaemonState>) -> Vec<Start> {
    let mut starts = Vec::new();
    let mut table = table();
    for h in held::all().into_iter().filter(|h| h.after.is_none() && !held::waits_on_home(h)) {
        let Some(inst) = state.registry.get(&h.sub_id).filter(|i| alive(state, &i.session_id)) else { continue };
        let brief = crate::sessions::chat_config::get(&h.sub_id).and_then(|c| c.subchat);
        // A hold the spawn path made without an `after` is a writer's, but a
        // rebuilt one (`lost_hold`) can belong to a read-only sub, which waits for
        // nobody: it starts at once and never takes a place in the writer queue
        // (2026-11-10: a read-only `live-proof` read "waiting for the writer slot"
        // with no writer running). A failed start parks it, so a later pass does
        // not retry it every tick.
        if brief.as_ref().is_some_and(|b| !b.writes) {
            if !held::launching(&h.sub_id) && !held::parked(&h.sub_id) {
                starts.push(Start::Launch { sub_id: h.sub_id });
            }
            continue;
        }
        // With no brief left to say otherwise, a hold without an `after` is a writer.
        let (key, gate) = match brief {
            Some(b) => (slot_key(&b, &inst.cwd), b.gate),
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
mod tests;
