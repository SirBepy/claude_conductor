//! Reopening a put-away main chat (pc-1806 step 6): the daemon side of "starting a chat in
//! the project reopens the same main chat", in two parts because the user's own message
//! comes between them.
//!
//! 1. [`reopen_main`] opens the gate for the MAIN chat only. The chat's child is let go of
//!    its freeze (no "continue": the user's message is what it answers), the record goes
//!    open but KEEPS the subs the pause froze, and a sub with nothing left to resume (it
//!    finished, ended or never started) is dealt with at once. Every sub that still has
//!    work stays held by [`super::is_paused_sub`]: no `after` release, no writer start, no
//!    wake of the main chat, no send to it, until the answer.
//! 2. [`begin_resume`] and [`run_resume`] are that answer. "Yes" resumes every waiting sub;
//!    "No" names the subs to end, and a sub that waited on one of them is released from
//!    that wait (the ended target is marked cleared, so the chain reads as satisfied, never
//!    as a Blocked card). Resuming is staggered so a family of ten does not start ten
//!    `claude` processes in one second, and what the pause queued meanwhile (the wake
//!    notices, the writer queue, the visiting subs' kept events) is drained last.
//!
//! An unattended starter (a schedule, the phone, `spawn_chat`) never calls either: the
//! doors of step 2 keep refusing, so a family stays paused until a person reopens it.

use super::{awaiting, is_hidden_family, resolve, PausedSub, Prior};
use crate::daemon::state::DaemonState;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// How the resume spaces its starts. Tests pass zeros.
#[derive(Clone, Copy, Debug)]
pub struct ResumeTiming {
    /// Pause after a sub that was told to carry on, so the starts do not land together.
    pub gap: Duration,
    /// The step between two reads of the number of running children.
    pub poll: Duration,
    /// The longest a resume waits for a child to exit when the family is at the start cap.
    /// Past it the sub starts anyway: the cap is soft (see `spawn::MAX_RUNNING`).
    pub cap_wait: Duration,
}

impl Default for ResumeTiming {
    fn default() -> Self {
        Self { gap: Duration::from_millis(1500), poll: Duration::from_secs(1), cap_wait: Duration::from_secs(60) }
    }
}

/// Families whose resume answer is being applied, so a second click starts no second one.
static RESUMING: Mutex<Option<HashSet<String>>> = Mutex::new(None);

/// Held while one family's answer is applied; dropping it lets the next one in.
pub struct Resuming(String);

impl Resuming {
    fn begin(main: &str) -> Option<Self> {
        let mut all = RESUMING.lock().unwrap_or_else(|p| p.into_inner());
        all.get_or_insert_with(HashSet::new).insert(main.to_string()).then(|| Self(main.to_string()))
    }
}

/// Whether an answer for `main` is being applied right now.
fn is_resuming(main: &str) -> bool {
    RESUMING.lock().unwrap_or_else(|p| p.into_inner()).as_ref().is_some_and(|all| all.contains(main))
}

impl Drop for Resuming {
    fn drop(&mut self) {
        if let Some(all) = RESUMING.lock().unwrap_or_else(|p| p.into_inner()).as_mut() {
            all.remove(&self.0);
        }
    }
}

/// Whether `sub` has anything to resume: a finished, ended or vanished sub does not.
fn has_work(state: &DaemonState, sub: &PausedSub) -> bool {
    if sub.prior == Prior::Finished {
        return false;
    }
    if sub.machine_id.is_some() {
        return super::super::remote::records::get(&sub.sub_id)
            .is_some_and(|r| !matches!(r.state, super::super::remote::records::RemoteState::Ended | super::super::remote::records::RemoteState::Finished));
    }
    state.registry.get(&sub.sub_id).is_some_and(|r| r.ended_at.is_none() && r.end_reason.is_none() && !r.subchat_finished)
}

/// The ids a sub waits for (`after`), local or remote.
fn waits_for(sub_id: &str) -> Vec<String> {
    if let Some(h) = super::super::held::all().into_iter().find(|h| h.sub_id == sub_id) {
        return h.target_ids().into_iter().map(str::to_string).collect();
    }
    super::super::remote::records::get(sub_id).map(|r| r.wait().target_ids().into_iter().map(str::to_string).collect()).unwrap_or_default()
}

/// What "Continue the plan?" shows: whether the family is still put away, and the subs a
/// reopen left waiting for the answer (name, what it was doing, and the subs it waits for,
/// which the checklist draws as a tree). Subs with nothing left to resume are not listed, and
/// neither is any sub while an answer is being applied: the staggered resume takes the subs
/// out of the record one at a time, and a question drawn meanwhile would list subs that are
/// already on their way.
pub fn paused_view(state: &DaemonState, main: &str) -> Value {
    let hidden = is_hidden_family(main);
    let (subs, unreadable) = match awaiting(main) {
        Ok(_) if is_resuming(main) => (Vec::new(), false),
        Ok(subs) => (subs, false),
        Err(_) => (Vec::new(), true),
    };
    let items: Vec<Value> = subs
        .iter()
        .filter(|s| has_work(state, s))
        .map(|s| {
            json!({
                "sub_id": s.sub_id,
                "name": s.name,
                "prior": s.prior,
                "needs_continue": s.needs_continue,
                "machine_id": s.machine_id,
                "after": waits_for(&s.sub_id),
            })
        })
        .collect();
    json!({ "hidden": hidden, "paused": items, "unreadable": unreadable })
}

/// [`paused_view`] for the question's own read: when every sub that waited for the answer
/// has ended or finished since the reopen (nothing is left to ask about), the pause is over
/// at once. Without this the record would stay open with no question to answer it, and the
/// wake queue would stay held for good.
pub fn settle(state: &Arc<DaemonState>, main: &str) -> Value {
    let view = paused_view(state, main);
    let nothing_to_ask = view["paused"].as_array().is_some_and(|p| p.is_empty())
        && !view["hidden"].as_bool().unwrap_or(true)
        && !view["unreadable"].as_bool().unwrap_or(true)
        && !is_resuming(main);
    if nothing_to_ask {
        if let Ok(left) = awaiting(main) {
            if !left.is_empty() {
                let ids: Vec<String> = left.into_iter().map(|s| s.sub_id).collect();
                if let Err(e) = resolve(main, &ids) {
                    log::warn!("put away: could not settle the empty question of {main}: {e}");
                } else {
                    finish(state, main);
                }
            }
        }
    }
    view
}

/// Why a reopen did not happen.
#[derive(Debug)]
pub enum ReopenError {
    /// A put-away of this chat is still running (waiting for its turn to end).
    BeingPutAway,
    Io(std::io::Error),
}

impl std::fmt::Display for ReopenError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::BeingPutAway => write!(f, "this chat is still being put away, try again in a moment"),
            Self::Io(e) => write!(f, "the reopen could not be recorded: {e}"),
        }
    }
}

/// Opens `main` for the user's message (part 1 of the module docs). Safe to call on a chat
/// that is not put away (it only reports what still waits) and twice (the second call finds
/// the gate open). Returns what waits for the answer, as [`paused_view`] draws it.
pub async fn reopen_main(state: &Arc<DaemonState>, main: &str) -> Result<Value, ReopenError> {
    if super::flow::is_running(main) {
        return Err(ReopenError::BeingPutAway);
    }
    let was_hidden = is_hidden_family(main);
    let waiting = super::reopen(state, main).map_err(ReopenError::Io)?;
    if was_hidden {
        // The put-away froze the chat's child by hand; the user's message wakes it. No
        // "continue": the freeze cut no turn (the put-away waited the turn out).
        state.registry.set_frozen(main, false);
        state.registry.set_auto_frozen(main, false);
        super::super::idle_freeze::forget(state, main);
        let _ = state.registry.take_frozen_needs_continue(main);
        // The family has a main chat to talk to again: events a visiting sub sent meanwhile.
        super::super::remote::home::release_held_events(state, main);
        // Nothing to resume is dealt with now, so the gate never holds a finished sub.
        let done: Vec<String> = waiting.iter().filter(|s| !has_work(state, s)).map(|s| s.sub_id.clone()).collect();
        resolve(main, &done).map_err(ReopenError::Io)?;
    }
    crate::daemon::machines::publish_instances_changed(state);
    crate::sessions::persistence::save_snapshot_default(&state.registry);
    let view = paused_view(state, main);
    if was_hidden && view["paused"].as_array().is_some_and(|p| p.is_empty()) && !view["unreadable"].as_bool().unwrap_or(false) {
        // Nothing waits for an answer: the pause is over, so what it queued goes out now.
        finish(state, main);
    }
    Ok(view)
}

/// What an answer to "Continue the plan?" will do, decided before anything runs.
pub struct ResumePlan {
    main: String,
    /// The waiting subs that resume, in the order the pause recorded them.
    remaining: Vec<PausedSub>,
    ended: usize,
    _guard: Resuming,
}

impl ResumePlan {
    /// How many subs the answer ended.
    pub fn ended(&self) -> usize {
        self.ended
    }

    /// How many subs the answer resumes.
    pub fn resuming(&self) -> usize {
        self.remaining.len()
    }
}

/// Applies the part of the answer that must not wait: the subs named in `end` are released
/// from whatever waits on them, then ended. Every other waiting sub resumes in
/// [`run_resume`]. ("Not now" is no call at all: the subs stay paused and the question
/// stays open.) Err names why nothing was done.
pub fn begin_resume(state: &Arc<DaemonState>, main: &str, end: &[String]) -> Result<ResumePlan, String> {
    let guard = Resuming::begin(main).ok_or_else(|| "the answer is already being applied".to_string())?;
    if is_hidden_family(main) {
        return Err(super::refusal(main));
    }
    let waiting: Vec<PausedSub> = awaiting(main).map_err(|e| format!("the paused subs could not be read: {e}"))?;
    let end: Vec<String> = end.iter().filter(|id| waiting.iter().any(|s| &s.sub_id == *id)).cloned().collect();

    // First, so ending a target never reads as a Blocked wait: a sub that waited on an
    // ended sub carries on as if that wait were satisfied.
    release_dependents(state, main, &end);
    for id in &end {
        let sub = waiting.iter().find(|s| &s.sub_id == id);
        end_one(state, id, sub.is_some_and(|s| s.machine_id.is_some()));
    }
    resolve(main, &end).map_err(|e| format!("the paused subs could not be updated: {e}"))?;

    let remaining = waiting.into_iter().filter(|s| !end.contains(&s.sub_id)).collect();
    Ok(ResumePlan { main: main.to_string(), remaining, ended: end.len(), _guard: guard })
}

/// Marks every ended target as cleared on each held sub of the family that waited on it
/// and is not itself being ended (`evaluate_after` skips a cleared target that has ended).
fn release_dependents(state: &DaemonState, main: &str, end: &[String]) {
    if end.is_empty() {
        return;
    }
    for entry in super::super::held::all() {
        let of_family = state.registry.get(&entry.sub_id).and_then(|i| i.subchat_of).as_deref() == Some(main);
        if !of_family || end.contains(&entry.sub_id) {
            continue;
        }
        let gone: Vec<String> = entry.target_ids().into_iter().filter(|t| end.iter().any(|e| e == t)).map(str::to_string).collect();
        super::super::held::update_cleared(&entry.sub_id, &gone, &[]);
    }
    for rec in super::super::remote::records::of_main(main) {
        if end.contains(&rec.sub_id) {
            continue;
        }
        let gone: Vec<String> = rec.wait().target_ids().into_iter().filter(|t| end.iter().any(|e| e == t)).map(str::to_string).collect();
        super::super::remote::after::store_cleared(&rec.sub_id, &gone, &[]);
    }
}

/// Ends one waiting sub the way the sub's own "End it" does.
fn end_one(state: &Arc<DaemonState>, sub_id: &str, remote: bool) {
    if remote {
        if let Some(rec) = super::super::remote::records::get(sub_id) {
            super::super::remote::actions::end(state, &rec);
        }
    } else if super::super::held::is_held(sub_id) {
        super::super::held::drop_held(state, sub_id);
    } else {
        super::super::resume::end_sub(state, sub_id);
    }
}

/// The children of the family's subs that run now.
fn live_children(state: &DaemonState, main: &str) -> usize {
    state.registry.list().iter().filter(|i| i.subchat_of.as_deref() == Some(main) && state.sessions.contains_key(&i.session_id)).count()
}

/// Waits (bounded) for the family to be under the start cap, so a resume never starts a
/// child past `MAX_RUNNING` unless the wait ran out.
async fn wait_for_room(state: &DaemonState, main: &str, t: &ResumeTiming) {
    let started = std::time::Instant::now();
    while live_children(state, main) >= super::super::spawn::MAX_RUNNING && started.elapsed() < t.cap_wait {
        tokio::time::sleep(t.poll).await;
    }
}

/// Resumes the plan's subs one at a time, then drains what the pause queued (part 2 of the
/// module docs). Each sub leaves the gate just before it is acted on, so a sub that is not
/// resumed yet stays paused.
pub async fn run_resume(state: &Arc<DaemonState>, plan: ResumePlan, t: &ResumeTiming) {
    let main = plan.main.clone();
    for sub in &plan.remaining {
        // The user may put the chat away again while this runs (the stagger takes seconds):
        // a sub woken now would have its freeze mark spent on a send the gate refuses.
        if is_hidden_family(&main) {
            log::warn!("put away: {main} was put away again while its resume ran, so the rest stays paused");
            return;
        }
        let id = sub.sub_id.as_str();
        let mut carried_on = false;
        if sub.machine_id.is_some() {
            if let Err(e) = resolve(&main, &[id.to_string()]) {
                log::warn!("put away: could not release {id} to resume it: {e}");
                continue;
            }
            if let Some(rec) = super::super::remote::records::get(id) {
                carried_on = super::super::remote::actions::queue_resume(state, &rec, sub.needs_continue);
            }
        } else {
            let frozen = state.registry.get(id).is_some_and(|r| r.frozen);
            if frozen {
                wait_for_room(state, &main, t).await;
                if is_hidden_family(&main) {
                    log::warn!("put away: {main} was put away again while {id} waited for room, so it stays paused");
                    return;
                }
            }
            if let Err(e) = resolve(&main, &[id.to_string()]) {
                log::warn!("put away: could not release {id} to resume it: {e}");
                continue;
            }
            // A held sub starts through the sweep below; a frozen one wakes here.
            if frozen {
                carried_on = state.registry.get(id).is_some_and(|r| r.frozen_needs_continue);
                crate::daemon::lifecycle::unfreeze_and_continue(state, id).await;
            }
        }
        if carried_on && !t.gap.is_zero() {
            tokio::time::sleep(t.gap).await;
        }
    }
    finish(state, &main);
}

/// The pause is over: forget the record, start what held back, deliver what queued.
fn finish(state: &Arc<DaemonState>, main: &str) {
    if let Err(e) = super::clear(main) {
        log::warn!("put away: the record of {main} could not be cleared: {e}");
    }
    // Held writers and `after` subs the gate kept back, and the writer slot's line.
    super::super::writers::requeue_held(state);
    super::super::writers::sweep(state);
    if let Ok(handle) = tokio::runtime::Handle::try_current() {
        let state = state.clone();
        handle.spawn(async move { super::super::held::sweep(&state).await });
    }
    // Wake notices queued while the family was away, now that the user has answered.
    crate::daemon::repo_channel_wake::spawn_drain(state, main);
    crate::daemon::machines::publish_instances_changed(state);
    crate::sessions::persistence::save_snapshot_default(&state.registry);
}

/// The whole answer on a detached task, for the RPC: the sync part runs first so its
/// refusal reaches the caller, the staggered part runs behind the reply.
pub fn resume_family(state: &Arc<DaemonState>, main: &str, end: &[String]) -> Result<(usize, usize), String> {
    let plan = begin_resume(state, main, end)?;
    let counts = (plan.ended(), plan.resuming());
    match tokio::runtime::Handle::try_current() {
        Ok(handle) => {
            let state = state.clone();
            handle.spawn(async move { run_resume(&state, plan, &ResumeTiming::default()).await });
        }
        Err(_) => log::warn!("put away: no runtime to resume {main} on"),
    }
    Ok(counts)
}
