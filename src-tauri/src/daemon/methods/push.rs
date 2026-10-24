//! `register_fcm_handle`: the Android shell's relay handle, handed over by the
//! phone SPA so the daemon can send native FCM pushes (`daemon::push`).

use crate::daemon::push::FcmHandle;
use crate::daemon::rpc::{Router, RpcError};
use crate::daemon::state::DaemonState;
use serde_json::{json, Value};
use std::sync::Arc;

pub fn register_push(router: &mut Router, state: Arc<DaemonState>) {
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
}
