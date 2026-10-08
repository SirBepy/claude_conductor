//! The sidebar's per-chat Hide/Unhide and project-rail filter, shared by every
//! client of this daemon (desktop app and phone) via `sessions::hidden_chats`.

use crate::daemon::rpc::{Router, RpcError};
use crate::daemon::state::DaemonState;
use crate::sessions::hidden_chats::{HiddenDelta, HiddenLists};
use serde_json::{json, Value};
use std::sync::Arc;

fn view(lists: &HiddenLists) -> Value {
    json!({"sessions": lists.sessions, "projects": lists.projects})
}

/// Applies the delta and, only when it changed something, tells every other
/// client. Clients also refetch when they become visible, since the notifier
/// can drop frames (`project_daemon_notifier_broadcast_lossy`).
fn update_hidden_chats(state: &DaemonState, delta: &HiddenDelta) -> Value {
    let (lists, changed) = crate::sessions::hidden_chats::update(delta);
    if changed {
        state.notifier.publish("hidden_chats_changed", view(&lists));
    }
    view(&lists)
}

pub fn register_hidden_chats(router: &mut Router, state: Arc<DaemonState>) {
    router.register("get_hidden_chats", move |_params, _ctx| async move {
        Ok(view(&crate::sessions::hidden_chats::list()))
    });
    router.register("update_hidden_chats", move |params, _ctx| {
        let state = state.clone();
        async move {
            let delta: HiddenDelta = serde_json::from_value(params.unwrap_or(Value::Null))
                .map_err(|e| RpcError::invalid_params(e.to_string()))?;
            Ok(update_hidden_chats(&state, &delta))
        }
    });
}
