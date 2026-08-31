use anyhow::Result;
use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::Connection;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use super::record::{BackfillResult, TokenRecord};
use super::walker::{claude_projects_dir, decode_cwd, parse_transcript, walk_jsonl};
use crate::storage::token_store;

fn iso_date(t: std::time::SystemTime) -> String {
    DateTime::<Utc>::from(t).format("%Y-%m-%d").to_string()
}

fn iso(t: std::time::SystemTime) -> String {
    DateTime::<Utc>::from(t).to_rfc3339_opts(SecondsFormat::Secs, true)
}

fn file_stamps(path: &Path) -> (String, String, String) {
    if let Ok(meta) = std::fs::metadata(path) {
        let modified = meta.modified().unwrap_or_else(|_| std::time::SystemTime::now());
        let created = meta.created().unwrap_or(modified);
        return (iso_date(modified), iso(created), iso(modified));
    }
    let now = Utc::now();
    let iso_now = now.to_rfc3339_opts(SecondsFormat::Secs, true);
    (now.format("%Y-%m-%d").to_string(), iso_now.clone(), iso_now)
}

/// Walk the Claude projects dir and append any session not yet recorded.
/// Subagent transcripts (files under a `subagents/` subdir) get summed into
/// their parent session record instead of getting their own.
///
/// Reads and writes `token_records` directly. It used to round-trip through
/// `token-history.json`, which the startup migration then re-imported wholesale
/// on every launch - see `storage::migration::retire_token_history_json`.
pub fn backfill_all(conn: &mut Connection) -> Result<BackfillResult> {
    let Some(projects_dir) = claude_projects_dir() else {
        return Ok(BackfillResult::default());
    };
    let files = walk_jsonl(&projects_dir);

    let mut regular: Vec<PathBuf> = Vec::new();
    let mut subagent: Vec<PathBuf> = Vec::new();
    for p in files {
        let in_subagents = p
            .parent()
            .and_then(|d| d.file_name())
            .and_then(|n| n.to_str())
            == Some("subagents");
        if in_subagents { subagent.push(p) } else { regular.push(p) }
    }

    let mut history = token_store::get_token_records(conn, 0)?;
    let mut known_ids: HashSet<String> =
        history.iter().map(|r| r.session_id.clone()).collect();
    // Only these sessions get written back, so a Stop-hook row landing in the
    // table while this walk runs is not clobbered by our stale copy.
    let mut dirty: HashSet<String> = HashSet::new();

    let mut result = BackfillResult::default();

    for file in &regular {
        let Some(session_id) = file.file_stem().and_then(|s| s.to_str()).map(String::from) else {
            continue;
        };
        if known_ids.contains(&session_id) { result.skipped += 1; continue }

        let project_dir_name = file
            .parent()
            .and_then(|d| d.file_name())
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();
        let cwd = decode_cwd(&project_dir_name);
        let (date, started_at, last_active_at) = file_stamps(file);
        let totals = parse_transcript(file);
        let now = Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true);

        history.push(TokenRecord {
            session_id: session_id.clone(),
            cwd: Some(cwd),
            date,
            input_tokens: totals.input_tokens,
            output_tokens: totals.output_tokens,
            cache_read_tokens: totals.cache_read_tokens,
            cache_creation_tokens: totals.cache_creation_tokens,
            turns: totals.turns,
            started_at,
            last_active_at,
            recorded_at: now,
            live: None,
            merged_subagents: None,
            // Backfill reads historical transcripts offline, with no live
            // `Instance` to read a kind from - stays "unknown", never guessed.
            kind: None,
        });
        known_ids.insert(session_id.clone());
        dirty.insert(session_id);
        result.processed += 1;
    }

    let mut merged_agent_ids: HashSet<String> = HashSet::new();
    for r in &history {
        if let Some(list) = &r.merged_subagents {
            for id in list { merged_agent_ids.insert(id.clone()); }
        }
    }

    for file in &subagent {
        let Some(agent_id) = file.file_stem().and_then(|s| s.to_str()).map(String::from) else {
            continue;
        };
        if merged_agent_ids.contains(&agent_id) { result.sub_skipped += 1; continue }

        let parent_session_id = file
            .parent()
            .and_then(|d| d.parent())
            .and_then(|d| d.file_name())
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();
        let encoded_project_dir = file
            .parent()
            .and_then(|d| d.parent())
            .and_then(|d| d.parent())
            .and_then(|d| d.file_name())
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();
        let cwd = decode_cwd(&encoded_project_dir);
        let (date, started_at, last_active_at) = file_stamps(file);
        let totals = parse_transcript(file);

        let idx = history.iter().position(|r| r.session_id == parent_session_id);
        let parent_idx = match idx {
            Some(i) => i,
            None => {
                let now = Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true);
                history.push(TokenRecord {
                    session_id: parent_session_id.clone(),
                    cwd: Some(cwd),
                    date: date.clone(),
                    input_tokens: 0,
                    output_tokens: 0,
                    cache_read_tokens: 0,
                    cache_creation_tokens: 0,
                    turns: 0,
                    started_at: started_at.clone(),
                    last_active_at: last_active_at.clone(),
                    recorded_at: now,
                    live: None,
                    merged_subagents: Some(Vec::new()),
                    kind: None,
                });
                history.len() - 1
            }
        };

        let p = &mut history[parent_idx];
        p.input_tokens += totals.input_tokens;
        p.output_tokens += totals.output_tokens;
        p.cache_read_tokens += totals.cache_read_tokens;
        p.cache_creation_tokens += totals.cache_creation_tokens;
        p.turns += totals.turns;
        if started_at < p.started_at || p.started_at.is_empty() {
            p.started_at = started_at;
        }
        if last_active_at > p.last_active_at {
            p.last_active_at = last_active_at;
        }
        let list = p.merged_subagents.get_or_insert_with(Vec::new);
        list.push(agent_id.clone());
        merged_agent_ids.insert(agent_id);
        dirty.insert(parent_session_id);
        result.sub_processed += 1;
    }

    token_store::upsert_records(conn, &history, &dirty)?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::walker::{walk_jsonl, parse_transcript};
    use crate::storage::db::init_schema;
    use tempfile::tempdir;

    fn test_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        init_schema(&conn).unwrap();
        conn
    }

    /// A `backfill_all`-style helper that takes an explicit projects dir so
    /// we can unit-test the aggregation without reaching out to `~/.claude`.
    /// Mirrors production's read-modify-`upsert_records` shape, `dirty` set
    /// included, so the store round-trip is exercised and not just the math.
    fn backfill_from(projects_dir: &Path, conn: &mut Connection) -> BackfillResult {
        let files = walk_jsonl(projects_dir);
        let mut regular = Vec::new();
        let mut subagent = Vec::new();
        for p in files {
            let in_sub = p.parent().and_then(|d| d.file_name()).and_then(|n| n.to_str())
                == Some("subagents");
            if in_sub { subagent.push(p) } else { regular.push(p) }
        }

        let mut history = token_store::get_token_records(conn, 0).unwrap();
        let mut known: HashSet<String> = history.iter().map(|r| r.session_id.clone()).collect();
        let mut dirty: HashSet<String> = HashSet::new();
        let mut result = BackfillResult::default();

        for file in &regular {
            let sid = file.file_stem().and_then(|s| s.to_str()).unwrap().to_string();
            if known.contains(&sid) { result.skipped += 1; continue }
            let totals = parse_transcript(file);
            history.push(TokenRecord {
                session_id: sid.clone(),
                cwd: Some("C:\\fake".into()),
                date: "2026-04-20".into(),
                input_tokens: totals.input_tokens,
                output_tokens: totals.output_tokens,
                cache_read_tokens: totals.cache_read_tokens,
                cache_creation_tokens: totals.cache_creation_tokens,
                turns: totals.turns,
                started_at: "2026-04-20T10:00:00Z".into(),
                last_active_at: "2026-04-20T10:30:00Z".into(),
                recorded_at: "2026-04-20T10:31:00Z".into(),
                live: None,
                merged_subagents: None,
                kind: None,
            });
            known.insert(sid.clone());
            dirty.insert(sid);
            result.processed += 1;
        }

        let mut merged_ids: HashSet<String> = HashSet::new();
        for r in &history {
            if let Some(l) = &r.merged_subagents { for id in l { merged_ids.insert(id.clone()); } }
        }
        for file in &subagent {
            let agent_id = file.file_stem().and_then(|s| s.to_str()).unwrap().to_string();
            if merged_ids.contains(&agent_id) { result.sub_skipped += 1; continue }
            let parent_sid = file
                .parent().and_then(|d| d.parent())
                .and_then(|d| d.file_name()).and_then(|n| n.to_str()).unwrap().to_string();
            let totals = parse_transcript(file);
            let idx = history.iter().position(|r| r.session_id == parent_sid);
            let idx = idx.unwrap_or_else(|| {
                history.push(TokenRecord {
                    session_id: parent_sid.clone(),
                    cwd: Some("C:\\fake".into()),
                    date: "2026-04-20".into(),
                    started_at: "2026-04-20T09:00:00Z".into(),
                    last_active_at: "2026-04-20T09:00:00Z".into(),
                    recorded_at: "2026-04-20T09:00:00Z".into(),
                    merged_subagents: Some(Vec::new()),
                    ..Default::default()
                });
                history.len() - 1
            });
            let p = &mut history[idx];
            p.input_tokens += totals.input_tokens;
            p.output_tokens += totals.output_tokens;
            p.cache_read_tokens += totals.cache_read_tokens;
            p.cache_creation_tokens += totals.cache_creation_tokens;
            p.turns += totals.turns;
            p.merged_subagents.get_or_insert_with(Vec::new).push(agent_id.clone());
            merged_ids.insert(agent_id);
            dirty.insert(parent_sid);
            result.sub_processed += 1;
        }

        token_store::upsert_records(conn, &history, &dirty).unwrap();
        result
    }

    #[test]
    fn backfill_aggregates_and_merges_subagents() {
        let dir = tempdir().unwrap();
        let projects = dir.path().join("projects");
        let mut conn = test_conn();

        let proj_a = projects.join("proj-a");
        std::fs::create_dir_all(&proj_a).unwrap();
        std::fs::write(
            proj_a.join("SESSION-1.jsonl"),
            r#"{"type":"assistant","message":{"usage":{"input_tokens":10,"output_tokens":20}}}"#,
        ).unwrap();

        let sub_dir = proj_a.join("SESSION-1").join("subagents");
        std::fs::create_dir_all(&sub_dir).unwrap();
        std::fs::write(
            sub_dir.join("AGENT-X.jsonl"),
            r#"{"type":"assistant","message":{"usage":{"input_tokens":5,"output_tokens":1}}}"#,
        ).unwrap();

        let r = backfill_from(&projects, &mut conn);
        assert_eq!(r.processed, 1);
        assert_eq!(r.sub_processed, 1);

        let history = token_store::get_token_records(&conn, 0).unwrap();
        assert_eq!(history.len(), 1, "subagent should be merged into parent");
        let s1 = history.iter().find(|r| r.session_id == "SESSION-1").unwrap();
        assert_eq!(s1.input_tokens, 15, "10 (main) + 5 (sub) input tokens");
        assert_eq!(s1.output_tokens, 21, "20 (main) + 1 (sub) output tokens");
        assert_eq!(s1.merged_subagents.as_ref().unwrap(), &vec!["AGENT-X".to_string()]);

        let r2 = backfill_from(&projects, &mut conn);
        assert_eq!(r2.processed, 0);
        assert_eq!(r2.skipped, 1);
        assert_eq!(r2.sub_processed, 0);
        assert_eq!(r2.sub_skipped, 1);
        let history2 = token_store::get_token_records(&conn, 0).unwrap();
        assert_eq!(history2.len(), 1, "re-backfill must not duplicate");
        let s1b = history2.iter().find(|r| r.session_id == "SESSION-1").unwrap();
        assert_eq!(s1b.input_tokens, 15, "tokens stable across re-backfill");
    }

    /// The regression this whole change exists for: the retired path re-imported
    /// the legacy JSON on every launch, so the row count grew without bound.
    #[test]
    fn repeated_backfill_never_grows_the_row_count() {
        let dir = tempdir().unwrap();
        let projects = dir.path().join("proj-b");
        std::fs::create_dir_all(projects.join("p")).unwrap();
        std::fs::write(
            projects.join("p").join("SESSION-9.jsonl"),
            r#"{"type":"assistant","message":{"usage":{"input_tokens":7,"output_tokens":3}}}"#,
        ).unwrap();
        let mut conn = test_conn();

        for _ in 0..5 {
            backfill_from(&projects, &mut conn);
        }
        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM token_records", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 1, "five backfills must leave exactly one row");
    }

    /// `upsert_records` is scoped to `dirty` so a row written by the Stop hook
    /// mid-walk is not clobbered by backfill's stale in-memory copy.
    #[test]
    fn backfill_leaves_a_concurrently_written_session_alone() {
        let dir = tempdir().unwrap();
        let projects = dir.path().join("proj-c");
        std::fs::create_dir_all(projects.join("p")).unwrap();
        std::fs::write(
            projects.join("p").join("SESSION-A.jsonl"),
            r#"{"type":"assistant","message":{"usage":{"input_tokens":1,"output_tokens":1}}}"#,
        ).unwrap();
        let mut conn = test_conn();

        let hook_row = TokenRecord {
            session_id: "SESSION-HOOK".into(),
            date: "2026-04-20".into(),
            input_tokens: 4242,
            turns: 9,
            recorded_at: "2026-04-20T10:00:00Z".into(),
            ..Default::default()
        };
        token_store::insert_token_record(&conn, &hook_row).unwrap();

        backfill_from(&projects, &mut conn);

        let history = token_store::get_token_records(&conn, 0).unwrap();
        let survived = history.iter().find(|r| r.session_id == "SESSION-HOOK").unwrap();
        assert_eq!(survived.input_tokens, 4242, "untouched session must survive");
        assert_eq!(history.len(), 2);
    }
}

