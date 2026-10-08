//! Typed wrappers for the daemon's history RPCs (`daemon/methods/history.rs`,
//! `daemon/methods/registry/listings.rs`). Used by `ipc/chat/history.rs` when
//! a session is mirrored from a paired peer, so a desktop-pipe call to a
//! session with no local transcript goes through the daemon's own
//! `machines/forward.rs::forward_one` seam instead of failing a local
//! filesystem read. Local sessions keep reading the JSONL directly - these
//! wrappers exist only for the mirrored branch.

use super::super::{ClientError, PersistentClient};
use crate::chat::history::TranscriptStats;
use crate::types::chat::{ChatEvent, HistoryPage};
use serde_json::json;

impl PersistentClient {
    pub async fn load_history(&self, session_id: &str, cwd: Option<&str>) -> Result<Vec<ChatEvent>, ClientError> {
        let res = self.call("load_history", json!({"session_id": session_id, "cwd": cwd})).await?;
        serde_json::from_value(res).map_err(|e| ClientError::Rpc {
            code: -32000,
            message: format!("load_history: bad result shape: {e}"),
        })
    }

    pub async fn transcript_stats(&self, session_id: &str, cwd: Option<&str>) -> Result<TranscriptStats, ClientError> {
        let res = self.call("transcript_stats", json!({"session_id": session_id, "cwd": cwd})).await?;
        serde_json::from_value(res).map_err(|e| ClientError::Rpc {
            code: -32000,
            message: format!("transcript_stats: bad result shape: {e}"),
        })
    }

    pub async fn load_history_page(
        &self,
        session_id: &str,
        cwd: Option<&str>,
        before_seq: Option<u64>,
        message_limit: u32,
    ) -> Result<HistoryPage, ClientError> {
        let res = self
            .call("load_history_page", json!({
                "session_id": session_id,
                "cwd": cwd,
                "before_seq": before_seq,
                "message_limit": message_limit,
            }))
            .await?;
        serde_json::from_value(res).map_err(|e| ClientError::Rpc {
            code: -32000,
            message: format!("load_history_page: bad result shape: {e}"),
        })
    }

    pub async fn load_event_detail(
        &self,
        session_id: &str,
        cwd: Option<&str>,
        seq: u64,
        tool_use_id: &str,
    ) -> Result<ChatEvent, ClientError> {
        let res = self
            .call("load_event_detail", json!({
                "session_id": session_id,
                "cwd": cwd,
                "seq": seq,
                "tool_use_id": tool_use_id,
            }))
            .await?;
        serde_json::from_value(res).map_err(|e| ClientError::Rpc {
            code: -32000,
            message: format!("load_event_detail: bad result shape: {e}"),
        })
    }
}
