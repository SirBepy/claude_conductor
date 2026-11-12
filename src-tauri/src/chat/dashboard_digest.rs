//! The chat dashboard's view of a whole transcript (docs/chat-dashboard-design.md,
//! docs/forever-chat-plan.md B2). A chat window loads only its newest history
//! page, but the dashboard's durable cards (Answers, Plan, Waiting on you) must
//! not lose an old answer, plan or open question once it scrolls past that
//! page. This keeps, from the transcript lines before the loaded page, only the
//! events those cards are built from, so the window can rebuild their rows
//! with its own renderer code without loading every event.
//!
//! What is kept (the rest of a transcript is assistant prose, thinking and
//! ordinary tool calls, which no durable card reads):
//! - every user line (Joe's messages, relays, question answers), with a large
//!   pasted image elided the way `read_page` elides a screenshot result;
//! - notifications and compaction boundaries (both count as row boundaries);
//! - the top-level Conductor tool calls some card reads (see `CARD_TOOLS`) and
//!   their results; the others (previews, mockups, the browser) carry large
//!   inputs or results no card reads;
//! - the builtin AskUserQuestion (older transcripts) and its result;
//! - edit tools' calls with only their path, for the Links and files card.
//!
//! The scan is forward and cached per transcript by the byte offset it reached
//! (transcripts are append-only), so a window that opens the same chat again
//! only parses what was written since.

use crate::chat::history_page::{truncate_tool_result, IMAGE_INLINE_MAX_B64};
use crate::chat::parser::parse_line;
use crate::types::chat::{ChatEvent, ContentBlock};
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// The Conductor tools a dashboard card reads a row of: messages and their
/// revisions, questions, plans, turn ends, drafts, and the hand-offs the
/// Answers card pairs with their answers.
const CARD_TOOLS: [&str; 9] = [
    "send_message",
    "update_message",
    "ask_user_question",
    "write_plan",
    "report_turn_status",
    "write_draft",
    "pr_preview",
    "spawn_chat",
    "subchat",
];
const CONDUCTOR_PREFIX: &str = "mcp__cc_conductor__";
const BUILTIN_ASK: &str = "AskUserQuestion";
const EDIT_TOOLS: [&str; 4] = ["Edit", "Write", "MultiEdit", "NotebookEdit"];
/// Transcripts whose scan stays cached. A window holds one chat at a time, so a
/// few cover switching back and forth; the oldest entry goes first.
const CACHE_MAX: usize = 8;

/// One transcript's scan so far: the kept events with the byte offset of the
/// line each came from, and where the next scan resumes.
#[derive(Default)]
struct Scan {
    scanned: u64,
    events: Vec<(u64, ChatEvent)>,
    kept_ids: HashSet<String>,
    /// The cache clock at this scan's last use: the lowest is evicted first.
    used: u64,
}

static CACHE: Mutex<Option<(u64, HashMap<PathBuf, Scan>)>> = Mutex::new(None);

/// A tool call the durable cards read, judged by name alone.
fn kept_tool(name: &str) -> bool {
    name == BUILTIN_ASK || name.strip_prefix(CONDUCTOR_PREFIX).is_some_and(|t| CARD_TOOLS.contains(&t))
}

/// The event as the digest keeps it, or None when no durable card reads it.
fn keep(ev: ChatEvent, offset: u64, kept_ids: &mut HashSet<String>) -> Option<ChatEvent> {
    match ev {
        ChatEvent::UserMessage { content, timestamp, remote_echo, is_meta, author_session_id } => {
            let content = content
                .into_iter()
                .map(|b| match b {
                    ContentBlock::Image { mime, data } if data.len() > IMAGE_INLINE_MAX_B64 => {
                        ContentBlock::Image { mime, data: String::new() }
                    }
                    other => other,
                })
                .collect();
            Some(ChatEvent::UserMessage { content, timestamp, remote_echo, is_meta, author_session_id })
        }
        ChatEvent::Notification { .. } | ChatEvent::Compacted { .. } => Some(ev),
        ChatEvent::ToolUse { tool_name, input, id, timestamp, parent_tool_use_id } => {
            if parent_tool_use_id.is_some() {
                return None;
            }
            if kept_tool(&tool_name) {
                kept_ids.insert(id.clone());
                return Some(ChatEvent::ToolUse { tool_name, input, id, timestamp, parent_tool_use_id });
            }
            if EDIT_TOOLS.contains(&tool_name.as_str()) {
                // Only the path: Write's content and Edit's strings can be large.
                let mut slim = serde_json::Map::new();
                for key in ["file_path", "notebook_path"] {
                    if let Some(v) = input.get(key) {
                        slim.insert(key.to_string(), v.clone());
                    }
                }
                return Some(ChatEvent::ToolUse {
                    tool_name,
                    input: serde_json::Value::Object(slim),
                    id,
                    timestamp,
                    parent_tool_use_id,
                });
            }
            None
        }
        ChatEvent::ToolResult { ref tool_use_id, .. } if kept_ids.contains(tool_use_id) => {
            Some(truncate_tool_result(ev, offset))
        }
        _ => None,
    }
}

fn is_blank_user(ev: &ChatEvent) -> bool {
    matches!(ev, ChatEvent::UserMessage { content, .. } if content.is_empty())
}

/// Parse the complete lines from `scan.scanned` on and keep what the cards read.
/// A trailing line still being written is left for the next call.
fn advance(path: &Path, scan: &mut Scan) -> Result<(), String> {
    let mut f = File::open(path).map_err(|e| format!("open {}: {}", path.display(), e))?;
    let len = f.metadata().map_err(|e| e.to_string())?.len();
    if len < scan.scanned {
        // Shorter than what was read: not the file the scan saw. Start over.
        *scan = Scan::default();
    }
    if len == scan.scanned {
        return Ok(());
    }
    f.seek(SeekFrom::Start(scan.scanned)).map_err(|e| e.to_string())?;
    let mut reader = BufReader::new(f);
    let mut offset = scan.scanned;
    let mut bytes = Vec::new();
    loop {
        bytes.clear();
        let n = reader.read_until(b'\n', &mut bytes).map_err(|e| e.to_string())?;
        if n == 0 || bytes.last() != Some(&b'\n') {
            break;
        }
        // A line that is not UTF-8 parses to nothing, as in `read_page`, and
        // never stops the scan of the lines after it.
        let line = std::str::from_utf8(&bytes).unwrap_or("");
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if !trimmed.trim().is_empty() {
            let kept: Vec<ChatEvent> = parse_line(trimmed)
                .into_iter()
                .filter_map(|ev| keep(ev, offset, &mut scan.kept_ids))
                .collect();
            // Every tool result's line also parses to a user message with no
            // blocks, which the renderer ignores. Only one that sits beside a
            // kept result stays, so the replay sees that line as it was.
            if kept.iter().any(|e| !is_blank_user(e)) {
                scan.events.extend(kept.into_iter().map(|e| (offset, e)));
            }
        }
        offset += n as u64;
    }
    scan.scanned = offset;
    Ok(())
}

/// The kept events of every line that starts before `before_seq` (a history
/// page's `oldest_seq`), oldest first; every line when it is None.
pub fn read_digest(path: &Path, before_seq: Option<u64>) -> Result<Vec<ChatEvent>, String> {
    // The scan leaves the cache for the file read, so a first scan of a long
    // transcript never holds up another chat's digest. Two windows on the same
    // chat at once each scan, and the later one is kept.
    let (mut scan, now) = {
        let mut guard = CACHE.lock().unwrap_or_else(|p| p.into_inner());
        let (clock, scans) = guard.get_or_insert_with(|| (0, HashMap::new()));
        *clock += 1;
        (scans.remove(path).unwrap_or_default(), *clock)
    };
    advance(path, &mut scan)?;
    // After the scan: one that started over for a shorter file reset it.
    scan.used = now;
    let upper = before_seq.unwrap_or(u64::MAX);
    let out = scan.events.iter().filter(|(o, _)| *o < upper).map(|(_, e)| e.clone()).collect();
    let mut guard = CACHE.lock().unwrap_or_else(|p| p.into_inner());
    let (_, scans) = guard.get_or_insert_with(|| (0, HashMap::new()));
    if !scans.contains_key(path) && scans.len() >= CACHE_MAX {
        if let Some(oldest) = scans.iter().min_by_key(|(_, s)| s.used).map(|(p, _)| p.clone()) {
            scans.remove(&oldest);
        }
    }
    scans.insert(path.to_path_buf(), scan);
    Ok(out)
}

/// [`read_digest`] addressed by session id, with the predecessor a `/respawn`
/// successor continues from, so the window can go on into that chat's digest.
pub fn read_digest_for_session(
    session_id: &str,
    cwd: Option<&str>,
    before_seq: Option<u64>,
) -> Result<serde_json::Value, String> {
    let path = crate::chat::history::locate_transcript(session_id, cwd)?;
    let events = read_digest(&path, before_seq)?;
    Ok(serde_json::json!({
        "events": events,
        "continues_from": crate::sessions::chat_config::predecessor_of(session_id),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn line(v: serde_json::Value) -> String {
        v.to_string()
    }

    fn user(text: &str) -> String {
        line(serde_json::json!({"type":"user","message":{"role":"user","content":text},"timestamp":"2026-11-12T10:00:00Z"}))
    }

    fn assistant_tool(name: &str, id: &str, input: serde_json::Value) -> String {
        line(serde_json::json!({"type":"assistant","message":{"role":"assistant","content":[
            {"type":"text","text":"working on it"},
            {"type":"tool_use","id":id,"name":name,"input":input}
        ]},"timestamp":"2026-11-12T10:00:01Z"}))
    }

    fn result(id: &str, text: &str) -> String {
        line(serde_json::json!({"type":"user","message":{"role":"user","content":[
            {"type":"tool_result","tool_use_id":id,"content":text,"is_error":false}
        ]},"timestamp":"2026-11-12T10:00:02Z"}))
    }

    fn write(path: &Path, lines: &[String]) {
        let mut f = File::create(path).unwrap();
        for l in lines {
            writeln!(f, "{l}").unwrap();
        }
    }

    fn names(evs: &[ChatEvent]) -> Vec<String> {
        evs.iter()
            .map(|e| match e {
                ChatEvent::UserMessage { .. } => "user".to_string(),
                ChatEvent::AssistantMessage { .. } => "assistant".to_string(),
                ChatEvent::ToolUse { tool_name, .. } => format!("use:{tool_name}"),
                ChatEvent::ToolResult { tool_use_id, .. } => format!("result:{tool_use_id}"),
                other => format!("{other:?}"),
            })
            .collect()
    }

    #[test]
    fn keeps_only_what_the_durable_cards_read() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("t.jsonl");
        write(&p, &[
            user("fix the footer"),
            assistant_tool("Read", "r1", serde_json::json!({"file_path":"a.ts"})),
            result("r1", "file body"),
            assistant_tool("mcp__cc_conductor__write_plan", "p1", serde_json::json!({"steps":[]})),
            result("p1", "{\"ok\":true}"),
            assistant_tool("mcp__cc_conductor__browser_take_screenshot", "b1", serde_json::json!({})),
            result("b1", "png"),
            assistant_tool("mcp__cc_conductor__show_preview", "v1", serde_json::json!({"html":"<p>big</p>"})),
            result("v1", "{\"ok\":true}"),
            assistant_tool("Write", "w1", serde_json::json!({"file_path":"b.ts","content":"x".repeat(10_000)})),
            result("w1", "written"),
            assistant_tool("mcp__cc_conductor__send_message", "m1", serde_json::json!({"kind":"answer","text":"Yes"})),
            result("m1", "{\"ok\":true}"),
        ]);
        let evs = read_digest(&p, None).unwrap();
        // A kept result's line keeps its blank user message too; a dropped
        // result's line (Read, the screenshot, the preview, Write) leaves nothing.
        assert_eq!(names(&evs), vec![
            "user",
            "use:mcp__cc_conductor__write_plan",
            "user",
            "result:p1",
            "use:Write",
            "use:mcp__cc_conductor__send_message",
            "user",
            "result:m1",
        ]);
        let ChatEvent::ToolUse { input, .. } = &evs[4] else { panic!("not a tool use") };
        assert_eq!(input, &serde_json::json!({"file_path":"b.ts"}), "an edit keeps only its path");
    }

    #[test]
    fn before_seq_cuts_at_the_loaded_page_and_appends_are_picked_up() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("t.jsonl");
        let first = user("one");
        write(&p, &[first.clone(), user("two")]);
        let second_at = first.len() as u64 + 1;
        assert_eq!(read_digest(&p, Some(second_at)).unwrap().len(), 1);
        assert_eq!(read_digest(&p, None).unwrap().len(), 2);
        // An append after the first scan is read on the next call.
        let mut f = std::fs::OpenOptions::new().append(true).open(&p).unwrap();
        writeln!(f, "{}", user("three")).unwrap();
        // A line still being written is not read yet.
        write!(f, "{{\"type\":\"user\"").unwrap();
        drop(f);
        assert_eq!(read_digest(&p, None).unwrap().len(), 3);
    }

    #[test]
    fn a_line_that_is_not_utf8_is_skipped_and_the_scan_goes_on() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("t.jsonl");
        let mut f = File::create(&p).unwrap();
        writeln!(f, "{}", user("before")).unwrap();
        f.write_all(b"{\"type\":\"user\",\"x\":\"\xff\xfe\"}\n").unwrap();
        writeln!(f, "{}", user("after")).unwrap();
        drop(f);
        assert_eq!(read_digest(&p, None).unwrap().len(), 2);
    }

    #[test]
    fn a_large_pasted_image_is_elided_and_its_block_kept() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("t.jsonl");
        let big = "A".repeat(IMAGE_INLINE_MAX_B64 + 10);
        write(&p, &[line(serde_json::json!({"type":"user","message":{"role":"user","content":[
            {"type":"image","source":{"type":"base64","media_type":"image/png","data":big}},
            {"type":"text","text":"this"}
        ]},"timestamp":"2026-11-12T10:00:00Z"}))]);
        let evs = read_digest(&p, None).unwrap();
        let ChatEvent::UserMessage { content, .. } = &evs[0] else { panic!("not a user message") };
        assert!(matches!(&content[0], ContentBlock::Image { data, .. } if data.is_empty()));
    }
}
