//! Sub-only tool schemas. Only advertised when the MCP child's env carries
//! `CC_SUBCHAT=1` (`daemon::subchats::SUB_ENV`), which `write_mcp_config` sets
//! for a hidden sub and no other chat.

use serde_json::{json, Value};

pub const TOOL_FINISH_SUBCHAT: &str = "finish_subchat";

fn rows(max_len: u32, what: &str) -> Value {
    json!({"type": "array", "maxItems": 8, "items": {"type": "string", "maxLength": max_len}, "description": what})
}

pub fn subchat_schemas() -> Vec<Value> {
    vec![json!({
        "name": TOOL_FINISH_SUBCHAT,
        "description": "End your job. Call this when the work is done; it replaces send_message and report_turn_status at the end of a turn, and it is the only way a sub ends (/close does not apply). The daemon stops this chat once your turn ends, keeps it, and wakes it with all its context if Joe or the main chat follows up. Joe sees a short verdict card built from this call, so write it for him. Refused with an error naming the fix while files YOU edited are uncommitted (commit them by path first; a peer's dirty files do not count) or while your own background work is running (wait or stop it). The report fields follow send_message's report kind: `text` is at most 200 chars, `verdict` at most 40 chars and says the conclusion as a person would (\"Built, not pushed\"), each row list holds at most 8 rows of 120 chars. `decided` and `ruled_out` are required and are kept in a log for later jobs: list each decision worth keeping and each option you dropped as one short row, or [\"nothing\"] when there is nothing, because a padded list is worse than an honest one.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "verdict": {"type": "string", "maxLength": 40, "description": "The conclusion as a person would say it out loud (\"Built, not pushed\", \"Stuck on auth\"), at most 40 chars."},
                "text": {"type": "string", "maxLength": 200, "description": "One or two lines for Joe: what happened. At most 200 chars."},
                "tone": {"type": "string", "enum": ["good", "bad", "neutral"], "description": "Optional colour of the verdict."},
                "done": rows(120, "What got done, at most 8 rows of 120 chars."),
                "not_done": rows(120, "What is not done, at most 8 rows of 120 chars."),
                "waiting_on": rows(120, "What the work is waiting on, at most 8 rows of 120 chars."),
                "your_move": rows(120, "ONLY rows Joe himself must act on, at most 8 of 120 chars."),
                "points": rows(200, "Optional extra points shown behind a click, at most 6 of 200 chars."),
                "decided": rows(200, "Required. Decisions you made that a later job should know, one short row each, or [\"nothing\"]."),
                "ruled_out": rows(200, "Required. Options you tried or weighed and dropped, one short row each, or [\"nothing\"]."),
                "reviewer_tool_use_id": {"type": "string", "description": "The tool_use id of the fresh-context review subagent you ran on your own diff, when you ran one. Optional."}
            },
            "required": ["verdict", "text", "decided", "ruled_out"]
        }
    })]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_schema_requires_the_report_core_and_both_log_fields() {
        let s = &subchat_schemas()[0];
        assert_eq!(s["name"], TOOL_FINISH_SUBCHAT);
        let required: Vec<&str> = s["inputSchema"]["required"].as_array().unwrap().iter().filter_map(Value::as_str).collect();
        for k in ["verdict", "text", "decided", "ruled_out"] {
            assert!(required.contains(&k), "{k} must be required");
        }
        assert!(!required.contains(&"reviewer_tool_use_id"), "the reviewer id is optional");
    }

    #[test]
    fn the_description_names_both_refusals_and_what_it_replaces() {
        let d = subchat_schemas()[0]["description"].as_str().unwrap().to_string();
        assert!(d.contains("uncommitted") && d.contains("background work"));
        assert!(d.contains("replaces send_message and report_turn_status"));
        assert!(!d.contains('\u{2014}'));
    }
}
