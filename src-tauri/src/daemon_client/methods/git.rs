//! Typed wrappers for the daemon's git/file-read RPCs (`daemon/methods/statusbar.rs`,
//! `daemon/methods/worktrees.rs`, `daemon/methods/pr_review.rs`,
//! `daemon/methods/files.rs`). Used by `ipc::git`/`ipc::git_diff`/
//! `ipc::git_branch_preview`/`ipc::files` when a session is mirrored from a
//! paired peer machine (G10 in docs/multi-machine.md), so Code
//! mode, the commits popover, and the git/dirty chips route one hop to the
//! owning peer via `machines/forward.rs::forward_one` instead of running
//! `git` against a path on the peer's disk. Local sessions keep reading disk
//! directly - these wrappers exist only for the mirrored branch.
//!
//! Every call sends `session_id` alongside `cwd`: the executing daemon (the
//! session's owner) resolves the real cwd from ITS OWN registry when
//! `session_id` is present, ignoring the `cwd` we send - see
//! `daemon/methods/pr_review.rs::resolve_cwd`'s doc. `cwd` is still sent
//! (rather than omitted) only because the phone's existing, unrelated calls
//! to these same RPC names use the same param shape without a `session_id`.

use super::super::{ClientError, PersistentClient};
use super::bad_shape;
use crate::ipc::ai_todos::{AiBacklog, AiTodoDoc, AiTodoEntry};
use crate::ipc::git::{BranchEntry, GitInfo};
use crate::ipc::git_diff::PrFileChange;
use crate::ipc::git_sync::{CommitHistory, CommitSync};
use crate::ipc::files::TextFileData;
use serde_json::json;

impl PersistentClient {
    pub async fn get_git_info(&self, session_id: &str, cwd: &str) -> Result<GitInfo, ClientError> {
        let res = self.call("get_git_info", json!({"session_id": session_id, "cwd": cwd})).await?;
        serde_json::from_value(res).map_err(|e| bad_shape("get_git_info", e))
    }

    pub async fn get_git_dirty(&self, session_id: &str, cwd: &str) -> Result<Vec<String>, ClientError> {
        let res = self.call("get_git_dirty", json!({"session_id": session_id, "cwd": cwd})).await?;
        serde_json::from_value(res).map_err(|e| bad_shape("get_git_dirty", e))
    }

    pub async fn get_recent_branches(&self, session_id: &str, cwd: &str) -> Result<Vec<BranchEntry>, ClientError> {
        let res = self.call("get_recent_branches", json!({"session_id": session_id, "cwd": cwd})).await?;
        serde_json::from_value(res).map_err(|e| bad_shape("get_recent_branches", e))
    }

    pub async fn get_commit_sync(&self, session_id: &str, cwd: &str) -> Result<CommitSync, ClientError> {
        let res = self.call("get_commit_sync", json!({"session_id": session_id, "cwd": cwd})).await?;
        serde_json::from_value(res).map_err(|e| bad_shape("get_commit_sync", e))
    }

    pub async fn get_commit_history(
        &self,
        session_id: &str,
        cwd: &str,
        offset: u32,
        limit: u32,
    ) -> Result<CommitHistory, ClientError> {
        let res = self
            .call("get_commit_history", json!({"session_id": session_id, "cwd": cwd, "offset": offset, "limit": limit}))
            .await?;
        serde_json::from_value(res).map_err(|e| bad_shape("get_commit_history", e))
    }

    pub async fn get_range_files(
        &self,
        session_id: &str,
        cwd: &str,
        from: Option<&str>,
        to: Option<&str>,
        base: Option<&str>,
    ) -> Result<Vec<PrFileChange>, ClientError> {
        let res = self
            .call("get_range_files", json!({"session_id": session_id, "cwd": cwd, "from": from, "to": to, "base": base}))
            .await?;
        serde_json::from_value(res).map_err(|e| bad_shape("get_range_files", e))
    }

    pub async fn get_file_diff(
        &self,
        session_id: &str,
        cwd: &str,
        from: Option<&str>,
        to: Option<&str>,
        base: Option<&str>,
        path: &str,
        context: Option<u32>,
    ) -> Result<String, ClientError> {
        let res = self
            .call("get_file_diff", json!({
                "session_id": session_id, "cwd": cwd, "from": from, "to": to, "base": base,
                "path": path, "context": context,
            }))
            .await?;
        serde_json::from_value(res).map_err(|e| bad_shape("get_file_diff", e))
    }

    pub async fn get_file_at_rev(
        &self,
        session_id: &str,
        cwd: &str,
        rev: Option<&str>,
        path: &str,
    ) -> Result<TextFileData, ClientError> {
        let res = self
            .call("get_file_at_rev", json!({"session_id": session_id, "cwd": cwd, "rev": rev, "path": path}))
            .await?;
        serde_json::from_value(res).map_err(|e| bad_shape("get_file_at_rev", e))
    }

    pub async fn list_branch_files(&self, session_id: &str, cwd: &str, branch: &str) -> Result<Vec<String>, ClientError> {
        let res = self
            .call("list_branch_files", json!({"session_id": session_id, "cwd": cwd, "branch": branch}))
            .await?;
        serde_json::from_value(res).map_err(|e| bad_shape("list_branch_files", e))
    }

    pub async fn list_project_files(&self, session_id: &str, project_dir: &str) -> Result<Vec<String>, ClientError> {
        let res = self
            .call("list_project_files", json!({"session_id": session_id, "project_dir": project_dir}))
            .await?;
        serde_json::from_value(res).map_err(|e| bad_shape("list_project_files", e))
    }

    pub async fn list_ai_todos(&self, session_id: &str, cwd: &str) -> Result<Vec<AiTodoEntry>, ClientError> {
        let res = self.call("list_ai_todos", json!({"session_id": session_id, "cwd": cwd})).await?;
        serde_json::from_value(res).map_err(|e| bad_shape("list_ai_todos", e))
    }

    pub async fn list_ai_backlog(&self, session_id: &str, cwd: &str) -> Result<AiBacklog, ClientError> {
        let res = self.call("list_ai_backlog", json!({"session_id": session_id, "cwd": cwd})).await?;
        serde_json::from_value(res).map_err(|e| bad_shape("list_ai_backlog", e))
    }

    pub async fn read_ai_todo(&self, session_id: &str, cwd: &str, id: &str) -> Result<AiTodoDoc, ClientError> {
        let res = self.call("read_ai_todo", json!({"session_id": session_id, "cwd": cwd, "id": id})).await?;
        serde_json::from_value(res).map_err(|e| bad_shape("read_ai_todo", e))
    }
}
