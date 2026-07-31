use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, ts_rs::TS)]
#[serde(tag = "type", rename_all = "lowercase")]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub enum ContentBlock {
    Text { text: String },
    Image { mime: String, data: String },
}

/// Prefix `daemon::lifecycle::send_message` embeds in the literal text it
/// writes to a session's stdin for a daemon-injected turn (repo-channel wake,
/// Jarvis worker-wake, scheduled hygiene fire). Unlike `UserMessage::is_meta`
/// below, `isMeta:true` on a transcript line is something ONLY the `claude`
/// CLI itself decides to set on its own self-injected turns - a plain stdin
/// message we send has no way to make the CLI persist that field, so the flag
/// is lost the moment the transcript is replayed from disk instead of read
/// live off the daemon's own broadcast. This sentinel survives into the CLI's
/// persisted transcript because it's part of the message text itself;
/// `chat::parser` strips it back off and treats the turn as `is_meta: true`
/// regardless of the (likely absent) `isMeta` JSON field.
pub const DAEMON_META_SENTINEL: &str = "\u{200B}[daemon-meta]\u{200B}";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, ts_rs::TS)]
#[serde(tag = "type", rename_all = "snake_case")]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub enum ChatEvent {
    SessionStarted {
        session_id: String,
        model: String,
        cwd: String,
        timestamp: i64,
    },
    UserMessage {
        content: Vec<ContentBlock>,
        timestamp: i64,
        /// True when this event was synthesised by the daemon's `send_message`
        /// path as a marked echo (e.g. from a remote/phone send). The frontend
        /// delivers marked echoes and drops unmarked ones (which come from
        /// `claude --resume` history replay). `#[serde(default)]` only: ts-rs
        /// 9/10 cannot parse `skip_serializing_if` and will break type export.
        #[serde(default)]
        remote_echo: bool,
        /// True when the transcript line carries `"isMeta":true` - Claude
        /// Code's own marker for a self-injected turn (a fired `ScheduleWakeup`
        /// prompt, an autopilot/resume continuation, etc.) rather than
        /// something the human actually typed. The frontend must never render
        /// this identically to a real user bubble.
        #[serde(default)]
        is_meta: bool,
    },
    AssistantMessage {
        content: Vec<ContentBlock>,
        streaming: bool,
        timestamp: i64,
    },
    /// O(delta) live-stream chunk (ai_todo 186). Replaces the per-chunk
    /// full-text `AssistantMessage { streaming: true }` snapshots on the live
    /// wire: `text` carries only the new characters. `block` is the text-block
    /// ordinal within the stream (client accumulators reset when it changes;
    /// each turn's fresh `claude -p` process restarts it at 1). `seq` is the
    /// per-block emit sequence assigned by the daemon pump after coalescing,
    /// so a client can drop deltas already covered by a `snapshot: true`
    /// resync frame (whose `text` is the FULL accumulated block text; sent on
    /// mid-turn attach and after broadcast lag). Never appears in JSONL
    /// history replay - those paths still emit full `AssistantMessage`s.
    AssistantDelta {
        text: String,
        block: u64,
        seq: u64,
        snapshot: bool,
        timestamp: i64,
    },
    ToolUse {
        tool_name: String,
        #[ts(type = "unknown")]
        input: serde_json::Value,
        id: String,
        timestamp: i64,
        #[serde(default)]
        parent_tool_use_id: Option<String>,
    },
    ToolResult {
        tool_use_id: String,
        output: ContentBlock,
        is_error: bool,
        timestamp: i64,
    },
    Notification {
        kind: String,
        body: String,
    },
    SessionEnded {
        exit_code: Option<i32>,
        timestamp: i64,
    },
    /// Emitted once per completed turn from the `result` line.
    /// `input_tokens` = full context window usage for this turn (not additive).
    /// `total_cost_usd` = cumulative session cost estimate.
    TurnUsage {
        input_tokens: u64,
        output_tokens: u64,
        cache_creation_input_tokens: u64,
        cache_read_input_tokens: u64,
        total_cost_usd: f64,
        duration_ms: u64,
        has_thinking: bool,
        /// Model that produced this turn. Populated from JSONL assistant lines
        /// (where the model field lives on the message object) and left None
        /// when emitted from the live `result` stream line.
        model: Option<String>,
        /// Self-reported turn status detected from the `<cc-status:..>` marker
        /// in the result text. `Some("question")` or `Some("done")`, or None if
        /// no marker was found.
        awaiting: Option<String>,
        /// `<cc-autopilot:on>` / `<cc-autopilot:off>` marker detected in the
        /// result text. `Some(true)` = autopilot started, `Some(false)` = finished.
        /// `None` = no autopilot marker this turn.
        autopilot_changed: Option<bool>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct HistoryEntry {
    pub session_id: String,
    pub project_id: String,
    pub cwd: String,
    pub title: String,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub message_count: u32,
    pub last_kind: crate::sessions::kinds::InstanceKind,
}

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct HistoryPage {
    pub events: Vec<ChatEvent>,
    pub oldest_seq: u64,
    pub newest_seq: u64,
    pub has_more: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_message_round_trips() {
        let ev = ChatEvent::UserMessage {
            content: vec![ContentBlock::Text { text: "hi".into() }],
            timestamp: 1700000000,
            remote_echo: false,
            is_meta: false,
        };
        let s = serde_json::to_string(&ev).unwrap();
        let back: ChatEvent = serde_json::from_str(&s).unwrap();
        assert_eq!(ev, back);
    }

    #[test]
    fn streaming_assistant_message_marks_partial() {
        let ev = ChatEvent::AssistantMessage {
            content: vec![ContentBlock::Text { text: "partial".into() }],
            streaming: true,
            timestamp: 1700000001,
        };
        let s = serde_json::to_string(&ev).unwrap();
        assert!(s.contains("\"streaming\":true"));
    }

    #[test]
    fn content_block_image_serializes_with_base64_data() {
        let block = ContentBlock::Image {
            mime: "image/png".into(),
            data: "ZmFrZQ==".into(),
        };
        let s = serde_json::to_string(&block).unwrap();
        assert!(s.contains("\"mime\":\"image/png\""));
        assert!(s.contains("\"data\":\"ZmFrZQ==\""));
    }
}
