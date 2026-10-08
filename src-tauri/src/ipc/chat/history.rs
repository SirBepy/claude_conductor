//! Read-only transcript replays for the chat hub.
//!
//! Distinct from `crate::chat::history` (the pure JSONL reader): this module
//! is the IPC surface that wraps it for the Sessions and History views. The
//! `list_history` listing pipeline lives in `history_list.rs`; `collect_history`
//! is re-exported here since `daemon::methods::history` calls it at this path.
//!
//! A session mirrored from a paired peer machine has no local transcript, so
//! each command below routes through the daemon's own `load_history`/
//! `load_history_page`/`transcript_stats`/`load_event_detail` RPCs instead -
//! the daemon's shared router already forwards those one hop to the owning
//! peer for a mirrored session id (`machines/forward.rs::forward_one`,
//! `remote_transport_table.rs`'s `PM` mask), so this layer only needs to pick
//! local-disk-read vs. daemon-RPC, never resolve the peer itself.

use super::attachments::validate_session_id;
use crate::state::AppState;
use crate::types::chat::ChatEvent;
use tauri::State;

pub(crate) use super::history_list::collect_history;

/// Whether `session_id` is mirrored from a paired peer, per the desktop's
/// cached instance list (`AppState.cached_instances`, reseeded by
/// `daemon_link::fetch_and_reseed_instances`). A miss (session absent from
/// the cache, or present with `machine: None`) means "read local disk" -
/// the existing behavior for every session hosted on this machine.
pub(crate) fn is_mirrored(instances: &[crate::types::Instance], session_id: &str) -> bool {
    instances
        .iter()
        .find(|i| i.session_id == session_id)
        .is_some_and(|i| i.machine.is_some())
}

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
pub async fn load_history(
    session_id: String,
    cwd: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<ChatEvent>, String> {
    validate_session_id(&session_id)?;

    if is_mirrored(&state.cached_instances.lock().unwrap(), &session_id) {
        let client = state.client().await.ok_or_else(|| "daemon client not connected".to_string())?;
        return client.load_history(&session_id, cwd.as_deref()).await.map_err(|e| e.to_string());
    }

    // Sync filesystem IO + JSONL parse can be heavy for large transcripts
    // (megabytes, thousands of events). Run on the blocking pool so the
    // Tauri async runtime stays responsive to other IPC calls while the
    // session loads.
    crate::chat::history::with_transcript(session_id, cwd, crate::chat::history::replay).await
}

/// User-message count and model for a past session's detail cards, without
/// shipping the transcript itself. `load_history` used to serve this, which put
/// the whole file through the webview's main-thread JSON.parse and froze the
/// window on a large chat.
#[tauri::command]
pub async fn transcript_stats(
    session_id: String,
    cwd: Option<String>,
    state: State<'_, AppState>,
) -> Result<crate::chat::history::TranscriptStats, String> {
    validate_session_id(&session_id)?;

    if is_mirrored(&state.cached_instances.lock().unwrap(), &session_id) {
        let client = state.client().await.ok_or_else(|| "daemon client not connected".to_string())?;
        return client.transcript_stats(&session_id, cwd.as_deref()).await.map_err(|e| e.to_string());
    }

    crate::chat::history::with_transcript(session_id, cwd, crate::chat::history::stats).await
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
    state: State<'_, AppState>,
) -> Result<crate::types::chat::HistoryPage, String> {
    validate_session_id(&session_id)?;
    let limit = message_limit.clamp(1, 500);

    if is_mirrored(&state.cached_instances.lock().unwrap(), &session_id) {
        let client = state.client().await.ok_or_else(|| "daemon client not connected".to_string())?;
        return client
            .load_history_page(&session_id, cwd.as_deref(), before_seq, limit)
            .await
            .map_err(|e| e.to_string());
    }

    tauri::async_runtime::spawn_blocking(move || {
        crate::chat::history::read_page_for_session(&session_id, cwd.as_deref(), before_seq, limit)
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
    state: State<'_, AppState>,
) -> Result<ChatEvent, String> {
    validate_session_id(&session_id)?;

    if is_mirrored(&state.cached_instances.lock().unwrap(), &session_id) {
        let client = state.client().await.ok_or_else(|| "daemon client not connected".to_string())?;
        return client
            .load_event_detail(&session_id, cwd.as_deref(), seq, &tool_use_id)
            .await
            .map_err(|e| e.to_string());
    }

    crate::chat::history::with_transcript(session_id, cwd, move |path| {
        crate::chat::history::read_single_event(path, seq, &tool_use_id)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::is_mirrored;
    use crate::sessions::kinds::InstanceKind;
    use crate::types::{Instance, MachineRef};

    fn fixture(session_id: &str, machine: Option<MachineRef>) -> Instance {
        Instance {
            session_id: session_id.into(),
            pid: 1,
            cwd: std::path::PathBuf::from("C:/x"),
            project_id: "proj".into(),
            kind: InstanceKind::Interactive,
            is_remote: false,
            started_at: "2026-04-21T10:00:00Z".into(),
            transcript_path: None,
            bridge_session_id: None,
            name: None,
            ended_at: None,
            end_reason: None,
            busy: false,
            model: String::new(),
            effort: String::new(),
            awaiting: None,
            last_notified_awaiting: None,
            autopilot: false,
            jarvis: false,
            worker_of: None,
            closing: false,
            turn_gen: 0,
            last_event_at: None,
            channel_epoch: 0,
            account_id: None,
            rate_limited_resets_at: None,
            rate_limited_type: None,
            frozen: false,
            frozen_needs_continue: false,
            auto_frozen: false,
            held_count: 0,
            local_task_running: false,
            successor_of: None,
            machine,
        }
    }

    #[test]
    fn local_session_is_not_mirrored() {
        let instances = vec![fixture("s1", None)];
        assert!(!is_mirrored(&instances, "s1"));
    }

    #[test]
    fn mirrored_session_carries_a_machine_ref() {
        let instances = vec![fixture("s1", Some(MachineRef { id: "mach-b".into(), label: "Mac Mini".into(), online: true }))];
        assert!(is_mirrored(&instances, "s1"));
    }

    #[test]
    fn session_absent_from_cache_is_not_mirrored() {
        let instances = vec![fixture("s1", None)];
        assert!(!is_mirrored(&instances, "unknown"));
    }
}
