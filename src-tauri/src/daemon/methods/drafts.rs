//! Cross-surface draft sync RPCs: composer text, AUQ partial answers, and
//! the held-message queue, all fetched in one round trip per session
//! (`get_session_drafts`) so a freshly-opened surface can reconcile without
//! trusting the lossy `instances_changed` broadcast (see notifier.rs's doc).

//! Authorization: a `session_id` known to this daemon, not a filesystem
//! path - `statusbar.rs`'s `is_known_cwd` guard doesn't apply. Same boundary
//! as `send_message`/`respond_permission`: any authenticated client may read
//! or write any session's drafts it knows the id of, no per-device check.

use crate::daemon::rpc::{Router, RpcError};
use crate::daemon::state::DaemonState;
use crate::types::ContentBlock;
use serde::Deserialize;
use serde_json::json;
use std::sync::Arc;

fn reject_unknown_session(state: &DaemonState, session_id: &str) -> Result<(), RpcError> {
    if state.registry.get(session_id).is_some() {
        Ok(())
    } else {
        Err(RpcError::invalid_params("unknown session_id".to_string()))
    }
}

/// Recomputes `held_count` from the store and publishes `instances_changed`
/// only if it actually changed - the one path that keeps the cheap broadcast
/// signal truthful after an add/remove/clear.
fn sync_held_count(state: &Arc<DaemonState>, session_id: &str) {
    let count = state.draft_store.held_count(session_id) as u32;
    if state.registry.set_held_count(session_id, count) {
        state.notifier.publish("instances_changed", json!({"instances": state.registry.list()}));
    }
}

pub fn register_drafts(router: &mut Router, state: Arc<DaemonState>) {
    {
        let state = state.clone();
        router.register("get_session_drafts", move |params, _ctx| {
            let state = state.clone();
            async move {
                #[derive(Deserialize)]
                struct P { session_id: String }
                let p: P = serde_json::from_value(params.unwrap_or(serde_json::Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                reject_unknown_session(&state, &p.session_id)?;
                Ok(serde_json::to_value(state.draft_store.get(&p.session_id)).unwrap())
            }
        });
    }

    {
        let state = state.clone();
        router.register("set_composer_draft", move |params, _ctx| {
            let state = state.clone();
            async move {
                #[derive(Deserialize)]
                struct P { session_id: String, text: String }
                let p: P = serde_json::from_value(params.unwrap_or(serde_json::Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                reject_unknown_session(&state, &p.session_id)?;
                let updated_at = state.draft_store.set_composer(&p.session_id, p.text);
                Ok(json!({"updated_at": updated_at}))
            }
        });
    }

    {
        let state = state.clone();
        router.register("clear_composer_draft", move |params, _ctx| {
            let state = state.clone();
            async move {
                #[derive(Deserialize)]
                struct P { session_id: String }
                let p: P = serde_json::from_value(params.unwrap_or(serde_json::Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                reject_unknown_session(&state, &p.session_id)?;
                let updated_at = state.draft_store.clear_composer(&p.session_id);
                Ok(json!({"updated_at": updated_at}))
            }
        });
    }

    {
        let state = state.clone();
        router.register("set_auq_draft", move |params, _ctx| {
            let state = state.clone();
            async move {
                #[derive(Deserialize)]
                struct P { session_id: String, prompt_id: String, payload: serde_json::Value }
                let p: P = serde_json::from_value(params.unwrap_or(serde_json::Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                reject_unknown_session(&state, &p.session_id)?;
                let updated_at = state.draft_store.set_auq(&p.session_id, p.prompt_id, p.payload);
                Ok(json!({"updated_at": updated_at}))
            }
        });
    }

    {
        let state = state.clone();
        // `prompt_id` guards against a stale clear from a superseded prompt's
        // UI wiping a newer prompt's in-progress draft - see draft_store.rs.
        router.register("clear_auq_draft", move |params, _ctx| {
            let state = state.clone();
            async move {
                #[derive(Deserialize)]
                struct P { session_id: String, prompt_id: String }
                let p: P = serde_json::from_value(params.unwrap_or(serde_json::Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                reject_unknown_session(&state, &p.session_id)?;
                let cleared = state.draft_store.clear_auq(&p.session_id, &p.prompt_id);
                Ok(json!({"cleared": cleared}))
            }
        });
    }

    {
        let state = state.clone();
        router.register("add_held_message", move |params, _ctx| {
            let state = state.clone();
            async move {
                #[derive(Deserialize)]
                struct P { session_id: String, blocks: Vec<ContentBlock> }
                let p: P = serde_json::from_value(params.unwrap_or(serde_json::Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                reject_unknown_session(&state, &p.session_id)?;
                let (id, updated_at) = state.draft_store.add_held(&p.session_id, p.blocks);
                sync_held_count(&state, &p.session_id);
                Ok(json!({"id": id, "updated_at": updated_at}))
            }
        });
    }

    {
        let state = state.clone();
        router.register("update_held_message", move |params, _ctx| {
            let state = state.clone();
            async move {
                #[derive(Deserialize)]
                struct P { session_id: String, id: u64, blocks: Vec<ContentBlock> }
                let p: P = serde_json::from_value(params.unwrap_or(serde_json::Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                reject_unknown_session(&state, &p.session_id)?;
                match state.draft_store.update_held(&p.session_id, p.id, p.blocks) {
                    Some(updated_at) => Ok(json!({"updated_at": updated_at})),
                    None => Err(RpcError::invalid_params("no such held item".to_string())),
                }
            }
        });
    }

    {
        let state = state.clone();
        router.register("remove_held_message", move |params, _ctx| {
            let state = state.clone();
            async move {
                #[derive(Deserialize)]
                struct P { session_id: String, id: u64 }
                let p: P = serde_json::from_value(params.unwrap_or(serde_json::Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                reject_unknown_session(&state, &p.session_id)?;
                match state.draft_store.remove_held(&p.session_id, p.id) {
                    Some(updated_at) => {
                        sync_held_count(&state, &p.session_id);
                        Ok(json!({"updated_at": updated_at}))
                    }
                    None => Err(RpcError::invalid_params("no such held item".to_string())),
                }
            }
        });
    }

    router.register("clear_held_messages", move |params, _ctx| {
        let state = state.clone();
        async move {
            #[derive(Deserialize)]
            struct P { session_id: String }
            let p: P = serde_json::from_value(params.unwrap_or(serde_json::Value::Null))
                .map_err(|e| RpcError::invalid_params(e.to_string()))?;
            reject_unknown_session(&state, &p.session_id)?;
            let updated_at = state.draft_store.clear_held(&p.session_id);
            sync_held_count(&state, &p.session_id);
            Ok(json!({"updated_at": updated_at}))
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
    use serde_json::json;

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
            "2026-08-13T00:00:00Z",
        );
        st
    }

    async fn call(state: Arc<DaemonState>, method: &str, params: serde_json::Value) -> crate::daemon::rpc::Response {
        let mut r = Router::new();
        register_drafts(&mut r, state);
        r.dispatch(
            Request { jsonrpc: "2.0".into(), id: json!(1), method: method.into(), params: Some(params) },
            dummy_ctx(),
        )
        .await
    }

    #[tokio::test]
    async fn unknown_session_rejected_for_every_method() {
        let cases = [
            ("get_session_drafts", json!({"session_id": "ghost"})),
            ("set_composer_draft", json!({"session_id": "ghost", "text": "hi"})),
            ("clear_composer_draft", json!({"session_id": "ghost"})),
            ("set_auq_draft", json!({"session_id": "ghost", "prompt_id": "p1", "payload": {}})),
            ("clear_auq_draft", json!({"session_id": "ghost", "prompt_id": "p1"})),
            ("add_held_message", json!({"session_id": "ghost", "blocks": []})),
            ("update_held_message", json!({"session_id": "ghost", "id": 1, "blocks": []})),
            ("remove_held_message", json!({"session_id": "ghost", "id": 1})),
            ("clear_held_messages", json!({"session_id": "ghost"})),
        ];
        for (method, params) in cases {
            let st = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
            let resp = call(st, method, params).await;
            assert!(resp.error.is_some(), "{method} must reject an unknown session_id");
        }
    }

    #[tokio::test]
    async fn composer_draft_round_trips_and_clears() {
        let st = state_with_session("s1");
        let resp = call(st.clone(), "set_composer_draft", json!({"session_id": "s1", "text": "hello"})).await;
        assert!(resp.error.is_none(), "{:?}", resp.error);

        let resp = call(st.clone(), "get_session_drafts", json!({"session_id": "s1"})).await;
        assert_eq!(resp.result.unwrap()["composer"]["text"], json!("hello"));

        call(st.clone(), "clear_composer_draft", json!({"session_id": "s1"})).await;
        let resp = call(st, "get_session_drafts", json!({"session_id": "s1"})).await;
        assert_eq!(resp.result.unwrap()["composer"], json!(null));
    }

    #[tokio::test]
    async fn writing_one_kind_does_not_clobber_the_others() {
        let st = state_with_session("s1");
        call(st.clone(), "set_composer_draft", json!({"session_id": "s1", "text": "draft text"})).await;
        call(st.clone(), "set_auq_draft", json!({"session_id": "s1", "prompt_id": "p1", "payload": {"x": 1}})).await;
        call(st.clone(), "add_held_message", json!({"session_id": "s1", "blocks": [{"type":"text","text":"held"}]})).await;

        let resp = call(st, "get_session_drafts", json!({"session_id": "s1"})).await;
        let v = resp.result.unwrap();
        assert_eq!(v["composer"]["text"], json!("draft text"));
        assert_eq!(v["auq"]["prompt_id"], json!("p1"));
        assert_eq!(v["held"].as_array().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn auq_draft_clear_requires_matching_prompt_id() {
        let st = state_with_session("s1");
        call(st.clone(), "set_auq_draft", json!({"session_id": "s1", "prompt_id": "p1", "payload": {}})).await;
        let resp = call(st.clone(), "clear_auq_draft", json!({"session_id": "s1", "prompt_id": "stale"})).await;
        assert_eq!(resp.result.unwrap()["cleared"], json!(false));

        let resp = call(st.clone(), "get_session_drafts", json!({"session_id": "s1"})).await;
        assert_eq!(resp.result.unwrap()["auq"]["prompt_id"], json!("p1"), "mismatched prompt_id must not clear");

        let resp = call(st, "clear_auq_draft", json!({"session_id": "s1", "prompt_id": "p1"})).await;
        assert_eq!(resp.result.unwrap()["cleared"], json!(true));
    }

    #[tokio::test]
    async fn held_message_ordering_and_edit_delete() {
        let st = state_with_session("s1");
        call(st.clone(), "add_held_message", json!({"session_id": "s1", "blocks": [{"type":"text","text":"one"}]})).await;
        let resp = call(st.clone(), "add_held_message", json!({"session_id": "s1", "blocks": [{"type":"text","text":"two"}]})).await;
        let second_id = resp.result.unwrap()["id"].as_u64().unwrap();

        let resp = call(st.clone(), "get_session_drafts", json!({"session_id": "s1"})).await;
        let held = resp.result.unwrap();
        let held = held["held"].as_array().unwrap().clone();
        assert_eq!(held.len(), 2);
        assert_eq!(held[0]["blocks"][0]["text"], json!("one"));
        assert_eq!(held[1]["blocks"][0]["text"], json!("two"));

        call(
            st.clone(),
            "update_held_message",
            json!({"session_id": "s1", "id": second_id, "blocks": [{"type":"text","text":"two-edited"}]}),
        )
        .await;
        let resp = call(st.clone(), "remove_held_message", json!({"session_id": "s1", "id": second_id})).await;
        assert!(resp.error.is_none());

        let resp = call(st, "get_session_drafts", json!({"session_id": "s1"})).await;
        let held = resp.result.unwrap();
        let held = held["held"].as_array().unwrap();
        assert_eq!(held.len(), 1, "edited-then-removed item must not survive");
        assert_eq!(held[0]["blocks"][0]["text"], json!("one"));
    }

    #[tokio::test]
    async fn removing_an_unknown_held_id_errors() {
        let st = state_with_session("s1");
        let resp = call(st, "remove_held_message", json!({"session_id": "s1", "id": 999})).await;
        assert!(resp.error.is_some());
    }

    #[tokio::test]
    async fn held_count_syncs_to_instance_and_publishes_change() {
        let st = state_with_session("s1");
        let mut rx = st.notifier.subscribe();
        call(st.clone(), "add_held_message", json!({"session_id": "s1", "blocks": []})).await;
        assert_eq!(st.registry.get("s1").unwrap().held_count, 1);
        let frame = rx.recv().await.expect("instances_changed published");
        assert_eq!(frame["method"], json!("instances_changed"));

        call(st.clone(), "clear_held_messages", json!({"session_id": "s1"})).await;
        assert_eq!(st.registry.get("s1").unwrap().held_count, 0);
    }

    #[tokio::test]
    async fn server_timestamp_advances_across_writes() {
        let st = state_with_session("s1");
        let r1 = call(st.clone(), "set_composer_draft", json!({"session_id": "s1", "text": "a"})).await;
        let t1 = r1.result.unwrap()["updated_at"].as_str().unwrap().to_string();
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        let r2 = call(st, "set_composer_draft", json!({"session_id": "s1", "text": "b"})).await;
        let t2 = r2.result.unwrap()["updated_at"].as_str().unwrap().to_string();
        assert!(t2 > t1, "server timestamp must advance across writes: {t1} vs {t2}");
    }
}
