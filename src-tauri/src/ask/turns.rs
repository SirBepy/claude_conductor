//! The main chat's new turns since a thread's previous question, as plain text
//! for the thread's next prompt, so a warm thread never re-reads the whole
//! transcript to see what changed (Joe, 2026-11-11). A thread's first question
//! still gets only the transcript path (`sidecar::build_prompt`) and reads it on
//! demand; from then on each question carries what was added since.

use std::collections::BTreeMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::Mutex;

/// Where each thread last read the transcript, in bytes. In memory only: after a
/// daemon restart a thread's next question names the transcript instead, which
/// is what a cold thread did before.
static OFFSETS: Mutex<BTreeMap<String, u64>> = Mutex::new(BTreeMap::new());

/// The most turn text one question carries; past it the oldest turns go and a
/// line says so, since the transcript still holds them.
const MAX_CHARS: usize = 8_000;
/// One turn's cap, so a single long message cannot crowd out the rest.
const MAX_TURN_CHARS: usize = 1_500;

/// Starts `thread_id` at the transcript's current end: its first question names
/// the transcript, so everything before now is reachable by reading it.
pub fn start(thread_id: &str, transcript: Option<&Path>) {
    let len = transcript.and_then(|p| std::fs::metadata(p).ok()).map(|m| m.len());
    if let Some(len) = len {
        OFFSETS.lock().unwrap_or_else(|p| p.into_inner()).insert(thread_id.to_string(), len);
    }
}

/// What to put ahead of a follow-up: the turns added since the thread last read,
/// or a pointer to the transcript when this daemon never saw the thread start.
pub fn since_last(thread_id: &str, transcript: Option<&Path>) -> String {
    let Some(path) = transcript else { return String::new() };
    let known = OFFSETS.lock().unwrap_or_else(|p| p.into_inner()).get(thread_id).copied();
    let Some(offset) = known else {
        start(thread_id, Some(path));
        return format!(
            "The chat may have moved on since your last answer. Its transcript is at:\n{}\nRead the newest turns there if this question needs them.\n\n",
            path.display()
        );
    };
    let (bytes, next) = read_from(path, offset);
    OFFSETS.lock().unwrap_or_else(|p| p.into_inner()).insert(thread_id.to_string(), next);
    let turns = render(&bytes);
    if turns.is_empty() {
        return String::new();
    }
    format!("Since his last question, the chat went on (newest last):\n{turns}\n\n")
}

/// Forgets a thread, for tests and for a thread whose process was recycled.
#[cfg(test)]
pub fn forget(thread_id: &str) {
    OFFSETS.lock().unwrap_or_else(|p| p.into_inner()).remove(thread_id);
}

/// Bytes from `offset` up to the last complete line, and the offset after them.
/// A line still being written stays for next time.
fn read_from(path: &Path, offset: u64) -> (Vec<u8>, u64) {
    let Ok(mut f) = std::fs::File::open(path) else { return (Vec::new(), offset) };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    if len < offset {
        // A file shorter than the offset is a different file: read on from its end.
        return (Vec::new(), len);
    }
    if f.seek(SeekFrom::Start(offset)).is_err() {
        return (Vec::new(), offset);
    }
    let mut buf = Vec::new();
    if f.read_to_end(&mut buf).is_err() {
        return (Vec::new(), offset);
    }
    let complete = buf.iter().rposition(|b| *b == b'\n').map(|i| i + 1).unwrap_or(0);
    buf.truncate(complete);
    (buf, offset + complete as u64)
}

/// Joe's messages, Claude's text, and what Claude sent or asked him, one line
/// group per turn. Tool calls, tool output, thinking, subagent lines and
/// injected (meta) messages are left out: the thread can read the transcript
/// when it needs them.
pub fn render(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes);
    let mut turns: Vec<String> = Vec::new();
    for line in text.lines() {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        if v.get("isSidechain").and_then(|b| b.as_bool()).unwrap_or(false)
            || v.get("isMeta").and_then(|b| b.as_bool()).unwrap_or(false)
        {
            continue;
        }
        let content = v.pointer("/message/content");
        match v.get("type").and_then(|t| t.as_str()) {
            Some("user") => {
                let said = match content {
                    Some(serde_json::Value::String(s)) => s.clone(),
                    Some(serde_json::Value::Array(blocks)) => blocks
                        .iter()
                        .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("text"))
                        .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
                        .collect::<Vec<_>>()
                        .join("\n"),
                    _ => String::new(),
                };
                let said = strip_reminders(&said);
                if !said.trim().is_empty() {
                    turns.push(format!("Joe: {}", clip(said.trim(), MAX_TURN_CHARS)));
                }
            }
            Some("assistant") => {
                for b in content.and_then(|c| c.as_array()).into_iter().flatten() {
                    match b.get("type").and_then(|t| t.as_str()) {
                        Some("text") => {
                            let t = b.get("text").and_then(|t| t.as_str()).unwrap_or("").trim();
                            if !t.is_empty() {
                                turns.push(format!("Claude: {}", clip(t, MAX_TURN_CHARS)));
                            }
                        }
                        Some("tool_use") => {
                            if let Some(s) = tool_line(b) {
                                turns.push(s);
                            }
                        }
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }
    keep_newest(turns)
}

/// The two tools whose input is what Joe actually reads: a sent message and a
/// question card. Matched by suffix, since the MCP prefix varies by setup.
fn tool_line(b: &serde_json::Value) -> Option<String> {
    let name = b.get("name")?.as_str()?;
    let input = b.get("input")?;
    let s = |k: &str| input.get(k).and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    if name.ends_with("send_message") {
        let body = [s("verdict"), s("text")].into_iter().filter(|x| !x.is_empty()).collect::<Vec<_>>().join(": ");
        return (!body.is_empty()).then(|| format!("Claude sent Joe: {}", clip(&body, MAX_TURN_CHARS)));
    }
    if name.ends_with("ask_user_question") {
        let qs: Vec<String> = input
            .get("questions")?
            .as_array()?
            .iter()
            .filter_map(|q| q.get("question").and_then(|v| v.as_str()))
            .map(|q| clip(q.trim(), 400))
            .collect();
        return (!qs.is_empty()).then(|| format!("Claude asked Joe: {}", qs.join(" | ")));
    }
    None
}

fn strip_reminders(s: &str) -> String {
    let mut out = String::new();
    let mut rest = s;
    while let Some(i) = rest.find("<system-reminder>") {
        out.push_str(&rest[..i]);
        match rest[i..].find("</system-reminder>") {
            Some(j) => rest = &rest[i + j + "</system-reminder>".len()..],
            None => return out,
        }
    }
    out.push_str(rest);
    out
}

fn clip(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let cut: String = s.chars().take(max).collect();
    format!("{cut}...")
}

fn keep_newest(turns: Vec<String>) -> String {
    let mut kept: Vec<&String> = Vec::new();
    let mut total = 0;
    for t in turns.iter().rev() {
        if total + t.len() > MAX_CHARS && !kept.is_empty() {
            break;
        }
        total += t.len() + 1;
        kept.push(t);
    }
    let dropped = turns.len() - kept.len();
    kept.reverse();
    let mut out = String::new();
    if dropped > 0 {
        out.push_str(&format!("({dropped} older turns left out; they are in the transcript.)\n"));
    }
    out.push_str(&kept.iter().map(|s| s.as_str()).collect::<Vec<_>>().join("\n"));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn line(v: serde_json::Value) -> String {
        format!("{v}\n")
    }

    #[test]
    fn renders_joe_claude_and_what_claude_sent_but_not_tool_noise() {
        let jsonl = [
            line(serde_json::json!({"type":"user","message":{"content":"is the cap soft?"}})),
            line(serde_json::json!({"type":"user","isMeta":true,"message":{"content":"injected"}})),
            line(serde_json::json!({"type":"assistant","message":{"content":[{"type":"thinking","thinking":"hmm"},{"type":"tool_use","name":"Read","input":{"file_path":"x"}}]}})),
            line(serde_json::json!({"type":"user","message":{"content":[{"type":"tool_result","content":"file body"}]}})),
            line(serde_json::json!({"type":"assistant","message":{"content":[{"type":"text","text":"Checking."}]}})),
            line(serde_json::json!({"type":"assistant","message":{"content":[{"type":"tool_use","name":"mcp__cc_conductor__send_message","input":{"kind":"answer","verdict":"Yes, soft","text":"Queued subs skip it."}}]}})),
            line(serde_json::json!({"type":"assistant","isSidechain":true,"message":{"content":[{"type":"text","text":"subagent"}]}})),
            line(serde_json::json!({"type":"assistant","message":{"content":[{"type":"tool_use","name":"mcp__cc_conductor__ask_user_question","input":{"questions":[{"question":"Cap at 10?"}]}}]}})),
        ]
        .concat();
        let out = render(jsonl.as_bytes());
        assert_eq!(
            out,
            "Joe: is the cap soft?\nClaude: Checking.\nClaude sent Joe: Yes, soft: Queued subs skip it.\nClaude asked Joe: Cap at 10?"
        );
    }

    #[test]
    fn system_reminders_inside_joes_message_are_dropped() {
        let jsonl = line(serde_json::json!({"type":"user","message":{"content":"<system-reminder>noise</system-reminder>real words"}}));
        assert_eq!(render(jsonl.as_bytes()), "Joe: real words");
    }

    #[test]
    fn only_the_newest_turns_fit_and_a_line_says_how_many_went() {
        let one = |i: usize| line(serde_json::json!({"type":"user","message":{"content":format!("{i} {}", "x".repeat(1_400))}}));
        let jsonl: String = (0..10).map(one).collect();
        let out = render(jsonl.as_bytes());
        assert!(out.starts_with("(5 older turns left out"), "{out}");
        assert!(out.contains("Joe: 9 "));
        assert!(!out.contains("Joe: 4 "));
    }

    #[test]
    fn follow_ups_carry_only_what_was_added_and_never_a_half_written_line() {
        let dir = std::env::temp_dir().join(format!("cc-turns-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.jsonl");
        std::fs::write(&path, line(serde_json::json!({"type":"user","message":{"content":"before the thread"}}))).unwrap();
        let tid = format!("t-{}", uuid::Uuid::new_v4());

        start(&tid, Some(&path));
        assert_eq!(since_last(&tid, Some(&path)), "");

        let mut f = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
        f.write_all(line(serde_json::json!({"type":"user","message":{"content":"new one"}})).as_bytes()).unwrap();
        f.write_all(br#"{"type":"user","message":{"content":"half"#).unwrap();
        f.flush().unwrap();
        let first = since_last(&tid, Some(&path));
        assert!(first.contains("Joe: new one"), "{first}");
        assert!(!first.contains("before the thread"));
        assert!(!first.contains("half"));

        f.write_all(b"\"}}\n").unwrap();
        f.flush().unwrap();
        let second = since_last(&tid, Some(&path));
        assert!(second.contains("Joe: half") && !second.contains("new one"), "{second}");
        forget(&tid);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_thread_this_daemon_never_saw_start_is_pointed_at_the_transcript() {
        let tid = format!("t-{}", uuid::Uuid::new_v4());
        let path = std::env::temp_dir().join(format!("cc-turns-missing-{}.jsonl", uuid::Uuid::new_v4()));
        std::fs::write(&path, "").unwrap();
        let out = since_last(&tid, Some(&path));
        assert!(out.contains("transcript is at") && out.contains(&path.display().to_string()), "{out}");
        forget(&tid);
        let _ = std::fs::remove_file(&path);
    }
}
