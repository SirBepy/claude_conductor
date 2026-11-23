//! Desktop IPC mirror for the reopen of a put-away main chat (`daemon/methods/put_away.rs`),
//! the same thin-wrapper pattern as `ipc/run_card.rs`.

use crate::state::AppState;
use serde_json::{json, Value};
use tauri::State;

#[tauri::command]
pub async fn reopen_main_chat(session_id: String, state: State<'_, AppState>) -> Result<Value, String> {
    let client = state.client().await.ok_or_else(|| "daemon client not connected".to_string())?;
    let out = client.call("reopen_main_chat", json!({"session_id": session_id})).await.map_err(|e| e.to_string())?;
    // The listing leaves a put-away chat out, so the front end finds the reopened main only once the cache
    // holds its open row. The daemon's `instances_changed` for it is a separate frame that may land after
    // this reply; reseed here so the refresh that follows the reopen already lists the chat.
    crate::daemon_link::fetch_and_reseed_instances(&client, &state).await;
    Ok(out)
}

#[tauri::command]
pub async fn put_away_paused(session_id: String, state: State<'_, AppState>) -> Result<Value, String> {
    let client = state.client().await.ok_or_else(|| "daemon client not connected".to_string())?;
    client.call("put_away_paused", json!({"session_id": session_id})).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn resume_paused(
    session_id: String,
    end: Vec<String>,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let client = state.client().await.ok_or_else(|| "daemon client not connected".to_string())?;
    client
        .call("resume_paused", json!({"session_id": session_id, "end": end}))
        .await
        .map_err(|e| e.to_string())
}
