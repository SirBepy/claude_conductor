use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, ts_rs::TS)]
#[serde(tag = "type", rename_all = "lowercase")]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub enum ContentBlock {
    Text { text: String },
    Image { mime: String, data: String },
}

/// Prefix `lifecycle::send_message` embeds in the wire text for a daemon-
/// injected turn (repo-channel/Jarvis/schedule wake), since a plain stdin
/// message has no way to make the CLI persist `isMeta:true` on replay.
/// `chat::parser` strips it and treats the turn as meta regardless.
pub const DAEMON_META_SENTINEL: &str = "\u{200B}[daemon-meta]\u{200B}";

/// Wraps a sending session's id in the wire text for a Jarvis-relayed
/// message (todo 682) - same "event field can't survive reload" constraint
/// `DAEMON_META_SENTINEL` above already solved. Every text-reading site
/// (`chat::parser`, `tokens::title/walker`) must strip it first.
pub const DAEMON_AUTHOR_SENTINEL_PREFIX: &str = "\u{200B}[daemon-author:";
pub const DAEMON_AUTHOR_SENTINEL_SUFFIX: &str = "]\u{200B}";

/// Splits a leading sentinel off `text`, returning `(Some(session_id),
/// remainder)`, or `(None, text)` unchanged if absent/malformed. Shared by
/// both `ContentBlock`- and raw-`&str`-based callers.
pub fn strip_daemon_author_sentinel(text: &str) -> (Option<&str>, &str) {
    let Some(after_prefix) = text.strip_prefix(DAEMON_AUTHOR_SENTINEL_PREFIX) else {
        return (None, text);
    };
    let Some(suffix_idx) = after_prefix.find(DAEMON_AUTHOR_SENTINEL_SUFFIX) else {
        return (None, text);
    };
    let session_id = &after_prefix[..suffix_idx];
    let remainder = &after_prefix[suffix_idx + DAEMON_AUTHOR_SENTINEL_SUFFIX.len()..];
    (Some(session_id), remainder)
}

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
        /// Sending session's id when relayed by another AI on Joe's behalf
        /// (a Jarvis dispatch), None otherwise. Carried via the sentinel
        /// above so it survives reload; see that const's doc.
        #[serde(default)]
        author_session_id: Option<String>,
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
        /// Set by `read_page` (paginated Sessions load only) when `output` was
        /// shortened to a preview. Full content fetches via `load_event_detail`.
        #[serde(default)]
        output_truncated: bool,
        /// This line's own transcript byte offset, set alongside `output_truncated`
        /// - reuses `read_page`'s existing pagination-cursor offset.
        #[serde(default)]
        full_seq: Option<u64>,
    },
    Notification {
        kind: String,
        body: String,
    },
    SessionEnded {
        exit_code: Option<i32>,
        timestamp: i64,
    },
    /// Broadcast lagged: every non-delta event in the gap is permanently gone
    /// from the live channel, since only the streaming accumulator self-heals.
    /// Frontend must force a fresh transcript re-read to recover the rest.
    EventsLagged {
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
    /// Last-seen model id for this session (assistant-line `message.model`,
    /// falling back to the init line's model). None if never parsed.
    pub model: Option<String>,
    /// Last `<cc-status:..>` marker seen in the transcript (question/done/
    /// waiting/working). None if no assistant turn carried one.
    pub last_status: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct HistoryPage {
    pub events: Vec<ChatEvent>,
    pub oldest_seq: u64,
    pub newest_seq: u64,
    pub has_more: bool,
    /// Session id whose transcript continues above this one, set only on the
    /// page that exhausts the current file (`has_more == false`). A `/respawn`
    /// successor points at its predecessor here, so scrolling up walks the
    /// whole chain instead of dead-ending at a fresh context window.
    #[serde(default)]
    pub continues_from: Option<String>,
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
            author_session_id: None,
        };
        let s = serde_json::to_string(&ev).unwrap();
        let back: ChatEvent = serde_json::from_str(&s).unwrap();
        assert_eq!(ev, back);
    }

    #[test]
    fn strip_daemon_author_sentinel_extracts_id_and_leaves_clean_remainder() {
        let text = format!(
            "{}sid-jarvis-1{}worker task text",
            DAEMON_AUTHOR_SENTINEL_PREFIX, DAEMON_AUTHOR_SENTINEL_SUFFIX
        );
        let (id, remainder) = strip_daemon_author_sentinel(&text);
        assert_eq!(id, Some("sid-jarvis-1"));
        assert_eq!(remainder, "worker task text");
    }

    #[test]
    fn strip_daemon_author_sentinel_leaves_plain_text_untouched() {
        let (id, remainder) = strip_daemon_author_sentinel("just a normal message");
        assert_eq!(id, None);
        assert_eq!(remainder, "just a normal message");
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
