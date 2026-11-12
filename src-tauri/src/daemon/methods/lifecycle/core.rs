//! The common turn-taking lifecycle RPCs: start/send/cancel/end a session.

use super::{err_to_rpc, start_session, SessionIdOnly};
use crate::daemon::lifecycle::{self, LifecycleError};
use crate::daemon::rpc::{Router, RpcError, Transport};
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
            start_session::start_session(state, params, ctx)
        });
    }
    {
        let map = map.clone();
        let state = state.clone();
        router.register("send_message", move |params, ctx| {
            let map = map.clone();
            let state = state.clone();
            async move {
                let p: SendMessageParams = serde_json::from_value(params.unwrap_or(Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                let live = map.get(&p.session_id).map(|s| s.clone());
                // A paired machine cannot do the desktop's -32004 dance: that
                // respawns on the CALLER's daemon, resuming the chat on the
                // wrong machine. So for a peer, this host revives its own idle
                // chat (cwd/model/effort/account from its registry, never the
                // caller's) and delivers the message, as its REST send route does.
                // Only for a chat this registry knows: an unknown id must stay a
                // plain NotFound, not seed busy/chat-state entries for it.
                let respawn_for_peer = live.is_none()
                    && matches!(ctx.transport, Transport::PeerMachine(_))
                    && state.registry.get(&p.session_id).is_some();
                // Ahead of the NotFound answer: that one makes the desktop respawn
                // and retry, which can only end in the same refusal one hop later.
                // Also ahead of the busy bump below, so a refusal latches nothing.
                lifecycle::refuse_if_api_credit_blocked(&state, &p.session_id).map_err(err_to_rpc)?;
                // A reply typed into a sub opened in the main chat's window. Ahead
                // of the NotFound answer below: a finished sub has no child, and the
                // desktop's resume-and-retry for that answer would bring it back
                // without clearing `subchat_finished` or its freeze.
                if let Some(done) = crate::daemon::subchats::route_send(&state, &p.session_id, &p.text).await {
                    return match done {
                        Ok(()) => Ok(json!({"ok": true})),
                        Err(crate::daemon::subchats::ContinueError::Send(e)) => Err(err_to_rpc(e)),
                        Err(e) => Err(RpcError::invalid_params(e.to_string())),
                    };
                }
                if live.is_none() && !respawn_for_peer {
                    return Err(err_to_rpc(LifecycleError::NotFound(p.session_id.clone())));
                }
                // A paired machine sending into a chat hosted here has no
                // desktop pipe to call `refresh_stale_launch` first, so the host
                // applies a pending model/effort pick itself. A local caller did
                // it already (and must re-attach to the new child). Ahead of the
                // busy refusal below so a parked-question chat takes the same
                // path as it does from the desktop.
                let live = if live.is_some() && matches!(ctx.transport, Transport::PeerMachine(_)) {
                    lifecycle::refresh_stale_launch(&state, &p.session_id).await;
                    map.get(&p.session_id).map(|s| s.clone())
                } else {
                    live
                };
                // The daemon is compacting this chat: Joe's message waits in the
                // compaction manager and goes out as his next turn when it ends
                // (`pump` hands it to `compaction::deliver_held`). Without this
                // it was refused as SESSION_BUSY like any mid-turn send.
                if live.is_some() && crate::daemon::subchats::compaction::hold_typed(&p.session_id, &p.text) {
                    return Ok(json!({"ok": true, "held": "compaction"}));
                }
                // Refusing beats writing into a live child: the bump
                // below would strand the running turn's own result line on the
                // old gen, latching `busy` until the 20-minute watchdog. After
                // the map lookup, so a dead child still gets its -32004 respawn.
                if live.is_some() {
                    lifecycle::refuse_if_busy(&state, &p.session_id).map_err(err_to_rpc)?;
                }
                // Bump turn_gen (set_busy) BEFORE the write - a warm child can
                // emit its first stream_event before this fn resumes past the
                // write's own .await (todo 525 root cause 1).
                let gen_before = state.registry.current_turn_gen(&p.session_id);
                // Past every refusal above, so a bounced send never settles a card.
                crate::daemon::methods::permission::settle_answered_questions(&state, &p.session_id, &p.text).await;
                state.registry.set_awaiting(&p.session_id, None);
                state.registry.set_busy(&p.session_id, true);
                log::info!(
                    "daemon: send_message {}: turn_gen {gen_before} -> {} before stdin write",
                    p.session_id,
                    state.registry.current_turn_gen(&p.session_id)
                );
                crate::sessions::chat_state::set_busy(&p.session_id, true);
                let sent = match &live {
                    Some(session) => lifecycle::send_message(session, &p.text, false).await,
                    None => lifecycle::send_message_with_respawn(&state, &p.session_id, &p.text, false).await,
                };
                if let Err(e) = sent {
                    state.registry.set_busy(&p.session_id, false);
                    crate::sessions::chat_state::set_busy(&p.session_id, false);
                    return Err(err_to_rpc(e));
                }
                crate::daemon::machines::publish_instances_changed(&state);
                // Jarvis wake (todo 272 chunk 3): the desktop's user-facing send
                // path (`ipc/chat/run.rs`); the phone has its own REST route
                // (`remote_handlers::send_message`), and Jarvis's `send_to_session`
                // bypasses this RPC entirely, so a hit here is Joe, never Jarvis.
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
                // The state at the moment of the interrupt, read before it lands:
                // a wedged chat's cancel is only diagnosable if the log says
                // whether the turn was still busy and what it had reported.
                let (busy, awaiting) = state
                    .registry
                    .get(&p.session_id)
                    .map_or((None, None), |i| (Some(i.busy), i.awaiting));
                log::info!(
                    "daemon: cancel_turn on session {} (busy={busy:?}, awaiting={awaiting:?})",
                    p.session_id
                );
                lifecycle::cancel_turn(&map, &p.session_id).await.map_err(err_to_rpc)?;
                // No force-clear here (todo 873): the interrupt is cooperative,
                // so only the child's own trailing result line - via pump.rs's
                // gen-matched set_busy_false_if_gen - should end the turn. An
                // eager clear let a racing send_message write into the still-live child.
                // Every subagent still running dies with the turn, and nothing
                // in the transcript says so - the tool results it was waiting
                // on just never arrive. Record them here, while the live set is
                // still the set that died; the next UserPromptSubmit names them
                // (`hooks_server::subagents`).
                state.record_subagents_killed_by_interrupt(&p.session_id);
                // Settle any AskUserQuestion/permission prompt still open for this
                // session (e.g. the user hit Skip on the question card, which now
                // routes through this same interrupt instead of answering the
                // hook). Drops the blocked hook oneshot(s) - so a still-alive hook
                // process resolves rather than hanging up to the 3600s prompt
                // ceiling - and clears the prompt record so `list_pending_prompts`
                // stops resurrecting the card. Mirrors the EOF-triggered "ghost
                // prompt" cleanup in `lifecycle.rs`'s pump loop; a no-op when
                // nothing is open for this session (the common Stop-turn case).
                //
                // The interrupted turn's verdict (a prior turn's "waiting") is
                // dead with the cancel, so `awaiting` clears - except that a
                // durable question card outlives the sweep and still needs
                // Joe, so it keeps "question" (see `settle_awaiting_after_cancel`).
                state.settle_awaiting_after_cancel(&p.session_id).await;
                // Same reasoning one level down (todo 933): a `write_plan` step
                // comment is keyed by step TEXT alone, so one still unclaimed
                // when its turn dies would be delivered against whatever
                // unrelated step a LATER turn happens to give the same text.
                // `pump::exit` already clears them on EOF, but the interrupt is
                // cooperative and keeps the child alive, so stdout never closes
                // and that teardown never runs for a cancelled turn.
                state.clear_step_comments(&p.session_id).await;
                crate::daemon::machines::publish_instances_changed(&state);
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
                // A main chat with running subs is not closed on a click: Joe is
                // asked on a card (menu Close, Ctrl+W, the phone and `/clear` all
                // arrive here), and the caller is told it was held.
                if crate::daemon::subchats::closing::request_close(&state, &p.session_id) {
                    return Ok(json!({"ok": true, "held": true}));
                }
                lifecycle::end_session(&map, &p.session_id).await.map_err(err_to_rpc)?;
                let now = chrono::Utc::now().to_rfc3339();
                state.registry.mark_ended(&p.session_id, EndReason::Manual, &now);
                crate::daemon::subchats::closing::settle_family(&state, &p.session_id).await;
                crate::daemon::machines::publish_instances_changed(&state);
                crate::sessions::persistence::save_snapshot_default(&state.registry);
                Ok(json!({"ok": true}))
            }
        });
    }
}

#[cfg(test)]
mod interrupt_cleanup_contract {
    /// `cancel_turn` interrupts cooperatively and keeps the child process
    /// alive, so stdout never hits EOF and `pump::exit` - the only other
    /// caller of `clear_step_comments` - never runs for an interrupted turn.
    /// A comment queued against step text a LATER turn happens to reuse would
    /// then be delivered against that unrelated step. Nothing in the type
    /// system ties the two teardown sites together, so the handler body is
    /// asserted directly, the same shape as the notifier-event registration
    /// contract guard.
    #[test]
    fn cancel_turn_clears_queued_step_comments() {
        let src = include_str!("core.rs");
        let after_register = src
            .split_once("router.register(\"cancel_turn\"")
            .expect("cancel_turn handler is registered in this file")
            .1;
        let handler_body = after_register
            .split_once("router.register(")
            .map(|(body, _)| body)
            .unwrap_or(after_register);
        assert!(
            handler_body.contains("clear_step_comments"),
            "cancel_turn must clear queued step comments, beside its \
             expire_prompts_for_session call"
        );
    }
}
