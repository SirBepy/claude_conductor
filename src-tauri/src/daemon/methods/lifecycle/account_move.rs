//! `move_session_to_account` alone - it's the largest single handler (moves a
//! session onto a different account) and the most likely to grow further.

use super::err_to_rpc;
use crate::daemon::lifecycle;
use crate::daemon::rpc::{Router, RpcError};
use crate::daemon::state::DaemonState;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

#[derive(Debug, Deserialize)]
struct MoveSessionParams {
    session_id: String,
    target_account_id: String,
}

pub fn register_account_move(router: &mut Router, state: Arc<DaemonState>) {
    {
        let state = state.clone();
        router.register("move_session_to_account", move |params, _ctx| {
            let state = state.clone();
            async move {
                let p: MoveSessionParams = serde_json::from_value(params.unwrap_or(Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                let old = state.registry.get(&p.session_id).ok_or_else(|| {
                    RpcError::invalid_params(format!("session {} not found", p.session_id))
                })?;
                // Jarvis's own id/account bookkeeping (and its worker_of
                // ownership tracking) assumes a fleet-owned session's id and
                // account don't change out from under it - block the
                // human-facing move rather than let it through (todo 441).
                if old.jarvis || old.worker_of.is_some() {
                    return Err(RpcError::invalid_params(format!(
                        "session {} is Jarvis-owned and cannot be moved to another account",
                        p.session_id
                    )));
                }
                if old.account_id.as_deref() == Some(p.target_account_id.as_str()) {
                    return Err(RpcError::invalid_params(format!(
                        "session {} is already on account {}",
                        p.session_id, p.target_account_id
                    )));
                }

                // In place: JUNCTION_DIRS pools every account's `projects/`.
                state.registry.set_account(&p.session_id, &p.target_account_id);
                crate::sessions::chat_config::set_account(&p.session_id, &p.target_account_id);
                if old.auto_frozen {
                    state.registry.set_frozen(&p.session_id, false);
                    state.registry.set_auto_frozen(&p.session_id, false);
                }

                // A blocked chat has no live child, and wants its queued
                // resume rather than the restart's "continue".
                let pending_resume =
                    crate::sessions::scheduled_items::find_pending_message_for_session(&p.session_id);
                if let Some(item) = pending_resume {
                    crate::sessions::scheduled_items::delete(&item.id);
                    // Meta: the user already saw this text as their own bubble.
                    state.registry.set_busy(&p.session_id, true);
                    crate::sessions::chat_state::set_busy(&p.session_id, true);
                    if let Err(e) =
                        lifecycle::send_message_with_respawn(&state, &p.session_id, &item.prompt, true).await
                    {
                        state.registry.set_busy(&p.session_id, false);
                        crate::sessions::chat_state::set_busy(&p.session_id, false);
                        return Err(err_to_rpc(e));
                    }
                    state.notifier.publish(
                        "scheduled_items_changed",
                        json!({"items": crate::sessions::scheduled_items::list()}),
                    );
                } else {
                    // Launch-only like model/effort: same restart+auto-continue.
                    crate::daemon::methods::registry::lifecycle::restart_live_session(
                        &state, "move_session_to_account", &p.session_id,
                    ).await;
                }

                crate::daemon::machines::publish_instances_changed(&state);
                crate::sessions::persistence::save_snapshot_default(&state.registry);
                Ok(json!({"session_id": p.session_id}))
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::rpc::{ConnectionContext, Request};
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::types::Settings;

    fn test_state() -> Arc<DaemonState> {
        DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()))
    }

    fn dummy_ctx() -> ConnectionContext {
        let (tx, _rx) = tokio::sync::mpsc::channel(16);
        ConnectionContext::new(tx)
    }

    async fn try_move(state: &Arc<DaemonState>, session_id: &str) -> RpcError {
        let mut router = Router::new();
        register_account_move(&mut router, state.clone());
        let req = Request {
            jsonrpc: "2.0".into(),
            id: json!(1),
            method: "move_session_to_account".into(),
            params: Some(json!({"session_id": session_id, "target_account_id": "other-acct"})),
        };
        router.dispatch(req, dummy_ctx()).await.error.expect("expected rejection")
    }

    #[tokio::test]
    async fn move_session_to_account_rejects_jarvis_singleton() {
        let state = test_state();
        state.registry.upsert_interactive("jv-1", std::path::Path::new("."), "proj", "2026-08-12T00:00:00Z");
        state.registry.set_jarvis("jv-1", true);

        let err = try_move(&state, "jv-1").await;
        assert!(err.message.contains("Jarvis-owned"), "{}", err.message);
    }

    #[tokio::test]
    async fn move_session_to_account_rejects_worker_of_session() {
        let state = test_state();
        state.registry.upsert_interactive("worker-1", std::path::Path::new("."), "proj", "2026-08-12T00:00:00Z");
        state.registry.set_worker_of("worker-1", Some("jv-1".to_string()));

        let err = try_move(&state, "worker-1").await;
        assert!(err.message.contains("Jarvis-owned"), "{}", err.message);
    }
}
