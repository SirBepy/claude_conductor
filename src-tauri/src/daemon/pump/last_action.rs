//! A sub's latest tool call in words ("Editing footer.css"), kept on its row
//! (`SessionProgress::last_action`) so the dashboard's hover card can say what it
//! is doing without reading the transcript. The pump hands every event here; only a
//! live turn's `ToolUse` of a sub counts.

use crate::daemon::state::DaemonState;
use crate::types::chat::ChatEvent;
use serde_json::Value;

/// Longest action line kept: it sits in a hover card, and a Bash command can be a page.
const MAX_CHARS: usize = 60;

/// Chat plumbing that says nothing about the work: a sub's last action is never one of these.
const NOISE: &[&str] = &["report_turn_status", "write_plan", "send_message", "update_message", "TodoWrite"];

fn clip(text: &str) -> String {
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.chars().count() <= MAX_CHARS {
        return text;
    }
    let cut: String = text.chars().take(MAX_CHARS - 1).collect();
    format!("{cut}\u{2026}")
}

fn file_name(input: &Value) -> Option<String> {
    let path = input.get("file_path").or_else(|| input.get("notebook_path")).or_else(|| input.get("path"))?.as_str()?;
    path.rsplit(['/', '\\']).find(|s| !s.is_empty()).map(str::to_string)
}

/// The action in words, or `None` for a call that is not worth showing.
pub fn describe(tool_name: &str, input: &Value) -> Option<String> {
    let bare = tool_name.rsplit("__").next().unwrap_or(tool_name);
    if NOISE.contains(&bare) {
        return None;
    }
    let with_file = |verb: &str| match file_name(input) {
        Some(f) => clip(&format!("{verb} {f}")),
        None => verb.to_string(),
    };
    let text_of = |key: &str| input.get(key).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty());
    Some(match tool_name {
        "Edit" | "MultiEdit" | "NotebookEdit" => with_file("Editing"),
        "Write" => with_file("Writing"),
        "Read" => with_file("Reading"),
        "Bash" | "PowerShell" => match text_of("description").or_else(|| text_of("command")) {
            Some(d) => clip(d),
            None => "Running a command".to_string(),
        },
        "Grep" => match text_of("pattern") {
            Some(p) => clip(&format!("Searching for {p}")),
            None => "Searching".to_string(),
        },
        "Glob" => "Finding files".to_string(),
        "Task" | "Agent" => "Running a subagent".to_string(),
        "WebFetch" | "WebSearch" => "Looking something up online".to_string(),
        _ => clip(&format!("Using {}", bare.replace('_', " "))),
    })
}

/// The pump's one hook: records `ev` when it is a live turn's tool call by a sub and
/// publishes the registry when the change is worth it (`Registry::note_action`).
pub fn note(state: &DaemonState, session_id: &str, live_turn: bool, ev: &ChatEvent) {
    // A resume replays the old transcript's tool calls; those are not what it is doing now.
    if !live_turn {
        return;
    }
    let ChatEvent::ToolUse { tool_name, input, .. } = ev else { return };
    let Some(action) = describe(tool_name, input) else { return };
    if state.registry.note_action(session_id, &action, chrono::Utc::now()) {
        crate::daemon::machines::publish_instances_changed(state);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_tool_call_reads_as_a_short_action() {
        assert_eq!(describe("Edit", &json!({"file_path": "C:\\p\\src\\footer.css"})).as_deref(), Some("Editing footer.css"));
        assert_eq!(describe("Write", &json!({"file_path": "/a/b/notes.md"})).as_deref(), Some("Writing notes.md"));
        assert_eq!(describe("Read", &json!({})).as_deref(), Some("Reading"));
        assert_eq!(describe("Bash", &json!({"command": "cargo test", "description": "Run the unit tests"})).as_deref(), Some("Run the unit tests"));
        assert_eq!(describe("Grep", &json!({"pattern": "fn main"})).as_deref(), Some("Searching for fn main"));
        assert_eq!(describe("mcp__cc_conductor__show_preview", &json!({})).as_deref(), Some("Using show preview"));
    }

    fn tool_use(name: &str, input: Value) -> ChatEvent {
        ChatEvent::ToolUse { tool_name: name.into(), input, id: "t1".into(), timestamp: 0, parent_tool_use_id: None }
    }

    #[test]
    fn the_pump_records_a_live_tool_call_of_a_sub_and_nothing_else() {
        use crate::daemon::session::new_session_map;
        use crate::daemon::settings_cache::SettingsCache;
        let st = DaemonState::new(new_session_map(), SettingsCache::new(crate::types::Settings::default()));
        for id in ["sub", "plain"] {
            st.registry.upsert_interactive(id, std::path::Path::new("."), "proj", "2026-11-12T00:00:00Z");
        }
        st.registry.set_subchat_of("sub", Some("main".into()));
        let edit = tool_use("Edit", json!({"file_path": "src/footer.css"}));

        note(&st, "sub", false, &edit);
        assert!(st.registry.get("sub").unwrap().progress.last_action.is_none(), "a resume replays old tool calls");
        note(&st, "plain", true, &edit);
        assert!(st.registry.get("plain").unwrap().progress.last_action.is_none(), "only a sub keeps one");
        note(&st, "sub", true, &ChatEvent::Notification { kind: "x".into(), body: "y".into() });
        assert!(st.registry.get("sub").unwrap().progress.last_action.is_none(), "only a tool call is an action");

        note(&st, "sub", true, &edit);
        let p = st.registry.get("sub").unwrap().progress;
        assert_eq!(p.last_action.as_deref(), Some("Editing footer.css"));
        assert!(p.last_action_at.is_some());
    }

    #[test]
    fn chat_plumbing_is_never_the_last_action() {
        for tool in ["mcp__cc_conductor__report_turn_status", "mcp__cc_conductor__write_plan", "mcp__cc_conductor__send_message", "TodoWrite"] {
            assert_eq!(describe(tool, &json!({})), None, "{tool}");
        }
    }

    #[test]
    fn a_long_command_is_cut_to_one_line() {
        let long = format!("echo {}", "x".repeat(200));
        let out = describe("Bash", &json!({"command": long})).unwrap();
        assert_eq!(out.chars().count(), MAX_CHARS);
        assert!(out.ends_with('\u{2026}'));
    }
}
