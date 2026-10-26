//! Desktop IPC for the API-credit status the daemon keeps (`daemon::api_credit`).
//! Proxies over the daemon pipe, same pattern as `ipc/hidden_chats.rs`: the
//! daemon owns the figures and the send gate that reads them.

use crate::accounts::ApiCreditStatus;
use crate::state::AppState;
use std::collections::HashMap;
use tauri::State;

#[tauri::command]
pub async fn get_api_credit_status(
    state: State<'_, AppState>,
) -> Result<HashMap<String, ApiCreditStatus>, String> {
    let client = state.client().await.ok_or_else(|| "daemon client not connected".to_string())?;
    let v = client.get_api_credit_status().await.map_err(|e| e.to_string())?;
    serde_json::from_value(v).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn refresh_api_credit_status(
    account_id: String,
    state: State<'_, AppState>,
) -> Result<ApiCreditStatus, String> {
    let client = state.client().await.ok_or_else(|| "daemon client not connected".to_string())?;
    let v = client.refresh_api_credit_status(&account_id).await.map_err(|e| e.to_string())?;
    serde_json::from_value(v).map_err(|e| e.to_string())
}

/// Saves the account's Console `sessionKey` only after the Console accepts it
/// for the account's organisation; the error says so when it does not.
#[tauri::command]
pub async fn set_console_session(
    account_id: String,
    session_key: String,
    state: State<'_, AppState>,
) -> Result<ApiCreditStatus, String> {
    let client = state.client().await.ok_or_else(|| "daemon client not connected".to_string())?;
    let v = client.set_console_session(&account_id, &session_key).await.map_err(|e| e.to_string())?;
    serde_json::from_value(v).map_err(|e| e.to_string())
}
