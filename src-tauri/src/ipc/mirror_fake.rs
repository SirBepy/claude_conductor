//! Test doubles for the mirrored-session forward branches: a fake daemon
//! client that records every call it gets and a hand-built instance cache, so
//! a command body runs without a live `AppState`.

use std::sync::{Arc, Mutex};

use super::MirrorReads;
use crate::context_status::ContextStatus;
use crate::daemon_client::ClientError;
use crate::ipc::ai_todos::AiTodoEntry;
use crate::ipc::git::GitInfo;
use crate::types::{Instance, MachineRef};

/// Records `(method, session_id, cwd)` per call; `fail` makes every call an
/// RPC error so the empty-answer fallback is reachable.
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
