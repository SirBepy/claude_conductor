//! Putting a project's main chat away (pc-1806 step 3): the daemon side of what a
//! close of that chat now means. Nothing is deleted and nothing ends: the chat stays
//! an open row flagged hidden, its stores stay, its pointer stays, and its subs are
//! paused where they stand. The order matters and is the one the todo fixes:
//!
//! 1. the family record is written FIRST (`put_away::put_away`), which closes the
//!    gate every start and wake path reads (step 2), so nothing new starts while
//!    the rest runs and a restart half way still finds the family hidden;
//! 2. a compaction or save turn already running on the chat is waited out, and so
//!    is the chat's own turn (a `close_session` call arrives inside one); a chat
//!    that stays busy past [`Timing::quiet_wait`] is not put away after all, the
//!    record is undone and the chat stays as it was;
//! 3. the save step and a compaction run while the prompt cache is warm
//!    (`compaction::start_for_put_away`: not for an API-credit account, and not for a
//!    chat small enough that a resume costs what a compaction saves);
//! 4. each sub is paused at its NEXT turn end, never mid-tool: the sub is waited for
//!    until it is not busy, then its child is stopped and the row frozen with
//!    `frozen_needs_continue` set when it was busy, ran a background task or waited
//!    on a card when the put-away began (read once, up front), and the writer slot it held is let go while
//!    every queue entry keeps its place ([`pause_now`] is the escalation for a sub
//!    that must stop sooner: an interrupt, then a wait for the result line, and only
//!    then the kill);
//! 5. the chat's own child is stopped last (a frozen chat is never compacted, so the
//!    compaction came first). The row is a manual freeze: no schedule, rate-limit
//!    resume or idle wake clears it, only a reopen does.
//!
//! Cards are parked, not dropped: `closing::settle_family` is never called, so the
//! family's cards keep showing and counting. A sub on a paired machine is paused by a
//! `sub_pause` queued in the outbox (`remote::actions::queue_pause`, the host's half in
//! `remote/host_actions.rs`), and the reopen that resumes what this paused is step 6.

use super::{PausedSub, Prior};
use crate::daemon::state::DaemonState;
use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// What the `close_session` tool says when it puts the chat away (the tool result, so
/// the model does not tell Joe the chat closed for good).
pub const NOTE: &str = "This is the project's main chat, so it is being put away, not closed: nothing is deleted, its subs are paused at their next turn end, and it can be reopened later. End your turn now and do not call close_session again.";

/// How long each wait runs before it gives up. Tests pass short ones.
#[derive(Clone, Copy, Debug)]
pub struct Timing {
    /// The step between two reads of the state being waited on.
    pub poll: Duration,
    /// The chat's own turn and any compaction in flight: past this the chat is not put away.
    pub quiet_wait: Duration,
    /// The save turn and the compaction after it. A compaction that outlives it leaves
    /// the chat's child running (the row is hidden and gated all the same).
    pub compaction_wait: Duration,
    /// One sub's turn. A sub still busy past it is left running: the record says it is
    /// paused, and a reopen finds it already running.
    pub sub_wait: Duration,
    /// An interrupted sub's result line, before the kill takes over ([`pause_now`]).
    pub interrupt_wait: Duration,
}

impl Default for Timing {
    fn default() -> Self {
        Self {
            poll: Duration::from_millis(250),
            quiet_wait: Duration::from_secs(30 * 60),
            compaction_wait: Duration::from_secs(20 * 60),
            sub_wait: Duration::from_secs(6 * 60 * 60),
            interrupt_wait: Duration::from_secs(10),
        }
    }
}

/// Why a chat was not put away.
#[derive(Debug)]
pub enum Refused {
    /// Not an open project main chat (the pointer names it, no `respawn` successor).
    NotAMainChat,
    /// A put-away of this chat is already running.
    AlreadyRunning,
    /// The family record could not be written; nothing changed.
    Record(std::io::Error),
    /// The chat stayed in a turn or a compaction past [`Timing::quiet_wait`]; the record was undone.
    NotQuiet,
}

/// Chats a put-away is running for, so a second close click starts no second one.
static RUNNING: Mutex<Option<HashSet<String>>> = Mutex::new(None);

struct Running(String);

impl Running {
    fn begin(main: &str) -> Option<Self> {
        let mut all = RUNNING.lock().unwrap_or_else(|p| p.into_inner());
        all.get_or_insert_with(HashSet::new).insert(main.to_string()).then(|| Self(main.to_string()))
    }
}

impl Drop for Running {
    fn drop(&mut self) {
        if let Some(all) = RUNNING.lock().unwrap_or_else(|p| p.into_inner()).as_mut() {
            all.remove(&self.0);
        }
    }
}

/// Whether closing `id` means put away: an open, daemon-hosted main chat that its
/// project's pointer names and that no `respawn` successor is taking over from (a
/// respawn hands the family over instead). The one question `closing::close_outcome` asks.
pub fn is_project_main_chat(state: &DaemonState, id: &str) -> bool {
    let Some(inst) = state.registry.get(id) else { return false };
    inst.ended_at.is_none()
        && inst.end_reason.is_none()
        && inst.machine.is_none()
        && !super::super::is_sub(&inst)
        && matches!(inst.kind, crate::sessions::kinds::InstanceKind::Interactive)
        && super::super::main_pointer::project_of_main(state, id).is_some()
        && super::super::closing::live_successor(state, id).is_none()
}

/// What a project's main chat is told when it calls `respawn`.
pub const RESPAWN_REFUSAL: &str = "A project's main chat does not respawn: the app compacts it in place when it grows (its subs and stores stay), and closing it puts it away instead of ending it. Keep working in this chat, or call close_session to put it away.";

/// Refuses `respawn` from a project's main chat (pc-1806): a successor row would take
/// the family and the pointer over from a chat that compaction already keeps small, and
/// a respawn is the one path that ends such a chat for real. Any other chat may.
pub fn refuse_respawn(state: &DaemonState, caller: &str) -> Result<(), String> {
    if is_project_main_chat(state, caller) {
        return Err(RESPAWN_REFUSAL.to_string());
    }
    Ok(())
}

/// Starts the put-away of `main` on a detached task: the callers are the pump's close
/// backstop and the hook server, which must not wait for a compaction. A chat that is
/// already put away and stopped, or one already being put away, starts nothing.
pub fn start(state: &Arc<DaemonState>, main: &str) {
    let done = state.registry.get(main).is_some_and(|i| i.hidden_at.is_some() && i.frozen);
    if done {
        return;
    }
    let Ok(handle) = tokio::runtime::Handle::try_current() else {
        log::warn!("put away: no runtime to put {main} away on");
        return;
    };
    let (state, main) = (state.clone(), main.to_string());
    handle.spawn(async move {
        match run(&state, &main, &Timing::default()).await {
            Ok(()) => log::info!("put away: {main} is put away"),
            Err(Refused::AlreadyRunning) => {}
            Err(e) => log::warn!("put away: {main} was not put away: {e:?}"),
        }
    });
}

/// The whole put-away of `main`, in the order the module docs give.
pub async fn run(state: &Arc<DaemonState>, main: &str, t: &Timing) -> Result<(), Refused> {
    let _running = Running::begin(main).ok_or(Refused::AlreadyRunning)?;
    if !is_project_main_chat(state, main) {
        return Err(Refused::NotAMainChat);
    }
    // A "Wait for them" pick from before this build, or a close in progress, must not
    // fight the put-away: the chat is not closing any more.
    super::super::closing::forget_pending(state, main);

    let now = chrono::Utc::now().to_rfc3339();
    let subs = plan(state, main, &now).await;
    super::put_away(state, main, subs.clone(), &now).map_err(Refused::Record)?;
    crate::sessions::persistence::save_snapshot_default(&state.registry);

    if !wait_until(t.quiet_wait, t.poll, || !chat_in_a_turn(state, main)).await {
        undo(state, main);
        return Err(Refused::NotQuiet);
    }

    // After the quiet check, so an undone put-away has paused nothing anywhere: a host
    // pauses each sub at its own next turn end, which needs no waiting here.
    queue_remote_pauses(state, &subs);

    let compaction_finished = compact_while_warm(state, main, t).await;

    // Every sub in parallel: each waits for its own turn end, and one long turn must
    // not hold the others' pause back.
    let pauses = subs.iter().map(|sub| pause_sub(state, main, sub, t));
    futures_util::future::join_all(pauses).await;

    // A chat whose compaction is still running keeps its child: stopping it now would
    // lose what the save turn and the compaction were for.
    if compaction_finished {
        freeze_main(state, main).await;
    }
    crate::daemon::machines::publish_instances_changed(state);
    crate::sessions::persistence::save_snapshot_default(&state.registry);
    super::super::main_pointer::reconcile(state);
    Ok(())
}

/// The chat is in a turn of its own or in a compaction (or the save turn before it).
fn chat_in_a_turn(state: &DaemonState, main: &str) -> bool {
    state.registry.get(main).is_some_and(|i| i.busy) || super::super::compaction::in_progress(main)
}

/// Polls `done` every `poll` until it holds or `limit` has passed; whether it held.
async fn wait_until(limit: Duration, poll: Duration, mut done: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + limit;
    loop {
        if done() {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(poll).await;
    }
}

/// Gives the chat its save turn and compaction. False only when one was started and
/// had not finished within [`Timing::compaction_wait`]; a compaction that was not
/// started (a card open, an API-credit account, a small chat) is not a wait.
async fn compact_while_warm(state: &Arc<DaemonState>, main: &str, t: &Timing) -> bool {
    match super::super::compaction::start_for_put_away(state, main).await {
        Ok(()) => {
            let finished = wait_until(t.compaction_wait, t.poll, || !super::super::compaction::in_progress(main)).await;
            if !finished {
                log::warn!("put away: {main} was still saving or compacting after {:?}; its child stays running", t.compaction_wait);
            }
            finished
        }
        Err(skip) => {
            log::info!("put away: {main} not compacted: {}", skip.reason());
            true
        }
    }
}

/// What the pause records about each local sub, read before anything is touched.
/// `needs_continue` follows the manual freeze's rule (`freeze_session`): the sub was
/// in a turn, ran a background task or waited on a card, so a resume must tell it to
/// carry on. A finished sub or one held without a child has nothing to continue.
async fn plan(state: &Arc<DaemonState>, main: &str, now: &str) -> Vec<PausedSub> {
    let rows: Vec<_> = state
        .registry
        .list()
        .into_iter()
        .filter(|i| i.subchat_of.as_deref() == Some(main) && i.ended_at.is_none() && i.end_reason.is_none())
        .collect();
    let mut subs = Vec::with_capacity(rows.len());
    for sub in rows {
        subs.push(paused_sub_for(state, &sub, now).await);
    }
    // The subs on paired machines are listed too: `put_away` must name every sub the
    // pause froze, and each one's resume goes to the machine named here.
    subs.extend(plan_remote(main, now));
    subs
}

/// What the pause records about one sub of this machine, read before anything is touched
/// (also the host's read of a visiting sub when a `sub_pause` reaches it).
pub(crate) async fn paused_sub_for(state: &Arc<DaemonState>, sub: &crate::types::Instance, now: &str) -> PausedSub {
    let held = super::super::held::is_held(&sub.session_id);
    let working = sub.busy || sub.local_task_running || crate::daemon::lifecycle::has_open_prompt(state, &sub.session_id).await;
    let prior = if sub.subchat_finished {
        Prior::Finished
    } else if held {
        Prior::Held
    } else if working {
        Prior::Working
    } else {
        Prior::Idle
    };
    PausedSub {
        sub_id: sub.session_id.clone(),
        name: Some(super::super::spawn::label(sub)),
        prior,
        needs_continue: prior == Prior::Working,
        paused_at: Some(now.to_string()),
        machine_id: None,
    }
}

/// The subs of `main` that run on a paired machine and have not ended. Only the home's
/// record is read: the host alone knows whether the sub is mid-turn, so the prior state
/// here is a coarse one (a held or finished sub is said so, any other is `Unknown`).
fn plan_remote(main: &str, now: &str) -> Vec<PausedSub> {
    use super::super::remote::records::{self, RemoteState};
    records::of_main(main)
        .into_iter()
        .filter(|r| r.state != RemoteState::Ended)
        .map(|r| PausedSub {
            prior: match r.state {
                RemoteState::Held => Prior::Held,
                RemoteState::Finished => Prior::Finished,
                _ => Prior::Unknown,
            },
            name: Some(super::super::remote::actions::name_of(&r)),
            sub_id: r.sub_id,
            needs_continue: false,
            paused_at: Some(now.to_string()),
            machine_id: Some(r.machine_id),
        })
        .collect()
}

/// Queues the pause of every sub on a paired machine through the durable outbox, so a
/// machine that is away pauses its subs when it is back (and a resume queued after it
/// arrives after it). Returns how many were queued.
fn queue_remote_pauses(state: &Arc<DaemonState>, subs: &[PausedSub]) -> usize {
    use super::super::remote::{actions, records};
    let queued = subs
        .iter()
        .filter(|s| s.machine_id.is_some())
        .filter_map(|s| records::get(&s.sub_id))
        .filter(|rec| actions::queue_pause(rec))
        .count();
    if queued > 0 {
        super::super::remote::outbox::flush_in_background(state);
    }
    queued
}

/// Takes a put-away back before anything was paused: the gate opens and the record goes.
fn undo(state: &Arc<DaemonState>, main: &str) {
    match super::reopen(state, main).and_then(|_| super::clear(main)) {
        Ok(()) => log::warn!("put away: {main} stayed in a turn, so it was not put away"),
        Err(e) => log::warn!("put away: {main} stayed in a turn and its record could not be undone: {e}"),
    }
    crate::sessions::persistence::save_snapshot_default(&state.registry);
}

/// Pauses one sub at its next turn end: waits until it is not busy, stops its child and
/// freezes the row, and lets go of the writer slot it holds.
pub(crate) async fn pause_sub(state: &Arc<DaemonState>, main: &str, sub: &PausedSub, t: &Timing) {
    let id = sub.sub_id.as_str();
    let quiet = wait_until(t.sub_wait, t.poll, || {
        // A reopen meanwhile (the gate is open again) or a sub that ended ends the wait.
        let row = state.registry.get(id);
        row.as_ref().is_none_or(|r| r.ended_at.is_some()) || !super::is_hidden_family(main) || row.is_some_and(|r| !r.busy)
    })
    .await;
    if !quiet {
        log::warn!("put away: sub {id} was still in a turn after {:?}; it keeps running", t.sub_wait);
        return;
    }
    if !super::is_hidden_family(main) {
        return;
    }
    // A sub that kept its child (a permission or secret card is open) still writes, so
    // it keeps the writer slot too.
    if freeze_child(state, id, sub.needs_continue).await {
        super::super::writers::release_for_pause(state, id);
    }
}

/// The escalation for a sub that must stop before its turn ends: an interrupt
/// (`cancel_turn`), a wait for the result line that ends the turn, and the kill only if
/// the line never comes. The sub is frozen with `frozen_needs_continue` set, since a
/// turn was cut. Nothing in the app calls it yet (the "Pause now" button is step 5).
pub async fn pause_now(state: &Arc<DaemonState>, sub_id: &str, t: &Timing) {
    let busy = state.registry.get(sub_id).is_some_and(|i| i.busy);
    if busy {
        match crate::daemon::lifecycle::cancel_turn(&state.sessions, sub_id).await {
            Ok(()) => {
                wait_until(t.interrupt_wait, t.poll, || !state.registry.get(sub_id).is_some_and(|i| i.busy)).await;
            }
            Err(e) => log::warn!("put away: could not interrupt {sub_id}: {e}"),
        }
    }
    let needs_continue = busy || state.registry.get(sub_id).is_some_and(|i| i.local_task_running);
    if freeze_child(state, sub_id, needs_continue).await {
        super::super::writers::release_for_pause(state, sub_id);
    }
}

/// Stops `id`'s child and marks the row frozen, as the menu's "Freeze chat" does. A sub
/// that is finished or held has no child, one already frozen keeps its own freeze, and
/// a child with a permission or secret card open is left alone (killing it would expire
/// the card). False when the child was left running, so the caller keeps whatever the
/// child still holds.
async fn freeze_child(state: &Arc<DaemonState>, id: &str, needs_continue: bool) -> bool {
    let Some(row) = state.registry.get(id) else { return true };
    if row.frozen || row.subchat_finished || super::super::held::is_held(id) {
        return true;
    }
    if crate::daemon::lifecycle::holds_live_call(state, id).await {
        return false;
    }
    crate::daemon::lifecycle::kill_and_wait_for_teardown(state, id).await;
    state.registry.set_frozen(id, true);
    state.registry.set_frozen_needs_continue(id, needs_continue);
    crate::daemon::machines::publish_instances_changed(state);
    true
}

/// Stops the put-away chat's own child. A manual freeze, so only a reopen clears it;
/// the reopen asks "Continue the plan?" itself, so `frozen_needs_continue` stays off.
async fn freeze_main(state: &Arc<DaemonState>, main: &str) {
    // The waits before this can last minutes: a reopen meanwhile must keep its child.
    if !super::is_hidden_family(main) {
        return;
    }
    freeze_child(state, main, false).await;
}
