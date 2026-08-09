//! JSONL replay: read a claude session transcript file, emit ChatEvents.
//! Used by both the History view (read-only) and the Sessions view's reopen
//! path (replay before live attach).

use crate::chat::parser::parse_line;
use crate::types::chat::{ChatEvent, ContentBlock, HistoryPage};
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::Path;

/// Chars kept inline before a `ToolResult`'s text output defers behind
/// `load_event_detail`. Only `read_page` (paginated Sessions open) applies
/// this - `replay` (History view) and live events stay untouched.
const TOOL_RESULT_PREVIEW_CHARS: usize = 4000;

/// If `ev`'s output text exceeds the preview cap, replace it with a
/// truncated copy carrying `output_truncated` + `full_seq` (this line's own
/// byte offset, reused as `load_event_detail`'s lookup key). No-op for
/// anything else (image output, short results, non-ToolResult events).
fn truncate_tool_result(ev: ChatEvent, line_offset: u64) -> ChatEvent {
    match ev {
        ChatEvent::ToolResult { tool_use_id, output: ContentBlock::Text { text }, is_error, timestamp, .. }
            if text.len() > TOOL_RESULT_PREVIEW_CHARS =>
        {
            // Truncate on a char boundary: text.len() is byte length, but we
            // want a UTF-8-safe char count, not a mid-codepoint byte slice.
            let preview: String = text.chars().take(TOOL_RESULT_PREVIEW_CHARS).collect();
            ChatEvent::ToolResult {
                tool_use_id,
                output: ContentBlock::Text { text: format!("{preview}…") },
                is_error,
                timestamp,
                output_truncated: true,
                full_seq: Some(line_offset),
            }
        }
        other => other,
    }
}

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

pub fn replay(path: &Path) -> Result<Vec<ChatEvent>, String> {
    let f = File::open(path).map_err(|e| format!("open {}: {}", path.display(), e))?;
    let reader = BufReader::new(f);
    let mut events = Vec::new();
    for line in reader.lines() {
        let line = line.map_err(|e| e.to_string())?;
        if line.trim().is_empty() {
            continue;
        }
        events.extend(parse_line(&line));
    }
    Ok(events)
}

/// Returns true for events that count toward `message_limit`. We count only
/// AssistantMessage events: a "page size" of N means N assistant replies plus
/// every surrounding event (UserMessage, ToolUse, ToolResult, TurnUsage,
/// Notification) that lives between them. This biases pagination toward
/// "show me the last N AI turns" rather than letting long stretches of
/// tool-only output exhaust the budget.
fn is_message_event(ev: &ChatEvent) -> bool {
    matches!(ev, ChatEvent::AssistantMessage { .. })
}

/// Read a paginated window of the JSONL transcript at `path` by tail-reading
/// from EOF backward in 64KB chunks until `message_limit` message-class
/// events have been parsed (or the file start is reached). First-page time
/// is O(20 messages of bytes) regardless of total file size.
///
/// `seq` values are *byte offsets* of line starts. Frontend treats them as
/// opaque monotonic ids: pass the previous page's `oldest_seq` as
/// `before_seq` to fetch the page above it.
///
/// - `before_seq = None` → tail-read from EOF.
/// - `before_seq = Some(off)` → tail-read from byte offset `off` (exclusive).
/// - `message_limit` counts only `UserMessage` / `AssistantMessage` events.
///   Tool calls, results, notifications, session boundaries, and turn-usage
///   records ride along but do not count toward the limit.
///
/// Orphan tool_results: a page may contain a `ToolResult` whose matching
/// `ToolUse` lives below `oldest_seq`. The renderer tolerates this.
pub fn read_page(
    path: &Path,
    before_seq: Option<u64>,
    message_limit: u32,
) -> Result<HistoryPage, String> {
    if message_limit == 0 || matches!(before_seq, Some(0)) {
        return Ok(empty_page());
    }

    let mut f = File::open(path).map_err(|e| format!("open {}: {}", path.display(), e))?;
    let file_len = f
        .metadata()
        .map_err(|e| e.to_string())?
        .len();
    let upper: u64 = before_seq.unwrap_or(file_len).min(file_len);
    if upper == 0 {
        return Ok(empty_page());
    }

    const CHUNK: usize = 64 * 1024;
    let mut tail_buf: Vec<u8> = Vec::with_capacity(CHUNK * 2);
    let mut window_start: u64 = upper;
    let mut events: Vec<(u64, ChatEvent)> = Vec::new();
    let mut messages: u32 = 0;
    let mut reached_start = false;

    loop {
        let need_more = window_start > 0
            && tail_buf
                .iter()
                .rposition(|&b| b == b'\n')
                .is_none();
        if need_more {
            let read_size = std::cmp::min(CHUNK as u64, window_start) as usize;
            let read_start = window_start - read_size as u64;
            f.seek(SeekFrom::Start(read_start)).map_err(|e| e.to_string())?;
            let mut chunk = vec![0u8; read_size];
            f.read_exact(&mut chunk).map_err(|e| e.to_string())?;
            chunk.extend_from_slice(&tail_buf);
            tail_buf = chunk;
            window_start = read_start;
        }

        let newline_pos = tail_buf.iter().rposition(|&b| b == b'\n');
        let line_start_in_buf: usize = match newline_pos {
            Some(pos) => pos + 1,
            None => {
                if window_start == 0 {
                    reached_start = true;
                    0
                } else {
                    // Buffer has no newline yet and we haven't reached file
                    // start — the next iteration will fetch more bytes.
                    continue;
                }
            }
        };

        let mut line_bytes = &tail_buf[line_start_in_buf..];
        if line_bytes.last() == Some(&b'\n') {
            line_bytes = &line_bytes[..line_bytes.len() - 1];
        }
        if line_bytes.last() == Some(&b'\r') {
            line_bytes = &line_bytes[..line_bytes.len() - 1];
        }

        let line_offset = window_start + line_start_in_buf as u64;
        let s = std::str::from_utf8(line_bytes).unwrap_or("");
        if !s.trim().is_empty() {
            for ev in parse_line(s) {
                let is_msg = is_message_event(&ev);
                events.push((line_offset, truncate_tool_result(ev, line_offset)));
                if is_msg {
                    messages += 1;
                }
            }
        }

        match newline_pos {
            Some(pos) => tail_buf.truncate(pos),
            None => tail_buf.clear(),
        }

        if messages >= message_limit {
            break;
        }
        if reached_start && tail_buf.is_empty() {
            break;
        }
    }

    events.reverse();
    let oldest_seq = events.first().map(|(o, _)| *o).unwrap_or(0);
    let newest_seq = events.last().map(|(o, _)| *o).unwrap_or(0);
    let has_more = oldest_seq > 0 && !events.is_empty();
    let evs: Vec<ChatEvent> = events.into_iter().map(|(_, e)| e).collect();
    Ok(HistoryPage {
        events: evs,
        oldest_seq,
        newest_seq,
        has_more,
    })
}

fn empty_page() -> HistoryPage {
    HistoryPage {
        events: Vec::new(),
        oldest_seq: 0,
        newest_seq: 0,
        has_more: false,
    }
}

/// Read the untruncated `ToolResult` for `tool_use_id` at byte offset `seq`
/// (the `full_seq` a preview carried). Matched by id, not "first on the
/// line" - a line can hold more than one tool_result.
pub fn read_single_event(path: &Path, seq: u64, tool_use_id: &str) -> Result<ChatEvent, String> {
    let mut f = File::open(path).map_err(|e| format!("open {}: {}", path.display(), e))?;
    let file_len = f.metadata().map_err(|e| e.to_string())?.len();
    if seq >= file_len {
        return Err(format!("seq {seq} past end of file"));
    }
    f.seek(SeekFrom::Start(seq)).map_err(|e| e.to_string())?;
    let mut line = String::new();
    BufReader::new(f)
        .read_line(&mut line)
        .map_err(|e| e.to_string())?;
    for ev in parse_line(line.trim_end()) {
        if let ChatEvent::ToolResult { tool_use_id: id, .. } = &ev {
            if id == tool_use_id {
                return Ok(ev);
            }
        }
    }
    Err(format!("no tool_result {tool_use_id} at seq {seq}"))
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

    fn write_jsonl(path: &Path, lines: &[&str]) {
        let mut f = File::create(path).unwrap();
        for l in lines {
            writeln!(f, "{}", l).unwrap();
        }
    }

    fn user_line(text: &str, ts: i64) -> String {
        format!(
            r#"{{"type":"user","message":{{"role":"user","content":{:?}}},"timestamp":{}}}"#,
            text, ts
        )
    }

    fn assistant_line(text: &str, ts: i64) -> String {
        format!(
            r#"{{"type":"assistant","message":{{"role":"assistant","content":{:?}}},"timestamp":{}}}"#,
            text, ts
        )
    }

    fn tool_use_line(id: &str, ts: i64) -> String {
        format!(
            r#"{{"type":"tool_use","id":{:?},"name":"X","input":{{}},"timestamp":{}}}"#,
            id, ts
        )
    }

    fn tool_result_line(tool_use_id: &str, ts: i64) -> String {
        format!(
            r#"{{"type":"tool_result","tool_use_id":{:?},"content":"ok","is_error":false,"timestamp":{}}}"#,
            tool_use_id, ts
        )
    }

    fn count_messages(events: &[ChatEvent]) -> usize {
        events
            .iter()
            .filter(|e| matches!(e, ChatEvent::AssistantMessage { .. }))
            .count()
    }

    #[test]
    fn read_page_last_n_messages() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.jsonl");
        let mut lines: Vec<String> = Vec::new();
        for i in 0..30 {
            lines.push(user_line(&format!("u{}", i), i as i64 * 2));
            lines.push(assistant_line(&format!("a{}", i), i as i64 * 2 + 1));
        }
        let refs: Vec<&str> = lines.iter().map(|s| s.as_str()).collect();
        write_jsonl(&p, &refs);
        let page = read_page(&p, None, 20).unwrap();
        assert_eq!(count_messages(&page.events), 20);
        assert!(page.oldest_seq > 0);
        assert!(page.has_more);
    }

    #[test]
    fn read_page_non_message_events_dont_count() {
        // Only AssistantMessage events count toward message_limit. UserMessage,
        // ToolUse, ToolResult ride along but don't count.
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("b.jsonl");
        let mut lines: Vec<String> = Vec::new();
        for i in 0..5 {
            lines.push(user_line(&format!("u{}", i), i as i64));
            lines.push(tool_use_line(&format!("t{}", i), i as i64));
            lines.push(tool_result_line(&format!("t{}", i), i as i64));
            lines.push(assistant_line(&format!("a{}", i), i as i64));
        }
        let refs: Vec<&str> = lines.iter().map(|s| s.as_str()).collect();
        write_jsonl(&p, &refs);
        // Ask for more assistants than exist (10 vs 5) so the walk runs out
        // of file before hitting the limit; window covers everything.
        let page = read_page(&p, None, 10).unwrap();
        assert_eq!(page.oldest_seq, 0);
        assert!(!page.has_more);
        assert_eq!(count_messages(&page.events), 5);
        assert_eq!(page.events.len(), 20);
    }

    #[test]
    fn read_page_before_seq_returns_disjoint() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("c.jsonl");
        let mut lines: Vec<String> = Vec::new();
        for i in 0..40 {
            lines.push(user_line(&format!("u{}", i), i as i64 * 2));
            lines.push(assistant_line(&format!("a{}", i), i as i64 * 2 + 1));
        }
        let refs: Vec<&str> = lines.iter().map(|s| s.as_str()).collect();
        write_jsonl(&p, &refs);
        let p1 = read_page(&p, None, 20).unwrap();
        let p2 = read_page(&p, Some(p1.oldest_seq), 20).unwrap();
        // Page 2 ends strictly before page 1 begins.
        assert!(p2.newest_seq < p1.oldest_seq);
        assert_eq!(count_messages(&p2.events), 20);
        assert!(p2.has_more);
    }

    #[test]
    fn read_page_walks_to_start() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("d.jsonl");
        let mut lines: Vec<String> = Vec::new();
        for i in 0..15 {
            lines.push(assistant_line(&format!("a{}", i), i as i64));
        }
        let refs: Vec<&str> = lines.iter().map(|s| s.as_str()).collect();
        write_jsonl(&p, &refs);
        let p1 = read_page(&p, None, 10).unwrap();
        let p2 = read_page(&p, Some(p1.oldest_seq), 10).unwrap();
        assert!(!p2.has_more);
        assert_eq!(count_messages(&p1.events) + count_messages(&p2.events), 15);
    }

    #[test]
    fn read_page_orphan_tool_result_passes_through() {
        // Walk back limit=1 AssistantMessage, capture surrounding events.
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("e.jsonl");
        let lines = vec![
            tool_use_line("t1", 0),
            user_line("u0", 1),
            tool_result_line("t1", 2),
            assistant_line("a0", 3),
        ];
        let refs: Vec<&str> = lines.iter().map(|s| s.as_str()).collect();
        write_jsonl(&p, &refs);
        let page = read_page(&p, None, 1).unwrap();
        // Walk back from EOF: assistant (count=1, stop). Slice = just the
        // assistant. Earlier tool_use/user/tool_result are excluded.
        assert_eq!(count_messages(&page.events), 1);
        assert!(matches!(page.events[0], ChatEvent::AssistantMessage { .. }));
        assert!(page.has_more);
    }

    #[test]
    fn read_page_before_seq_zero_empty() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("f.jsonl");
        write_jsonl(&p, &[&user_line("u0", 0)]);
        let page = read_page(&p, Some(0), 20).unwrap();
        assert_eq!(page.events.len(), 0);
        assert!(!page.has_more);
        assert_eq!(page.oldest_seq, 0);
        assert_eq!(page.newest_seq, 0);
    }

    #[test]
    fn read_page_handles_lines_spanning_chunk_boundary() {
        // Build a transcript where some lines are larger than the 64KB read
        // chunk to verify the tail-read buffer correctly grows when the
        // newest line spans more than one chunk's worth of bytes.
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("big.jsonl");
        let big_text = "x".repeat(80 * 1024);
        let lines = vec![
            user_line("first", 0),
            assistant_line(&big_text, 1),
            user_line("after-big", 2),
        ];
        let refs: Vec<&str> = lines.iter().map(|s| s.as_str()).collect();
        write_jsonl(&p, &refs);
        // 1 assistant in fixture; ask for 2 to force the walk past it,
        // running into the file start. All 3 events returned.
        let page = read_page(&p, None, 2).unwrap();
        assert_eq!(count_messages(&page.events), 1);
        assert_eq!(page.events.len(), 3);
        assert!(!page.has_more);
        let assistant = page.events.iter().find_map(|e| match e {
            ChatEvent::AssistantMessage { content, .. } => match &content[0] {
                crate::types::chat::ContentBlock::Text { text } => Some(text.len()),
                _ => None,
            },
            _ => None,
        });
        assert_eq!(assistant, Some(80 * 1024));
    }

    fn tool_result_line_with(tool_use_id: &str, ts: i64, content: &str) -> String {
        format!(
            r#"{{"type":"tool_result","tool_use_id":{:?},"content":{:?},"is_error":false,"timestamp":{}}}"#,
            tool_use_id, content, ts
        )
    }

    #[test]
    fn read_page_truncates_large_tool_result_and_tags_full_seq() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("g.jsonl");
        let big_output = "x".repeat(TOOL_RESULT_PREVIEW_CHARS + 5000);
        let lines = vec![
            user_line("u0", 0),
            tool_use_line("t1", 1),
            tool_result_line_with("t1", 2, &big_output),
            assistant_line("a0", 3),
        ];
        let refs: Vec<&str> = lines.iter().map(|s| s.as_str()).collect();
        write_jsonl(&p, &refs);
        // Backward walk processes the LAST line first and stops as soon as it
        // has message_limit assistants - ask for more than the 1 present so it
        // walks all the way to file start and the earlier tool_result is included
        // (same trick as read_page_non_message_events_dont_count).
        let page = read_page(&p, None, 5).unwrap();
        let tr = page.events.iter().find_map(|e| match e {
            ChatEvent::ToolResult { output_truncated, full_seq, output, .. } => {
                Some((*output_truncated, *full_seq, output.clone()))
            }
            _ => None,
        });
        let (truncated, full_seq, output) = tr.expect("tool_result present");
        assert!(truncated);
        assert!(full_seq.is_some());
        match output {
            ContentBlock::Text { text } => assert_eq!(text.chars().count(), TOOL_RESULT_PREVIEW_CHARS + 1), // preview + "…"
            _ => panic!("expected text output"),
        }
        // The untruncated content is recoverable from the tagged offset.
        let full = read_single_event(&p, full_seq.unwrap(), "t1").unwrap();
        match full {
            ChatEvent::ToolResult { output_truncated, output: ContentBlock::Text { text }, .. } => {
                assert!(!output_truncated);
                assert_eq!(text, big_output);
            }
            _ => panic!("expected untruncated tool_result"),
        }
    }

    #[test]
    fn read_page_leaves_small_tool_result_untouched() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("h.jsonl");
        let lines = vec![tool_use_line("t1", 0), tool_result_line("t1", 1), assistant_line("a0", 2)];
        let refs: Vec<&str> = lines.iter().map(|s| s.as_str()).collect();
        write_jsonl(&p, &refs);
        let page = read_page(&p, None, 5).unwrap();
        let tr = page.events.iter().find_map(|e| match e {
            ChatEvent::ToolResult { output_truncated, full_seq, .. } => Some((*output_truncated, *full_seq)),
            _ => None,
        });
        assert_eq!(tr, Some((false, None)));
    }

    #[test]
    fn read_single_event_errors_on_wrong_tool_use_id() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("i.jsonl");
        write_jsonl(&p, &[&tool_result_line("t1", 0)]);
        let err = read_single_event(&p, 0, "not-t1").unwrap_err();
        assert!(err.contains("not-t1"), "err was: {err}");
    }
}
