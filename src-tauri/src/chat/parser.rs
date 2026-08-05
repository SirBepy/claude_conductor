//! Line-delimited stream-json parser. Each line of `claude -p --output-format=stream-json --verbose`
//! is one JSON object describing a chat event. This module turns those lines into typed
//! `ChatEvent`s and buffers across read boundaries (a line may straddle two `read()` calls
//! when streaming partial messages).

use crate::types::chat::{ChatEvent, ContentBlock};
use serde_json::Value;

// Marker detection (`<cc-status:...>` / `<cc-autopilot:...>`) is chat-protocol
// concern, not stream-json line parsing; it lives in `markers.rs`. Re-export
// `detect_awaiting` under this module's path so existing `chat::parser::detect_awaiting`
// call sites (e.g. daemon/hooks_server/stop.rs) keep working unchanged.
pub(crate) use super::markers::detect_awaiting;
use super::markers::detect_autopilot;

/// Extract an event's `timestamp` as an epoch value the frontend can format.
///
/// Two producers write this field differently: the live `stream-json` output
/// carries a numeric epoch (what the tests use), while the persisted transcript
/// JSONL stores an RFC3339 string (e.g. "2026-07-11T09:34:05.750Z"). Numbers
/// pass through unchanged; strings parse to epoch millis (always > 1e10, so the
/// frontend's seconds-vs-millis heuristic treats them as milliseconds). Without
/// the string arm, `as_i64()` returned `None` for every history line and the
/// per-message hover timestamps silently disappeared. Returns 0 when the field
/// is absent or unparseable.
fn event_timestamp(v: &Value) -> i64 {
    match v.get("timestamp") {
        Some(Value::Number(n)) => n.as_i64().unwrap_or(0),
        Some(Value::String(s)) => chrono::DateTime::parse_from_rfc3339(s)
            .map(|dt| dt.timestamp_millis())
            .unwrap_or(0),
        _ => 0,
    }
}

pub struct ParserContext {
    buf: Vec<u8>,
    /// Ordinal of the current text content_block, incremented on each
    /// `content_block_start { type: "text" }`. Stamped onto the
    /// `AssistantDelta` emitted per `content_block_delta` chunk so consumers
    /// know when to reset their accumulator (ai_todo 186 - the parser no
    /// longer accumulates text itself; the daemon pump owns the running text
    /// via `Session::streaming`, keeping per-chunk cost O(delta)).
    text_block: u64,
    /// Set when a `content_block_start` with type "thinking" is seen in the
    /// stream. Stays true for the session lifetime so the statusbar keeps
    /// the indicator after the first thinking turn.
    has_thinking: bool,
    /// Live-stream mode. When true, the full `assistant` message line is
    /// suppressed: its visible text is already streamed via `stream_event`
    /// deltas and finalized by the trailing `result` line, and its usage is
    /// authoritative only on `result`. Forwarding it duplicates both the
    /// message and the TurnUsage, tripling every live turn (ai_todo 47).
    /// History replay (bare `parse_line`, no `result` line) is unaffected and
    /// keeps per-assistant-line usage. Defaults to false for back-compat.
    live: bool,
    /// Set whenever a `stream_event` line is fed. `--resume` history replay never
    /// emits that envelope, so this is a turn-liveness signal that fires even for
    /// tool-only turns, unlike `AssistantDelta`/`ToolUse` (both present on replay).
    saw_stream_event: bool,
}

impl ParserContext {
    pub fn new() -> Self {
        Self {
            buf: Vec::with_capacity(4096),
            text_block: 0,
            has_thinking: false,
            live: false,
            saw_stream_event: false,
        }
    }

    /// Parser for a live `claude` stdout stream (daemon pump / runner). See the
    /// `live` field for why the full `assistant` line is suppressed.
    pub fn new_live() -> Self {
        Self { live: true, ..Self::new() }
    }

    /// Read and clear `saw_stream_event` (todo 475). The daemon pump polls this
    /// once per line read to detect the live turn's earliest signal, before any
    /// content (text or tool) has streamed.
    pub fn take_stream_event_seen(&mut self) -> bool {
        std::mem::replace(&mut self.saw_stream_event, false)
    }

    pub fn feed(&mut self, bytes: &[u8]) -> Vec<ChatEvent> {
        self.buf.extend_from_slice(bytes);
        let mut events = Vec::new();
        while let Some(pos) = self.buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = self.buf.drain(..=pos).collect();
            // strip trailing \n (and possible \r on Windows)
            let len = line.len().saturating_sub(1);
            let trimmed = if len > 0 && line[len - 1] == b'\r' { len - 1 } else { len };
            let line_str = String::from_utf8_lossy(&line[..trimmed]);
            if line_str.trim().is_empty() {
                continue;
            }
            // stream_event lines (--include-partial-messages output) need
            // accumulator state, so handle them inline. parse_result_line
            // handles `result` (also stateful: reads has_thinking). parse_line
            // covers the remaining stateless lines.
            if let Some(stream_events) = self.parse_stream_event_line(&line_str) {
                self.saw_stream_event = true;
                events.extend(stream_events);
            } else if let Some(result_events) = self.parse_result_line(&line_str) {
                events.extend(result_events);
            } else if self.live && is_full_assistant_line(&line_str) {
                // Redundant text/usage in a live stream: deltas already showed the
                // text and the `result` line finalizes it + carries authoritative
                // usage (ai_todo 47). BUT the full `assistant` line is the only
                // carrier of complete `tool_use` blocks (stream_event deltas never
                // emit a finished tool_use), so salvage those before dropping the
                // rest - without this the "changes" panel and tool rows stay empty.
                events.extend(tool_use_from_assistant_line(&line_str));
                continue;
            } else {
                events.extend(parse_line(&line_str));
            }
        }
        events
    }

    /// Returns `Some(events)` if `line` is a `stream_event` (possibly empty
    /// vec when the inner event is a no-op like message_start). `None` means
    /// the line is not a stream_event and should fall through to parse_line.
    fn parse_stream_event_line(&mut self, line: &str) -> Option<Vec<ChatEvent>> {
        let v: Value = serde_json::from_str(line).ok()?;
        if v.get("type").and_then(|t| t.as_str())? != "stream_event" {
            return None;
        }
        let event = v.get("event")?;
        let event_type = event.get("type").and_then(|t| t.as_str())?;
        let ts = event_timestamp(&v);

        match event_type {
            "content_block_start" => {
                let block_type = event
                    .get("content_block")
                    .and_then(|c| c.get("type"))
                    .and_then(|t| t.as_str())
                    .unwrap_or("");
                if block_type == "text" {
                    // New text block: bump the ordinal so delta consumers
                    // reset their accumulator (covers malformed streams that
                    // skip content_block_stop too).
                    self.text_block += 1;
                } else if block_type == "thinking" {
                    self.has_thinking = true;
                }
                Some(Vec::new())
            }
            "content_block_delta" => {
                if let Some(t) = text_delta(line) {
                    // O(delta) on the wire (ai_todo 186): forward only the new
                    // chunk. `seq` is assigned downstream by the daemon pump
                    // after coalescing (see lifecycle.rs); 0 here.
                    return Some(vec![ChatEvent::AssistantDelta {
                        text: t,
                        block: self.text_block,
                        seq: 0,
                        snapshot: false,
                        timestamp: ts,
                    }]);
                }
                // signature_delta / thinking_delta / input_json_delta - skip silently.
                Some(Vec::new())
            }
            // message_start / content_block_stop / message_delta / message_stop
            // are bookkeeping; the standalone `result` line will finalize the
            // turn, so we don't emit a finalize from message_stop (would
            // duplicate).
            _ => Some(Vec::new()),
        }
    }

    /// Returns `Some(events)` if `line` is a `result` line, `None` otherwise.
    /// Emits both a finalized AssistantMessage and a TurnUsage event.
    fn parse_result_line(&mut self, line: &str) -> Option<Vec<ChatEvent>> {
        let v: Value = serde_json::from_str(line).ok()?;
        if v.get("type").and_then(|t| t.as_str())? != "result" {
            return None;
        }
        let ts = event_timestamp(&v);
        let mut events = Vec::new();

        let result_text = v.get("result").and_then(|s| s.as_str()).unwrap_or("");
        let awaiting = detect_awaiting(result_text);
        let autopilot_changed = detect_autopilot(result_text);

        if !result_text.is_empty() {
            events.push(ChatEvent::AssistantMessage {
                content: vec![crate::types::chat::ContentBlock::Text { text: result_text.to_string() }],
                streaming: false,
                timestamp: ts,
            });
        }

        let usage = v.get("usage");
        let input_tokens = usage.and_then(|u| u.get("input_tokens")).and_then(|v| v.as_u64()).unwrap_or(0);
        let output_tokens = usage.and_then(|u| u.get("output_tokens")).and_then(|v| v.as_u64()).unwrap_or(0);
        let cache_creation = usage.and_then(|u| u.get("cache_creation_input_tokens")).and_then(|v| v.as_u64()).unwrap_or(0);
        let cache_read = usage.and_then(|u| u.get("cache_read_input_tokens")).and_then(|v| v.as_u64()).unwrap_or(0);
        let total_cost_usd = v.get("total_cost_usd").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let duration_ms = v.get("duration_ms").and_then(|v| v.as_u64()).unwrap_or(0);

        events.push(ChatEvent::TurnUsage {
            input_tokens,
            output_tokens,
            cache_creation_input_tokens: cache_creation,
            cache_read_input_tokens: cache_read,
            total_cost_usd,
            duration_ms,
            has_thinking: self.has_thinking,
            model: None,
            awaiting,
            autopilot_changed,
        });

        Some(events)
    }
}

/// Extracts the visible text from one stream-json line if it is a
/// `content_block_delta` carrying a `text_delta`. Returns `None` for any
/// other line (thinking/signature deltas, block-start/stop, result, blank).
pub fn text_delta(line: &str) -> Option<String> {
    let v: Value = serde_json::from_str(line.trim()).ok()?;
    if v.get("type")?.as_str()? != "stream_event" {
        return None;
    }
    let event = v.get("event")?;
    if event.get("type")?.as_str()? != "content_block_delta" {
        return None;
    }
    let delta = event.get("delta")?;
    if delta.get("type")?.as_str()? != "text_delta" {
        return None;
    }
    Some(delta.get("text")?.as_str()?.to_string())
}

/// True if `line` is a full `assistant` message line (`"type":"assistant"`),
/// as opposed to a `stream_event` delta or a `result` line. Used by live-mode
/// `feed()` to suppress these redundant lines (see `ParserContext::live`).
fn is_full_assistant_line(line: &str) -> bool {
    serde_json::from_str::<Value>(line)
        .ok()
        .as_ref()
        .and_then(|v| v.get("type"))
        .and_then(Value::as_str)
        == Some("assistant")
}

/// Parse one JSONL line and return 0-2 `ChatEvent`s. Most lines produce one
/// event; an "assistant" JSONL line that carries `message.model` + `message.usage`
/// also emits a `TurnUsage` so the statusbar can show model/cost from history.
pub fn parse_line(line: &str) -> Vec<ChatEvent> {
    let v: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(_) => return vec![],
    };
    let ts = event_timestamp(&v);
    let Some(ty) = v.get("type").and_then(|t| t.as_str()) else { return vec![]; };
    match ty {
        // The init `system` line is what carries the session_id we care about.
        // Other system subtypes (hook_started / hook_response / SessionStart hook
        // re-emissions on each --resume turn) are noise for the chat surface and
        // are dropped here. The instance registry is fed via the dedicated
        // SessionStart HTTP hook, not via this stdout stream.
        "system" => {
            let subtype = v.get("subtype").and_then(|s| s.as_str()).unwrap_or("");
            if subtype == "init" {
                vec![ChatEvent::SessionStarted {
                    session_id: v.get("session_id").and_then(|s| s.as_str()).unwrap_or("").to_string(),
                    model: v.get("model").and_then(|s| s.as_str()).unwrap_or("").to_string(),
                    cwd: v.get("cwd").and_then(|s| s.as_str()).unwrap_or("").to_string(),
                    timestamp: ts,
                }]
            } else {
                vec![]
            }
        }
        "user" => {
            let Some(content_val) = v.get("message").and_then(|m| m.get("content")) else { return vec![]; };
            // `isMeta:true` marks a turn Claude Code itself injected (a fired
            // ScheduleWakeup, autopilot/resume) rather than something the human
            // typed. A daemon-injected wake (repo-channel/Jarvis/schedule) has
            // no such field on replay - see `strip_daemon_meta_sentinel` below.
            let mut content = extract_content_blocks(content_val);
            let sentinel_stripped = strip_daemon_meta_sentinel(&mut content);
            let is_meta = sentinel_stripped
                || v.get("isMeta").and_then(|b| b.as_bool()).unwrap_or(false);
            let mut evs = vec![ChatEvent::UserMessage {
                content,
                timestamp: ts,
                remote_echo: false,
                is_meta,
            }];
            // AUQ answers arrive as tool_result blocks inside a user message.
            // Emit a ToolResult event for each so the question card re-renders.
            if let Some(arr) = content_val.as_array() {
                for item in arr {
                    if item.get("type").and_then(|t| t.as_str()) != Some("tool_result") {
                        continue;
                    }
                    let tool_use_id = item.get("tool_use_id")
                        .and_then(|s| s.as_str())
                        .unwrap_or("")
                        .to_string();
                    let output = tool_result_output(item.get("content"));
                    let is_error = item.get("is_error")
                        .and_then(|b| b.as_bool())
                        .unwrap_or(false);
                    evs.push(ChatEvent::ToolResult {
                        tool_use_id,
                        output,
                        is_error,
                        timestamp: ts,
                    });
                }
            }
            evs
        }
        "assistant" => {
            // The transcript JSONL stores every claude reply as `assistant` lines
            // with a populated `stop_reason` (turn already finalized on disk).
            // The live `-p` stdout uses `stream_event` envelopes for partial
            // chunks plus a single trailing `assistant` line carrying the full
            // final message (also with `stop_reason` set). Either way, an
            // `assistant` line with a non-empty `stop_reason` is finalized -
            // mark streaming=false so the renderer doesn't keep its
            // streamingIndex pointing at the row across turn boundaries.
            let Some(message) = v.get("message") else { return vec![]; };
            let Some(content_val) = message.get("content") else { return vec![]; };
            let has_thinking = content_val
                .as_array()
                .map(|arr| arr.iter().any(|b| b.get("type").and_then(|t| t.as_str()) == Some("thinking")))
                .unwrap_or(false);
            let content = extract_content_blocks(content_val);
            let model = message.get("model").and_then(|s| s.as_str()).map(|s| s.to_string());
            let usage = message.get("usage");

            let mut evs = Vec::new();

            // Only emit AssistantMessage when there is visible text/image content.
            // Tool-use-only turns (all content blocks are type "tool_use") have no
            // renderable content, but we must NOT skip TurnUsage for them - those
            // turns still consume context window tokens that must reach the statusbar.
            if !content.is_empty() {
                let has_stop_reason = message
                    .get("stop_reason")
                    .and_then(|s| s.as_str())
                    .map(|s| !s.is_empty())
                    .unwrap_or(false);
                evs.push(ChatEvent::AssistantMessage {
                    content,
                    streaming: !has_stop_reason,
                    timestamp: ts,
                });
            }

            // Emit a ToolUse for each tool_use block so the chat shows tool rows
            // and the "changes" panel collects file edits. (History replay path;
            // the live path salvages these in feed() since the line is suppressed.)
            // Thread the envelope-level parent_tool_use_id so subagent calls can
            // later be nested under their parent Task in the UI.
            let parent_tool_use_id = v.get("parent_tool_use_id").and_then(|x| x.as_str()).map(String::from);
            evs.extend(tool_use_events(content_val, ts, parent_tool_use_id));

            // JSONL assistant lines carry model + usage on the message object.
            // Always emit TurnUsage when present so the statusbar ctx% reflects
            // every turn's input tokens (including tool-use-only turns).
            if model.is_some() || usage.is_some() {
                let input_tokens = usage.and_then(|u| u.get("input_tokens")).and_then(|v| v.as_u64()).unwrap_or(0);
                let output_tokens = usage.and_then(|u| u.get("output_tokens")).and_then(|v| v.as_u64()).unwrap_or(0);
                let cache_creation = usage.and_then(|u| u.get("cache_creation_input_tokens")).and_then(|v| v.as_u64()).unwrap_or(0);
                let cache_read = usage.and_then(|u| u.get("cache_read_input_tokens")).and_then(|v| v.as_u64()).unwrap_or(0);
                // Detect status marker from the text content of this assistant line.
                let awaiting_from_content = content_val
                    .as_array()
                    .and_then(|arr| {
                        arr.iter()
                            .filter_map(|b| if b.get("type")?.as_str()? == "text" { b.get("text")?.as_str() } else { None })
                            .last()
                    })
                    .and_then(|t| detect_awaiting(t));
                evs.push(ChatEvent::TurnUsage {
                    input_tokens,
                    output_tokens,
                    cache_creation_input_tokens: cache_creation,
                    cache_read_input_tokens: cache_read,
                    total_cost_usd: 0.0,
                    duration_ms: 0,
                    has_thinking,
                    model,
                    awaiting: awaiting_from_content,
                    autopilot_changed: None,
                });
            }

            // If both evs are empty (no renderable content, no model/usage) drop silently.
            evs
        }
        "tool_use" => {
            let Some(id) = v.get("id").and_then(|s| s.as_str()) else { return vec![]; };
            vec![ChatEvent::ToolUse {
                tool_name: v.get("name").and_then(|s| s.as_str()).unwrap_or("").to_string(),
                input: v.get("input").cloned().unwrap_or(Value::Null),
                id: id.to_string(),
                timestamp: ts,
                // Bare tool_use content blocks carry no envelope; parent is unknown.
                parent_tool_use_id: None,
            }]
        }
        "tool_result" => vec![ChatEvent::ToolResult {
            tool_use_id: v.get("tool_use_id").and_then(|s| s.as_str()).unwrap_or("").to_string(),
            output: tool_result_output(v.get("content")),
            is_error: v.get("is_error").and_then(|b| b.as_bool()).unwrap_or(false),
            timestamp: ts,
        }],
        // "result" is handled by ParserContext::parse_result_line (stateful:
        // needs has_thinking). If it reaches here somehow, drop it.
        "result" => vec![],
        "rate_limit_event" => {
            let info = v.get("rate_limit_info").cloned().unwrap_or(Value::Null);
            // claude -p emits these every turn: "allowed" is the steady-state
            // heartbeat and "allowed_warning" is an approaching-limit nudge the
            // user explicitly does NOT want surfaced. Only "rejected" (the turn
            // was actually blocked) drives the rate-limit banner.
            let status = info.get("status").and_then(|s| s.as_str()).unwrap_or("");
            if status != "rejected" {
                return vec![];
            }
            vec![ChatEvent::Notification {
                kind: "rate_limit".into(),
                body: info.to_string(),
            }]
        }
        _ => vec![],
    }
}

/// Emit a `ChatEvent::ToolUse` for each `tool_use` block in an assistant
/// message's `content` array. tool_use blocks are not renderable `ContentBlock`s
/// (so `extract_content_blocks` drops them), yet the frontend needs them to show
/// tool rows and populate the changes panel with file edits.
///
/// `parent_tool_use_id` is the envelope-level field from the enclosing `assistant`
/// line. It is `Some` for subagent (Task/Agent) tool calls and `None` for
/// main-agent calls.
fn tool_use_events(content_val: &Value, ts: i64, parent_tool_use_id: Option<String>) -> Vec<ChatEvent> {
    let Some(arr) = content_val.as_array() else { return vec![]; };
    arr.iter()
        .filter_map(|b| {
            if b.get("type")?.as_str()? != "tool_use" {
                return None;
            }
            let id = b.get("id")?.as_str()?.to_string();
            if let Some(ref parent) = parent_tool_use_id {
                log::debug!("chat: tool_use {} parent_tool_use_id={:?}", id, parent);
            }
            Some(ChatEvent::ToolUse {
                tool_name: b.get("name").and_then(|s| s.as_str()).unwrap_or("").to_string(),
                input: b.get("input").cloned().unwrap_or(Value::Null),
                id,
                timestamp: ts,
                parent_tool_use_id: parent_tool_use_id.clone(),
            })
        })
        .collect()
}

/// Parse a full `assistant` JSONL line and return only its `ToolUse` events.
/// Used by live-mode `feed()`, where the line is otherwise suppressed but is the
/// sole carrier of complete tool_use blocks. The envelope-level
/// `parent_tool_use_id` field (present on subagent lines) is threaded through so
/// the UI can later nest subagent calls under their parent Task.
fn tool_use_from_assistant_line(line: &str) -> Vec<ChatEvent> {
    let Ok(v) = serde_json::from_str::<Value>(line) else { return vec![]; };
    let ts = event_timestamp(&v);
    let parent_tool_use_id = v.get("parent_tool_use_id").and_then(|x| x.as_str()).map(String::from);
    let Some(content) = v.get("message").and_then(|m| m.get("content")) else { return vec![]; };
    tool_use_events(content, ts, parent_tool_use_id)
}

/// A tool_result's `content` field is a plain string for most tools, but MCP
/// tools (e.g. a Playwright screenshot) and Read on an image file emit the
/// array-of-blocks form instead. `ChatEvent::ToolResult.output` only carries
/// one `ContentBlock`, so when the array contains an image, that's what gets
/// surfaced (it's the reason this exists); otherwise any text blocks are
/// concatenated, matching the prior string-only behavior.
fn tool_result_output(content_val: Option<&Value>) -> ContentBlock {
    let Some(v) = content_val else { return ContentBlock::Text { text: String::new() }; };
    if let Some(s) = v.as_str() {
        return ContentBlock::Text { text: s.to_string() };
    }
    let blocks = extract_content_blocks(v);
    if let Some(image) = blocks.iter().find(|b| matches!(b, ContentBlock::Image { .. })) {
        return image.clone();
    }
    let text = blocks.iter()
        .filter_map(|b| match b { ContentBlock::Text { text } => Some(text.as_str()), _ => None })
        .collect::<Vec<_>>()
        .join("\n");
    ContentBlock::Text { text }
}

/// Strips a leading `DAEMON_META_SENTINEL` off the first text block, if
/// present, and reports whether it found one. Always written at the very
/// start of the wire text by `lifecycle::send_message`, so a plain
/// `starts_with` on the first block is the only check needed.
fn strip_daemon_meta_sentinel(content: &mut [ContentBlock]) -> bool {
    let Some(ContentBlock::Text { text }) = content.first_mut() else { return false };
    let Some(stripped) = text.strip_prefix(crate::types::chat::DAEMON_META_SENTINEL) else { return false };
    *text = stripped.to_string();
    true
}

fn extract_content_blocks(v: &Value) -> Vec<ContentBlock> {
    if let Some(s) = v.as_str() {
        return vec![ContentBlock::Text { text: s.to_string() }];
    }
    if let Some(arr) = v.as_array() {
        return arr.iter().filter_map(|item| {
            match item.get("type")?.as_str()? {
                "text" => Some(ContentBlock::Text {
                    text: item.get("text")?.as_str()?.to_string(),
                }),
                "image" => Some(ContentBlock::Image {
                    mime: item.get("source")?.get("media_type")?.as_str()?.to_string(),
                    data: item.get("source")?.get("data")?.as_str()?.to_string(),
                }),
                _ => None,
            }
        }).collect();
    }
    vec![]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_system_init_as_session_started() {
        let mut ctx = ParserContext::new();
        let line = r#"{"type":"system","subtype":"init","session_id":"abc","model":"claude-opus-4-7","cwd":"/tmp/x","timestamp":1700000000}"#;
        let events = ctx.feed(format!("{}\n", line).as_bytes());
        assert_eq!(events.len(), 1);
        match &events[0] {
            ChatEvent::SessionStarted { session_id, model, cwd, .. } => {
                assert_eq!(session_id, "abc");
                assert_eq!(model, "claude-opus-4-7");
                assert_eq!(cwd, "/tmp/x");
            }
            _ => panic!("expected SessionStarted"),
        }
    }

    #[test]
    fn rate_limit_allowed_and_warning_are_suppressed() {
        // Only an actually-blocked turn (status:"rejected") should surface; the
        // steady-state "allowed" heartbeat and the "allowed_warning" nudge are
        // both dropped (the user does not want approaching-limit notifications).
        let mut ctx = ParserContext::new();
        for status in ["allowed", "allowed_warning"] {
            let line = format!(
                r#"{{"type":"rate_limit_event","rate_limit_info":{{"status":"{}","rateLimitType":"five_hour","resetsAt":1781274600,"utilization":0.98}}}}"#,
                status
            );
            let events = ctx.feed(format!("{}\n", line).as_bytes());
            assert!(events.is_empty(), "status {} must be suppressed", status);
        }
    }

    #[test]
    fn rate_limit_rejected_surfaces_notification_with_reset_info() {
        let mut ctx = ParserContext::new();
        let line = r#"{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","rateLimitType":"five_hour","resetsAt":1781274600,"overageStatus":"rejected"}}"#;
        let events = ctx.feed(format!("{}\n", line).as_bytes());
        assert_eq!(events.len(), 1);
        match &events[0] {
            ChatEvent::Notification { kind, body } => {
                assert_eq!(kind, "rate_limit");
                assert!(body.contains("\"rejected\""), "body keeps status");
                assert!(body.contains("resetsAt"), "body keeps resetsAt");
                assert!(body.contains("five_hour"), "body keeps rateLimitType");
            }
            _ => panic!("expected Notification"),
        }
    }

    // Realistic single-turn live stream: a streamed text delta, then the full
    // `assistant` line (finalized text + model/usage), then the `result` line.
    fn live_turn_lines() -> String {
        [
            r#"{"type":"stream_event","timestamp":1,"event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"OK"}}}"#,
            r#"{"type":"assistant","timestamp":2,"message":{"role":"assistant","model":"claude-haiku-4-5","stop_reason":"end_turn","usage":{"input_tokens":10,"output_tokens":2},"content":[{"type":"text","text":"OK"}]}}"#,
            r#"{"type":"result","subtype":"success","timestamp":3,"result":"OK","total_cost_usd":0.01,"duration_ms":100,"usage":{"input_tokens":10,"output_tokens":2}}"#,
        ]
        .join("\n")
            + "\n"
    }

    #[test]
    fn live_mode_dedups_turn_to_single_usage_and_final_message() {
        // Regression for ai_todo 47: in a live stream the full `assistant` line
        // duplicated the streamed text + TurnUsage, tripling each turn.
        let mut ctx = ParserContext::new_live();
        let events = ctx.feed(live_turn_lines().as_bytes());

        let turn_usages = events
            .iter()
            .filter(|e| matches!(e, ChatEvent::TurnUsage { .. }))
            .count();
        assert_eq!(turn_usages, 1, "exactly one TurnUsage per live turn (from result)");

        let finalized = events
            .iter()
            .filter(|e| matches!(e, ChatEvent::AssistantMessage { streaming: false, .. }))
            .count();
        assert_eq!(finalized, 1, "exactly one finalized AssistantMessage (from result)");

        // The streaming delta still flows so the UI shows live typing.
        let streaming = events
            .iter()
            .filter(|e| matches!(e, ChatEvent::AssistantDelta { snapshot: false, .. }))
            .count();
        assert!(streaming >= 1, "streaming deltas still forwarded in live mode");
    }

    // Simulates `claude -p --include-partial-messages` output: multiple
    // intermediate `assistant` lines with stop_reason:null are emitted before
    // the final `assistant` line and `result`. In live mode all intermediate
    // `assistant` lines must be suppressed (they duplicate stream_event deltas)
    // so exactly one finalized AssistantMessage and one TurnUsage come out.
    #[test]
    fn live_mode_suppresses_multiple_partial_assistant_lines() {
        let lines = [
            r#"{"type":"stream_event","timestamp":1,"event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"I "}}}"#,
            r#"{"type":"assistant","timestamp":2,"message":{"role":"assistant","stop_reason":null,"usage":null,"content":[{"type":"text","text":"I "}]}}"#,
            r#"{"type":"stream_event","timestamp":3,"event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"am done"}}}"#,
            r#"{"type":"assistant","timestamp":4,"message":{"role":"assistant","stop_reason":null,"usage":null,"content":[{"type":"text","text":"I am done"}]}}"#,
            r#"{"type":"assistant","timestamp":5,"message":{"role":"assistant","model":"claude-haiku-4-5","stop_reason":"end_turn","usage":{"input_tokens":5,"output_tokens":3},"content":[{"type":"text","text":"I am done"}]}}"#,
            r#"{"type":"result","subtype":"success","timestamp":6,"result":"I am done","total_cost_usd":0.001,"duration_ms":50,"usage":{"input_tokens":5,"output_tokens":3}}"#,
        ]
        .join("\n")
            + "\n";

        let mut ctx = ParserContext::new_live();
        let events = ctx.feed(lines.as_bytes());

        let finalized = events
            .iter()
            .filter(|e| matches!(e, ChatEvent::AssistantMessage { streaming: false, .. }))
            .count();
        assert_eq!(
            finalized, 1,
            "--include-partial-messages: exactly one finalized AssistantMessage from result"
        );

        let turn_usages = events
            .iter()
            .filter(|e| matches!(e, ChatEvent::TurnUsage { .. }))
            .count();
        assert_eq!(
            turn_usages, 1,
            "--include-partial-messages: exactly one TurnUsage from result"
        );

        let streaming = events
            .iter()
            .filter(|e| matches!(e, ChatEvent::AssistantDelta { snapshot: false, .. }))
            .count();
        assert!(streaming >= 1, "streaming deltas still flow through live mode");
    }

    #[test]
    fn history_mode_keeps_per_assistant_line_usage() {
        // History replay (non-live feed + bare parse_line) must still emit a
        // TurnUsage per assistant line - JSONL files have no `result` line, so
        // that is the only source of per-message model/cost.
        let mut ctx = ParserContext::new();
        let events = ctx.feed(live_turn_lines().as_bytes());
        let turn_usages = events
            .iter()
            .filter(|e| matches!(e, ChatEvent::TurnUsage { .. }))
            .count();
        assert_eq!(turn_usages, 2, "non-live: assistant line + result line both emit usage");

        // Bare parse_line on an assistant line is unchanged.
        let line = r#"{"type":"assistant","timestamp":2,"message":{"role":"assistant","model":"m","stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1},"content":[{"type":"text","text":"hi"}]}}"#;
        let evs = parse_line(line);
        assert!(evs.iter().any(|e| matches!(e, ChatEvent::TurnUsage { .. })));
    }

    #[test]
    fn live_mode_emits_tool_use_from_suppressed_assistant_line() {
        // The full assistant line is suppressed in live mode, but its tool_use
        // blocks must still surface so the changes panel / tool rows populate.
        let lines = [
            r#"{"type":"assistant","timestamp":0,"message":{"role":"assistant","stop_reason":"tool_use","usage":null,"content":[{"type":"text","text":"editing"},{"type":"tool_use","id":"toolu_1","name":"Edit","input":{"file_path":"/a.rs","old_string":"x","new_string":"y"}}]}}"#,
            r#"{"type":"result","subtype":"success","timestamp":1,"result":"done","total_cost_usd":0.0,"duration_ms":1,"usage":{"input_tokens":1,"output_tokens":1}}"#,
        ]
        .join("\n")
            + "\n";
        let mut ctx = ParserContext::new_live();
        let events = ctx.feed(lines.as_bytes());
        let tool_uses: Vec<_> = events
            .iter()
            .filter_map(|e| match e {
                ChatEvent::ToolUse { tool_name, id, .. } => Some((tool_name.as_str(), id.as_str())),
                _ => None,
            })
            .collect();
        assert_eq!(tool_uses, vec![("Edit", "toolu_1")], "one ToolUse salvaged from the suppressed assistant line");
    }

    /// A tool-only live turn never emits `AssistantDelta`, but it does stream
    /// `stream_event` lines before its tool_use content_block.
    #[test]
    fn stream_event_seen_fires_before_tool_use_content_on_a_tool_only_turn() {
        let mut ctx = ParserContext::new_live();
        let stream_lines = [
            r#"{"type":"stream_event","event":{"type":"message_start","message":{}}}"#,
            r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_9","name":"Bash","input":{}}}}"#,
            r#"{"type":"stream_event","event":{"type":"content_block_stop","index":0}}"#,
            r#"{"type":"stream_event","event":{"type":"message_stop"}}"#,
        ];
        for l in stream_lines {
            ctx.feed(format!("{l}\n").as_bytes());
            assert!(ctx.take_stream_event_seen(), "every stream_event line must set the flag: {l}");
        }
    }

    /// `--resume` history replay never wraps lines in a `stream_event` envelope,
    /// so a replayed tool-use-only turn must NOT trip the liveness signal.
    #[test]
    fn stream_event_seen_stays_false_for_a_replayed_tool_use_turn() {
        let mut ctx = ParserContext::new_live();
        let lines = [
            r#"{"type":"assistant","timestamp":0,"message":{"role":"assistant","stop_reason":"tool_use","usage":null,"content":[{"type":"tool_use","id":"toolu_old","name":"Bash","input":{}}]}}"#,
            r#"{"type":"result","subtype":"success","timestamp":1,"result":"","total_cost_usd":0.0,"duration_ms":1,"usage":{"input_tokens":1,"output_tokens":1}}"#,
        ];
        for l in lines {
            ctx.feed(format!("{l}\n").as_bytes());
        }
        assert!(!ctx.take_stream_event_seen(), "replayed lines carry no stream_event envelope");
    }

    #[test]
    fn history_mode_emits_tool_use_from_assistant_line() {
        let line = r#"{"type":"assistant","timestamp":2,"message":{"role":"assistant","model":"m","stop_reason":"tool_use","usage":{"input_tokens":1,"output_tokens":1},"content":[{"type":"tool_use","id":"toolu_2","name":"Write","input":{"file_path":"/b.rs","content":"hi"}}]}}"#;
        let evs = parse_line(line);
        assert!(
            evs.iter().any(|e| matches!(e, ChatEvent::ToolUse { id, .. } if id == "toolu_2")),
            "history replay emits ToolUse for tool_use-only assistant lines"
        );
        // tool_use-only turn still reports usage (context window must update).
        assert!(evs.iter().any(|e| matches!(e, ChatEvent::TurnUsage { .. })));
    }

    #[test]
    fn user_message_with_tool_result_block_emits_tool_result_event() {
        // AUQ answers arrive as tool_result blocks inside a user message.
        let line = r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_auq","content":"The user answered the question(s):\nQ: Tabs or spaces?\nA: Spaces","is_error":true}]},"timestamp":5}"#;
        let evs = parse_line(line);
        let tool_result = evs.iter().find_map(|e| match e {
            ChatEvent::ToolResult { tool_use_id, output, .. } => Some((tool_use_id.as_str(), output)),
            _ => None,
        });
        assert!(tool_result.is_some(), "must emit a ToolResult event");
        let (id, output) = tool_result.unwrap();
        assert_eq!(id, "toolu_auq");
        match output {
            ContentBlock::Text { text } => assert!(text.contains("Spaces"), "answer text preserved"),
            _ => panic!("expected text output"),
        }
    }

    #[test]
    fn tool_result_image_block_surfaces_as_image_output() {
        // A Read on a .png / an MCP screenshot returns the array-of-blocks form
        // with an image (real transcript shape: source.type=base64, media_type, data).
        // Regression for todo 261: the parser used to read content as a string only
        // and silently drop the image, so screenshots never rendered in chat.
        let line = r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_img","content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"iVBORw0KGgo="}}]}]},"timestamp":9}"#;
        let evs = parse_line(line);
        let output = evs.iter().find_map(|e| match e {
            ChatEvent::ToolResult { tool_use_id, output, .. } if tool_use_id == "toolu_img" => Some(output),
            _ => None,
        });
        match output {
            Some(ContentBlock::Image { mime, data }) => {
                assert_eq!(mime, "image/png");
                assert_eq!(data, "iVBORw0KGgo=");
            }
            other => panic!("expected image output, got {other:?}"),
        }
    }

    #[test]
    fn parses_user_message() {
        let mut ctx = ParserContext::new();
        let line = r#"{"type":"user","message":{"role":"user","content":"hello"},"timestamp":1700000000}"#;
        let events = ctx.feed(format!("{}\n", line).as_bytes());
        assert_eq!(events.len(), 1);
        match &events[0] {
            ChatEvent::UserMessage { content, is_meta, .. } => {
                match &content[0] {
                    ContentBlock::Text { text } => assert_eq!(text, "hello"),
                    _ => panic!("expected text block"),
                }
                assert!(!is_meta, "a plain typed message must not be flagged is_meta");
            }
            _ => panic!("expected UserMessage"),
        }
    }

    #[test]
    fn parses_rfc3339_string_timestamp() {
        // The persisted transcript JSONL writes `timestamp` as an RFC3339 string
        // (not the numeric epoch the live stream uses). It must parse to epoch
        // millis, else hover timestamps on history messages silently vanish.
        let mut ctx = ParserContext::new();
        let line = r#"{"type":"user","message":{"role":"user","content":"hi"},"timestamp":"2021-01-01T00:00:00.000Z"}"#;
        let events = ctx.feed(format!("{}\n", line).as_bytes());
        assert_eq!(events.len(), 1);
        match &events[0] {
            ChatEvent::UserMessage { timestamp, .. } => {
                assert_eq!(*timestamp, 1_609_459_200_000, "RFC3339 string -> epoch millis");
            }
            _ => panic!("expected UserMessage"),
        }
    }

    #[test]
    fn flags_is_meta_user_message() {
        // Claude Code marks a self-injected turn (a fired ScheduleWakeup prompt,
        // an autopilot/resume continuation, etc.) with "isMeta":true instead of
        // wrapping it in a distinguishable sentinel like <task-notification>.
        let mut ctx = ParserContext::new();
        let line = r#"{"type":"user","isMeta":true,"message":{"role":"user","content":"Check on the research agent and continue once it reports back."},"timestamp":1700000000}"#;
        let events = ctx.feed(format!("{}\n", line).as_bytes());
        assert_eq!(events.len(), 1);
        match &events[0] {
            ChatEvent::UserMessage { is_meta, .. } => assert!(*is_meta),
            _ => panic!("expected UserMessage"),
        }
    }

    #[test]
    fn strips_daemon_meta_sentinel_and_flags_is_meta_even_without_ismeta_field() {
        // A daemon-injected wake never gets the CLI's own "isMeta":true field -
        // only the CLI sets that on its OWN self-injected turns. This is what
        // the persisted transcript line looks like on replay instead: no
        // "isMeta" key, just the sentinel embedded in the content string.
        let mut ctx = ParserContext::new();
        let text = format!(
            "{}[repo-channel] other-session: touching pending-pane.ts, anyone on this?",
            crate::types::chat::DAEMON_META_SENTINEL
        );
        let line = serde_json::json!({
            "type": "user",
            "message": {"role": "user", "content": text},
            "timestamp": 1700000000
        })
        .to_string();
        let events = ctx.feed(format!("{}\n", line).as_bytes());
        assert_eq!(events.len(), 1);
        match &events[0] {
            ChatEvent::UserMessage { content, is_meta, .. } => {
                assert!(*is_meta, "sentinel-prefixed content must be treated as meta on replay");
                match &content[0] {
                    ContentBlock::Text { text } => assert_eq!(
                        text, "[repo-channel] other-session: touching pending-pane.ts, anyone on this?",
                        "the sentinel itself must not leak into displayed text"
                    ),
                    other => panic!("expected text block, got {other:?}"),
                }
            }
            _ => panic!("expected UserMessage"),
        }
    }

    #[test]
    fn buffers_across_boundaries() {
        let mut ctx = ParserContext::new();
        let line = r#"{"type":"user","message":{"role":"user","content":"hi"},"timestamp":1}"#;
        let bytes = format!("{}\n", line);
        let mid = bytes.len() / 2;
        let first = ctx.feed(&bytes.as_bytes()[..mid]);
        let second = ctx.feed(&bytes.as_bytes()[mid..]);
        assert!(first.is_empty());
        assert_eq!(second.len(), 1);
    }

    #[test]
    fn ignores_empty_lines_and_blank_whitespace() {
        let mut ctx = ParserContext::new();
        let events = ctx.feed(b"\n\n   \n");
        assert!(events.is_empty());
    }

    #[test]
    fn handles_crlf_line_endings() {
        let mut ctx = ParserContext::new();
        let line = r#"{"type":"system","subtype":"init","session_id":"x","timestamp":1}"#;
        let events = ctx.feed(format!("{}\r\n", line).as_bytes());
        assert_eq!(events.len(), 1);
        assert!(matches!(events[0], ChatEvent::SessionStarted { .. }));
    }

    #[test]
    fn result_line_finalizes_assistant_message() {
        let mut ctx = ParserContext::new();
        let line = r#"{"type":"result","subtype":"success","is_error":false,"result":"final answer","total_cost_usd":0.001,"duration_ms":1200,"usage":{"input_tokens":100,"output_tokens":10},"timestamp":1}"#;
        let events = ctx.feed(format!("{}\n", line).as_bytes());
        // result emits AssistantMessage + TurnUsage
        assert_eq!(events.len(), 2);
        match &events[0] {
            ChatEvent::AssistantMessage { streaming, content, .. } => {
                assert_eq!(*streaming, false);
                match &content[0] {
                    ContentBlock::Text { text } => assert_eq!(text, "final answer"),
                    _ => panic!("expected text block"),
                }
            }
            _ => panic!("expected finalized AssistantMessage at index 0"),
        }
        match &events[1] {
            ChatEvent::TurnUsage { input_tokens, total_cost_usd, duration_ms, has_thinking, .. } => {
                assert_eq!(*input_tokens, 100);
                assert_eq!(*total_cost_usd, 0.001);
                assert_eq!(*duration_ms, 1200);
                assert!(!has_thinking);
            }
            _ => panic!("expected TurnUsage at index 1"),
        }
    }

    #[test]
    fn assistant_chunk_without_stop_reason_marked_streaming() {
        let mut ctx = ParserContext::new();
        let line = r#"{"type":"assistant","message":{"role":"assistant","content":"partial"},"timestamp":1}"#;
        let events = ctx.feed(format!("{}\n", line).as_bytes());
        match &events[0] {
            ChatEvent::AssistantMessage { streaming, .. } => assert!(*streaming),
            _ => panic!("expected streaming AssistantMessage"),
        }
    }

    #[test]
    fn assistant_with_stop_reason_marked_finalized() {
        let mut ctx = ParserContext::new();
        let line = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"stop_reason":"end_turn"},"timestamp":1}"#;
        let events = ctx.feed(format!("{}\n", line).as_bytes());
        match &events[0] {
            ChatEvent::AssistantMessage { streaming, content, .. } => {
                assert_eq!(*streaming, false);
                match &content[0] {
                    ContentBlock::Text { text } => assert_eq!(text, "done"),
                    _ => panic!("expected text"),
                }
            }
            _ => panic!("expected finalized AssistantMessage"),
        }
    }

    #[test]
    fn assistant_with_only_thinking_block_is_skipped() {
        let mut ctx = ParserContext::new();
        let line = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"thinking","thinking":"...","signature":"sig"}],"stop_reason":"end_turn"},"timestamp":1}"#;
        let events = ctx.feed(format!("{}\n", line).as_bytes());
        assert!(events.is_empty(), "thinking-only assistant lines must not surface");
    }

    #[test]
    fn thinking_block_sets_has_thinking_in_turn_usage() {
        let mut ctx = ParserContext::new();
        let lines = [
            r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}}"#,
            r#"{"type":"result","subtype":"success","is_error":false,"result":"done","timestamp":1}"#,
        ];
        let mut all = Vec::new();
        for l in lines {
            all.extend(ctx.feed(format!("{}\n", l).as_bytes()));
        }
        let usage = all.iter().find(|e| matches!(e, ChatEvent::TurnUsage { .. }));
        match usage {
            Some(ChatEvent::TurnUsage { has_thinking, .. }) => assert!(has_thinking),
            _ => panic!("expected TurnUsage with has_thinking=true"),
        }
    }

    #[test]
    fn jsonl_assistant_with_thinking_block_sets_has_thinking() {
        let mut ctx = ParserContext::new();
        let line = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"thinking","thinking":"...","signature":"sig"},{"type":"text","text":"answer"}],"stop_reason":"end_turn","model":"claude-opus-4-7","usage":{"input_tokens":100,"output_tokens":20}},"timestamp":1}"#;
        let events = ctx.feed(format!("{}\n", line).as_bytes());
        let usage = events.iter().find(|e| matches!(e, ChatEvent::TurnUsage { .. }));
        match usage {
            Some(ChatEvent::TurnUsage { has_thinking, .. }) => assert!(*has_thinking, "JSONL thinking block must set has_thinking"),
            _ => panic!("expected TurnUsage"),
        }
    }

    #[test]
    fn system_hook_subtypes_dropped() {
        let mut ctx = ParserContext::new();
        let line = r#"{"type":"system","subtype":"hook_started","hook_name":"SessionStart:resume","timestamp":1}"#;
        let events = ctx.feed(format!("{}\n", line).as_bytes());
        assert!(events.is_empty(), "hook chatter must not appear in chat");
    }

    #[test]
    fn replay_two_turn_jsonl_preserves_message_order() {
        // Reproduces Joe's bug: previously, every transcript assistant line was
        // marked streaming=true, so streamingIndex stayed pointing at turn 1's
        // reply slot and turn 2's reply overwrote it instead of appending.
        let lines = [
            r#"{"type":"user","message":{"role":"user","content":"first"},"timestamp":1}"#,
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"reply 1"}],"stop_reason":"end_turn"},"timestamp":2}"#,
            r#"{"type":"user","message":{"role":"user","content":"second"},"timestamp":3}"#,
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"reply 2"}],"stop_reason":"end_turn"},"timestamp":4}"#,
        ];
        let mut ctx = ParserContext::new();
        let mut all = Vec::new();
        for l in lines {
            all.extend(ctx.feed(format!("{}\n", l).as_bytes()));
        }
        // Expect 4 events in order, and every assistant marked finalized.
        assert_eq!(all.len(), 4);
        match &all[0] { ChatEvent::UserMessage { .. } => {}, _ => panic!("0: user") }
        match &all[1] {
            ChatEvent::AssistantMessage { streaming, content, .. } => {
                assert_eq!(*streaming, false);
                match &content[0] {
                    ContentBlock::Text { text } => assert_eq!(text, "reply 1"),
                    _ => panic!("text"),
                }
            }
            _ => panic!("1: assistant"),
        }
        match &all[2] { ChatEvent::UserMessage { .. } => {}, _ => panic!("2: user") }
        match &all[3] {
            ChatEvent::AssistantMessage { streaming, content, .. } => {
                assert_eq!(*streaming, false);
                match &content[0] {
                    ContentBlock::Text { text } => assert_eq!(text, "reply 2"),
                    _ => panic!("text"),
                }
            }
            _ => panic!("3: assistant"),
        }
    }

    #[test]
    fn stream_event_text_delta_emits_chunk_deltas() {
        let mut ctx = ParserContext::new();
        let lines = [
            r#"{"type":"stream_event","event":{"type":"message_start","message":{}}}"#,
            r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}}"#,
            r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi. "}}}"#,
            r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Ready."}}}"#,
            r#"{"type":"stream_event","event":{"type":"content_block_stop","index":0}}"#,
            r#"{"type":"stream_event","event":{"type":"message_stop"}}"#,
        ];
        let mut all = Vec::new();
        for l in lines {
            all.extend(ctx.feed(format!("{}\n", l).as_bytes()));
        }
        // O(delta) protocol: each chunk surfaces as its own AssistantDelta
        // carrying ONLY the new text, all within the same block ordinal.
        let deltas: Vec<_> = all
            .iter()
            .filter_map(|e| match e {
                ChatEvent::AssistantDelta { text, block, snapshot: false, .. } => {
                    Some((text.clone(), *block))
                }
                _ => None,
            })
            .collect();
        assert_eq!(deltas, vec![("Hi. ".to_string(), 1), ("Ready.".to_string(), 1)]);
    }

    #[test]
    fn stream_event_thinking_delta_does_not_emit() {
        let mut ctx = ParserContext::new();
        let line = r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"abc"}}}"#;
        let events = ctx.feed(format!("{}\n", line).as_bytes());
        assert!(events.is_empty(), "signature_delta must not surface to UI");
    }

    #[test]
    fn stream_event_then_result_finalizes_correctly() {
        let mut ctx = ParserContext::new();
        let stream_lines = [
            r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}}"#,
            r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Final answer."}}}"#,
            r#"{"type":"stream_event","event":{"type":"message_stop"}}"#,
        ];
        for l in stream_lines {
            ctx.feed(format!("{}\n", l).as_bytes());
        }
        let result_line = r#"{"type":"result","subtype":"success","is_error":false,"result":"Final answer.","timestamp":1}"#;
        let events = ctx.feed(format!("{}\n", result_line).as_bytes());
        // result emits AssistantMessage + TurnUsage.
        assert!(events.len() >= 1);
        match &events[0] {
            ChatEvent::AssistantMessage { streaming, content, .. } => {
                assert_eq!(*streaming, false);
                match &content[0] {
                    ContentBlock::Text { text } => assert_eq!(text, "Final answer."),
                    _ => panic!("expected text"),
                }
            }
            _ => panic!("expected finalized AssistantMessage from result line"),
        }
    }

    #[test]
    fn assistant_line_with_parent_tool_use_id_propagates_to_tool_use() {
        // Live path: envelope carries parent_tool_use_id for a subagent line.
        let line = r#"{"type":"assistant","parent_tool_use_id":"toolu_PARENT","timestamp":5,"message":{"role":"assistant","stop_reason":"tool_use","usage":null,"content":[{"type":"tool_use","id":"toolu_CHILD","name":"Read","input":{"file_path":"/x.rs"}}]}}"#;
        let mut ctx = ParserContext::new_live();
        let events = ctx.feed(format!("{}\n", line).as_bytes());
        let tool_use = events.iter().find_map(|e| match e {
            ChatEvent::ToolUse { id, parent_tool_use_id, .. } if id == "toolu_CHILD" => Some(parent_tool_use_id.clone()),
            _ => None,
        });
        assert_eq!(tool_use, Some(Some("toolu_PARENT".to_string())), "parent_tool_use_id must propagate from envelope to ToolUse");
    }

    #[test]
    fn assistant_line_without_parent_tool_use_id_yields_none() {
        // Main-agent line: no parent_tool_use_id on envelope.
        let line = r#"{"type":"assistant","timestamp":5,"message":{"role":"assistant","stop_reason":"tool_use","usage":null,"content":[{"type":"tool_use","id":"toolu_MAIN","name":"Read","input":{"file_path":"/y.rs"}}]}}"#;
        let mut ctx = ParserContext::new_live();
        let events = ctx.feed(format!("{}\n", line).as_bytes());
        let tool_use = events.iter().find_map(|e| match e {
            ChatEvent::ToolUse { id, parent_tool_use_id, .. } if id == "toolu_MAIN" => Some(parent_tool_use_id.clone()),
            _ => None,
        });
        assert_eq!(tool_use, Some(None), "absent parent_tool_use_id must yield None");
    }

    #[test]
    fn history_mode_assistant_line_with_parent_tool_use_id_propagates() {
        // History replay path (parse_line): same envelope field must propagate.
        let line = r#"{"type":"assistant","parent_tool_use_id":"toolu_P2","timestamp":3,"message":{"role":"assistant","model":"m","stop_reason":"tool_use","usage":{"input_tokens":1,"output_tokens":1},"content":[{"type":"tool_use","id":"toolu_C2","name":"Write","input":{"file_path":"/z.rs","content":""}}]}}"#;
        let evs = parse_line(line);
        let parent = evs.iter().find_map(|e| match e {
            ChatEvent::ToolUse { id, parent_tool_use_id, .. } if id == "toolu_C2" => Some(parent_tool_use_id.clone()),
            _ => None,
        });
        assert_eq!(parent, Some(Some("toolu_P2".to_string())), "history-path parent_tool_use_id must propagate");
    }

    #[test]
    fn new_text_block_bumps_block_ordinal() {
        let mut ctx = ParserContext::new();
        let lines = [
            r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}}"#,
            r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"First"}}}"#,
            r#"{"type":"stream_event","event":{"type":"content_block_stop","index":0}}"#,
            r#"{"type":"stream_event","event":{"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}}"#,
            r#"{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Second"}}}"#,
        ];
        let mut deltas = Vec::new();
        for l in lines {
            for ev in ctx.feed(format!("{}\n", l).as_bytes()) {
                if let ChatEvent::AssistantDelta { text, block, .. } = ev {
                    deltas.push((text, block));
                }
            }
        }
        // The second block's chunk carries a new ordinal so downstream
        // accumulators know to reset instead of appending across blocks.
        assert_eq!(deltas, vec![("First".to_string(), 1), ("Second".to_string(), 2)]);
    }
}
