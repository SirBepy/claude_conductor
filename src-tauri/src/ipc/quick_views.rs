//! Desktop IPC mirror for the chat dashboard's quick-view buttons
//! (`daemon/methods/quick_views.rs`), same thin-wrapper pattern as `ipc/answers.rs`.

use crate::state::AppState;
use serde_json::{json, Value};
use tauri::State;

#[tauri::command]
pub async fn chat_quick_view(session_id: String, view: String, state: State<'_, AppState>) -> Result<Value, String> {
    let client = state.client().await.ok_or_else(|| "daemon client not connected".to_string())?;
    client
        .call("chat_quick_view", json!({"session_id": session_id, "view": view}))
        .await
        .map_err(|e| e.to_string())
}
