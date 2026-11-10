//! Desktop IPC mirror for the Subchats card's three daemon RPCs
//! (`daemon/methods/sub_view.rs`), same thin-wrapper pattern as `ipc/answers.rs`.

use crate::state::AppState;
use serde_json::{json, Value};
use tauri::State;

#[tauri::command]
pub async fn list_session_images(session_id: String, state: State<'_, AppState>) -> Result<Value, String> {
    let client = state.client().await.ok_or_else(|| "daemon client not connected".to_string())?;
    client.call("list_session_images", json!({"session_id": session_id})).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_sub_brief(session_id: String, state: State<'_, AppState>) -> Result<Value, String> {
    let client = state.client().await.ok_or_else(|| "daemon client not connected".to_string())?;
    client.call("get_sub_brief", json!({"session_id": session_id})).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_sub_pinned(session_id: String, pinned: bool, state: State<'_, AppState>) -> Result<Value, String> {
    let client = state.client().await.ok_or_else(|| "daemon client not connected".to_string())?;
    client.call("set_sub_pinned", json!({"session_id": session_id, "pinned": pinned})).await.map_err(|e| e.to_string())
}
