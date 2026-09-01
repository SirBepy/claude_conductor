//! Split out of `tool_schemas.rs` (todo 801): the permission-relay,
//! question-card, and close-confirm tool schemas. Content is byte-identical
//! to before.

use serde_json::{json, Value};

pub const TOOL_APPROVAL: &str = "approval_prompt";
pub const TOOL_QUESTION: &str = "ask_user_question";

/// Shared by the schema below and `server::question_args`'s validator so the
/// two cannot drift (todo 818). Frontend twin: `DOMAIN_META`/`BADGE_META` in
/// `src/views/sessions/permission-modal/types.ts`.
pub const QUESTION_DOMAINS: [&str; 7] =
    ["ux", "arch", "sec", "data", "tooling", "infra", "billing"];
pub const OPTION_BADGES: [&str; 3] = ["recommended", "long_term", "short_term"];
pub const TOOL_CLOSE: &str = "close_session";

pub fn core_schemas() -> Vec<Value> {
    vec![
        json!({
            "name": TOOL_APPROVAL,
            "description": "Permission relay. Returns {behavior:'allow'|'deny'}.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "tool_name": {"type": "string"},
                    "input": {"type": "object"}
                },
                "required": ["tool_name", "input"]
            }
        }),
        json!({
            "name": TOOL_QUESTION,
            "description": "Present one or more questions to the user as a floating card. There is NO cap on how many questions you may send - unlike the built-in AskUserQuestion tool, which stops at 4, this one accepts any number. Prefer it whenever you have more than 4, and always ask everything you need in ONE call instead of drip-feeding the user across several rounds. Keep 'question' scannable: short paragraphs (blank line between) rather than one dense run-on paragraph, bold the 1-2 facts that matter, bullet enumerable items, and end with the literal, standalone ask as its own final sentence. Options need short labels; put nuance in each option's description. 'domain' tags what kind of decision this is, so the user can weigh it accordingly. 'badges' mark an option as the recommended and/or long-term/short-term best pick - they are fixed tokens (recommended, long_term, short_term), never free text, and an out-of-enum value is rejected outright rather than dropped. Returns answers keyed by question text.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "questions": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "question": {"type": "string"},
                                "header": {"type": "string"},
                                "domain": {
                                    "type": "string",
                                    "enum": QUESTION_DOMAINS
                                },
                                "multiSelect": {"type": "boolean"},
                                "options": {
                                    "type": "array",
                                    "items": {
                                        "type": "object",
                                        "properties": {
                                            "label": {"type": "string"},
                                            "description": {"type": "string"},
                                            "badges": {
                                                "type": "array",
                                                "items": {
                                                    "type": "string",
                                                    "enum": OPTION_BADGES
                                                }
                                            }
                                        }
                                    }
                                }
                            },
                            "required": ["question"]
                        }
                    }
                },
                "required": ["questions"]
            }
        }),
        json!({
            "name": TOOL_CLOSE,
            "description": "Confirm this chat's /close teardown so the host app ends the session and kills the process at turn end. Call ONLY from the /close skill's final close step, and never on --dont-close or a failed chain.",
            "inputSchema": {
                "type": "object",
                "properties": {}
            }
        }),
    ]
}
