//! RPC method registration, grouped by category. Each submodule exposes one or
//! more `register_*` fns; the daemon bin (`src/bin/cc_conductor_daemon.rs`)
//! calls them in sequence at startup to populate the Router.

// pub(crate): `hooks_server::channel` (the coordination-tool HTTP routes)
// calls this module's `list_peers`/`post_message`/`read_messages` directly -
// same non-RPC shape as `jarvis` below.
pub(crate) mod channel;
mod channels;
mod context;
mod drafts;
// pub(crate): `hooks_server::jarvis` (the fleet-tool HTTP routes, todo 272
// chunk 2b) calls this module's `spawn_worker`/`send_to_session`/
// `fleet_status`/`respond_worker_prompt` directly - those aren't RPC methods
// (no `Router`/`ConnectionContext` at a hooks-server callsite - see that
// module's header), so plain private-to-`daemon::methods` visibility isn't
// enough; `hooks_server` is a sibling of `daemon::methods`, not a descendant.
pub(crate) mod jarvis;
mod jarvis_assets;
mod jarvis_fleet;
mod history;
mod lifecycle;
mod permission;
mod pr_review;
mod preview;
mod registry;
mod schedule;
pub(crate) mod spawn_chat;
mod statusbar;
mod worktrees;
// pub(crate): `hooks_server::turn_status` (the `report_turn_status` MCP
// tool's HTTP route, todo 435) calls this module's `report_status` directly -
// same non-RPC shape as `channel` above.
pub(crate) mod turn_status;
mod usage;
// pub(crate): `hooks_server::user_todos` (the `write_user_todo` MCP tool route
// and the per-turn injection hook, todo 692) calls this module's handlers
// directly - same non-RPC shape as `channel` above.
pub(crate) mod user_todos;

pub use channels::register_channels;
pub use context::register_context;
pub use drafts::register_drafts;
pub use history::register_history;
pub use jarvis::register_jarvis;
pub use lifecycle::{register, register_notifier, register_settings};
pub use permission::register_responders;
pub use pr_review::register_pr_review;
pub use preview::register_preview;
pub use registry::register_chat_registry;
pub use schedule::register_schedule;
pub use statusbar::register_statusbar;
pub use usage::register_usage;
pub use user_todos::register_user_todos;
pub use worktrees::register_worktrees;

#[cfg(test)]
mod tests {
    use super::{register, register_channels, register_chat_registry, register_responders, register_schedule};
    use crate::daemon::rpc::{ConnectionContext, Request, Router};
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::daemon::state::DaemonState;
    use crate::types::Settings;
    use serde_json::json;

    fn dummy_ctx() -> ConnectionContext {
        let (tx, _rx) = tokio::sync::mpsc::channel(16);
        ConnectionContext::new(tx)
    }

    fn dummy_state() -> std::sync::Arc<DaemonState> {
        DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()))
    }

    #[tokio::test]
    async fn unknown_session_returns_not_found_rpc_error() {
        let mut r = Router::new();
        register(&mut r, dummy_state());
        let resp = r.dispatch(Request {
            jsonrpc: "2.0".into(),
            id: json!(1),
            method: "send_message".into(),
            params: Some(json!({"session_id": "nope", "text": "hi"})),
        }, dummy_ctx()).await;
        let err = resp.error.expect("error");
        assert_eq!(err.code, -32004);
    }

    #[tokio::test]
    async fn missing_params_returns_invalid_params() {
        let mut r = Router::new();
        register(&mut r, dummy_state());
        let resp = r.dispatch(Request {
            jsonrpc: "2.0".into(),
            id: json!(1),
            method: "send_message".into(),
            params: Some(json!({})),
        }, dummy_ctx()).await;
        let err = resp.error.expect("error");
        assert_eq!(err.code, -32602);
    }

    #[tokio::test]
    async fn attach_session_unknown_returns_not_found() {
        let mut r = Router::new();
        register(&mut r, dummy_state());
        let resp = r.dispatch(Request {
            jsonrpc: "2.0".into(),
            id: json!(1),
            method: "attach_session".into(),
            params: Some(json!({"session_id": "ghost"})),
        }, dummy_ctx()).await;
        let err = resp.error.expect("error");
        assert_eq!(err.code, -32004);
    }

    #[tokio::test]
    async fn detach_session_unknown_is_ok() {
        let mut r = Router::new();
        register(&mut r, dummy_state());
        let resp = r.dispatch(Request {
            jsonrpc: "2.0".into(),
            id: json!(1),
            method: "detach_session".into(),
            params: Some(json!({"session_id": "ghost"})),
        }, dummy_ctx()).await;
        // detach on unknown session is a no-op, not an error
        assert!(resp.error.is_none());
        assert_eq!(resp.result, Some(json!({"ok": true})));
    }

    #[tokio::test]
    async fn respond_permission_resolves_pending_oneshot() {
        let st = dummy_state();
        let (tx, rx) = tokio::sync::oneshot::channel();
        st.pending.lock().await.insert("req-1".to_string(), tx);

        let mut r = Router::new();
        register_responders(&mut r, st.clone());
        let resp = r.dispatch(Request {
            jsonrpc: "2.0".into(),
            id: json!(1),
            method: "respond_permission".into(),
            params: Some(json!({"request_id": "req-1", "allow": true, "updated_input": {"k": 1}})),
        }, dummy_ctx()).await;
        assert!(resp.error.is_none(), "expected no error, got {:?}", resp.error);

        let payload = rx.await.expect("oneshot resolved");
        assert_eq!(payload["behavior"], json!("allow"));
        assert_eq!(payload["updatedInput"]["k"], json!(1));
    }

    #[tokio::test]
    async fn respond_permission_unknown_request_id_settles_ok() {
        // Ghost prompts (child died while the prompt was open) are settled,
        // not rejected: -32004 here used to leave the record + awaiting flag
        // stuck forever. See daemon/methods/permission.rs module docs.
        let mut r = Router::new();
        register_responders(&mut r, dummy_state());
        let resp = r.dispatch(Request {
            jsonrpc: "2.0".into(),
            id: json!(1),
            method: "respond_permission".into(),
            params: Some(json!({"request_id": "ghost", "allow": true})),
        }, dummy_ctx()).await;
        assert!(resp.error.is_none(), "expected no error, got {:?}", resp.error);
        assert_eq!(resp.result, Some(json!({"ok": true, "delivered": false})));
    }

    #[tokio::test]
    async fn list_channels_empty_returns_array() {
        let mut r = Router::new();
        register_channels(&mut r, dummy_state());
        let resp = r.dispatch(Request {
            jsonrpc: "2.0".into(),
            id: json!(1),
            method: "list_channels".into(),
            params: None,
        }, dummy_ctx()).await;
        assert!(resp.error.is_none(), "expected no error, got {:?}", resp.error);
        assert_eq!(resp.result, Some(json!([])));
    }

    #[tokio::test]
    async fn mark_session_ended_unknown_is_ok() {
        let mut r = Router::new();
        register_chat_registry(&mut r, dummy_state());
        let resp = r.dispatch(Request { jsonrpc: "2.0".into(), id: json!(1),
            method: "mark_session_ended".into(), params: Some(json!({"session_id":"ghost"})) }, dummy_ctx()).await;
        assert!(resp.error.is_none(), "got {:?}", resp.error);
    }

    #[tokio::test]
    async fn list_instances_empty_returns_array() {
        let mut r = Router::new();
        register_chat_registry(&mut r, dummy_state());
        let resp = r.dispatch(Request { jsonrpc: "2.0".into(), id: json!(1),
            method: "list_instances".into(), params: None }, dummy_ctx()).await;
        assert!(resp.error.is_none(), "got {:?}", resp.error);
        assert_eq!(resp.result, Some(json!([])));
    }

    #[tokio::test]
    async fn list_accounts_dispatches_to_registered_handler() {
        // Guards ai_todo 241: the phone's new-chat picker calls list_accounts
        // over the remote API. If the daemon route is missing, dispatch returns
        // method-not-found (-32601) and mobile can't start chats. Assert it
        // resolves to a handler returning a JSON array (empty or not, depending
        // on the machine's accounts.json - load_registry falls back to []).
        let mut r = Router::new();
        register_chat_registry(&mut r, dummy_state());
        let resp = r.dispatch(Request { jsonrpc: "2.0".into(), id: json!(1),
            method: "list_accounts".into(), params: None }, dummy_ctx()).await;
        assert!(resp.error.is_none(), "list_accounts not registered? got {:?}", resp.error);
        assert!(
            resp.result.as_ref().map(serde_json::Value::is_array).unwrap_or(false),
            "expected a JSON array, got {:?}", resp.result
        );
    }

    #[tokio::test]
    async fn list_slash_commands_dispatches_to_registered_handler() {
        // Guards the remote `/` autocomplete popup bug: HttpTransport had no
        // case for list_slash_commands and the daemon had no RPC registered for
        // it, so the phone/browser popup was always empty. Assert it resolves
        // to a handler returning a JSON array (scan_all always returns at least
        // the builtins, even with no project_dir).
        let mut r = Router::new();
        register_chat_registry(&mut r, dummy_state());
        let resp = r.dispatch(Request { jsonrpc: "2.0".into(), id: json!(1),
            method: "list_slash_commands".into(), params: None }, dummy_ctx()).await;
        assert!(resp.error.is_none(), "list_slash_commands not registered? got {:?}", resp.error);
        assert!(
            resp.result.as_ref().map(serde_json::Value::is_array).unwrap_or(false),
            "expected a JSON array, got {:?}", resp.result
        );
    }

    #[tokio::test]
    async fn schedule_list_dispatches_to_registered_handler() {
        // Guards ai_todo 257: the phone's scheduled-chip and Schedule view call
        // schedule_list over the remote API. If the daemon route is missing,
        // dispatch returns method-not-found (-32601) and both surfaces render
        // nothing. Assert it resolves to a handler returning a JSON array
        // (empty or not, depending on the machine's scheduled-items.json -
        // scheduled_items::list falls back to []).
        let mut r = Router::new();
        register_schedule(&mut r, dummy_state());
        let resp = r.dispatch(Request { jsonrpc: "2.0".into(), id: json!(1),
            method: "schedule_list".into(), params: None }, dummy_ctx()).await;
        assert!(resp.error.is_none(), "schedule_list not registered? got {:?}", resp.error);
        assert!(
            resp.result.as_ref().map(serde_json::Value::is_array).unwrap_or(false),
            "expected a JSON array, got {:?}", resp.result
        );
    }

    #[tokio::test]
    async fn ensure_session_character_dispatches_to_registered_handler() {
        // Guards the remote-avatar bug: `ensure_session_character` (the
        // ASSIGNMENT mutator) previously existed only as a Tauri app-process
        // command, so a session started on the remote/browser transport never
        // got a character - HttpTransport had no case for it and the daemon
        // had no RPC registered, so dispatch would 404 with -32601 (method not
        // found). With an empty registry (dummy_state) the session_id is
        // unknown, so the handler can't resolve a project_id and returns
        // `null` rather than erroring - the point of this test is that the
        // ROUTE resolves at all.
        let mut r = Router::new();
        register_chat_registry(&mut r, dummy_state());
        let resp = r.dispatch(Request { jsonrpc: "2.0".into(), id: json!(1),
            method: "ensure_session_character".into(), params: Some(json!({"session_id": "ghost"})) }, dummy_ctx()).await;
        assert!(resp.error.is_none(), "ensure_session_character not registered? got {:?}", resp.error);
        assert_eq!(resp.result, Some(json!(null)));
    }

    #[tokio::test]
    async fn shutdown_daemon_returns_ok() {
        let mut r = Router::new();
        register(&mut r, dummy_state());
        let resp = r.dispatch(Request { jsonrpc: "2.0".into(), id: json!(1),
            method: "shutdown_daemon".into(), params: None }, dummy_ctx()).await;
        assert!(resp.error.is_none(), "got {:?}", resp.error);
        assert_eq!(resp.result, Some(json!({"ok": true})));
    }

    #[tokio::test]
    async fn start_session_invalid_cwd_does_not_register() {
        let st = dummy_state();
        let reg = st.registry.clone();
        let mut r = Router::new();
        register(&mut r, st);
        let resp = r.dispatch(Request {
            jsonrpc: "2.0".into(),
            id: json!(1),
            method: "start_session".into(),
            params: Some(json!({"cwd": "Z:\\does\\not\\exist", "model": "opus", "effort": "high", "resume_id": null})),
        }, dummy_ctx()).await;
        assert!(resp.error.is_some(), "invalid cwd must error");
        assert_eq!(reg.list().len(), 0, "no registry entry on failed spawn");
    }
}
