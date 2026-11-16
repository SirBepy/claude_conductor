//! The home's half of what a main chat does to a sub that runs on another machine
//! (`docs/cross-machine-subchats.md`, step 6): `subchat send`, `status`, `drop`,
//! `retry` and the close of a sub.
//!
//! The home owns the family and words everything Joe or the main chat reads; the host
//! carries out the action on its own row (`host_actions.rs`). An interactive call goes
//! to the host at once and fails with a plain "unreachable" when the host does not
//! answer, since the main chat is waiting for the verdict; ending a sub goes through the
//! outbox like a finish does, so it still reaches a host that is away. What the host
//! says back is data: every string is cut to size before it is shown, and none of it
//! reaches an `is_meta` message.

use super::outbox;
use super::records::{self, RemoteState, RemoteSub};
use crate::daemon::machines::{forward, PeerError};
use crate::daemon::state::DaemonState;
use crate::util::text::flat_clip;
use serde_json::{json, Value};
use std::sync::Arc;

/// Longest error a host's refusal may put in a tool result.
const MAX_REFUSAL: usize = 300;
const MAX_STATUS_TEXT: usize = 400;

/// The name the main chat gave the sub, or the head of its id.
pub fn name_of(rec: &RemoteSub) -> String {
    let name = rec.name.trim();
    if name.is_empty() { rec.sub_id.chars().take(8).collect() } else { name.to_string() }
}

/// What every "the host does not answer" sentence of this module contains, so a caller
/// that retries on its own tick can tell it from a refusal.
pub const UNREACHABLE: &str = "is unreachable (";

/// One interactive call to the host. `Err` is the sentence the tool result carries.
async fn call(state: &Arc<DaemonState>, rec: &RemoteSub, method: &str, params: Value) -> Result<Value, String> {
    let label = forward::peer_label(state, &rec.machine_id);
    let unreachable = |why: &str| format!("{label} {UNREACHABLE}{}). The sub keeps running there: try again when it is back.", flat_clip(why, 160));
    let client = forward::resolve_peer_client(state, &rec.machine_id).await.map_err(|e| unreachable(&e.message))?;
    match client.call(method, params).await {
        Ok(v) => Ok(v),
        Err(PeerError::Rejected { message, .. }) => Err(flat_clip(&message, MAX_REFUSAL)),
        Err(e) => Err(unreachable(&e.to_string())),
    }
}

/// Where a delivered message stands on the host.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Delivery {
    Passed,
    Held,
    NotStarted,
    Stranded,
}

/// `subchat send` to a remote sub: the host continues it, holds the text until it is
/// idle, or queues it behind a sub that never started. `text` is already composed here
/// (Joe's words, the framed main-chat text, the question job).
pub async fn deliver(state: &Arc<DaemonState>, rec: &RemoteSub, text: &str, writes: bool, question: Option<&str>) -> Result<Delivery, String> {
    if rec.state == RemoteState::Ended {
        return Err("it has ended and cannot take a message".to_string());
    }
    let reply = call(state, rec, "sub_deliver", json!({ "sub_id": rec.sub_id, "text": text, "writes": writes, "question": question })).await?;
    let delivery = match reply["delivery"].as_str() {
        Some("held") => Delivery::Held,
        Some("not_started") => Delivery::NotStarted,
        Some("stranded") => Delivery::Stranded,
        _ => Delivery::Passed,
    };
    // A finished sub that took a message is working again: the family counts it.
    if matches!(delivery, Delivery::Passed | Delivery::Held) && rec.state == RemoteState::Finished {
        let _ = records::update_state(&rec.sub_id, RemoteState::Running);
    }
    Ok(delivery)
}

/// The live part of `subchat status` for a running remote sub, from the host, every
/// string cut; `None` when the host does not answer (the record and the finish record
/// are what is left then).
pub async fn live_status(state: &Arc<DaemonState>, rec: &RemoteSub) -> Option<Value> {
    let v = call(state, rec, "sub_status", json!({ "sub_id": rec.sub_id })).await.ok()?;
    let text = |key: &str| v[key].as_str().map(|s| flat_clip(s, MAX_STATUS_TEXT)).filter(|s| !s.is_empty());
    Some(json!({
        "status": text("status"),
        "tier": text("tier"),
        "progress": text("progress"),
        "facts": text("facts"),
        "context_pct": v["context_pct"].as_u64().map(|n| n.min(100)),
    }))
}

/// `subchat retry` for a remote sub whose start failed on the host.
pub async fn retry(state: &Arc<DaemonState>, rec: &RemoteSub) -> Result<(), String> {
    call(state, rec, "sub_start", json!({ "sub_id": rec.sub_id, "retry": true })).await.map(|_| ())
}

/// Starts a remote sub the host holds (an `after` chain whose target is done, or Joe's
/// "Start now"). A writing sub's tree was made at the commit its main chat was on when
/// it was spawned: the sub it waited for may have merged since, so the tree is first
/// brought up to the target's tip (`sub_start` carries the tip and the commits the host
/// lacks), and a sub that cannot be brought up to date is not started.
pub async fn start(state: &Arc<DaemonState>, rec: &RemoteSub) -> Result<(), String> {
    let mut params = json!({ "sub_id": rec.sub_id, "retry": false });
    if rec.state == RemoteState::Held && super::land::lands(rec) {
        let held = rec.clone();
        let offered = tokio::task::spawn_blocking(move || super::land::offer(&held)).await.map_err(|e| e.to_string())?;
        match offered {
            Ok(o) => {
                params["target_tip"] = json!(o.tip);
                params["bundle"] = json!(o.bundle);
            }
            Err(crate::daemon::subchats::worktree::Landing::Blocked(b)) => {
                return Err(format!(
                    "Its tree could not be brought up to {} before it starts ({}). Fix that and start it again.",
                    rec.target,
                    flat_clip(&b.text, 200)
                ));
            }
            Err(_) => return Err(format!("Its tree could not be brought up to {} before it starts. Start it again.", rec.target)),
        }
    }
    match call_with_bundle(state, rec, "sub_start", params).await {
        Ok(_) => {}
        // The host started it already (a reply that was lost, or a start that raced this one):
        // that is what was asked for.
        Err(e) if e.contains(super::host_actions::ALREADY_STARTED) => {}
        Err(e) => return Err(e),
    }
    if rec.state == RemoteState::Held {
        let _ = records::update_state(&rec.sub_id, RemoteState::Running);
        super::after::drop_cards(state, &rec.sub_id);
    }
    Ok(())
}

/// [`call`] for a request that may carry a bundle, with the longer timeout one needs.
async fn call_with_bundle(state: &Arc<DaemonState>, rec: &RemoteSub, method: &str, params: Value) -> Result<Value, String> {
    let label = forward::peer_label(state, &rec.machine_id);
    let unreachable = |why: &str| format!("{label} {UNREACHABLE}{}). The sub keeps running there: try again when it is back.", flat_clip(why, 160));
    let client = forward::resolve_peer_client(state, &rec.machine_id).await.map_err(|e| unreachable(&e.message))?;
    match client.call_with_timeout(method, params, std::time::Duration::from_secs(120)).await {
        Ok(v) => Ok(v),
        Err(PeerError::Rejected { message, .. }) => Err(flat_clip(&message, MAX_REFUSAL)),
        Err(e) => Err(unreachable(&e.to_string())),
    }
}

/// The job a remote sub was briefed with, for the dashboard's Subchats card: asked of its
/// host, which holds the brief. `None` when `sub_id` is not a remote sub of this machine's
/// or the host does not answer. The host's words are data, so each is cut to size.
pub async fn brief(state: &Arc<DaemonState>, sub_id: &str) -> Option<Value> {
    let rec = records::get(sub_id)?;
    let reply = call(state, &rec, "get_sub_brief", json!({ "session_id": rec.sub_id })).await.ok()?;
    let b = reply.get("brief").filter(|b| b.is_object())?;
    let text = |key: &str| b[key].as_str().map(|s| s.chars().take(MAX_BRIEF_TEXT).collect::<String>()).unwrap_or_default();
    Some(json!({ "task": text("task"), "goal": text("goal"), "done_when": text("done_when") }))
}

/// Longest brief line shown for a remote sub.
const MAX_BRIEF_TEXT: usize = 4_000;

/// What a sub leaving the family sets going on the home: the "Wait for them" close and
/// every `after` chain read the family again, and its queued-sub card comes down.
fn settled(state: &Arc<DaemonState>, sub_id: &str) {
    super::after::drop_cards(state, sub_id);
    crate::daemon::subchats::closing::on_sub_settled(state, sub_id);
    crate::daemon::subchats::held::on_target_done(state);
}

/// `subchat drop` for a remote sub that never started. The host decides (a sub that ran
/// is Joe's to end), so this is a call and not an outbox entry: the refusal is the answer.
pub async fn drop_never_started(state: &Arc<DaemonState>, rec: &RemoteSub) -> Result<String, String> {
    let reply = call(state, rec, "sub_drop", json!({ "sub_id": rec.sub_id })).await?;
    let _ = records::update_state(&rec.sub_id, RemoteState::Ended);
    crate::daemon::subchats::plumbing::clear(&rec.sub_id);
    settled(state, &rec.sub_id);
    Ok(reply["dropped"].as_str().map(|n| flat_clip(n, 120)).unwrap_or_else(|| name_of(rec)))
}

/// Hands a running remote sub to its machine's sidebar, as "Move to sidebar" does for a
/// local one: it stops being a sub there and is an ordinary chat of that machine's, its
/// work in flight kept. Queued like an end, so a host that is away does it when it is back.
pub fn to_sidebar(state: &Arc<DaemonState>, rec: &RemoteSub) {
    if rec.state == RemoteState::Ended {
        return;
    }
    let _ = records::update_state(&rec.sub_id, RemoteState::Ended);
    if let Err(e) = outbox::enqueue(&rec.machine_id, "sub_to_sidebar", json!({ "sub_id": rec.sub_id })) {
        log::warn!("subchats: could not queue the move to the sidebar of {} for {}: {e}", rec.sub_id, rec.machine_id);
    }
    outbox::flush_in_background(state);
    crate::daemon::subchats::plumbing::clear(&rec.sub_id);
    settled(state, &rec.sub_id);
}

/// A respawn moved the main chat's family to its successor: every record of `old`'s subs
/// on paired machines names `new`, and each host that still has a live sub is told through
/// the outbox (so a host that is away learns it when it is back) to move its visiting row.
pub fn reparent_family(state: &Arc<DaemonState>, old: &str, new: &str) {
    if old == new {
        return;
    }
    let mut told = false;
    for rec in records::of_main(old) {
        // The host is told first: a crash between the two leaves the record under `old`, so a
        // second run of the move queues it again (the call is idempotent) instead of never.
        if rec.state != RemoteState::Ended {
            match outbox::enqueue(&rec.machine_id, "sub_reparent", json!({ "sub_id": rec.sub_id, "new_main_id": new })) {
                Ok(_) => told = true,
                Err(e) => log::warn!("subchats: could not queue the move of {} to the main chat {new} for {}: {e}", rec.sub_id, rec.machine_id),
            }
        }
        let _ = records::update(&rec.sub_id, |r| r.main_id = new.to_string());
    }
    if told {
        outbox::flush_in_background(state);
    }
}

/// Ends a remote sub for good (Joe closed it, or its main chat is closing). The record
/// ends at once; the host is told through the outbox, so a host that is away ends it
/// when it is back.
pub fn end(state: &Arc<DaemonState>, rec: &RemoteSub) {
    if rec.state == RemoteState::Ended {
        return;
    }
    let _ = records::update_state(&rec.sub_id, RemoteState::Ended);
    if let Err(e) = outbox::enqueue(&rec.machine_id, "sub_end", json!({ "sub_id": rec.sub_id })) {
        log::warn!("subchats: could not queue the end of {} for {}: {e}", rec.sub_id, rec.machine_id);
    }
    outbox::flush_in_background(state);
    crate::daemon::subchats::plumbing::clear(&rec.sub_id);
    settled(state, &rec.sub_id);
}
