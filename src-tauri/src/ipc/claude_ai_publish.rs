//! Desktop proxy for the daemon's `publish_to_claude_ai`. The daemon owns the
//! sidecar and the preview store; this only forwards.

use crate::claude_ai_publish::PublishedLink;
use crate::state::AppState;
use serde_json::Value;
use tauri::State;

/// Publishes preview `id`; blocks for the sidecar's whole run.
#[tauri::command]
pub async fn publish_to_claude_ai(id: String, state: State<'_, AppState>) -> Result<PublishedLink, String> {
    let client = state.client().await.ok_or_else(|| "daemon client not connected".to_string())?;
    let v = client.publish_to_claude_ai(&id).await.map_err(|e| e.to_string())?;
    serde_json::from_value(v.get("published").cloned().unwrap_or(Value::Null)).map_err(|e| e.to_string())
}
