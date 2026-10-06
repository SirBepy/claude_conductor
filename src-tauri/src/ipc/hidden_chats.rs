//! Desktop IPC mirror for the daemon-owned hidden-chats list
//! (`sessions::hidden_chats`). Proxies over the daemon pipe, same pattern as
//! `ipc/user_todos.rs`, so the desktop and the phone read one list.

use crate::state::AppState;
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Debug, Serialize, Deserialize)]
pub struct HiddenChatsView {
    pub sessions: Vec<String>,
}

#[tauri::command]
pub async fn get_hidden_chats(state: State<'_, AppState>) -> Result<HiddenChatsView, String> {
    let client = state.client().await.ok_or_else(|| "daemon client not connected".to_string())?;
    let v = client.get_hidden_chats().await.map_err(|e| e.to_string())?;
    serde_json::from_value(v).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_hidden_chats(
    add: Vec<String>,
    remove: Vec<String>,
    state: State<'_, AppState>,
) -> Result<HiddenChatsView, String> {
    let client = state.client().await.ok_or_else(|| "daemon client not connected".to_string())?;
    let v = client.update_hidden_chats(add, remove).await.map_err(|e| e.to_string())?;
    serde_json::from_value(v).map_err(|e| e.to_string())
}
