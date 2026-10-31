//! Scheduled-message / scheduled-new-chat RPC methods. The daemon is the sole
//! writer of `scheduled-items.json` (mirrors `chat-config.json`'s "daemon
//! sole writer" rule): every mutation goes through one of these methods so it
//! composes correctly with the scheduler tick loop (`daemon::schedule`)
//! reading and rewriting the same file. The desktop app still reads
//! `scheduled-items.json` directly for its own `schedule_list` Tauri command
//! (same as `get_session_config` / `list_auto_accept` read `chat-config.json`
//! directly), but every method here is ALSO a daemon RPC so the phone - which
//! has no Tauri runtime and no direct filesystem access - can use the same
//! items. `schedule_list` and the mutators (`schedule_create` / `_update` /
//! `_delete` / `_fire_now`) are all phone-reachable (`P` in
//! `remote_transport_table.rs`, see its rationale comment).

use crate::daemon::rpc::{Router, RpcError, Transport};
use crate::daemon::state::DaemonState;
use crate::sessions::scheduled_items::{self, Recurrence, ScheduledItem, ScheduledKind};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

#[derive(Debug, Deserialize)]
struct CreateParams {
    kind: ScheduledKind,
    prompt: String,
    fire_at: String,
    #[serde(default)]
    recurrence: Option<Recurrence>,
    /// Arbitrary shell command, so only the desktop pipe may supply one.
    #[serde(default)]
    guard: Option<String>,
}

#[derive(Debug, Deserialize)]
struct IdParams {
    id: String,
}

const GUARD_LOCAL_ONLY: &str = "a pre-fire guard is a shell command, so it can only be set from the desktop app";

pub fn register_schedule(router: &mut Router, state: Arc<DaemonState>) {
    // Read-only: mirrors the desktop `schedule_list` Tauri command's JSON
    // shape (`Vec<ScheduledItem>`). Exposed over the remote-access API so the
    // phone's scheduled-chip and Schedule view populate (ai_todo 257) - without
    // this, `HttpTransport.call("schedule_list")` fell through to
    // `RemoteUnavailableError` and both surfaces silently rendered nothing.
    router.register("schedule_list", move |_params, _ctx| {
        async move { Ok(json!(scheduled_items::list())) }
    });

    {
        let state = state.clone();
        router.register("schedule_create", move |params, ctx| {
            let state = state.clone();
            async move {
                let p: CreateParams = serde_json::from_value(params.unwrap_or(Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                // Refused rather than dropped: a guarded schedule silently
                // created without its guard would fire on days it should skip.
                if p.guard.is_some() && ctx.transport != Transport::Local {
                    return Err(RpcError::invalid_params(GUARD_LOCAL_ONLY));
                }
                let mut item = ScheduledItem::new(p.kind, p.prompt, p.fire_at, p.recurrence);
                item.guard = scheduled_items::normalize_guard(p.guard.as_deref()).map(str::to_string);
                scheduled_items::upsert(item.clone());
                publish_changed(&state);
                serde_json::to_value(&item).map_err(|e| RpcError::internal(e.to_string()))
            }
        });
    }

    {
        let state = state.clone();
        router.register("schedule_update", move |params, ctx| {
            let state = state.clone();
            async move {
                let mut item: ScheduledItem = serde_json::from_value(params.unwrap_or(Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                if item.id.is_empty() {
                    return Err(RpcError::invalid_params("schedule_update: id must not be empty"));
                }
                let Some(stored) = scheduled_items::get(&item.id) else {
                    return Err(RpcError {
                        code: -32004,
                        message: format!("scheduled item {} not found", item.id),
                        data: None,
                    });
                };
                // The update carries the whole record, so a phone or peer
                // editing a time would otherwise be free to rewrite the
                // command. Keep what is stored instead of erroring: an older
                // client round-trips the item without the field at all.
                item.guard = guard_after_update(&ctx.transport, item.guard, stored.guard);
                item.after_meeting = after_meeting_after_update(item.after_meeting, stored.after_meeting);
                scheduled_items::upsert(item);
                publish_changed(&state);
                Ok(json!({"ok": true}))
            }
        });
    }

    {
        let state = state.clone();
        router.register("schedule_delete", move |params, _ctx| {
            let state = state.clone();
            async move {
                let p: IdParams = serde_json::from_value(params.unwrap_or(Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                let existed = scheduled_items::delete(&p.id);
                if existed {
                    publish_changed(&state);
                }
                Ok(json!({"ok": existed}))
            }
        });
    }

    {
        let state = state.clone();
        router.register("schedule_fire_now", move |params, _ctx| {
            let state = state.clone();
            async move {
                let p: IdParams = serde_json::from_value(params.unwrap_or(Value::Null))
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                crate::daemon::schedule::fire_now(&state, &p.id).await;
                Ok(json!({"ok": true}))
            }
        });
    }
}

/// Which guard an update writes: the desktop's own value, a blank one cleared,
/// and for any other transport always the stored one.
fn guard_after_update(transport: &Transport, incoming: Option<String>, stored: Option<String>) -> Option<String> {
    if *transport != Transport::Local {
        return stored;
    }
    scheduled_items::normalize_guard(incoming.as_deref()).map(str::to_string)
}

/// The meeting gate an update writes. A client that predates the field
/// round-trips the record without it (the field is skipped when `None`), and
/// that must not turn a gated item into an ungated one; an explicit value wins.
fn after_meeting_after_update(incoming: Option<bool>, stored: Option<bool>) -> Option<bool> {
    incoming.or(stored)
}

/// Mirrors `daemon::schedule`'s own `notify_changed` exactly (same notifier
/// method name and payload shape): Defect 5 was that these RPC handlers never
/// published, so the schedule view only ever caught up when the next tick (or
/// a manual reload) happened to run.
pub(crate) fn publish_changed(state: &Arc<DaemonState>) {
    state.notifier.publish(
        "scheduled_items_changed",
        json!({ "items": scheduled_items::list() }),
    );
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

    fn dummy_state() -> Arc<DaemonState> {
        DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()))
    }

    #[tokio::test]
    async fn schedule_update_unknown_id_returns_not_found() {
        let mut r = Router::new();
        register_schedule(&mut r, dummy_state());
        let item = ScheduledItem::new(
            ScheduledKind::Message { session_id: "s".into(), cwd: "C:/x".into() },
            "hi".into(),
            "2026-01-01T00:00:00Z".into(),
            None,
        );
        let resp = r.dispatch(Request {
            jsonrpc: "2.0".into(),
            id: json!(1),
            method: "schedule_update".into(),
            params: Some(serde_json::to_value(&item).unwrap()),
        }, dummy_ctx()).await;
        assert_eq!(resp.error.as_ref().map(|e| e.code), Some(-32004));
    }

    #[tokio::test]
    async fn schedule_create_with_a_guard_is_refused_from_a_phone_and_a_peer() {
        for transport in [Transport::Phone, Transport::PeerMachine("m1".into())] {
            let mut r = Router::new();
            register_schedule(&mut r, dummy_state());
            let mut ctx = dummy_ctx();
            ctx.transport = transport;
            let resp = r.dispatch(Request {
                jsonrpc: "2.0".into(),
                id: json!(1),
                method: "schedule_create".into(),
                params: Some(json!({
                    "kind": {"type": "message", "session_id": "s", "cwd": "C:/x"},
                    "prompt": "hi",
                    "fire_at": "2026-01-01T00:00:00Z",
                    "guard": "exit 0",
                })),
            }, ctx).await;
            let err = resp.error.expect("a guard from a remote transport must be refused");
            assert!(err.message.contains("desktop"), "{}", err.message);
        }
    }

    #[test]
    fn only_the_desktop_pipe_changes_a_guard_on_update() {
        let stored = Some("check.ps1".to_string());
        assert_eq!(guard_after_update(&Transport::Phone, None, stored.clone()), stored, "a phone's reschedule keeps it");
        assert_eq!(
            guard_after_update(&Transport::Phone, Some("rm -rf".into()), stored.clone()),
            stored,
            "a phone cannot rewrite it"
        );
        assert_eq!(guard_after_update(&Transport::Local, Some("new.ps1".into()), stored.clone()), Some("new.ps1".into()));
        assert_eq!(guard_after_update(&Transport::Local, Some("  ".into()), stored.clone()), None, "blank clears it");
        assert_eq!(
            guard_after_update(&Transport::Local, Some("  new.ps1 ".into()), stored),
            Some("new.ps1".into()),
            "stored trimmed, same as an MCP-created one"
        );
    }

    #[test]
    fn an_update_without_the_meeting_gate_keeps_the_stored_one() {
        assert_eq!(after_meeting_after_update(None, Some(true)), Some(true), "an older client's round trip keeps it");
        assert_eq!(after_meeting_after_update(None, None), None);
        assert_eq!(after_meeting_after_update(Some(false), Some(true)), Some(false), "an explicit off wins");
        assert_eq!(after_meeting_after_update(Some(true), None), Some(true), "an explicit on wins");
    }

    #[tokio::test]
    async fn schedule_delete_unknown_id_reports_ok_false() {
        let mut r = Router::new();
        register_schedule(&mut r, dummy_state());
        let resp = r.dispatch(Request {
            jsonrpc: "2.0".into(),
            id: json!(1),
            method: "schedule_delete".into(),
            params: Some(json!({"id": "ghost"})),
        }, dummy_ctx()).await;
        assert!(resp.error.is_none());
        assert_eq!(resp.result, Some(json!({"ok": false})));
    }

    #[tokio::test]
    async fn schedule_fire_now_unknown_id_is_ok_noop() {
        let mut r = Router::new();
        register_schedule(&mut r, dummy_state());
        let resp = r.dispatch(Request {
            jsonrpc: "2.0".into(),
            id: json!(1),
            method: "schedule_fire_now".into(),
            params: Some(json!({"id": "ghost"})),
        }, dummy_ctx()).await;
        assert!(resp.error.is_none(), "got {:?}", resp.error);
    }
}
