//! JSONL replay: read a claude session transcript file, emit ChatEvents.
//! Used by both the History view (read-only) and the Sessions view's reopen
//! path (replay before live attach). Pagination lives in `history_page`.

use crate::types::chat::ChatEvent;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::Path;

pub use crate::chat::history_page::{read_page, read_single_event};

/// Resolve the JSONL transcript path for `session_id`.
///
/// Claude CLI writes transcripts to
/// `~/.claude/projects/<encoded-cwd>/<session_id>.jsonl`. When `cwd` is known
/// (Sessions view passes it from the Instance entry), use
/// `tokens::transcript_for_session` directly; otherwise (History view, where
/// cwd isn't carried on `HistoryEntry`) fall back to scanning every project
/// dir for a matching `<session_id>.jsonl`. Falls through on cwd miss because
/// the encoded dir may not match exactly (case differences on Windows,
/// junctions, etc.).
pub fn locate_transcript(session_id: &str, cwd: Option<&str>) -> Result<std::path::PathBuf, String> {
    let projects = crate::tokens::claude_projects_dir().ok_or("no home dir")?;
    locate_transcript_in(&projects, session_id, cwd)
}

/// Inner form of [`locate_transcript`] that takes the `~/.claude/projects`
/// dir explicitly. Split out so tests can point at a tempdir without
/// monkey-patching `dirs::home_dir` (which on Windows reads the OS user
/// profile, not `USERPROFILE` / `HOME` env vars).
fn locate_transcript_in(
    projects: &std::path::Path,
    session_id: &str,
    cwd: Option<&str>,
) -> Result<std::path::PathBuf, String> {
    if let Some(cwd_str) = cwd.filter(|s| !s.is_empty()) {
        let candidate = projects
            .join(crate::tokens::encode_cwd_as_project_dir(std::path::Path::new(cwd_str)))
            .join(format!("{session_id}.jsonl"));
        if candidate.exists() {
            return Ok(candidate);
        }
        // Fall through to scan: cwd path may not match the encoded dir
        // exactly (case differences on Windows, junctions, etc.).
    }
    let entries = std::fs::read_dir(projects)
        .map_err(|_| format!("no transcript found for session {session_id}"))?;
    for entry in entries.flatten() {
        let candidate = entry.path().join(format!("{session_id}.jsonl"));
        if candidate.exists() {
            return Ok(candidate);
        }
    }
    Err(format!("no transcript found for session {session_id}"))
}

/// [`read_page`] addressed by session id, tagging the page that exhausts the
/// file with the predecessor it continues from. The cursor stays per-file:
/// `oldest_seq` is a byte offset, so a chained page is fetched by re-calling
/// this with the `continues_from` id and no `before_seq`.
pub fn read_page_for_session(
    session_id: &str,
    cwd: Option<&str>,
    before_seq: Option<u64>,
    message_limit: u32,
) -> Result<crate::types::chat::HistoryPage, String> {
    let path = locate_transcript(session_id, cwd)?;
    let mut page = read_page(&path, before_seq, message_limit)?;
    if !page.has_more {
        page.continues_from = crate::sessions::chat_config::predecessor_of(session_id);
    }
    Ok(page)
}

pub fn replay(path: &Path) -> Result<Vec<ChatEvent>, String> {
    let f = File::open(path).map_err(|e| format!("open {}: {}", path.display(), e))?;
    let reader = BufReader::new(f);
    let mut events = Vec::new();
    for line in reader.lines() {
        let line = line.map_err(|e| e.to_string())?;
        if line.trim().is_empty() {
            continue;
        }
        events.extend(crate::chat::parser::parse_line(&line));
    }
    Ok(events)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::chat::ContentBlock;
    use std::io::Write;

    #[test]
    fn locate_transcript_finds_via_cwd() {
        let tmp = tempfile::tempdir().unwrap();
        let projects = tmp.path();

        // The cwd we pass; its encoded form is what claude CLI uses for the
        // per-project subdir under `~/.claude/projects/`.
        let cwd = tmp.path().join("my").join("project");
        std::fs::create_dir_all(&cwd).unwrap();
        let encoded = crate::tokens::encode_cwd_as_project_dir(&cwd);
        let proj_dir = projects.join(&encoded);
        std::fs::create_dir_all(&proj_dir).unwrap();
        let session_id = "abc-123";
        let transcript = proj_dir.join(format!("{session_id}.jsonl"));
        std::fs::write(&transcript, "").unwrap();

        let cwd_str = cwd.to_string_lossy().into_owned();
        let found = locate_transcript_in(projects, session_id, Some(cwd_str.as_str())).unwrap();
        assert_eq!(found, transcript);
    }

    #[test]
    fn locate_transcript_falls_back_to_scan() {
        let tmp = tempfile::tempdir().unwrap();
        let projects = tmp.path();

        // Build a project dir whose encoded name has nothing to do with the
        // cwd we pass in, forcing the fallback scan to find it.
        let bogus_proj = projects.join("some-other-proj");
        std::fs::create_dir_all(&bogus_proj).unwrap();
        let session_id = "scan-me-999";
        let transcript = bogus_proj.join(format!("{session_id}.jsonl"));
        std::fs::write(&transcript, "").unwrap();

        // cwd = None: no shortcut, fallback runs.
        let found = locate_transcript_in(projects, session_id, None).unwrap();
        assert_eq!(found, transcript);

        // cwd = mismatched real path: shortcut misses, fallback finds it.
        let mismatched = tmp.path().join("not").join("real");
        let cwd_str = mismatched.to_string_lossy().into_owned();
        let found2 = locate_transcript_in(projects, session_id, Some(cwd_str.as_str())).unwrap();
        assert_eq!(found2, transcript);
    }

    #[test]
    fn locate_transcript_errors_when_not_found() {
        let tmp = tempfile::tempdir().unwrap();
        let projects = tmp.path();
        // Project dir exists but no matching transcripts inside.
        std::fs::create_dir_all(projects.join("empty")).unwrap();

        let err = locate_transcript_in(projects, "nonexistent-session", None).unwrap_err();
        assert!(err.contains("nonexistent-session"), "err was: {err}");
    }

    #[test]
    fn replays_jsonl_file() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("t.jsonl");
        let mut f = File::create(&p).unwrap();
        writeln!(
            f,
            r#"{{"type":"user","message":{{"role":"user","content":"hi"}},"timestamp":1}}"#
        )
        .unwrap();
        writeln!(
            f,
            r#"{{"type":"assistant","message":{{"role":"assistant","content":"hello"}},"timestamp":2}}"#
        )
        .unwrap();
        let events = replay(&p).unwrap();
        assert_eq!(events.len(), 2);
        match &events[0] {
            ChatEvent::UserMessage { content, .. } => match &content[0] {
                ContentBlock::Text { text } => assert_eq!(text, "hi"),
                _ => panic!("expected text block"),
            },
            _ => panic!("expected UserMessage"),
        }
    }

    #[test]
    fn replay_ignores_blank_lines() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("blank.jsonl");
        let mut f = File::create(&p).unwrap();
        writeln!(f).unwrap();
        writeln!(f, "   ").unwrap();
        writeln!(
            f,
            r#"{{"type":"user","message":{{"role":"user","content":"x"}},"timestamp":1}}"#
        )
        .unwrap();
        writeln!(f).unwrap();
        let events = replay(&p).unwrap();
        assert_eq!(events.len(), 1);
    }

    #[test]
    fn replay_skips_unrecognized_lines() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("garbage.jsonl");
        let mut f = File::create(&p).unwrap();
        writeln!(f, "not json at all").unwrap();
        writeln!(f, r#"{{"type":"unknown_variant","x":1}}"#).unwrap();
        writeln!(
            f,
            r#"{{"type":"user","message":{{"role":"user","content":"keepme"}},"timestamp":1}}"#
        )
        .unwrap();
        let events = replay(&p).unwrap();
        assert_eq!(events.len(), 1);
    }

    #[test]
    fn replay_returns_err_on_missing_file() {
        let r = replay(Path::new("/this/file/does/not/exist.jsonl"));
        assert!(r.is_err());
    }
}
