//! Desktop IPC mirror for the daemon-owned Ask store, which holds the Answers
//! card's threads. Proxies over `state.daemon_client`, same pattern as
//! `ipc/user_todos.rs` - the daemon is a separate process, so this never touches
//! the store here.

use crate::ask::AskThread;
use crate::state::AppState;
use tauri::State;

#[tauri::command]
pub async fn ask_list_threads(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<AskThread>, String> {
    let client = state.client().await.ok_or_else(|| "daemon client not connected".to_string())?;
    let v = client.ask_list_threads(&session_id).await.map_err(|e| e.to_string())?;
    serde_json::from_value(v).map_err(|e| e.to_string())
}
