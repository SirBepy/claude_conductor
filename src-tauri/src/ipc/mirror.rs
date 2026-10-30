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
use crate::ipc::ai_todos::{AiBacklog, AiTodoDoc, AiTodoEntry};
use crate::ipc::chat::attachments::AttachmentData;
use crate::ipc::files::TextFileData;
use crate::ipc::git::{BranchEntry, GitInfo};
use crate::ipc::git_diff::PrFileChange;
use crate::ipc::git_sync::{CommitHistory, CommitSync};
use crate::tokens::ChatDrain;
use crate::types::Instance;

/// The daemon client to route a mirrored session's git/file read through, or
/// `None` when the session is local to this machine (`session_id` absent,
/// not mirrored, or no daemon client is connected right now) - callers fall
/// back to their own local disk read in that case. Takes the instance cache
/// and the client as inputs (not `AppState`) so a command body can be driven
/// by a test with a fake client and a hand-built cache.
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
/// stand in for `PersistentClient`. One method per `PersistentClient` read that a
/// command forwards for a mirrored chat, under the same name.
pub(crate) trait MirrorReads {
    fn list_ai_todos(&self, session_id: &str, cwd: &str) -> impl Future<Output = Result<Vec<AiTodoEntry>, ClientError>> + Send;
    fn list_ai_backlog(&self, session_id: &str, cwd: &str) -> impl Future<Output = Result<AiBacklog, ClientError>> + Send;
    fn read_ai_todo(&self, session_id: &str, cwd: &str, id: &str) -> impl Future<Output = Result<AiTodoDoc, ClientError>> + Send;
    fn context_status(&self, session_id: &str) -> impl Future<Output = Result<Option<ContextStatus>, ClientError>> + Send;
    fn get_git_info(&self, session_id: &str, cwd: &str) -> impl Future<Output = Result<GitInfo, ClientError>> + Send;
    fn get_git_dirty(&self, session_id: &str, cwd: &str) -> impl Future<Output = Result<Vec<String>, ClientError>> + Send;
    fn get_recent_branches(&self, session_id: &str, cwd: &str) -> impl Future<Output = Result<Vec<BranchEntry>, ClientError>> + Send;
    fn get_range_files(&self, session_id: &str, cwd: &str, from: Option<&str>, to: Option<&str>, base: Option<&str>) -> impl Future<Output = Result<Vec<PrFileChange>, ClientError>> + Send;
    fn get_file_diff(&self, session_id: &str, cwd: &str, from: Option<&str>, to: Option<&str>, base: Option<&str>, path: &str, context: Option<u32>) -> impl Future<Output = Result<String, ClientError>> + Send;
    fn get_file_at_rev(&self, session_id: &str, cwd: &str, rev: Option<&str>, path: &str) -> impl Future<Output = Result<TextFileData, ClientError>> + Send;
    fn get_commit_sync(&self, session_id: &str, cwd: &str) -> impl Future<Output = Result<CommitSync, ClientError>> + Send;
    fn get_commit_history(&self, session_id: &str, cwd: &str, offset: u32, limit: u32) -> impl Future<Output = Result<CommitHistory, ClientError>> + Send;
    fn list_branch_files(&self, session_id: &str, cwd: &str, branch: &str) -> impl Future<Output = Result<Vec<String>, ClientError>> + Send;
    fn list_project_files(&self, session_id: &str, project_dir: &str) -> impl Future<Output = Result<Vec<String>, ClientError>> + Send;
    fn read_image_file(&self, path: &str, session_id: &str) -> impl Future<Output = Result<AttachmentData, ClientError>> + Send;
    fn instance_token_stats(&self, session_id: &str) -> impl Future<Output = Result<serde_json::Value, ClientError>> + Send;
    fn chat_drain(&self, session_id: &str) -> impl Future<Output = Result<Option<ChatDrain>, ClientError>> + Send;
}

impl MirrorReads for PersistentClient {
    async fn list_ai_todos(&self, session_id: &str, cwd: &str) -> Result<Vec<AiTodoEntry>, ClientError> {
        PersistentClient::list_ai_todos(self, session_id, cwd).await
    }
    async fn list_ai_backlog(&self, session_id: &str, cwd: &str) -> Result<AiBacklog, ClientError> {
        PersistentClient::list_ai_backlog(self, session_id, cwd).await
    }
    async fn read_ai_todo(&self, session_id: &str, cwd: &str, id: &str) -> Result<AiTodoDoc, ClientError> {
        PersistentClient::read_ai_todo(self, session_id, cwd, id).await
    }
    async fn context_status(&self, session_id: &str) -> Result<Option<ContextStatus>, ClientError> {
        PersistentClient::context_status(self, session_id).await
    }
    async fn get_git_info(&self, session_id: &str, cwd: &str) -> Result<GitInfo, ClientError> {
        PersistentClient::get_git_info(self, session_id, cwd).await
    }
    async fn get_git_dirty(&self, session_id: &str, cwd: &str) -> Result<Vec<String>, ClientError> {
        PersistentClient::get_git_dirty(self, session_id, cwd).await
    }
    async fn get_recent_branches(&self, session_id: &str, cwd: &str) -> Result<Vec<BranchEntry>, ClientError> {
        PersistentClient::get_recent_branches(self, session_id, cwd).await
    }
    async fn get_range_files(&self, session_id: &str, cwd: &str, from: Option<&str>, to: Option<&str>, base: Option<&str>) -> Result<Vec<PrFileChange>, ClientError> {
        PersistentClient::get_range_files(self, session_id, cwd, from, to, base).await
    }
    async fn get_file_diff(&self, session_id: &str, cwd: &str, from: Option<&str>, to: Option<&str>, base: Option<&str>, path: &str, context: Option<u32>) -> Result<String, ClientError> {
        PersistentClient::get_file_diff(self, session_id, cwd, from, to, base, path, context).await
    }
    async fn get_file_at_rev(&self, session_id: &str, cwd: &str, rev: Option<&str>, path: &str) -> Result<TextFileData, ClientError> {
        PersistentClient::get_file_at_rev(self, session_id, cwd, rev, path).await
    }
    async fn get_commit_sync(&self, session_id: &str, cwd: &str) -> Result<CommitSync, ClientError> {
        PersistentClient::get_commit_sync(self, session_id, cwd).await
    }
    async fn get_commit_history(&self, session_id: &str, cwd: &str, offset: u32, limit: u32) -> Result<CommitHistory, ClientError> {
        PersistentClient::get_commit_history(self, session_id, cwd, offset, limit).await
    }
    async fn list_branch_files(&self, session_id: &str, cwd: &str, branch: &str) -> Result<Vec<String>, ClientError> {
        PersistentClient::list_branch_files(self, session_id, cwd, branch).await
    }
    async fn list_project_files(&self, session_id: &str, project_dir: &str) -> Result<Vec<String>, ClientError> {
        PersistentClient::list_project_files(self, session_id, project_dir).await
    }
    async fn read_image_file(&self, path: &str, session_id: &str) -> Result<AttachmentData, ClientError> {
        PersistentClient::read_image_file(self, path, session_id).await
    }
    async fn instance_token_stats(&self, session_id: &str) -> Result<serde_json::Value, ClientError> {
        PersistentClient::instance_token_stats(self, session_id).await
    }
    async fn chat_drain(&self, session_id: &str) -> Result<Option<ChatDrain>, ClientError> {
        PersistentClient::chat_drain(self, session_id).await
    }
}

#[cfg(test)]
pub(crate) mod fake;
