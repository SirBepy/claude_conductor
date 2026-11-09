//! App-side pass-throughs to the daemon's project-MCP sign-in RPCs
//! (`daemon::methods::mcp_servers`).

use serde_json::Value;
use tauri::State;

use crate::state::AppState;

/// Starts a sign-in for one listed server and returns `{auth_url}`.
#[tauri::command]
pub async fn mcp_sign_in(url: String, state: State<'_, AppState>) -> Result<Value, String> {
    let client = state.client().await.ok_or_else(|| "daemon client not connected".to_string())?;
    client.call("mcp_sign_in", serde_json::json!({ "url": url })).await.map_err(|e| e.to_string())
}

/// `{<url>: bool}`: whether each server has a stored sign-in.
#[tauri::command]
pub async fn mcp_signed_in(urls: Vec<String>, state: State<'_, AppState>) -> Result<Value, String> {
    let client = state.client().await.ok_or_else(|| "daemon client not connected".to_string())?;
    client.call("mcp_signed_in", serde_json::json!({ "urls": urls })).await.map_err(|e| e.to_string())
}
