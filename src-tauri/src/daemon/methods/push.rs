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
    let revoke_state = state.clone();
    router.register("register_fcm_handle", move |params, ctx| {
        let state = state.clone();
        async move {
            let h: FcmHandle = serde_json::from_value(params.unwrap_or(Value::Null))
                .map_err(|e| RpcError::invalid_params(e.to_string()))?;
            let Some(pm) = state.push.get() else {
                return Err(RpcError::invalid_params("push is not initialised".to_string()));
            };
            // The device id comes from the authenticated connection: params are
            // untrusted, so a phone must not be able to file its handle under
            // another device (which would let that device's revoke drop it).
            let ok = match ctx.device_id.as_deref() {
                Some(device_id) => pm.register_fcm_handle_for_device(h, device_id),
                None => pm.register_fcm_handle(h),
            };
            if !ok {
                return Err(RpcError::invalid_params("handle or secret is empty or too long".to_string()));
            }
            Ok(json!({ "ok": true }))
        }
    });

    // Revoke runs here, not in the app process, because only the daemon owns
    // the FCM handle list. Desktop-pipe only: absent from `TRANSPORT_TABLE`.
    router.register("revoke_remote_device", move |params, _ctx| {
        let state = revoke_state.clone();
        async move {
            let Some(id) = params.as_ref().and_then(|p| p.get("id")).and_then(Value::as_str) else {
                return Err(RpcError::invalid_params("id must be a string".to_string()));
            };
            let app_data = crate::settings::paths::data_dir().map_err(|e| RpcError::internal(e.to_string()))?;
            let revoked = revoke_device_and_handles(&state, id, &app_data).map_err(RpcError::internal)?;
            Ok(json!(revoked))
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

/// Removes the device from the registry and drops the push handles it enrolled.
/// Handles are pruned even when the device was already gone, so a retry after a
/// partial failure still cleans up.
fn revoke_device_and_handles(state: &DaemonState, id: &str, app_data: &std::path::Path) -> Result<bool, String> {
    let revoked = crate::daemon::device_registry::DeviceRegistry::revoke_device(id, app_data)?;
    if let Some(pm) = state.push.get() {
        pm.unregister_fcm_handles_for_device(id);
    }
    Ok(revoked)
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

    async fn register_over(transport: crate::daemon::rpc::Transport, device: Option<&str>, router: &Router) -> crate::daemon::rpc::Response {
        use crate::daemon::rpc::{DEVICE_ID, TRANSPORT};
        let req = Request {
            jsonrpc: "2.0".into(),
            id: json!(1),
            method: "register_fcm_handle".into(),
            // The params lie about which device this is.
            params: Some(json!({ "handle": "h1", "secret": "s1", "device_id": "forged-dev" })),
        };
        let device = device.map(str::to_string);
        DEVICE_ID
            .scope(device, TRANSPORT.scope(transport, async {
                let (tx, _rx) = tokio::sync::mpsc::channel(16);
                router.dispatch(req, ConnectionContext::new(tx)).await
            }))
            .await
    }

    fn push_state(dir: &std::path::Path) -> Arc<DaemonState> {
        let state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        state.init_push(dir.to_path_buf());
        state
    }

    #[tokio::test]
    async fn register_fcm_handle_records_the_connections_device_not_the_params() {
        let dir = tempfile::tempdir().unwrap();
        let state = push_state(dir.path());
        let mut r = Router::new();
        register_push(&mut r, state.clone());

        let resp = register_over(crate::daemon::rpc::Transport::Phone, Some("real-dev"), &r).await;
        assert!(resp.error.is_none(), "{:?}", resp.error);
        let pm = state.push.get().unwrap();
        assert_eq!(pm.unregister_fcm_handles_for_device("forged-dev"), 0);
        assert_eq!(pm.unregister_fcm_handles_for_device("real-dev"), 1);
    }

    #[tokio::test]
    async fn register_fcm_handle_without_a_device_keeps_no_owner() {
        let dir = tempfile::tempdir().unwrap();
        let state = push_state(dir.path());
        let mut r = Router::new();
        register_push(&mut r, state.clone());

        let resp = register_over(crate::daemon::rpc::Transport::Local, None, &r).await;
        assert!(resp.error.is_none(), "{:?}", resp.error);
        assert_eq!(state.push.get().unwrap().unregister_fcm_handles_for_device("forged-dev"), 0);
    }

    #[test]
    fn revoking_a_device_drops_its_push_handles() {
        use crate::daemon::device_registry::DeviceRegistry;
        let dir = tempfile::tempdir().unwrap();
        let state = push_state(dir.path());
        DeviceRegistry::add_device("Phone", dir.path()).unwrap();
        let id = DeviceRegistry::list_devices(dir.path()).into_iter().find(|d| d.name == "Phone").unwrap().id;
        let pm = state.push.get().unwrap();
        assert!(pm.register_fcm_handle_for_device(FcmHandle { handle: "h1".into(), secret: "s".into(), device_id: None }, &id));

        assert!(revoke_device_and_handles(&state, &id, dir.path()).unwrap());
        assert!(!DeviceRegistry::list_devices(dir.path()).iter().any(|d| d.id == id));
        assert_eq!(pm.unregister_fcm_handles_for_device(&id), 0, "handle already dropped by the revoke");
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
