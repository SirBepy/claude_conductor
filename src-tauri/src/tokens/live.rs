use chrono::{DateTime, SecondsFormat, Utc};
use std::collections::HashSet;
use std::path::Path;
use super::record::TokenRecord;
use super::aggregate::load_history;
use super::walker::{claude_projects_dir, decode_cwd, parse_transcript};

fn iso_date(t: std::time::SystemTime) -> String {
    DateTime::<Utc>::from(t).format("%Y-%m-%d").to_string()
}

fn iso(t: std::time::SystemTime) -> String {
    DateTime::<Utc>::from(t).to_rfc3339_opts(SecondsFormat::Secs, true)
}

/// Find JSONL files modified in the last 12 hours whose session hasn't been
/// persisted yet — the dashboard uses this to surface in-progress work. Loads
/// the persisted history from the legacy JSONL file; kept for callers/tests
/// that still pass a path. The live IPC path uses
/// [`active_sessions_from_history`] with records loaded from the SQLite store.
pub fn active_sessions(history_path: &Path) -> Vec<TokenRecord> {
    active_sessions_from_history(&load_history(history_path))
}

/// Same scan as [`active_sessions`] but takes the already-loaded persisted
/// history (source-agnostic). The IPC layer feeds DB-loaded records here so the
/// "already persisted" exclusion works against the SQLite store, not the file.
pub fn active_sessions_from_history(history: &[TokenRecord]) -> Vec<TokenRecord> {
    let known_ids: HashSet<String> =
        history.iter().map(|r| r.session_id.clone()).collect();

    let Some(projects_dir) = claude_projects_dir() else { return vec![] };
    let cutoff = std::time::SystemTime::now()
        .checked_sub(std::time::Duration::from_secs(12 * 3600))
        .unwrap_or_else(std::time::SystemTime::now);

    let mut results = Vec::new();
    let Ok(project_entries) = std::fs::read_dir(&projects_dir) else { return vec![] };
    for proj_entry in project_entries.flatten() {
        if !proj_entry.path().is_dir() { continue }
        let proj_name = proj_entry.file_name().to_string_lossy().to_string();
        let Ok(entries) = std::fs::read_dir(proj_entry.path()) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() { continue }
            if path.extension().and_then(|s| s.to_str()) != Some("jsonl") { continue }
            let Some(session_id) = path.file_stem().and_then(|s| s.to_str()).map(String::from) else {
                continue;
            };
            if known_ids.contains(&session_id) { continue }

            let Ok(meta) = entry.metadata() else { continue };
            let modified = meta.modified().unwrap_or_else(|_| std::time::SystemTime::now());
            if modified < cutoff { continue }
            let created = meta.created().unwrap_or(modified);
            let totals = parse_transcript(&path);
            results.push(TokenRecord {
                session_id,
                cwd: Some(decode_cwd(&proj_name)),
                date: iso_date(modified),
                input_tokens: totals.input_tokens,
                output_tokens: totals.output_tokens,
                cache_read_tokens: totals.cache_read_tokens,
                cache_creation_tokens: totals.cache_creation_tokens,
                turns: totals.turns,
                started_at: iso(created),
                last_active_at: iso(modified),
                recorded_at: Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true),
                live: Some(true),
                merged_subagents: None,
                // Scans transcripts off disk, with no `Instance` to read a kind
                // from - stays "unknown" rather than guessed.
                kind: None,
            });
        }
    }
    results
}
