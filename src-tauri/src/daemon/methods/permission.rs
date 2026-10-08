//! Permission/question responder RPC methods. The app calls these to resolve
//! the pending oneshot channels that the hooks server is blocking on while it
//! waits for a user decision.
//!
//! Both responders tolerate GHOST prompts: if the session's `claude -p` child
//! died while the prompt was open, its hook `curl` died with it and axum
//! dropped the blocked handler future on client disconnect - so the handler's
//! own post-await cleanup (remove_prompt + awaiting clear) never ran. The
//! prompt record then kept resurrecting the card on every
//! `list_pending_prompts` poll, and answering it hit "unknown request_id" and
//! changed nothing: the row sat on "Input Needed" forever. Answering any
//! prompt - live or ghost - now always tears the record down and settles the
//! registry state.

use crate::daemon::rpc::{Router, RpcError};
use crate::daemon::state::DaemonState;
use std::sync::Arc;

/// Shared tail of both responders: drop the prompt record (ghost or live) and,
/// for question prompts, clear a lingering `awaiting == "question"` and tell
/// every window. `clear_awaiting` is false for permission prompts - they never
/// set `awaiting`, and a coincident real question from another prompt must
/// survive a permission answer.
async fn settle_prompt(state: &Arc<DaemonState>, request_id: &str, clear_awaiting: bool) {
    let session_id = state.prompt_session_id(request_id).await;
    state.remove_prompt(request_id).await;
    if !clear_awaiting {
        return;
    }
    if let Some(sid) = session_id.as_deref() {
        // Gated on no OTHER open question for this session (todo 897): the
        // record for `request_id` was already removed above, so this check
        // only sees genuine siblings, not itself.
        if state.clear_question_awaiting_if_no_others_pending(sid).await {
            state.notifier.publish(
                "instances_changed",
                serde_json::json!({"instances": state.registry.list()}),
            );
        }
    }
}

/// Core of `respond_permission`, factored out so the Jarvis `respond_worker_prompt`
/// route (`daemon::methods::jarvis::respond_worker_prompt`) can answer a
/// worker's permission prompt without going through the RPC `Router` (the
/// hooks-server handlers that route works don't have a `Router`/`ConnectionContext`
/// to dispatch through - see `hooks_server::jarvis`). Returns whether a live
/// waiter was actually resolved (`false` for a ghost/unknown request_id, same
/// as the RPC handler below).
pub(crate) async fn respond_permission_inner(
    state: &Arc<DaemonState>,
    request_id: &str,
    allow: bool,
    updated_input: Option<serde_json::Value>,
    message: Option<String>,
) -> bool {
    let tx = state.pending.lock().await.remove(request_id);
    let delivered = match tx {
        Some(tx) => {
            let payload = if allow {
                serde_json::json!({
                    "behavior": "allow",
                    "updatedInput": updated_input.unwrap_or(serde_json::Value::Object(Default::default())),
                })
            } else {
                serde_json::json!({
                    "behavior": "deny",
                    "message": message.unwrap_or_default(),
                })
            };
            let _ = tx.send(payload);
            true
        }
        None => false,
    };
    settle_prompt(state, request_id, false).await;
    delivered
}

/// Records a Skip in `companion.db` so scrollback can still show the card as
/// dismissed after a reopen. Nothing is ever written to Claude's transcript
/// JSONL for a skip (by design - the model's context stays clean), so this row
/// is the only durable trace. `question_id` is the prompt/tool_use id, so the
/// mark lands on the card that was actually dismissed even with several open.
/// Warn-and-skip on any failure, never fatal.
fn record_skip(state: &Arc<DaemonState>, session_id: &str, question_id: &str) {
    let Some(db) = state.db.as_ref() else {
        log::warn!("daemon: companion.db unavailable; dropping skipped-question mark");
        return;
    };
    let mgr = db.lock().unwrap_or_else(|p| p.into_inner());
    let ts = chrono::Utc::now().timestamp_millis();
    if let Err(e) = crate::storage::skipped_question_store::insert_skip(
        mgr.conn(), session_id, ts, Some(question_id),
    ) {
        log::warn!("daemon: insert_skip failed: {e:#}");
    }
}

/// Core of `respond_question`, factored out for the same reason as
/// `respond_permission_inner` above.
///
/// `skipped` distinguishes a real Skip from an empty-but-real answer. Nothing
/// reaches the model, so the live notification below is paired with a durable
/// `skipped_questions` row for scrollback (todo 661).
pub(crate) async fn respond_question_inner(
    state: &Arc<DaemonState>,
    request_id: &str,
    answers: serde_json::Value,
    skipped: bool,
) -> bool {
    let session_id = state.prompt_session_id(request_id).await;
    let tx = state.pending.lock().await.remove(request_id);
    let delivered = match tx {
        Some(tx) => {
            let _ = tx.send(serde_json::json!({"answers": answers}));
            true
        }
        None => false,
    };
    settle_prompt(state, request_id, true).await;
    if skipped {
        if let Some(sid) = session_id.as_deref() {
            record_skip(state, sid, request_id);
        }
        if let Some(session) = session_id.as_deref().and_then(|sid| state.sessions.get(sid).map(|s| s.clone())) {
            crate::daemon::broadcast::publish(&session, crate::types::chat::ChatEvent::Notification {
                kind: "question_skipped".into(),
                body: String::new(),
            });
        }
    }
    delivered
}

pub fn register_responders(router: &mut Router, state: Arc<DaemonState>) {
    {
        let state = state.clone();
        router.register("respond_permission", move |params, _ctx| {
            let state = state.clone();
            async move {
                #[derive(serde::Deserialize)]
                struct Body {
                    request_id: String,
                    allow: bool,
                    #[serde(default)] updated_input: Option<serde_json::Value>,
                    #[serde(default)] message: Option<String>,
                }
                let b: Body = serde_json::from_value(params.unwrap_or(serde_json::Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                let delivered = respond_permission_inner(&state, &b.request_id, b.allow, b.updated_input, b.message).await;
                Ok(serde_json::json!({"ok": true, "delivered": delivered}))
            }
        });
    }
    {
        let state = state.clone();
        router.register("list_pending_prompts", move |_params, ctx| {
            let state = state.clone();
            // Reliable poll path: the app fetches open prompts over RPC instead
            // of relying on the lossy notifier broadcast (which silently dropped
            // question_request frames and hung AskUserQuestion turns).
            async move {
                let mut prompts = state.list_prompts().await;
                // Merge in every paired peer's mirrored prompts - EXCEPT
                // when the caller is itself a peer machine (`Transport::PeerMachine`).
                // One-hop rule, same guard `MirrorState::instances`/`set_instances`
                // already enforce for session rows: a peer must only ever see
                // OUR own local prompts, never a prompt we ourselves mirrored
                // from a third machine, or two paired peers could echo the
                // same prompt back and forth past one hop.
                if !matches!(ctx.transport, crate::daemon::rpc::Transport::PeerMachine(_)) {
                    prompts.extend(state.mirror.prompts());
                }
                Ok(serde_json::Value::Array(prompts))
            }
        });
    }
    {
        let state = state.clone();
        // Deliberately NOT folded into the paginated history stream (todo 661
        // decision): a cheap point query the client fetches once per session
        // attach, so `history_page.rs`'s byte-offset cursor math is untouched.
        router.register("get_skipped_question_marks", move |params, _ctx| {
            let state = state.clone();
            async move {
                #[derive(serde::Deserialize)]
                struct Body {
                    session_id: String,
                }
                let b: Body = serde_json::from_value(params.unwrap_or(serde_json::Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                let marks = match state.db.as_ref() {
                    Some(db) => {
                        let mgr = db.lock().unwrap_or_else(|p| p.into_inner());
                        crate::storage::skipped_question_store::get_skips(mgr.conn(), &b.session_id)
                            .unwrap_or_else(|e| {
                                log::warn!("daemon: get_skips failed: {e:#}");
                                Vec::new()
                            })
                    }
                    None => Vec::new(),
                };
                Ok(serde_json::json!(marks))
            }
        });
    }
    {
        let state = state.clone();
        // Resolves the render-confirmation waiter `on_question_request`
        // races against a timeout (todo 735) - DISTINCT from `respond_question`
        // below, which only resolves once the user submits a real answer.
        router.register("confirm_question_rendered", move |params, _ctx| {
            let state = state.clone();
            async move {
                #[derive(serde::Deserialize)]
                struct Body {
                    id: String,
                    // A mirrored-chat client has no other way to name
                    // which session this prompt id belongs to; unused for
                    // local routing (`confirm_question_rendered` keys on
                    // `id` alone), but present so `forward.rs::extract_session_id`
                    // can read it generically off the raw params and route
                    // the call to the owning peer for a mirrored chat.
                    #[serde(default)]
                    session_id: Option<String>,
                }
                let b: Body = serde_json::from_value(params.unwrap_or(serde_json::Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                log::trace!("confirm_question_rendered: id={} session_id={:?}", b.id, b.session_id);
                state.confirm_question_rendered(&b.id).await;
                Ok(serde_json::json!({"ok": true}))
            }
        });
    }
    router.register("respond_question", move |params, _ctx| {
        let state = state.clone();
        async move {
            #[derive(serde::Deserialize)]
            struct Body {
                request_id: String,
                answers: serde_json::Value,
                #[serde(default)]
                skipped: bool,
            }
            let b: Body = serde_json::from_value(params.unwrap_or(serde_json::Value::Null))
                .map_err(|e| RpcError::invalid_params(e.to_string()))?;
            let delivered = respond_question_inner(&state, &b.request_id, b.answers, b.skipped).await;
            Ok(serde_json::json!({"ok": true, "delivered": delivered}))
        }
    });
}

#[cfg(test)]
mod list_pending_prompts_tests {
    use super::*;
    use crate::daemon::rpc::{ConnectionContext, Request, Router, Transport, TRANSPORT};
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::types::Settings;
    use serde_json::json;

    async fn dispatch_with(state: Arc<DaemonState>, transport: Transport) -> serde_json::Value {
        let mut r = Router::new();
        register_responders(&mut r, state);
        let (tx, _rx) = tokio::sync::mpsc::channel(16);
        let ctx = TRANSPORT.scope(transport, async { ConnectionContext::new(tx) }).await;
        let resp = r
            .dispatch(
                Request { jsonrpc: "2.0".into(), id: json!(1), method: "list_pending_prompts".into(), params: None },
                ctx,
            )
            .await;
        resp.result.expect("list_pending_prompts must not error")
    }

    /// A session mirrored from a paired peer has its question/permission
    /// cards cached in `MirrorState` (by `peer_link`) rather than in this
    /// daemon's own `pending_prompts` - `list_pending_prompts` must merge
    /// both so a client never needs to know which machine actually hosts a
    /// prompt it's polling for.
    #[tokio::test]
    async fn merges_local_and_mirrored_prompts() {
        let state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        state.add_prompt("local-1", "question-requested", json!({"session_id": "s-local"}), true).await;
        state.mirror.set_instances("mach-b", "Mac Mini", vec![]);
        state.mirror.set_prompts("mach-b", vec![json!({"id": "mirrored-1", "event": "question-requested", "payload": {"session_id": "s-remote"}, "durable": true})]);

        let result = dispatch_with(state, Transport::Local).await;
        let ids: Vec<&str> = result.as_array().unwrap().iter().map(|p| p["id"].as_str().unwrap()).collect();
        assert_eq!(ids.len(), 2, "expected both the local and the mirrored prompt: {ids:?}");
        assert!(ids.contains(&"local-1"));
        assert!(ids.contains(&"mirrored-1"));
    }

    /// One-hop rule: a peer machine calling `list_pending_prompts` on
    /// us (e.g. because IT mirrors a session WE host) must see only our own
    /// local prompts - re-exporting a prompt we ourselves mirrored from a
    /// THIRD machine would let two paired peers echo it back and forth.
    #[tokio::test]
    async fn excludes_mirrored_prompts_for_a_peer_machine_caller() {
        let state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        state.add_prompt("local-1", "question-requested", json!({"session_id": "s-local"}), true).await;
        state.mirror.set_instances("mach-b", "Mac Mini", vec![]);
        state.mirror.set_prompts("mach-b", vec![json!({"id": "mirrored-1", "event": "question-requested", "payload": {"session_id": "s-remote"}, "durable": true})]);

        let result = dispatch_with(state, Transport::PeerMachine("mach-c".into())).await;
        let ids: Vec<&str> = result.as_array().unwrap().iter().map(|p| p["id"].as_str().unwrap()).collect();
        assert_eq!(ids, vec!["local-1"], "a peer caller must never see a prompt we mirrored from someone else");
    }
}
