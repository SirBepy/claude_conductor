//! Desktop IPC mirror for the daemon-owned gaming-mode toggle
//! (`daemon::methods::gaming_mode`). Desktop-pipe only - never exposed over
//! the remote/phone transport (absent from `remote_transport_table`).

use crate::state::AppState;
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct GamingModeView {
    pub on: bool,
    pub paused_sessions: usize,
    pub stopped_procs: usize,
    pub stopped_containers: usize,
    pub docker_desktop_stopped: bool,
}

#[tauri::command]
pub async fn get_gaming_mode(state: State<'_, AppState>) -> Result<GamingModeView, String> {
    let client = state.client().await.ok_or_else(|| "daemon client not connected".to_string())?;
    let v = client.get_gaming_mode().await.map_err(|e| e.to_string())?;
    serde_json::from_value(v).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_gaming_mode(on: bool, state: State<'_, AppState>) -> Result<GamingModeView, String> {
    let client = state.client().await.ok_or_else(|| "daemon client not connected".to_string())?;
    let v = client.set_gaming_mode(on).await.map_err(|e| e.to_string())?;
    serde_json::from_value(v).map_err(|e| e.to_string())
}
