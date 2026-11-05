//! Subchats tool schemas. `finish_subchat` is advertised only when the MCP
//! child's env carries `CC_SUBCHAT=1` (`daemon::subchats::SUB_ENV`), which
//! `write_mcp_config` sets for a hidden sub and no other chat. `subchat` is
//! listed for every chat, because the tool list is fixed when the server
//! process starts and cannot follow a mid-chat toggle; it refuses itself when
//! the chat has no subs.

use serde_json::{json, Value};

pub const TOOL_FINISH_SUBCHAT: &str = "finish_subchat";
pub const TOOL_SUBCHAT: &str = "subchat";

/// The main chat's side: look up its subs and pass a message to one. Short on
/// purpose, like `write_user_todo`: it is listed for every chat, so its
/// description is paid for on every turn of chats that never use the mode.
pub fn chat_schemas() -> Vec<Value> {
    vec![json!({
        "name": TOOL_SUBCHAT,
        "description": "Only for a chat with Use subchats on: look up its subs and pass them a message (refuses with the fix when this chat has no subs, and from a sub). `list`: each sub's name, status, tier and task. `status` needs sub: its verdict, summary, facts and progress. `log`: the decisions log. `send` needs sub, or all=true for every running sub (an outside update such as a pasted Slack message). `send` passes Joe's latest message to the sub word for word, with his images; you only pick the target, never retype or summarise it. Set `text` only when Joe sent nothing to copy and you have an instruction of your own. `writes`=true when the follow-up needs the sub to edit files. A finished sub is woken with its context; a busy one gets it at its next step. A sub is found by exact name, then unique prefix, then id.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "action": {"type": "string", "enum": ["list", "status", "log", "send"]},
                "sub": {"type": "string", "description": "A sub's name, a unique start of it, or its id. For status and send."},
                "all": {"type": "boolean", "description": "send to every running sub instead of one. Finished subs are not woken."},
                "writes": {"type": "boolean", "description": "send: the follow-up needs the sub to edit files. Only one sub edits files at a time in a project: if another holds the writer slot this sub is queued for it, and the result says so."},
                "text": {"type": "string", "description": "send: your own instruction, only when there is no message from Joe to copy. It reaches the sub framed as coming from the main chat."}
            },
            "required": ["action"]
        }
    })]
}

fn rows(max_len: u32, what: &str) -> Value {
    json!({"type": "array", "maxItems": 8, "items": {"type": "string", "maxLength": max_len}, "description": what})
}

pub fn subchat_schemas() -> Vec<Value> {
    vec![json!({
        "name": TOOL_FINISH_SUBCHAT,
        "description": "End your job. Call this when the work is done; it replaces send_message and report_turn_status at the end of a turn, and it is the only way a sub ends (/close does not apply). The daemon stops this chat once your turn ends, keeps it, and wakes it with all its context if Joe or the main chat follows up. Joe sees a short verdict card built from this call, so write it for him. Refused with an error naming the fix while files YOU edited are uncommitted (commit them by path first; a peer's dirty files do not count) or while your own background work is running (wait or stop it). If you changed files and the project asks for a reviewer (its default; the brief's `review: false` opts out), it is refused until `reviewer_tool_use_id` names a fresh subagent (an Agent call, run with no shared context on your own diff) whose result came back after your last edit: fix what it finds and run a new one only if you edit again. The report fields follow send_message's report kind: `text` is at most 200 chars, `verdict` at most 40 chars and says the conclusion as a person would (\"Built, not pushed\"), each row list holds at most 8 rows of 120 chars. `decided` and `ruled_out` are required and are kept in a log for later jobs: list each decision worth keeping and each option you dropped as one short row, or [\"nothing\"] when there is nothing, because a padded list is worse than an honest one. A decided row that replaces an entry already in the decisions log starts with \"replaces D3:\" (the entry's own id), which closes that entry.",
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
                "decided": rows(200, "Required. Decisions you made that a later job should know, one short row each, or [\"nothing\"]. Start a row with \"replaces D3:\" to close an earlier decisions-log entry it replaces."),
                "ruled_out": rows(200, "Required. Options you tried or weighed and dropped, one short row each, or [\"nothing\"]."),
                "reviewer_tool_use_id": {"type": "string", "description": "The tool_use id of the Agent call that ran the fresh-context reviewer on your own diff. Required when you changed files, unless the brief says review false or the project is set to facts only."}
            },
            "required": ["verdict", "text", "decided", "ruled_out"]
        }
    })]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_subchat_tool_takes_an_action_and_defaults_to_copying_joes_message() {
        let s = &chat_schemas()[0];
        assert_eq!(s["name"], TOOL_SUBCHAT);
        let props = s["inputSchema"]["properties"].as_object().unwrap();
        for k in ["action", "sub", "all", "writes", "text"] {
            assert!(props.contains_key(k), "{k}");
        }
        let actions: Vec<&str> = props["action"]["enum"].as_array().unwrap().iter().filter_map(Value::as_str).collect();
        assert_eq!(actions, ["list", "status", "log", "send"]);
        assert_eq!(s["inputSchema"]["required"], json!(["action"]));
        let d = s["description"].as_str().unwrap();
        assert!(d.contains("word for word") && d.contains("never retype"), "{d}");
        assert!(!d.contains('\u{2014}'));
        assert!(d.chars().count() < 1100, "listed for every chat, so it stays short");
    }

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
    fn the_finish_description_names_the_reviewer_rule() {
        let s = &subchat_schemas()[0];
        let d = s["description"].as_str().unwrap();
        assert!(d.contains("reviewer_tool_use_id") && d.contains("fresh subagent") && d.contains("after your last edit"), "{d}");
        assert!(d.contains("review: false"));
        let id = s["inputSchema"]["properties"]["reviewer_tool_use_id"]["description"].as_str().unwrap();
        assert!(id.contains("Required when you changed files"), "{id}");
    }

    #[test]
    fn the_description_names_both_refusals_and_what_it_replaces() {
        let d = subchat_schemas()[0]["description"].as_str().unwrap().to_string();
        assert!(d.contains("uncommitted") && d.contains("background work"));
        assert!(d.contains("replaces send_message and report_turn_status"));
        assert!(d.contains("\"replaces D3:\""), "the replaces convention is taught where decided is written");
        let props = &subchat_schemas()[0]["inputSchema"]["properties"];
        assert!(props["decided"]["description"].as_str().unwrap().contains("replaces D3:"));
        assert!(!d.contains('\u{2014}'));
    }
}
