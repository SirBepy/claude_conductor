//! Phone RPC mirror of the desktop `chat_drains` Tauri command
//! (`ipc::drain::chat_drains`) - the sidebar's token-drain sort (todo 1022,
//! split from todo 1007's reachability table, which had no daemon RPC for
//! this at all). Reuses `ipc::drain::drain_board` so the leaderboard math
//! (capacity calibration, window-size percents) is byte-identical to desktop;
//! only session resolution and the usage-window context differ, since the
//! daemon has no `AppState` to read.

use crate::daemon::rpc::{Router, RpcError};
use crate::daemon::state::DaemonState;
use crate::ipc::drain::{drain_board, resolve_instance_transcript, resolve_session_from_history, windows_from_snapshot, DrainBoard};
use serde_json::json;
use std::path::PathBuf;
use std::sync::Arc;

/// Resolve `(cwd, transcript)` for one session id the way the desktop's
/// `resolve_session` does, but against the daemon's own live `Registry`
/// (`state.registry`) instead of `AppState.cached_instances` - same
/// live-then-history-fallback order (see `ipc::drain`'s module doc).
fn resolve_session(session_id: &str, state: &DaemonState) -> Option<(PathBuf, PathBuf)> {
    if let Some(inst) = state.registry.list().into_iter().find(|i| i.session_id == session_id) {
        if let Some(t) = resolve_instance_transcript(&inst.cwd, session_id, inst.transcript_path.as_deref()) {
            return Some((inst.cwd.clone(), t));
        }
    }
    resolve_session_from_history(session_id)
}

/// Mirrors `AppState.current_usage`'s derivation - see `state.rs`'s doc
/// comment ("mirrors the default account's own entry ... once accounts are
/// registered") and `scheduler.rs::do_poll`/`do_poll_accounts` (`do_poll`
/// always writes the branch's result into `current_usage`; the per-account
/// branch picks `Settings.default_account_id`, falling back to the first
/// successful account, while the legacy branch writes a single `account_id:
/// None` row). Reduced here from the SAME `companion.db` rows `get_usage_map`
/// reads: the default account's own latest snapshot when one is configured,
/// else the latest legacy (`account_id: None`) snapshot, else (no default
/// configured and no legacy row) the newest snapshot of any kind. `None` when
/// there is no snapshot at all yet, matching `AppState.current_usage`'s
/// initial `None` before the first poll. `all` is ascending by timestamp
/// (`get_all_snapshots`'s contract), so scanning from the end finds the
/// latest match.
fn latest_current_usage_snapshot(
    all: Vec<crate::types::UsageSnapshot>,
    default_account_id: Option<&str>,
) -> Option<crate::types::UsageSnapshot> {
    if let Some(id) = default_account_id {
        if let Some(s) = all.iter().rev().find(|s| s.account_id.as_deref() == Some(id)) {
            return Some(s.clone());
        }
    }
    if let Some(s) = all.iter().rev().find(|s| s.account_id.is_none()) {
        return Some(s.clone());
    }
    all.into_iter().last()
}

pub fn register_drain(router: &mut Router, state: Arc<DaemonState>) {
    router.register("chat_drains", move |params, _ctx| {
        let state = state.clone();
        async move {
            #[derive(serde::Deserialize)]
            struct P {
                session_ids: Vec<String>,
            }
            let p: P = serde_json::from_value(params.unwrap_or(serde_json::Value::Null))
                .map_err(|e| RpcError::invalid_params(e.to_string()))?;

            // Drop any id that isn't a plausible session id BEFORE it's used to
            // build a filesystem path (resolve_session_from_history joins it
            // straight into `<projects>/<dir>/<id>.jsonl`) - same charset guard
            // `paste_attachment`/`load_history` use for the same reason.
            let ids: Vec<String> = p
                .session_ids
                .into_iter()
                .filter(|id| crate::ipc::chat::attachments::validate_session_id(id).is_ok())
                .collect();

            let mut resolved: Vec<(String, PathBuf, PathBuf)> = Vec::new();
            for id in &ids {
                if let Some((cwd, transcript)) = resolve_session(id, &state) {
                    resolved.push((id.clone(), cwd, transcript));
                }
            }

            let default_account_id = state.settings.snapshot().default_account_id;
            let (five, weekly) = match state.db.clone() {
                Some(db) => tokio::task::spawn_blocking(move || {
                    let mgr = db.lock().unwrap_or_else(|e| e.into_inner());
                    let all = crate::storage::usage_store::get_all_snapshots(mgr.conn()).unwrap_or_default();
                    let snap = latest_current_usage_snapshot(all, default_account_id.as_deref());
                    windows_from_snapshot(snap.as_ref())
                })
                .await
                .map_err(|e| RpcError::internal(format!("join: {e}")))?,
                // No DB open on this daemon - same "unknown" pair the desktop
                // command's `windows_from_state` returns before the first poll.
                None => windows_from_snapshot(None),
            };

            let board: DrainBoard = tokio::task::spawn_blocking(move || drain_board(&resolved, &five, &weekly))
                .await
                .map_err(|e| RpcError::internal(format!("join: {e}")))?;
            Ok(json!(board))
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

    fn state() -> Arc<DaemonState> {
        DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()))
    }

    async fn call(state: Arc<DaemonState>, params: serde_json::Value) -> crate::daemon::rpc::Response {
        let mut r = Router::new();
        register_drain(&mut r, state);
        r.dispatch(
            Request { jsonrpc: "2.0".into(), id: json!(1), method: "chat_drains".into(), params: Some(params) },
            dummy_ctx(),
        )
        .await
    }

    /// `validate_session_id` (shared with `paste_attachment`/`load_history`)
    /// rejects anything outside `[A-Za-z0-9_-]` - a traversal-shaped id like
    /// `../x` never reaches `resolve_session_from_history`'s path join.
    #[test]
    fn traversal_shaped_ids_fail_validation() {
        assert!(crate::ipc::chat::attachments::validate_session_id("../x").is_err());
        assert!(crate::ipc::chat::attachments::validate_session_id("safe-id-1").is_ok());
    }

    #[tokio::test]
    async fn dispatches_and_drops_an_unresolvable_or_invalid_id() {
        // Neither id resolves (no registry entry, no history file for either
        // on this machine) - "../x" is dropped by validation before it would
        // even reach the history-scan fallback, "unknown-id" is dropped by the
        // fallback finding nothing. Board comes back empty, not an error.
        let resp = call(state(), json!({"session_ids": ["../x", "unknown-id"]})).await;
        assert!(resp.error.is_none(), "got {:?}", resp.error);
        let chats = resp.result.unwrap()["chats"].as_object().cloned().unwrap();
        assert!(chats.is_empty(), "expected no resolvable sessions, got {chats:?}");
    }
}
