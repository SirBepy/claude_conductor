//! The host half of what a main chat does to its visiting subs
//! (`docs/cross-machine-subchats.md`, "Wire": `sub_deliver`, `sub_status`,
//! `sub_start`, `sub_end`, `sub_drop`, and `sub_pause` / `sub_resume` of a put-away).
//!
//! The home decides and words everything; the host carries the action out on its own
//! row, the same code a local sub's action runs. Every call is machine-only (`M`) and
//! acts on a sub only when the sub's stored `home.machine_id` is the machine the call
//! arrived from (`ctx.transport`, never a payload field), so a peer cannot message,
//! start, end or read a chat of this machine's own, nor a sub another machine started.
//! Anything else is one refusal that does not say whether the id exists.

use super::host::{peer_of, Starter};
use crate::daemon::rpc::{ConnectionContext, Router, RpcError};
use crate::daemon::state::DaemonState;
use crate::daemon::subchats::{brief, held, queued, resume, tool, SubchatBrief};
use crate::types::Instance;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

/// What the host says when `sub_start` finds the sub running already; the home reads it as "done".
pub const ALREADY_STARTED: &str = "it has started already";

/// Longest text a main chat may send a sub in one `sub_deliver`: the same bound a first
/// message has.
const MAX_TEXT: usize = 200_000;

#[derive(Debug, Deserialize)]
struct Deliver {
    sub_id: String,
    text: String,
    #[serde(default)]
    writes: bool,
    #[serde(default)]
    question: Option<String>,
}

#[derive(Debug, Deserialize)]
struct Only {
    sub_id: String,
}

#[derive(Debug, Deserialize)]
struct Start {
    sub_id: String,
    /// Start a sub whose start failed (`subchat retry`), not one that waits.
    #[serde(default)]
    retry: bool,
    /// The tip of the home's target branch and the commits this clone lacks of it: a
    /// held writing sub's tree is brought up to it before the sub starts, so a sub that
    /// waited for another builds on what that one merged.
    #[serde(default)]
    target_tip: Option<String>,
    #[serde(default)]
    bundle: Option<String>,
}

/// Registers the methods. `start` is how a registered sub is started, as for
/// `sub_spawn` (a test passes one that starts no `claude`).
pub fn register(router: &mut Router, state: Arc<DaemonState>, start: Starter) {
    router.register("sub_deliver", {
        let state = state.clone();
        move |params, ctx| {
            let state = state.clone();
            async move { deliver(&state, &ctx, decode(params)?).await }
        }
    });
    router.register("sub_status", {
        let state = state.clone();
        move |params, ctx| {
            let state = state.clone();
            async move { status(&state, &ctx, decode(params)?).await }
        }
    });
    router.register("sub_start", {
        let state = state.clone();
        move |params, ctx| {
            let (state, start) = (state.clone(), start.clone());
            async move { start_it(&state, &start, &ctx, decode(params)?).await }
        }
    });
    router.register("sub_end", {
        let state = state.clone();
        move |params, ctx| {
            let state = state.clone();
            async move { end(&state, &ctx, decode::<Only>(params)?) }
        }
    });
    router.register("sub_drop", {
        let state = state.clone();
        move |params, ctx| {
            let state = state.clone();
            async move { drop_it(&state, &ctx, decode::<Only>(params)?) }
        }
    });
    router.register("sub_to_sidebar", {
        let state = state.clone();
        move |params, ctx| {
            let state = state.clone();
            async move { to_sidebar(&state, &ctx, decode::<Only>(params)?).await }
        }
    });
    router.register("sub_reparent", {
        let state = state.clone();
        move |params, ctx| {
            let state = state.clone();
            async move { reparent(&state, &ctx, decode::<Reparent>(params)?) }
        }
    });
    router.register("sub_pause", {
        let state = state.clone();
        move |params, ctx| {
            let state = state.clone();
            async move { pause(&state, &ctx, decode::<Only>(params)?).await }
        }
    });
    router.register("sub_resume", move |params, ctx| {
        let state = state.clone();
        async move { resume_it(&state, &ctx, decode::<Resume>(params)?).await }
    });
}

#[derive(Debug, Deserialize)]
struct Resume {
    sub_id: String,
    /// Send the sub "continue" when the pause cut a turn. The home's "Continue the plan?"
    /// answer decides it; a sub that was idle is only unfrozen either way.
    #[serde(default = "yes")]
    send_continue: bool,
}

fn yes() -> bool {
    true
}

/// Sub ids a pause is running for, so a pause the outbox sent twice (a lost reply) starts one wait.
static PAUSING: std::sync::Mutex<Option<std::collections::HashSet<String>>> = std::sync::Mutex::new(None);

struct Pausing(String);

impl Pausing {
    fn claim(sub_id: &str) -> Option<Self> {
        let mut all = PAUSING.lock().unwrap_or_else(|p| p.into_inner());
        all.get_or_insert_with(Default::default).insert(sub_id.to_string()).then(|| Self(sub_id.to_string()))
    }
}

impl Drop for Pausing {
    fn drop(&mut self) {
        if let Some(all) = PAUSING.lock().unwrap_or_else(|p| p.into_inner()).as_mut() {
            all.remove(&self.0);
        }
    }
}

/// The main chat's id on its HOME, which is what this machine's gate for the sub's family is
/// keyed by (`put_away::family_main`: a visiting sub's parent is the home's main chat).
fn home_main(state: &DaemonState, sub_id: &str, stored: &SubchatBrief) -> String {
    let main = crate::daemon::subchats::put_away::family_main(state, sub_id);
    if main == sub_id {
        stored.home.as_ref().map(|h| h.main_id.clone()).unwrap_or_else(|| stored.parent.clone())
    } else {
        main
    }
}

/// The home put the sub's main chat away (pc-1806 step 4): this machine closes its gate for
/// the family FIRST (the record is durable, so a restart half way still holds it), then pauses
/// the sub at its next turn end on a task of its own, never mid-tool, exactly as a local sub
/// is paused. The reply only says the pause was taken up: the wait can last hours, and the
/// home's outbox needs an answer to drop the entry.
async fn pause(state: &Arc<DaemonState>, ctx: &ConnectionContext, req: Only) -> Result<Value, RpcError> {
    let (inst, stored) = own_sub(state, ctx, "sub_pause", &req.sub_id)?;
    if inst.ended_at.is_some() || inst.end_reason.is_some() {
        return Err(RpcError::invalid_params("it has ended, so there is nothing to pause"));
    }
    let main = home_main(state, &req.sub_id, &stored);
    let now = chrono::Utc::now().to_rfc3339();
    let paused = crate::daemon::subchats::put_away::paused_sub_for(state, &inst, &now).await;
    crate::daemon::subchats::put_away::visiting_pause(&main, paused.clone(), &now).map_err(|e| RpcError::internal(format!("could not record the pause: {e}")))?;
    // It may have ended while the state was read: its end forgot a sub that was not listed
    // yet, and the home never resumes an ended one, so the entry would keep the gate shut.
    if state.registry.get(&req.sub_id).map_or(true, |i| i.ended_at.is_some() || i.end_reason.is_some()) {
        forget_pause(state, &req.sub_id, &stored);
        return Err(RpcError::invalid_params("it has ended, so there is nothing to pause"));
    }
    if let (Some(claim), Ok(handle)) = (Pausing::claim(&req.sub_id), tokio::runtime::Handle::try_current()) {
        let state = state.clone();
        handle.spawn(async move {
            let _claim = claim;
            crate::daemon::subchats::put_away::pause_sub(&state, &main, &paused, &crate::daemon::subchats::put_away::Timing::default()).await;
            crate::daemon::machines::publish_instances_changed(&state);
            crate::sessions::persistence::save_snapshot_default(&state.registry);
        });
    }
    Ok(json!({ "ok": true }))
}

/// The home reopened the sub's main chat (step 6): the gate opens, and the sub is unfrozen and
/// told to "continue" when the pause cut a turn and the home asked for it. A sub with no child
/// (held, finished, or killed by a restart that the gate then kept down) is only let go: a
/// held one starts again by the home's own sweep, and a finished one has nothing to do.
async fn resume_it(state: &Arc<DaemonState>, ctx: &ConnectionContext, req: Resume) -> Result<Value, RpcError> {
    // A sub whose row is gone (closed here meanwhile) must still release the gate it held, so
    // the caller is checked by the stored brief alone when there is no row to read.
    let stored = match own_sub(state, ctx, "sub_resume", &req.sub_id) {
        Ok((_, stored)) => stored,
        Err(e) => own_brief(ctx, "sub_resume", &req.sub_id).map_err(|_| e)?,
    };
    let main = home_main(state, &req.sub_id, &stored);
    // The gate opens before anything is sent: `continue_sub` refuses a gated family.
    crate::daemon::subchats::put_away::visiting_resume(&main, &req.sub_id).map_err(|e| RpcError::internal(format!("could not record the resume: {e}")))?;
    // A pause still waiting for the sub's turn end sees the gate open and leaves within a poll; one
    // that is already stopping the child finishes first, so the row is read after it is frozen,
    // never before (a freeze that lands after this read would outlive the resume).
    for _ in 0..600 {
        if !PAUSING.lock().unwrap_or_else(|p| p.into_inner()).as_ref().is_some_and(|all| all.contains(&req.sub_id)) {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    let Some(inst) = state.registry.get(&req.sub_id) else { return Ok(json!({ "ok": true, "resumed": "nothing" })) };
    if inst.ended_at.is_some() || inst.end_reason.is_some() || !inst.frozen {
        return Ok(json!({ "ok": true, "resumed": "nothing" }));
    }
    let needs = state.registry.take_frozen_needs_continue(&req.sub_id);
    if needs && req.send_continue {
        // `continue_sub` clears the freeze itself, as `subchat send` does.
        if let Err(e) = continue_for_delivery(state, &req.sub_id, "continue").await {
            // The pause cut a turn and this did not restart it: the flag goes back, and the
            // outbox sends the resume again (an internal error is retried, a refusal is dropped).
            state.registry.set_frozen_needs_continue(&req.sub_id, true);
            return Err(RpcError::internal(format!("could not continue the sub: {e}")));
        }
        return Ok(json!({ "ok": true, "resumed": "continued" }));
    }
    state.registry.set_frozen(&req.sub_id, false);
    state.registry.set_auto_frozen(&req.sub_id, false);
    crate::daemon::machines::publish_instances_changed(state);
    crate::sessions::persistence::save_snapshot_default(&state.registry);
    Ok(json!({ "ok": true, "resumed": "unfrozen" }))
}

/// `forget_pause` for a sub known only by id (its own end, seen on this machine).
pub(super) fn forget_paused(state: &DaemonState, sub_id: &str) {
    if let Some(stored) = crate::sessions::chat_config::get(sub_id).and_then(|c| c.subchat) {
        forget_pause(state, sub_id, &stored);
    }
}

/// A visiting sub that ended or left its home's family: this machine's record of the pause
/// no longer lists it, and the gate it held opens with the last one.
fn forget_pause(state: &DaemonState, sub_id: &str, stored: &SubchatBrief) {
    let main = home_main(state, sub_id, stored);
    if let Err(e) = crate::daemon::subchats::put_away::visiting_forget(&main, sub_id) {
        log::warn!("subchats: could not drop {sub_id} from the paused visitors of {main}: {e}");
    }
}

#[derive(Debug, Deserialize)]
struct Reparent {
    sub_id: String,
    /// The main chat on the home that took over the family (a respawn's successor).
    new_main_id: String,
}

/// The main chat of the sub's family changed on the home (a respawn moved the family to
/// its successor): the sub's parent, its brief and its home reference name the new one.
/// The machine stays the caller's own: the stored home machine is never rewritten.
fn reparent(state: &Arc<DaemonState>, ctx: &ConnectionContext, req: Reparent) -> Result<Value, RpcError> {
    let (_, mut stored) = own_sub(state, ctx, "sub_reparent", &req.sub_id)?;
    if !super::host::plain_id(&req.new_main_id) {
        return Err(RpcError::invalid_params("new_main_id is not a chat id"));
    }
    // As at spawn: a main chat id that names a chat of this machine would make the sub part of
    // that chat's family.
    if state.registry.get(&req.new_main_id).is_some() {
        return Err(RpcError::invalid_params("new_main_id names a chat on this machine, not on the machine that sent the call"));
    }
    stored.parent = req.new_main_id.clone();
    if let Some(home) = stored.home.as_mut() {
        home.main_id = req.new_main_id.clone();
    }
    crate::sessions::chat_config::set_subchat(&req.sub_id, Some(stored));
    crate::sessions::chat_config::set_spawned_by(&req.sub_id, &req.new_main_id);
    state.registry.set_subchat_of(&req.sub_id, Some(req.new_main_id.clone()));
    crate::sessions::persistence::save_snapshot_default(&state.registry);
    crate::daemon::machines::publish_instances_changed(state);
    Ok(json!({ "ok": true }))
}

fn decode<T: for<'de> Deserialize<'de>>(params: Option<Value>) -> Result<T, RpcError> {
    serde_json::from_value(params.unwrap_or(Value::Null)).map_err(|e| RpcError::invalid_params(e.to_string()))
}

/// The row and brief of the sub `sub_id` names, when it is a visiting sub of the
/// calling machine's.
fn own_sub(state: &DaemonState, ctx: &ConnectionContext, method: &str, sub_id: &str) -> Result<(Instance, SubchatBrief), RpcError> {
    let brief = own_brief(ctx, method, sub_id)?;
    let inst = state.registry.get(sub_id).ok_or_else(|| RpcError::invalid_params("no sub of a chat on your machine has that id here"))?;
    Ok((inst, brief))
}

/// The stored brief of a sub that belongs to the calling machine, with no registry row needed.
fn own_brief(ctx: &ConnectionContext, method: &str, sub_id: &str) -> Result<SubchatBrief, RpcError> {
    let from = peer_of(ctx, method)?;
    let refuse = || RpcError::invalid_params("no sub of a chat on your machine has that id here");
    if uuid::Uuid::parse_str(sub_id).is_err() {
        return Err(refuse());
    }
    let brief = crate::sessions::chat_config::get(sub_id).and_then(|c| c.subchat).ok_or_else(refuse)?;
    if brief.home.as_ref().map(|h| h.machine_id.as_str()) != Some(from.as_str()) {
        return Err(refuse());
    }
    Ok(brief)
}

/// The word the home reads a delivery by.
fn word(d: &tool::Delivery) -> &'static str {
    match d {
        tool::Delivery::Passed => "passed",
        tool::Delivery::Held => "held",
        tool::Delivery::NotStarted => "not_started",
        tool::Delivery::Stranded => "stranded",
    }
}

/// `subchat send`'s delivery on this machine: continue the sub, hold the text until it
/// is idle, or queue it behind a sub that never started. The home composed the text
/// (Joe's words, the framed main-chat text and the question job); this only delivers it.
async fn deliver(state: &Arc<DaemonState>, ctx: &ConnectionContext, req: Deliver) -> Result<Value, RpcError> {
    let (inst, stored) = own_sub(state, ctx, "sub_deliver", &req.sub_id)?;
    if req.text.trim().is_empty() || req.text.len() > MAX_TEXT {
        return Err(RpcError::invalid_params("text is empty or over 200000 bytes"));
    }
    if inst.ended_at.is_some() || inst.end_reason.is_some() {
        return Err(RpcError::invalid_params("it has ended and cannot take a message"));
    }
    let question = brief::question_arg(req.question.as_deref()).map_err(RpcError::invalid_params)?;
    // Only this machine knows the sub's writes were off, so the home's composed text gets
    // the note here.
    if req.writes {
        // A reader runs in the project folder with no tree of its own, so turning it into a
        // writer here would edit the checkout; the main chat spawns a new sub instead.
        if !stored.writes {
            return Err(RpcError::invalid_params("this sub was started as a reader on this machine and has no worktree: it cannot be made a writer. Spawn a new sub for the change."));
        }
        if inst.model.to_ascii_lowercase().contains("opus") {
            return Err(RpcError::invalid_params(crate::daemon::subchats::spawn::OPUS_WRITER_REFUSAL));
        }
        tool::record_writes(&req.sub_id);
    }
    let note = tool::writes_note_due(&req.sub_id);
    // One sub changes files at a time: a follow-up that needs to write takes the slot or
    // queues for it, as a local `subchat send` does, and the home hears which so its main
    // chat is told this sub waits.
    let queued_behind = if req.writes {
        match crate::daemon::subchats::writers::request_slot(state, &req.sub_id) {
            crate::daemon::subchats::writers::SlotOutcome::Queued { behind, .. } => Some(behind),
            crate::daemon::subchats::writers::SlotOutcome::Granted => None,
        }
    } else {
        None
    };
    let owner = state.clone();
    let resume = move |sub_id: String, text: String| {
        let state = owner.clone();
        async move { continue_for_delivery(&state, &sub_id, &text).await }
    };
    let has = |id: &str| crate::context_status::resolve_transcript(&state.registry, id).is_some();
    let text = if note { tool::with_writes_note(&req.text) } else { req.text.clone() };
    let delivery = tool::deliver(state, &inst, &text, &resume, &has).await.map_err(RpcError::invalid_params)?;
    if let Some(q) = &question {
        tool::record_question(&req.sub_id, q);
    }
    Ok(json!({ "ok": true, "delivery": word(&delivery), "queued_behind": queued_behind }))
}

/// Wakes the sub with `text` as a new turn. A test records the text instead (the same seam
/// the local merge follow-up has), so no `claude` child is started.
async fn continue_for_delivery(state: &Arc<DaemonState>, sub_id: &str, text: &str) -> Result<(), crate::daemon::subchats::ContinueError> {
    #[cfg(test)]
    {
        let _ = state;
        return crate::daemon::subchats::merge_followup::test_support::send(sub_id, text)
            .map_err(|_| crate::daemon::subchats::ContinueError::Ended(sub_id.to_string()));
    }
    #[cfg(not(test))]
    crate::daemon::subchats::continue_sub(state, sub_id, text).await
}

/// What `subchat status` shows of a running sub: read here, because only this machine
/// has its row, its transcript and its git. Plain data; the home cuts every string.
async fn status(state: &Arc<DaemonState>, ctx: &ConnectionContext, req: Only) -> Result<Value, RpcError> {
    let (inst, _) = own_sub(state, ctx, "sub_status", &req.sub_id)?;
    let (st, row) = (state.clone(), inst.clone());
    // Git and the transcript are read off the async threads.
    let facts = tokio::task::spawn_blocking(move || tool::real_facts(&st, &row))
        .await
        .map_err(|e| RpcError::internal(e.to_string()))?
        .map(|f| tool::facts_line(&f));
    Ok(json!({
        "ok": true,
        "status": tool::status_word(&inst),
        "tier": tool::tier(&inst),
        "context_pct": crate::daemon::subchats::ceiling::context_pct(state, &req.sub_id),
        "progress": tool::progress(&inst),
        "facts": facts,
    }))
}

/// Starts a sub registered with `hold: true` (an `after` chain whose target is done, or
/// Joe's "Start now"), or one whose start failed (`retry`). The start itself runs in the
/// background as a spawn's does, so a failure reaches the home as a `could_not_start` wake.
async fn start_it(state: &Arc<DaemonState>, start: &Starter, ctx: &ConnectionContext, req: Start) -> Result<Value, RpcError> {
    let (inst, stored) = own_sub(state, ctx, "sub_start", &req.sub_id)?;
    if inst.ended_at.is_some() || inst.end_reason.is_some() {
        return Err(RpcError::invalid_params("it has ended, so there is nothing to start"));
    }
    if !held::is_held(&req.sub_id) {
        return Err(RpcError::invalid_params(format!("it is not waiting to start: {ALREADY_STARTED}")));
    }
    if let (Some(tip), false) = (req.target_tip.clone(), req.retry) {
        let Some(info) = stored.worktree_at.clone() else {
            return Err(RpcError::invalid_params("that sub has no worktree here, so there is no tree to bring up to date"));
        };
        if !super::git_sync::is_commit_id(&tip) {
            return Err(RpcError::invalid_params("target_tip is not a full commit id"));
        }
        let update = super::host_land::UpdateParams { sub_id: req.sub_id.clone(), target_tip: tip, bundle: req.bundle.clone() };
        let moved = tokio::task::spawn_blocking(move || super::host_land::update_blocking(&update, &info))
            .await
            .map_err(|e| RpcError::internal(e.to_string()))?
            .map_err(RpcError::invalid_params)?;
        // The home's call can time out and be sent again while this one works: a sub that was
        // started in the meantime is not this call's to report as waiting.
        if !held::is_held(&req.sub_id) {
            return Err(RpcError::invalid_params(format!("it is not waiting to start: {ALREADY_STARTED}")));
        }
        if moved["status"].as_str() != Some("done") {
            let why = moved["why"].as_str().unwrap_or("it did not say why");
            return Err(RpcError::invalid_params(format!("its tree could not be brought up to date with the target: {}", crate::util::text::flat_clip(why, 200))));
        }
    }
    if req.retry {
        let launcher = start.clone();
        held::retry_with(state, &req.sub_id, move |st, id| {
            let launcher = launcher.clone();
            async move {
                launcher(&st, &id);
                Ok(())
            }
        })
        .await
        .map_err(RpcError::invalid_params)?;
    } else {
        start(state, &req.sub_id);
    }
    Ok(json!({ "ok": true }))
}

/// Ends the sub for good: the home closed it, or closed its main chat.
fn end(state: &Arc<DaemonState>, ctx: &ConnectionContext, req: Only) -> Result<Value, RpcError> {
    let (_, stored) = own_sub(state, ctx, "sub_end", &req.sub_id)?;
    forget_pause(state, &req.sub_id, &stored);
    if held::is_held(&req.sub_id) {
        held::drop_held(state, &req.sub_id);
    } else {
        resume::end_sub(state, &req.sub_id);
    }
    // A research sub's scratch folder goes with it (a no-op for any other sub).
    super::scratch::remove(&req.sub_id);
    Ok(json!({ "ok": true }))
}

/// Hands the sub to this machine's sidebar: its main chat closed on the home, so it
/// becomes an ordinary chat here with its work in flight kept.
async fn to_sidebar(state: &Arc<DaemonState>, ctx: &ConnectionContext, req: Only) -> Result<Value, RpcError> {
    let (_, stored) = own_sub(state, ctx, "sub_to_sidebar", &req.sub_id)?;
    forget_pause(state, &req.sub_id, &stored);
    // A sub that never ran (queued here) has no conversation to keep: it ends with its chat.
    if held::is_held(&req.sub_id) {
        held::drop_held(state, &req.sub_id);
        return Ok(json!({ "ok": true }));
    }
    crate::daemon::subchats::move_to_sidebar(state, &req.sub_id).await.map_err(|e| RpcError::invalid_params(e.to_string()))?;
    Ok(json!({ "ok": true }))
}

/// Drops a sub that never started, by the same code `subchat drop` runs for a local one.
fn drop_it(state: &Arc<DaemonState>, ctx: &ConnectionContext, req: Only) -> Result<Value, RpcError> {
    let (_, stored) = own_sub(state, ctx, "sub_drop", &req.sub_id)?;
    let name = queued::drop_now(state, &req.sub_id).map_err(RpcError::invalid_params)?;
    forget_pause(state, &req.sub_id, &stored);
    super::scratch::remove(&req.sub_id);
    Ok(json!({ "ok": true, "dropped": crate::util::text::flat_clip(&name, 120) }))
}
