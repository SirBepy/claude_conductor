//! Desktop IPC mirror for the daemon-owned draft-message store (todo 666).
//! Proxies to the daemon over its RPC/pipe connection, same pattern as
//! `ipc/user_todos.rs` - the daemon is a SEPARATE process from this app's
//! `AppState`, so these commands never touch the store directly.

use crate::state::AppState;
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Debug, Serialize, Deserialize)]
pub struct MessageDraftsView {
    pub drafts: Vec<crate::sessions::message_drafts::MessageDraft>,
}

#[tauri::command]
pub async fn list_message_drafts(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<MessageDraftsView, String> {
    let guard = state.daemon_client.lock().await;
    let client = guard.as_ref().ok_or_else(|| "daemon client not connected".to_string())?;
    let v = client.list_message_drafts(&session_id).await.map_err(|e| e.to_string())?;
    serde_json::from_value(v).map_err(|e| e.to_string())
}

/// The user's edit from the panel. `recipient` may be empty on a card with a
/// single variant; the daemon refuses to guess on a multi-recipient one.
#[tauri::command]
pub async fn set_draft_body(
    session_id: String,
    id: String,
    recipient: String,
    body: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let guard = state.daemon_client.lock().await;
    let client = guard.as_ref().ok_or_else(|| "daemon client not connected".to_string())?;
    client.set_draft_body(&session_id, &id, &recipient, &body).await.map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn set_draft_version(
    session_id: String,
    id: String,
    recipient: String,
    n: u32,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let guard = state.daemon_client.lock().await;
    let client = guard.as_ref().ok_or_else(|| "daemon client not connected".to_string())?;
    client.set_draft_version(&session_id, &id, &recipient, n).await.map_err(|e| e.to_string())?;
    Ok(())
}

/// `next` is `needs-you`/`ready`/`copied`. The panel sets `copied` when Copy is
/// actually pressed, which is the only evidence this app can ever have.
#[tauri::command]
pub async fn set_draft_state(
    session_id: String,
    id: String,
    next: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let guard = state.daemon_client.lock().await;
    let client = guard.as_ref().ok_or_else(|| "daemon client not connected".to_string())?;
    client.set_draft_state(&session_id, &id, &next).await.map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn delete_draft(session_id: String, id: String, state: State<'_, AppState>) -> Result<(), String> {
    let guard = state.daemon_client.lock().await;
    let client = guard.as_ref().ok_or_else(|| "daemon client not connected".to_string())?;
    client.delete_draft(&session_id, &id).await.map_err(|e| e.to_string())?;
    Ok(())
}
