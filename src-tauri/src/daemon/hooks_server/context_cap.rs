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
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::sync::Arc;

/// Joe's pick, 2026-10-14. A fresh chat already starts at ~50-60k (system
/// prompt, CLAUDE.md files, skill list), so this leaves ~90k of real work.
pub(crate) const CONTEXT_CAP_TOKENS: u64 = 150_000;

const OPT_IN_SKILL: &str = "auto-respawn";

pub(crate) fn render_for_injection(state: &Arc<DaemonState>, session_id: &str) -> Option<String> {
    let path = crate::context_status::resolve_transcript(&state.registry, session_id)?;
    let status = crate::context_status::compute_context_status(&path)?;
    let note = cap_note(status.occupancy)?;
    // The opt-in lives in the transcript itself, so it needs no stored state,
    // survives a daemon restart, and dies with the chat: a successor has to run
    // the skill again. Checked only past the cap, so most turns never scan.
    opted_in(&path).then_some(note)
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

/// True once the chat invoked the skill: a `Skill` tool call naming it, or
/// Joe typing the slash command. Parsed, not substring-matched, so a chat that
/// merely mentions the skill's name (or edits this file) never opts itself in.
fn opted_in(transcript: &Path) -> bool {
    let Ok(file) = std::fs::File::open(transcript) else { return false };
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        if !line.contains(OPT_IN_SKILL) {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
        if line_opts_in(&v) {
            return true;
        }
    }
    false
}

fn line_opts_in(v: &serde_json::Value) -> bool {
    let Some(content) = v.get("message").and_then(|m| m.get("content")) else { return false };
    let typed = |text: &str| text.contains(&format!("<command-name>/{OPT_IN_SKILL}</command-name>"));
    match v.get("type").and_then(|t| t.as_str()) {
        Some("assistant") => content.as_array().is_some_and(|blocks| {
            blocks.iter().any(|b| {
                b.get("type").and_then(|t| t.as_str()) == Some("tool_use")
                    && b.get("name").and_then(|n| n.as_str()) == Some("Skill")
                    && b.get("input").and_then(|i| i.get("skill")).and_then(|s| s.as_str()) == Some(OPT_IN_SKILL)
            })
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
        assert!(!opted_in(f.path()), "mentioning the skill must not opt a chat in");
    }

    #[test]
    fn a_skill_tool_call_opts_in() {
        let f = transcript(&[
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Skill","input":{"skill":"auto-respawn"}}]}}"#,
        ]);
        assert!(opted_in(f.path()));
    }

    #[test]
    fn a_typed_slash_command_opts_in() {
        let f = transcript(&[
            r#"{"type":"user","message":{"content":"<command-message>auto-respawn</command-message>\n<command-name>/auto-respawn</command-name>"}}"#,
        ]);
        assert!(opted_in(f.path()));
    }

    #[test]
    fn unknown_session_injects_nothing() {
        use crate::daemon::session::new_session_map;
        use crate::daemon::settings_cache::SettingsCache;
        let state = DaemonState::new(new_session_map(), SettingsCache::new(crate::types::Settings::default()));
        assert_eq!(render_for_injection(&state, "00000000-0000-4000-8000-00000000dead"), None);
    }
}
