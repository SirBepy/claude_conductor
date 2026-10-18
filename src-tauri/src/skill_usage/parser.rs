use crate::skill_usage::types::{InvocationSource, SkillUsageEvent, TokenBreakdown};
use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
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

pub fn parse_transcript(path: &Path) -> Vec<SkillUsageEvent> {
    let Ok(file) = std::fs::File::open(path) else { return vec![] };
    let lines: Vec<Value> = BufReader::new(file)
        .lines()
        .map_while(Result::ok)
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str::<Value>(&l).ok())
        .collect();

    let mut events = Vec::new();
    let mut last_user_text: Option<String> = None;
    let mut skill_seen_since_user: bool = false;
    let mut cwd: Option<String> = None;
    let mut session_id: Option<String> = None;

    for i in 0..lines.len() {
        let row = &lines[i];
        let row_type = row.get("type").and_then(|v| v.as_str()).unwrap_or("");

        if session_id.is_none() {
            session_id = row
                .get("session_id")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
        }
        if cwd.is_none() {
            cwd = row
                .get("cwd")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
        }

        match row_type {
            "user" => {
                if let Some(text) = first_user_text(row) {
                    last_user_text = Some(text);
                    skill_seen_since_user = false;
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

                let body_lengths = tool_result_lengths(&lines, i, &skills_in_turn);
                let total_usage = next_assistant_usage(&lines, i);
                let split = split_usage(&body_lengths, &total_usage);

                let project = cwd.as_deref().and_then(crate::notifications::rules::project_name_from_cwd).unwrap_or_default();
                let ts = chrono::Utc::now()
                    .to_rfc3339_opts(chrono::SecondsFormat::Secs, true);

                for (idx, (_id, skill_name)) in skills_in_turn.iter().enumerate() {
                    // Source for skills after the first in the same turn: chained.
                    let source = if idx == 0 {
                        classify_source(
                            skill_name,
                            last_user_text.as_deref(),
                            skill_seen_since_user,
                        )
                    } else {
                        InvocationSource::Skill
                    };
                    events.push(SkillUsageEvent {
                        ts: ts.clone(),
                        skill: skill_name.clone(),
                        session_id: session_id.clone().unwrap_or_default(),
                        project: project.clone(),
                        source,
                        tokens: split[idx].clone(),
                    });
                }
                skill_seen_since_user = true;
            }
            _ => {}
        }
    }

    events
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

fn next_assistant_usage(lines: &[Value], from_idx: usize) -> TokenBreakdown {
    for line in lines.iter().skip(from_idx + 1) {
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
    lines: &[Value],
    from_idx: usize,
    skills_in_turn: &[(String, String)],
) -> Vec<usize> {
    let mut by_id: HashMap<String, usize> = HashMap::new();
    for line in lines.iter().skip(from_idx + 1) {
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
}
