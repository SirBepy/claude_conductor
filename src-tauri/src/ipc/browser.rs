//! Settings' browser status: relays to the daemon, which owns the Chrome
//! process (`daemon::browser`).

use serde_json::Value;
use tauri::State;

use crate::state::AppState;

#[tauri::command]
pub async fn browser_status(state: State<'_, AppState>) -> Result<Value, String> {
    let client = state.client().await.ok_or_else(|| "daemon client not connected".to_string())?;
    client.call("browser_status", serde_json::json!({})).await.map_err(|e| e.to_string())
}
