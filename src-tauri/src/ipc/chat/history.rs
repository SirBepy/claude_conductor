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

/// Matches the exact message `chat::history::locate_transcript` returns on a
/// missing transcript - the only local failure a daemon retry could possibly
/// fix (any other local error, e.g. a permission or parse failure, would
/// just recur identically on retry).
fn is_not_found(err: &str) -> bool {
    err.starts_with("no transcript found for session")
}

/// Decide whether a local-disk "not found" lookup should retry once through
/// the daemon RPC path.
///
/// A session just started on a paired machine has no local transcript, and
/// `cached_instances` only gains the row's `machine` tag once the peer's next
/// `instances_changed` frame republishes - until then the row is either
/// absent from the cache or present untagged, so the `is_mirrored` check the
/// callers below run first never routes it to the daemon. The daemon's own
/// `MirrorState` pending-owner map (b9bac1eb) already knows a freshly
/// forwarded id in that window, so retrying there is cheap: a genuinely local
/// not-found comes back byte-for-byte identical from the daemon (same
/// `locate_transcript` message), so retrying for "absent from cache" or
/// "present but untagged" is harmless, not just acceptable.
///
/// Never retry on anything but a not-found (a success or a different local
/// error must return as-is, with zero extra RPCs on the common path), and
/// never retry an id already tagged mirrored - unreachable in practice since
/// the caller's own `is_mirrored` check already sends that case to the
/// daemon before local disk is ever touched, but kept as an explicit input
/// so the tagged state stays testable here. Absent-from-cache and
/// present-but-untagged retry identically, so the cache presence is not an
/// input at all.
pub(crate) fn should_retry_via_daemon(was_not_found: bool, tagged_mirrored: bool) -> bool {
    was_not_found && !tagged_mirrored
}

/// The daemon client to retry a failed local read through, or `local_err`
/// back unchanged when no retry applies (see `should_retry_via_daemon`) or
/// the daemon is not connected. Every command below calls this from its
/// local-read error arm, where the session may have just been spawned on a
/// paired machine before this cache saw its `machine` tag.
async fn daemon_retry_client(
    state: &AppState,
    session_id: &str,
    local_err: String,
) -> Result<crate::daemon_client::PersistentClient, String> {
    let tagged_mirrored = is_mirrored(&state.cached_instances.lock().unwrap(), session_id);
    if !should_retry_via_daemon(is_not_found(&local_err), tagged_mirrored) {
        return Err(local_err);
    }
    state.client().await.ok_or(local_err)
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
    let local = crate::chat::history::with_transcript(session_id.clone(), cwd.clone(), crate::chat::history::replay).await;
    match local {
        Ok(events) => Ok(events),
        Err(local_err) => {
            let client = daemon_retry_client(&state, &session_id, local_err).await?;
            client.load_history(&session_id, cwd.as_deref()).await.map_err(|e| e.to_string())
        }
    }
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

    let local = crate::chat::history::with_transcript(session_id.clone(), cwd.clone(), crate::chat::history::stats).await;
    match local {
        Ok(stats) => Ok(stats),
        Err(local_err) => {
            let client = daemon_retry_client(&state, &session_id, local_err).await?;
            client.transcript_stats(&session_id, cwd.as_deref()).await.map_err(|e| e.to_string())
        }
    }
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

    let sid = session_id.clone();
    let c = cwd.clone();
    let local = tauri::async_runtime::spawn_blocking(move || {
        crate::chat::history::read_page_for_session(&sid, c.as_deref(), before_seq, limit)
    })
    .await
    .map_err(|e| format!("join: {}", e))?;

    match local {
        Ok(page) => Ok(page),
        Err(local_err) => {
            let client = daemon_retry_client(&state, &session_id, local_err).await?;
            client
                .load_history_page(&session_id, cwd.as_deref(), before_seq, limit)
                .await
                .map_err(|e| e.to_string())
        }
    }
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

    let tool_use_id_retry = tool_use_id.clone();
    let local = crate::chat::history::with_transcript(session_id.clone(), cwd.clone(), move |path| {
        crate::chat::history::read_single_event(path, seq, &tool_use_id)
    })
    .await;

    match local {
        Ok(event) => Ok(event),
        Err(local_err) => {
            let client = daemon_retry_client(&state, &session_id, local_err).await?;
            client
                .load_event_detail(&session_id, cwd.as_deref(), seq, &tool_use_id_retry)
                .await
                .map_err(|e| e.to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{is_mirrored, is_not_found, should_retry_via_daemon};
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

    // Decision fn for whether a local "not found" retries via the daemon.

    #[test]
    fn retries_when_not_found_and_not_tagged_mirrored() {
        // A session just started on the peer, either absent from this cache
        // or present but not yet carrying the peer's `machine` tag - the
        // window before this cache's next resync. Retrying is cheap and
        // harmless, so this is a deliberate retry, not an oversight.
        assert!(should_retry_via_daemon(true, false));
    }

    #[test]
    fn never_retries_an_id_already_tagged_mirrored() {
        // Unreachable in practice (the caller's own `is_mirrored` check
        // already routes this to the daemon before reaching local disk) but
        // kept explicit so the decision fn's full input space is covered.
        assert!(!should_retry_via_daemon(true, true));
    }

    #[test]
    fn never_retries_without_a_local_not_found() {
        // A successful read, or some other local I/O error (permission
        // denied, corrupt file): the common path must never cost an extra
        // RPC, and a daemon retry would only mask the real error.
        assert!(!should_retry_via_daemon(false, false));
        assert!(!should_retry_via_daemon(false, true));
    }

    #[test]
    fn is_not_found_matches_locate_transcript_message_only() {
        assert!(is_not_found("no transcript found for session abc-123"));
        assert!(!is_not_found("open /x/y.jsonl: permission denied"));
        assert!(!is_not_found(""));
    }
}
