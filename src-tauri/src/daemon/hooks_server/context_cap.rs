//! Context-cap rider on the per-turn `UserPromptSubmit` injection, for chats
//! that opted in by running the `/auto-respawn` skill: once such a chat's
//! context passes [`CONTEXT_CAP_TOKENS`], every turn carries a note telling it
//! to hand off through `respawn`. Opt-in only, never a default: a respawn drops
//! the conversation, which ruins an ordinary working chat (Joe, 2026-10-14). It
//! exists for long-running listener chats like mc_plugins_tag's Player Claude
//! hub, whose own "respawn at 30-40%" doc rule was read both as used and as
//! left and landed respawns anywhere from 250k to 770k. It rides an existing
//! turn, never a wake of its own.

use crate::context_status::tail::{self, ContextCursor, CursorStore};
use crate::daemon::state::DaemonState;
use std::sync::Arc;

/// Joe's pick, 2026-10-14. A fresh chat already starts at ~50-60k (system
/// prompt, CLAUDE.md files, skill list), so this leaves ~90k of real work.
pub(crate) const CONTEXT_CAP_TOKENS: u64 = 150_000;

const OPT_IN_SKILL: &str = "auto-respawn";

/// What one pass over the transcript tail learned about a chat.
pub(crate) struct CapView {
    /// The chat ran `/auto-respawn` (sticky once seen).
    pub opted: bool,
    status: Option<crate::context_status::ContextStatus>,
    /// Changes whenever the chat's context was rewritten under the same session
    /// id (a compaction, or the transcript being replaced); see `ContextCursor`.
    pub epoch: u64,
}

/// One cursor per session, advanced over only the bytes appended since the
/// previous turn. A tool-heavy transcript runs to tens of megabytes and this
/// ran on EVERY turn of every chat, opted in or not; now a turn costs its tail,
/// and the first one after a daemon restart costs the same because the cursor
/// (offset plus running state) is persisted.
static CURSORS: std::sync::LazyLock<CursorStore<ContextCursor>> =
    std::sync::LazyLock::new(|| CursorStore::new("context"));

impl CapView {
    /// Percent of the window the chat's context fills, once it has a usage line.
    pub(crate) fn pct_used(&self) -> Option<u8> {
        self.status.as_ref().map(|s| s.pct_used)
    }
}

pub(crate) fn view(state: &Arc<DaemonState>, session_id: &str) -> Option<CapView> {
    let path = crate::context_status::resolve_transcript(&state.registry, session_id)?;
    view_of(&path, session_id, tail::cursor_dir().as_deref())
}

fn view_of(path: &std::path::Path, session_id: &str, dir: Option<&std::path::Path>) -> Option<CapView> {
    // The opt-in lives in the transcript itself, so it dies with the chat (a
    // successor has to run the skill again) and, being remembered in the
    // persisted cursor, survives a daemon restart. Only lines naming the skill
    // are parsed. The occupancy is scored from the cursor's running state, and
    // only when the chat opted in (see `note_for_view`).
    CURSORS.with(dir, session_id, |cursor| {
        cursor.advance(path, line_opts_in).then(|| CapView {
            opted: cursor.flagged(),
            status: cursor.status(),
            epoch: cursor.epoch(),
        })
    })
}

/// A chat that never opted in is answered before its occupancy is scored.
pub(crate) fn note_for_view(view: &CapView) -> Option<String> {
    if !view.opted {
        return None;
    }
    cap_note(view.status.as_ref()?.occupancy)
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

    /// The cursor-based note for `path`, each file under its own session key.
    fn note_for_transcript(path: &std::path::Path) -> Option<String> {
        note_for_view(&view_of(path, &path.to_string_lossy(), None)?)
    }

    /// The previous implementation: one streaming pass over the whole file.
    fn full_note(path: &std::path::Path) -> Option<String> {
        let mut opted = false;
        let status = crate::context_status::compute_context_status_visiting(path, |line| {
            opted = opted || line_opts_in(line);
        })?;
        let note = cap_note(status.occupancy)?;
        opted.then_some(note)
    }

    fn append(path: &std::path::Path, line: &str) {
        let mut f = std::fs::OpenOptions::new().append(true).open(path).unwrap();
        writeln!(f, "{line}").unwrap();
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
        assert!(view(&state, "00000000-0000-4000-8000-00000000dead").is_none());
    }

    const OPT_IN: &str = r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Skill","input":{"skill":"auto-respawn"}}]}}"#;

    fn usage(tokens: u64) -> String {
        format!(r#"{{"type":"assistant","message":{{"model":"claude-opus-4-8","usage":{{"input_tokens":{tokens}}}}}}}"#)
    }

    #[test]
    fn reading_only_the_appended_lines_gives_the_full_reads_note_after_every_append() {
        let f = transcript(&[r#"{"type":"user","message":{"content":"hi"}}"#]);
        let lines = [usage(100_000), OPT_IN.to_string(), usage(120_000), "not json".into(), usage(200_000), usage(40_000), usage(260_000)];
        assert_eq!(note_for_transcript(f.path()), full_note(f.path()));
        for l in &lines {
            append(f.path(), l);
            assert_eq!(note_for_transcript(f.path()), full_note(f.path()), "after appending {l}");
        }
        assert!(note_for_transcript(f.path()).expect("past the cap").contains("260k"));
    }

    #[test]
    fn an_opt_in_in_an_earlier_read_is_remembered_by_the_next_one() {
        let f = transcript(&[OPT_IN]);
        assert_eq!(note_for_transcript(f.path()), None, "opted in but under the cap");
        append(f.path(), &usage(180_000));
        assert!(note_for_transcript(f.path()).is_some(), "the opt-in lies behind the offset");
    }

    #[test]
    fn a_shrunk_or_replaced_transcript_is_read_from_the_start() {
        let f = transcript(&[OPT_IN, &usage(300_000)]);
        assert!(note_for_transcript(f.path()).is_some());

        // Shorter than the remembered offset.
        std::fs::write(f.path(), format!("{}
", usage(300_000))).unwrap();
        assert_eq!(note_for_transcript(f.path()), None, "the new file never opted in");
        assert_eq!(note_for_transcript(f.path()), full_note(f.path()));

        // Longer than the remembered offset but a different file: only the head fingerprint tells.
        let long: Vec<String> = std::iter::once(r#"{"type":"user","message":{"content":"a different first line"}}"#.to_string())
            .chain(std::iter::repeat_with(|| usage(10)).take(40))
            .chain([usage(250_000)])
            .collect();
        std::fs::write(f.path(), long.join("
") + "
").unwrap();
        assert_eq!(note_for_transcript(f.path()), full_note(f.path()));
        assert_eq!(note_for_transcript(f.path()), None, "still never opted in");
    }

    #[test]
    fn a_half_written_last_line_is_left_for_the_next_read() {
        let f = transcript(&[OPT_IN]);
        let half = usage(250_000);
        let mut raw = std::fs::OpenOptions::new().append(true).open(f.path()).unwrap();
        write!(raw, "{}", &half[..half.len() - 10]).unwrap();
        assert_eq!(note_for_transcript(f.path()), None);
        write!(raw, "{}
", &half[half.len() - 10..]).unwrap();
        assert_eq!(note_for_transcript(f.path()), full_note(f.path()));
        assert!(note_for_transcript(f.path()).is_some());
    }

    #[test]
    fn the_opt_in_and_the_cursor_survive_a_daemon_restart() {
        let dir = tempfile::tempdir().unwrap();
        let f = transcript(&[OPT_IN, &usage(10_000)]);
        let key = "restart-session";
        let note = |f: &tempfile::NamedTempFile| view_of(f.path(), key, Some(dir.path())).and_then(|v| note_for_view(&v));
        assert_eq!(note(&f), None);
        CURSORS.forget_memory();
        append(f.path(), &usage(210_000));
        assert!(note(&f).expect("opt-in remembered across the restart").contains("210k"));
        assert_eq!(note(&f), full_note(f.path()));
    }

    #[test]
    fn a_chat_that_never_opted_in_is_answered_without_scoring_its_occupancy() {
        let f = transcript(&[&usage(900_000)]);
        let v = view_of(f.path(), "never-opted", None).unwrap();
        assert!(!v.opted);
        assert_eq!(note_for_view(&v), None);
    }

    #[test]
    fn a_compaction_marker_changes_the_count_a_rider_keys_on() {
        let f = transcript(&[OPT_IN]);
        let before = view_of(f.path(), "compaction-count", None).unwrap().epoch;
        append(f.path(), r#"{"type":"system","subtype":"compact_boundary","compactMetadata":{"preTokens":900000}}"#);
        append(f.path(), r#"{"type":"user","message":{"content":"mentions compact_boundary in prose"}}"#);
        let after = view_of(f.path(), "compaction-count", None).unwrap().epoch;
        assert_eq!(after, before + 1, "a line that merely mentions the word is not a marker");
    }
}
