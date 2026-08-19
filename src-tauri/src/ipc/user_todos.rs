//! Desktop IPC mirror for the daemon-owned "Your Todos" store (todo 692).
//! Proxies to the daemon over its RPC/pipe connection (`state.daemon_client`),
//! same pattern as `ipc/preview.rs` - the daemon is a SEPARATE process from
//! this app's `AppState`, so these commands never touch the store directly.

use crate::state::AppState;
use serde::{Deserialize, Serialize};
use tauri::State;

/// One round-trip's worth of panel state. `columns` is this chat's own saved
/// Columns-menu visibility (`chat_config::todo_columns`), so opening the panel
/// restores the view without a second call.
#[derive(Debug, Serialize, Deserialize)]
pub struct UserTodosView {
    pub todos: Vec<crate::sessions::user_todos::UserTodo>,
    pub columns: Vec<String>,
}

#[tauri::command]
pub async fn list_user_todos(session_id: String, state: State<'_, AppState>) -> Result<UserTodosView, String> {
    let guard = state.daemon_client.lock().await;
    let client = guard.as_ref().ok_or_else(|| "daemon client not connected".to_string())?;
    let v = client.list_user_todos(&session_id).await.map_err(|e| e.to_string())?;
    serde_json::from_value(v).map_err(|e| e.to_string())
}

/// Joe's tick/untick from the panel. `next` is `open`/`done`/`archived`.
#[tauri::command]
pub async fn set_user_todo_state(
    session_id: String,
    id: String,
    next: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let guard = state.daemon_client.lock().await;
    let client = guard.as_ref().ok_or_else(|| "daemon client not connected".to_string())?;
    client.set_user_todo_state(&session_id, &id, &next).await.map_err(|e| e.to_string())?;
    Ok(())
}

/// The notify CTA's `Notify` button: pushes this chat's pending changes now
/// rather than waiting for the next turn's injection to consume them.
#[tauri::command]
pub async fn mark_todos_seen(
    session_id: String,
    origin_session_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let guard = state.daemon_client.lock().await;
    let client = guard.as_ref().ok_or_else(|| "daemon client not connected".to_string())?;
    client.mark_todos_seen(&session_id, &origin_session_id).await.map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn set_todo_columns(
    session_id: String,
    columns: Vec<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let guard = state.daemon_client.lock().await;
    let client = guard.as_ref().ok_or_else(|| "daemon client not connected".to_string())?;
    client.set_todo_columns(&session_id, columns).await.map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn clear_archived_todos(session_id: String, state: State<'_, AppState>) -> Result<(), String> {
    let guard = state.daemon_client.lock().await;
    let client = guard.as_ref().ok_or_else(|| "daemon client not connected".to_string())?;
    client.clear_archived_todos(&session_id).await.map_err(|e| e.to_string())?;
    Ok(())
}
