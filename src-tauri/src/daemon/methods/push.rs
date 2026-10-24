//! `register_fcm_handle`: the Android shell's relay handle, handed over by the
//! phone SPA so the daemon can send native FCM pushes (`daemon::push`), and
//! `set_push_show_chat_name`, the one setting the phone may flip.

use crate::daemon::push::FcmHandle;
use crate::daemon::rpc::{Router, RpcError};
use crate::daemon::state::DaemonState;
use serde_json::{json, Value};
use std::sync::Arc;

pub fn register_push(router: &mut Router, state: Arc<DaemonState>) {
    let show_name_state = state.clone();
    router.register("register_fcm_handle", move |params, _ctx| {
        let state = state.clone();
        async move {
            let h: FcmHandle = serde_json::from_value(params.unwrap_or(Value::Null))
                .map_err(|e| RpcError::invalid_params(e.to_string()))?;
            let Some(pm) = state.push.get() else {
                return Err(RpcError::invalid_params("push is not initialised".to_string()));
            };
            if !pm.register_fcm_handle(h) {
                return Err(RpcError::invalid_params("handle or secret is empty or too long".to_string()));
            }
            Ok(json!({ "ok": true }))
        }
    });

    // The phone is refused `save_settings`, so this is its single narrow write
    // path: one boolean key, validated, never a free-form settings patch.
    let state = show_name_state;
    router.register("set_push_show_chat_name", move |params, _ctx| {
        let state = state.clone();
        async move {
            let Some(value) = params.as_ref().and_then(|p| p.get("value")).and_then(Value::as_bool) else {
                return Err(RpcError::invalid_params("value must be a boolean".to_string()));
            };
            state.settings.set_extra_bool(PUSH_SHOW_CHAT_NAME_KEY, value);
            // The app process owns settings.json: it merges and persists on this event.
            state.notifier.publish("push_show_chat_name_set", json!({ "value": value }));
            Ok(json!({ "ok": true }))
        }
    });
}

/// The `Settings.extra` key read by `Settings::push_show_chat_name`.
pub const PUSH_SHOW_CHAT_NAME_KEY: &str = "pushShowChatName";

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
                Request { jsonrpc: "2.0".into(), id: json!(1), method: "set_push_show_chat_name".into(), params: Some(params) },
                ConnectionContext::new(tx),
            )
            .await
    }

    #[tokio::test]
    async fn set_push_show_chat_name_changes_only_that_key() {
        let mut s = Settings::default();
        s.hook_port = Some(4242);
        s.extra.insert("pauseInMeeting".into(), json!(false));
        let state = DaemonState::new(new_session_map(), SettingsCache::new(s));
        let mut r = Router::new();
        register_push(&mut r, state.clone());

        let resp = call(&r, json!({ "value": false })).await;
        assert_eq!(resp.result.unwrap(), json!({ "ok": true }));
        let snap = state.settings.snapshot();
        assert!(!snap.push_show_chat_name());
        assert_eq!(snap.hook_port, Some(4242));
        assert_eq!(snap.extra.get("pauseInMeeting"), Some(&json!(false)));
        assert_eq!(snap.extra.len(), 2);
    }

    #[tokio::test]
    async fn set_push_show_chat_name_rejects_a_non_bool() {
        let state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        let mut r = Router::new();
        register_push(&mut r, state.clone());
        for bad in [json!({ "value": "no" }), json!({ "value": 0 }), json!({}), Value::Null] {
            let resp = call(&r, bad).await;
            assert_eq!(resp.error.unwrap().code, -32602);
        }
        assert!(state.settings.snapshot().push_show_chat_name());
    }
}
