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
                let subchats_on =
                    crate::sessions::chat_config::get(&p.session_id).is_some_and(|c| c.subchats_on);
                if let Some(reason) = crate::daemon::subchats::refusal_for_move(
                    &old,
                    subchats_on,
                    &p.target_account_id,
                    &crate::accounts::load_registry(),
                ) {
                    return Err(RpcError::invalid_params(reason));
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

                // A chat frozen by a usage limit wants its queued resume rather
                // than the restart's "continue". Its child usually outlives the
                // rejection, still on the exhausted account's config dir, so
                // it is killed first: the resume below then respawns on the
                // new account instead of being rejected again and re-freezing.
                // Any other chat's pending message is Joe's own schedule and
                // keeps its time. The claim (Pending -> Firing) keeps the
                // scheduler from firing the same resume during the kill wait;
                // a `None` means it already is.
                let pending_resume = old
                    .auto_frozen
                    .then(|| crate::sessions::scheduled_items::find_pending_message_for_session(&p.session_id))
                    .flatten()
                    .and_then(|item| crate::sessions::scheduled_items::claim_for_fire(&item.id).map(|_| item));
                if let Some(item) = pending_resume {
                    lifecycle::kill_and_wait_for_teardown(&state, &p.session_id).await;
                    if state.sessions.get(&p.session_id).is_some() {
                        // Still alive past the teardown wait: a send now would
                        // land on the exhausted account again. The chat stays
                        // frozen on its queued resume; the account is already
                        // the new one, so that resume (or Joe's next message,
                        // via `refresh_stale_launch`) respawns it there.
                        crate::sessions::scheduled_items::upsert(item);
                        state.registry.set_frozen(&p.session_id, true);
                        state.registry.set_auto_frozen(&p.session_id, true);
                        crate::daemon::machines::publish_instances_changed(&state);
                        crate::sessions::persistence::save_snapshot_default(&state.registry);
                        return Err(RpcError::internal(format!(
                            "session {}'s old process did not exit; it is on the new account and resumes there with its queued resume or your next message",
                            p.session_id
                        )));
                    }
                    crate::sessions::scheduled_items::delete(&item.id);
                    // Meta: the user already saw this text as their own bubble.
                    state.registry.set_busy(&p.session_id, true);
                    crate::sessions::chat_state::set_busy(&p.session_id, true);
                    if let Err(e) =
                        lifecycle::send_message_with_respawn(&state, &p.session_id, &item.prompt, true).await
                    {
                        state.registry.set_busy(&p.session_id, false);
                        crate::sessions::chat_state::set_busy(&p.session_id, false);
                        // The old child is gone, so the queued resume is the
                        // only thing left that brings this chat back: keep it.
                        crate::sessions::scheduled_items::upsert(item);
                        crate::daemon::machines::publish_instances_changed(&state);
                        crate::sessions::persistence::save_snapshot_default(&state.registry);
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

    /// Moves an auto-frozen chat with a live probe child and a queued resume,
    /// returning the move's error (the probe's cwd does not exist, so no
    /// `claude` ever starts), whether the old child was killed, the resume
    /// still queued afterwards, and whether the chat is still frozen. `exits`
    /// stands in for the pump: it drops the session from the map once the kill
    /// lands, as a real teardown does.
    #[cfg(windows)]
    async fn move_auto_frozen(exits: bool) -> (String, bool, Option<String>, bool) {
        let _guard = crate::util::env_lock();
        let dir = tempfile::tempdir().unwrap();
        std::env::set_var("CC_DATA_DIR", dir.path());

        let state = test_state();
        let (_child, session) =
            crate::daemon::lifecycle::probe::live_session(&state, "rl-1", ("opus", "high"), ("opus", "high"));
        state.registry.set_account("rl-1", "acct");
        state.registry.set_frozen("rl-1", true);
        state.registry.set_auto_frozen("rl-1", true);
        crate::sessions::scheduled_items::upsert(crate::sessions::scheduled_items::ScheduledItem::new(
            crate::sessions::scheduled_items::ScheduledKind::Message {
                session_id: "rl-1".into(),
                cwd: "Z:\\does\\not\\exist".into(),
            },
            "the prompt the limit rejected".into(),
            "2099-01-01T00:00:00Z".into(),
            None,
        ));
        if exits {
            let (s, sessions) = (session.clone(), state.sessions.clone());
            tokio::spawn(async move {
                while !s.expected_exit.load(std::sync::atomic::Ordering::SeqCst) {
                    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                }
                sessions.remove("rl-1");
            });
        }

        let err = try_move(&state, "rl-1").await.message;

        let inst = state.registry.get("rl-1").unwrap();
        assert_eq!(inst.account_id.as_deref(), Some("other-acct"));
        assert_eq!(inst.frozen, inst.auto_frozen, "a usage-limit freeze is always the auto kind");
        let killed = session.expected_exit.load(std::sync::atomic::Ordering::SeqCst);
        let kept = crate::sessions::scheduled_items::find_pending_message_for_session("rl-1").map(|i| i.prompt);
        std::env::remove_var("CC_DATA_DIR");
        (err, killed, kept, inst.frozen)
    }

    /// 2026-11-13, "frozen chats can't get unfrozen": a rate-limited chat's
    /// child outlives the rejection on the exhausted account. Moving it must
    /// clear the auto-freeze and replay its queued resume on a NEW child, never
    /// write it into the old one (which rejects it again and re-freezes).
    #[cfg(windows)]
    #[tokio::test]
    async fn moving_an_auto_frozen_chat_resumes_it_on_a_new_child() {
        let (err, killed, kept, frozen) = move_auto_frozen(true).await;
        assert!(!frozen, "the move must clear the usage-limit freeze");
        assert!(killed, "the queued resume went into the child still running on the exhausted account");
        assert!(err.contains("does not exist"), "the resume must reach a respawn on the new account: {err}");
        // That respawn failed (missing cwd) after the old child was killed: the
        // resume must stay queued, or nothing ever brings the chat back.
        assert_eq!(kept.as_deref(), Some("the prompt the limit rejected"));
    }

    /// An old child that outlives the teardown wait must not receive the
    /// resume: it would be rejected on the exhausted account again. The chat
    /// stays frozen on its queued resume, which now respawns on the new account.
    #[cfg(windows)]
    #[tokio::test]
    async fn a_move_whose_old_child_will_not_exit_keeps_the_resume_queued() {
        let (err, killed, kept, frozen) = move_auto_frozen(false).await;
        assert!(killed);
        assert!(err.contains("did not exit"), "{err}");
        assert_eq!(kept.as_deref(), Some("the prompt the limit rejected"));
        assert!(frozen, "nothing was sent, so the chat must stay frozen on its resume");
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
