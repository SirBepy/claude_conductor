//! Subchats tool schemas. `finish_subchat` is advertised only when the MCP
//! child's env carries `CC_SUBCHAT=1` (`daemon::subchats::SUB_ENV`), which
//! `write_mcp_config` sets for a hidden sub and no other chat. `subchat` is
//! listed for every chat, because the tool list is fixed when the server
//! process starts and cannot follow a mid-chat toggle; it refuses itself when
//! the chat has no subs.

use crate::daemon::subchats::QUESTION_MAX;
use serde_json::{json, Value};

pub const TOOL_FINISH_SUBCHAT: &str = "finish_subchat";
pub const TOOL_SUBCHAT: &str = "subchat";
pub const TOOL_SHARED_MOCKUP: &str = "shared_mockup";

/// The main chat's side: look up its subs and pass a message to one. Short on
/// purpose, like `write_user_todo`: it is listed for every chat, so its
/// description is paid for on every turn of chats that never use the mode.
pub fn chat_schemas() -> Vec<Value> {
    vec![shared_mockup_schema(), json!({
        "name": TOOL_SUBCHAT,
        "description": "Only for a chat with Use subchats on: look up its subs and pass them a message (refuses with the fix when this chat has no subs, and from a sub). `list`: each sub's name, status, tier and task. `status` needs sub: its verdict, summary, facts and progress. `log`: the decisions log. `send` needs sub, or all=true for every running sub (an outside update such as a pasted Slack message). `send` passes Joe's latest message to the sub word for word, with his images; you only pick the target, never retype or summarise it. Set `text` only when Joe sent nothing to copy and you have an instruction of your own. `writes`=true when the follow-up needs the sub to edit files. A finished sub is woken with its context; a busy one gets it at its next step. `drop` needs sub: ends a sub that never started (queued), for a job no longer wanted. A sub is found by exact name, then prefix, then id; a sub that has not ended beats an ended one, and the newest wins among equal names.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "action": {"type": "string", "enum": ["list", "status", "log", "send", "drop"]},
                "sub": {"type": "string", "description": "A sub's name, a unique start of it, or its id. For status, send and drop."},
                "all": {"type": "boolean", "description": "send to every running sub instead of one. Finished subs are not woken."},
                "writes": {"type": "boolean", "description": "send: the follow-up needs the sub to edit files. Only one sub edits files at a time in a project: if another holds the writer slot this sub is queued for it, and the result says so."},
                "text": {"type": "string", "description": "send: your own instruction, only when there is no message from Joe to copy. It reaches the sub framed as coming from the main chat."},
                "question": {"type": "string", "maxLength": QUESTION_MAX, "description": "send: when Joe's follow-up asks for information, his question rewritten as one clear question (at most 200 chars). The sub's finish is then drawn as the answer in his Answers card, so you relay nothing."}
            },
            "required": ["action"]
        }
    })]
}


/// One page a main chat and its subs build together. Listed for every chat; the
/// daemon refuses with the fix when the caller has no right to the action.
fn shared_mockup_schema() -> Value {
    json!({
        "name": TOOL_SHARED_MOCKUP,
        "description": "One shared mockup page per main chat that its subs each add controls to; use it instead of every sub pushing its own show_preview page. `create` (the main chat only, once, before or as it hands out jobs): slug, title, shell = the page html with one EMPTY element per sub's region, e.g. <div data-part=\"header\"></div> (double quotes, nothing inside). `part` (a sub, or the main chat): part = a region id of the shell, html = that region's content, css, controls. Omit slug and a sub finds its main chat's page. A sub writes only its own region. The panel shows a row of the subs that added controls; Joe opens one sub's controls and the page changes at once, with no reload. controls = [{id, label, kind, options, default}] with at most 8: kind \"select\" is a choice between 2 to 12 options (a native dropdown), kind \"switch\" is a plain yes/no (default true or false). Never express a choice as several switches or as buttons in the html. A control sets data-<id>=\"<value>\" on your region's root element (a switch is \"on\" or \"off\"), so style it in css, which applies only inside your region and is scoped with @scope: write `:scope[data-style=\"ember\"] h3 {...}` for rules that depend on the attribute, and the plain `h3 {...}` for the rest. No script is needed. Pushing a part again replaces it; omit controls to keep the old ones. For one chat's own exploration use show_preview instead, and say why in its title."
        ,
        "inputSchema": {
            "type": "object",
            "properties": {
                "action": {"type": "string", "enum": ["create", "part"]},
                "slug": {"type": "string", "description": "The mockup's name. create: required. part: optional, defaults to the main chat's newest shared mockup."},
                "title": {"type": "string", "description": "create: the panel title."},
                "shell": {"type": "string", "description": "create: the page html with one empty element per region, each carrying data-part=\"<id>\". Ids are lowercase letters, digits, - or _."},
                "part": {"type": "string", "description": "part: the region id from the shell that this part fills."},
                "html": {"type": "string", "description": "part: the region's content."},
                "css": {"type": "string", "description": "part: css for this region only. Use :scope[data-<control id>=\"<value>\"] for rules that follow a control."},
                "controls": {
                    "type": "array",
                    "maxItems": 8,
                    "description": "part: this region's controls. Omitted keeps the earlier ones, [] clears them.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "id": {"type": "string", "description": "Lowercase letters, digits, - or _. Becomes the data-<id> attribute."},
                            "label": {"type": "string", "description": "What Joe reads, at most 40 chars."},
                            "kind": {"type": "string", "enum": ["select", "switch"]},
                            "options": {"type": "array", "items": {"type": "string"}, "description": "select only: 2 to 12 values."},
                            "default": {"description": "select: one of the options. switch: true or false."}
                        },
                        "required": ["id", "label", "kind"]
                    }
                }
            },
            "required": ["action"]
        }
    })
}

fn rows(max_len: u32, what: &str) -> Value {
    json!({"type": "array", "maxItems": 8, "items": {"type": "string", "maxLength": max_len}, "description": what})
}

pub fn subchat_schemas() -> Vec<Value> {
    vec![json!({
        "name": TOOL_FINISH_SUBCHAT,
        "description": "End your job. Call this when the work is done; it replaces send_message and report_turn_status at the end of a turn, and it is the only way a sub ends (/close does not apply). The daemon stops this chat once your turn ends, keeps it, and wakes it with all its context if Joe or the main chat follows up. Joe sees a short verdict card built from this call, so write it for him. Refused with an error naming the fix while files YOU edited are uncommitted (commit them by path first; a peer's dirty files do not count) or while your own background work is running (wait or stop it). If you changed files and the project asks for a reviewer (its default; the brief's `review: false` opts out), it is refused until a fresh subagent (an Agent call, run with no shared context on your own diff, in the foreground so its result lands in your transcript) has returned after your last edit: fix what it finds and run a new one only if you edit again. The app finds that subagent call itself; you cannot see tool_use ids, so do not look for one. The report fields follow send_message's report kind: `text` is at most 200 chars, `verdict` at most 40 chars and says the conclusion as a person would (\"Built, not pushed\"), each row list holds at most 8 rows of 120 chars. `decided` and `ruled_out` are required and are kept in a log for later jobs: list each decision worth keeping and each option you dropped as one short row, or [\"nothing\"] when there is nothing, because a padded list is worse than an honest one. A decided row that replaces an entry already in the decisions log starts with \"replaces D3:\" (the entry's own id), which closes that entry.",
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
                "reviewer_tool_use_id": {"type": "string", "description": "Normally leave this out: the app finds your reviewer itself, the last Agent call after your last edit. Only if you can already see the tool_use id of the Agent call that reviewed your diff, you may pass it, and it is then checked."}
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
        let all = chat_schemas();
        let s = all.iter().find(|t| t["name"] == TOOL_SUBCHAT).unwrap();
        assert_eq!(s["name"], TOOL_SUBCHAT);
        let props = s["inputSchema"]["properties"].as_object().unwrap();
        for k in ["action", "sub", "all", "writes", "text", "question"] {
            assert!(props.contains_key(k), "{k}");
        }
        let actions: Vec<&str> = props["action"]["enum"].as_array().unwrap().iter().filter_map(Value::as_str).collect();
        assert_eq!(actions, ["list", "status", "log", "send", "drop"]);
        assert_eq!(s["inputSchema"]["required"], json!(["action"]));
        let d = s["description"].as_str().unwrap();
        assert!(d.contains("word for word") && d.contains("never retype"), "{d}");
        assert!(!d.contains('\u{2014}'));
        assert!(d.chars().count() < 1100, "listed for every chat, so it stays short");
    }

    #[test]
    fn shared_mockup_is_listed_for_every_chat_and_names_the_control_convention() {
        let all = chat_schemas();
        let s = all.iter().find(|t| t["name"] == TOOL_SHARED_MOCKUP).expect("listed for every chat");
        let d = s["description"].as_str().unwrap();
        for needle in ["data-part", "select", "switch", ":scope", "show_preview", "own region"] {
            assert!(d.contains(needle), "description must mention {needle}: {d}");
        }
        assert!(!d.contains('\u{2014}'));
        let kinds = &s["inputSchema"]["properties"]["controls"]["items"]["properties"]["kind"]["enum"];
        assert_eq!(kinds, &json!(["select", "switch"]), "no chip or button kind exists");
        assert_eq!(s["inputSchema"]["properties"]["action"]["enum"], json!(["create", "part"]));
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
        assert!(d.contains("fresh subagent") && d.contains("after your last edit") && d.contains("foreground"), "{d}");
        assert!(d.contains("review: false"));
        // A model cannot see a tool_use id, so the tool never asks for one.
        assert!(d.contains("cannot see tool_use ids"), "{d}");
        let id = s["inputSchema"]["properties"]["reviewer_tool_use_id"]["description"].as_str().unwrap();
        assert!(id.contains("Normally leave this out") && !id.contains("Required"), "{id}");
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

    // Four schema copies, the daemon checks and the main-chat prompt prose all
    // state the rewritten-question limit; one const owns the number.
    #[test]
    fn every_question_schema_and_its_prose_name_question_max() {
        use super::super::tool_schemas_coordination::{coordination_schemas, TOOL_SEND_MESSAGE};
        use super::super::tool_schemas_workflow::{workflow_schemas, TOOL_SPAWN_CHAT};
        let find = |all: Vec<Value>, name: &str| all.into_iter().find(|t| t["name"] == name).unwrap();
        let tools = [
            find(workflow_schemas(), TOOL_SPAWN_CHAT),
            find(chat_schemas(), TOOL_SUBCHAT),
            find(coordination_schemas(), TOOL_SEND_MESSAGE),
        ];
        for t in &tools {
            let q = &t["inputSchema"]["properties"]["question"];
            assert_eq!(q["maxLength"], QUESTION_MAX, "{} question maxLength", t["name"]);
            let said = format!("at most {QUESTION_MAX} chars");
            assert!(q["description"].as_str().unwrap().contains(&said), "{} question prose", t["name"]);
        }
        let prose = include_str!("../daemon/claude_config/args.rs");
        assert!(prose.contains(&format!("one clear question of at most {QUESTION_MAX} chars")), "main-chat prompt prose");
        assert!(prose.contains(&format!("question = his question rewritten as one clear question of at most {QUESTION_MAX} chars")));
    }
}
