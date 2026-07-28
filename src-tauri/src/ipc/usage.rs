use crate::state::AppState;
use crate::types::{AuthState, UsageSnapshot};
use std::collections::HashMap;
use tauri::{AppHandle, State};

#[tauri::command]
pub fn get_current_usage(state: State<AppState>) -> Option<UsageSnapshot> {
    state.current_usage.lock().unwrap().clone()
}

/// Per-account current usage, keyed by `Account.id` (multi-account milestone
/// 03). Empty while no registered account has a stored web cookie (the
/// legacy single-cookie poll populates only `get_current_usage`).
#[tauri::command]
pub fn get_usage_map(state: State<AppState>) -> HashMap<String, UsageSnapshot> {
    state.current_usage_by_account.lock().unwrap().clone()
}

/// Per-account auth state, keyed by `Account.id`. An account absent from the
/// map has not been polled yet this run.
#[tauri::command]
pub fn get_auth_state_map(state: State<AppState>) -> HashMap<String, AuthState> {
    state.auth_state_by_account.lock().unwrap().clone()
}

#[tauri::command]
pub fn get_history(
    state: State<AppState>,
    limit: Option<u32>,
    account_id: Option<String>,
) -> Vec<UsageSnapshot> {
    // Snapshots come back ascending by timestamp (same order the legacy JSONL
    // file produced), so a `limit` keeps the newest N by trimming the front.
    // `account_id` (new, optional - existing callers omit it and see every
    // row) filters to one account's snapshots.
    let mut all = {
        let mgr = state.db.lock().unwrap();
        crate::storage::usage_store::get_all_snapshots(mgr.conn()).unwrap_or_default()
    };
    if let Some(acct) = account_id {
        all.retain(|s| s.account_id.as_deref() == Some(acct.as_str()));
    }
    if let Some(n) = limit {
        let start = all.len().saturating_sub(n as usize);
        all = all.split_off(start);
    }
    all
}

#[tauri::command]
pub async fn poll_now(app: AppHandle, account_id: Option<String>) -> Result<UsageSnapshot, String> {
    match crate::scheduler::poll_once_scoped(
        &app,
        crate::scheduler::PollTrigger::Manual,
        account_id.as_deref(),
    )
    .await
    {
        Ok(snap) => Ok(snap),
        Err(e) => Err(format!("{e:?}")),
    }
}
