//! Registry-mutation RPC methods: mark-ended, externalize, set-effort,
//! set-model, register-historical, manual takeover, and the list-instances
//! snapshot fetch. Split by domain into `registry/` submodules (todo 723);
//! this file just wires them all into the `Router`.

mod attachments;
mod characters;
mod image_read;
pub(super) mod lifecycle;
mod listings;
pub(super) mod new_session_bundle;
mod project_meta;
mod waiting_tail;

use crate::daemon::rpc::Router;
use crate::daemon::state::DaemonState;
use std::sync::Arc;

pub fn register_chat_registry(router: &mut Router, state: Arc<DaemonState>) {
    lifecycle::register_lifecycle(router, state.clone());
    characters::register_characters(router, state.clone());
    attachments::register_attachments(router, state.clone());
    image_read::register_image_read(router, state.clone());
    project_meta::register_project_meta(router, state.clone());
    waiting_tail::register_waiting_tail(router, state.clone());
    new_session_bundle::register_new_session_bundle(router, state.clone());
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
        let read = call(dummy_state(), "read_ai_todo", json!({"cwd": "C:\\nope\\not\\registered", "id": "pc-1"})).await;
        assert!(read.error.is_some(), "read_ai_todo: unknown cwd must be rejected");
        for method in ["count_ai_todos", "list_ai_todos", "list_ai_backlog"] {
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

    /// A paired machine reading a chat hosted here sends that chat's
    /// `session_id`; the list comes from the cwd THIS registry holds for it,
    /// so the cwd the peer sends (a path off its mirrored row) cannot steer it.
    #[tokio::test]
    async fn list_ai_todos_with_a_session_id_reads_the_registered_cwd() {
        let dir = tempfile::tempdir().unwrap();
        let todos = dir.path().join(".claude").join("todos");
        std::fs::create_dir_all(&todos).unwrap();
        std::fs::write(todos.join("07-b.md"), "b").unwrap();
        let state = dummy_state();
        let sid = uuid::Uuid::new_v4().to_string();
        state.registry.upsert_interactive(&sid, dir.path(), "proj", "2026-10-06T00:00:00Z");

        let list = call(state.clone(), "list_ai_todos", json!({"cwd": "C:\\nope\\not\\registered", "session_id": sid})).await;
        assert_eq!(list.result.unwrap()[0]["name"], json!("07-b.md"));
        let unknown = call(state, "list_ai_todos", json!({"cwd": "C:\\nope", "session_id": "no-such-session"})).await;
        assert!(unknown.error.is_some(), "an unknown session_id must be rejected");
    }

    /// The chip's count for a chat hosted here follows the same `session_id`
    /// rule as the list: the registered cwd wins over whatever cwd is sent.
    #[tokio::test]
    async fn count_ai_todos_with_a_session_id_reads_the_registered_cwd() {
        let dir = tempfile::tempdir().unwrap();
        let todos = dir.path().join(".claude").join("todos");
        std::fs::create_dir_all(&todos).unwrap();
        std::fs::write(todos.join("07-b.md"), "b").unwrap();
        std::fs::write(todos.join("08-c.md"), "c").unwrap();
        let state = dummy_state();
        let sid = uuid::Uuid::new_v4().to_string();
        state.registry.upsert_interactive(&sid, dir.path(), "proj", "2026-10-06T00:00:00Z");

        let count = call(state.clone(), "count_ai_todos", json!({"cwd": "C:\\nope\\not\\registered", "session_id": sid})).await;
        assert_eq!(count.result, Some(json!(2)));
        let unknown = call(state, "count_ai_todos", json!({"cwd": "C:\\nope", "session_id": "no-such-session"})).await;
        assert!(unknown.error.is_some(), "an unknown session_id must be rejected");
    }

    /// The Backlog panel's reads go through the same cwd trust rule as the
    /// chip: a known project reads its own backlog, and a `session_id`
    /// re-derives the cwd from the registry so a peer's `cwd` string cannot
    /// steer it.
    #[tokio::test]
    async fn backlog_reads_serve_a_known_project_and_follow_a_session_id() {
        let dir = tempfile::tempdir().unwrap();
        let todos = dir.path().join(".claude").join("todos");
        std::fs::create_dir_all(&todos).unwrap();
        std::fs::write(todos.join("pc-0007-b.md"), "# Bee\n**Summary:** Buzz.\n\n## Why\n\nBecause.\n").unwrap();
        std::fs::write(todos.join("PLAN.md"), "## Now\n- [ ] pc-0007\n").unwrap();
        let state = dummy_state();
        let sid = uuid::Uuid::new_v4().to_string();
        state.registry.upsert_interactive(&sid, dir.path(), "proj", "2026-10-06T00:00:00Z");
        let cwd = dir.path().to_string_lossy().into_owned();

        let backlog = call(state.clone(), "list_ai_backlog", json!({"cwd": cwd})).await.result.unwrap();
        assert_eq!(backlog["groups"], json!(["Now"]));
        assert_eq!(backlog["todos"][0]["id"], json!("pc-0007"));
        assert_eq!(backlog["todos"][0]["group"], json!("Now"));

        let doc = call(state.clone(), "read_ai_todo", json!({"cwd": "C:\\nope", "id": "7", "session_id": sid})).await.result.unwrap();
        assert_eq!(doc["entry"]["title"], json!("Bee"));
        assert_eq!(doc["why"], json!("Because."));

        let missing = call(state, "read_ai_todo", json!({"cwd": cwd, "id": "pc-99"})).await;
        assert!(missing.error.is_some(), "an unknown todo id is an error, not an empty doc");
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

    // The phone's whole new-chat flow reads this one response, so a project's
    // row, todo badge and CLAUDE.md scopes must all be in it. Not under the
    // OS temp dir: list_project_groups drops temp-dir projects as ephemeral.
    #[tokio::test]
    async fn new_session_bundle_carries_a_projects_stats_and_scopes() {
        let dir = tempfile::Builder::new().prefix("bundle-test-").tempdir_in(env!("CARGO_MANIFEST_DIR")).unwrap();
        std::fs::create_dir_all(dir.path().join("apps/web")).unwrap();
        std::fs::create_dir_all(dir.path().join(".claude/todos")).unwrap();
        std::fs::write(dir.path().join("CLAUDE.md"), "").unwrap();
        std::fs::write(dir.path().join("apps/web/CLAUDE.md"), "").unwrap();
        std::fs::write(dir.path().join(".claude/todos/01-a.md"), "a").unwrap();
        let path = dir.path().to_string_lossy().into_owned();
        let mut settings = Settings::default();
        settings.projects.push(
            serde_json::from_value(json!({
                "id": "p1", "path": path, "name": "bundle", "created_at": "2026-10-22T00:00:00Z",
            }))
            .unwrap(),
        );
        let state = DaemonState::new(new_session_map(), SettingsCache::new(settings));

        let resp = call(state, "new_session_bundle", json!({})).await;
        let b = resp.result.unwrap_or_else(|| panic!("bundle errored: {:?}", resp.error));
        assert!(b["groups"].as_array().unwrap().iter().any(|g| g["path"] == json!(path)));
        assert_eq!(b["stats"][&path]["todoCount"], json!(1));
        assert_eq!(b["scopes"][&path].as_array().unwrap().len(), 2);
        assert!(b["projectAccounts"].as_object().unwrap().contains_key(&path));
        assert!(b["settings"].is_object() && b["accounts"].is_array() && b["projects"].is_array());
    }

    // A paired machine's picker needs the project rows and their todo/recency
    // stats, not this daemon's settings, accounts or CLAUDE.md scopes.
    #[tokio::test]
    async fn new_session_bundle_for_a_peer_machine_is_groups_and_stats_only() {
        let dir = tempfile::Builder::new().prefix("bundle-peer-").tempdir_in(env!("CARGO_MANIFEST_DIR")).unwrap();
        std::fs::create_dir_all(dir.path().join(".claude/todos")).unwrap();
        std::fs::write(dir.path().join(".claude/todos/01-a.md"), "a").unwrap();
        std::fs::write(dir.path().join(".claude/todos/02-b.md"), "b").unwrap();
        let path = dir.path().to_string_lossy().into_owned();
        let mut settings = Settings::default();
        settings.projects.push(
            serde_json::from_value(json!({
                "id": "p1", "path": path, "name": "bundle", "created_at": "2026-10-22T00:00:00Z",
                "avatar": {"kind": "image", "value": "C:/private/face.png"},
            }))
            .unwrap(),
        );
        let state = DaemonState::new(new_session_map(), SettingsCache::new(settings));

        let mut r = Router::new();
        register_chat_registry(&mut r, state);
        let mut ctx = dummy_ctx();
        ctx.transport = crate::daemon::rpc::Transport::PeerMachine("mac".into());
        let resp = r
            .dispatch(Request { jsonrpc: "2.0".into(), id: json!(1), method: "new_session_bundle".into(), params: None }, ctx)
            .await;
        let b = resp.result.unwrap_or_else(|| panic!("bundle errored: {:?}", resp.error));

        let g = b["groups"].as_array().unwrap().iter().find(|g| g["path"] == json!(path)).expect("project group");
        assert_eq!(g["avatar"]["kind"], json!("none"), "image avatar path must not cross to a peer");
        assert_eq!(b["stats"][&path]["todoCount"], json!(2));
        for stripped in ["settings", "accounts", "projects", "scopes", "projectAccounts"] {
            assert!(b.get(stripped).is_none(), "{stripped} must not be sent to a peer machine");
        }
    }

    #[tokio::test]
    async fn list_slash_commands_allows_missing_project_dir() {
        let resp = call(dummy_state(), "list_slash_commands", json!({})).await;
        assert!(resp.error.is_none(), "missing project_dir must still succeed");
    }
}
