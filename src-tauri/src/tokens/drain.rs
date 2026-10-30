//! Cost-weighted "drain" of a session in relative drain UNITS per transcript,
//! per session (incl. merged subagents), and per user message. The weights are
//! the per-token model prices, so the scale is meaningless on its own and is
//! only ever used as a ratio — never shown to the user as a dollar figure.
//! Pricing is matched on the model string of each assistant usage line. The
//! per-message grouping mirrors `walker::parse_transcript`'s line loop and
//! reuses `title::is_real_user_turn` so a "message" means exactly what the user
//! perceives (no tool_result continuations, no meta/last-prompt rows).

use std::io::{BufRead, BufReader};
use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use super::title::is_real_user_turn;
use super::walker::{claude_projects_dir, encode_cwd_as_project_dir, transcript_for_session};

/// Per-MTok prices flattened to per-single-token (the spec's `*e-6` constants).
pub(crate) struct Pricing {
    pub input: f64,
    pub output: f64,
    pub cache_write: f64,
    pub cache_read: f64,
}

/// Picks a pricing row by lowercase substring of the model string. Unknown or
/// empty models fall back to the sonnet row (the common middle tier).
pub(crate) fn pricing_for(model: &str) -> Pricing {
    let m = model.to_lowercase();
    if m.contains("opus") {
        Pricing { input: 15e-6, output: 75e-6, cache_write: 18.75e-6, cache_read: 1.5e-6 }
    } else if m.contains("haiku") {
        Pricing { input: 1e-6, output: 5e-6, cache_write: 1.25e-6, cache_read: 0.1e-6 }
    } else {
        // "sonnet" and the default both land here.
        Pricing { input: 3e-6, output: 15e-6, cache_write: 3.75e-6, cache_read: 0.3e-6 }
    }
}

/// One assistant usage line's drain (USD) and raw token sum. `None` when the
/// line is not an assistant message carrying a `usage` block.
fn line_drain(v: &serde_json::Value) -> Option<(f64, u64)> {
    if v.get("type").and_then(|t| t.as_str()) != Some("assistant") {
        return None;
    }
    // Usage + model live under `message` in transcript JSONL, but fall back to
    // the top level the same way walker does for stream-json lines.
    let message = v.get("message");
    let usage = message
        .and_then(|m| m.get("usage"))
        .or_else(|| v.get("usage"))?;
    let model = message
        .and_then(|m| m.get("model"))
        .or_else(|| v.get("model"))
        .and_then(|s| s.as_str())
        .unwrap_or("");
    let p = pricing_for(model);
    let get = |k: &str| usage.get(k).and_then(|n| n.as_u64()).unwrap_or(0);
    let input = get("input_tokens");
    let output = get("output_tokens");
    let cache_write = get("cache_creation_input_tokens");
    let cache_read = get("cache_read_input_tokens");
    let usd = input as f64 * p.input
        + output as f64 * p.output
        + cache_write as f64 * p.cache_write
        + cache_read as f64 * p.cache_read;
    let tokens = input + output + cache_write + cache_read;
    Some((usd, tokens))
}

/// Parses an RFC 3339 string (e.g. "2026-06-22T17:31:45.803Z") into a
/// `SystemTime`. Shared by `line_timestamp` and `ipc::drain`.
pub fn rfc3339_to_system_time(s: &str) -> Option<SystemTime> {
    let dt = chrono::DateTime::parse_from_rfc3339(s).ok()?;
    let secs = dt.timestamp();
    if secs < 0 { return None; }
    Some(UNIX_EPOCH + Duration::new(secs as u64, dt.timestamp_subsec_nanos()))
}

/// Parses a transcript line's top-level `timestamp` into a `SystemTime`. `None`
/// when absent or unparseable — assistant usage lines always carry one, so `None`
/// means the line isn't a usage line we'd count anyway.
fn line_timestamp(v: &serde_json::Value) -> Option<SystemTime> {
    rfc3339_to_system_time(v.get("timestamp").and_then(|t| t.as_str())?)
}

/// Cost-weighted drain UNITS for ONE transcript file. `since: None` counts every
/// assistant usage line (lifetime); `since: Some(cutoff)` counts only lines whose
/// `timestamp` is at or after the cutoff (windowed). Missing/malformed files yield
/// 0.0 (never panic). Lines without a parseable timestamp are excluded when a
/// cutoff is set (can't place them in the window).
pub fn transcript_drain_units(path: &Path, since: Option<SystemTime>) -> f64 {
    let Ok(file) = std::fs::File::open(path) else { return 0.0 };
    let reader = BufReader::new(file);
    let mut total = 0.0;
    for line in reader.lines().map_while(|r| r.ok()) {
        if line.trim().is_empty() { continue }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
        if let Some(cutoff) = since {
            match line_timestamp(&v) {
                Some(ts) if ts >= cutoff => {}
                _ => continue,
            }
        }
        if let Some((usd, _)) = line_drain(&v) {
            total += usd;
        }
    }
    total
}

/// Drain UNITS for a session incl. merged subagents (main transcript + every
/// `subagents/*.jsonl`). `since: None` = lifetime; `since: Some(cutoff)` =
/// windowed (only lines at or after cutoff). Resolves the main transcript the
/// same way `walker`/`backfill` do.
pub fn drain_units_for_session(cwd: &Path, session_id: &str, since: Option<SystemTime>) -> f64 {
    let mut total = 0.0;
    if let Some(main) = transcript_for_session(cwd, session_id) {
        total += transcript_drain_units(&main, since);
    }
    // Subagent transcripts live at
    // `<projects>/<encoded-cwd>/<session-id>/subagents/*.jsonl`.
    if let Some(projects) = claude_projects_dir() {
        let sub_dir = projects
            .join(encode_cwd_as_project_dir(cwd))
            .join(session_id)
            .join("subagents");
        if let Ok(entries) = std::fs::read_dir(&sub_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|s| s.to_str()) == Some("jsonl") {
                    total += transcript_drain_units(&path, since);
                }
            }
        }
    }
    total
}

/// Drain attributed to one of the user's messages. The tokens cover every
/// assistant turn from this user message up to (but not including) the next one.
/// No dollar figure is exposed: the user is subscription-based, so the rundown
/// is in raw tokens, and `expensive` is flagged from an internal cost-weight.
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, ts_rs::TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
#[serde(rename_all = "camelCase")]
pub struct MessageDrain {
    /// 1-based: the user's Nth message.
    pub index: u32,
    /// First ~80 chars of that user prompt, whitespace-collapsed.
    pub preview: String,
    /// Raw token sum for those turns (what the rundown shows).
    pub tokens: u64,
    /// True if this message's cost-weighted drain is a clear outlier
    /// (>= mean + 1*stddev) OR top-3. Ranked on the internal weight, not tokens,
    /// so a short-but-pricey opus turn still flags.
    pub expensive: bool,
}

/// One chat's share of the rolling windows, returned to the UI. `five_hour_pct`
/// / `weekly_pct` are the chat's slice of the CURRENT window utilization, filled
/// by the IPC layer (`None` when there's no usage snapshot to apportion against);
/// `drain.rs` only produces the raw token total + per-message breakdown.
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, ts_rs::TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
#[serde(rename_all = "camelCase")]
pub struct ChatDrain {
    pub session_id: String,
    pub tokens: u64,
    pub five_hour_pct: Option<f64>,
    pub weekly_pct: Option<f64>,
    pub messages: Vec<MessageDrain>,
}

/// First ~80 chars of a real-user-turn line's text, whitespace-collapsed.
fn user_preview(v: &serde_json::Value) -> String {
    let text = match v.get("message").and_then(|m| m.get("content")) {
        Some(serde_json::Value::String(s)) => s.clone(),
        Some(serde_json::Value::Array(items)) => {
            let mut acc = String::new();
            for it in items {
                if it.get("type").and_then(|t| t.as_str()) != Some("text") { continue }
                if let Some(t) = it.get("text").and_then(|t| t.as_str()) {
                    if !acc.is_empty() { acc.push(' '); }
                    acc.push_str(t);
                }
            }
            acc
        }
        _ => String::new(),
    };
    let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    collapsed.chars().take(80).collect()
}

/// Walks the transcript and groups each block of assistant usage lines under the
/// PRECEDING real user turn, emitting one `MessageDrain` per user message.
///
/// Determinism rules (the known-buggy area):
/// - A `tool_result` user line does NOT start a new group: `is_real_user_turn`
///   already excludes it, so it is treated like any other non-user line and its
///   drain (none, it carries no usage) stays in the current group.
/// - Assistant/tool lines BEFORE the first real user message accumulate into an
///   implicit "group 0". It is emitted (index 0) only if it actually drained
///   something, so an ordinary transcript with no pre-amble produces no phantom
///   group, but a transcript that starts with assistant chatter never panics or
///   silently drops that cost.
pub fn message_drains(path: &Path) -> Vec<MessageDrain> {
    let Ok(file) = std::fs::File::open(path) else { return Vec::new() };
    let reader = BufReader::new(file);

    // current group being accumulated. index 0 = pre-first-user implicit group.
    // `cur_weight` is the internal cost-weight (drives `expensive`); it is never
    // surfaced. `cur_tokens` is the raw token total the rundown shows.
    let mut groups: Vec<MessageDrain> = Vec::new();
    let mut weights: Vec<f64> = Vec::new();
    let mut cur_index: u32 = 0;
    let mut cur_preview = String::new();
    let mut cur_weight = 0.0;
    let mut cur_tokens: u64 = 0;
    let mut started = false; // whether the current group has any committed identity

    // Flush the in-progress group into `groups`. Group 0 (pre-user) is only
    // pushed when it drained something; real user groups always push so the
    // message list lines up 1:1 with what the user sent.
    macro_rules! flush {
        () => {{
            if cur_index > 0 || cur_weight > 0.0 || cur_tokens > 0 {
                groups.push(MessageDrain {
                    index: cur_index,
                    preview: cur_preview.clone(),
                    tokens: cur_tokens,
                    expensive: false,
                });
                weights.push(cur_weight);
            }
        }};
    }

    let mut next_user_index: u32 = 1;
    for line in reader.lines().map_while(|r| r.ok()) {
        if line.trim().is_empty() { continue }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
        if is_real_user_turn(&v) {
            // Close the previous group (group 0 or the prior user message).
            if started || cur_weight > 0.0 || cur_tokens > 0 {
                flush!();
            }
            cur_index = next_user_index;
            next_user_index += 1;
            cur_preview = user_preview(&v);
            cur_weight = 0.0;
            cur_tokens = 0;
            started = true;
            continue;
        }
        if let Some((weight, tokens)) = line_drain(&v) {
            cur_weight += weight;
            cur_tokens += tokens;
        }
    }
    // Flush the trailing group.
    if started || cur_weight > 0.0 || cur_tokens > 0 {
        flush!();
    }

    mark_expensive(&mut groups, &weights);
    groups
}

/// Sets `expensive` on outliers: any cost-weight >= mean + 1*stddev, OR a top-3
/// weight. `weights` is positionally aligned with `groups` (the internal drain
/// units, never surfaced). Mutates in place after all weights are known.
fn mark_expensive(groups: &mut [MessageDrain], weights: &[f64]) {
    if groups.is_empty() { return }
    let n = weights.len() as f64;
    let mean = weights.iter().sum::<f64>() / n;
    let variance = weights.iter().map(|w| (w - mean).powi(2)).sum::<f64>() / n;
    let stddev = variance.sqrt();
    let threshold = mean + stddev;

    // Indices of the top-3 by weight.
    let mut by_weight: Vec<usize> = (0..weights.len()).collect();
    by_weight.sort_by(|&a, &b| {
        weights[b]
            .partial_cmp(&weights[a])
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let top3: std::collections::HashSet<usize> = by_weight.into_iter().take(3).collect();

    for (i, g) in groups.iter_mut().enumerate() {
        // A positive-weight message is "expensive" if it clears the stddev bar or
        // sits in the top 3. Zero-weight messages never qualify.
        let w = weights[i];
        g.expensive = w > 0.0 && (w >= threshold || top3.contains(&i));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn pricing_orders_opus_above_sonnet_above_haiku() {
        let opus = pricing_for("claude-opus-4-8");
        let sonnet = pricing_for("claude-sonnet-4-5");
        let haiku = pricing_for("claude-haiku-4-5");
        assert!(opus.input > sonnet.input && sonnet.input > haiku.input);
        assert!(opus.output > sonnet.output && sonnet.output > haiku.output);
        assert!(opus.cache_write > sonnet.cache_write && sonnet.cache_write > haiku.cache_write);
        assert!(opus.cache_read > sonnet.cache_read && sonnet.cache_read > haiku.cache_read);
    }

    #[test]
    fn pricing_unknown_falls_back_to_sonnet() {
        let unknown = pricing_for("some-future-model");
        let empty = pricing_for("");
        let sonnet = pricing_for("claude-sonnet-4-5");
        assert_eq!(unknown.input, sonnet.input);
        assert_eq!(unknown.output, sonnet.output);
        assert_eq!(empty.input, sonnet.input);
        assert_eq!(empty.cache_read, sonnet.cache_read);
    }

    #[test]
    fn transcript_drain_one_opus_line_matches_hand_computed() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("t.jsonl");
        // input 1000, output 2000, cache_write 4000, cache_read 8000 @ opus.
        std::fs::write(
            &path,
            r#"{"type":"assistant","message":{"model":"claude-opus-4-8","usage":{"input_tokens":1000,"output_tokens":2000,"cache_creation_input_tokens":4000,"cache_read_input_tokens":8000}}}"#,
        ).unwrap();
        let expected = 1000.0 * 15e-6
            + 2000.0 * 75e-6
            + 4000.0 * 18.75e-6
            + 8000.0 * 1.5e-6;
        let got = transcript_drain_units(&path, None);
        assert!((got - expected).abs() < 1e-12, "got {got}, expected {expected}");
    }

    #[test]
    fn transcript_drain_missing_file_is_zero() {
        assert_eq!(transcript_drain_units(Path::new("nope-not-real.jsonl"), None), 0.0);
    }

    #[test]
    fn transcript_drain_since_excludes_earlier_lines() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("t.jsonl");
        // Two lines: one before cutoff (2026-01-01), one after (2026-06-01).
        let content = [
            r#"{"timestamp":"2025-12-31T23:59:59Z","type":"assistant","message":{"model":"claude-sonnet-4-5","usage":{"input_tokens":1000,"output_tokens":0}}}"#,
            r#"{"timestamp":"2026-06-01T00:00:00Z","type":"assistant","message":{"model":"claude-sonnet-4-5","usage":{"input_tokens":500,"output_tokens":0}}}"#,
        ].join("\n");
        std::fs::write(&path, content).unwrap();
        let cutoff = rfc3339_to_system_time("2026-01-01T00:00:00Z").unwrap();
        let windowed = transcript_drain_units(&path, Some(cutoff));
        let lifetime = transcript_drain_units(&path, None);
        // Only the June line should count in the windowed sum.
        let expected_windowed = 500.0 * 3e-6;
        let expected_lifetime = 1000.0 * 3e-6 + 500.0 * 3e-6;
        assert!((windowed - expected_windowed).abs() < 1e-12, "windowed={windowed}");
        assert!((lifetime - expected_lifetime).abs() < 1e-12, "lifetime={lifetime}");
    }

    #[test]
    fn message_drains_groups_deterministically_with_edge_cases() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("t.jsonl");
        let content = [
            // (a) assistant/tool lines BEFORE any real user message - implicit group 0.
            r#"{"type":"assistant","message":{"model":"claude-sonnet-4-5","usage":{"input_tokens":100,"output_tokens":10}}}"#,
            // First real user message.
            r#"{"type":"user","message":{"role":"user","content":"first question"}}"#,
            r#"{"type":"assistant","message":{"model":"claude-opus-4-8","usage":{"input_tokens":200,"output_tokens":20}}}"#,
            // (b) a tool_result user line mid-stream must NOT start a new group.
            r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"ok"}]}}"#,
            r#"{"type":"assistant","message":{"model":"claude-opus-4-8","usage":{"input_tokens":300,"output_tokens":30}}}"#,
            // Second real user message.
            r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"second question"}]}}"#,
            r#"{"type":"assistant","message":{"model":"claude-haiku-4-5","usage":{"input_tokens":50,"output_tokens":5}}}"#,
        ].join("\n");
        std::fs::write(&path, content).unwrap();

        let drains = message_drains(&path);
        // group 0 (pre-user) + 2 real user messages = 3 groups; the spec asks for
        // "exactly 2 groups" of real user messages, which we assert below.
        let user_groups: Vec<&MessageDrain> = drains.iter().filter(|d| d.index >= 1).collect();
        assert_eq!(user_groups.len(), 2, "exactly 2 real user message groups");
        assert_eq!(user_groups[0].index, 1);
        assert_eq!(user_groups[1].index, 2);
        assert_eq!(user_groups[0].preview, "first question");
        assert_eq!(user_groups[1].preview, "second question");
        assert!(!user_groups[0].preview.is_empty());

        // Group 1 swallows the tool_result-fenced assistant lines (200+20 and
        // 300+30 token turns), proving tool_result did not split it.
        assert_eq!(user_groups[0].tokens, 200 + 20 + 300 + 30);
        // Group 2 has only the haiku turn.
        assert_eq!(user_groups[1].tokens, 50 + 5);

        // Implicit group 0 is present and non-empty (it drained the leading line).
        let g0 = drains.iter().find(|d| d.index == 0).expect("pre-user group present");
        assert_eq!(g0.tokens, 100 + 10);
    }

    #[test]
    fn message_drains_no_preamble_has_no_group_zero() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("t.jsonl");
        let content = [
            r#"{"type":"user","message":{"role":"user","content":"hi"}}"#,
            r#"{"type":"assistant","message":{"model":"claude-sonnet-4-5","usage":{"input_tokens":10,"output_tokens":2}}}"#,
        ].join("\n");
        std::fs::write(&path, content).unwrap();
        let drains = message_drains(&path);
        assert!(drains.iter().all(|d| d.index >= 1), "no phantom group 0 for clean transcript");
        assert_eq!(drains.len(), 1);
        assert_eq!(drains[0].index, 1);
    }

    #[test]
    fn message_drains_missing_file_is_empty_not_panic() {
        let drains = message_drains(Path::new("definitely-missing.jsonl"));
        assert!(drains.is_empty());
    }

    #[test]
    fn mark_expensive_flags_outlier_and_top3() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("t.jsonl");
        // 4 user messages with wildly different opus output costs; one huge.
        let line = |text: &str, out: u64| {
            format!(
                "{}\n{}",
                serde_json::json!({"type":"user","message":{"role":"user","content":text}}),
                serde_json::json!({"type":"assistant","message":{"model":"claude-opus-4-8","usage":{"input_tokens":1,"output_tokens":out}}}),
            )
        };
        let content = [
            line("a", 10),
            line("b", 10),
            line("c", 10),
            line("d", 100000),
        ].join("\n");
        std::fs::write(&path, content).unwrap();
        let drains = message_drains(&path);
        let big = drains.iter().find(|d| d.preview == "d").unwrap();
        assert!(big.expensive, "the 100k-output message must be flagged expensive");
    }
}
