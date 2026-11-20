//! Subs the daemon holds without a child: a sub registered with `after` waits
//! here until the sub it named finishes, then the daemon starts it without waking
//! the main agent (spec section 2).
//!
//! A held sub is a real registry row, so it shows in the list and survives a
//! restart with the rest of the snapshot, but it holds no cap slot: it has no
//! process (`spawn::started_subs`). What the
//! snapshot cannot carry is the launch recipe (the first message, the tier, the
//! account) and the thing it waits for, so those live in
//! `<data_dir>/subchats/held.json` (`held-<instance>.json` for a test or dev
//! daemon, see [`file_path`]).
//!
//! **Ends blocked**, the rule that decides between starting a waiting sub and
//! asking Joe, is defined once in [`after_state`]:
//! - the earlier sub was ended (`end_sub`, the stalled-sub card's "End it", a
//!   closed row, or a row that no longer exists), or
//! - it finished with a verdict that says blocked (the word "blocked" in the
//!   verdict, as the nudge and the brief's stop clause teach a sub to write) or
//!   with tone `bad`.
//!
//! A target that already read as finished cleanly is remembered on the entry
//! (`Held::cleared`), so closing it later while a sibling target still runs does not
//! turn into the first case; a target closed before it ever read clean still does.
//!
//! A crash is not its own case: a sub whose process died raises its own
//! "stopped" card, and the waiting sub keeps waiting while Joe answers it. If he
//! ends the sub, that is the first case; if he nudges it, it finishes later.
//!
//! Parent gone: a held sub whose main chat ended with no successor, or whose
//! `subchat_of` was cleared, is dropped (ended without ever running), never
//! promoted to a sidebar chat, because promoting a chat that never ran would
//! leave an empty row that cannot resume. A respawn moves the sub with the rest
//! of the main chat's subs (it reads `subchat_of` live), so the successor's
//! link is checked before a parent counts as gone.
//!
//! The 60 second tick, a boot pass and the two events that can end a wait
//! (`on_finished`, `end_sub`) all run the same [`release_ready`], so a finish
//! while the daemon was down releases the sub at boot.

use super::cards::{self, CardAnswer, CardOption, RaisedCard};
use super::finish::{self, FinishRecord};
use super::spawn::{HoldPlan, SubPlan};
use crate::daemon::lifecycle::{self, StartSessionParams};
use crate::daemon::state::DaemonState;
use crate::sessions::chat_config::ChatConfig;
use crate::types::Instance;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::future::Future;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

/// Card kind for a held sub that needs Joe: its target ended blocked. A sub that
/// could not start is plumbing, so it wakes the main chat instead (`plumbing`),
/// which starts it again with `subchat retry` ([`retry`]).
pub const CARD_KIND: &str = "subchat_held";
/// What a launch reports for a sub that ended before its child started, whether
/// before the launch began or while its worktree was being set up. Nobody is told
/// about it: an ended sub has nothing left to retry.
pub(crate) const ENDED_BEFORE_START: &str = "it has been ended";
pub const START_ANYWAY: &str = "Start it anyway";
pub const DROP_IT: &str = "Drop it";

/// Everything needed to start the child later, as `spawn_chat` would have.
///
/// Every field has a default, so an entry written by an older build still loads.
/// Only `Held::sub_id` is required: an entry that names no sub has nobody to start.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct LaunchSpec {
    #[serde(default)]
    pub cwd: PathBuf,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub effort: String,
    /// The account the main chat ran on, resolved when the sub was registered.
    #[serde(default)]
    pub account_id: Option<String>,
    #[serde(default)]
    pub first_message: String,
}

/// One held sub.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Held {
    pub sub_id: String,
    /// The words the sub's row shows ("waiting for header").
    #[serde(default)]
    pub reason: String,
    /// The sub it waits for, or several, one id per line (an entry written before
    /// `after` took a list holds one id, which reads the same). `None` for a hold
    /// some other rule owns (the writer queue): [`release_ready`] leaves those to
    /// their owner and [`launch_held`] starts one on request.
    #[serde(default)]
    pub after: Option<String>,
    /// The names of `after`'s subs, one per line, in the same order.
    #[serde(default)]
    pub after_name: String,
    /// Targets that already read as finished cleanly. Closing such a sub afterwards
    /// (it merged, then Joe closed it while a sibling target still runs) is not
    /// "ended before it finished", so [`after_all`] skips such a target once it has
    /// ended. One still running is read again.
    #[serde(default)]
    pub cleared: Vec<String>,
    #[serde(default)]
    pub launch: LaunchSpec,
}

impl Held {
    /// The ids of the subs this one waits for.
    pub fn target_ids(&self) -> Vec<&str> {
        self.after.as_deref().map(|a| a.lines().map(str::trim).filter(|l| !l.is_empty()).collect()).unwrap_or_default()
    }

    /// Their names, in the same order.
    fn target_names(&self) -> Vec<&str> {
        self.after_name.lines().map(str::trim).filter(|l| !l.is_empty()).collect()
    }

    /// The names in words, "header" or "header, footer".
    pub fn names_display(&self) -> String {
        self.target_names().join(", ")
    }
}

/// Serialises read-modify-write of the file. The file is small and read rarely,
/// so there is no in-memory copy to drift from it.
static FILE_LOCK: Mutex<()> = Mutex::new(());

/// Held subs Joe has been asked about and skipped, or whose launch failed and is
/// waiting on his answer. They are not retried until a restart, which is when a
/// raised card (never persisted) is asked again.
static PARKED: Mutex<Option<HashSet<String>>> = Mutex::new(None);

/// Subs a launch is in flight for, so a finish event and the tick cannot both start one.
static LAUNCHING: Mutex<Option<HashSet<String>>> = Mutex::new(None);

/// One file per daemon instance. A test, dev or wdio daemon runs on the same data
/// folder as the live app with a registry of its own, and its boot pass reads a
/// held sub its registry does not know as one that vanished and forgets it: a
/// shared file let every `cargo test` wipe the live app's queue (2026-11-10, the
/// `test-pclient` lib test). The default instance keeps the plain `held.json`.
fn file_path() -> Option<PathBuf> {
    let suffix = crate::daemon::instance::instance_suffix();
    crate::settings::paths::data_dir().ok().map(|d| d.join("subchats").join(format!("held{suffix}.json")))
}

/// Entry by entry, so one that will not decode costs only itself. Anything
/// unreadable is kept aside as `<held file>.bad` before the next write replaces the
/// file (see [`super::jsonfile`]).
fn read_unlocked() -> Vec<Held> {
    try_read_unlocked().unwrap_or_default()
}

/// [`read_unlocked`] for a writer: `Err` when the file exists but cannot be read now
/// (locked), so the caller stops instead of writing a set built from nothing over it.
fn try_read_unlocked() -> std::io::Result<Vec<Held>> {
    let Some(path) = file_path() else { return Ok(Vec::new()) };
    try_read_at(&path)
}

fn try_read_at(path: &std::path::Path) -> std::io::Result<Vec<Held>> {
    super::jsonfile::read_list_guarded(path)
}

fn write_unlocked(all: &[Held]) -> std::io::Result<()> {
    let path = file_path().ok_or_else(super::jsonfile::no_data_dir)?;
    super::jsonfile::write_json(&path, all)
}

/// Every held sub, oldest first.
pub fn all() -> Vec<Held> {
    let _g = FILE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    read_unlocked()
}

/// What a visiting sub's row says while it waits for its home to start it.
pub(crate) const WAITING_ON_HOME: &str = "waiting on its main chat for ";

/// A visiting sub the host registered held for an `after` chain: its home starts it, so
/// no boot pass or queue of this machine may (a hold without `after` is otherwise a
/// writer waiting for the slot, or a tree being set up, which those passes do start).
pub(crate) fn waits_on_home(h: &Held) -> bool {
    h.after.is_none() && h.reason.starts_with(WAITING_ON_HOME) && super::is_visiting(&h.sub_id)
}

/// Whether the daemon is holding `sub_id` without a child. The sweeps that look
/// for a dead, stuck or over-long sub call this first: a held sub has no process
/// because it has not started, which is not a death.
pub fn is_held(sub_id: &str) -> bool {
    all().iter().any(|h| h.sub_id == sub_id)
}

/// Holds `entry`'s sub: persists the recipe and marks the row as waiting. A
/// second hold for the same sub replaces the first.
pub fn hold(state: &DaemonState, entry: Held) -> std::io::Result<()> {
    {
        let _g = FILE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut held = try_read_unlocked()?;
        held.retain(|h| h.sub_id != entry.sub_id);
        held.push(entry.clone());
        write_unlocked(&held)?;
    }
    state.registry.set_waiting_for(&entry.sub_id, Some(entry.reason));
    Ok(())
}

/// Takes `sub_id` out of the held set and clears its waiting mark. The entry is
/// returned so a failed launch can put it back. The caller is logged: a hold that
/// vanished with nothing in the log (2026-11-13, a queued sub found with no hold
/// ten hours after its rebuild) could not be traced to the path that took it.
#[track_caller]
pub fn release(state: &DaemonState, sub_id: &str) -> Option<Held> {
    release_checked(state, sub_id).ok().flatten()
}

/// [`release`] that tells "not held" (`Ok(None)`) from "the file could not be read now"
/// (`Err`), for a caller that must not leave a running sub looking held.
#[track_caller]
pub(crate) fn release_checked(state: &DaemonState, sub_id: &str) -> std::io::Result<Option<Held>> {
    let caller = std::panic::Location::caller();
    let taken = {
        let _g = FILE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut held = try_read_unlocked()?;
        let Some(at) = held.iter().position(|h| h.sub_id == sub_id) else { return Ok(None) };
        let entry = held.remove(at);
        if let Err(e) = write_unlocked(&held) {
            log::warn!("subchats: could not store the held set after releasing {sub_id}: {e}");
        }
        entry
    };
    log::info!("subchats: released the hold of {sub_id} (from {}:{})", caller.file(), caller.line());
    state.registry.set_waiting_for(sub_id, None);
    Ok(Some(taken))
}

pub(crate) fn claim_launch(sub_id: &str) -> Option<LaunchGuard> {
    let mut g = LAUNCHING.lock().unwrap_or_else(|e| e.into_inner());
    g.get_or_insert_with(HashSet::new).insert(sub_id.to_string()).then(|| LaunchGuard(sub_id.to_string()))
}

pub(crate) struct LaunchGuard(String);

impl Drop for LaunchGuard {
    fn drop(&mut self) {
        if let Some(set) = LAUNCHING.lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
            set.remove(&self.0);
        }
    }
}

pub(crate) fn parked(sub_id: &str) -> bool {
    PARKED.lock().unwrap_or_else(|e| e.into_inner()).as_ref().is_some_and(|s| s.contains(sub_id))
}

pub(crate) fn set_parked(sub_id: &str, on: bool) {
    let mut g = PARKED.lock().unwrap_or_else(|e| e.into_inner());
    let set = g.get_or_insert_with(HashSet::new);
    if on {
        set.insert(sub_id.to_string());
    } else {
        set.remove(sub_id);
    }
}

/// Where the sub a held sub waits for stands.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AfterState {
    /// It finished and said nothing was blocked: start now.
    Clean,
    /// Still running, idle, or itself held.
    Pending,
    /// It ended blocked; the string says how, for the card.
    Blocked(String),
}

/// Whether a finish record counts as ended blocked: the verdict says so, or the
/// sub marked it a bad outcome.
pub fn is_blocked_finish(record: &FinishRecord) -> bool {
    if record.tone.as_deref() == Some("bad") {
        return true;
    }
    record
        .verdict
        .to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .any(|word| word == "blocked")
}

/// [`after_state`] for a target that runs on a paired machine: it has no row here, so
/// the home's record of it and its finish record stand in for one.
fn remote_after_state(rec: &super::remote::records::RemoteSub) -> AfterState {
    use super::remote::records::RemoteState;
    match rec.state {
        // A finish numbered after the end of the same chat still counts (`finished_after_end`).
        RemoteState::Ended if !rec.finished_after_end => AfterState::Blocked("it was ended before it finished".to_string()),
        RemoteState::Held | RemoteState::Running => AfterState::Pending,
        RemoteState::Finished | RemoteState::Ended => {
            // Its commits are still being fetched and merged: a sub that started now would be
            // caught up to a target that does not have them yet.
            if super::merge_followup::unresolved(&rec.sub_id) || super::merge_followup::landing_in_flight(&rec.sub_id) {
                return AfterState::Pending;
            }
            match finish::read_record(&rec.sub_id) {
                Some(r) if is_blocked_finish(&r) => AfterState::Blocked(format!("it finished as \"{}\"", r.verdict.trim())),
                _ => AfterState::Clean,
            }
        }
    }
}

/// Whether `id` names a target that has ended, on this machine or a paired one.
fn target_ended(state: &DaemonState, id: &str) -> bool {
    match state.registry.get(id) {
        Some(t) => t.ended_at.is_some() || t.end_reason.is_some(),
        None => super::remote::records::get(id).is_some_and(|r| r.state == super::remote::records::RemoteState::Ended),
    }
}

pub fn after_state(state: &DaemonState, target_id: &str) -> AfterState {
    let Some(target) = state.registry.get(target_id) else {
        return match super::remote::records::get(target_id) {
            Some(rec) => remote_after_state(&rec),
            None => AfterState::Blocked("it no longer exists".to_string()),
        };
    };
    // Any ended target is blocked, even one that had finished: ending it forgets a
    // refused merge (`end_sub`), so its commits may never have landed.
    if target.ended_at.is_some() || target.end_reason.is_some() {
        return AfterState::Blocked("it was ended before it finished".to_string());
    }
    // Its commits did not land and that is still being handled: a job that builds
    // on them would build on the wrong code.
    if !target.subchat_finished || super::merge_followup::unresolved(target_id) {
        return AfterState::Pending;
    }
    match finish::read_record(target_id) {
        Some(r) if is_blocked_finish(&r) => AfterState::Blocked(format!("it finished as \"{}\"", r.verdict.trim())),
        // No readable record: unknown never blocks.
        _ => AfterState::Clean,
    }
}

/// Where a held sub's wait stands over every sub it waits for: blocked as soon as
/// any one ended blocked (with that sub's name), clean only when all finished
/// cleanly, else pending. The name is the blocked sub's, or all of them.
pub fn after_all(state: &DaemonState, entry: &Held) -> (AfterState, String) {
    let (verdict, name, add, remove) = evaluate_after(state, entry);
    update_cleared(&entry.sub_id, &add, &remove);
    (verdict, name)
}

/// [`after_all`] without storing the cleared targets: the verdict, the name, and the
/// targets to add to and remove from `entry.cleared`. A caller whose entry does not
/// live in `held.json` (a remote sub's record) stores them itself.
pub(crate) fn evaluate_after(state: &DaemonState, entry: &Held) -> (AfterState, String, Vec<String>, Vec<String>) {
    let names = entry.target_names();
    let mut pending = false;
    let mut newly_cleared: Vec<String> = Vec::new();
    let mut reopened: Vec<String> = Vec::new();
    let mut blocked: Option<(String, String)> = None;
    for (i, id) in entry.target_ids().into_iter().enumerate() {
        // Only the ended case is skipped: a cleared target that went back to work (a
        // nudge, a merge conflict after its finish) is read again like any other.
        if entry.cleared.iter().any(|c| c == id) && target_ended(state, id) {
            continue;
        }
        let was_cleared = entry.cleared.iter().any(|c| c == id);
        match after_state(state, id) {
            AfterState::Blocked(why) => {
                if was_cleared {
                    reopened.push(id.to_string());
                }
                let name = names.get(i).map_or_else(|| entry.names_display(), |n| n.to_string());
                blocked = Some((why, name));
                break;
            }
            AfterState::Pending => {
                pending = true;
                if was_cleared {
                    reopened.push(id.to_string());
                }
            }
            AfterState::Clean => {
                if !was_cleared {
                    newly_cleared.push(id.to_string());
                }
            }
        }
    }
    // Written even when a later target blocked: this one did finish cleanly. A cleared
    // target that is running again loses its mark, so closing it later (its merge
    // refused the second time) blocks the wait like any other ended target.
    if let Some((why, name)) = blocked {
        return (AfterState::Blocked(why), name, newly_cleared, reopened);
    }
    (if pending { AfterState::Pending } else { AfterState::Clean }, entry.names_display(), newly_cleared, reopened)
}

/// Adds `add` to and removes `remove` from `sub_id`'s cleared targets. A no-op when
/// the entry is gone or nothing changes.
fn update_cleared(sub_id: &str, add: &[String], remove: &[String]) {
    if add.is_empty() && remove.is_empty() {
        return;
    }
    let _g = FILE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let Ok(mut held) = try_read_unlocked() else { return };
    let Some(entry) = held.iter_mut().find(|h| h.sub_id == sub_id) else { return };
    let before = entry.cleared.clone();
    entry.cleared.retain(|c| !remove.contains(c));
    for id in add {
        if !entry.cleared.contains(id) {
            entry.cleared.push(id.clone());
        }
    }
    if entry.cleared != before {
        if let Err(e) = write_unlocked(&held) {
            log::warn!("subchats: could not store the cleared targets of {sub_id}: {e}");
        }
    }
}

pub(super) fn subs_of(state: &DaemonState, parent: &str) -> Vec<Instance> {
    let mut subs: Vec<Instance> =
        state.registry.list().into_iter().filter(|i| i.subchat_of.as_deref() == Some(parent)).collect();
    subs.sort_by(|a, b| a.started_at.cmp(&b.started_at));
    subs
}

/// Resolves `spawn_chat`'s `after` among `parent`'s subs, finished or running, by
/// the same name rules the `subchat` tool uses. `Ok(None)` means start now (every
/// named sub already finished cleanly); `Ok(Some)` means hold, for the ones still
/// running. A name that matches none or several is refused with the subs listed,
/// and so is a sub that already ended blocked: that sub's own card tells Joe, and a
/// card for a job that was never registered would have nothing to start.
pub fn plan_after_all(state: &DaemonState, parent: &str, queries: &[String]) -> Result<Option<HoldPlan>, String> {
    let subs = subs_of(state, parent);
    let mut targets: Vec<(String, String)> = Vec::new();
    let remote = super::tool::remote_of(parent);
    for query in queries {
        // A sub on a paired machine is a target like any other: it has a record here, not a row.
        let (target_id, name) = match super::tool::resolve(&subs, query) {
            Ok(target) => (target.session_id.clone(), super::tool::label(target)),
            // Only a miss falls through to a remote sub; a name that is ambiguous among this
            // machine's subs is refused as it always was.
            Err(e) if e.starts_with("No sub named") => match super::tool::resolve_remote(&remote, query) {
                Some(rec) => (rec.sub_id.clone(), super::remote::actions::name_of(rec)),
                None => return Err(format!("after: {e}")),
            },
            Err(e) => return Err(format!("after: {e}")),
        };
        match after_state(state, &target_id) {
            AfterState::Clean => {}
            AfterState::Pending => {
                if !targets.iter().any(|(id, _)| *id == target_id) {
                    targets.push((target_id.clone(), name));
                }
            }
            AfterState::Blocked(why) => {
                return Err(format!(
                    "after: {name} ended blocked ({why}), so a job waiting for it would never start. Joe's card for that sub already tells him, so say nothing of your own; spawn this job without after only if he says to go on without it."
                ));
            }
        }
    }
    Ok((!targets.is_empty()).then_some(HoldPlan { targets }))
}

/// [`plan_after_all`] for one name.
pub fn plan_after(state: &DaemonState, parent: &str, query: &str) -> Result<Option<HoldPlan>, String> {
    plan_after_all(state, parent, &[query.to_string()])
}

/// Registers the row of a sub `plan` says must wait, and holds it. The caller is
/// `spawn_chat`; no child is started, so nothing here can fail on a missing
/// `claude`. The checks a launch would make that depend on the request
/// (the folder, the account) run now, so a bad request is refused to the main
/// agent instead of surfacing a minute later as a card.
pub async fn register(
    state: &Arc<DaemonState>,
    caller_session_id: &str,
    name: Option<&str>,
    inherited: &ChatConfig,
    mut spec: LaunchSpec,
    plan: &mut SubPlan,
) -> Result<String, String> {
    let default_account_id = state.settings.snapshot().default_account_id;
    let account = crate::accounts::resolve_account(spec.account_id.as_deref(), default_account_id.as_deref())
        .map_err(|e| e.to_string())?;
    spec.account_id = Some(account.id);
    register_row(state, caller_session_id, name, inherited, spec, plan)
}

/// [`register`] once the account is resolved: the row, the brief and the hold.
/// Split out so a test needs no accounts file.
pub(crate) fn register_row(
    state: &Arc<DaemonState>,
    caller_session_id: &str,
    name: Option<&str>,
    inherited: &ChatConfig,
    spec: LaunchSpec,
    plan: &mut SubPlan,
) -> Result<String, String> {
    let target = plan.hold.clone().ok_or_else(|| "this sub has nothing to wait for".to_string())?;
    let reason = format!("waiting for {}", target.names_display());
    register_held_row(state, caller_session_id, name, inherited, spec, plan, uuid::Uuid::new_v4().to_string(), reason, Some(target))
}

/// The row, the brief and the hold under the id `sid`. `target` is the sub a wait
/// is for; `None` is a hold some other rule owns (the writer queue), which
/// [`release_ready`] leaves alone.
pub(crate) fn register_held_row(
    state: &Arc<DaemonState>,
    caller_session_id: &str,
    name: Option<&str>,
    inherited: &ChatConfig,
    spec: LaunchSpec,
    plan: &mut SubPlan,
    sid: String,
    reason: String,
    target: Option<HoldPlan>,
) -> Result<String, String> {
    if !spec.cwd.exists() {
        return Err(lifecycle::LifecycleError::CwdMissing(spec.cwd.clone()).to_string());
    }
    let account = spec.account_id.clone().unwrap_or_default();
    let now = chrono::Utc::now().to_rfc3339();
    let auto_accept = crate::daemon::session_registration::spawned_auto_accept(
        inherited.auto_accept,
        state.settings.snapshot().spawned_chats_inherit_auto_accept(),
        false,
    );
    crate::daemon::session_registration::register_new_session(
        state, &sid, &spec.cwd, &spec.model, &spec.effort, &account, &now, auto_accept, None, false,
    );
    if let Some(n) = name {
        state.registry.set_name(&sid, n.to_string());
    }
    crate::sessions::chat_config::set_spawned_by(&sid, caller_session_id);
    super::spawn::mark_as_sub(state, &sid, plan);
    hold(
        state,
        Held {
            sub_id: sid.clone(),
            reason,
            after: target.as_ref().map(|t| t.targets.iter().map(|(id, _)| id.as_str()).collect::<Vec<_>>().join("\n")),
            after_name: target
                .map(|t| t.targets.iter().map(|(_, n)| n.replace('\n', " ")).collect::<Vec<_>>().join("\n"))
                .unwrap_or_default(),
            cleared: Vec::new(),
            launch: spec,
        },
    )
    .map_err(|e| format!("could not store the held sub: {e}"))?;
    crate::sessions::persistence::save_snapshot_default(&state.registry);
    crate::daemon::machines::publish_instances_changed(state);
    Ok(sid)
}

/// The launcher the production paths use.
pub(super) async fn production_launch(state: Arc<DaemonState>, sub_id: String) -> Result<(), String> {
    launch_held(&state, &sub_id).await
}

/// Starts a held sub's child with the first message it was registered with, as
/// `spawn_chat` would have, and takes it out of the held set. A failure puts it
/// back and says why.
pub async fn launch_held(state: &Arc<DaemonState>, sub_id: &str) -> Result<(), String> {
    // Another caller is already starting it; its result is the result.
    let Some(_claim) = claim_launch(sub_id) else { return Ok(()) };
    launch_claimed(state, sub_id).await
}

/// [`launch_held`] for a caller that holds the launch claim itself (its guard outlives the
/// call), so it knows it is the one launching: Joe's "Start now" must not mistake a lost
/// claim for a launch.
pub(crate) async fn launch_claimed(state: &Arc<DaemonState>, sub_id: &str) -> Result<(), String> {
    let entry = all().into_iter().find(|h| h.sub_id == sub_id).ok_or_else(|| format!("{sub_id} is not held"))?;
    let inst = state.registry.get(sub_id).ok_or_else(|| format!("unknown session: {sub_id}"))?;
    if inst.ended_at.is_some() {
        release(state, sub_id);
        return Err(ENDED_BEFORE_START.to_string());
    }
    // A child already runs under this id and has begun a turn: an earlier launch started
    // it and its hold could not be removed then (see below). Starting a second one would
    // run the job twice. A child that has not begun one is a failed start's dying child
    // (its message never went out), which the retry must still see fail and keep the hold.
    if state.sessions.contains_key(sub_id) && (inst.busy || state.registry.current_turn_gen(sub_id) > 0) {
        release(state, sub_id);
        return Ok(());
    }
    let parent = inst.subchat_of.clone().ok_or_else(|| "it is no longer a sub".to_string())?;
    // A worktree sub's tree is set up and caught up to its target first; a failure
    // has drawn its own blocker card and stops the launch.
    if let Err(e) = super::worktree::before_launch(state, sub_id).await {
        if e == ENDED_BEFORE_START {
            release(state, sub_id);
        }
        return Err(e);
    }
    // Its facts count from now, not from the day it was queued: the sub it waited
    // for committed in between, and those commits are not this job's.
    if let Some(mut brief) = crate::sessions::chat_config::get(sub_id).and_then(|c| c.subchat) {
        brief.git_head_at_spawn = super::git::head(&inst.cwd);
        if brief.gate {
            brief.upstream_at_spawn = super::git::upstream(&inst.cwd);
        }
        crate::sessions::chat_config::set_subchat(sub_id, Some(brief));
    }
    let params = StartSessionParams {
        cwd: entry.launch.cwd.clone(),
        model: entry.launch.model.clone(),
        effort: entry.launch.effort.clone(),
        resume_id: None,
        account_id: entry.launch.account_id.clone(),
        fork: false,
        // The row exists under this id, so the child is started under it.
        new_session_id: Some(sub_id.to_string()),
    };
    let session = lifecycle::spawn_session_as(state, params, Some(&parent)).await.map_err(|e| e.to_string())?;
    // The child runs now. A file that cannot be read this instant must not leave it
    // looking held (the dead and stuck sweeps skip a held sub, and the next pass would
    // launch it again), so the release is retried, and the mark cleared at the end.
    let mut released = release_checked(state, sub_id);
    for _ in 0..5 {
        if released.is_ok() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        released = release_checked(state, sub_id);
    }
    if let Err(e) = released {
        log::warn!("subchats: {sub_id} started but its hold could not be removed: {e}");
        state.registry.set_waiting_for(sub_id, None);
    }
    if let Err(e) = lifecycle::send_message(&session, &entry.launch.first_message, false).await {
        // NotFound just means the child already exited.
        let _ = lifecycle::end_session(&state.sessions, sub_id).await;
        if let Err(store) = hold(state, entry) {
            log::warn!("subchats: could not put {sub_id} back in the held set: {store}");
        }
        return Err(e.to_string());
    }
    state.registry.set_awaiting(sub_id, None);
    state.registry.set_busy(sub_id, true);
    crate::sessions::chat_state::set_busy(sub_id, true);
    crate::daemon::machines::publish_instances_changed(state);
    crate::sessions::persistence::save_snapshot_default(&state.registry);
    // It runs: an earlier failed start is no longer a problem.
    super::plumbing::resolved(state, sub_id);
    log::info!("subchats: started held sub {sub_id} (it waited for {})", entry.names_display());
    Ok(())
}

/// `subchat retry`: starts a held sub again whose start failed, as the old "Try
/// again" card did. Only a sub whose start failed qualifies; any other queued sub
/// starts by itself when what it waits for is done. `launch` is injected so a test
/// starts no `claude`. A failure keeps it held and parked, and is the tool's
/// result rather than another wake.
pub async fn retry_with<F, Fut>(state: &Arc<DaemonState>, sub_id: &str, launch: F) -> Result<(), String>
where
    F: Fn(Arc<DaemonState>, String) -> Fut,
    Fut: Future<Output = Result<(), String>>,
{
    let name = state.registry.get(sub_id).map(|i| super::tool::label(&i)).unwrap_or_else(|| sub_id.chars().take(8).collect());
    // Not every parked sub: one whose target ended blocked was parked by Joe's
    // skip, and starting it is his decision.
    let failed = super::plumbing::current(sub_id).is_some_and(|r| r.problem == super::plumbing::Problem::CouldNotStart);
    if !is_held(sub_id) || !failed {
        return Err(format!(
            "{name} has no failed start to retry: retry is for a sub the app could not start. A queued sub starts by itself when what it waits for is done (action status says what that is)."
        ));
    }
    set_parked(sub_id, false);
    let _quiet = super::plumbing::quiet(sub_id);
    match launch(state.clone(), sub_id.to_string()).await {
        Ok(()) => {
            super::plumbing::resolved(state, sub_id);
            Ok(())
        }
        Err(e) if e == ENDED_BEFORE_START => {
            // It ended since the failure: nothing is left to retry or to report.
            super::plumbing::resolved(state, sub_id);
            Err(format!("{name} has ended, so there is nothing to retry"))
        }
        Err(e) => {
            log::warn!("subchats: retrying held sub {sub_id} failed: {e}");
            super::plumbing::report(state, sub_id, super::plumbing::Problem::CouldNotStart, e.clone(), Vec::new());
            set_parked(sub_id, true);
            Err(format!("{name} still could not start: {e}"))
        }
    }
}

/// [`retry_with`] against the real launcher.
pub async fn retry(state: &Arc<DaemonState>, sub_id: &str) -> Result<(), String> {
    retry_with(state, sub_id, production_launch).await
}

/// Ends a held sub that will not run: Joe dropped it, or its main chat is gone.
/// The row is kept as an ended sub, so it stays out of every list and the
/// transcript-less chat is never offered for resuming.
pub fn drop_held(state: &Arc<DaemonState>, sub_id: &str) {
    release(state, sub_id);
    set_parked(sub_id, false);
    super::resume::end_sub(state, sub_id);
    crate::sessions::persistence::save_snapshot_default(&state.registry);
}

/// Drops every held sub of `parent`. For the main chat crashing or closing with
/// no successor: a held sub never ran, so it is dropped, not promoted. Returns
/// the ids dropped.
#[cfg(test)]
pub fn drop_held_of_parent(state: &Arc<DaemonState>, parent: &str) -> Vec<String> {
    let ids: Vec<String> = all()
        .into_iter()
        .filter(|h| state.registry.get(&h.sub_id).and_then(|i| i.subchat_of).as_deref() == Some(parent))
        .map(|h| h.sub_id)
        .collect();
    for id in &ids {
        drop_held(state, id);
    }
    ids
}

/// True when a held sub has no main chat left to run for. A parent that ended
/// but was respawned (a row names it as its predecessor) is not gone: the subs
/// move to the successor.
pub(super) fn orphaned(state: &DaemonState, sub_id: &str) -> bool {
    let Some(inst) = state.registry.get(sub_id) else { return true };
    let Some(parent) = inst.subchat_of.as_deref() else { return true };
    // A visiting sub's main chat is on its home machine, never in this registry.
    if super::is_visiting(sub_id) {
        return false;
    }
    !chat_live(state, parent) && !state.registry.list().iter().any(|i| i.successor_of.as_deref() == Some(parent))
}

/// Whether a main chat is still there to run for: its row is open, or the daemon
/// holds its child. The child counts because a row can stay `ended_at` while the
/// chat runs again (a SessionEnd hook closed an External row, then a scheduled
/// wake resumed it, 2026-11-14: the sub it spawned 20 seconds after was dropped as
/// orphaned and its worktree went with it, mid-setup).
pub(crate) fn chat_live(state: &DaemonState, chat_id: &str) -> bool {
    state.registry.get(chat_id).is_some_and(|p| p.ended_at.is_none()) || state.sessions.contains_key(chat_id)
}

pub(crate) enum Why {
    TargetBlocked { target: String, why: String },
    LaunchFailed(String),
}

/// Boxed because the card's answer runs this again (a "Start it anyway" that
/// fails), which makes this future contain itself; the compiler cannot prove such
/// a future is `Send` unless the cycle goes through a trait object.
pub(crate) fn raise_decision(state: &Arc<DaemonState>, held: &Held, why: Why) -> std::pin::Pin<Box<dyn Future<Output = ()> + Send>> {
    let (state, held) = (state.clone(), held.clone());
    Box::pin(async move { raise_decision_now(&state, &held, why).await })
}

async fn raise_decision_now(state: &Arc<DaemonState>, held: &Held, why: Why) {
    let sub_id = held.sub_id.as_str();
    let (target, why) = match why {
        // A failed start is plumbing: the main chat is told, Joe is not asked.
        Why::LaunchFailed(err) => {
            // An ended sub has nothing left to retry, so its main chat is not woken.
            if err == ENDED_BEFORE_START {
                return;
            }
            super::plumbing::report(state, sub_id, super::plumbing::Problem::CouldNotStart, err, Vec::new());
            return;
        }
        Why::TargetBlocked { target, why } => (target, why),
    };
    if cards::open_card_for(state, CARD_KIND, sub_id).await.is_some() {
        return;
    }
    let Some(parent) = state.registry.get(sub_id).and_then(|i| i.subchat_of) else { return };
    let name = state.registry.get(sub_id).and_then(|i| i.name).filter(|n| !n.trim().is_empty()).unwrap_or_else(|| "A sub".to_string());
    let question = format!("**{target}** ended blocked ({why}), and **{name}** was waiting for it.\n\nStart {name} anyway, or drop it?");
    let options = vec![
        CardOption::new(START_ANYWAY, "Run it now, without the earlier job"),
        CardOption::new(DROP_IT, "Do not run it"),
    ];
    let card = RaisedCard {
        kind: CARD_KIND,
        display_session_id: parent,
        sub_id: Some(sub_id.to_string()),
        header: "Queued sub".to_string(),
        question,
        options,
        domain: None,
    };
    match cards::raise_card(state, card).await {
        Ok(handle) => {
            let (state, sub) = (state.clone(), sub_id.to_string());
            handle.on_answer(move |answer| async move { apply_answer(&state, &sub, answer, &production_launch).await });
        }
        Err(e) => log::warn!("subchats: could not raise the held-sub card for {sub_id}: {e}"),
    }
}

/// What each answer to the held-sub card does. A skip parks the sub until the
/// next restart rather than asking again every minute, and so does a failed
/// "Start it anyway": the main chat is woken about it and retries it, not the tick.
pub(crate) async fn apply_answer<F, Fut>(state: &Arc<DaemonState>, sub_id: &str, answer: CardAnswer, launch: &F)
where
    F: Fn(Arc<DaemonState>, String) -> Fut,
    Fut: Future<Output = Result<(), String>>,
{
    match answer {
        CardAnswer::Picked(choice) if choice == START_ANYWAY => {
            set_parked(sub_id, false);
            if let Err(e) = launch(state.clone(), sub_id.to_string()).await {
                log::warn!("subchats: held sub {sub_id} could not start: {e}");
                if let Some(h) = all().into_iter().find(|h| h.sub_id == sub_id) {
                    raise_decision(state, &h, Why::LaunchFailed(e)).await;
                    set_parked(sub_id, true);
                }
            }
        }
        CardAnswer::Picked(choice) if choice == DROP_IT => drop_held(state, sub_id),
        CardAnswer::Picked(other) => log::info!("subchats: ignoring held-sub card answer {other:?} for {sub_id}"),
        CardAnswer::Skipped => set_parked(sub_id, true),
        CardAnswer::Withdrawn => {}
    }
}

/// One pass over the held set: start every sub whose target finished cleanly,
/// ask Joe about every one whose target ended blocked, drop those with no main
/// chat. `launch` is injected so a test starts no `claude`.
pub async fn release_ready<F, Fut>(state: &Arc<DaemonState>, launch: F)
where
    F: Fn(Arc<DaemonState>, String) -> Fut,
    Fut: Future<Output = Result<(), String>>,
{
    for entry in all() {
        // A row that ended or vanished while queued never starts: forget its recipe.
        if state.registry.get(&entry.sub_id).is_none_or(|i| i.ended_at.is_some()) {
            release(state, &entry.sub_id);
            continue;
        }
        if orphaned(state, &entry.sub_id) {
            log::info!("subchats: held sub {} has no main chat left, dropping it", entry.sub_id);
            drop_held(state, &entry.sub_id);
            continue;
        }
        if entry.after.is_none() || parked(&entry.sub_id) {
            continue;
        }
        let (verdict, blocked_name) = after_all(state, &entry);
        match verdict {
            AfterState::Pending => {}
            AfterState::Clean => {
                if let Err(e) = launch(state.clone(), entry.sub_id.clone()).await {
                    log::warn!("subchats: held sub {} could not start: {e}", entry.sub_id);
                    raise_decision(state, &entry, Why::LaunchFailed(e)).await;
                    set_parked(&entry.sub_id, true);
                }
            }
            AfterState::Blocked(why) => {
                raise_decision(state, &entry, Why::TargetBlocked { target: blocked_name, why }).await;
            }
        }
    }
}

pub(crate) fn launching(sub_id: &str) -> bool {
    LAUNCHING.lock().unwrap_or_else(|e| e.into_inner()).as_ref().is_some_and(|s| s.contains(sub_id))
}

/// The production pass: rebuilds lost holds, then starts real children.
pub async fn sweep(state: &Arc<DaemonState>) {
    super::lost_hold::recover_lost(state);
    release_ready(state, production_launch).await;
    // Subs held on a paired machine wait on this machine's family too. Detached: a start is a
    // host call (up to 120 s, after a cold dial), and this pass runs inside the one watchdog
    // task every other sweep of the tick waits behind. Without a runtime (a test) it runs here.
    match tokio::runtime::Handle::try_current() {
        Ok(handle) => {
            let state = state.clone();
            handle.spawn(async move { super::remote::after::sweep(&state).await });
        }
        Err(_) => super::remote::after::sweep(state).await,
    }
}

/// The hook for "a sub finished or ended": runs a pass on its own task, because
/// both callers are synchronous and one sits inside the pump's result handler,
/// where an inline respawn would make the pump future self-referential (see
/// [`super::on_finished`]). With no runtime there is nothing to start a child on.
pub fn on_target_done(state: &Arc<DaemonState>) {
    if all().is_empty() && !super::remote::after::any_waiting() {
        return;
    }
    if let Ok(handle) = tokio::runtime::Handle::try_current() {
        let state = state.clone();
        handle.spawn(async move { sweep(&state).await });
    }
}

/// Boot: marks every held row as waiting again (the mark is not persisted with
/// the row) and runs a pass, which also covers a sub whose target finished while
/// the daemon was down. Called once the registry is restored.
pub fn on_boot(state: &Arc<DaemonState>) {
    restamp(state);
    super::pause::sync_parked(state);
    crate::daemon::machines::publish_instances_changed(state);
    if let Ok(handle) = tokio::runtime::Handle::try_current() {
        let state = state.clone();
        handle.spawn(async move { sweep(&state).await });
    }
}

/// Marks every held sub's row as waiting, from the persisted set.
pub(crate) fn restamp(state: &DaemonState) {
    for h in all() {
        state.registry.set_waiting_for(&h.sub_id, Some(h.reason));
    }
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::finish::FinishRecord;

    /// Stores a finish record for `sub_id` in the (temp) data dir, the way a
    /// committed finish does.
    pub fn finish_record(sub_id: &str, verdict: &str, tone: Option<&str>) {
        let dir = crate::settings::paths::data_dir().unwrap().join("subchats");
        std::fs::create_dir_all(&dir).unwrap();
        let record = FinishRecord {
            sub_id: sub_id.into(),
            round: 1,
            verdict: verdict.into(),
            tone: tone.map(str::to_string),
            ..FinishRecord::default()
        };
        std::fs::write(dir.join(format!("{sub_id}.finish.json")), serde_json::to_string(&record).unwrap()).unwrap();
    }
}

#[cfg(test)]
mod tests;
