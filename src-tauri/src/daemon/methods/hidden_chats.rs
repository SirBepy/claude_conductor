//! The sidebar's per-chat Hide/Unhide, shared by every client of this daemon
//! (desktop app and phone) via `sessions::hidden_chats`.

use crate::daemon::rpc::{Router, RpcError};
use crate::daemon::state::DaemonState;
use serde_json::{json, Value};
use std::sync::Arc;

fn view(sessions: &[String]) -> Value {
    json!({"sessions": sessions})
}

/// Applies the delta and, only when it changed something, tells every other
/// client. Clients also refetch when they become visible, since the notifier
/// can drop frames (`project_daemon_notifier_broadcast_lossy`).
fn update_hidden_chats(state: &DaemonState, add: &[String], remove: &[String]) -> Value {
    let (sessions, changed) = crate::sessions::hidden_chats::update(add, remove);
    if changed {
        state.notifier.publish("hidden_chats_changed", view(&sessions));
    }
    view(&sessions)
}

pub fn register_hidden_chats(router: &mut Router, state: Arc<DaemonState>) {
    router.register("get_hidden_chats", move |_params, _ctx| async move {
        Ok(view(&crate::sessions::hidden_chats::list()))
    });
    router.register("update_hidden_chats", move |params, _ctx| {
        let state = state.clone();
        async move {
            #[derive(serde::Deserialize)]
            struct P {
                #[serde(default)]
                add: Vec<String>,
                #[serde(default)]
                remove: Vec<String>,
            }
            let p: P = serde_json::from_value(params.unwrap_or(Value::Null))
                .map_err(|e| RpcError::invalid_params(e.to_string()))?;
            Ok(update_hidden_chats(&state, &p.add, &p.remove))
        }
    });
}
