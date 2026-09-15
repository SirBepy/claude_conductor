//! `add_step_comment` RPC (todo 898): Joe leaves a note on a still-`pending`
//! `write_plan` step from the checklist UI. Stored on `DaemonState` and taken
//! back out by `hooks_server::plan::on_write_plan` the moment that step goes
//! `active` - see `daemon::state::step_comments` for the full lifecycle.
//! Desktop-pipe only: absent from `remote_handlers::TRANSPORT_TABLE`, so a
//! phone/peer-machine session cannot leave one yet (not asked for by todo 898).

use crate::daemon::rpc::{Router, RpcError};
use crate::daemon::state::DaemonState;
use serde::Deserialize;
use serde_json::json;
use std::sync::Arc;

pub fn register_step_comments(router: &mut Router, state: Arc<DaemonState>) {
    router.register("add_step_comment", move |params, _ctx| {
        let state = state.clone();
        async move {
            #[derive(Deserialize)]
            struct P {
                session_id: String,
                step_text: String,
                comment: String,
            }
            let p: P = serde_json::from_value(params.unwrap_or(serde_json::Value::Null))
                .map_err(|e| RpcError::invalid_params(e.to_string()))?;
            if state.registry.get(&p.session_id).is_none() {
                return Err(RpcError::invalid_params("unknown session_id".to_string()));
            }
            let step_text = p.step_text.trim();
            if step_text.is_empty() {
                return Err(RpcError::invalid_params("step_text must not be empty".to_string()));
            }
            let comment = p.comment.trim();
            if comment.is_empty() {
                return Err(RpcError::invalid_params("comment must not be empty".to_string()));
            }
            state.add_step_comment(&p.session_id, step_text, comment).await;
            Ok(json!({"ok": true}))
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

    fn dummy_ctx() -> ConnectionContext {
        let (tx, _rx) = tokio::sync::mpsc::channel(16);
        ConnectionContext::new(tx)
    }

    fn state_with_session(session_id: &str) -> Arc<DaemonState> {
        let st = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        let settings = std::sync::Mutex::new(Settings::default());
        st.registry.record_interactive_session(
            session_id,
            std::path::Path::new("/tmp/x"),
            &settings,
            "2026-09-15T00:00:00Z",
        );
        st
    }

    async fn call(state: Arc<DaemonState>, params: serde_json::Value) -> crate::daemon::rpc::Response {
        let mut r = Router::new();
        register_step_comments(&mut r, state);
        r.dispatch(
            Request { jsonrpc: "2.0".into(), id: json!(1), method: "add_step_comment".into(), params: Some(params) },
            dummy_ctx(),
        )
        .await
    }

    #[tokio::test]
    async fn unknown_session_is_rejected() {
        let st = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        let resp = call(st, json!({"session_id": "ghost", "step_text": "a", "comment": "hi"})).await;
        assert!(resp.error.is_some());
    }

    #[tokio::test]
    async fn blank_step_text_or_comment_is_rejected() {
        let st = state_with_session("s1");
        let resp = call(st.clone(), json!({"session_id": "s1", "step_text": "   ", "comment": "hi"})).await;
        assert!(resp.error.is_some());
        let resp = call(st, json!({"session_id": "s1", "step_text": "a", "comment": "  "})).await;
        assert!(resp.error.is_some());
    }

    #[tokio::test]
    async fn a_stored_comment_is_retrievable_through_daemon_state() {
        let st = state_with_session("s1");
        let resp = call(st.clone(), json!({"session_id": "s1", "step_text": "Read the spec", "comment": "skip it"})).await;
        assert!(resp.error.is_none(), "{:?}", resp.error);
        assert_eq!(st.take_step_comment("s1", "Read the spec").await, Some("skip it".to_string()));
    }
}
