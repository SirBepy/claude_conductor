//! Desktop IPC mirror for the Subchats card's daemon RPCs (`daemon/methods/sub_view.rs`):
//! the three the phone shares, plus `start_queued_sub` and `drop_queued_sub` for a queued
//! sub's menu. Same thin-wrapper pattern as `ipc/answers.rs`.

use crate::state::AppState;
use serde_json::{json, Value};
use tauri::State;

#[tauri::command]
pub async fn list_session_images(session_id: String, state: State<'_, AppState>) -> Result<Value, String> {
    let client = state.client().await.ok_or_else(|| "daemon client not connected".to_string())?;
    client.call("list_session_images", json!({"session_id": session_id})).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_sub_brief(session_id: String, state: State<'_, AppState>) -> Result<Value, String> {
    let client = state.client().await.ok_or_else(|| "daemon client not connected".to_string())?;
    client.call("get_sub_brief", json!({"session_id": session_id})).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_sub_pinned(session_id: String, pinned: bool, state: State<'_, AppState>) -> Result<Value, String> {
    let client = state.client().await.ok_or_else(|| "daemon client not connected".to_string())?;
    client.call("set_sub_pinned", json!({"session_id": session_id, "pinned": pinned})).await.map_err(|e| e.to_string())
}

/// A queued sub's menu (Start now). Desktop only: the daemon method is absent from the
/// remote transport table, so the phone and a paired machine cannot reach it.
#[tauri::command]
pub async fn start_queued_sub(session_id: String, state: State<'_, AppState>) -> Result<Value, String> {
    let client = state.client().await.ok_or_else(|| "daemon client not connected".to_string())?;
    client.call("start_queued_sub", json!({"session_id": session_id})).await.map_err(|e| e.to_string())
}

/// A queued sub's menu (Drop). Desktop only, like `start_queued_sub`.
#[tauri::command]
pub async fn drop_queued_sub(session_id: String, state: State<'_, AppState>) -> Result<Value, String> {
    let client = state.client().await.ok_or_else(|| "daemon client not connected".to_string())?;
    client.call("drop_queued_sub", json!({"session_id": session_id})).await.map_err(|e| e.to_string())
}
