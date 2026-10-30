//! Test doubles for the mirrored-session forward branches: a fake daemon
//! client that records every call it gets and a hand-built instance cache, so
//! a command body runs without a live `AppState`.

use std::sync::{Arc, Mutex};

use super::MirrorReads;
use crate::context_status::ContextStatus;
use crate::daemon_client::ClientError;
use crate::ipc::ai_todos::{AiBacklog, AiTodoDoc, AiTodoEntry};
use crate::ipc::chat::attachments::AttachmentData;
use crate::ipc::files::TextFileData;
use crate::ipc::git::{BranchEntry, GitInfo};
use crate::ipc::git_diff::PrFileChange;
use crate::ipc::git_sync::{CommitEntry, CommitHistory, CommitHistoryEntry, CommitSync};
use crate::tokens::ChatDrain;
use crate::types::{Instance, MachineRef};

/// Records `(method, session_id, args)` per call, where `args` is the call's
/// remaining arguments joined with `|` (just the cwd for most); `fail` makes
/// every call an RPC error so the empty-answer fallback is reachable.
#[derive(Clone)]
pub(crate) struct FakeMirror {
    pub calls: Arc<Mutex<Vec<(String, String, String)>>>,
    pub fail: bool,
}

impl FakeMirror {
    pub fn ok() -> Self {
        Self { calls: Arc::default(), fail: false }
    }

    pub fn failing() -> Self {
        Self { calls: Arc::default(), fail: true }
    }

    pub fn calls(&self) -> Vec<(String, String, String)> {
        self.calls.lock().unwrap().clone()
    }

    fn record(&self, method: &str, session_id: &str, cwd: &str) -> Result<(), ClientError> {
        self.calls.lock().unwrap().push((method.into(), session_id.into(), cwd.into()));
        if self.fail {
            return Err(ClientError::Rpc { code: -32000, message: "peer unreachable".into() });
        }
        Ok(())
    }
}

/// What a successful fake read hands back; no real local read could produce it.
pub(crate) const PEER_TODO_ID: &str = "pc-9999";
pub(crate) const PEER_MODEL: &str = "peer-model";
pub(crate) const PEER_BRANCH: &str = "peer-branch";
pub(crate) const PEER_FILE: &str = "peer/only.rs";
pub(crate) const PEER_DIFF: &str = "diff --git a/peer b/peer";
pub(crate) const PEER_CONTENT: &str = "content only the peer has";
pub(crate) const PEER_TOKENS: u64 = 4242;

impl MirrorReads for FakeMirror {
    async fn list_ai_todos(&self, session_id: &str, cwd: &str) -> Result<Vec<AiTodoEntry>, ClientError> {
        self.record("list_ai_todos", session_id, cwd)?;
        Ok(vec![AiTodoEntry { id: PEER_TODO_ID.into(), ..AiTodoEntry::default() }])
    }

    async fn context_status(&self, session_id: &str) -> Result<Option<ContextStatus>, ClientError> {
        self.record("context_status", session_id, "")?;
        Ok(Some(ContextStatus {
            model: PEER_MODEL.into(),
            window: 1_000_000,
            occupancy: 1,
            remaining: 999_999,
            pct_used: 0,
            pct_left: 100,
            confidence: "heuristic".into(),
        }))
    }

    async fn get_git_info(&self, session_id: &str, cwd: &str) -> Result<GitInfo, ClientError> {
        self.record("get_git_info", session_id, cwd)?;
        Ok(GitInfo {
            branch: Some(PEER_BRANCH.into()),
            repo: None,
            ahead: None,
            behind: None,
            sha: None,
            insertions: None,
            deletions: None,
        })
    }

    async fn list_ai_backlog(&self, session_id: &str, cwd: &str) -> Result<AiBacklog, ClientError> {
        self.record("list_ai_backlog", session_id, cwd)?;
        Ok(AiBacklog { groups: Vec::new(), todos: vec![AiTodoEntry { id: PEER_TODO_ID.into(), ..AiTodoEntry::default() }] })
    }

    async fn read_ai_todo(&self, session_id: &str, cwd: &str, id: &str) -> Result<AiTodoDoc, ClientError> {
        self.record("read_ai_todo", session_id, &format!("{cwd}|{id}"))?;
        Ok(AiTodoDoc { entry: AiTodoEntry { id: PEER_TODO_ID.into(), ..AiTodoEntry::default() }, ..AiTodoDoc::default() })
    }

    async fn get_git_dirty(&self, session_id: &str, cwd: &str) -> Result<Vec<String>, ClientError> {
        self.record("get_git_dirty", session_id, cwd)?;
        Ok(vec![PEER_FILE.into()])
    }

    async fn get_recent_branches(&self, session_id: &str, cwd: &str) -> Result<Vec<BranchEntry>, ClientError> {
        self.record("get_recent_branches", session_id, cwd)?;
        Ok(vec![BranchEntry { name: PEER_BRANCH.into(), current: true, short_sha: None, upstream: None }])
    }

    async fn get_range_files(
        &self,
        session_id: &str,
        cwd: &str,
        from: Option<&str>,
        to: Option<&str>,
        base: Option<&str>,
    ) -> Result<Vec<PrFileChange>, ClientError> {
        self.record("get_range_files", session_id, &format!("{cwd}|{from:?}|{to:?}|{base:?}"))?;
        Ok(vec![PrFileChange { path: PEER_FILE.into(), status: "M".into(), added: 1, removed: 0, old_path: None }])
    }

    async fn get_file_diff(
        &self,
        session_id: &str,
        cwd: &str,
        from: Option<&str>,
        to: Option<&str>,
        base: Option<&str>,
        path: &str,
        context: Option<u32>,
    ) -> Result<String, ClientError> {
        self.record("get_file_diff", session_id, &format!("{cwd}|{from:?}|{to:?}|{base:?}|{path}|{context:?}"))?;
        Ok(PEER_DIFF.into())
    }

    async fn get_file_at_rev(
        &self,
        session_id: &str,
        cwd: &str,
        rev: Option<&str>,
        path: &str,
    ) -> Result<TextFileData, ClientError> {
        self.record("get_file_at_rev", session_id, &format!("{cwd}|{rev:?}|{path}"))?;
        Ok(TextFileData { content: PEER_CONTENT.into(), truncated: false })
    }

    async fn get_commit_sync(&self, session_id: &str, cwd: &str) -> Result<CommitSync, ClientError> {
        self.record("get_commit_sync", session_id, cwd)?;
        Ok(CommitSync {
            ahead: vec![CommitEntry { short_sha: "abc1234".into(), message: "peer commit".into() }],
            behind: Vec::new(),
            has_upstream: true,
        })
    }

    async fn get_commit_history(
        &self,
        session_id: &str,
        cwd: &str,
        offset: u32,
        limit: u32,
    ) -> Result<CommitHistory, ClientError> {
        self.record("get_commit_history", session_id, &format!("{cwd}|{offset}|{limit}"))?;
        Ok(CommitHistory {
            entries: vec![CommitHistoryEntry { short_sha: "abc1234".into(), message: "peer commit".into(), pushed: true, timestamp: 1 }],
            has_more: false,
            has_upstream: true,
        })
    }

    async fn list_branch_files(&self, session_id: &str, cwd: &str, branch: &str) -> Result<Vec<String>, ClientError> {
        self.record("list_branch_files", session_id, &format!("{cwd}|{branch}"))?;
        Ok(vec![PEER_FILE.into()])
    }

    async fn list_project_files(&self, session_id: &str, project_dir: &str) -> Result<Vec<String>, ClientError> {
        self.record("list_project_files", session_id, project_dir)?;
        Ok(vec![PEER_FILE.into()])
    }

    async fn read_image_file(&self, path: &str, session_id: &str) -> Result<AttachmentData, ClientError> {
        self.record("read_image_file", session_id, path)?;
        Ok(AttachmentData { mime: "image/png".into(), base64: PEER_CONTENT.into() })
    }

    async fn instance_token_stats(&self, session_id: &str) -> Result<serde_json::Value, ClientError> {
        self.record("instance_token_stats", session_id, "")?;
        Ok(serde_json::json!({ "tokens": PEER_TOKENS, "turns": 1, "prompts": 1 }))
    }

    async fn chat_drain(&self, session_id: &str) -> Result<Option<ChatDrain>, ClientError> {
        self.record("chat_drain", session_id, "")?;
        Ok(Some(ChatDrain {
            session_id: session_id.into(),
            tokens: PEER_TOKENS,
            five_hour_pct: None,
            weekly_pct: None,
            messages: Vec::new(),
        }))
    }
}

/// An instance cache holding one local row (`local`) and one mirrored row
/// (`mirrored`), the only two states `is_mirrored` distinguishes.
pub(crate) fn instance_cache(local: &str, mirrored: &str) -> Mutex<Vec<Instance>> {
    let row = |sid: &str, machine: Option<MachineRef>| -> Instance {
        let mut v = serde_json::json!({
            "session_id": sid,
            "pid": 0,
            "cwd": "C:/x",
            "project_id": "proj",
            "kind": "interactive",
            "started_at": "2026-10-30T00:00:00Z",
        });
        v["machine"] = serde_json::to_value(machine).unwrap();
        serde_json::from_value(v).unwrap()
    };
    Mutex::new(vec![
        row(local, None),
        row(mirrored, Some(MachineRef { id: "m1".into(), label: "laptop".into(), online: true })),
    ])
}
