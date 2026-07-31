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

/// Process-global title cache keyed by transcript path + mtime. `session_title`
/// reads and parses the whole JSONL, so without this every History open
/// re-parses the same files. A page hit returns instantly; the entry is
/// invalidated automatically when the file's mtime advances (the chat grew).
fn title_cache(
) -> &'static std::sync::Mutex<std::collections::HashMap<std::path::PathBuf, (std::time::SystemTime, String)>>
{
    static C: std::sync::OnceLock<
        std::sync::Mutex<std::collections::HashMap<std::path::PathBuf, (std::time::SystemTime, String)>>,
    > = std::sync::OnceLock::new();
    C.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// Title for one transcript, using the path+mtime cache. Falls back to the
/// session id when the transcript carries no derivable title.
fn cached_title(path: &std::path::Path, mtime: Option<std::time::SystemTime>, session_id: &str) -> String {
    if let Some(mt) = mtime {
        if let Some((cached_mt, title)) = title_cache().lock().unwrap().get(path) {
            if *cached_mt == mt {
                return title.clone();
            }
        }
        let title = crate::tokens::session_title(path, 60).unwrap_or_else(|| session_id.to_string());
        title_cache().lock().unwrap().insert(path.to_path_buf(), (mt, title.clone()));
        title
    } else {
        crate::tokens::session_title(path, 60).unwrap_or_else(|| session_id.to_string())
    }
}

fn build_entry(m: &LiteMeta) -> crate::types::chat::HistoryEntry {
    crate::types::chat::HistoryEntry {
        session_id: m.session_id.clone(),
        project_id: m.proj_slug.clone(),
        cwd: crate::tokens::decode_cwd(&m.proj_slug),
        title: cached_title(&m.path, m.mtime, &m.session_id),
        started_at: m.started_at,
        ended_at: m.ended_at,
        message_count: 0,
        // last_kind is best-effort; without parsing the JSONL we can't tell
        // whether the session was Interactive vs External. Cross-referencing
        // with the registry is a follow-up; for v1 we mark as External.
        last_kind: crate::sessions::kinds::InstanceKind::External,
    }
}

/// Core of `list_history`, split out so it can be unit-tested against a temp
/// projects dir, and reused by the daemon RPC mirror (`daemon::methods::history`)
/// so the remote/phone client shares the exact same walk + cache. Does the
/// cheap walk + stat + sort + slice FIRST, then parses titles for the returned
/// page only. The exception is title `search`, which inherently needs every
/// title and so falls back to the full-parse path (the History view passes
/// `search = None`, so the common case stays cheap).
pub(crate) fn collect_history(
    projects_dir: &std::path::Path,
    project_id: Option<String>,
    search: Option<String>,
    limit: u32,
    offset: u32,
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

    // Title search is the one operation that needs every title; take the slow
    // full-parse path only then. Otherwise sort + slice cheaply, parse the page.
    if let Some(q) = search.map(|s| s.to_lowercase()) {
        let mut entries: Vec<crate::types::chat::HistoryEntry> = metas.iter().map(build_entry).collect();
        entries.retain(|e| e.title.to_lowercase().contains(&q));
        entries.sort_by(|a, b| b.ended_at.unwrap_or(0).cmp(&a.ended_at.unwrap_or(0)));
        return paginate(entries, offset, limit);
    }

    // Newest first by ended_at (mtime) — a cheap stat field, no parse needed.
    metas.sort_by(|a, b| b.ended_at.unwrap_or(0).cmp(&a.ended_at.unwrap_or(0)));
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
        let mut entries = collect_history(&projects_dir, project_id, search, limit, offset);
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

    #[test]
    fn collect_history_extracts_titles_filters_and_paginates() {
        let tmp = tempdir().unwrap();
        let root = tmp.path();
        write_session(root, "projA", "11111111-1111-1111-1111-111111111111", "Hello from A");
        write_session(root, "projB", "22222222-2222-2222-2222-222222222222", "Hello from B");
        write_session(root, "projB", "33333333-3333-3333-3333-333333333333", "Third one");

        // All three, titles parsed from the first user prompt.
        let all = collect_history(root, None, None, 100, 0);
        assert_eq!(all.len(), 3);
        let titles: std::collections::HashSet<_> = all.iter().map(|e| e.title.clone()).collect();
        assert!(titles.contains("Hello from A"));
        assert!(titles.contains("Hello from B"));
        assert!(titles.contains("Third one"));

        // Project filter keeps only the matching slug.
        let only_b = collect_history(root, Some("projB".into()), None, 100, 0);
        assert_eq!(only_b.len(), 2);
        assert!(only_b.iter().all(|e| e.project_id == "projB"));

        // Pagination: a page of 2, then the remainder.
        assert_eq!(collect_history(root, None, None, 2, 0).len(), 2);
        assert_eq!(collect_history(root, None, None, 2, 2).len(), 1);

        // Title search (slow path) filters case-insensitively.
        let found = collect_history(root, None, Some("THIRD".into()), 100, 0);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].title, "Third one");
    }

    #[test]
    fn collect_history_caches_title_by_path_and_mtime() {
        let tmp = tempdir().unwrap();
        let root = tmp.path();
        write_session(root, "projC", "44444444-4444-4444-4444-444444444444", "Cached title");
        let path = root.join("projC").join("44444444-4444-4444-4444-444444444444.jsonl");

        let first = collect_history(root, None, None, 100, 0);
        assert_eq!(first[0].title, "Cached title");
        // The (path, mtime) entry is now memoized.
        let guard = title_cache().lock().unwrap();
        assert_eq!(
            guard.get(&path).map(|(_, t)| t.clone()),
            Some("Cached title".to_string())
        );
    }

    #[test]
    fn collect_history_empty_when_projects_dir_missing() {
        let tmp = tempdir().unwrap();
        let missing = tmp.path().join("does-not-exist");
        assert!(collect_history(&missing, None, None, 10, 0).is_empty());
    }
}
