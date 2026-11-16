//! The host half of what a main chat does to its visiting subs
//! (`docs/cross-machine-subchats.md`, "Wire": `sub_deliver`, `sub_status`,
//! `sub_start`, `sub_end`, `sub_drop`).
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
}

/// Registers the six methods. `start` is how a registered sub is started, as for
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
    router.register("sub_to_sidebar", move |params, ctx| {
        let state = state.clone();
        async move { to_sidebar(&state, &ctx, decode::<Only>(params)?).await }
    });
}

fn decode<T: for<'de> Deserialize<'de>>(params: Option<Value>) -> Result<T, RpcError> {
    serde_json::from_value(params.unwrap_or(Value::Null)).map_err(|e| RpcError::invalid_params(e.to_string()))
}

/// The row and brief of the sub `sub_id` names, when it is a visiting sub of the
/// calling machine's.
fn own_sub(state: &DaemonState, ctx: &ConnectionContext, method: &str, sub_id: &str) -> Result<(Instance, SubchatBrief), RpcError> {
    let from = peer_of(ctx, method)?;
    let refuse = || RpcError::invalid_params("no sub of a chat on your machine has that id here");
    if uuid::Uuid::parse_str(sub_id).is_err() {
        return Err(refuse());
    }
    let brief = crate::sessions::chat_config::get(sub_id).and_then(|c| c.subchat).ok_or_else(refuse)?;
    if brief.home.as_ref().map(|h| h.machine_id.as_str()) != Some(from.as_str()) {
        return Err(refuse());
    }
    let inst = state.registry.get(sub_id).ok_or_else(refuse)?;
    Ok((inst, brief))
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
    let owner = state.clone();
    let resume = move |sub_id: String, text: String| {
        let state = owner.clone();
        async move { crate::daemon::subchats::continue_sub(&state, &sub_id, &text).await }
    };
    let has = |id: &str| crate::context_status::resolve_transcript(&state.registry, id).is_some();
    let delivery = tool::deliver(state, &inst, &req.text, &resume, &has).await.map_err(RpcError::invalid_params)?;
    if let Some(q) = &question {
        tool::record_question(&req.sub_id, q);
    }
    Ok(json!({ "ok": true, "delivery": word(&delivery) }))
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
    let (inst, _) = own_sub(state, ctx, "sub_start", &req.sub_id)?;
    if inst.ended_at.is_some() || inst.end_reason.is_some() {
        return Err(RpcError::invalid_params("it has ended, so there is nothing to start"));
    }
    if !held::is_held(&req.sub_id) {
        return Err(RpcError::invalid_params("it is not waiting to start: it has started already"));
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
    own_sub(state, ctx, "sub_end", &req.sub_id)?;
    if held::is_held(&req.sub_id) {
        held::drop_held(state, &req.sub_id);
    } else {
        resume::end_sub(state, &req.sub_id);
    }
    Ok(json!({ "ok": true }))
}

/// Hands the sub to this machine's sidebar: its main chat closed on the home, so it
/// becomes an ordinary chat here with its work in flight kept.
async fn to_sidebar(state: &Arc<DaemonState>, ctx: &ConnectionContext, req: Only) -> Result<Value, RpcError> {
    own_sub(state, ctx, "sub_to_sidebar", &req.sub_id)?;
    crate::daemon::subchats::move_to_sidebar(state, &req.sub_id).await.map_err(|e| RpcError::invalid_params(e.to_string()))?;
    Ok(json!({ "ok": true }))
}

/// Drops a sub that never started, by the same code `subchat drop` runs for a local one.
fn drop_it(state: &Arc<DaemonState>, ctx: &ConnectionContext, req: Only) -> Result<Value, RpcError> {
    own_sub(state, ctx, "sub_drop", &req.sub_id)?;
    let name = queued::drop_now(state, &req.sub_id).map_err(RpcError::invalid_params)?;
    Ok(json!({ "ok": true, "dropped": crate::util::text::flat_clip(&name, 120) }))
}
