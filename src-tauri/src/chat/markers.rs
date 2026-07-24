//! Chat-protocol marker detection: the `<cc-status:...>` and `<cc-autopilot:...>`
//! tags Claude embeds in its reply text so the daemon can drive turn status
//! (awaiting/in-progress) and the autopilot toggle. This is protocol parsing,
//! not stream-json line parsing (see `parser.rs` for that); the logic mirrors
//! `chat-classifiers.ts` on the frontend and `extract_cc_title` in `tokens/title.rs`.

/// Returns the last `<cc-status:done|question|waiting|working>` marker found in
/// `text`, or `None` if no marker is present. "waiting" = Claude finished its
/// part but is parked on an external process (CI / a long command) it will
/// resume on. "working" = Claude dispatched its own background subagents/tasks
/// that will re-invoke it - still in progress from the user's perspective.
///
/// Tolerant of the malformed variants some model invocations emit (mirrors
/// `chat-classifiers.ts` on the frontend and `extract_cc_title` in
/// `tokens/title.rs`): the XML form `<cc-status>done</cc-status>`, the hybrid
/// colon-open/XML-close form `<cc-status:done</cc-status>`, mixed case, and
/// stray whitespace around the label. A quoted instruction like
/// `<cc-status:done|question|waiting|working>` never matches: the label must
/// be followed directly by `>` or `<`.
pub(crate) fn detect_awaiting(text: &str) -> Option<String> {
    const OPEN: &str = "<cc-status";
    const LABELS: [&str; 4] = ["question", "done", "waiting", "working"];
    let lower = text.to_lowercase();
    let mut result = None;
    let mut search = lower.as_str();
    while let Some(i) = search.find(OPEN) {
        let after = &search[i + OPEN.len()..];
        // ':' opens the colon/hybrid forms, '>' the XML form.
        if let Some(body) = after.strip_prefix(':').or_else(|| after.strip_prefix('>')) {
            let body = body.trim_start();
            for label in LABELS {
                if let Some(rest) = body.strip_prefix(label) {
                    if matches!(rest.trim_start().chars().next(), Some('>') | Some('<')) {
                        result = Some(label.to_string());
                    }
                    break;
                }
            }
        }
        search = after;
    }
    result
}

/// Returns `Some(true)` if the last autopilot marker in `text` is `<cc-autopilot:on>`,
/// `Some(false)` if it is `<cc-autopilot:off>`, or `None` if no marker is present.
pub(crate) fn detect_autopilot(text: &str) -> Option<bool> {
    let lower = text.to_lowercase();
    let on_pos = lower.rfind("<cc-autopilot:on>");
    let off_pos = lower.rfind("<cc-autopilot:off>");
    match (on_pos, off_pos) {
        (None, None) => None,
        (Some(_), None) => Some(true),
        (None, Some(_)) => Some(false),
        (Some(on), Some(off)) => Some(on > off),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat::parser::ParserContext;
    use crate::types::chat::ChatEvent;

    #[test]
    fn detect_awaiting_tolerates_xml_form() {
        // Some model invocations emit the XML variant; the daemon parser must
        // accept the same forms the frontend's chat-classifiers already strip.
        assert_eq!(detect_awaiting("done\n<cc-status>done</cc-status>").as_deref(), Some("done"));
        assert_eq!(detect_awaiting("<cc-status>question</cc-status>").as_deref(), Some("question"));
    }

    #[test]
    fn detect_awaiting_tolerates_hybrid_form() {
        // Colon open with an XML close: <cc-status:working</cc-status>.
        assert_eq!(detect_awaiting("<cc-status:working</cc-status>").as_deref(), Some("working"));
    }

    #[test]
    fn detect_awaiting_tolerates_case_and_whitespace() {
        assert_eq!(detect_awaiting("<CC-Status: Done >").as_deref(), Some("done"));
        assert_eq!(detect_awaiting("<cc-status:waiting >").as_deref(), Some("waiting"));
    }

    #[test]
    fn detect_awaiting_ignores_quoted_instruction() {
        // A response quoting the system-prompt syntax list must not register
        // as a status: the label is followed by '|', not '>' or '<'.
        assert!(detect_awaiting("end with <cc-status:done|question|waiting|working>").is_none());
    }

    #[test]
    fn detect_awaiting_last_marker_wins_across_forms() {
        let text = "<cc-status:done>\nlater...\n<cc-status>question</cc-status>";
        assert_eq!(detect_awaiting(text).as_deref(), Some("question"));
    }

    #[test]
    fn result_line_detects_question_awaiting() {
        let mut ctx = ParserContext::new_live();
        let line = r#"{"type":"result","subtype":"success","result":"What should I do? <cc-status:question>","total_cost_usd":0.0,"duration_ms":100,"usage":{"input_tokens":10,"output_tokens":5},"timestamp":1}"#;
        let events = ctx.feed(format!("{}\n", line).as_bytes());
        let usage = events.iter().find(|e| matches!(e, ChatEvent::TurnUsage { .. }));
        match usage {
            Some(ChatEvent::TurnUsage { awaiting, .. }) => assert_eq!(awaiting.as_deref(), Some("question")),
            _ => panic!("expected TurnUsage"),
        }
    }

    #[test]
    fn result_line_detects_done_awaiting() {
        let mut ctx = ParserContext::new_live();
        let line = r#"{"type":"result","subtype":"success","result":"All done! <cc-status:done>","total_cost_usd":0.0,"duration_ms":100,"usage":{"input_tokens":10,"output_tokens":5},"timestamp":1}"#;
        let events = ctx.feed(format!("{}\n", line).as_bytes());
        let usage = events.iter().find(|e| matches!(e, ChatEvent::TurnUsage { .. }));
        match usage {
            Some(ChatEvent::TurnUsage { awaiting, .. }) => assert_eq!(awaiting.as_deref(), Some("done")),
            _ => panic!("expected TurnUsage"),
        }
    }

    #[test]
    fn result_line_detects_waiting_awaiting() {
        let mut ctx = ParserContext::new_live();
        let line = r#"{"type":"result","subtype":"success","result":"Kicked off CI, watching it. <cc-status:waiting>","total_cost_usd":0.0,"duration_ms":100,"usage":{"input_tokens":10,"output_tokens":5},"timestamp":1}"#;
        let events = ctx.feed(format!("{}\n", line).as_bytes());
        let usage = events.iter().find(|e| matches!(e, ChatEvent::TurnUsage { .. }));
        match usage {
            Some(ChatEvent::TurnUsage { awaiting, .. }) => assert_eq!(awaiting.as_deref(), Some("waiting")),
            _ => panic!("expected TurnUsage"),
        }
    }

    #[test]
    fn result_line_detects_working_awaiting() {
        // "working" = own background subagents/tasks still running; the sidebar
        // must show In Progress, not the parked "Waiting" tier.
        let mut ctx = ParserContext::new_live();
        let line = r#"{"type":"result","subtype":"success","result":"3 review agents running in the background. <cc-status:working>","total_cost_usd":0.0,"duration_ms":100,"usage":{"input_tokens":10,"output_tokens":5},"timestamp":1}"#;
        let events = ctx.feed(format!("{}\n", line).as_bytes());
        let usage = events.iter().find(|e| matches!(e, ChatEvent::TurnUsage { .. }));
        match usage {
            Some(ChatEvent::TurnUsage { awaiting, .. }) => assert_eq!(awaiting.as_deref(), Some("working")),
            _ => panic!("expected TurnUsage"),
        }
    }

    #[test]
    fn result_line_no_marker_gives_none_awaiting() {
        let mut ctx = ParserContext::new_live();
        let line = r#"{"type":"result","subtype":"success","result":"plain reply","total_cost_usd":0.0,"duration_ms":100,"usage":{"input_tokens":10,"output_tokens":5},"timestamp":1}"#;
        let events = ctx.feed(format!("{}\n", line).as_bytes());
        let usage = events.iter().find(|e| matches!(e, ChatEvent::TurnUsage { .. }));
        match usage {
            Some(ChatEvent::TurnUsage { awaiting, .. }) => assert!(awaiting.is_none()),
            _ => panic!("expected TurnUsage"),
        }
    }
}
