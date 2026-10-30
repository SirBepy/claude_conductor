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

use std::future::Future;
use std::sync::Mutex;

use crate::context_status::ContextStatus;
use crate::daemon_client::{ClientError, PersistentClient};
use crate::ipc::ai_todos::AiTodoEntry;
use crate::ipc::git::GitInfo;
use crate::state::AppState;
use crate::types::Instance;

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

/// `mirrored_client`'s decision with the client already in hand, so a command
/// body can be driven by a test with a fake client and a hand-built instance
/// cache instead of a live `AppState`.
pub(crate) fn route_mirrored<C>(
    instances: &Mutex<Vec<Instance>>,
    session_id: Option<&str>,
    client: Option<C>,
) -> Option<C> {
    let sid = session_id?;
    if !super::chat::history::is_mirrored(&instances.lock().unwrap(), sid) {
        return None;
    }
    client
}

/// The daemon calls a mirrored-session branch makes, as a trait so a test can
/// stand in for `PersistentClient`. Only the commands whose forward branch has
/// a test go through it; the rest still take `PersistentClient` directly.
pub(crate) trait MirrorReads {
    fn list_ai_todos(&self, session_id: &str, cwd: &str) -> impl Future<Output = Result<Vec<AiTodoEntry>, ClientError>> + Send;
    fn context_status(&self, session_id: &str) -> impl Future<Output = Result<Option<ContextStatus>, ClientError>> + Send;
    fn get_git_info(&self, session_id: &str, cwd: &str) -> impl Future<Output = Result<GitInfo, ClientError>> + Send;
}

impl MirrorReads for PersistentClient {
    async fn list_ai_todos(&self, session_id: &str, cwd: &str) -> Result<Vec<AiTodoEntry>, ClientError> {
        PersistentClient::list_ai_todos(self, session_id, cwd).await
    }
    async fn context_status(&self, session_id: &str) -> Result<Option<ContextStatus>, ClientError> {
        PersistentClient::context_status(self, session_id).await
    }
    async fn get_git_info(&self, session_id: &str, cwd: &str) -> Result<GitInfo, ClientError> {
        PersistentClient::get_git_info(self, session_id, cwd).await
    }
}

#[cfg(test)]
#[path = "mirror_fake.rs"]
pub(crate) mod fake;
