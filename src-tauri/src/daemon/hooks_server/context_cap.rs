//! Context-cap rider on the per-turn `UserPromptSubmit` injection, for chats
//! that opted in by running the `/auto-respawn` skill: once such a chat's
//! context passes [`CONTEXT_CAP_TOKENS`], every turn carries a note telling it
//! to hand off through `respawn`. Opt-in only, never a default: a respawn drops
//! the conversation, which ruins an ordinary working chat (Joe, 2026-10-14). It
//! exists for long-running listener chats like mc_plugins_tag's Player Claude
//! hub, whose own "respawn at 30-40%" doc rule was read both as used and as
//! left and landed respawns anywhere from 250k to 770k. It rides an existing
//! turn, never a wake of its own.

use crate::daemon::state::DaemonState;
use std::sync::Arc;

/// Joe's pick, 2026-10-14. A fresh chat already starts at ~50-60k (system
/// prompt, CLAUDE.md files, skill list), so this leaves ~90k of real work.
pub(crate) const CONTEXT_CAP_TOKENS: u64 = 150_000;

const OPT_IN_SKILL: &str = "auto-respawn";

pub(crate) fn render_for_injection(state: &Arc<DaemonState>, session_id: &str) -> Option<String> {
    let path = crate::context_status::resolve_transcript(&state.registry, session_id)?;
    note_for_transcript(&path)
}

fn note_for_transcript(path: &std::path::Path) -> Option<String> {
    // The opt-in lives in the transcript itself, so it needs no stored state,
    // survives a daemon restart, and dies with the chat: a successor has to run
    // the skill again. It rides the occupancy score's own streaming pass, so the
    // (tool-heavy, multi-megabyte) transcript is read once per turn and never
    // held in memory whole; only lines naming the skill are parsed.
    let mut opted = false;
    let status = crate::context_status::compute_context_status_visiting(path, |line| {
        opted = opted || line_opts_in(line);
    })?;
    let note = cap_note(status.occupancy)?;
    opted.then_some(note)
}

fn cap_note(occupancy: u64) -> Option<String> {
    (occupancy >= CONTEXT_CAP_TOKENS).then(|| {
        format!(
            "Context cap (/auto-respawn is on for this chat): it is at {}k tokens, past the {}k cap. Finish the current request, then call `respawn` with a complete handoff prompt that tells the successor to run /auto-respawn first.",
            occupancy / 1000,
            CONTEXT_CAP_TOKENS / 1000
        )
    })
}

/// True when this transcript line is the chat invoking the skill: a `Skill`
/// tool call naming it, or Joe typing the slash command. Parsed, not
/// substring-matched, so a chat that merely mentions the skill's name (or edits
/// this file) never opts itself in.
fn line_opts_in(line: &str) -> bool {
    if !line.contains(OPT_IN_SKILL) {
        return false;
    }
    serde_json::from_str::<serde_json::Value>(line.trim()).is_ok_and(|v| value_opts_in(&v))
}

fn value_opts_in(v: &serde_json::Value) -> bool {
    let Some(content) = v.get("message").and_then(|m| m.get("content")) else { return false };
    let typed = |text: &str| text.contains(&format!("<command-name>/{OPT_IN_SKILL}</command-name>"));
    match v.get("type").and_then(|t| t.as_str()) {
        Some("assistant") => content.as_array().is_some_and(|blocks| {
            blocks.iter().any(|b| crate::skill_usage::parser::skill_tool_use_name(b) == Some(OPT_IN_SKILL))
        }),
        Some("user") => match content {
            serde_json::Value::String(s) => typed(s),
            serde_json::Value::Array(blocks) => blocks.iter().any(|b| {
                b.get("type").and_then(|t| t.as_str()) == Some("text")
                    && b.get("text").and_then(|t| t.as_str()).is_some_and(typed)
            }),
            _ => false,
        },
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn transcript(lines: &[&str]) -> tempfile::NamedTempFile {
        let mut f = tempfile::NamedTempFile::new().unwrap();
        for l in lines {
            writeln!(f, "{l}").unwrap();
        }
        f
    }

    fn opted_in(f: &tempfile::NamedTempFile) -> bool {
        std::fs::read_to_string(f.path()).unwrap().lines().any(line_opts_in)
    }

    #[test]
    fn below_the_cap_injects_nothing() {
        assert_eq!(cap_note(CONTEXT_CAP_TOKENS - 1), None);
    }

    #[test]
    fn at_the_cap_names_the_size_and_respawn() {
        let note = cap_note(212_345).expect("over the cap");
        assert!(note.contains("212k"), "{note}");
        assert!(note.contains("150k"), "{note}");
        assert!(note.contains("`respawn`"), "{note}");
    }

    #[test]
    fn a_chat_that_never_ran_the_skill_is_not_opted_in() {
        let f = transcript(&[
            r#"{"type":"user","message":{"content":"should we build an auto-respawn skill?"}}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"run /auto-respawn to opt in"}]}}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Edit","input":{"new_string":"\"skill\":\"auto-respawn\""}}]}}"#,
        ]);
        assert!(!opted_in(&f), "mentioning the skill must not opt a chat in");
    }

    #[test]
    fn a_skill_tool_call_opts_in() {
        let f = transcript(&[
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Skill","input":{"skill":"auto-respawn"}}]}}"#,
        ]);
        assert!(opted_in(&f));
    }

    #[test]
    fn a_typed_slash_command_opts_in() {
        let f = transcript(&[
            r#"{"type":"user","message":{"content":"<command-message>auto-respawn</command-message>\n<command-name>/auto-respawn</command-name>"}}"#,
        ]);
        assert!(opted_in(&f));
    }

    const PAST_CAP_USAGE: &str = r#"{"type":"assistant","message":{"model":"claude-opus-4-8","usage":{"input_tokens":200000,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}"#;

    #[test]
    fn past_the_cap_an_opted_in_chat_gets_the_note_from_one_pass() {
        let f = transcript(&[
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Skill","input":{"skill":"auto-respawn"}}]}}"#,
            PAST_CAP_USAGE,
        ]);
        let note = note_for_transcript(f.path()).expect("opted in and past the cap");
        assert!(note.contains("200k"), "{note}");
    }

    #[test]
    fn past_the_cap_a_chat_that_never_opted_in_gets_nothing() {
        let f = transcript(&[PAST_CAP_USAGE]);
        assert_eq!(note_for_transcript(f.path()), None);
    }

    #[test]
    fn unknown_session_injects_nothing() {
        use crate::daemon::session::new_session_map;
        use crate::daemon::settings_cache::SettingsCache;
        let state = DaemonState::new(new_session_map(), SettingsCache::new(crate::types::Settings::default()));
        assert_eq!(render_for_injection(&state, "00000000-0000-4000-8000-00000000dead"), None);
    }
}
