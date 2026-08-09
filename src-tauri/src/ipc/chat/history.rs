//! Read-only transcript replays for the chat hub.
//!
//! Distinct from `crate::chat::history` (the pure JSONL reader): this module
//! is the IPC surface that wraps it for the Sessions and History views. The
//! `list_history` listing pipeline lives in `history_list.rs`; `collect_history`
//! is re-exported here since `daemon::methods::history` calls it at this path.

use super::attachments::validate_session_id;
use crate::types::chat::ChatEvent;

pub(crate) use super::history_list::collect_history;

/// Replay the JSONL transcript for `session_id` from disk into ChatEvents.
/// Used by the Sessions view to seed the renderer when opening a session,
/// and by the History view for read-only past-session browsing.
///
/// Claude CLI writes transcripts to `~/.claude/projects/<encoded-cwd>/<session_id>.jsonl`,
/// NOT `~/.claude/sessions/<session_id>.jsonl` (the latter holds pid-keyed
/// metadata, not transcripts). When `cwd` is known (Sessions view passes it
/// from the Instance entry), use `transcript_for_session` directly; otherwise
/// (History view, where cwd isn't carried on `HistoryEntry`) scan every project
/// dir for a matching `<session_id>.jsonl`.
#[tauri::command]
pub async fn load_history(session_id: String, cwd: Option<String>) -> Result<Vec<ChatEvent>, String> {
    validate_session_id(&session_id)?;

    // Sync filesystem IO + JSONL parse can be heavy for large transcripts
    // (megabytes, thousands of events). Run on the blocking pool so the
    // Tauri async runtime stays responsive to other IPC calls while the
    // session loads.
    tauri::async_runtime::spawn_blocking(move || {
        let path = crate::chat::history::locate_transcript(&session_id, cwd.as_deref())?;
        crate::chat::history::replay(&path)
    })
    .await
    .map_err(|e| format!("join: {}", e))?
}

/// Paginated transcript reader. Returns the last `message_limit` message
/// bubbles (UserMessage / AssistantMessage), plus all surrounding tool calls
/// and metadata events. Pass `before_seq = Some(oldestSeq)` to fetch the
/// previous page.
///
/// Used by the Sessions view chat-open path. The History view keeps using
/// `load_history` because it browses full transcripts read-only.
#[tauri::command]
pub async fn load_history_page(
    session_id: String,
    cwd: Option<String>,
    before_seq: Option<u64>,
    message_limit: u32,
) -> Result<crate::types::chat::HistoryPage, String> {
    validate_session_id(&session_id)?;
    let limit = message_limit.clamp(1, 500);

    tauri::async_runtime::spawn_blocking(move || {
        let path = crate::chat::history::locate_transcript(&session_id, cwd.as_deref())?;
        crate::chat::history::read_page(&path, before_seq, limit)
    })
    .await
    .map_err(|e| format!("join: {}", e))?
}

/// Fetch a single `ToolResult`'s untruncated output, addressed by the
/// `full_seq` a `read_page` preview carried plus the call's `tool_use_id`
/// (a line can hold more than one result). Used when the user expands a
/// tool-row whose output was too large to inline on the page load.
#[tauri::command]
pub async fn load_event_detail(
    session_id: String,
    cwd: Option<String>,
    seq: u64,
    tool_use_id: String,
) -> Result<ChatEvent, String> {
    validate_session_id(&session_id)?;

    tauri::async_runtime::spawn_blocking(move || {
        let path = crate::chat::history::locate_transcript(&session_id, cwd.as_deref())?;
        crate::chat::history::read_single_event(&path, seq, &tool_use_id)
    })
    .await
    .map_err(|e| format!("join: {}", e))?
}
