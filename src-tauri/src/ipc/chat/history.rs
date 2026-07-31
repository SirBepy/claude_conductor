//! Read-only transcript replays for the chat hub.
//!
//! Distinct from `crate::chat::history` (the pure JSONL reader): this module
//! is the IPC surface that wraps it for the Sessions and History views.

use super::attachments::validate_session_id;
use crate::types::chat::ChatEvent;

/// Replay the JSONL transcript for `session_id` from disk into ChatEvents.
/// Used by the Sessions view to seed the renderer when opening a session,
/// and by the History view for read-only past-session browsing.
///
/// Claude CLI writes transcripts to `~/.claude/projects/<encoded-cwd>/<session_id>.jsonl`,
/// NOT `~/.claude/sessions/<session_id>.jsonl` (the latter holds pid-keyed
/// metadata, not transcripts). When `cwd` is known (Sessions view passes it
/// from the Instance entry), use `transcript_for_session` directly; otherwise
/// (History view, where cwd isn't carried on `HistoryEntry`) scan every project
/// dir for a matching `<session_id>.jsonl`.
#[tauri::command]
pub async fn load_history(session_id: String, cwd: Option<String>) -> Result<Vec<ChatEvent>, String> {
    validate_session_id(&session_id)?;

    // Sync filesystem IO + JSONL parse can be heavy for large transcripts
    // (megabytes, thousands of events). Run on the blocking pool so the
    // Tauri async runtime stays responsive to other IPC calls while the
    // session loads.
    tauri::async_runtime::spawn_blocking(move || {
        let path = crate::chat::history::locate_transcript(&session_id, cwd.as_deref())?;
        crate::chat::history::replay(&path)
    })
    .await
    .map_err(|e| format!("join: {}", e))?
}

/// Paginated transcript reader. Returns the last `message_limit` message
/// bubbles (UserMessage / AssistantMessage), plus all surrounding tool calls
/// and metadata events. Pass `before_seq = Some(oldestSeq)` to fetch the
/// previous page.
///
/// Used by the Sessions view chat-open path. The History view keeps using
/// `load_history` because it browses full transcripts read-only.
#[tauri::command]
pub async fn load_history_page(
    session_id: String,
    cwd: Option<String>,
    before_seq: Option<u64>,
    message_limit: u32,
) -> Result<crate::types::chat::HistoryPage, String> {
    validate_session_id(&session_id)?;
    let limit = message_limit.clamp(1, 500);

    tauri::async_runtime::spawn_blocking(move || {
        let path = crate::chat::history::locate_transcript(&session_id, cwd.as_deref())?;
        crate::chat::history::read_page(&path, before_seq, limit)
    })
    .await
    .map_err(|e| format!("join: {}", e))?
}

/// Lightweight per-file metadata gathered by the cheap dir walk, BEFORE any
/// transcript is opened. Sorting + pagination happen on these, so the expensive
/// `session_title` parse only runs for the page actually returned.
struct LiteMeta {
    session_id: String,
    proj_slug: String,
    path: std::path::PathBuf,
    started_at: i64,
    ended_at: Option<i64>,
    mtime: Option<std::time::SystemTime>,
}

/// Cached per-transcript scan result (title/model/last_status). Cloned out of
/// the cache on every hit, so it stays cheap (small strings) unlike the JSONL
/// parse it stands in for.
#[derive(Clone)]
struct CachedScan {
    title: String,
    model: Option<String>,
    last_status: Option<String>,
}

/// Process-global scan cache keyed by transcript path + mtime. `scan_transcript`
/// reads and parses the whole JSONL, so without this every History open
/// re-parses the same files. A page hit returns instantly; the entry is
/// invalidated automatically when the file's mtime advances (the chat grew).
fn scan_cache(
) -> &'static std::sync::Mutex<std::collections::HashMap<std::path::PathBuf, (std::time::SystemTime, CachedScan)>>
{
    static C: std::sync::OnceLock<
        std::sync::Mutex<std::collections::HashMap<std::path::PathBuf, (std::time::SystemTime, CachedScan)>>,
    > = std::sync::OnceLock::new();
    C.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// Title + model + last_status for one transcript, using the path+mtime cache.
/// Title falls back to the session id when the transcript carries no
/// derivable title. One scan covers all three fields (see `scan_transcript`),
/// so a History page never opens a transcript twice per entry.
fn cached_scan(path: &std::path::Path, mtime: Option<std::time::SystemTime>, session_id: &str) -> CachedScan {
    if let Some(mt) = mtime {
        if let Some((cached_mt, scan)) = scan_cache().lock().unwrap().get(path) {
            if *cached_mt == mt {
                return scan.clone();
            }
        }
        let raw = crate::tokens::scan_transcript(path, 60);
        let scan = CachedScan {
            title: raw.title.unwrap_or_else(|| session_id.to_string()),
            model: raw.model,
            last_status: raw.last_status,
        };
        scan_cache().lock().unwrap().insert(path.to_path_buf(), (mt, scan.clone()));
        scan
    } else {
        let raw = crate::tokens::scan_transcript(path, 60);
        CachedScan {
            title: raw.title.unwrap_or_else(|| session_id.to_string()),
            model: raw.model,
            last_status: raw.last_status,
        }
    }
}

fn build_entry(m: &LiteMeta) -> crate::types::chat::HistoryEntry {
    let scan = cached_scan(&m.path, m.mtime, &m.session_id);
    crate::types::chat::HistoryEntry {
        session_id: m.session_id.clone(),
        project_id: m.proj_slug.clone(),
        cwd: crate::tokens::decode_cwd(&m.proj_slug),
        title: scan.title,
        started_at: m.started_at,
        ended_at: m.ended_at,
        message_count: 0,
        // last_kind is best-effort; without parsing the JSONL we can't tell
        // whether the session was Interactive vs External. Cross-referencing
        // with the registry is a follow-up; for v1 we mark as External.
        last_kind: crate::sessions::kinds::InstanceKind::External,
        model: scan.model,
        last_status: scan.last_status,
    }
}

/// True if `model` matches `filter`: a case-insensitive substring check, so a
/// family name ("sonnet") matches a full id ("claude-sonnet-5") and a full id
/// filter still matches itself exactly.
fn model_matches(model: Option<&str>, filter: &str) -> bool {
    let filter = filter.to_lowercase();
    model.map(|m| m.to_lowercase().contains(&filter)).unwrap_or(false)
}

/// Parses an RFC3339 timestamp into unix-epoch seconds, matching the
/// convention `started_at`/`ended_at` already use. Invalid input is ignored
/// (that bound is simply not applied) rather than failing the whole call.
fn parse_date_bound(s: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(s).ok().map(|dt| dt.timestamp())
}

/// Core of `list_history`, split out so it can be unit-tested against a temp
/// projects dir, and reused by the daemon RPC mirror (`daemon::methods::history`)
/// so the remote/phone client shares the exact same walk + cache. Does the
/// cheap walk + stat + sort + slice FIRST, then parses titles for the returned
/// page only. Title `search` and `model_filter` need parsed data: search falls
/// back to the full-parse path (it inherently needs every title), while
/// `model_filter` alone streams the sort-order list, parsing only until
/// `limit` matches are collected past `offset` (the History view passes both
/// `None`, so the common case stays cheap).
#[allow(clippy::too_many_arguments)]
pub(crate) fn collect_history(
    projects_dir: &std::path::Path,
    project_id: Option<String>,
    search: Option<String>,
    limit: u32,
    offset: u32,
    model_filter: Option<String>,
    date_from: Option<String>,
    date_to: Option<String>,
) -> Vec<crate::types::chat::HistoryEntry> {
    if !projects_dir.exists() {
        return Vec::new();
    }
    let Ok(proj_dirs) = std::fs::read_dir(projects_dir) else {
        return Vec::new();
    };
    let mut metas: Vec<LiteMeta> = Vec::new();
    for proj_dir in proj_dirs.flatten() {
        if !proj_dir.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let proj_slug = proj_dir.file_name().to_string_lossy().to_string();
        // Project filter is cheap (dir name), so apply it before touching files.
        if let Some(ref pid) = project_id {
            if &proj_slug != pid {
                continue;
            }
        }
        let inner = match std::fs::read_dir(proj_dir.path()) {
            Ok(i) => i,
            Err(_) => continue,
        };
        for f in inner.flatten() {
            let p = f.path();
            if p.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            let session_id = p
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default();
            let meta = f.metadata().ok();
            let started_at = meta
                .as_ref()
                .and_then(|m| m.created().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);
            let mtime = meta.as_ref().and_then(|m| m.modified().ok());
            let ended_at = mtime
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as i64);
            metas.push(LiteMeta {
                session_id,
                proj_slug: proj_slug.clone(),
                path: p,
                started_at,
                ended_at,
                mtime,
            });
        }
    }

    // Date range is cheap (stat fields only), so apply it before any parsing.
    let from_ts = date_from.as_deref().and_then(parse_date_bound);
    let to_ts = date_to.as_deref().and_then(parse_date_bound);
    if from_ts.is_some() || to_ts.is_some() {
        metas.retain(|m| {
            let ts = m.ended_at.unwrap_or(m.started_at);
            from_ts.is_none_or(|f| ts >= f) && to_ts.is_none_or(|t| ts <= t)
        });
    }

    // Title search is the one operation that needs every title; take the slow
    // full-parse path only then. Otherwise sort + slice cheaply, parse the page.
    if let Some(q) = search.map(|s| s.to_lowercase()) {
        let mut entries: Vec<crate::types::chat::HistoryEntry> = metas.iter().map(build_entry).collect();
        entries.retain(|e| e.title.to_lowercase().contains(&q));
        if let Some(ref mf) = model_filter {
            entries.retain(|e| model_matches(e.model.as_deref(), mf));
        }
        entries.sort_by(|a, b| b.ended_at.unwrap_or(0).cmp(&a.ended_at.unwrap_or(0)));
        return paginate(entries, offset, limit);
    }

    // Newest first by ended_at (mtime) — a cheap stat field, no parse needed.
    metas.sort_by(|a, b| b.ended_at.unwrap_or(0).cmp(&a.ended_at.unwrap_or(0)));

    if let Some(mf) = model_filter {
        // model_filter needs parsed data; stream-parse the sorted list until
        // `limit` matches are collected past `offset` instead of parsing
        // every entry up front (the path+mtime cache makes repeat calls cheap).
        let mut matched = 0u32;
        let mut out = Vec::new();
        for m in &metas {
            let entry = build_entry(m);
            if !model_matches(entry.model.as_deref(), &mf) {
                continue;
            }
            if matched >= offset {
                out.push(entry);
                if out.len() as u32 >= limit {
                    break;
                }
            }
            matched += 1;
        }
        return out;
    }

    let len = metas.len();
    let start = (offset as usize).min(len);
    let end = (offset.saturating_add(limit) as usize).min(len);
    metas[start..end].iter().map(build_entry).collect()
}

fn paginate<T: Clone>(items: Vec<T>, offset: u32, limit: u32) -> Vec<T> {
    let len = items.len();
    let start = (offset as usize).min(len);
    // saturating_add to prevent u32 overflow on attacker-supplied huge values.
    let end = (offset.saturating_add(limit) as usize).min(len);
    items[start..end].to_vec()
}

/// List past sessions by walking `~/.claude/projects/<encoded-cwd>/*.jsonl`.
/// `~/.claude/sessions/` is pid-keyed metadata, not transcripts. Returns a
/// paginated, optionally-filtered list sorted newest first by mtime.
///
/// `project_id` filters by the encoded-cwd dir name (the same slug
/// `tokens::encode_cwd_as_project_dir` produces). Pass `None` to list all.
///
/// Runs on the blocking pool: the dir walk + (page-only) title parses are
/// synchronous filesystem IO that would otherwise stall the async runtime.
#[tauri::command]
pub async fn list_history(
    project_id: Option<String>,
    search: Option<String>,
    limit: u32,
    offset: u32,
    model_filter: Option<String>,
    date_from: Option<String>,
    date_to: Option<String>,
    state: tauri::State<'_, crate::state::AppState>,
) -> Result<Vec<crate::types::chat::HistoryEntry>, String> {
    let projects_dir = crate::tokens::claude_projects_dir().ok_or("no home dir")?;
    // Collect live session IDs so we can exclude them from history.
    let live_ids: std::collections::HashSet<String> = state
        .cached_instances
        .lock()
        .unwrap()
        .iter()
        .filter(|i| i.ended_at.is_none())
        .map(|i| i.session_id.clone())
        .collect();
    tauri::async_runtime::spawn_blocking(move || {
        let mut entries = collect_history(
            &projects_dir, project_id, search, limit, offset, model_filter, date_from, date_to,
        );
        entries.retain(|e| !live_ids.contains(&e.session_id));
        entries
    })
    .await
    .map_err(|e| format!("join: {}", e))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    /// Thin wrapper so existing tests (no model/date filters) don't need to
    /// spell out three trailing `None`s at every call site.
    fn ch(
        root: &std::path::Path,
        project_id: Option<String>,
        search: Option<String>,
        limit: u32,
        offset: u32,
    ) -> Vec<crate::types::chat::HistoryEntry> {
        collect_history(root, project_id, search, limit, offset, None, None, None)
    }

    fn write_session(root: &std::path::Path, proj: &str, sid: &str, first_prompt: &str) {
        let pdir = root.join(proj);
        fs::create_dir_all(&pdir).unwrap();
        let line = serde_json::json!({
            "type": "user",
            "message": { "role": "user", "content": first_prompt }
        })
        .to_string();
        fs::write(pdir.join(format!("{sid}.jsonl")), line).unwrap();
    }

    /// A session whose transcript also carries an assistant reply, so model
    /// + last_status extraction has something to find.
    fn write_session_with_model(root: &std::path::Path, proj: &str, sid: &str, prompt: &str, model: &str, status: &str) {
        let pdir = root.join(proj);
        fs::create_dir_all(&pdir).unwrap();
        let user_line = serde_json::json!({
            "type": "user",
            "message": { "role": "user", "content": prompt }
        }).to_string();
        let assistant_line = serde_json::json!({
            "type": "assistant",
            "message": {
                "role": "assistant",
                "model": model,
                "content": [{"type": "text", "text": format!("done <cc-status:{status}>")}],
            }
        }).to_string();
        fs::write(pdir.join(format!("{sid}.jsonl")), [user_line, assistant_line].join("\n")).unwrap();
    }

    #[test]
    fn collect_history_extracts_titles_filters_and_paginates() {
        let tmp = tempdir().unwrap();
        let root = tmp.path();
        write_session(root, "projA", "11111111-1111-1111-1111-111111111111", "Hello from A");
        write_session(root, "projB", "22222222-2222-2222-2222-222222222222", "Hello from B");
        write_session(root, "projB", "33333333-3333-3333-3333-333333333333", "Third one");

        // All three, titles parsed from the first user prompt.
        let all = ch(root, None, None, 100, 0);
        assert_eq!(all.len(), 3);
        let titles: std::collections::HashSet<_> = all.iter().map(|e| e.title.clone()).collect();
        assert!(titles.contains("Hello from A"));
        assert!(titles.contains("Hello from B"));
        assert!(titles.contains("Third one"));

        // Project filter keeps only the matching slug.
        let only_b = ch(root, Some("projB".into()), None, 100, 0);
        assert_eq!(only_b.len(), 2);
        assert!(only_b.iter().all(|e| e.project_id == "projB"));

        // Pagination: a page of 2, then the remainder.
        assert_eq!(ch(root, None, None, 2, 0).len(), 2);
        assert_eq!(ch(root, None, None, 2, 2).len(), 1);

        // Title search (slow path) filters case-insensitively.
        let found = ch(root, None, Some("THIRD".into()), 100, 0);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].title, "Third one");
    }

    #[test]
    fn collect_history_caches_title_by_path_and_mtime() {
        let tmp = tempdir().unwrap();
        let root = tmp.path();
        write_session(root, "projC", "44444444-4444-4444-4444-444444444444", "Cached title");
        let path = root.join("projC").join("44444444-4444-4444-4444-444444444444.jsonl");

        let first = ch(root, None, None, 100, 0);
        assert_eq!(first[0].title, "Cached title");
        // The (path, mtime) entry is now memoized.
        let guard = scan_cache().lock().unwrap();
        assert_eq!(
            guard.get(&path).map(|(_, s)| s.title.clone()),
            Some("Cached title".to_string())
        );
    }

    #[test]
    fn collect_history_empty_when_projects_dir_missing() {
        let tmp = tempdir().unwrap();
        let missing = tmp.path().join("does-not-exist");
        assert!(ch(&missing, None, None, 10, 0).is_empty());
    }

    #[test]
    fn collect_history_extracts_model_and_last_status() {
        let tmp = tempdir().unwrap();
        let root = tmp.path();
        write_session_with_model(root, "projD", "55555555-5555-5555-5555-555555555555", "hi", "claude-sonnet-5", "done");

        let all = ch(root, None, None, 100, 0);
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].model.as_deref(), Some("claude-sonnet-5"));
        assert_eq!(all[0].last_status.as_deref(), Some("done"));
    }

    #[test]
    fn collect_history_model_filter_matches_family_substring_and_streams_page() {
        let tmp = tempdir().unwrap();
        let root = tmp.path();
        write_session_with_model(root, "projE", "66666666-6666-6666-6666-666666666666", "a", "claude-sonnet-5", "done");
        write_session_with_model(root, "projE", "77777777-7777-7777-7777-777777777777", "b", "claude-opus-4", "done");

        let sonnet_only = collect_history(root, None, None, 100, 0, Some("sonnet".into()), None, None);
        assert_eq!(sonnet_only.len(), 1);
        assert_eq!(sonnet_only[0].model.as_deref(), Some("claude-sonnet-5"));

        // A full id also matches (not just the family substring).
        let full_id = collect_history(root, None, None, 100, 0, Some("claude-opus-4".into()), None, None);
        assert_eq!(full_id.len(), 1);
        assert_eq!(full_id[0].model.as_deref(), Some("claude-opus-4"));
    }

    #[test]
    fn collect_history_date_range_filters_on_ended_at() {
        let tmp = tempdir().unwrap();
        let root = tmp.path();
        write_session(root, "projF", "88888888-8888-8888-8888-888888888888", "in range");

        // A far-future lower bound excludes every entry written "now".
        let future = collect_history(root, None, None, 100, 0, None, Some("2099-01-01T00:00:00Z".into()), None);
        assert!(future.is_empty());

        // A generous range around "now" keeps it.
        let wide = collect_history(root, None, None, 100, 0, None, Some("2000-01-01T00:00:00Z".into()), Some("2099-01-01T00:00:00Z".into()));
        assert_eq!(wide.len(), 1);
    }
}
