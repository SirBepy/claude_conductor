use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use super::record::TokenTotals;

// multi-account audit: stays valid - `projects/` is junctioned into every
// profile dir, so token-history walking sees every account's transcripts in
// this one shared tree.
pub(crate) fn claude_projects_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".claude").join("projects"))
}

/// Claude CLI names its per-project transcript dir by replacing every
/// non-alphanumeric character in the absolute cwd with `-`. Verified
/// against real directories on disk (e.g. `c:\Users\tecno\Desktop\...\
/// claude_usage_in_taskbar` → `c--Users-tecno-Desktop-...-claude-usage-
/// in-taskbar`, `C:\Users\tecno\.claude` → `C--Users-tecno--claude`).
pub fn encode_cwd_as_project_dir(cwd: &Path) -> String {
    cwd.to_string_lossy()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

/// Resolves the transcript file named after a specific session id.
/// Returns `Some(path)` only if the file actually exists. Use this
/// in preference to `latest_transcript_for_cwd` when a session_id is
/// known: two concurrent sessions share a cwd, so the "latest"
/// helper would return the same file for both and the dashboard
/// would show identical stats.
pub fn transcript_for_session(cwd: &Path, session_id: &str) -> Option<PathBuf> {
    let projects = claude_projects_dir()?;
    let path = projects
        .join(encode_cwd_as_project_dir(cwd))
        .join(format!("{session_id}.jsonl"));
    if path.exists() { Some(path) } else { None }
}

/// Resolves the transcript Claude CLI is writing *right now* for a
/// given cwd. A single CLI process can rotate through multiple
/// transcripts when the user runs `/compact` or `/clear`, and
/// `~/.claude/sessions/<pid>.json` keeps the stale initial sessionId,
/// so we cannot rely on sessionId to locate the file. Instead we read
/// `~/.claude/projects/<encoded-cwd>/` and return the most recently
/// modified `.jsonl` - that's the live transcript by construction.
///
/// WARNING: this returns the same path for every session that shares
/// `cwd`. Only safe when the caller has a single session in mind.
/// Use `transcript_for_session` when you have a session_id.
pub fn latest_transcript_for_cwd(cwd: &Path) -> Option<PathBuf> {
    let projects = claude_projects_dir()?;
    let dir = projects.join(encode_cwd_as_project_dir(cwd));
    let entries = std::fs::read_dir(&dir).ok()?;
    let mut best: Option<(std::time::SystemTime, PathBuf)> = None;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("jsonl") { continue; }
        let Ok(meta) = entry.metadata() else { continue };
        let Ok(mtime) = meta.modified() else { continue };
        match &best {
            Some((t, _)) if *t >= mtime => {}
            _ => best = Some((mtime, path)),
        }
    }
    best.map(|(_, p)| p)
}

/// Recursively collect every `.jsonl` file under `dir`. Unreadable subdirs
/// are skipped silently — matches the Electron implementation's `try/catch`
/// around `fs.readdirSync`.
pub fn walk_jsonl(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else { return out };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            out.extend(walk_jsonl(&path));
        } else if path.extension().and_then(|s| s.to_str()) == Some("jsonl") {
            out.push(path);
        }
    }
    out
}

/// Best-effort decode of a Claude project directory name back to its real
/// filesystem path. Claude encodes all of `/ \ _ space :` as `-`, so the
/// reverse direction has to probe the actual filesystem to find which `-`
/// was which separator.
///
/// Ported from `src/core/path-decoder.js`. Strategy: at each level, read the
/// real directory, then greedy-match the most remaining dashed segments.
pub fn decode_cwd(encoded: &str) -> String {
    let sep: char = if cfg!(windows) { '\\' } else { '/' };
    let (mut current_path, raw_parts): (String, Vec<&str>) = if cfg!(windows) {
        if let Some(drive_sep) = encoded.find("--") {
            let drive = &encoded[..drive_sep];
            let rest = &encoded[drive_sep + 2..];
            (format!("{drive}:{sep}"), rest.split('-').collect())
        } else {
            return encoded.to_string();
        }
    } else {
        ("/".to_string(), encoded.split('-').collect())
    };

    let mut parts: Vec<String> = Vec::with_capacity(raw_parts.len());
    let mut i = 0;
    while i < raw_parts.len() {
        if raw_parts[i].is_empty() && i + 1 < raw_parts.len() {
            parts.push(format!(".{}", raw_parts[i + 1]));
            i += 2;
        } else {
            parts.push(raw_parts[i].to_string());
            i += 1;
        }
    }

    let norm = |s: &str| -> String {
        s.chars()
            .flat_map(|c| c.to_lowercase())
            .map(|c| match c {
                '-' | '_' | ' ' => '\0',
                other => other,
            })
            .collect()
    };

    let mut i = 0;
    while i < parts.len() {
        let mut matched = false;
        if let Ok(entries) = std::fs::read_dir(&current_path) {
            let entry_map: std::collections::HashMap<String, String> = entries
                .flatten()
                .filter_map(|e| {
                    e.file_name().to_str().map(|s| (norm(s), s.to_string()))
                })
                .collect();
            let remaining = parts.len() - i;
            for n in (1..=remaining).rev() {
                let candidate = norm(&parts[i..i + n].join("-"));
                if let Some(real) = entry_map.get(&candidate) {
                    if !current_path.ends_with(sep) {
                        current_path.push(sep);
                    }
                    current_path.push_str(real);
                    i += n;
                    matched = true;
                    break;
                }
            }
        }
        if !matched {
            if !current_path.ends_with(sep) {
                current_path.push(sep);
            }
            current_path.push_str(&parts[i]);
            i += 1;
        }
    }

    current_path
}

/// Sum assistant-turn token counts from a Claude Code transcript.
/// Malformed or missing files yield a zero-filled record (never panic).
pub fn parse_transcript(path: &Path) -> TokenTotals {
    let mut acc = TokenTotals::default();
    let Ok(file) = std::fs::File::open(path) else { return acc };
    let reader = BufReader::new(file);
    for line in reader.lines().map_while(|r| r.ok()) {
        if line.trim().is_empty() { continue }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
        // Count genuine human messages, NOT `last-prompt` checkpoint lines:
        // Claude Code re-writes a `last-prompt` entry (with the same text) on
        // every turn, so counting those massively over-reports (e.g. 4 typed
        // messages showed as 19). `is_real_user_turn` is the shared predicate
        // that skips meta rows, tool_result continuations, and command markup.
        if crate::tokens::title::is_real_user_turn(&v) {
            acc.user_prompts += 1;
            continue;
        }
        match v.get("type").and_then(|t| t.as_str()) {
            Some("assistant") => {
                let usage = v.get("message").and_then(|m| m.get("usage")).or_else(|| v.get("usage"));
                let Some(usage) = usage else { continue };
                let get = |k: &str| usage.get(k).and_then(|n| n.as_u64()).unwrap_or(0);
                acc.input_tokens += get("input_tokens");
                acc.output_tokens += get("output_tokens");
                acc.cache_read_tokens += get("cache_read_input_tokens");
                acc.cache_creation_tokens += get("cache_creation_input_tokens");
                acc.turns += 1;
            }
            _ => {}
        }
    }
    acc
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use tempfile::tempdir;

    #[test]
    fn walk_jsonl_finds_nested_files() {
        let dir = tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("a/b")).unwrap();
        std::fs::write(dir.path().join("a/one.jsonl"), "").unwrap();
        std::fs::write(dir.path().join("a/b/two.jsonl"), "").unwrap();
        std::fs::write(dir.path().join("a/ignore.txt"), "").unwrap();
        let mut found = walk_jsonl(dir.path());
        found.sort();
        assert_eq!(found.len(), 2);
        assert!(found[0].ends_with("one.jsonl") || found[1].ends_with("one.jsonl"));
    }

    #[test]
    fn encode_cwd_matches_claude_cli_layout() {
        assert_eq!(
            encode_cwd_as_project_dir(Path::new("c:\\Users\\tecno\\Desktop\\Projects\\claude_usage_in_taskbar")),
            "c--Users-tecno-Desktop-Projects-claude-usage-in-taskbar",
        );
        assert_eq!(
            encode_cwd_as_project_dir(Path::new("C:\\Users\\tecno\\.claude")),
            "C--Users-tecno--claude",
        );
    }

    #[test]
    fn latest_transcript_for_cwd_returns_none_when_dir_missing() {
        let out = latest_transcript_for_cwd(Path::new("Z:\\does\\not\\exist"));
        assert!(out.is_none());
    }

    #[test]
    fn parse_transcript_sums_assistant_usages() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("t.jsonl");
        let content = [
            r#"{"type":"user","message":{"content":"hi"}}"#,
            r#"{"type":"assistant","message":{"usage":{"input_tokens":10,"output_tokens":20,"cache_read_input_tokens":5,"cache_creation_input_tokens":3}}}"#,
            r#""#,
            r#"{"type":"assistant","usage":{"input_tokens":100,"output_tokens":50}}"#,
            r#"not json at all"#,
        ].join("\n");
        std::fs::write(&path, content).unwrap();
        let totals = parse_transcript(&path);
        assert_eq!(totals.input_tokens, 110);
        assert_eq!(totals.output_tokens, 70);
        assert_eq!(totals.cache_read_tokens, 5);
        assert_eq!(totals.cache_creation_tokens, 3);
        assert_eq!(totals.turns, 2);
    }

    #[test]
    fn parse_transcript_counts_real_user_messages_not_last_prompt() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("t.jsonl");
        let sentinel_row = serde_json::json!({
            "type": "user",
            "message": {"role": "user", "content": format!("{}[repo-channel] hi", crate::types::chat::DAEMON_META_SENTINEL)}
        }).to_string();
        let content = [
            // 2 genuine human messages (role:user with text).
            r#"{"type":"user","message":{"role":"user","content":"first question"}}"#,
            r#"{"type":"assistant","message":{"role":"assistant","usage":{"input_tokens":10,"output_tokens":5}}}"#,
            // tool_result continuation - also type:user, must NOT count.
            r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"ok"}]}}"#,
            // last-prompt checkpoint dupes - must NOT count (the old bug).
            r#"{"type":"last-prompt","lastPrompt":"first question"}"#,
            r#"{"type":"last-prompt","lastPrompt":"first question"}"#,
            // meta row - must NOT count.
            r#"{"type":"user","isMeta":true,"message":{"role":"user","content":"<local-command-caveat>x"}}"#,
            // daemon-injected wake row (repo-channel/Jarvis/scheduled) - carries
            // no "isMeta" field on replay, only DAEMON_META_SENTINEL - must NOT count.
            sentinel_row.as_str(),
            r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"second question"}]}}"#,
        ].join("\n");
        std::fs::write(&path, content).unwrap();
        let totals = parse_transcript(&path);
        assert_eq!(totals.user_prompts, 2, "only genuine human messages count");
        assert_eq!(totals.turns, 1);
    }

    #[test]
    fn parse_transcript_counts_a_daemon_author_sentinel_row_as_real() {
        // A Jarvis relay (todo 682) is real, visible content unlike the meta
        // sentinel above - `is_real_user_turn` only ever inspects the bool
        // (never returns the text), so this needs no strip to count right.
        let dir = tempdir().unwrap();
        let path = dir.path().join("t.jsonl");
        let author_row = serde_json::json!({
            "type": "user",
            "message": {"role": "user", "content": format!(
                "{}sid-jarvis-1{}build the login page",
                crate::types::chat::DAEMON_AUTHOR_SENTINEL_PREFIX,
                crate::types::chat::DAEMON_AUTHOR_SENTINEL_SUFFIX
            )}
        }).to_string();
        std::fs::write(&path, author_row).unwrap();
        let totals = parse_transcript(&path);
        assert_eq!(totals.user_prompts, 1, "an authored relay is a real counted turn");
    }

    #[test]
    fn parse_transcript_missing_file_returns_zero() {
        let totals = parse_transcript(Path::new("definitely-not-a-real-file.jsonl"));
        assert_eq!(totals.turns, 0);
        assert_eq!(totals.input_tokens, 0);
    }

    #[test]
    fn decode_cwd_returns_original_when_no_drive_marker_on_windows() {
        if cfg!(windows) {
            assert_eq!(decode_cwd("just-some-name"), "just-some-name");
        }
    }
}
