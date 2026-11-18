//! `set_chat_heads_order`: the phone's durable chat-head drag. The head order is the
//! one `Settings.extra` key `chatHeadsOrder` (ids, in order), shared by every client
//! of this daemon. The phone is refused `save_settings`, so this is its narrow write
//! path: one key, a validated list of ids, never a free-form settings patch.

use crate::daemon::rpc::{Router, RpcError};
use crate::daemon::state::DaemonState;
use serde_json::{json, Value};
use std::sync::Arc;

/// The `Settings.extra` key the heads read (`HEAD_ORDER_KEY` in `chat-heads-model.ts`).
pub const CHAT_HEADS_ORDER_KEY: &str = "chatHeadsOrder";

/// Same cap as the front end's `MAX_ORDER_IDS`: the list only ever grows by what Joe drags.
const MAX_IDS: usize = 300;
/// Session ids and draft placeholder ids are short; a longer string is not one.
const MAX_ID_LEN: usize = 200;

/// The order to store, or why the params are not one. Duplicates keep their first place.
fn validated(params: Option<&Value>) -> Result<Vec<String>, RpcError> {
    let Some(items) = params.and_then(|p| p.get("order")).and_then(Value::as_array) else {
        return Err(RpcError::invalid_params("order must be a list of ids".to_string()));
    };
    if items.len() > MAX_IDS {
        return Err(RpcError::invalid_params(format!("order holds at most {MAX_IDS} ids")));
    }
    let mut out: Vec<String> = Vec::with_capacity(items.len());
    for item in items {
        match item.as_str() {
            Some(id) if !id.is_empty() && id.len() <= MAX_ID_LEN => {
                if !out.iter().any(|seen| seen == id) {
                    out.push(id.to_string());
                }
            }
            _ => return Err(RpcError::invalid_params(format!("each id must be a string of 1 to {MAX_ID_LEN} characters"))),
        }
    }
    Ok(out)
}

pub fn register_chat_heads_order(router: &mut Router, state: Arc<DaemonState>) {
    router.register("set_chat_heads_order", move |params, _ctx| {
        let state = state.clone();
        async move {
            let order = validated(params.as_ref())?;
            let value = json!(order);
            state.settings.set_extra_value(CHAT_HEADS_ORDER_KEY, value.clone());
            // The app process owns settings.json: it merges and persists on this event.
            state.notifier.publish("chat_heads_order_set", json!({ "order": value }));
            Ok(json!({ "ok": true }))
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

    async fn call(router: &Router, params: Value) -> crate::daemon::rpc::Response {
        let (tx, _rx) = tokio::sync::mpsc::channel(16);
        router
            .dispatch(
                Request { jsonrpc: "2.0".into(), id: json!(1), method: "set_chat_heads_order".into(), params: Some(params) },
                ConnectionContext::new(tx),
            )
            .await
    }

    fn setup() -> (Arc<DaemonState>, Router) {
        let mut s = Settings::default();
        s.hook_port = Some(4242);
        s.extra.insert("pauseInMeeting".into(), json!(false));
        let state = DaemonState::new(new_session_map(), SettingsCache::new(s));
        let mut r = Router::new();
        register_chat_heads_order(&mut r, state.clone());
        (state, r)
    }

    #[tokio::test]
    async fn stores_the_order_under_its_own_key_and_nothing_else() {
        let (state, r) = setup();
        let resp = call(&r, json!({ "order": ["b", "a", "b", "c"] })).await;
        assert_eq!(resp.result.unwrap(), json!({ "ok": true }));
        let snap = state.settings.snapshot();
        assert_eq!(snap.extra.get(CHAT_HEADS_ORDER_KEY), Some(&json!(["b", "a", "c"])), "a repeated id keeps its first place");
        assert_eq!(snap.hook_port, Some(4242));
        assert_eq!(snap.extra.get("pauseInMeeting"), Some(&json!(false)));
        assert_eq!(snap.extra.len(), 2);
    }

    #[tokio::test]
    async fn an_empty_order_is_a_valid_reset() {
        let (state, r) = setup();
        call(&r, json!({ "order": ["a"] })).await;
        let resp = call(&r, json!({ "order": [] })).await;
        assert!(resp.error.is_none());
        assert_eq!(state.settings.snapshot().extra.get(CHAT_HEADS_ORDER_KEY), Some(&json!([])));
    }

    #[tokio::test]
    async fn a_bad_order_is_refused_and_leaves_the_stored_one() {
        let (state, r) = setup();
        call(&r, json!({ "order": ["keep"] })).await;
        let too_many: Vec<String> = (0..=MAX_IDS).map(|n| format!("id-{n}")).collect();
        for bad in [
            json!({}),
            json!({ "order": "a" }),
            json!({ "order": ["a", 3] }),
            json!({ "order": ["a", ""] }),
            json!({ "order": ["x".repeat(MAX_ID_LEN + 1)] }),
            json!({ "order": too_many }),
        ] {
            let resp = call(&r, bad.clone()).await;
            assert!(resp.error.is_some(), "{bad} must be refused");
        }
        assert_eq!(state.settings.snapshot().extra.get(CHAT_HEADS_ORDER_KEY), Some(&json!(["keep"])));
    }

    #[tokio::test]
    async fn the_app_process_is_told_to_persist_the_same_order() {
        let (state, r) = setup();
        let mut rx = state.notifier.subscribe();
        call(&r, json!({ "order": ["a", "b"] })).await;
        let frame = rx.try_recv().expect("the app process is told");
        assert_eq!(frame["method"], "chat_heads_order_set");
        let params = frame["params"].clone();
        assert_eq!(params, json!({ "order": ["a", "b"] }));
    }
}
