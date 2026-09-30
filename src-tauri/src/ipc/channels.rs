use crate::state::AppState;
use tauri::State;

#[tauri::command]
pub async fn spawn_channel(project_id: String, state: State<'_, AppState>) -> Result<(), String> {
    let client = state.client().await.ok_or("daemon client not connected")?;
    client.start_channel(&project_id).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn stop_channel(project_id: String, state: State<'_, AppState>) -> Result<(), String> {
    let client = state.client().await.ok_or("daemon client not connected")?;
    client.stop_channel(&project_id).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn restart_channel(project_id: String, state: State<'_, AppState>) -> Result<(), String> {
    let client = state.client().await.ok_or("daemon client not connected")?;
    client.restart_channel(&project_id).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn show_terminal(project_id: String, state: State<'_, AppState>) -> Result<(), String> {
    let client = state.client().await.ok_or("daemon client not connected")?;
    client.show_channel(&project_id).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn hide_terminal(project_id: String, state: State<'_, AppState>) -> Result<(), String> {
    let client = state.client().await.ok_or("daemon client not connected")?;
    client.hide_channel(&project_id).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_channels(state: State<'_, AppState>) -> Result<Vec<serde_json::Value>, String> {
    Ok(state.cached_channels.lock().unwrap().clone())
}
