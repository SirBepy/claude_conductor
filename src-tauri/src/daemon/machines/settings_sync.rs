//! The peer half of "same personal settings on every paired machine" (todo
//! pc-1455). The model (which keys, how a stamp wins) is `settings::sync`; the
//! stamps' storage and the settings write are `settings::sync_store`, and both
//! belong to the APP process, which owns `settings.json`. This daemon only moves
//! changes between the app and the paired peers: an incoming call is handed to the
//! app as a `settings_sync_incoming` notification, and what goes out is read from
//! the pushed settings snapshot plus the stamps file beside `settings.json`.
//!
//! Nothing is queued on disk. The state is what travels (every stamped personal key
//! with its value and stamp), so a peer that was unreachable catches up from the
//! next exchange and a change that reaches an app which is not running is simply
//! sent again.

use std::sync::Arc;

use serde::Deserialize;
use serde_json::{json, Value};

use crate::daemon::rpc::{ConnectionContext, Router, RpcError, Transport};
use crate::daemon::state::DaemonState;
use crate::settings::sync::{is_personal, Change};
use crate::settings::sync_store;

/// Most changes one call may carry: a call names each personal key at most once,
/// and the list is a handful. A longer one is refused as a whole.
pub(crate) const MAX_CHANGES: usize = 64;
/// Most one change's value may serialize to. Personal values are small switches,
/// colours and a few lists; this stops a peer filling `settings.json`.
const MAX_VALUE_BYTES: usize = 256 * 1024;

pub fn register(router: &mut Router, state: Arc<DaemonState>) {
    // Machine-only (M in the transport table).
    router.register("settings_sync", move |params, ctx| {
        let state = state.clone();
        async move {
            let req: ExchangeParams = serde_json::from_value(params.unwrap_or(Value::Null))
                .map_err(|e| RpcError::invalid_params(e.to_string()))?;
            handle_exchange(&state, &ctx, req)
        }
    });
}

#[derive(Debug, Deserialize)]
pub(crate) struct ExchangeParams {
    #[serde(default)]
    pub changes: Vec<Change>,
    /// Asks for the receiver's own stamped state in the reply (a pull), which a
    /// machine that just connected uses to catch up.
    #[serde(default)]
    pub want_reply: bool,
}

/// What this machine would send a peer right now: the pushed settings snapshot's
/// stamped personal keys. Empty before the machine registry exists.
pub(crate) fn local_state(state: &DaemonState) -> Vec<Change> {
    let Some(registry) = state.machines.get() else { return Vec::new() };
    let clocks = sync_store::peek_clocks(&registry.app_data().join(sync_store::CLOCKS_FILE));
    sync_store::stamped_state(&state.settings.snapshot(), &clocks)
}

/// Makes a peer's changes safe to hand to the app: only personal keys, values of a
/// sane size, and every stamp's `by` set to the machine the call came from. The
/// sender is what `ctx.transport` says, never what the payload claims (CLAUDE.md,
/// multi-machine). The app's merge still refuses a value that does not fit
/// `Settings` and a stamp that is not a time or is far ahead.
pub(crate) fn sanitize(changes: Vec<Change>, from: &str) -> Result<Vec<Change>, RpcError> {
    if changes.len() > MAX_CHANGES {
        return Err(RpcError::invalid_params(format!("at most {MAX_CHANGES} changes per call")));
    }
    Ok(changes
        .into_iter()
        .filter(|c| is_personal(&c.key))
        .filter(|c| serde_json::to_vec(&c.value).is_ok_and(|v| v.len() <= MAX_VALUE_BYTES))
        .map(|mut c| {
            c.stamp.by = from.to_string();
            c
        })
        .collect())
}

/// Hands changes from machine `from` to the app process, which merges and
/// persists them (the daemon never writes `settings.json`).
pub(crate) fn deliver_to_app(state: &DaemonState, from: &str, changes: &[Change]) {
    if !changes.is_empty() {
        state.notifier.publish("settings_sync_incoming", json!({ "from": from, "changes": changes }));
    }
}

/// A peer's `settings_sync` call. The caller is `ctx.transport`'s machine; the call
/// is refused unless the owner switched "Sync settings" on for that machine here.
pub(crate) fn handle_exchange(state: &Arc<DaemonState>, ctx: &ConnectionContext, req: ExchangeParams) -> Result<Value, RpcError> {
    let Transport::PeerMachine(from) = &ctx.transport else {
        return Err(RpcError::invalid_params("settings_sync is only callable by a peer machine"));
    };
    let registry = state.machines.get().ok_or_else(|| RpcError::internal("machine registry not initialised"))?;
    if !registry.sync_settings(from) {
        return Err(RpcError::invalid_params("settings sync is off for this machine"));
    }
    let changes = sanitize(req.changes, from)?;
    deliver_to_app(state, from, &changes);
    let mut out = json!({ "ok": true });
    if req.want_reply {
        out["changes"] = json!(local_state(state));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::machines::PeerMachine;
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::settings::sync::Stamp;
    use crate::types::Settings;
    use tempfile::tempdir;

    fn change(key: &str, value: Value, by: &str) -> Change {
        Change { key: key.into(), value, stamp: Stamp { at: "2026-11-15T10:00:00Z".into(), by: by.into() } }
    }

    fn state_with_peer(dir: &std::path::Path, settings: Settings) -> Arc<DaemonState> {
        let state = DaemonState::new(new_session_map(), SettingsCache::new(settings));
        state.init_machines(dir.to_path_buf());
        state.machines.get().unwrap().upsert_peer(PeerMachine {
            machine_id: "mac".into(),
            label: "Mac".into(),
            os: "macos".into(),
            iroh_id: None,
            direct_url: None,
            token: "tok".into(),
            reverse_device_id: None,
            added_at: 0,
            icon: None,
        });
        state
    }

    async fn call(state: &Arc<DaemonState>, params: Value, transport: Option<Transport>) -> crate::daemon::rpc::Response {
        let mut r = Router::new();
        register(&mut r, state.clone());
        let (tx, _rx) = tokio::sync::mpsc::channel(16);
        let ctx = match transport {
            Some(t) => crate::daemon::rpc::TRANSPORT.scope(t, async { ConnectionContext::new(tx) }).await,
            None => ConnectionContext::new(tx),
        };
        r.dispatch(
            crate::daemon::rpc::Request { jsonrpc: "2.0".into(), id: json!(1), method: "settings_sync".into(), params: Some(params) },
            ctx,
        )
        .await
    }

    fn from_mac() -> Option<Transport> {
        Some(Transport::PeerMachine("mac".into()))
    }

    #[tokio::test]
    async fn a_peer_with_the_switch_off_is_refused_and_nothing_reaches_the_app() {
        let dir = tempdir().unwrap();
        let state = state_with_peer(dir.path(), Settings::default());
        let mut rx = state.notifier.subscribe();
        let params = json!({"changes": [change("paceBand", json!(1), "mac")]});
        let resp = call(&state, params, from_mac()).await;
        assert_eq!(resp.error.map(|e| e.code), Some(-32602));
        assert!(rx.try_recv().is_err(), "a refused call must not be delivered");
    }

    #[tokio::test]
    async fn only_a_peer_machine_may_call_it_even_with_a_switch_on() {
        let dir = tempdir().unwrap();
        let state = state_with_peer(dir.path(), Settings::default());
        assert!(state.machines.get().unwrap().set_sync_settings("mac", true));
        for transport in [None, Some(Transport::Phone)] {
            let resp = call(&state, json!({"changes": []}), transport).await;
            assert_eq!(resp.error.map(|e| e.code), Some(-32602));
        }
    }

    #[tokio::test]
    async fn an_accepted_call_reaches_the_app_with_the_sender_taken_from_the_transport() {
        let dir = tempdir().unwrap();
        let state = state_with_peer(dir.path(), Settings::default());
        state.machines.get().unwrap().set_sync_settings("mac", true);
        let mut rx = state.notifier.subscribe();
        let params = json!({"changes": [
            change("paceBand", json!(3), "some-other-machine"),
            change("hook_port", json!(1), "mac"),
            change("projects", json!([]), "mac"),
        ]});
        let resp = call(&state, params, from_mac()).await;
        assert!(resp.error.is_none(), "got {:?}", resp.error);
        let frame = rx.try_recv().expect("delivered to the app");
        assert_eq!(frame["method"], "settings_sync_incoming");
        assert_eq!(frame["params"]["from"], "mac");
        let delivered = frame["params"]["changes"].as_array().unwrap();
        assert_eq!(delivered.len(), 1, "machine-local keys never reach the app: {delivered:?}");
        assert_eq!(delivered[0]["key"], "paceBand");
        assert_eq!(delivered[0]["stamp"]["by"], "mac", "a payload cannot claim to be another machine");
    }

    #[tokio::test]
    async fn a_huge_value_is_dropped_and_too_many_changes_are_refused() {
        let dir = tempdir().unwrap();
        let state = state_with_peer(dir.path(), Settings::default());
        state.machines.get().unwrap().set_sync_settings("mac", true);
        let mut rx = state.notifier.subscribe();
        let big = "x".repeat(MAX_VALUE_BYTES + 1);
        let resp = call(&state, json!({"changes": [change("paceColors", json!(big), "mac")]}), from_mac()).await;
        assert!(resp.error.is_none());
        assert!(rx.try_recv().is_err(), "an oversized value is dropped, so nothing is delivered");

        let many: Vec<Change> = (0..=MAX_CHANGES).map(|_| change("paceBand", json!(1), "mac")).collect();
        let resp = call(&state, json!({"changes": many}), from_mac()).await;
        assert_eq!(resp.error.map(|e| e.code), Some(-32602));
    }

    #[tokio::test]
    async fn want_reply_returns_this_machines_stamped_personal_state() {
        let dir = tempdir().unwrap();
        let mut settings = Settings::default();
        settings.poll_interval_secs = 77;
        settings.hook_port = Some(5);
        let state = state_with_peer(dir.path(), settings);
        state.machines.get().unwrap().set_sync_settings("mac", true);
        let mut clocks = crate::settings::sync::Clocks::new();
        let stamp = Stamp { at: "2026-11-15T09:00:00Z".into(), by: "pc".into() };
        clocks.insert("poll_interval_secs".into(), stamp.clone());
        clocks.insert("hook_port".into(), stamp);
        sync_store::save_clocks(&dir.path().join(sync_store::CLOCKS_FILE), &clocks).unwrap();

        let resp = call(&state, json!({"changes": [], "want_reply": true}), from_mac()).await;
        let result = resp.result.expect("answered");
        let sent = result["changes"].as_array().unwrap();
        assert_eq!(sent.len(), 1, "{sent:?}");
        assert_eq!(sent[0]["key"], "poll_interval_secs");
        assert_eq!(sent[0]["value"], 77);

        let resp = call(&state, json!({"changes": []}), from_mac()).await;
        assert!(resp.result.unwrap().get("changes").is_none(), "no reply state unless asked for");
    }
}
