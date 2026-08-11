//! Daemon-owned "context window remaining" - the single source of truth for
//! how full a session's context window is. The frontend chip used to compute
//! this itself (`src/views/sessions/session-statusbar-helpers.ts`), which had a
//! null-model-default bug on early turns and no sticky correction. This module
//! ports the window heuristic EXACTLY, then layers a stateless sticky
//! correction on top, and exposes the result over IPC + the daemon hooks
//! server so every surface reads the same number.

use serde::Serialize;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use ts_rs::TS;

/// How full a session's context window is, computed from its transcript.
#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct ContextStatus {
    /// Model id from the last usage line that carries one (e.g. "claude-opus-4-8").
    pub model: String,
    /// Effective context window in tokens.
    pub window: u64,
    /// Current occupancy = the LAST usage line's occupancy (latest turn).
    pub occupancy: u64,
    /// window - occupancy, saturating at 0.
    pub remaining: u64,
    /// round(occupancy / window * 100), clamped 0..=100.
    pub pct_used: u8,
    /// 100 - pct_used.
    pub pct_left: u8,
    /// "proven" when the >200K sticky correction fired, else "heuristic".
    pub confidence: String,
}

/// Window heuristic, kept in sync with the frontend's `modelContextWindow`
/// (session-statusbar-helpers.ts):
///   claude-3*opus -> 200K; any other opus or fable -> 1M; sonnet-5/sonnet-4-6
///   -> 1M; everything else -> 200K.
/// Opus/fable use a blocklist (new versions default to 1M without a code
/// change); sonnet uses a narrow allowlist instead, since older sonnet
/// (4.0/4.5/3.x) isn't confirmed 1M by default and the sticky correction
/// below only ever raises the window, never lowers it.
fn model_window(model: &str) -> u64 {
    // /claude-3[^0-9]*opus/i : "claude-3" then non-digits then "opus".
    let lower = model.to_ascii_lowercase();
    if is_claude_3_opus(&lower) {
        return 200_000;
    }
    if lower.contains("opus") || lower.contains("fable") {
        return 1_000_000;
    }
    if lower.contains("sonnet-5") || lower.contains("sonnet-4-6") {
        return 1_000_000;
    }
    200_000
}

/// Rust port of the regex `/claude-3[^0-9]*opus/i` (already lowercased input).
/// Matches "claude-3", then a run of non-digit chars, then "opus".
fn is_claude_3_opus(lower: &str) -> bool {
    let Some(after) = lower.find("claude-3").map(|i| i + "claude-3".len()) else {
        return false;
    };
    let rest = &lower[after..];
    // Scan the non-digit run that follows, then require "opus" at its end-ish.
    // The regex allows "opus" anywhere inside that non-digit run, so search for
    // "opus" within the leading non-digit prefix of `rest`.
    let non_digit_prefix_end = rest
        .char_indices()
        .find(|(_, c)| c.is_ascii_digit())
        .map(|(i, _)| i)
        .unwrap_or(rest.len());
    rest[..non_digit_prefix_end].contains("opus")
}

/// Pure scoring with no file IO: given the per-line occupancies (in transcript
/// order) and the resolved model string, produce a ContextStatus. This is the
/// testable heart of the module; `compute_context_status` is just the IO shell
/// that feeds it.
///
/// - current occupancy = the LAST element (latest turn, NOT cumulative).
/// - max occupancy = the MAX across all elements (drives the sticky correction).
/// - window = model heuristic, then `max(window, 1_000_000)` if any single turn
///   ever exceeded 200K (proof the real window is at least 1M).
/// - confidence = "proven" when max occupancy > 200K, else "heuristic".
///
/// Returns None when there are no usage lines at all.
pub fn score_context(occupancies: &[u64], model: &str) -> Option<ContextStatus> {
    let occupancy = *occupancies.last()?;
    let max_occupancy = occupancies.iter().copied().max().unwrap_or(occupancy);

    let mut window = model_window(model);
    let sticky_fired = max_occupancy > 200_000;
    if sticky_fired {
        // Any single turn over 200K proves the window is at least 1M, regardless
        // of what the model-name heuristic guessed.
        window = window.max(1_000_000);
    }

    let remaining = window.saturating_sub(occupancy);
    let pct_used = if window == 0 {
        0u8
    } else {
        // round(occupancy / window * 100), clamped 0..=100.
        let raw = ((occupancy as f64) / (window as f64) * 100.0).round();
        raw.clamp(0.0, 100.0) as u8
    };
    let pct_left = 100u8.saturating_sub(pct_used);

    let confidence = if sticky_fired { "proven" } else { "heuristic" };

    Some(ContextStatus {
        model: model.to_string(),
        window,
        occupancy,
        remaining,
        pct_used,
        pct_left,
        confidence: confidence.to_string(),
    })
}

/// One usage line's contribution, extracted from a parsed JSONL value.
/// Returns `(occupancy, model)` where occupancy = input + cache_read +
/// cache_creation, and model is the message.model field if present. Returns
/// None for lines that carry no `message.usage.input_tokens` block.
fn usage_from_line(v: &serde_json::Value) -> Option<(u64, Option<String>)> {
    // Same lookup order as walker.rs: prefer message.usage, fall back to usage.
    let usage = v
        .get("message")
        .and_then(|m| m.get("usage"))
        .or_else(|| v.get("usage"))?;
    // Only count lines that actually carry input_tokens (a real usage block).
    let input = usage.get("input_tokens").and_then(|n| n.as_u64())?;
    let cache_read = usage
        .get("cache_read_input_tokens")
        .and_then(|n| n.as_u64())
        .unwrap_or(0);
    let cache_creation = usage
        .get("cache_creation_input_tokens")
        .and_then(|n| n.as_u64())
        .unwrap_or(0);
    let occupancy = input
        .saturating_add(cache_read)
        .saturating_add(cache_creation);

    // Model lives at message.model (assistant lines) with a top-level fallback.
    let model = v
        .get("message")
        .and_then(|m| m.get("model"))
        .or_else(|| v.get("model"))
        .and_then(|m| m.as_str())
        .map(|s| s.to_string());

    Some((occupancy, model))
}

/// Read a transcript JSONL and compute its ContextStatus. Robust to non-JSON
/// and non-usage lines; returns None when the file is missing/unreadable or has
/// no usage lines at all. Never panics.
pub fn compute_context_status(transcript_path: &Path) -> Option<ContextStatus> {
    let file = std::fs::File::open(transcript_path).ok()?;
    let reader = BufReader::new(file);

    let mut occupancies: Vec<u64> = Vec::new();
    // model = the model from the LAST usage line that has one (avoids the
    // frontend's null-default-on-early-turns bug, where the first assistant
    // line may omit the model).
    let mut model: Option<String> = None;

    for line in reader.lines().map_while(|r| r.ok()) {
        if line.trim().is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        let Some((occ, line_model)) = usage_from_line(&v) else {
            continue;
        };
        occupancies.push(occ);
        if let Some(m) = line_model {
            model = Some(m);
        }
    }

    score_context(&occupancies, model.as_deref().unwrap_or(""))
}

/// Resolve the transcript path for a session and compute its ContextStatus.
///
/// Resolution order:
///   1. If the session is in the daemon registry, use its cwd with
///      `transcript_for_session(cwd, session_id)`.
///   2. Otherwise scan `~/.claude/projects/*/<session_id>.jsonl` directly (the
///      session id is a unique UUID, so the filename match is sufficient).
///
/// Returns None if nothing resolves. Never panics.
pub fn context_status_for_session(
    registry: &crate::sessions::registry::Registry,
    session_id: &str,
) -> Option<ContextStatus> {
    if let Some(path) = resolve_transcript(registry, session_id) {
        return compute_context_status(&path);
    }
    None
}

/// Find the transcript file for `session_id`: registry cwd first, then a
/// filename scan of `~/.claude/projects/*/<session_id>.jsonl`.
fn resolve_transcript(
    registry: &crate::sessions::registry::Registry,
    session_id: &str,
) -> Option<PathBuf> {
    use crate::tokens::walker;

    // 1. Registry: an Instance for this session knows its cwd.
    if let Some(inst) = registry.get(session_id) {
        // Prefer an explicit transcript_path if the registry has one.
        if let Some(tp) = inst.transcript_path.as_ref() {
            if tp.exists() {
                return Some(tp.clone());
            }
        }
        if let Some(path) = walker::transcript_for_session(&inst.cwd, session_id) {
            return Some(path);
        }
    }

    // 2. Fallback: scan all project dirs for <session_id>.jsonl.
    let projects = walker::claude_projects_dir()?;
    let target = format!("{session_id}.jsonl");
    let entries = std::fs::read_dir(&projects).ok()?;
    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let candidate = dir.join(&target);
        if candidate.exists() {
            return Some(candidate);
        }
    }
    None
}

/// Resolves a session's transcript path from the app's mirrored instance
/// cache. The daemon registry isn't directly reachable here; `cached_instances`
/// is the app-side mirror refreshed via `instances_changed`.
fn resolve_session_transcript(
    state: &crate::state::AppState,
    session_id: &str,
) -> Option<std::path::PathBuf> {
    use crate::tokens::walker;

    let instances = state.cached_instances.lock().unwrap();
    instances
        .iter()
        .find(|i| i.session_id == session_id)
        .and_then(|inst| {
            inst.transcript_path
                .as_ref()
                .filter(|p| p.exists())
                .cloned()
                .or_else(|| walker::transcript_for_session(&inst.cwd, session_id))
        })
}

/// Fallback for when the mirrored instance cache doesn't resolve a transcript:
/// scans `~/.claude/projects/*/<session_id>.jsonl` directly. Blocking - call
/// from within `spawn_blocking`.
fn scan_projects_for_session(session_id: &str) -> Option<std::path::PathBuf> {
    use crate::tokens::walker;

    let projects = walker::claude_projects_dir()?;
    let target = format!("{session_id}.jsonl");
    let entries = std::fs::read_dir(&projects).ok()?;
    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let candidate = dir.join(&target);
        if candidate.exists() {
            return Some(candidate);
        }
    }
    None
}

/// Daemon-aligned context-window status for a session. The transcript lives on
/// local disk, so the app resolves it itself (cwd from the mirrored instance
/// cache, else a project-dir scan) and runs the same core scorer the daemon's
/// `/context` endpoint uses. Returns None when unresolved or no usage lines.
#[tauri::command]
pub async fn context_status(
    session_id: String,
    state: tauri::State<'_, crate::state::AppState>,
) -> Result<Option<ContextStatus>, String> {
    let resolved = resolve_session_transcript(&state, &session_id);

    let status = tauri::async_runtime::spawn_blocking(move || {
        if let Some(path) = resolved {
            return compute_context_status(&path);
        }
        // Fallback: scan ~/.claude/projects/*/<session_id>.jsonl directly.
        let candidate = scan_projects_for_session(&session_id)?;
        compute_context_status(&candidate)
    })
    .await
    .map_err(|e| format!("context_status join error: {e}"))?;

    Ok(status)
}

/// Scans a transcript for the most recent line carrying a non-empty `cwd`
/// (`last-prompt`/`mode` rows omit it), reading from the end so large
/// transcripts stay cheap. This is where the session is *actually* operating,
/// which differs from the daemon-recorded spawn dir once inside a worktree.
fn last_transcript_cwd(path: &std::path::Path) -> Option<String> {
    let content = std::fs::read_to_string(path).ok()?;
    for line in content.lines().rev() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
            if let Some(cwd) = v.get("cwd").and_then(|c| c.as_str()) {
                if !cwd.is_empty() {
                    return Some(cwd.to_string());
                }
            }
        }
    }
    None
}

/// Returns the session's *live* working directory - the last `cwd` recorded in
/// its transcript - so git chips can follow the AI into a worktree instead of
/// pinning to the spawn dir. Falls back to `fallback` (spawn cwd) when
/// unresolved, so callers always get a usable directory.
#[tauri::command]
pub async fn session_live_cwd(
    session_id: String,
    fallback: String,
    state: tauri::State<'_, crate::state::AppState>,
) -> Result<String, String> {
    let resolved = resolve_session_transcript(&state, &session_id);

    let cwd = tauri::async_runtime::spawn_blocking(move || -> Option<String> {
        let path = resolved.or_else(|| scan_projects_for_session(&session_id))?;
        last_transcript_cwd(&path)
    })
    .await
    .map_err(|e| format!("session_live_cwd join error: {e}"))?;

    Ok(cwd.unwrap_or(fallback))
}

#[cfg(test)]
mod live_cwd_tests {
    use super::last_transcript_cwd;
    use std::io::Write;

    fn write_tmp(name: &str, body: &str) -> std::path::PathBuf {
        let mut path = std::env::temp_dir();
        path.push(format!("cc_livecwd_{name}.jsonl"));
        let mut f = std::fs::File::create(&path).unwrap();
        f.write_all(body.as_bytes()).unwrap();
        path
    }

    #[test]
    fn returns_last_line_cwd() {
        let path = write_tmp(
            "last",
            "{\"type\":\"user\",\"cwd\":\"C:\\\\repo\"}\n\
             {\"type\":\"assistant\",\"cwd\":\"C:\\\\repo\\\\wt\"}\n",
        );
        assert_eq!(last_transcript_cwd(&path).as_deref(), Some("C:\\repo\\wt"));
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn skips_trailing_lines_without_cwd() {
        // `last-prompt`/`mode` rows carry no cwd; the scan must fall back to the
        // most recent line that does.
        let path = write_tmp(
            "skip",
            "{\"type\":\"assistant\",\"cwd\":\"C:\\\\repo\\\\wt\"}\n\
             {\"type\":\"last-prompt\"}\n\
             {\"type\":\"mode\"}\n",
        );
        assert_eq!(last_transcript_cwd(&path).as_deref(), Some("C:\\repo\\wt"));
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn none_when_no_cwd_anywhere() {
        let path = write_tmp("nocwd", "{\"type\":\"mode\"}\n{\"type\":\"summary\"}\n");
        assert_eq!(last_transcript_cwd(&path), None);
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn ignores_empty_cwd_and_blank_lines() {
        let path = write_tmp(
            "empty",
            "{\"type\":\"user\",\"cwd\":\"C:\\\\repo\"}\n\n{\"type\":\"assistant\",\"cwd\":\"\"}\n",
        );
        assert_eq!(last_transcript_cwd(&path).as_deref(), Some("C:\\repo"));
        std::fs::remove_file(&path).ok();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_heuristic_claude_3_opus_is_200k() {
        let s = score_context(&[1_000], "claude-3-opus-20240229").unwrap();
        assert_eq!(s.window, 200_000);
        assert_eq!(s.confidence, "heuristic");
    }

    #[test]
    fn window_heuristic_opus_4_is_1m() {
        let s = score_context(&[1_000], "claude-opus-4-8").unwrap();
        assert_eq!(s.window, 1_000_000);
        assert_eq!(s.confidence, "heuristic");
    }

    #[test]
    fn window_heuristic_unknown_non_opus_is_200k() {
        let s = score_context(&[1_000], "claude-sonnet-4-5").unwrap();
        assert_eq!(s.window, 200_000);
        let s2 = score_context(&[1_000], "some-mystery-model").unwrap();
        assert_eq!(s2.window, 200_000);
    }

    #[test]
    fn window_heuristic_fable_5_is_1m() {
        let s = score_context(&[1_000], "claude-fable-5").unwrap();
        assert_eq!(s.window, 1_000_000);
        assert_eq!(s.confidence, "heuristic");
    }

    #[test]
    fn window_heuristic_sonnet_5_and_sonnet_4_6_are_1m() {
        let s = score_context(&[1_000], "claude-sonnet-5").unwrap();
        assert_eq!(s.window, 1_000_000);
        let s2 = score_context(&[1_000], "claude-sonnet-4-6").unwrap();
        assert_eq!(s2.window, 1_000_000);
    }

    #[test]
    fn window_heuristic_older_sonnet_stays_200k() {
        // Sonnet 4.0/4.5's default (non-beta) window isn't confirmed 1M, so
        // only sonnet-5 and sonnet-4-6 are allowlisted.
        let s = score_context(&[1_000], "claude-sonnet-4-0").unwrap();
        assert_eq!(s.window, 200_000);
        let s2 = score_context(&[1_000], "claude-sonnet-4-5").unwrap();
        assert_eq!(s2.window, 200_000);
    }

    #[test]
    fn sticky_correction_forces_1m_even_for_unknown_model() {
        // Unknown model would heuristic to 200K, but a turn over 200K proves
        // the real window is at least 1M, and confidence becomes "proven".
        let s = score_context(&[50_000, 250_000, 120_000], "totally-unknown").unwrap();
        assert_eq!(s.window, 1_000_000);
        assert_eq!(s.confidence, "proven");
    }

    #[test]
    fn sticky_correction_does_not_lower_an_already_1m_window() {
        let s = score_context(&[250_000], "claude-opus-4-8").unwrap();
        assert_eq!(s.window, 1_000_000);
        assert_eq!(s.confidence, "proven");
    }

    #[test]
    fn occupancy_is_latest_line_not_cumulative() {
        // Three usage lines: current = last (300K), max = 300K for sticky.
        let s = score_context(&[100_000, 200_000, 300_000], "unknown").unwrap();
        assert_eq!(s.occupancy, 300_000, "current occupancy is the LAST line");
        // max occupancy (300K > 200K) forces the 1M window via sticky.
        assert_eq!(s.window, 1_000_000);
        assert_eq!(s.confidence, "proven");
    }

    #[test]
    fn max_drives_sticky_even_when_last_line_is_small() {
        // Last line is small (under 200K) but an earlier turn peaked over 200K.
        let s = score_context(&[250_000, 30_000], "unknown").unwrap();
        assert_eq!(s.occupancy, 30_000, "current = last line");
        assert_eq!(s.window, 1_000_000, "max turn over 200K still forces 1M");
        assert_eq!(s.confidence, "proven");
    }

    #[test]
    fn remaining_and_pct_math() {
        // occupancy 250K, window 1M -> pct_used 25, remaining 750K.
        let s = score_context(&[250_000], "claude-opus-4-8").unwrap();
        assert_eq!(s.window, 1_000_000);
        assert_eq!(s.occupancy, 250_000);
        assert_eq!(s.remaining, 750_000);
        assert_eq!(s.pct_used, 25);
        assert_eq!(s.pct_left, 75);
    }

    #[test]
    fn pct_used_clamps_and_remaining_saturates_when_over_window() {
        // Occupancy beyond the window: pct_used clamps to 100, remaining to 0.
        // Use a 1M window (claude-opus-4-8) with occupancy past it, since any
        // occupancy over 200K forces window to 1M via the sticky rule, so a
        // 200K window can never legitimately be exceeded.
        let s = score_context(&[1_200_000], "claude-opus-4-8").unwrap();
        assert_eq!(s.window, 1_000_000);
        assert_eq!(s.pct_used, 100);
        assert_eq!(s.pct_left, 0);
        assert_eq!(s.remaining, 0);
    }

    #[test]
    fn empty_occupancies_returns_none() {
        assert!(score_context(&[], "claude-opus-4-8").is_none());
    }

    #[test]
    fn compute_context_status_reads_jsonl_fixture() {
        use std::io::Write;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sess.jsonl");
        let mut f = std::fs::File::create(&path).unwrap();
        // user line (no usage) + 2 assistant usage lines + a junk line.
        writeln!(f, r#"{{"type":"user","message":{{"content":"hi"}}}}"#).unwrap();
        writeln!(
            f,
            r#"{{"type":"assistant","message":{{"model":"claude-opus-4-8","usage":{{"input_tokens":10000,"cache_read_input_tokens":40000,"cache_creation_input_tokens":50000}}}}}}"#
        )
        .unwrap();
        writeln!(f, "not json").unwrap();
        // Last usage line: occupancy = 200000 + 40000 + 10000 = 250000.
        writeln!(
            f,
            r#"{{"type":"assistant","message":{{"model":"claude-opus-4-8","usage":{{"input_tokens":200000,"cache_read_input_tokens":40000,"cache_creation_input_tokens":10000}}}}}}"#
        )
        .unwrap();
        drop(f);

        let s = compute_context_status(&path).unwrap();
        assert_eq!(s.model, "claude-opus-4-8");
        assert_eq!(s.occupancy, 250_000, "current = last usage line");
        assert_eq!(s.window, 1_000_000);
        assert_eq!(s.remaining, 750_000);
        assert_eq!(s.pct_used, 25);
        assert_eq!(s.confidence, "proven");
    }

    #[test]
    fn compute_context_status_missing_file_returns_none() {
        assert!(compute_context_status(Path::new("definitely-not-real.jsonl")).is_none());
    }

    #[test]
    fn compute_context_status_no_usage_lines_returns_none() {
        use std::io::Write;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nousage.jsonl");
        let mut f = std::fs::File::create(&path).unwrap();
        writeln!(f, r#"{{"type":"user","message":{{"content":"hi"}}}}"#).unwrap();
        writeln!(f, r#"{{"type":"summary","summary":"x"}}"#).unwrap();
        drop(f);
        assert!(compute_context_status(&path).is_none());
    }

    #[test]
    fn model_resolved_from_last_usage_line_with_a_model() {
        // First usage line has no model (the early-turn bug case); the second
        // does. We must pick up the later model, not default to empty/null.
        use std::io::Write;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("model.jsonl");
        let mut f = std::fs::File::create(&path).unwrap();
        writeln!(
            f,
            r#"{{"type":"assistant","message":{{"usage":{{"input_tokens":5000}}}}}}"#
        )
        .unwrap();
        writeln!(
            f,
            r#"{{"type":"assistant","message":{{"model":"claude-opus-4-8","usage":{{"input_tokens":6000}}}}}}"#
        )
        .unwrap();
        drop(f);
        let s = compute_context_status(&path).unwrap();
        assert_eq!(s.model, "claude-opus-4-8");
        assert_eq!(s.window, 1_000_000);
    }
}
