//! Session-lifecycle RPCs: mark-ended, externalize, set-effort, set-model,
//! freeze, unfreeze. Distinct from the top-level `daemon::methods::lifecycle`
//! module - this is `daemon::methods::registry::lifecycle`.

use crate::daemon::rpc::{Router, RpcError};
use crate::daemon::state::DaemonState;
use crate::types::EndReason;
use serde_json::{json, Value};
use std::sync::Arc;

/// Kill+respawn `session_id` so a launch-only swap applies now instead of
/// waiting for a natural restart. Model and effort are both launch-only CLI
/// flags; so is the account, which is the `CLAUDE_CONFIG_DIR` the child is
/// spawned under - hence `move_session_to_account` shares this too. Resumes
/// a busy/blocked session with "continue"; no-ops (returns `false`) if the
/// session isn't live (e.g. a not-yet-started draft, or a rate-limited chat
/// whose child is already gone).
pub(crate) async fn restart_live_session(state: &Arc<DaemonState>, caller: &str, session_id: &str) -> bool {
    if state.sessions.get(session_id).is_none() {
        return false;
    }
    let was_busy = state.registry.get(session_id).map(|i| i.busy).unwrap_or(false);
    let was_asked = state.list_prompts().await.iter()
        .any(|v| v["payload"]["session_id"].as_str() == Some(session_id));
    match crate::daemon::lifecycle::restart_session(state, session_id).await {
        Ok(_) => {
            if was_busy || was_asked {
                if let Err(e) = crate::daemon::lifecycle::send_message_with_respawn(
                    state, session_id, "continue", false,
                ).await {
                    log::warn!("{caller}: auto-continue failed for {session_id}: {e}");
                }
            }
            true
        }
        Err(e) => {
            log::warn!("{caller}: restart failed for {session_id}: {e}");
            false
        }
    }
}

pub fn register_lifecycle(router: &mut Router, state: Arc<DaemonState>) {
    #[derive(serde::Deserialize)]
    struct SessionId { session_id: String }
    #[derive(serde::Deserialize)]
    struct EffortParams { session_id: String, effort: String }
    #[derive(serde::Deserialize)]
    struct ModelParams { session_id: String, model: String }

    {
        let state = state.clone();
        router.register("mark_session_ended", move |params, _ctx| {
            let state = state.clone();
            async move {
                let p: SessionId = serde_json::from_value(params.unwrap_or(Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                let now = chrono::Utc::now().to_rfc3339();
                state.registry.mark_ended(&p.session_id, EndReason::Manual, &now);
                state.notifier.publish("instances_changed", json!({"instances": state.registry.list()}));
                crate::sessions::persistence::save_snapshot_default(&state.registry);
                Ok(json!({"ok": true}))
            }
        });
    }
    {
        let state = state.clone();
        router.register("externalize_session", move |params, _ctx| {
            let state = state.clone();
            async move {
                let p: SessionId = serde_json::from_value(params.unwrap_or(Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                state.registry.externalize_session(&p.session_id);
                state.notifier.publish("instances_changed", json!({"instances": state.registry.list()}));
                // Now External: drop it from the Interactive snapshot so a daemon
                // restart doesn't resurrect it as a ghost Interactive entry.
                crate::sessions::persistence::save_snapshot_default(&state.registry);
                Ok(json!({"ok": true}))
            }
        });
    }
    {
        let state = state.clone();
        router.register("set_session_effort", move |params, _ctx| {
            let state = state.clone();
            async move {
                let p: EffortParams = serde_json::from_value(params.unwrap_or(Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                state.registry.set_effort(&p.session_id, &p.effort);
                crate::sessions::chat_config::record(&p.session_id, "", &p.effort);

                // Effort is launch-only like model - restart so it actually
                // applies instead of silently no-op'ing on a live session.
                let restarted = restart_live_session(&state, "set_session_effort", &p.session_id).await;

                state.notifier.publish("instances_changed", json!({"instances": state.registry.list()}));
                crate::sessions::persistence::save_snapshot_default(&state.registry);
                Ok(json!({"ok": true, "restarted": restarted}))
            }
        });
    }
    {
        let state = state.clone();
        router.register("set_session_model", move |params, _ctx| {
            let state = state.clone();
            async move {
                let p: ModelParams = serde_json::from_value(params.unwrap_or(Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                state.registry.set_model(&p.session_id, &p.model);
                crate::sessions::chat_config::record(&p.session_id, &p.model, "");

                let restarted = restart_live_session(&state, "set_session_model", &p.session_id).await;

                state.notifier.publish("instances_changed", json!({"instances": state.registry.list()}));
                crate::sessions::persistence::save_snapshot_default(&state.registry);
                Ok(json!({"ok": true, "restarted": restarted}))
            }
        });
    }
    // Chat menu's "Freeze chat": force-kills the live child (if any) and
    // flips the frozen flag - never marks the session ended, so it keeps its
    // sidebar slot (new Frozen segment). Interactive-only; External/Automated
    // no-op + log, same shape as `externalize_session`'s guards.
    {
        let state = state.clone();
        router.register("freeze_session", move |params, _ctx| {
            let state = state.clone();
            async move {
                let p: SessionId = serde_json::from_value(params.unwrap_or(Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                let Some(inst) = state.registry.get(&p.session_id) else {
                    return Err(RpcError::invalid_params(format!("session {} not found", p.session_id)));
                };
                if !matches!(inst.kind, crate::sessions::kinds::InstanceKind::Interactive) {
                    log::warn!("freeze_session: {} is not Interactive (kind={:?}) - ignoring", p.session_id, inst.kind);
                    return Ok(json!({"ok": false}));
                }
                if inst.frozen {
                    return Ok(json!({"ok": true}));
                }
                // Same busy/asked signal `set_session_model` uses to decide the
                // kill cancelled real work, not just an already-idle process -
                // remembered so unfreeze knows to auto-continue.
                let was_busy = inst.busy;
                let was_asked = state.list_prompts().await.iter()
                    .any(|v| v["payload"]["session_id"].as_str() == Some(p.session_id.as_str()));
                crate::daemon::lifecycle::kill_and_wait_for_teardown(&state, &p.session_id).await;
                state.registry.set_frozen(&p.session_id, true);
                state.registry.set_frozen_needs_continue(&p.session_id, was_busy || was_asked);
                state.notifier.publish("instances_changed", json!({"instances": state.registry.list()}));
                crate::sessions::persistence::save_snapshot_default(&state.registry);
                Ok(json!({"ok": true}))
            }
        });
    }
    // Chat menu's "Unfreeze chat": clears frozen, then auto-sends "continue"
    // if a turn/prompt was cancelled by the freeze, so interrupted work
    // resumes. Clears frozen BEFORE that send - it may respawn, and
    // `spawn_session`'s frozen guard would otherwise refuse its own respawn.
    {
        let state = state.clone();
        router.register("unfreeze_session", move |params, _ctx| {
            let state = state.clone();
            async move {
                let p: SessionId = serde_json::from_value(params.unwrap_or(Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                let Some(inst) = state.registry.get(&p.session_id) else {
                    return Err(RpcError::invalid_params(format!("session {} not found", p.session_id)));
                };
                if !matches!(inst.kind, crate::sessions::kinds::InstanceKind::Interactive) {
                    log::warn!("unfreeze_session: {} is not Interactive (kind={:?}) - ignoring", p.session_id, inst.kind);
                    return Ok(json!({"ok": false}));
                }
                state.registry.set_frozen(&p.session_id, false);
                state.registry.set_auto_frozen(&p.session_id, false);
                if state.registry.take_frozen_needs_continue(&p.session_id) {
                    if let Err(e) = crate::daemon::lifecycle::send_message_with_respawn(
                        &state, &p.session_id, "continue", false,
                    ).await {
                        log::warn!("unfreeze_session: auto-continue failed for {}: {}", p.session_id, e);
                    }
                }
                state.notifier.publish("instances_changed", json!({"instances": state.registry.list()}));
                crate::sessions::persistence::save_snapshot_default(&state.registry);
                Ok(json!({"ok": true}))
            }
        });
    }
}
