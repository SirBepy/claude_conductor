//! Desktop IPC mirror for the daemon's draft store, same thin-wrapper pattern
//! as `ipc/schedule.rs`. Returns raw `Value` because the daemon's
//! `SessionDrafts` only derives `Serialize`.

use crate::state::AppState;
use crate::types::chat::ContentBlock;
use serde_json::{json, Value};
use tauri::State;

#[tauri::command]
pub async fn get_session_drafts(session_id: String, state: State<'_, AppState>) -> Result<Value, String> {
    let guard = state.daemon_client.lock().await;
    let client = guard.as_ref().ok_or_else(|| "daemon client not connected".to_string())?;
    client.call("get_session_drafts", json!({"session_id": session_id})).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_composer_draft(
    session_id: String,
    text: String,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let guard = state.daemon_client.lock().await;
    let client = guard.as_ref().ok_or_else(|| "daemon client not connected".to_string())?;
    client
        .call("set_composer_draft", json!({"session_id": session_id, "text": text}))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn clear_composer_draft(session_id: String, state: State<'_, AppState>) -> Result<Value, String> {
    let guard = state.daemon_client.lock().await;
    let client = guard.as_ref().ok_or_else(|| "daemon client not connected".to_string())?;
    client.call("clear_composer_draft", json!({"session_id": session_id})).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_auq_draft(
    session_id: String,
    prompt_id: String,
    payload: Value,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let guard = state.daemon_client.lock().await;
    let client = guard.as_ref().ok_or_else(|| "daemon client not connected".to_string())?;
    client
        .call("set_auq_draft", json!({"session_id": session_id, "prompt_id": prompt_id, "payload": payload}))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn clear_auq_draft(
    session_id: String,
    prompt_id: String,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let guard = state.daemon_client.lock().await;
    let client = guard.as_ref().ok_or_else(|| "daemon client not connected".to_string())?;
    client
        .call("clear_auq_draft", json!({"session_id": session_id, "prompt_id": prompt_id}))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn add_held_message(
    session_id: String,
    blocks: Vec<ContentBlock>,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let guard = state.daemon_client.lock().await;
    let client = guard.as_ref().ok_or_else(|| "daemon client not connected".to_string())?;
    client
        .call("add_held_message", json!({"session_id": session_id, "blocks": blocks}))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_held_message(
    session_id: String,
    id: u64,
    blocks: Vec<ContentBlock>,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let guard = state.daemon_client.lock().await;
    let client = guard.as_ref().ok_or_else(|| "daemon client not connected".to_string())?;
    client
        .call("update_held_message", json!({"session_id": session_id, "id": id, "blocks": blocks}))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn remove_held_message(session_id: String, id: u64, state: State<'_, AppState>) -> Result<Value, String> {
    let guard = state.daemon_client.lock().await;
    let client = guard.as_ref().ok_or_else(|| "daemon client not connected".to_string())?;
    client
        .call("remove_held_message", json!({"session_id": session_id, "id": id}))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn clear_held_messages(session_id: String, state: State<'_, AppState>) -> Result<Value, String> {
    let guard = state.daemon_client.lock().await;
    let client = guard.as_ref().ok_or_else(|| "daemon client not connected".to_string())?;
    client.call("clear_held_messages", json!({"session_id": session_id})).await.map_err(|e| e.to_string())
}
