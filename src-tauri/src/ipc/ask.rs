//! Desktop IPC mirror for the daemon-owned Ask store. Proxies over
//! `state.daemon_client`, same pattern as `ipc/user_todos.rs` - the daemon is a
//! separate process, so these never touch the store or spawn a sidecar here.

use crate::ask::AskThread;
use crate::state::AppState;
use tauri::State;

#[tauri::command]
pub async fn ask_list_threads(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<AskThread>, String> {
    let guard = state.daemon_client.lock().await;
    let client = guard.as_ref().ok_or_else(|| "daemon client not connected".to_string())?;
    let v = client.ask_list_threads(&session_id).await.map_err(|e| e.to_string())?;
    serde_json::from_value(v).map_err(|e| e.to_string())
}

/// Blocks for the sidecar's whole run (seconds, not milliseconds) and returns
/// the updated thread. `threadId` omitted starts a new thread.
#[tauri::command]
pub async fn ask_send(
    session_id: String,
    thread_id: Option<String>,
    question: String,
    cwd: Option<String>,
    state: State<'_, AppState>,
) -> Result<AskThread, String> {
    let guard = state.daemon_client.lock().await;
    let client = guard.as_ref().ok_or_else(|| "daemon client not connected".to_string())?;
    let v = client
        .ask_send(&session_id, thread_id.as_deref(), &question, cwd.as_deref())
        .await
        .map_err(|e| e.to_string())?;
    serde_json::from_value(v).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn ask_delete_thread(
    session_id: String,
    thread_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<AskThread>, String> {
    let guard = state.daemon_client.lock().await;
    let client = guard.as_ref().ok_or_else(|| "daemon client not connected".to_string())?;
    let v = client.ask_delete_thread(&session_id, &thread_id).await.map_err(|e| e.to_string())?;
    serde_json::from_value(v).map_err(|e| e.to_string())
}
