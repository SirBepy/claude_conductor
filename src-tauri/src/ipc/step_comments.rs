//! Desktop IPC mirror for the `add_step_comment` daemon RPC (todo 898), same
//! thin-wrapper pattern as `ipc/drafts.rs`.

use crate::state::AppState;
use serde_json::{json, Value};
use tauri::State;

#[tauri::command]
pub async fn add_step_comment(
    session_id: String,
    step_text: String,
    comment: String,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let guard = state.daemon_client.lock().await;
    let client = guard.as_ref().ok_or_else(|| "daemon client not connected".to_string())?;
    client
        .call("add_step_comment", json!({"session_id": session_id, "step_text": step_text, "comment": comment}))
        .await
        .map_err(|e| e.to_string())
}
