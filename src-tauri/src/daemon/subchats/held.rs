//! Subs the daemon holds without a child: a sub registered with `after` waits
//! here until the sub it named finishes, then the daemon starts it without waking
//! the main agent (spec section 2).
//!
//! A held sub is a real registry row, so it shows in the list, counts toward the
//! cap of five and survives a restart with the rest of the snapshot. What the
//! snapshot cannot carry is the launch recipe (the first message, the tier, the
//! account) and the thing it waits for, so those live in `<data_dir>/subchats/held.json`.
//!
//! **Ends blocked**, the rule that decides between starting a waiting sub and
//! asking Joe, is defined once in [`after_state`]:
//! - the earlier sub was ended (`end_sub`, the stalled-sub card's "End it", a
//!   closed row, or a row that no longer exists), or
//! - it finished with a verdict that says blocked (the word "blocked" in the
//!   verdict, as the nudge and the brief's stop clause teach a sub to write) or
//!   with tone `bad`.
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

/// Card kind for a held sub that needs Joe: its target ended blocked, or it
/// could not start.
pub const CARD_KIND: &str = "subchat_held";
pub const START_ANYWAY: &str = "Start it anyway";
pub const TRY_AGAIN: &str = "Try again";
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
    /// The sub it waits for. `None` for a hold some other rule owns (the writer
    /// queue): [`release_ready`] leaves those to their owner and
    /// [`launch_held`] starts one on request.
    #[serde(default)]
    pub after: Option<String>,
    #[serde(default)]
    pub after_name: String,
    #[serde(default)]
    pub launch: LaunchSpec,
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
/// unreadable is kept aside as `held.json.bad` before the next write replaces the
/// file (see [`super::jsonfile`]).
fn read_unlocked() -> Vec<Held> {
    let Some(path) = file_path() else { return Vec::new() };
    let Ok(raw) = std::fs::read_to_string(&path) else { return Vec::new() };
    let entries: Vec<serde_json::Value> = match serde_json::from_str(raw.trim_start_matches('\u{feff}')) {
        Ok(v) => v,
        Err(e) => {
            super::jsonfile::keep_bad_copy(&path, &raw, &e.to_string());
            return Vec::new();
        }
    };
    let mut held = Vec::with_capacity(entries.len());
    let mut unreadable = 0;
    for entry in entries {
        match serde_json::from_value::<Held>(entry) {
            Ok(h) => held.push(h),
            Err(_) => unreadable += 1,
        }
    }
    if unreadable > 0 {
        super::jsonfile::keep_bad_copy(&path, &raw, &format!("{unreadable} of its entries did not decode"));
    }
    held
}

fn write_unlocked(all: &[Held]) -> std::io::Result<()> {
    let path = file_path().ok_or_else(|| std::io::Error::other("no data dir"))?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let body = serde_json::to_string(all).map_err(std::io::Error::other)?;
    crate::util::write_json_atomic(&path, &body)
}

/// Every held sub, oldest first.
pub fn all() -> Vec<Held> {
    let _g = FILE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    read_unlocked()
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
        let mut held = read_unlocked();
        held.retain(|h| h.sub_id != entry.sub_id);
        held.push(entry.clone());
        write_unlocked(&held)?;
    }
    state.registry.set_waiting_for(&entry.sub_id, Some(entry.reason));
    Ok(())
}

/// Takes `sub_id` out of the held set and clears its waiting mark. The entry is
/// returned so a failed launch can put it back.
pub fn release(state: &DaemonState, sub_id: &str) -> Option<Held> {
    let taken = {
        let _g = FILE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut held = read_unlocked();
        let at = held.iter().position(|h| h.sub_id == sub_id)?;
        let entry = held.remove(at);
        if let Err(e) = write_unlocked(&held) {
            log::warn!("subchats: could not store the held set after releasing {sub_id}: {e}");
        }
        entry
    };
    state.registry.set_waiting_for(sub_id, None);
    Some(taken)
}

fn claim_launch(sub_id: &str) -> Option<LaunchGuard> {
    let mut g = LAUNCHING.lock().unwrap_or_else(|e| e.into_inner());
    g.get_or_insert_with(HashSet::new).insert(sub_id.to_string()).then(|| LaunchGuard(sub_id.to_string()))
}

struct LaunchGuard(String);

impl Drop for LaunchGuard {
    fn drop(&mut self) {
        if let Some(set) = LAUNCHING.lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
            set.remove(&self.0);
        }
    }
}

fn parked(sub_id: &str) -> bool {
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

pub fn after_state(state: &DaemonState, target_id: &str) -> AfterState {
    let Some(target) = state.registry.get(target_id) else {
        return AfterState::Blocked("it no longer exists".to_string());
    };
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

fn subs_of(state: &DaemonState, parent: &str) -> Vec<Instance> {
    let mut subs: Vec<Instance> =
        state.registry.list().into_iter().filter(|i| i.subchat_of.as_deref() == Some(parent)).collect();
    subs.sort_by(|a, b| a.started_at.cmp(&b.started_at));
    subs
}

/// Resolves `spawn_chat`'s `after` among `parent`'s subs, finished or running, by
/// the same name rules the `subchat` tool uses. `Ok(None)` means start now (the
/// named sub already finished cleanly); `Ok(Some)` means hold. A name that
/// matches none or several is refused with the subs listed, and so is a sub that
/// already ended blocked: the main agent is awake right now to tell Joe, and a
/// card for a job that was never registered would have nothing to start.
pub fn plan_after(state: &DaemonState, parent: &str, query: &str) -> Result<Option<HoldPlan>, String> {
    let subs = subs_of(state, parent);
    let target = super::tool::resolve(&subs, query).map_err(|e| format!("after: {e}"))?;
    let name = super::tool::label(target);
    match after_state(state, &target.session_id) {
        AfterState::Clean => Ok(None),
        AfterState::Pending => Ok(Some(HoldPlan { target_id: target.session_id.clone(), target_name: name })),
        AfterState::Blocked(why) => Err(format!(
            "after: {name} ended blocked ({why}), so a job waiting for it would never start. Tell Joe, and spawn this job without after if he says to go on without it."
        )),
    }
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
    let reason = format!("waiting for {}", target.target_name);
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
            after: target.as_ref().map(|t| t.target_id.clone()),
            after_name: target.map(|t| t.target_name).unwrap_or_default(),
            launch: spec,
        },
    )
    .map_err(|e| format!("could not store the held sub: {e}"))?;
    crate::sessions::persistence::save_snapshot_default(&state.registry);
    crate::daemon::machines::publish_instances_changed(state);
    Ok(sid)
}

/// The launcher the production paths use.
async fn production_launch(state: Arc<DaemonState>, sub_id: String) -> Result<(), String> {
    launch_held(&state, &sub_id).await
}

/// Starts a held sub's child with the first message it was registered with, as
/// `spawn_chat` would have, and takes it out of the held set. A failure puts it
/// back and says why.
pub async fn launch_held(state: &Arc<DaemonState>, sub_id: &str) -> Result<(), String> {
    // Another caller is already starting it; its result is the result.
    let Some(_claim) = claim_launch(sub_id) else { return Ok(()) };
    let entry = all().into_iter().find(|h| h.sub_id == sub_id).ok_or_else(|| format!("{sub_id} is not held"))?;
    let inst = state.registry.get(sub_id).ok_or_else(|| format!("unknown session: {sub_id}"))?;
    if inst.ended_at.is_some() {
        release(state, sub_id);
        return Err("it has been ended".to_string());
    }
    let parent = inst.subchat_of.clone().ok_or_else(|| "it is no longer a sub".to_string())?;
    // A worktree sub's tree is set up and caught up to its target first; a failure
    // has drawn its own blocker card and stops the launch.
    super::worktree::before_launch(state, sub_id).await?;
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
    release(state, sub_id);
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
    log::info!("subchats: started held sub {sub_id} (it waited for {})", entry.after_name);
    Ok(())
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
fn orphaned(state: &DaemonState, sub_id: &str) -> bool {
    let Some(inst) = state.registry.get(sub_id) else { return true };
    let Some(parent) = inst.subchat_of.as_deref() else { return true };
    match state.registry.get(parent) {
        Some(p) if p.ended_at.is_none() => false,
        _ => !state.registry.list().iter().any(|i| i.successor_of.as_deref() == Some(parent)),
    }
}

pub(crate) enum Why {
    TargetBlocked { target: String, why: String },
    LaunchFailed(String),
}

/// Boxed because the card's answer can raise another card (a "Try again" that
/// fails), which makes this future contain itself; the compiler cannot prove such
/// a future is `Send` unless the cycle goes through a trait object.
pub(crate) fn raise_decision(state: &Arc<DaemonState>, held: &Held, why: Why) -> std::pin::Pin<Box<dyn Future<Output = ()> + Send>> {
    let (state, held) = (state.clone(), held.clone());
    Box::pin(async move { raise_decision_now(&state, &held, why).await })
}

async fn raise_decision_now(state: &Arc<DaemonState>, held: &Held, why: Why) {
    let sub_id = held.sub_id.as_str();
    if cards::open_card_for(state, CARD_KIND, sub_id).await.is_some() {
        return;
    }
    let Some(parent) = state.registry.get(sub_id).and_then(|i| i.subchat_of) else { return };
    let name = state.registry.get(sub_id).and_then(|i| i.name).filter(|n| !n.trim().is_empty()).unwrap_or_else(|| "A sub".to_string());
    let (question, options) = match &why {
        Why::TargetBlocked { target, why } => (
            format!("**{target}** ended blocked ({why}), and **{name}** was waiting for it.\n\nStart {name} anyway, or drop it?"),
            vec![
                CardOption::new(START_ANYWAY, "Run it now, without the earlier job"),
                CardOption::new(DROP_IT, "Do not run it"),
            ],
        ),
        Why::LaunchFailed(err) => (
            format!("**{name}** could not start: {err}\n\nTry again, or drop it?"),
            vec![
                CardOption::new(TRY_AGAIN, "Start it again now"),
                CardOption::new(DROP_IT, "Do not run it"),
            ],
        ),
    };
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
/// "Start it anyway": its next card is Joe's to answer, not the tick's to retry.
pub(crate) async fn apply_answer<F, Fut>(state: &Arc<DaemonState>, sub_id: &str, answer: CardAnswer, launch: &F)
where
    F: Fn(Arc<DaemonState>, String) -> Fut,
    Fut: Future<Output = Result<(), String>>,
{
    match answer {
        CardAnswer::Picked(choice) if choice == START_ANYWAY || choice == TRY_AGAIN => {
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
        let Some(target) = entry.after.as_deref() else { continue };
        if parked(&entry.sub_id) {
            continue;
        }
        match after_state(state, target) {
            AfterState::Pending => {}
            AfterState::Clean => {
                if let Err(e) = launch(state.clone(), entry.sub_id.clone()).await {
                    log::warn!("subchats: held sub {} could not start: {e}", entry.sub_id);
                    raise_decision(state, &entry, Why::LaunchFailed(e)).await;
                    set_parked(&entry.sub_id, true);
                }
            }
            AfterState::Blocked(why) => {
                raise_decision(state, &entry, Why::TargetBlocked { target: entry.after_name.clone(), why }).await;
            }
        }
    }
}

/// Subs whose lost hold was rebuilt this run. Once each: a sub that loses its hold
/// a second time is left to [`super::queue_watch`], which tells the main chat,
/// instead of being rebuilt and started every minute.
static RECOVERED: Mutex<Option<HashSet<String>>> = Mutex::new(None);

fn launching(sub_id: &str) -> bool {
    LAUNCHING.lock().unwrap_or_else(|e| e.into_inner()).as_ref().is_some_and(|s| s.contains(sub_id))
}

/// A sub that was registered and never started, with no hold left to start it:
/// a live sub row with no child, no transcript and no held entry. Its hold was
/// lost (another daemon instance on the same data folder forgot it before
/// `held.json` was per instance), and without this nothing would ever start it:
/// it reads as queued for good, and `--resume` on it fails because it never had a
/// conversation.
pub(crate) fn is_lost_hold(state: &DaemonState, inst: &Instance, held: &[Held], has_transcript: &(dyn Fn(&str) -> bool + Sync)) -> bool {
    let id = inst.session_id.as_str();
    inst.subchat_of.is_some()
        && inst.ended_at.is_none()
        && inst.end_reason.is_none()
        && !inst.subchat_finished
        && !inst.busy
        && !state.sessions.contains_key(id)
        && !launching(id)
        && !held.iter().any(|h| h.sub_id == id)
        && !has_transcript(id)
}

/// How old a lost hold may be and still be rebuilt by the tick on its own. An
/// older one was most likely worked around by then (2026-11-10: the main chat
/// re-ran four lost lanes as plain chats), and starting it blind would run the job
/// twice. It is left to [`super::queue_watch`], which tells the main chat, and the
/// main chat drops it (`subchat drop`) or Joe nudges it from its card.
pub const RECOVER_WITHIN: chrono::Duration = chrono::Duration::hours(2);

/// Whether `inst` was registered recently enough for the tick to rebuild its lost
/// hold. An unreadable start time is not.
pub(crate) fn recent_enough(inst: &Instance, now: chrono::DateTime<chrono::Utc>) -> bool {
    chrono::DateTime::parse_from_rfc3339(&inst.started_at)
        .is_ok_and(|t| now.signed_duration_since(t.with_timezone(&chrono::Utc)) <= RECOVER_WITHIN)
}

/// Whether `inst` is a sub that never started: held, or a lost hold.
pub(crate) fn never_started(state: &DaemonState, inst: &Instance, has_transcript: &(dyn Fn(&str) -> bool + Sync)) -> bool {
    let held = all();
    held.iter().any(|h| h.sub_id == inst.session_id) || is_lost_hold(state, inst, &held, has_transcript)
}

/// Rebuilds the hold of every lost one ([`is_lost_hold`]) that `admit` lets in from what survives: its
/// brief (stored in chat-config, which also holds `after` by name) and its row
/// (folder, model, effort, account). The first message is composed from the brief
/// again; an extra `prompt` the main chat passed at spawn is not kept anywhere and
/// is not in it. A worktree sub is left out: its tree has its own start path.
/// Returns the subs rebuilt and whether any of them waits for the writer slot
/// rather than for a named sub.
pub(crate) fn recover_lost_with(
    state: &DaemonState,
    has_transcript: &(dyn Fn(&str) -> bool + Sync),
    admit: &(dyn Fn(&Instance) -> bool + Sync),
) -> (Vec<String>, bool) {
    let held = all();
    let mut rebuilt = Vec::new();
    let mut for_slot = false;
    for inst in state.registry.list() {
        if !is_lost_hold(state, &inst, &held, has_transcript) || !admit(&inst) || orphaned(state, &inst.session_id) {
            continue;
        }
        let id = inst.session_id.clone();
        let Some(brief) = crate::sessions::chat_config::get(&id).and_then(|c| c.subchat) else { continue };
        if brief.worktree_at.is_some() {
            continue;
        }
        if RECOVERED.lock().unwrap_or_else(|e| e.into_inner()).as_ref().is_some_and(|s| s.contains(&id)) {
            continue;
        }
        let Some(parent) = inst.subchat_of.as_deref() else { continue };
        let (after, after_name) = match brief.after.as_deref().map(str::trim).filter(|q| !q.is_empty()) {
            Some(query) => {
                let subs: Vec<Instance> = subs_of(state, parent).into_iter().filter(|s| s.session_id != id).collect();
                match super::tool::resolve(&subs, query) {
                    Ok(target) => (Some(target.session_id.clone()), super::tool::label(target)),
                    // The sub it waited for cannot be named again: the watchdog
                    // tells the main chat rather than starting it out of order.
                    Err(e) => {
                        log::warn!("subchats: lost hold of {id} not rebuilt, its after {query:?} does not resolve: {e}");
                        continue;
                    }
                }
            }
            None => (None, String::new()),
        };
        let reason = if after.is_some() { format!("waiting for {after_name}") } else { super::writers::QUEUED_TEXT.to_string() };
        for_slot |= after.is_none();
        let entry = Held {
            sub_id: id.clone(),
            reason,
            after,
            after_name,
            launch: LaunchSpec {
                cwd: inst.cwd.clone(),
                model: inst.model.clone(),
                effort: inst.effort.clone(),
                account_id: inst.account_id.clone(),
                first_message: super::brief::compose_first_message(&brief, None),
            },
        };
        if let Err(e) = hold(state, entry) {
            log::warn!("subchats: could not rebuild the lost hold of {id}: {e}");
            continue;
        }
        RECOVERED.lock().unwrap_or_else(|e| e.into_inner()).get_or_insert_with(HashSet::new).insert(id.clone());
        log::warn!("subchats: rebuilt the lost hold of sub {id} from its brief");
        rebuilt.push(id);
    }
    (rebuilt, for_slot)
}

/// [`recover_lost_with`] against the real transcripts, then the writer queue picks
/// up any rebuilt sub that waits for the slot.
pub(crate) fn recover_lost(state: &Arc<DaemonState>) -> Vec<String> {
    let now = chrono::Utc::now();
    let (rebuilt, for_slot) = recover_lost_with(
        state,
        &|id| crate::context_status::resolve_transcript(&state.registry, id).is_some(),
        &|inst| recent_enough(inst, now),
    );
    if !rebuilt.is_empty() {
        crate::daemon::machines::publish_instances_changed(state);
    }
    if for_slot {
        super::writers::requeue_held(state);
    }
    rebuilt
}

/// Joe's "nudge" on a sub that never started. It has no conversation, so
/// `--resume` would fail with "No conversation found" and raise the same card
/// again. Instead its hold is rebuilt (even if it was rebuilt once already: Joe
/// asked) and the held pass starts it if what it waits for is done. Returns false
/// for a sub that did start, which a real nudge is for.
pub(crate) async fn start_never_started_with<F, Fut>(
    state: &Arc<DaemonState>,
    sub_id: &str,
    has_transcript: &(dyn Fn(&str) -> bool + Sync),
    launch: F,
) -> bool
where
    F: Fn(Arc<DaemonState>, String) -> Fut,
    Fut: Future<Output = Result<(), String>>,
{
    let Some(inst) = state.registry.get(sub_id) else { return false };
    let held_now = all();
    let was_held = held_now.iter().any(|h| h.sub_id == sub_id);
    if !was_held && !is_lost_hold(state, &inst, &held_now, has_transcript) {
        return false;
    }
    if !was_held {
        if let Some(set) = RECOVERED.lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
            set.remove(sub_id);
        }
        let (_, for_slot) = recover_lost_with(state, has_transcript, &|inst| inst.session_id == sub_id);
        if for_slot {
            super::writers::requeue_held(state);
        }
    }
    set_parked(sub_id, false);
    release_ready(state, launch).await;
    true
}

/// [`start_never_started_with`] against the real transcripts and launcher.
pub async fn start_never_started(state: &Arc<DaemonState>, sub_id: &str) -> bool {
    let has = |id: &str| crate::context_status::resolve_transcript(&state.registry, id).is_some();
    start_never_started_with(state, sub_id, &has, production_launch).await
}

/// The production pass: rebuilds lost holds, then starts real children.
pub async fn sweep(state: &Arc<DaemonState>) {
    recover_lost(state);
    release_ready(state, production_launch).await;
}

/// The hook for "a sub finished or ended": runs a pass on its own task, because
/// both callers are synchronous and one sits inside the pump's result handler,
/// where an inline respawn would make the pump future self-referential (see
/// [`super::on_finished`]). With no runtime there is nothing to start a child on.
pub fn on_target_done(state: &Arc<DaemonState>) {
    if all().is_empty() {
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
mod tests {
    use super::*;
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::daemon::subchats::{store_sub_brief, SubchatArgs, TempDataDir};
    use crate::types::Settings;

    fn state() -> Arc<DaemonState> {
        DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()))
    }

    fn here() -> PathBuf {
        std::env::current_dir().unwrap()
    }

    fn row(st: &DaemonState, id: &str) {
        if st.registry.get(id).is_none() {
            st.registry.upsert_interactive(id, &here(), "proj", "2026-11-05T00:00:00Z");
        }
    }

    /// A sub of `parent` named `name`, with a stored brief so it reads as a sub everywhere.
    fn sub_of(st: &DaemonState, parent: &str, id: &str, name: &str) {
        row(st, parent);
        row(st, id);
        st.registry.set_subchat_of(id, Some(parent.into()));
        st.registry.set_name(id, name.into());
        store_sub_brief(id, parent);
    }

    fn spec(first: &str) -> LaunchSpec {
        LaunchSpec {
            cwd: here(),
            model: "sonnet".into(),
            effort: "high".into(),
            account_id: Some("acct".into()),
            first_message: first.into(),
        }
    }

    /// `sub` (named `name`) held behind `target` (named `target_name`).
    fn hold_behind(st: &DaemonState, parent: &str, sub: &str, name: &str, target: &str, target_name: &str) {
        sub_of(st, parent, sub, name);
        hold(
            st,
            Held {
                sub_id: sub.into(),
                reason: format!("waiting for {target_name}"),
                after: Some(target.into()),
                after_name: target_name.into(),
                launch: spec("do the footer"),
            },
        )
        .unwrap();
    }

    type Calls = Arc<Mutex<Vec<String>>>;

    /// A launcher that records the sub it was asked to start and releases it, as a
    /// real start would, without spawning a `claude`.
    fn launcher(calls: &Calls) -> impl Fn(Arc<DaemonState>, String) -> std::future::Ready<Result<(), String>> {
        let calls = calls.clone();
        move |st, id| {
            calls.lock().unwrap().push(id.clone());
            release(&st, &id);
            std::future::ready(Ok(()))
        }
    }

    fn failing_launcher(calls: &Calls) -> impl Fn(Arc<DaemonState>, String) -> std::future::Ready<Result<(), String>> {
        let calls = calls.clone();
        move |_st, id| {
            calls.lock().unwrap().push(id);
            std::future::ready(Err("no account is set up".to_string()))
        }
    }

    fn calls() -> Calls {
        Arc::new(Mutex::new(Vec::new()))
    }

    async fn cards_of_kind(st: &Arc<DaemonState>) -> Vec<serde_json::Value> {
        st.list_prompts().await.into_iter().filter(|p| p["payload"]["card_kind"] == CARD_KIND).collect()
    }

    fn option_labels(card: &serde_json::Value) -> Vec<String> {
        card["payload"]["questions"][0]["options"]
            .as_array()
            .unwrap()
            .iter()
            .map(|o| o["label"].as_str().unwrap().to_string())
            .collect()
    }

    // ── what counts as blocked ─────────────────────────────────────────────

    #[test]
    fn a_blocked_verdict_or_a_bad_tone_is_blocked_and_an_ordinary_finish_is_not() {
        let rec = |verdict: &str, tone: Option<&str>| FinishRecord {
            verdict: verdict.into(),
            tone: tone.map(str::to_string),
            ..FinishRecord::default()
        };
        assert!(is_blocked_finish(&rec("Blocked", None)));
        assert!(is_blocked_finish(&rec("Blocked on auth", None)));
        assert!(is_blocked_finish(&rec("Stuck, blocked.", None)));
        assert!(is_blocked_finish(&rec("Tests still failing", Some("bad"))), "a bad tone is a bad outcome");
        assert!(!is_blocked_finish(&rec("Built, not pushed", None)));
        assert!(!is_blocked_finish(&rec("Unblocked the build", Some("good"))), "a different word");
        assert!(!is_blocked_finish(&rec("", None)));
    }

    #[test]
    fn the_target_is_pending_while_it_runs_clean_when_finished_and_blocked_when_ended_or_gone() {
        let _d = TempDataDir::new();
        let st = state();
        sub_of(&st, "as-main", "as-run", "running");
        assert_eq!(after_state(&st, "as-run"), AfterState::Pending);

        sub_of(&st, "as-main", "as-ok", "ok");
        st.registry.set_subchat_finished("as-ok", true);
        assert_eq!(after_state(&st, "as-ok"), AfterState::Clean, "no readable record: unknown never blocks");
        test_support::finish_record("as-ok", "Built, not pushed", Some("good"));
        assert_eq!(after_state(&st, "as-ok"), AfterState::Clean);

        sub_of(&st, "as-main", "as-blk", "blk");
        st.registry.set_subchat_finished("as-blk", true);
        test_support::finish_record("as-blk", "Blocked on the schema", None);
        assert!(matches!(after_state(&st, "as-blk"), AfterState::Blocked(w) if w.contains("Blocked on the schema")));

        sub_of(&st, "as-main", "as-end", "end");
        st.registry.mark_ended("as-end", crate::types::EndReason::Manual, "2026-11-05T00:00:00Z");
        assert!(matches!(after_state(&st, "as-end"), AfterState::Blocked(_)));
        assert!(matches!(after_state(&st, "as-gone"), AfterState::Blocked(_)));
    }

    // ── resolving `after` ──────────────────────────────────────────────────

    #[test]
    fn after_resolves_among_the_parents_subs_finished_or_running_and_refuses_none_or_several() {
        let _d = TempDataDir::new();
        let st = state();
        sub_of(&st, "pa-main", "pa-fix-a", "fix-a");
        sub_of(&st, "pa-main", "pa-fix-b", "fix-b");
        sub_of(&st, "pa-main", "pa-docs", "docs");
        sub_of(&st, "pa-other", "pa-foreign", "foreign");

        let hold_plan = plan_after(&st, "pa-main", "docs").unwrap().expect("a running target holds");
        assert_eq!((hold_plan.target_id.as_str(), hold_plan.target_name.as_str()), ("pa-docs", "docs"));

        let err = plan_after(&st, "pa-main", "fix").unwrap_err();
        assert!(err.starts_with("after: ") && err.contains("more than one sub") && err.contains("fix-a") && err.contains("fix-b"), "{err}");

        let err = plan_after(&st, "pa-main", "nothing-like-it").unwrap_err();
        assert!(err.contains("No sub named") && err.contains("docs") && err.contains("fix-a"), "{err}");

        let err = plan_after(&st, "pa-main", "foreign").unwrap_err();
        assert!(err.contains("No sub named"), "another main chat's sub is not an option: {err}");
    }

    #[test]
    fn an_already_finished_target_means_start_now_and_an_already_blocked_one_is_refused() {
        let _d = TempDataDir::new();
        let st = state();
        sub_of(&st, "pb-main", "pb-done", "done");
        st.registry.set_subchat_finished("pb-done", true);
        test_support::finish_record("pb-done", "Built, not pushed", None);
        assert_eq!(plan_after(&st, "pb-main", "done").unwrap(), None, "nothing to wait for");

        sub_of(&st, "pb-main", "pb-bad", "bad");
        st.registry.set_subchat_finished("pb-bad", true);
        test_support::finish_record("pb-bad", "Blocked", None);
        let err = plan_after(&st, "pb-main", "bad").unwrap_err();
        assert!(err.contains("ended blocked") && err.contains("without after"), "{err}");
    }

    // ── holding ────────────────────────────────────────────────────────────

    #[test]
    fn a_hold_persists_marks_the_row_waiting_and_a_second_hold_replaces_the_first() {
        let _d = TempDataDir::new();
        let st = state();
        hold_behind(&st, "h1-main", "h1-sub", "footer", "h1-target", "header");
        assert!(is_held("h1-sub") && !is_held("h1-other"));
        assert_eq!(st.registry.get("h1-sub").unwrap().progress.waiting_for.as_deref(), Some("waiting for header"));
        let mut again = all().into_iter().find(|h| h.sub_id == "h1-sub").unwrap();
        again.reason = "waiting for the writer slot".into();
        hold(&st, again).unwrap();
        assert_eq!(all().iter().filter(|h| h.sub_id == "h1-sub").count(), 1);
        assert_eq!(st.registry.get("h1-sub").unwrap().progress.waiting_for.as_deref(), Some("waiting for the writer slot"));
        let taken = release(&st, "h1-sub").expect("it was held");
        assert_eq!(taken.launch.first_message, "do the footer");
        assert!(!is_held("h1-sub") && st.registry.get("h1-sub").unwrap().progress.waiting_for.is_none());
        assert!(release(&st, "h1-sub").is_none());
    }

    #[test]
    fn registering_makes_a_counted_waiting_row_with_its_brief_and_a_released_slot() {
        let _d = TempDataDir::new();
        let st = state();
        sub_of(&st, "rg-main", "rg-header", "header");
        let cfg = crate::sessions::chat_config::ChatConfig { subchats_on: true, ..Default::default() };
        let args = SubchatArgs {
            task: Some("Footer".into()),
            goal: Some("g".into()),
            done_when: Some("d".into()),
            writes: Some(false),
            after: Some("header".into()),
            ..Default::default()
        };
        let mut plan = super::super::spawn::plan(&st, "rg-main", &cfg, &here().to_string_lossy(), None, None, None, Some("footer"), &args, &[])
            .unwrap()
            .unwrap();
        assert_eq!(plan.hold.as_ref().map(|h| h.target_id.as_str()), Some("rg-header"));
        let sid = register_row(&st, "rg-main", Some("footer"), &cfg, spec(&plan.first_message), &mut plan).unwrap();

        let inst = st.registry.get(&sid).unwrap();
        assert_eq!(inst.subchat_of.as_deref(), Some("rg-main"));
        assert!(!inst.busy && inst.ended_at.is_none() && !inst.subchat_finished);
        assert_eq!(inst.progress.waiting_for.as_deref(), Some("waiting for header"));
        let brief = crate::sessions::chat_config::get(&sid).unwrap().subchat.expect("brief stored");
        assert_eq!((brief.task.as_str(), brief.after.as_deref()), ("Footer", Some("header")));
        let entry = all().into_iter().find(|h| h.sub_id == sid).unwrap();
        assert_eq!(entry.after.as_deref(), Some("rg-header"));
        assert!(entry.launch.first_message.contains("Footer"), "{}", entry.launch.first_message);
        // The row counts as running (header + footer), so the held sub is in the cap.
        assert_eq!(super::super::spawn::running_subs(&st.registry, "rg-main").len(), 2);
        assert_eq!(super::super::tool::status_word(&inst), "queued");
    }

    #[test]
    fn a_held_sub_counts_toward_the_cap_of_five() {
        let _d = TempDataDir::new();
        let st = state();
        for n in 0..4 {
            sub_of(&st, "cp-main", &format!("cp-run{n}"), &format!("job-{n}"));
        }
        hold_behind(&st, "cp-main", "cp-held", "queued-job", "cp-run0", "job-0");
        let cfg = crate::sessions::chat_config::ChatConfig { subchats_on: true, ..Default::default() };
        let args = SubchatArgs {
            task: Some("t".into()),
            goal: Some("g".into()),
            done_when: Some("d".into()),
            writes: Some(false),
            ..Default::default()
        };
        let err = super::super::spawn::plan(&st, "cp-main", &cfg, &here().to_string_lossy(), None, None, None, Some("sixth"), &args, &[])
            .err()
            .expect("four running plus one held is five");
        assert!(err.contains("queued-job"), "the held sub is named among the running: {err}");
    }

    #[test]
    fn continuing_a_held_sub_is_refused_before_anything_is_cleared() {
        let _d = TempDataDir::new();
        let st = state();
        hold_behind(&st, "ms-main", "ms-held", "footer", "ms-target", "header");
        let err = super::super::resume::prepare_continue(&st, "ms-held").unwrap_err();
        assert!(matches!(err, super::super::ContinueError::Held(_)), "{err:?}");
        assert!(err.to_string().contains("has not started yet"), "{err}");
        assert!(st.registry.get("ms-held").unwrap().subchat_of.is_some());
    }

    #[tokio::test]
    async fn moving_a_held_sub_to_the_sidebar_and_typing_to_it_are_refused() {
        let _d = TempDataDir::new();
        let st = state();
        hold_behind(&st, "mv-main", "mv-held", "footer", "mv-target", "header");
        let moved = super::super::move_to_sidebar(&st, "mv-held").await.unwrap_err();
        assert!(matches!(moved, super::super::MoveError::Held(_)), "{moved:?}");
        assert!(st.registry.get("mv-held").unwrap().subchat_of.is_some(), "still a sub");
        let typed = super::super::route_send(&st, "mv-held", "also blue").await.expect("routed, not ordinary");
        assert!(matches!(typed, Err(super::super::ContinueError::Held(_))), "{typed:?}");
    }

    // ── starting and the restart ───────────────────────────────────────────

    #[tokio::test]
    async fn the_target_finishing_starts_the_held_sub_and_only_it_without_touching_the_main_chat() {
        let _d = TempDataDir::new();
        let st = state();
        sub_of(&st, "go-main", "go-target", "header");
        hold_behind(&st, "go-main", "go-held", "footer", "go-target", "header");
        let seen = calls();
        release_ready(&st, launcher(&seen)).await;
        assert!(seen.lock().unwrap().is_empty(), "the target still runs");

        st.registry.set_subchat_finished("go-target", true);
        release_ready(&st, launcher(&seen)).await;
        assert_eq!(*seen.lock().unwrap(), ["go-held"]);
        assert!(!is_held("go-held"), "started, so no longer held");
        let main = st.registry.get("go-main").unwrap();
        assert!(!main.busy && main.awaiting.is_none(), "the main agent is not woken");
        assert!(st.list_prompts().await.is_empty(), "and Joe is not asked anything");
    }

    #[tokio::test]
    async fn a_chain_starts_one_link_at_a_time() {
        let _d = TempDataDir::new();
        let st = state();
        sub_of(&st, "ch-main", "ch-c", "c");
        hold_behind(&st, "ch-main", "ch-b", "b", "ch-c", "c");
        hold_behind(&st, "ch-main", "ch-a", "a", "ch-b", "b");
        let seen = calls();
        release_ready(&st, launcher(&seen)).await;
        assert!(seen.lock().unwrap().is_empty());

        st.registry.set_subchat_finished("ch-c", true);
        release_ready(&st, launcher(&seen)).await;
        assert_eq!(*seen.lock().unwrap(), ["ch-b"], "a waits on b, which has only just started");

        st.registry.set_subchat_finished("ch-b", true);
        release_ready(&st, launcher(&seen)).await;
        assert_eq!(*seen.lock().unwrap(), ["ch-b", "ch-a"]);
    }

    #[tokio::test]
    async fn the_hold_survives_a_restart_and_a_finish_while_the_daemon_was_down_releases_it_at_boot() {
        let _d = TempDataDir::new();
        let before = state();
        sub_of(&before, "rs-main", "rs-target", "header");
        hold_behind(&before, "rs-main", "rs-held", "footer", "rs-target", "header");
        // The target finishes and the daemon dies before anyone looks.
        before.registry.set_subchat_finished("rs-target", true);
        test_support::finish_record("rs-target", "Built, not pushed", None);
        crate::sessions::persistence::save_snapshot_default(&before.registry);

        // A new process: a fresh registry restored from the snapshot, same data dir.
        let after = state();
        let path = crate::settings::paths::interactive_sessions_file().unwrap();
        crate::sessions::persistence::populate_registry(&after.registry, crate::sessions::persistence::load_snapshot(&path));
        assert!(after.registry.get("rs-held").is_some(), "the row came back");
        assert!(after.registry.get("rs-held").unwrap().progress.waiting_for.is_none(), "the mark is in memory only");
        restamp(&after);
        assert_eq!(after.registry.get("rs-held").unwrap().progress.waiting_for.as_deref(), Some("waiting for header"));
        assert!(is_held("rs-held"), "the recipe was on disk");

        let seen = calls();
        release_ready(&after, launcher(&seen)).await;
        assert_eq!(*seen.lock().unwrap(), ["rs-held"], "the finish that happened while down releases it");
    }

    #[tokio::test]
    async fn a_failed_start_keeps_the_sub_held_asks_joe_once_and_is_not_retried_every_tick() {
        let _d = TempDataDir::new();
        let st = state();
        sub_of(&st, "fl-main", "fl-target", "header");
        st.registry.set_subchat_finished("fl-target", true);
        hold_behind(&st, "fl-main", "fl-held", "footer", "fl-target", "header");
        let seen = calls();
        release_ready(&st, failing_launcher(&seen)).await;
        release_ready(&st, failing_launcher(&seen)).await;
        assert_eq!(seen.lock().unwrap().len(), 1, "a failure is Joe's to answer, not the tick's to retry");
        assert!(is_held("fl-held"), "nothing is lost");
        let cards = cards_of_kind(&st).await;
        assert_eq!(cards.len(), 1);
        assert_eq!(option_labels(&cards[0]), [TRY_AGAIN, DROP_IT]);
        assert!(cards[0]["payload"]["questions"][0]["question"].as_str().unwrap().contains("no account is set up"));
    }

    #[tokio::test]
    async fn launching_reaches_the_spawn_and_a_failure_there_loses_nothing() {
        let _d = TempDataDir::new();
        let st = state();
        sub_of(&st, "ln-main", "ln-held", "footer");
        let mut missing = spec("go");
        missing.cwd = std::env::temp_dir().join(format!("cc-held-missing-{}", uuid::Uuid::new_v4()));
        hold(
            &st,
            Held { sub_id: "ln-held".into(), reason: "waiting for header".into(), after: None, after_name: String::new(), launch: missing },
        )
        .unwrap();
        let err = launch_held(&st, "ln-held").await.unwrap_err();
        assert!(err.contains("cwd does not exist"), "it got as far as the spawn: {err}");
        assert!(is_held("ln-held"), "still queued for the next try");
        assert_eq!(st.registry.get("ln-held").unwrap().progress.waiting_for.as_deref(), Some("waiting for header"));
        assert!(launch_held(&st, "nobody").await.unwrap_err().contains("not held"));
    }

    // ── target ends blocked ────────────────────────────────────────────────

    #[tokio::test]
    async fn a_blocked_target_raises_one_card_and_start_anyway_runs_the_sub() {
        let _d = TempDataDir::new();
        let st = state();
        sub_of(&st, "bk-main", "bk-target", "header");
        st.registry.set_subchat_finished("bk-target", true);
        test_support::finish_record("bk-target", "Blocked on the schema", None);
        hold_behind(&st, "bk-main", "bk-held", "footer", "bk-target", "header");

        let seen = calls();
        release_ready(&st, launcher(&seen)).await;
        release_ready(&st, launcher(&seen)).await;
        assert!(seen.lock().unwrap().is_empty(), "never started behind Joe's back");
        let cards = cards_of_kind(&st).await;
        assert_eq!(cards.len(), 1, "one card per wait, not one per tick");
        assert_eq!(cards[0]["payload"]["display_session_id"], "bk-main");
        assert_eq!(cards[0]["payload"]["sub_id"], "bk-held");
        assert_eq!(option_labels(&cards[0]), [START_ANYWAY, DROP_IT]);
        let text = cards[0]["payload"]["questions"][0]["question"].as_str().unwrap();
        assert!(text.contains("header") && text.contains("footer") && text.contains("Blocked on the schema"), "{text}");

        apply_answer(&st, "bk-held", CardAnswer::Picked(START_ANYWAY.into()), &launcher(&seen)).await;
        assert_eq!(*seen.lock().unwrap(), ["bk-held"]);
    }

    #[tokio::test]
    async fn drop_it_ends_the_waiting_sub_so_it_leaves_the_cap_and_the_list() {
        let _d = TempDataDir::new();
        let st = state();
        sub_of(&st, "dr-main", "dr-target", "header");
        st.registry.mark_ended("dr-target", crate::types::EndReason::Manual, "2026-11-05T00:00:00Z");
        hold_behind(&st, "dr-main", "dr-held", "footer", "dr-target", "header");
        let seen = calls();
        release_ready(&st, launcher(&seen)).await;
        assert_eq!(cards_of_kind(&st).await.len(), 1, "an ended target is blocked too");

        apply_answer(&st, "dr-held", CardAnswer::Picked(DROP_IT.into()), &launcher(&seen)).await;
        assert!(seen.lock().unwrap().is_empty());
        assert!(!is_held("dr-held"));
        let row = st.registry.get("dr-held").unwrap();
        assert!(row.ended_at.is_some() && row.progress.waiting_for.is_none());
        assert!(super::super::spawn::running_subs(&st.registry, "dr-main").is_empty(), "the slot is free again");
    }

    #[tokio::test]
    async fn skipping_the_card_parks_the_sub_instead_of_asking_every_minute() {
        let _d = TempDataDir::new();
        let st = state();
        sub_of(&st, "sk-main", "sk-target", "header");
        st.registry.mark_ended("sk-target", crate::types::EndReason::Manual, "2026-11-05T00:00:00Z");
        hold_behind(&st, "sk-main", "sk-held", "footer", "sk-target", "header");
        let seen = calls();
        release_ready(&st, launcher(&seen)).await;
        let card = cards_of_kind(&st).await.remove(0);
        apply_answer(&st, "sk-held", CardAnswer::Skipped, &launcher(&seen)).await;
        // The answered card is gone from the list, as it is in the app.
        crate::daemon::methods::permission::respond_question_inner(&st, card["id"].as_str().unwrap(), serde_json::json!({}), true).await;
        release_ready(&st, launcher(&seen)).await;
        assert!(cards_of_kind(&st).await.is_empty(), "a skip is left alone until the next restart");
        assert!(is_held("sk-held"));
    }

    // ── the main chat going away ───────────────────────────────────────────

    #[tokio::test]
    async fn a_held_sub_whose_main_chat_is_gone_is_dropped_not_promoted_but_a_respawn_keeps_it() {
        let _d = TempDataDir::new();
        let st = state();
        sub_of(&st, "gone-main", "gone-target", "header");
        hold_behind(&st, "gone-main", "gone-held", "footer", "gone-target", "header");
        // The main chat is respawned: it ends, and a row names it as its predecessor.
        row(&st, "gone-successor");
        st.registry.set_successor_of("gone-successor", "gone-main");
        st.registry.mark_ended("gone-main", crate::types::EndReason::Manual, "2026-11-05T00:00:00Z");
        let seen = calls();
        release_ready(&st, launcher(&seen)).await;
        assert!(is_held("gone-held"), "a respawn moves the subs, it does not end them");

        // A crash: no successor.
        sub_of(&st, "crash-main", "crash-target", "header");
        hold_behind(&st, "crash-main", "crash-held", "footer", "crash-target", "header");
        st.registry.mark_ended("crash-main", crate::types::EndReason::Manual, "2026-11-05T00:00:00Z");
        release_ready(&st, launcher(&seen)).await;
        assert!(!is_held("crash-held"));
        let row = st.registry.get("crash-held").unwrap();
        assert!(row.ended_at.is_some(), "ended, never run");
        assert_eq!(row.subchat_of.as_deref(), Some("crash-main"), "and not promoted to a sidebar chat");
        assert!(seen.lock().unwrap().is_empty());
    }

    #[test]
    fn ending_a_queued_sub_forgets_its_recipe_so_it_can_never_start_later() {
        let _d = TempDataDir::new();
        let st = state();
        hold_behind(&st, "en-main", "en-held", "footer", "en-target", "header");
        assert!(super::super::resume::end_sub(&st, "en-held"));
        assert!(!is_held("en-held"));
        assert!(st.registry.get("en-held").unwrap().progress.waiting_for.is_none());
    }

    #[tokio::test]
    async fn a_queued_row_that_ended_by_another_path_is_forgotten_not_started() {
        let _d = TempDataDir::new();
        let st = state();
        sub_of(&st, "ex-main", "ex-target", "header");
        st.registry.set_subchat_finished("ex-target", true);
        hold_behind(&st, "ex-main", "ex-held", "footer", "ex-target", "header");
        st.registry.mark_ended("ex-held", crate::types::EndReason::Manual, "2026-11-05T00:00:00Z");
        let seen = calls();
        release_ready(&st, launcher(&seen)).await;
        assert!(seen.lock().unwrap().is_empty(), "an ended sub is never launched");
        assert!(!is_held("ex-held"));
        assert!(cards_of_kind(&st).await.is_empty(), "and Joe is not asked about it");
    }

    // ── a damaged file ──────────────────────────────────────────────────────

    fn held_file() -> PathBuf {
        file_path().unwrap()
    }

    fn bad_copies() -> Vec<String> {
        let dir = held_file().parent().unwrap().to_path_buf();
        std::fs::read_dir(dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.starts_with(&format!("{}.bad", held_file().file_name().unwrap().to_string_lossy())))
            .collect()
    }

    /// One entry that will not decode used to make the whole file read as empty,
    /// and the next write then dropped every queued sub.
    #[test]
    fn one_unreadable_entry_does_not_empty_the_set_and_is_kept_aside() {
        let _d = TempDataDir::new();
        let st = state();
        hold_behind(&st, "bad-main", "bad-one", "footer", "bad-t", "header");
        let mut entries: Vec<serde_json::Value> = serde_json::from_str(&std::fs::read_to_string(held_file()).unwrap()).unwrap();
        entries.push(serde_json::json!({ "reason": "no sub id, so nobody to start" }));
        std::fs::write(held_file(), serde_json::to_string(&entries).unwrap()).unwrap();

        assert!(is_held("bad-one"), "the readable entry is still held");
        hold_behind(&st, "bad-main", "bad-two", "docs", "bad-t", "header");
        assert!(is_held("bad-one") && is_held("bad-two"), "a write does not drop the queue");
        let copies = bad_copies();
        assert_eq!(copies.len(), 1, "{copies:?}");
        let kept = std::fs::read_to_string(held_file().with_file_name(&copies[0])).unwrap();
        assert!(kept.contains("no sub id"), "the unreadable entry is kept: {kept}");
    }

    #[test]
    fn a_file_that_is_not_json_is_kept_aside_before_the_next_write_replaces_it() {
        let _d = TempDataDir::new();
        let st = state();
        std::fs::create_dir_all(held_file().parent().unwrap()).unwrap();
        std::fs::write(held_file(), "{ half a file").unwrap();
        assert!(all().is_empty());
        hold_behind(&st, "junk-main", "junk-one", "footer", "junk-t", "header");
        let copies = bad_copies();
        assert_eq!(copies.len(), 1, "{copies:?}");
        assert_eq!(std::fs::read_to_string(held_file().with_file_name(&copies[0])).unwrap(), "{ half a file");
        assert!(is_held("junk-one"));
    }

    /// An entry written by an older build lacks a field a newer one added.
    #[test]
    fn an_entry_missing_a_field_still_loads() {
        let _d = TempDataDir::new();
        std::fs::create_dir_all(held_file().parent().unwrap()).unwrap();
        std::fs::write(held_file(), r#"[{"sub_id":"old-one","launch":{"first_message":"do it"}}]"#).unwrap();
        let held = all();
        assert_eq!(held.len(), 1);
        assert_eq!(held[0].launch.first_message, "do it");
        assert!(bad_copies().is_empty(), "nothing was unreadable");
    }

    #[test]
    fn dropping_a_parents_held_subs_leaves_other_parents_alone() {
        let _d = TempDataDir::new();
        let st = state();
        hold_behind(&st, "dp-a", "dp-a-held", "x", "dp-a-t", "t");
        hold_behind(&st, "dp-b", "dp-b-held", "y", "dp-b-t", "t");
        assert_eq!(drop_held_of_parent(&st, "dp-a"), ["dp-a-held"]);
        assert!(!is_held("dp-a-held") && is_held("dp-b-held"));
    }

    // ── a second daemon on the same data folder ───────────────────────────

    /// 2026-11-10: the `test-pclient` lib test booted a daemon on the live data
    /// folder, its boot pass found no row for the live app's held subs, and it
    /// forgot all of them, so four queued lanes never started.
    #[tokio::test]
    async fn a_second_daemon_instance_on_the_same_data_dir_leaves_the_live_held_set_alone() {
        let _d = TempDataDir::new();
        let st = state();
        hold_behind(&st, "si-main", "si-sub", "footer", "si-target", "header");
        std::env::set_var("CC_DAEMON_INSTANCE", "test-other");
        let other = state();
        let c = calls();
        release_ready(&other, launcher(&c)).await;
        std::env::remove_var("CC_DAEMON_INSTANCE");
        assert!(is_held("si-sub"), "a daemon whose registry does not know the sub must not forget it");
        assert!(c.lock().unwrap().is_empty());
    }

    // ── a hold that was lost ───────────────────────────────────────────────

    /// A sub of `parent` whose brief says it waits for `after` by name.
    fn lost_sub(st: &DaemonState, parent: &str, id: &str, name: &str, after: Option<&str>) {
        sub_of(st, parent, id, name);
        let mut brief: super::super::SubchatBrief = serde_json::from_str(&format!(
            r#"{{"parent":"{parent}","task":"Build the footer","goal":"g","done_when":"d","writes":true,"files":["src/"]}}"#
        ))
        .unwrap();
        brief.after = after.map(str::to_string);
        crate::sessions::chat_config::set_subchat(id, Some(brief));
    }

    fn no_transcript(_: &str) -> bool {
        false
    }

    #[tokio::test]
    async fn a_never_started_sub_whose_hold_was_lost_is_rebuilt_from_its_brief_and_starts_when_its_target_is_done() {
        let _d = TempDataDir::new();
        let st = state();
        sub_of(&st, "lh-main", "lh-target", "header");
        st.registry.set_subchat_finished("lh-target", true);
        lost_sub(&st, "lh-main", "lh-lost", "footer", Some("header"));
        lost_sub(&st, "lh-main", "lh-later", "sidebar", Some("footer"));

        let (mut rebuilt, for_slot) = recover_lost_with(&st, &no_transcript, &|_| true);
        rebuilt.sort();
        assert_eq!(rebuilt, ["lh-later", "lh-lost"]);
        assert!(!for_slot, "both wait for a named sub");
        let entry = all().into_iter().find(|h| h.sub_id == "lh-lost").expect("held again");
        assert_eq!((entry.after.as_deref(), entry.after_name.as_str()), (Some("lh-target"), "header"));
        assert!(entry.launch.first_message.starts_with("Job: Build the footer"), "{}", entry.launch.first_message);
        assert_eq!(st.registry.get("lh-lost").unwrap().progress.waiting_for.as_deref(), Some("waiting for header"));

        let c = calls();
        release_ready(&st, launcher(&c)).await;
        assert_eq!(*c.lock().unwrap(), ["lh-lost"], "the one whose target finished starts; the next keeps waiting");
        assert!(is_held("lh-later"));
    }

    #[test]
    fn a_lost_hold_is_rebuilt_once_and_a_sub_that_ran_is_never_rebuilt() {
        let _d = TempDataDir::new();
        let st = state();
        lost_sub(&st, "lo-main", "lo-lost", "footer", None);
        lost_sub(&st, "lo-main", "lo-ran", "header", None);
        let has = |id: &str| id == "lo-ran";
        let (rebuilt, for_slot) = recover_lost_with(&st, &has, &|_| true);
        assert_eq!(rebuilt, ["lo-lost"]);
        assert!(for_slot, "no after: it waits for the writer slot");
        release(&st, "lo-lost");
        assert!(recover_lost_with(&st, &has, &|_| true).0.is_empty(), "rebuilt once per run; a second loss goes to the watchdog");
    }

    #[test]
    fn only_a_recent_lost_hold_is_rebuilt_on_its_own() {
        let _d = TempDataDir::new();
        let st = state();
        lost_sub(&st, "ag-main", "ag-old", "footer", None);
        let inst = st.registry.get("ag-old").unwrap();
        let registered = chrono::DateTime::parse_from_rfc3339(&inst.started_at).unwrap().with_timezone(&chrono::Utc);
        assert!(recent_enough(&inst, registered + RECOVER_WITHIN));
        assert!(!recent_enough(&inst, registered + RECOVER_WITHIN + chrono::Duration::minutes(1)));
        let now = registered + chrono::Duration::hours(8);
        assert!(recover_lost_with(&st, &no_transcript, &|i| recent_enough(i, now)).0.is_empty(), "an hours-old job is the main chat's call");
        assert!(never_started(&st, &inst, &no_transcript));
    }

    #[tokio::test]
    async fn joes_nudge_on_a_sub_that_never_started_starts_it_and_a_sub_that_ran_is_left_to_the_real_nudge() {
        let _d = TempDataDir::new();
        let st = state();
        sub_of(&st, "ns-main", "ns-target", "header");
        st.registry.set_subchat_finished("ns-target", true);
        lost_sub(&st, "ns-main", "ns-lost", "footer", Some("header"));
        lost_sub(&st, "ns-main", "ns-ran", "sidebar", None);
        let has = |id: &str| id == "ns-ran";
        let c = calls();
        assert!(start_never_started_with(&st, "ns-lost", &has, launcher(&c)).await);
        assert_eq!(*c.lock().unwrap(), ["ns-lost"]);
        assert!(!start_never_started_with(&st, "ns-ran", &has, launcher(&c)).await, "it has a conversation to resume");
    }
}
