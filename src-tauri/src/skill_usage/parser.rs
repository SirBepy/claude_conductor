use crate::skill_usage::types::{InvocationSource, SkillUsageEvent, TokenBreakdown};
use crate::context_status::tail::{TailPos, TailReader};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::path::Path;

/// The skill name a `tool_use` content block invoked, if it is a `Skill`
/// call naming one. `None` for any other tool_use, any non-tool_use block,
/// or a `Skill` call whose `input.skill` is missing or not a string.
/// Shared with `hooks_server::context_cap`'s opt-in scan so both readers of
/// a transcript's `Skill` tool_use blocks agree on what counts as one.
pub(crate) fn skill_tool_use_name(block: &Value) -> Option<&str> {
    if block.get("type").and_then(Value::as_str) != Some("tool_use") {
        return None;
    }
    if block.get("name").and_then(Value::as_str) != Some("Skill") {
        return None;
    }
    block.pointer("/input/skill").and_then(Value::as_str)
}

/// Every skill invocation in the whole transcript, read from byte 0. The
/// reference the incremental reader below must agree with.
pub fn parse_transcript(path: &Path) -> Vec<SkillUsageEvent> {
    let Some(mut reader) = TailReader::open(path, &TailPos::default()) else { return vec![] };
    let rows = read_rows(&mut reader);
    scan(&rows, &mut Carry::default(), true).0
}

/// What a scan carries from one row to the next, so a transcript can be read in
/// pieces: the chunk boundary must not change what the next row is made of.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
struct Carry {
    last_user_text: Option<String>,
    skill_seen_since_user: bool,
    cwd: Option<String>,
    session_id: Option<String>,
}

/// Where `parse_transcript_tail` stopped, and the carry at that point.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct SkillTail {
    pos: TailPos,
    carry: Carry,
}

/// `classify_source` only looks at the first word of a `/command`, so keeping
/// the head of a long pasted prompt decides it exactly as the whole text would.
const USER_TEXT_KEPT: usize = 256;

struct Row {
    value: Value,
    start: u64,
}

fn read_rows(reader: &mut TailReader) -> Vec<Row> {
    let mut rows = Vec::new();
    let mut line = String::new();
    while let Some((start, _)) = reader.next_line(&mut line) {
        if line.trim().is_empty() {
            continue;
        }
        if let Ok(value) = serde_json::from_str::<Value>(&line) {
            rows.push(Row { value, start });
        }
    }
    rows
}

/// A skill row's token split reads the first later assistant row that has a
/// usage block, and its results sit before the next assistant row. Until that
/// row is on disk the row's numbers are not final.
fn is_resolved(rows: &[Row], i: usize) -> bool {
    rows.iter().skip(i + 1).any(|r| {
        r.value.get("type").and_then(|v| v.as_str()) == Some("assistant") && r.value.pointer("/message/usage").is_some()
    })
}

/// Skill invocations found in the NEW lines of a transcript since `tail` last
/// stopped. A skill row whose usage row has not been written yet is held back
/// (the position stays at its start) and comes out once it can be sized, so each
/// invocation is emitted once, with the numbers a full read of the finished
/// file gives. The old per-turn full read emitted every invocation again on
/// every turn. A file that shrank or was replaced is read from the start.
pub fn parse_transcript_tail(path: &Path, tail: &mut SkillTail) -> Vec<SkillUsageEvent> {
    let Some(mut reader) = TailReader::open(path, &tail.pos) else { return vec![] };
    if reader.reset {
        *tail = SkillTail::default();
    }
    let rows = read_rows(&mut reader);
    let (events, held_at) = scan(&rows, &mut tail.carry, false);
    tail.pos = reader.finish(held_at.map(|i| rows[i].start));
    events
}

/// Walks `rows` in order. With `all` false it stops before the first skill row
/// that cannot be sized yet and returns that row's index.
fn scan(rows: &[Row], carry: &mut Carry, all: bool) -> (Vec<SkillUsageEvent>, Option<usize>) {
    let mut events = Vec::new();

    for i in 0..rows.len() {
        let row = &rows[i].value;
        let row_type = row.get("type").and_then(|v| v.as_str()).unwrap_or("");

        if carry.session_id.is_none() {
            carry.session_id = row
                .get("session_id")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
        }
        if carry.cwd.is_none() {
            carry.cwd = row
                .get("cwd")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
        }

        match row_type {
            "user" => {
                if let Some(text) = first_user_text(row) {
                    let mut end = text.len().min(USER_TEXT_KEPT);
                    while !text.is_char_boundary(end) {
                        end -= 1;
                    }
                    carry.last_user_text = Some(text[..end].to_string());
                    carry.skill_seen_since_user = false;
                }
            }
            "assistant" => {
                let Some(content) = row
                    .pointer("/message/content")
                    .and_then(|v| v.as_array())
                else {
                    continue;
                };
                // Collect every Skill tool_use in this turn, in order.
                let mut skills_in_turn: Vec<(String, String)> = Vec::new(); // (tool_use_id, skill_name)
                for c in content {
                    let Some(skill_name) = skill_tool_use_name(c) else { continue };
                    if skill_name.is_empty() {
                        continue;
                    }
                    let id = c.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    skills_in_turn.push((id, skill_name.to_string()));
                }
                if skills_in_turn.is_empty() {
                    continue;
                }
                if !all && !is_resolved(rows, i) {
                    return (events, Some(i));
                }

                let body_lengths = tool_result_lengths(rows, i, &skills_in_turn);
                let total_usage = next_assistant_usage(rows, i);
                let split = split_usage(&body_lengths, &total_usage);

                let project = carry.cwd.as_deref().and_then(crate::notifications::rules::project_name_from_cwd).unwrap_or_default();
                let ts = chrono::Utc::now()
                    .to_rfc3339_opts(chrono::SecondsFormat::Secs, true);

                for (idx, (_id, skill_name)) in skills_in_turn.iter().enumerate() {
                    // Source for skills after the first in the same turn: chained.
                    let source = if idx == 0 {
                        classify_source(
                            skill_name,
                            carry.last_user_text.as_deref(),
                            carry.skill_seen_since_user,
                        )
                    } else {
                        InvocationSource::Skill
                    };
                    events.push(SkillUsageEvent {
                        ts: ts.clone(),
                        skill: skill_name.clone(),
                        session_id: carry.session_id.clone().unwrap_or_default(),
                        project: project.clone(),
                        source,
                        tokens: split[idx].clone(),
                    });
                }
                carry.skill_seen_since_user = true;
            }
            _ => {}
        }
    }

    (events, None)
}

fn first_user_text(row: &Value) -> Option<String> {
    let arr = row.pointer("/message/content")?.as_array()?;
    for c in arr {
        if c.get("type").and_then(|v| v.as_str()) == Some("text") {
            return c
                .get("text")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
        }
    }
    None
}

fn classify_source(
    skill_name: &str,
    last_user_text: Option<&str>,
    skill_seen_since_user: bool,
) -> InvocationSource {
    if let Some(text) = last_user_text {
        let trimmed = text.trim_start();
        if let Some(rest) = trimmed.strip_prefix('/') {
            let short = skill_name.rsplit(':').next().unwrap_or(skill_name);
            let head = rest
                .split(|c: char| c.is_whitespace())
                .next()
                .unwrap_or("");
            if head == skill_name || head == short {
                return InvocationSource::Manual;
            }
        }
    }
    if skill_seen_since_user {
        return InvocationSource::Skill;
    }
    InvocationSource::Auto
}

fn next_assistant_usage(lines: &[Row], from_idx: usize) -> TokenBreakdown {
    for line in lines.iter().skip(from_idx + 1).map(|r| &r.value) {
        if line.get("type").and_then(|v| v.as_str()) != Some("assistant") {
            continue;
        }
        let Some(usage) = line.pointer("/message/usage") else {
            continue;
        };
        return TokenBreakdown {
            input: usage
                .get("input_tokens")
                .and_then(|v| v.as_u64())
                .unwrap_or(0),
            output: usage
                .get("output_tokens")
                .and_then(|v| v.as_u64())
                .unwrap_or(0),
            cache_read: usage
                .get("cache_read_input_tokens")
                .and_then(|v| v.as_u64())
                .unwrap_or(0),
            cache_create: usage
                .get("cache_creation_input_tokens")
                .and_then(|v| v.as_u64())
                .unwrap_or(0),
        };
    }
    TokenBreakdown::default()
}

/// Walks forward from `from_idx` to the next user turn, indexing its
/// `tool_result` entries by `tool_use_id`, and returns the body length
/// (sum of character lengths across text content) for each skill in order.
/// Missing tool_results yield 0 for that slot.
fn tool_result_lengths(
    lines: &[Row],
    from_idx: usize,
    skills_in_turn: &[(String, String)],
) -> Vec<usize> {
    let mut by_id: HashMap<String, usize> = HashMap::new();
    for line in lines.iter().skip(from_idx + 1).map(|r| &r.value) {
        let t = line.get("type").and_then(|v| v.as_str()).unwrap_or("");
        if t == "assistant" {
            // We've passed the user turn that holds tool_results; stop.
            break;
        }
        if t != "user" {
            continue;
        }
        let Some(content) = line
            .pointer("/message/content")
            .and_then(|v| v.as_array())
        else {
            continue;
        };
        for c in content {
            if c.get("type").and_then(|v| v.as_str()) != Some("tool_result") {
                continue;
            }
            let Some(id) = c.get("tool_use_id").and_then(|v| v.as_str()) else {
                continue;
            };
            let len = tool_result_content_len(c.get("content"));
            by_id.insert(id.to_string(), len);
        }
        // A skill's tool_results live in the same user turn that resolves it;
        // once we've scanned that turn we're done.
        break;
    }
    skills_in_turn
        .iter()
        .map(|(id, _)| by_id.get(id).copied().unwrap_or(0))
        .collect()
}

/// `content` for a tool_result may be a string or an array of content blocks.
/// We sum text lengths; non-text blocks (images) contribute 0 since skill
/// bodies are text and we want a proxy for "input-token weight".
fn tool_result_content_len(content: Option<&Value>) -> usize {
    let Some(content) = content else { return 0 };
    if let Some(s) = content.as_str() {
        return s.len();
    }
    if let Some(arr) = content.as_array() {
        return arr
            .iter()
            .filter_map(|b| {
                if b.get("type").and_then(|v| v.as_str()) == Some("text") {
                    b.get("text").and_then(|v| v.as_str())
                } else {
                    None
                }
            })
            .map(str::len)
            .sum();
    }
    0
}

/// Splits one TokenBreakdown across N slots weighted by body length.
/// Each field is split independently using floor; the last slot collects
/// the remainder so the per-skill sum equals the original exactly. When
/// every weight is zero (no tool_results captured), falls back to an
/// equal split with the same remainder-to-last rule.
fn split_usage(weights: &[usize], total: &TokenBreakdown) -> Vec<TokenBreakdown> {
    if weights.is_empty() {
        return vec![];
    }
    if weights.len() == 1 {
        return vec![total.clone()];
    }
    let total_weight: usize = weights.iter().sum();
    let use_equal = total_weight == 0;

    let mut out: Vec<TokenBreakdown> = Vec::with_capacity(weights.len());
    let mut acc = TokenBreakdown::default();
    for (idx, w) in weights.iter().enumerate() {
        let mut piece = TokenBreakdown::default();
        if idx == weights.len() - 1 {
            // Last slot: take whatever's left so totals match exactly.
            piece.input = total.input.saturating_sub(acc.input);
            piece.output = total.output.saturating_sub(acc.output);
            piece.cache_read = total.cache_read.saturating_sub(acc.cache_read);
            piece.cache_create = total.cache_create.saturating_sub(acc.cache_create);
        } else {
            let (num, denom) = if use_equal {
                (1u64, weights.len() as u64)
            } else {
                (*w as u64, total_weight as u64)
            };
            piece.input = total.input * num / denom;
            piece.output = total.output * num / denom;
            piece.cache_read = total.cache_read * num / denom;
            piece.cache_create = total.cache_create * num / denom;
        }
        acc.input += piece.input;
        acc.output += piece.output;
        acc.cache_read += piece.cache_read;
        acc.cache_create += piece.cache_create;
        out.push(piece);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skill_tool_use_name_reads_a_skill_block() {
        let block = serde_json::json!({"type": "tool_use", "name": "Skill", "input": {"skill": "auto-respawn"}});
        assert_eq!(skill_tool_use_name(&block), Some("auto-respawn"));
    }

    #[test]
    fn skill_tool_use_name_ignores_a_non_skill_tool_use() {
        let block = serde_json::json!({"type": "tool_use", "name": "Edit", "input": {"skill": "auto-respawn"}});
        assert_eq!(skill_tool_use_name(&block), None);
    }

    #[test]
    fn skill_tool_use_name_is_none_without_input_skill() {
        let block = serde_json::json!({"type": "tool_use", "name": "Skill", "input": {}});
        assert_eq!(skill_tool_use_name(&block), None);
    }

    // ---- incremental reading ----

    use crate::context_status::tail::CursorStore;
    use std::io::Write;

    const USER_COMMIT: &str = r#"{"type":"user","session_id":"sess-1","cwd":"C:/work/proj","message":{"content":[{"type":"text","text":"/commit please"}]}}"#;
    const SKILL_COMMIT: &str = r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Skill","input":{"skill":"commit"}}]}}"#;
    const RESULT_T1: &str = r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"commit body text"}]}}"#;
    const USAGE_A: &str = r#"{"type":"assistant","message":{"content":[{"type":"text","text":"ok"}],"usage":{"input_tokens":10,"output_tokens":20,"cache_read_input_tokens":30,"cache_creation_input_tokens":40}}}"#;
    const USER_MORE: &str = r#"{"type":"user","message":{"content":[{"type":"text","text":"now do more"}]}}"#;
    const TWO_SKILLS: &str = r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t2","name":"Skill","input":{"skill":"alpha"}},{"type":"tool_use","id":"t3","name":"Skill","input":{"skill":"beta"}}]}}"#;
    const RESULT_T23: &str = r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t2","content":"aaaa"},{"type":"tool_result","tool_use_id":"t3","content":"bbbbbbbbbbbb"}]}}"#;
    const USAGE_B: &str = r#"{"type":"assistant","message":{"content":[{"type":"text","text":"done"}],"usage":{"input_tokens":101,"output_tokens":7,"cache_read_input_tokens":0,"cache_creation_input_tokens":55}}}"#;

    const SESSION: [&str; 9] =
        [USER_COMMIT, SKILL_COMMIT, RESULT_T1, USAGE_A, USER_MORE, TWO_SKILLS, RESULT_T23, USAGE_B, USER_MORE];

    /// Events without their wall-clock `ts`, which differs between two parses.
    fn shape(events: &[SkillUsageEvent]) -> Vec<String> {
        events
            .iter()
            .map(|e| format!("{} {:?} {} {} {:?}", e.skill, e.source, e.session_id, e.project, e.tokens))
            .collect()
    }

    fn append(path: &Path, line: &str) {
        let mut f = std::fs::OpenOptions::new().create(true).append(true).open(path).unwrap();
        writeln!(f, "{line}").unwrap();
    }

    #[test]
    fn a_full_read_sizes_each_skill_from_the_usage_row_after_it() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.jsonl");
        for l in SESSION {
            append(&path, l);
        }
        let events = parse_transcript(&path);
        assert_eq!(events.len(), 3);
        assert_eq!((events[0].skill.as_str(), events[0].source), ("commit", InvocationSource::Manual));
        assert_eq!(events[0].tokens.total(), 100);
        assert_eq!(events[0].session_id, "sess-1");
        assert_eq!((events[1].skill.as_str(), events[1].source), ("alpha", InvocationSource::Auto));
        assert_eq!((events[2].skill.as_str(), events[2].source), ("beta", InvocationSource::Skill));
        // 4 vs 12 bytes of result: a 1:3 split of 101 input tokens.
        assert_eq!((events[1].tokens.input, events[2].tokens.input), (25, 76));
    }

    #[test]
    fn reading_only_the_appended_lines_emits_each_skill_once_and_matches_a_full_read() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.jsonl");
        let mut tail = SkillTail::default();
        let mut got = Vec::new();
        for l in SESSION {
            append(&path, l);
            got.extend(parse_transcript_tail(&path, &mut tail));
        }
        assert_eq!(shape(&got), shape(&parse_transcript(&path)));
        assert_eq!(got.len(), 3, "nothing is emitted twice");
        assert!(parse_transcript_tail(&path, &mut tail).is_empty(), "an unchanged file yields nothing");
    }

    #[test]
    fn a_skill_whose_usage_row_is_not_written_yet_waits_instead_of_being_sized_at_zero() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.jsonl");
        let mut tail = SkillTail::default();
        for l in [USER_COMMIT, SKILL_COMMIT, RESULT_T1] {
            append(&path, l);
        }
        assert!(parse_transcript_tail(&path, &mut tail).is_empty());
        append(&path, USAGE_A);
        let events = parse_transcript_tail(&path, &mut tail);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].tokens.total(), 100, "sized from the row that arrived later");
        assert_eq!(events[0].source, InvocationSource::Manual, "the user row behind the offset still decides the source");
    }

    #[test]
    fn a_shrunk_or_replaced_transcript_is_parsed_from_the_start() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.jsonl");
        let mut tail = SkillTail::default();
        for l in SESSION {
            append(&path, l);
        }
        assert_eq!(parse_transcript_tail(&path, &mut tail).len(), 3);

        let short = [USER_MORE, TWO_SKILLS, RESULT_T23, USAGE_B].join("\n") + "\n";
        std::fs::write(&path, short).unwrap();
        assert_eq!(shape(&parse_transcript_tail(&path, &mut tail)), shape(&parse_transcript(&path)));

        let longer: Vec<&str> = [USER_COMMIT, SKILL_COMMIT, RESULT_T1, USAGE_A].into_iter().cycle().take(40).collect();
        std::fs::write(&path, longer.join("\n") + "\n").unwrap();
        let events = parse_transcript_tail(&path, &mut tail);
        assert_eq!(shape(&events), shape(&parse_transcript(&path)));
        assert_eq!(events.len(), 10);
    }

    #[test]
    fn a_daemon_restart_neither_re_emits_old_skills_nor_loses_the_source_context() {
        let transcripts = tempfile::tempdir().unwrap();
        let saved = tempfile::tempdir().unwrap();
        let path = transcripts.path().join("t.jsonl");
        let store = CursorStore::<SkillTail>::new("skills-test");
        let step = |upto: &[&str]| {
            for l in upto {
                append(&path, l);
            }
            store.with(Some(saved.path()), "sess-1", |t| parse_transcript_tail(&path, t))
        };
        let mut got = step(&SESSION[..4]);
        store.forget_memory();
        got.extend(step(&SESSION[4..]));
        assert_eq!(shape(&got), shape(&parse_transcript(&path)));
        assert_eq!(got.len(), 3);
    }

    #[test]
    fn a_long_pasted_prompt_classifies_the_same_as_its_kept_head() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.jsonl");
        let long = format!(r#"{{"type":"user","message":{{"content":[{{"type":"text","text":"/commit {}"}}]}}}}"#, "é".repeat(500));
        for l in [long.as_str(), SKILL_COMMIT, RESULT_T1, USAGE_A] {
            append(&path, l);
        }
        let mut tail = SkillTail::default();
        let events = parse_transcript_tail(&path, &mut tail);
        assert_eq!(shape(&events), shape(&parse_transcript(&path)));
        assert_eq!(events[0].source, InvocationSource::Manual);
    }
}
