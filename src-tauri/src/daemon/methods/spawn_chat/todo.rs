//! "Start a chat on it" from the Backlog panel: a new chat in a registered
//! project whose first message is `Do todo <id>`. Desktop pipe only: the method
//! is absent from `remote_transport_table::TRANSPORT_TABLE`, so no phone or
//! peer machine can spawn a chat through it.
//!
//! The spawn itself is `forward::spawn_chat_for_peer`, the caller-less sibling
//! of `spawn_chat` that the `spawn_chat` RPC runs: the panel has no calling
//! session to inherit a model, effort or cwd guard from, so `cwd` is gated by
//! `reject_unknown` instead and the model/effort come from the project's most
//! recent chat. Billing is unchanged: it goes through `lifecycle::spawn_session`
//! like every other chat, subscription-only.

use super::forward::spawn_chat_for_peer;
use super::{FALLBACK_EFFORT, FALLBACK_MODEL};
use crate::daemon::methods::pr_review::reject_unknown;
use crate::daemon::rpc::{Router, RpcError};
use crate::daemon::state::DaemonState;
use crate::project_dashboard::{todo_actions, todo_ids, todo_stats::todos_dir};
use serde_json::{json, Value};
use std::sync::Arc;

/// Model and effort of the newest chat in the same folder, else the
/// `spawn_chat` fallbacks. A todo chat is usually the same kind of work as the
/// chat the panel sits beside, so its setting is the better default than a
/// constant.
fn model_and_effort_for(state: &DaemonState, cwd: &std::path::Path) -> (String, String) {
    let newest = state
        .registry
        .list()
        .into_iter()
        .filter(|i| crate::util::same_dir(&i.cwd, cwd) && !i.model.is_empty() && !i.effort.is_empty())
        .max_by(|a, b| a.started_at.cmp(&b.started_at));
    match newest {
        Some(i) => (i.model, i.effort),
        None => (FALLBACK_MODEL.to_string(), FALLBACK_EFFORT.to_string()),
    }
}

/// The first message for todo `canonical`.
fn first_message(canonical: &str) -> String {
    format!("Do todo {canonical}")
}

/// Spawns the chat and returns its session id. `id` may be any spelling; it is
/// resolved against the project's backlog first, so a typo never starts an
/// empty chat.
pub(crate) async fn start_todo_chat(state: &Arc<DaemonState>, cwd: &str, id: &str) -> Result<String, String> {
    let canonical = todo_actions::canonical_id_of(&todos_dir(std::path::Path::new(cwd)), id, &todo_ids::device_label())?;
    let (model, effort) = model_and_effort_for(state, std::path::Path::new(cwd));
    spawn_chat_for_peer(state, cwd, &first_message(&canonical), &model, &effort, None).await
}

pub fn register_todo_chat_rpc(router: &mut Router, state: Arc<DaemonState>) {
    router.register("ai_todo_start_chat", move |params, _ctx| {
        let state = state.clone();
        async move {
            #[derive(serde::Deserialize)]
            struct P {
                cwd: String,
                id: String,
            }
            let p: P = serde_json::from_value(params.unwrap_or(Value::Null))
                .map_err(|e| RpcError::invalid_params(e.to_string()))?;
            reject_unknown(&state, &p.cwd)?;
            let session_id = start_todo_chat(&state, &p.cwd, &p.id).await.map_err(RpcError::invalid_params)?;
            Ok(json!({"ok": true, "session_id": session_id}))
        }
    });
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

    #[test]
    fn the_first_message_is_do_todo_with_the_canonical_id() {
        assert_eq!(first_message("pc-1407"), "Do todo pc-1407");
    }

    #[test]
    fn model_and_effort_follow_the_newest_chat_in_the_folder_else_the_fallbacks() {
        let state = test_state();
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            model_and_effort_for(&state, dir.path()),
            (FALLBACK_MODEL.to_string(), FALLBACK_EFFORT.to_string())
        );
        state.registry.upsert_interactive("old", dir.path(), "p", "2026-10-01T00:00:00Z");
        state.registry.upsert_interactive("new", dir.path(), "p", "2026-10-02T00:00:00Z");
        state.registry.set_model_effort("old", "sonnet", "low");
        state.registry.set_model_effort("new", "opus", "high");
        assert_eq!(model_and_effort_for(&state, dir.path()), ("opus".to_string(), "high".to_string()));
    }

    /// An id that names no todo fails before `spawn_session` is reached, so
    /// this never launches a `claude` child.
    #[tokio::test]
    async fn an_unknown_todo_starts_no_chat() {
        let state = test_state();
        let dir = tempfile::tempdir().unwrap();
        let err = start_todo_chat(&state, &dir.path().to_string_lossy(), "pc-9").await.unwrap_err();
        assert!(err.contains("no todo"), "{err}");
    }

    #[tokio::test]
    async fn the_rpc_rejects_an_unregistered_cwd() {
        let state = test_state();
        let mut router = Router::new();
        register_todo_chat_rpc(&mut router, state);
        let (tx, _rx) = tokio::sync::mpsc::channel(16);
        let resp = router
            .dispatch(
                Request {
                    jsonrpc: "2.0".into(),
                    id: json!(1),
                    method: "ai_todo_start_chat".into(),
                    params: Some(json!({"cwd": "C:\\nope\\not\\registered", "id": "pc-1"})),
                },
                ConnectionContext::new(tx),
            )
            .await;
        assert!(resp.error.is_some(), "an unknown cwd must be rejected before any todo is read");
    }
}
