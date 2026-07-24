//! Usage + token-history RPC methods: read-only mirrors of the desktop
//! `get_history` / `get_token_history` / `get_active_sessions` / `get_usage_map`
//! / `get_auth_state_map` Tauri commands, exposed over the daemon pipe/remote
//! API so the phone homescreen and stats views populate without a Tauri
//! runtime. All read the same shared `companion.db` (via `state.db`) or the
//! same on-disk account files the desktop app itself reads; the daemon is the
//! writer of these records, so the data is always present. `poll_now` (a CDP
//! scrape) stays app-process-only by design and is not mirrored here.

use crate::daemon::rpc::{Router, RpcError};
use crate::daemon::state::DaemonState;
use serde_json::json;
use std::collections::HashMap;
use std::sync::Arc;

pub fn register_usage(router: &mut Router, state: Arc<DaemonState>) {
    // Mirrors `get_history` (params: { limit }) -> Vec<UsageSnapshot>. Snapshots
    // come back ascending by timestamp; `limit` keeps the newest N (trim front).
    {
        let state = state.clone();
        router.register("get_history", move |params, _ctx| {
            let state = state.clone();
            async move {
                #[derive(serde::Deserialize, Default)]
                struct P { limit: Option<u32> }
                let p: P = serde_json::from_value(params.unwrap_or(serde_json::Value::Null)).unwrap_or_default();
                let Some(db) = state.db.clone() else { return Ok(json!([])) };
                let snaps = tokio::task::spawn_blocking(move || {
                    let mgr = db.lock().unwrap_or_else(|e| e.into_inner());
                    let mut all = crate::storage::usage_store::get_all_snapshots(mgr.conn())
                        .unwrap_or_default();
                    if let Some(n) = p.limit {
                        let start = all.len().saturating_sub(n as usize);
                        all = all.split_off(start);
                    }
                    all
                })
                .await
                .map_err(|e| RpcError::internal(format!("join: {e}")))?;
                Ok(json!(snaps))
            }
        });
    }
    // Mirrors `get_token_history` -> Vec<TokenRecord>, filtering empty session
    // ids to match the desktop's `load_history_from_db` behaviour.
    {
        let state = state.clone();
        router.register("get_token_history", move |_params, _ctx| {
            let state = state.clone();
            async move {
                let Some(db) = state.db.clone() else { return Ok(json!([])) };
                let records = tokio::task::spawn_blocking(move || {
                    let mgr = db.lock().unwrap_or_else(|e| e.into_inner());
                    crate::storage::token_store::get_token_records(mgr.conn(), 0)
                        .unwrap_or_default()
                        .into_iter()
                        .filter(|r| !r.session_id.is_empty())
                        .collect::<Vec<_>>()
                })
                .await
                .map_err(|e| RpcError::internal(format!("join: {e}")))?;
                Ok(json!(records))
            }
        });
    }
    // Mirrors `get_active_sessions` -> Vec<TokenRecord>: the in-flight usage
    // derived from the same history (live token merge on the homescreen/stats).
    {
        let state = state.clone();
        router.register("get_active_sessions", move |_params, _ctx| {
            let state = state.clone();
            async move {
                let Some(db) = state.db.clone() else { return Ok(json!([])) };
                let active = tokio::task::spawn_blocking(move || {
                    let mgr = db.lock().unwrap_or_else(|e| e.into_inner());
                    let history = crate::storage::token_store::get_token_records(mgr.conn(), 0)
                        .unwrap_or_default()
                        .into_iter()
                        .filter(|r| !r.session_id.is_empty())
                        .collect::<Vec<_>>();
                    crate::tokens::active_sessions_from_history(&history)
                })
                .await
                .map_err(|e| RpcError::internal(format!("join: {e}")))?;
                Ok(json!(active))
            }
        });
    }
    // Mirrors `get_usage_map` (the desktop Tauri command in `ipc/usage.rs`) ->
    // HashMap<account_id, UsageSnapshot>. Desktop reads this straight out of
    // `AppState.current_usage_by_account`, an in-memory cache the daemon (a
    // separate process) cannot see; instead this reduces the SAME `companion.db`
    // `get_history` already reads down to the newest row per `account_id`.
    // `get_all_snapshots` returns rows ascending by timestamp, so a plain
    // insert-per-row walk naturally leaves the latest snapshot per account in
    // the map (later rows overwrite earlier ones for the same key). Snapshots
    // with no `account_id` (legacy single-cookie poll) are skipped, matching
    // desktop's map which is keyed by `Account.id` only.
    {
        let state = state.clone();
        router.register("get_usage_map", move |_params, _ctx| {
            let state = state.clone();
            async move {
                let Some(db) = state.db.clone() else { return Ok(json!({})) };
                let map = tokio::task::spawn_blocking(move || {
                    let mgr = db.lock().unwrap_or_else(|e| e.into_inner());
                    let all = crate::storage::usage_store::get_all_snapshots(mgr.conn())
                        .unwrap_or_default();
                    let mut map: HashMap<String, crate::types::UsageSnapshot> = HashMap::new();
                    for snap in all {
                        if let Some(id) = snap.account_id.clone() {
                            map.insert(id, snap);
                        }
                    }
                    map
                })
                .await
                .map_err(|e| RpcError::internal(format!("join: {e}")))?;
                Ok(json!(map))
            }
        });
    }
    // Mirrors `get_auth_state_map` (the desktop Tauri command in `ipc/usage.rs`)
    // -> HashMap<account_id, AuthState>. Desktop reads this from
    // `AppState.auth_state_by_account`, which is populated ONLY by the app
    // process's poll loop (`scheduler::do_poll_accounts`) and is never
    // persisted to `companion.db`, `settings.json`, or any other file the
    // daemon can read - so an exact mirror is not possible cross-process.
    // Best available proxy on shared disk: whether each registered account's
    // session-key cookie file (`settings::paths::account_session_file`, the
    // SAME file `do_poll_accounts` itself reads via `auth::session::load`)
    // exists and is non-empty. No file -> `NeedsLogin` (this exactly mirrors
    // `do_poll_accounts`'s own "no session" failure branch). A present file is
    // reported `LoggedIn`; the daemon cannot detect an already-expired-but-
    // present cookie without itself performing a live network poll against
    // claude.ai, which is out of scope for this read-only mirror (every other
    // daemon RPC in this file is a pure disk/db read, never a live external
    // call triggered by a read). `InProgress` is never returned - the daemon
    // doesn't drive the CDP login flow.
    router.register("get_auth_state_map", move |_params, _ctx| {
        async move {
            let accounts = crate::accounts::load_registry();
            let map = tokio::task::spawn_blocking(move || {
                let mut map: HashMap<String, crate::types::AuthState> = HashMap::new();
                for account in accounts {
                    let Ok(path) = crate::settings::paths::account_session_file(&account.id)
                    else {
                        continue;
                    };
                    let auth_state = if crate::auth::session::load(&path).is_some() {
                        crate::types::AuthState::LoggedIn
                    } else {
                        crate::types::AuthState::NeedsLogin
                    };
                    map.insert(account.id, auth_state);
                }
                map
            })
            .await
            .map_err(|e| RpcError::internal(format!("join: {e}")))?;
            Ok(json!(map))
        }
    });
}
