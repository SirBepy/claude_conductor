//! Desktop IPC mirror for "Turn into a project" (`daemon/methods/promote.rs`), the same thin
//! wrapper as `ipc/put_away.rs`.

use crate::state::AppState;
use serde_json::{json, Value};
use tauri::State;

#[tauri::command]
pub async fn promote_preview(session_id: String, state: State<'_, AppState>) -> Result<Value, String> {
    let client = state.client().await.ok_or_else(|| "daemon client not connected".to_string())?;
    client.call("promote_preview", json!({"session_id": session_id})).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn promote_to_project(session_id: String, path: String, state: State<'_, AppState>) -> Result<Value, String> {
    let client = state.client().await.ok_or_else(|| "daemon client not connected".to_string())?;
    client
        .call("promote_to_project", json!({"session_id": session_id, "path": path}))
        .await
        .map_err(|e| e.to_string())
}
