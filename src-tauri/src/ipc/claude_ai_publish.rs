//! Desktop proxy for the daemon's `publish_to_claude_ai`. The daemon owns the
//! sidecar and the preview store; this only forwards.

use crate::state::AppState;
use serde_json::Value;
use tauri::State;

/// Publishes preview `id`; blocks for the sidecar's whole run. Returns the
/// daemon's `{ published, stored }` as is so the UI can say when the link was
/// not saved.
#[tauri::command]
pub async fn publish_to_claude_ai(id: String, state: State<'_, AppState>) -> Result<Value, String> {
    let client = state.client().await.ok_or_else(|| "daemon client not connected".to_string())?;
    client.publish_to_claude_ai(&id).await.map_err(|e| e.to_string())
}
