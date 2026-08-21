//! Desktop-side mirror of the `tail_waiting_log` daemon RPC (todo 675). The
//! registry and the log file both live in the daemon process, not this one,
//! so this is a thin forward through the app<->daemon client -
//! `daemon::methods::registry::waiting_tail` is what re-validates the path.

use crate::state::AppState;
use serde_json::json;
use tauri::State;

#[derive(serde::Serialize, serde::Deserialize)]
pub struct TailResult {
    pub content: String,
    pub offset: u64,
}

#[tauri::command]
pub async fn tail_waiting_log(
    session_id: String,
    path: String,
    offset: Option<u64>,
    state: State<'_, AppState>,
) -> Result<TailResult, String> {
    let client_guard = state.daemon_client.lock().await;
    let client = client_guard
        .as_ref()
        .ok_or_else(|| "daemon client not connected".to_string())?;
    let result = client
        .call(
            "tail_waiting_log",
            json!({ "session_id": session_id, "path": path, "offset": offset }),
        )
        .await
        .map_err(|e| e.to_string())?;
    serde_json::from_value(result).map_err(|e| e.to_string())
}
