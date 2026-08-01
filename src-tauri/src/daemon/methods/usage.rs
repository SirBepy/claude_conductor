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

/// Snapshots come back ascending by timestamp, so a plain insert-per-row walk
/// naturally leaves the latest snapshot per account in the map. Shared by
/// `get_usage_map` and `request_live_usage_refresh` below, and by
/// `jarvis_fleet::five_hour_utilization_by_account` (todo 330).
pub(crate) fn reduce_to_latest_per_account(
    rows: Vec<crate::types::UsageSnapshot>,
) -> HashMap<String, crate::types::UsageSnapshot> {
    let mut map: HashMap<String, crate::types::UsageSnapshot> = HashMap::new();
    for snap in rows {
        if let Some(id) = snap.account_id.clone() {
            map.insert(id, snap);
        }
    }
    map
}

/// The newest `captured_at` across every snapshot in the DB, used by
/// `request_live_usage_refresh` to detect once the app's triggered poll has
/// actually written a fresh row (called once for the baseline, then again on
/// each poll of the wait loop).
async fn latest_captured_at(
    db: Arc<std::sync::Mutex<crate::storage::StorageManager>>,
) -> Result<Option<String>, RpcError> {
    tokio::task::spawn_blocking(move || {
        let mgr = db.lock().unwrap_or_else(|e| e.into_inner());
        crate::storage::usage_store::get_all_snapshots(mgr.conn())
            .unwrap_or_default()
            .into_iter()
            .map(|s| s.captured_at)
            .max()
    })
    .await
    .map_err(|e| RpcError::internal(format!("join: {e}")))
}

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
                    reduce_to_latest_per_account(all)
                })
                .await
                .map_err(|e| RpcError::internal(format!("join: {e}")))?;
                Ok(json!(map))
            }
        });
    }
    // Click-to-refresh from the remote/phone usage dials (ai_todo: live-poll
    // refresh). The daemon itself can never do the cookie-authed HTTPS poll -
    // that stays app-process-only, same reason `poll_now` isn't mirrored above.
    // Instead this asks the CONNECTED app process to do it: publish
    // "usage_poll_requested" over the same global notifier the app already
    // subscribes to (see daemon_link.rs's `handle_daemon_notification`), whose
    // `publish` return value (subscriber count) doubles as an instant "is the
    // app even running" check - a paired phone with the app not open would
    // otherwise hang for the full timeout for no reason. Then poll `companion.db`
    // for a snapshot fresher than the baseline captured just before publishing;
    // the app's poll writes there the same way the scheduler's tick does. This
    // is a best-effort wait, not a true request/response - the app has no
    // reverse channel to say "here's your answer" directly (see the doc
    // comment above other read-only mirrors in this file), so a slow/failed
    // poll on the app side just falls through the timeout and returns whatever
    // is latest in the DB instead of hanging or erroring.
    {
        let state = state.clone();
        router.register("request_live_usage_refresh", move |params, _ctx| {
            let state = state.clone();
            async move {
                #[derive(serde::Deserialize, Default)]
                struct P {
                    account_id: Option<String>,
                }
                let p: P = serde_json::from_value(params.unwrap_or(serde_json::Value::Null))
                    .unwrap_or_default();
                let Some(db) = state.db.clone() else {
                    return Err(RpcError::internal("companion.db is not open on the daemon"));
                };

                let baseline = latest_captured_at(db.clone()).await?;

                let heard = state
                    .notifier
                    .publish("usage_poll_requested", json!({ "account_id": p.account_id }));
                if heard == 0 {
                    return Err(RpcError::internal(
                        "desktop app is not running - open it to refresh usage",
                    ));
                }

                let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(12);
                loop {
                    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
                    let latest = latest_captured_at(db.clone()).await?;
                    if latest > baseline || tokio::time::Instant::now() >= deadline {
                        break;
                    }
                }

                let map = tokio::task::spawn_blocking(move || {
                    let mgr = db.lock().unwrap_or_else(|e| e.into_inner());
                    let all = crate::storage::usage_store::get_all_snapshots(mgr.conn())
                        .unwrap_or_default();
                    reduce_to_latest_per_account(all)
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

    // Pipe-side push from the app's scheduler (`scheduler::poll_once_scoped`)
    // on every fresh poll. Just fans the snapshot out over the global notifier
    // -> `/api/global/stream` for local consumers (e.g. a taskbar widget); not
    // in `remote_handlers::SAFE_METHODS`; so it can't be called over the HTTP
    // remote API.
    {
        let state = state.clone();
        router.register("notify_usage_snapshot", move |params, _ctx| {
            let state = state.clone();
            async move {
                let snap: crate::types::UsageSnapshot = serde_json::from_value(
                    params.ok_or_else(|| RpcError::invalid_params("missing snapshot"))?,
                )
                .map_err(|e| RpcError::invalid_params(format!("bad snapshot: {e}")))?;
                state.notifier.publish("usage_snapshot", json!(snap));
                Ok(json!({}))
            }
        });
    }
}
