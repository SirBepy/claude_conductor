//! The `start_session` RPC: spawn a chat here, or forward the spawn to the paired
//! machine that `machine_id` names.

use super::err_to_rpc;
use crate::daemon::lifecycle::{self, StartSessionParams};
use crate::daemon::machines::forward::map_peer_err;
use crate::daemon::methods::pr_review::is_known_cwd;
use crate::daemon::rpc::{ConnectionContext, RpcError, Transport};
use crate::daemon::state::DaemonState;
use serde_json::{json, Value};
use std::sync::Arc;

/// An account refusal from the host, prefixed with the host's name: the
/// caller's picker listed that machine's accounts, so "account X not found"
/// alone would read as a problem on this machine.
pub(super) fn name_host_on_account_refusal(e: crate::daemon::machines::PeerError, host_label: &str) -> RpcError {
    match e {
        crate::daemon::machines::PeerError::Rejected { code, message } if message.starts_with("account ") => {
            RpcError { code: code as i32, message: format!("{host_label}: {message}"), data: None }
        }
        other => map_peer_err(other),
    }
}

/// `start_session`'s `machine_id` branch (D3): forwards to that peer's own
/// `start_session` with `machine_id` stripped (the peer has no use for it -
/// it always spawns locally) and returns its result verbatim. `account_id`
/// is passed through untouched: the new-chat picker listed the HOST's
/// accounts for a peer target (`list_machine_accounts`), so the id is the
/// host's own and the host's normal account resolution is the authority. The
/// mirror
/// delivers the new row via the peer's own `instances_changed` broadcast, so
/// no local publish is needed here.
pub(super) async fn forward_start_session(
    state: &Arc<DaemonState>,
    machine_id: &str,
    mut params_value: Value,
) -> Result<Value, RpcError> {
    let registry = state
        .machines
        .get()
        .ok_or_else(|| RpcError::invalid_params("machine registry not initialised"))?;
    let peer = registry
        .peer(machine_id)
        .ok_or_else(|| RpcError::invalid_params(format!("unknown machine: {machine_id}")))?;
    crate::daemon::machines::forward::require_online(state, &peer).await?;
    if let Some(obj) = params_value.as_object_mut() {
        obj.remove("machine_id");
    }
    let client = crate::daemon::machines::client_for(state, &peer).await.map_err(map_peer_err)?;
    let result = client
        .call("start_session", params_value)
        .await
        .map_err(|e| name_host_on_account_refusal(e, &peer.label))?;
    // The peer's own `instances_changed` broadcast can take up to one
    // mirror-link cycle to report the chat it just spawned for us, so a
    // caller's immediate follow-up `attach_session`/`send_message` would
    // find no mirrored row yet. Record the id as pending-owned right away so
    // `MirrorState::owner_of` resolves it before that first frame arrives.
    if let Some(sid) = result.get("session_id").and_then(Value::as_str) {
        state.mirror.record_pending(sid, machine_id);
    }
    Ok(result)
}

/// Refuses a `start_session` that would spawn a peer-hosted chat on THIS
/// machine: its transcript and folder live on the host, so a local resume (or
/// a fork of it) can only fail, or worse start a second diverging copy. Hosted
/// there means `machines::mirrored_owner` (local registry first, then the
/// live mirror, then the persisted ownership record).
pub(super) fn refuse_peer_hosted(state: &DaemonState, p: &StartSessionParams) -> Option<RpcError> {
    for id in [p.resume_id.as_deref(), p.new_session_id.as_deref()].into_iter().flatten() {
        let Some(machine_id) = crate::daemon::machines::mirrored_owner(state, id) else { continue };
        let label = crate::daemon::machines::forward::peer_label(state, &machine_id);
        return Some(RpcError {
            code: crate::daemon::machines::forward::ERR_NOT_FORWARDABLE,
            message: format!("chat {id} is hosted on {label}; it cannot be started on this machine"),
            data: None,
        });
    }
    None
}

/// A peer resuming one of our chats arrives with `account_id` stripped
/// (`forward_start_session`), so our own registry's binding wins; otherwise the
/// resume would silently rebind the chat to this daemon's default account.
pub(super) fn bind_remote_resume_account(state: &DaemonState, transport: &Transport, p: &mut StartSessionParams) {
    if matches!(transport, Transport::Local) {
        return;
    }
    if let Some(account) = p.resume_id.as_deref().and_then(|id| state.registry.get(id)).and_then(|i| i.account_id) {
        p.account_id = Some(account);
    }
}

pub(super) async fn start_session(
    state: Arc<DaemonState>,
    params: Option<Value>,
    ctx: ConnectionContext,
) -> Result<Value, RpcError> {
    let params_value = params.unwrap_or(Value::Null);
    // Multi-machine federation: a `machine_id` naming a DIFFERENT
    // machine than us means "spawn this chat over there" - forward
    // whole-cloth rather than falling through to the local spawn
    // path below. Absent, or naming ourselves (no registry, or a
    // registry that just hasn't minted a self id yet, both count
    // as "must be us" since a real peer id can never match None),
    // means the existing local behavior, unchanged.
    let requested_machine =
        params_value.get("machine_id").and_then(Value::as_str).map(str::to_string);
    if let Some(target) = requested_machine {
        if !crate::daemon::machines::is_self_machine(&state, &target) {
            return forward_start_session(&state, &target, params_value).await;
        }
    }
    // Persist before the RPC returns, not via a client follow-up call -
    // a network-latency caller's own send_message can otherwise race
    // ahead of it (same pattern move_session_to_account guards against).
    let auto_accept = params_value.get("auto_accept").and_then(Value::as_bool).unwrap_or(false);
    // "Use subchats" from the first spawn: a flip after the spawn
    // reaches a live child only at its next respawn, too late for
    // the first turn. Forwarded to a peer untouched (only
    // `machine_id` is stripped), which then applies it itself.
    let subchats_on = params_value.get("subchats_on").and_then(Value::as_bool).unwrap_or(false);
    // Idempotency key: the placeholder id is the one value that
    // survives the caller's retry (`daemon::start_tokens`). Absent
    // for schedules and resumes - those spawn as before.
    let token = params_value
        .get("placeholder_id")
        .and_then(Value::as_str)
        .map(str::to_string);
    let mut p: StartSessionParams = serde_json::from_value(params_value)
        .map_err(|e| RpcError::invalid_params(e.to_string()))?;
    // After the `machine_id` forward above, so a start aimed at the
    // host still reaches it; this only stops a LOCAL spawn.
    if let Some(refusal) = refuse_peer_hosted(&state, &p) {
        return Err(refusal);
    }
    // A phone or peer may only start agents inside a registered
    // project (or one of its worktrees), not in `C:\` or the home
    // folder; `create_project_folder` is their way to add one. The
    // desktop and daemon-internal spawns (Local) are unrestricted.
    // Checked before the idempotency claim so a refusal records nothing.
    if !matches!(ctx.transport, Transport::Local)
        && !is_known_cwd(&state, &p.cwd.to_string_lossy())
    {
        return Err(RpcError::invalid_params("unknown cwd".to_string()));
    }
    bind_remote_resume_account(&state, &ctx.transport, &mut p);
    let cwd = p.cwd.clone();
    let model = p.model.clone();
    let effort = p.effort.clone();
    // Point of truth for the "Remote" sidebar segment: this RPC is the
    // one path the phone cockpit's new-chat/composer flow spawns
    // through (see remote_handlers.rs), so ctx.remote is set exactly
    // when the request actually arrived over that surface.
    let is_remote = ctx.remote;
    // Held across the spawn, so a racing retry waits for it.
    let mut claim = match token.as_deref() {
        Some(t) => Some(state.start_tokens.claim(t).await),
        None => None,
    };
    let already = claim.as_ref().and_then(|c| c.existing()).map(str::to_string);
    // A recorded id whose child is gone is not reusable.
    if let Some(sid) = already.filter(|sid| state.sessions.contains_key(sid)) {
        log::info!(
            "daemon: start_session token {} already spawned {sid}; returning it",
            token.as_deref().unwrap_or("")
        );
        return Ok(json!({"session_id": sid}));
    }
    // The mode is persisted under the id the child is about to get, so
    // `lifecycle::spawn` finds it when it builds argv. A plain resume
    // keeps its own id, and a mode flip on an existing chat is
    // `set_subchats_on`'s job (it also guards the sub case).
    let mode_sid = if subchats_on {
        if p.resume_id.is_some() && !p.fork {
            return Err(RpcError::invalid_params(
                "subchats_on only applies to a new chat, not a plain resume".to_string(),
            ));
        }
        let sid = p.new_session_id.get_or_insert_with(|| uuid::Uuid::new_v4().to_string()).clone();
        crate::daemon::subchats::prepare_new_main(
            &state,
            &sid,
            p.account_id.as_deref(),
            &crate::accounts::load_registry(),
            crate::sessions::chat_config::set_subchats_on,
        )?;
        Some(sid)
    } else {
        None
    };
    let spawned = lifecycle::spawn_session(&state, p).await;
    if spawned.is_err() {
        if let Some(sid) = mode_sid.as_deref() {
            // Nothing spawned, so no chat should be left holding the mode.
            crate::sessions::chat_config::set_subchats_on(sid, false);
            crate::daemon::subchats::publish_mode_changed(&state);
        }
    }
    let session = spawned.map_err(err_to_rpc)?;
    let sid = session.session_id.clone();
    if let Some(c) = claim.as_mut() {
        c.record(&sid);
    }
    let account_id = session.account_id.clone();
    let now = chrono::Utc::now().to_rfc3339();
    crate::daemon::session_registration::register_new_session(
        &state, &sid, &cwd, &model, &effort, &account_id, &now, auto_accept, None, is_remote,
    );
    // Deliberately NOT set_busy(true) here: no turn is in flight yet
    // (claude emits nothing until its first stdin message, so the
    // pump can never clear a busy set now). The caller's follow-up
    // send_message sets busy the moment a real turn starts. Setting
    // it at spawn left a started-but-never-messaged session busy
    // forever, deferring scheduled messages into it until they went
    // Missed and spinning the sidebar indefinitely (ai_todo 212).
    crate::daemon::machines::publish_instances_changed(&state);
    crate::sessions::persistence::save_snapshot_default(&state.registry);
    Ok(json!({"session_id": sid}))
}
