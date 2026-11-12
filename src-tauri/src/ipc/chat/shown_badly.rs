//! Desktop IPC mirror for a card menu's "Shown badly" flag
//! (`daemon/methods/registry/shown_badly.rs`), same thin-wrapper pattern as
//! `ipc/sub_view.rs`.

use crate::state::AppState;
use serde_json::{json, Value};
use tauri::State;

#[tauri::command]
pub async fn flag_shown_badly(
    chat_id: String,
    message_id: Option<String>,
    message: Value,
    note: Option<String>,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let client = state.client().await.ok_or_else(|| "daemon client not connected".to_string())?;
    client
        .call(
            "flag_shown_badly",
            json!({"chat_id": chat_id, "message_id": message_id, "message": message, "note": note}),
        )
        .await
        .map_err(|e| e.to_string())
}
