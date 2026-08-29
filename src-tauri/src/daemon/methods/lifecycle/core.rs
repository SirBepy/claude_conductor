//! The common turn-taking lifecycle RPCs: start/send/cancel/end a session.

use super::{err_to_rpc, SessionIdOnly};
use crate::daemon::lifecycle::{self, LifecycleError, StartSessionParams};
use crate::daemon::rpc::{Router, RpcError};
use crate::daemon::state::DaemonState;
use crate::types::EndReason;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

#[derive(Debug, Deserialize)]
struct SendMessageParams {
    session_id: String,
    text: String,
}

pub fn register_core(router: &mut Router, state: Arc<DaemonState>) {
    let map = state.sessions.clone();
    {
        let state = state.clone();
        router.register("start_session", move |params, ctx| {
            let state = state.clone();
            async move {
                let params_value = params.unwrap_or(Value::Null);
                // Persist before the RPC returns, not via a client follow-up call -
                // a network-latency caller's own send_message can otherwise race
                // ahead of it (same pattern move_session_to_account guards against).
                let auto_accept = params_value.get("auto_accept").and_then(Value::as_bool).unwrap_or(false);
                // Idempotency key: the placeholder id is the one value that
                // survives the caller's retry (`daemon::start_tokens`). Absent
                // for channels, schedules and resumes - those spawn as before.
                let token = params_value
                    .get("placeholder_id")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let p: StartSessionParams = serde_json::from_value(params_value)
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
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
                let session = lifecycle::spawn_session(&state, p).await.map_err(err_to_rpc)?;
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
                state.notifier.publish("instances_changed", json!({"instances": state.registry.list()}));
                crate::sessions::persistence::save_snapshot_default(&state.registry);
                Ok(json!({"session_id": sid}))
            }
        });
    }
    {
        let map = map.clone();
        let state = state.clone();
        router.register("send_message", move |params, _ctx| {
            let map = map.clone();
            let state = state.clone();
            async move {
                let p: SendMessageParams = serde_json::from_value(params.unwrap_or(Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                let session = map.get(&p.session_id)
                    .ok_or_else(|| err_to_rpc(LifecycleError::NotFound(p.session_id.clone())))?
                    .clone();
                // Bump turn_gen (set_busy) BEFORE the write - a warm child can
                // emit its first stream_event before this fn resumes past the
                // write's own .await (todo 525 root cause 1).
                let gen_before = state.registry.current_turn_gen(&p.session_id);
                state.registry.set_awaiting(&p.session_id, None);
                state.registry.set_busy(&p.session_id, true);
                log::info!(
                    "daemon: send_message {}: turn_gen {gen_before} -> {} before stdin write",
                    p.session_id,
                    state.registry.current_turn_gen(&p.session_id)
                );
                crate::sessions::chat_state::set_busy(&p.session_id, true);
                if let Err(e) = lifecycle::send_message(&session, &p.text, false).await {
                    state.registry.set_busy(&p.session_id, false);
                    crate::sessions::chat_state::set_busy(&p.session_id, false);
                    return Err(err_to_rpc(e));
                }
                state.notifier.publish("instances_changed", json!({"instances": state.registry.list()}));
                // Jarvis wake (todo 272 chunk 3): this is the one user-facing send
                // path both desktop (`ipc/chat/run.rs`) and the remote/phone
                // cockpit (`http-transport.ts`'s `/api/rpc` "send_message") funnel
                // through - Jarvis's own `send_to_session` bypasses this RPC
                // entirely (see `methods::jarvis::send_to_session`), so a hit here
                // is by construction Joe (or a paired device), never Jarvis itself.
                // Tell Jarvis when Joe messages one of its workers directly so it
                // doesn't keep orchestrating a fleet member Joe just took over.
                if let Some(inst) = state.registry.get(&p.session_id) {
                    if let Some(jarvis_id) = inst.worker_of.clone() {
                        let display_name = inst.name.clone().unwrap_or_else(|| p.session_id.clone());
                        crate::daemon::jarvis_wake::enqueue(
                            &state,
                            &jarvis_id,
                            format!("[fleet] Joe messaged worker \"{display_name}\" directly"),
                        );
                        crate::daemon::jarvis_wake::drain(&state, &jarvis_id).await;
                    }
                }
                Ok(json!({"ok": true}))
            }
        });
    }
    {
        let map = map.clone();
        let state = state.clone();
        router.register("cancel_turn", move |params, _ctx| {
            let map = map.clone();
            let state = state.clone();
            async move {
                let p: SessionIdOnly = serde_json::from_value(params.unwrap_or(Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                lifecycle::cancel_turn(&map, &p.session_id).await.map_err(err_to_rpc)?;
                state.registry.set_busy(&p.session_id, false);
                crate::sessions::chat_state::set_busy(&p.session_id, false);
                // The interrupted turn's verdict (an AUQ's "question", a prior
                // turn's "waiting") is dead with the cancel - clear it so the
                // sidebar doesn't keep flagging a question nobody is asking.
                state.registry.set_awaiting(&p.session_id, None);
                // Settle any AskUserQuestion/permission prompt still open for this
                // session (e.g. the user hit Skip on the question card, which now
                // routes through this same interrupt instead of answering the
                // hook). Drops the blocked hook oneshot(s) - so a still-alive hook
                // process resolves rather than hanging up to the 3600s prompt
                // ceiling - and clears the prompt record so `list_pending_prompts`
                // stops resurrecting the card. Mirrors the EOF-triggered "ghost
                // prompt" cleanup in `lifecycle.rs`'s pump loop; a no-op when
                // nothing is open for this session (the common Stop-turn case).
                state.expire_prompts_for_session(&p.session_id).await;
                state.notifier.publish("instances_changed", json!({"instances": state.registry.list()}));
                Ok(json!({"ok": true}))
            }
        });
    }
    {
        let map = map.clone();
        let state = state.clone();
        router.register("end_session", move |params, _ctx| {
            let map = map.clone();
            let state = state.clone();
            async move {
                let p: SessionIdOnly = serde_json::from_value(params.unwrap_or(Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                lifecycle::end_session(&map, &p.session_id).await.map_err(err_to_rpc)?;
                let now = chrono::Utc::now().to_rfc3339();
                state.registry.mark_ended(&p.session_id, EndReason::Manual, &now);
                state.notifier.publish("instances_changed", json!({"instances": state.registry.list()}));
                crate::sessions::persistence::save_snapshot_default(&state.registry);
                Ok(json!({"ok": true}))
            }
        });
    }
}
