//! Desktop IPC mirror for the daemon-owned dictation cleanup pass. Proxies
//! over `state.daemon_client`, same pattern as `ipc/ask.rs` - the daemon owns
//! the sidecar spawn, this just forwards.

use crate::state::AppState;
use tauri::State;

/// Blocks for the sidecar's whole run (a couple of seconds). Returns the
/// cleaned transcript, or an error the caller falls back to the raw text on.
#[tauri::command]
pub async fn voice_clean_transcript(text: String, state: State<'_, AppState>) -> Result<String, String> {
    let client = state.client().await.ok_or_else(|| "daemon client not connected".to_string())?;
    let v = client.voice_clean_transcript(&text).await.map_err(|e| e.to_string())?;
    serde_json::from_value(v).map_err(|e| e.to_string())
}
