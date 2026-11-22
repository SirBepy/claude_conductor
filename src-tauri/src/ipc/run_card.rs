//! Desktop IPC mirror for the Plan card's run section read (`daemon/methods/run_card.rs`),
//! the same thin-wrapper pattern as `ipc/picks.rs`.

use crate::state::AppState;
use serde_json::{json, Value};
use tauri::State;

#[tauri::command]
pub async fn run_plan_state(session_id: String, state: State<'_, AppState>) -> Result<Value, String> {
    let client = state.client().await.ok_or_else(|| "daemon client not connected".to_string())?;
    client.call("run_plan_state", json!({"session_id": session_id})).await.map_err(|e| e.to_string())
}
