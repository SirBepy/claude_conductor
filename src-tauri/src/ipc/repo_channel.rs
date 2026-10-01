//! Desktop/phone IPC mirror of the daemon's `list_channel_messages` RPC
//! (todo 893): a non-consuming read of the repo-channel coordination log so
//! the peer-message chip's inline panel can show the real posted text
//! instead of the zero-peer-bytes wake placeholder it's limited to on the
//! wire (`daemon/repo_channel_wake.rs`'s `wake_notice`, todo 743's
//! injection boundary). Same thin pass-through pattern as
//! `ipc/message_drafts.rs::list_message_drafts` - the daemon is a SEPARATE
//! process from this app's `AppState`, so this never touches the store
//! directly.

use crate::sessions::repo_channel::ChannelMessage;
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Debug, Serialize, Deserialize)]
pub struct ChannelMessagesView {
    pub messages: Vec<ChannelMessage>,
}

/// `session_id` is the VIEWED chat (whose project scopes the read), not the
/// peer author - same trust model as the `read_messages`/`list_peers` MCP
/// tools this mirrors: the daemon resolves the project from the registry,
/// never from a caller-supplied project id.
#[tauri::command]
pub async fn list_channel_messages(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<ChannelMessagesView, String> {
    let client = state.client().await.ok_or_else(|| "daemon client not connected".to_string())?;
    let v = client
        .call("list_channel_messages", serde_json::json!({ "session_id": session_id }))
        .await
        .map_err(|e| e.to_string())?;
    serde_json::from_value(v).map_err(|e| e.to_string())
}
