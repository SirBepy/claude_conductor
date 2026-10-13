//! Shared mirrored-session routing helper for IPC commands whose underlying
//! work (git/file reads against a chat's cwd) only makes sense on the
//! machine actually hosting the session - a chat mirrored in from a paired
//! peer machine (`Instance.machine`, see `CLAUDE.md`'s federation module map)
//! has its cwd on the PEER's disk, not this one's (G10, docs/multi-machine.md).
//!
//! Reuses `ipc::chat::history::is_mirrored` (same `AppState.cached_instances`
//! check `load_history`/`transcript_stats`/etc already route on) so every
//! call site here agrees with the chat-history routing about what counts as
//! mirrored, rather than re-deriving the check.

use crate::state::AppState;

/// The daemon client to route a mirrored session's git/file read through, or
/// `None` when the session is local to this machine (`session_id` absent,
/// not mirrored, or the daemon client isn't connected right now) - callers
/// fall back to their own local disk read in that case, unchanged from
/// before this module existed.
pub(crate) async fn mirrored_client(
    state: &AppState,
    session_id: Option<&str>,
) -> Option<crate::daemon_client::PersistentClient> {
    let sid = session_id?;
    if !super::chat::history::is_mirrored(&state.cached_instances.lock().unwrap(), sid) {
        return None;
    }
    state.client().await
}
