//! Per-session state in the daemon. One `Session` per long-lived `claude -p`
//! subprocess. Owned by the SessionMap; accessed via Arc.

use crate::types::chat::ChatEvent;
use dashmap::DashMap;
use std::path::PathBuf;
use std::sync::atomic::AtomicU32;
use std::sync::Arc;
use tokio::process::ChildStdin;
use tokio::sync::{broadcast, Mutex};

pub const BROADCAST_CAPACITY: usize = 1024;

/// Accumulated text of the in-flight streamed text block (ai_todo 186).
/// Written by the pump on each coalesced delta flush; read by the attach
/// paths (pipe `attach_session`, remote WS) to synthesize a full-text resync
/// frame for clients that join or lag mid-turn, and by the legacy conversion
/// for clients that don't speak the delta protocol. Cleared at turn end.
#[derive(Debug, Default)]
pub struct StreamingText {
    pub block: u64,
    pub seq: u64,
    pub text: String,
}

impl StreamingText {
    /// Fold one coalesced chunk in and return the emit `seq` to stamp on its
    /// wire event. A new `block` resets the accumulator (mirrors the parser
    /// clearing on each text `content_block_start`).
    pub fn apply_chunk(&mut self, block: u64, chunk: &str) -> u64 {
        if block != self.block {
            self.block = block;
            self.seq = 0;
            self.text.clear();
        }
        self.text.push_str(chunk);
        self.seq += 1;
        self.seq
    }

    /// Full-text resync frame for a delta-protocol client attaching (or
    /// lagging) mid-turn. `None` when nothing is streaming right now.
    pub fn snapshot_event(&self) -> Option<ChatEvent> {
        if self.text.is_empty() {
            return None;
        }
        Some(ChatEvent::AssistantDelta {
            text: self.text.clone(),
            block: self.block,
            seq: self.seq,
            snapshot: true,
            timestamp: 0,
        })
    }

    /// Old-wire-shape equivalent of [`Self::snapshot_event`]: the full-text
    /// streaming `AssistantMessage` a pre-delta client expects. `None` when
    /// nothing is streaming.
    pub fn legacy_snapshot_event(&self) -> Option<ChatEvent> {
        if self.text.is_empty() {
            return None;
        }
        Some(ChatEvent::AssistantMessage {
            content: vec![crate::types::chat::ContentBlock::Text { text: self.text.clone() }],
            streaming: true,
            timestamp: 0,
        })
    }

    pub fn clear(&mut self) {
        self.block = 0;
        self.seq = 0;
        self.text.clear();
    }
}

pub struct Session {
    pub session_id: String,
    pub cwd: PathBuf,
    pub model: String,
    pub effort: String,
    pub pid: u32,
    pub stdin: Mutex<ChildStdin>,
    pub events: broadcast::Sender<ChatEvent>,
    /// Path to the per-session .mcp.json file. Removed on session end /
    /// pump exit. None if write_mcp_config failed (degrades to no
    /// permission-prompt tool, which is OK for v1).
    pub mcp_config_path: Option<PathBuf>,
    /// Path to the per-session hook-settings .settings.json file (registers
    /// the AskUserQuestion PreToolUse hook). Removed on session end / pump
    /// exit, mirroring `mcp_config_path`. None if write_hook_settings failed
    /// (degrades to AskUserQuestion being unanswerable this session).
    pub hook_settings_path: Option<PathBuf>,
    /// The registry account id this session was spawned under (resolved at
    /// spawn time - see `daemon::lifecycle::spawn_session`). Always set: a
    /// chat requires a registry account, there is no no-account spawn path.
    pub account_id: String,
    /// Text of the most recent turn sent into this session. Kept so that a
    /// turn rejected by a rate limit before it produced any output can be
    /// rescheduled verbatim rather than as a vague "continue". Empty until the
    /// first send. std `Mutex`: only ever held across a `String` clone.
    pub last_prompt: std::sync::Mutex<String>,
    /// In-flight streamed text block accumulator - see [`StreamingText`].
    /// std `Mutex`: only ever held across an append or a `String` clone.
    pub streaming: std::sync::Mutex<StreamingText>,
    /// Consecutive Stop-hook turns where report_turn_status/send_message were
    /// both missing (todo 824): the closest live proxy for MCP reachability,
    /// since the MCP child is a fresh HTTP-only process per turn with no
    /// attach/detach event. Reset to 0 the moment either tool lands.
    pub mcp_miss_streak: AtomicU32,
}

impl Session {
    pub fn new(
        session_id: String,
        cwd: PathBuf,
        model: String,
        effort: String,
        pid: u32,
        stdin: ChildStdin,
        mcp_config_path: Option<PathBuf>,
        hook_settings_path: Option<PathBuf>,
        account_id: String,
    ) -> Arc<Self> {
        let (tx, _rx) = broadcast::channel(BROADCAST_CAPACITY);
        Arc::new(Self {
            session_id,
            cwd,
            model,
            effort,
            pid,
            stdin: Mutex::new(stdin),
            events: tx,
            mcp_config_path,
            hook_settings_path,
            account_id,
            last_prompt: std::sync::Mutex::new(String::new()),
            streaming: std::sync::Mutex::new(StreamingText::default()),
            mcp_miss_streak: AtomicU32::new(0),
        })
    }
}

pub type SessionMap = Arc<DashMap<String, Arc<Session>>>;

pub fn new_session_map() -> SessionMap {
    Arc::new(DashMap::new())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_session_map_is_empty() {
        let m = new_session_map();
        assert_eq!(m.len(), 0);
    }

    #[test]
    fn broadcast_capacity_constant() {
        assert!(BROADCAST_CAPACITY >= 256);
    }

    #[test]
    fn streaming_text_accumulates_and_numbers_emits() {
        let mut s = StreamingText::default();
        assert_eq!(s.apply_chunk(1, "Hello"), 1);
        assert_eq!(s.apply_chunk(1, " world"), 2);
        assert_eq!(s.text, "Hello world");
    }

    #[test]
    fn streaming_text_new_block_resets() {
        let mut s = StreamingText::default();
        s.apply_chunk(1, "first");
        assert_eq!(s.apply_chunk(2, "second"), 1, "seq restarts per block");
        assert_eq!(s.text, "second");
        assert_eq!(s.block, 2);
    }

    #[test]
    fn streaming_text_snapshot_events() {
        let mut s = StreamingText::default();
        assert!(s.snapshot_event().is_none(), "nothing streaming -> no resync frame");
        assert!(s.legacy_snapshot_event().is_none());
        s.apply_chunk(3, "partial tex");
        match s.snapshot_event() {
            Some(ChatEvent::AssistantDelta { text, block, seq, snapshot, .. }) => {
                assert_eq!(text, "partial tex");
                assert_eq!(block, 3);
                assert_eq!(seq, 1);
                assert!(snapshot);
            }
            other => panic!("expected snapshot AssistantDelta, got {:?}", other),
        }
        match s.legacy_snapshot_event() {
            Some(ChatEvent::AssistantMessage { content, streaming, .. }) => {
                assert!(streaming);
                match &content[0] {
                    crate::types::chat::ContentBlock::Text { text } => assert_eq!(text, "partial tex"),
                    _ => panic!("expected text block"),
                }
            }
            other => panic!("expected legacy AssistantMessage, got {:?}", other),
        }
        s.clear();
        assert!(s.snapshot_event().is_none(), "cleared at turn end -> no stale resync");
    }
}
