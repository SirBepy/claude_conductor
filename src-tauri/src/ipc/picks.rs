//! Desktop IPC mirror for the chat dashboard's Autopilot picks card RPCs
//! (`daemon/methods/picks.rs`), the same thin-wrapper pattern as `ipc/answers.rs`.

use crate::state::AppState;
use serde_json::{json, Value};
use tauri::State;

#[tauri::command]
pub async fn picks_state(session_id: String, state: State<'_, AppState>) -> Result<Value, String> {
    let client = state.client().await.ok_or_else(|| "daemon client not connected".to_string())?;
    client.call("picks_state", json!({"session_id": session_id})).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn picks_review(
    session_id: String,
    id: String,
    action: String,
    instead: Option<String>,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let client = state.client().await.ok_or_else(|| "daemon client not connected".to_string())?;
    client
        .call(
            "picks_review",
            json!({"session_id": session_id, "id": id, "action": action, "instead": instead.unwrap_or_default()}),
        )
        .await
        .map_err(|e| e.to_string())
}
