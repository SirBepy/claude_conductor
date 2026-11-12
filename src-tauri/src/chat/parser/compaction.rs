//! The lines a compaction (`/compact` or the CLI's own auto-compact) adds, measured in
//! `docs/research/compact-spike.md` sections 2 and 3. The `compact_boundary` system line
//! becomes the one `ChatEvent::Compacted`; the continuation summary is model input, not
//! something anyone said, so it raises no event. The `/compact` command, its
//! `<local-command-caveat>` and `<local-command-stdout>` lines stay ordinary user lines
//! here and are hidden by the frontend classifier (`chat-classifiers.ts`), which has to
//! recognise the same shapes on the live echo anyway.

use crate::types::chat::ChatEvent;
use serde_json::Value;

/// The `compact_boundary` system line as a `Compacted` event. The transcript writes the
/// metadata camelCase (`compactMetadata.preTokens`), the live stream-json snake_case
/// (`compact_metadata.pre_tokens`); both are read so the live window and a history load
/// draw the same row. A missing figure reads as 0, which the row shows as a bare
/// "Context compacted".
pub(super) fn boundary_event(v: &Value, timestamp: i64) -> ChatEvent {
    let meta = v.get("compactMetadata").or_else(|| v.get("compact_metadata"));
    let num = |camel: &str, snake: &str| {
        meta.and_then(|m| m.get(camel).or_else(|| m.get(snake)))
            .and_then(Value::as_u64)
            .unwrap_or(0)
    };
    ChatEvent::Compacted {
        pre_tokens: num("preTokens", "pre_tokens"),
        post_tokens: num("postTokens", "post_tokens"),
        duration_ms: num("durationMs", "duration_ms"),
        trigger: meta
            .and_then(|m| m.get("trigger"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        timestamp,
    }
}

/// The continuation summary the CLI writes right after the boundary (thousands of chars,
/// `isCompactSummary:true`). Drawn as a user line it became a giant message from Joe.
pub(super) fn is_compact_summary(v: &Value) -> bool {
    v.get("isCompactSummary").and_then(Value::as_bool).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::super::{parse_line, ParserContext};
    use crate::types::chat::ChatEvent;

    // Rebuilt from the spike's measured lines (tests/fixtures/compact-spike/README.md).
    // CRLF-normalised: a CRLF checkout must parse the same as the LF one.
    fn fixture(text: &str) -> String {
        text.replace("\r\n", "\n")
    }
    const TRANSCRIPT: &str = include_str!("../../../../tests/fixtures/compact-spike/transcript.jsonl");
    const STDOUT: &str = include_str!("../../../../tests/fixtures/compact-spike/stdout.jsonl");
    const HISTORY_EVENTS: &str = include_str!("../../../../tests/fixtures/compact-spike/history-events.json");
    const LIVE_EVENTS: &str = include_str!("../../../../tests/fixtures/compact-spike/live-events.json");

    fn history_events() -> Vec<ChatEvent> {
        fixture(TRANSCRIPT).lines().filter(|l| !l.trim().is_empty()).flat_map(parse_line).collect()
    }

    /// What the daemon pump publishes for the compaction's stdout (it drops every
    /// `SessionStarted`, `daemon/pump.rs`).
    fn live_events() -> Vec<ChatEvent> {
        let mut ctx = ParserContext::new_live();
        ctx.feed(fixture(STDOUT).as_bytes())
            .into_iter()
            .filter(|e| !matches!(e, ChatEvent::SessionStarted { .. }))
            .collect()
    }

    fn user_texts(evs: &[ChatEvent]) -> Vec<String> {
        evs.iter()
            .filter_map(|e| match e {
                ChatEvent::UserMessage { content, .. } => Some(
                    content.iter().map(|b| match b {
                        crate::types::chat::ContentBlock::Text { text } => text.clone(),
                        _ => String::new(),
                    }).collect::<String>(),
                ),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn history_boundary_raises_one_compacted_event_with_the_measured_figures() {
        let evs = history_events();
        let compacted: Vec<&ChatEvent> = evs.iter().filter(|e| matches!(e, ChatEvent::Compacted { .. })).collect();
        assert_eq!(compacted.len(), 1, "one boundary, one event: {evs:?}");
        assert_eq!(
            compacted[0],
            &ChatEvent::Compacted {
                pre_tokens: 85837,
                post_tokens: 9860,
                duration_ms: 21335,
                trigger: "manual".into(),
                timestamp: 1794487235600,
            }
        );
    }

    #[test]
    fn history_summary_raises_no_user_message() {
        let texts = user_texts(&history_events());
        assert!(
            texts.iter().all(|t| !t.contains("This session is being continued")),
            "the continuation summary must not become a user message: {texts:?}"
        );
    }

    #[test]
    fn live_boundary_raises_the_same_compacted_event_from_snake_case_metadata() {
        let evs = live_events();
        let compacted: Vec<&ChatEvent> = evs.iter().filter(|e| matches!(e, ChatEvent::Compacted { .. })).collect();
        assert_eq!(compacted.len(), 1, "{evs:?}");
        assert_eq!(
            compacted[0],
            &ChatEvent::Compacted {
                pre_tokens: 85837,
                post_tokens: 9860,
                duration_ms: 21335,
                trigger: "manual".into(),
                timestamp: 0,
            }
        );
    }

    #[test]
    fn boundary_without_metadata_still_raises_the_row() {
        let evs = parse_line(r#"{"type":"system","subtype":"compact_boundary","content":"Conversation compacted"}"#);
        assert_eq!(
            evs,
            vec![ChatEvent::Compacted { pre_tokens: 0, post_tokens: 0, duration_ms: 0, trigger: String::new(), timestamp: 0 }]
        );
    }

    // The vitest suites (tests/chat-compaction-row.test.mjs) feed these JSON files to the
    // renderer; pinning them to the parser's real output keeps the two halves honest.
    #[test]
    fn history_events_fixture_is_the_parser_output() {
        let expected: Vec<ChatEvent> = serde_json::from_str(&fixture(HISTORY_EVENTS)).unwrap();
        assert_eq!(history_events(), expected);
    }

    #[test]
    fn live_events_fixture_is_the_pump_output() {
        let expected: Vec<ChatEvent> = serde_json::from_str(&fixture(LIVE_EVENTS)).unwrap();
        assert_eq!(live_events(), expected);
    }
}
