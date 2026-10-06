//! Registry-mutation RPC methods: mark-ended, externalize, set-effort,
//! set-model, register-historical, manual takeover, and the list-instances
//! snapshot fetch. Split by domain into `registry/` submodules (todo 723);
//! this file just wires them all into the `Router`.

mod attachments;
mod characters;
pub(super) mod lifecycle;
mod listings;
mod project_meta;
mod waiting_tail;

use crate::daemon::rpc::Router;
use crate::daemon::state::DaemonState;
use std::sync::Arc;

pub fn register_chat_registry(router: &mut Router, state: Arc<DaemonState>) {
    lifecycle::register_lifecycle(router, state.clone());
    characters::register_characters(router, state.clone());
    attachments::register_attachments(router, state.clone());
    project_meta::register_project_meta(router, state.clone());
    waiting_tail::register_waiting_tail(router, state.clone());
    listings::register_listings(router, state);
}

#[cfg(test)]
mod reject_unknown_tests {
    use super::*;
    use crate::daemon::rpc::{ConnectionContext, Request};
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::types::Settings;
    use serde_json::{json, Value};

    fn dummy_ctx() -> ConnectionContext {
        let (tx, _rx) = tokio::sync::mpsc::channel(16);
        ConnectionContext::new(tx)
    }

    fn dummy_state() -> Arc<DaemonState> {
        DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()))
    }

    async fn call(state: Arc<DaemonState>, method: &str, params: Value) -> crate::daemon::rpc::Response {
        let mut r = Router::new();
        register_chat_registry(&mut r, state);
        r.dispatch(
            Request { jsonrpc: "2.0".into(), id: json!(1), method: method.into(), params: Some(params) },
            dummy_ctx(),
        )
        .await
    }

    // Todo 656: these three take a client-supplied path over remote RPC and
    // must reject an unrecognized one before touching the filesystem.
    #[tokio::test]
    async fn get_project_tech_rejects_unknown_root() {
        let resp = call(dummy_state(), "get_project_tech", json!({"root": "C:\\nope\\not\\registered"})).await;
        assert!(resp.error.is_some(), "unknown root must be rejected");
    }

    #[tokio::test]
    async fn get_project_icon_rejects_unknown_root() {
        let resp = call(dummy_state(), "get_project_icon", json!({"root": "C:\\nope\\not\\registered"})).await;
        assert!(resp.error.is_some(), "unknown root must be rejected");
    }

    #[tokio::test]
    async fn project_last_activity_at_rejects_unknown_cwd() {
        let resp = call(dummy_state(), "project_last_activity_at", json!({"cwd": "C:\\nope\\not\\registered"})).await;
        assert!(resp.error.is_some(), "unknown cwd must be rejected");
    }

    #[tokio::test]
    async fn ai_todos_methods_reject_unknown_cwd() {
        for method in ["count_ai_todos", "list_ai_todos"] {
            let resp = call(dummy_state(), method, json!({"cwd": "C:\\nope\\not\\registered"})).await;
            assert!(resp.error.is_some(), "{method}: unknown cwd must be rejected");
        }
    }

    #[tokio::test]
    async fn ai_todos_methods_list_a_known_projects_backlog() {
        let dir = tempfile::tempdir().unwrap();
        let todos = dir.path().join(".claude").join("todos");
        std::fs::create_dir_all(&todos).unwrap();
        std::fs::write(todos.join("01-a.md"), "a").unwrap();
        std::fs::write(todos.join("PLAN.md"), "plan").unwrap();
        let state = dummy_state();
        state.registry.upsert_interactive(&uuid::Uuid::new_v4().to_string(), dir.path(), "proj", "2026-10-06T00:00:00Z");
        let cwd = dir.path().to_string_lossy().into_owned();

        let count = call(state.clone(), "count_ai_todos", json!({"cwd": cwd})).await;
        assert_eq!(count.result, Some(json!(1)), "PLAN.md is not a todo");
        let list = call(state, "list_ai_todos", json!({"cwd": cwd})).await;
        assert_eq!(list.result.unwrap()[0]["name"], json!("01-a.md"));
    }

    // Todo 656 follow-up: list_slash_commands must reject an unregistered
    // project_dir, but the None case (desktop's own ~/.claude scan) must
    // keep working - a test that only checks rejection would let someone
    // "fix" this by breaking the None path.
    #[tokio::test]
    async fn list_slash_commands_rejects_unknown_project_dir() {
        let resp = call(dummy_state(), "list_slash_commands", json!({"project_dir": "C:\\nope\\not\\registered"})).await;
        assert!(resp.error.is_some(), "unknown project_dir must be rejected");
    }

    #[tokio::test]
    async fn list_slash_commands_allows_missing_project_dir() {
        let resp = call(dummy_state(), "list_slash_commands", json!({})).await;
        assert!(resp.error.is_none(), "missing project_dir must still succeed");
    }
}
