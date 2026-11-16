//! Text search over a project's todo files, for the Backlog panel's search box.
//! The list already carries every live todo's id, title and summary, so the
//! panel filters those itself; this reads what it does not have: the body text
//! of live todos and the whole of the archived ones in `.claude/todos/done/`
//! (finished todos leave the list, which is why a search must reach them).
//!
//! Not an RPC method: the panel calls it through the desktop-only
//! `search_ai_todos` Tauri command, because it reads this machine's disk and a
//! phone or peer would be reading the wrong one. It only ever opens regular
//! `.md` files directly inside `<cwd>/.claude/todos/` and its `done/`, so there
//! is no path from the query to a file name.

use crate::ipc::ai_todos::{AiTodoDoc, AiTodoEntry};
use crate::project_dashboard::todo_ids::parse_file_name;
use crate::project_dashboard::todo_read::{parse_head, parse_sections, strip_html_comments};
use crate::project_dashboard::todo_stats::{is_backlog_file, todos_dir};
use std::path::Path;

/// A todo file bigger than this is skipped: a todo is prose, and a huge file is
/// something else sitting in the folder.
const MAX_FILE_BYTES: u64 = 1024 * 1024;
/// Archived hits sent back at most; the panel says so when it hit the cap.
const MAX_ARCHIVED_HITS: usize = 50;

/// What a search found. `live_ids` are backlog todos whose file text holds the
/// query (the panel merges them with its own id/title/summary matches);
/// `archived` are `done/` todos in full, so the reader can open one without a
/// second read.
#[derive(Clone, Debug, Default, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(default)]
pub struct TodoSearch {
    pub live_ids: Vec<String>,
    pub archived: Vec<AiTodoDoc>,
    /// More archived todos matched than `archived` holds.
    pub archived_truncated: bool,
}

/// True when `needle` (already lowercased) is in `hay` ignoring case.
fn contains_ci(hay: &str, needle: &str) -> bool {
    hay.to_lowercase().contains(needle)
}

/// Whether a todo with this file name and text matches `needle`: its id (the
/// canonical `pc-1757`, or the bare number), its file name, or its text.
fn matches(name: &str, text: &str, needle: &str) -> bool {
    let id = parse_file_name(name).map(|p| p.key.canonical());
    if id.as_deref().is_some_and(|id| id.contains(needle)) {
        return true;
    }
    // `1757` must find `pc-1757` even though the file name zero-pads or not.
    if let Some(p) = parse_file_name(name) {
        if needle.chars().all(|c| c.is_ascii_digit()) && p.key.number.to_string() == needle.trim_start_matches('0') {
            return true;
        }
    }
    // Not the file name: ".md" or "pc" would match every todo. The title and
    // the slug's words are in the text.
    contains_ci(&strip_html_comments(text), needle)
}

/// Every regular `.md` file of `dir` (not `PLAN.md`), skipping symlinks and
/// oversized files, with its text.
fn read_todo_files(dir: &Path) -> Vec<(std::path::PathBuf, String)> {
    let Ok(rd) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut out = Vec::new();
    for e in rd.flatten() {
        let path = e.path();
        // `DirEntry::file_type` does not follow a symlink, so a link out of the
        // folder reads as "not a file" and is never opened.
        let is_file = e.file_type().is_ok_and(|t| t.is_file());
        if !is_file || !is_backlog_file(&path) {
            continue;
        }
        // A file whose size cannot be read is skipped like an oversized one.
        if e.metadata().map_or(true, |m| m.len() > MAX_FILE_BYTES) {
            continue;
        }
        if let Ok(raw) = std::fs::read_to_string(&path) {
            out.push((path, raw.strip_prefix('\u{feff}').map(str::to_string).unwrap_or(raw)));
        }
    }
    out
}

fn mtime_ms(path: &Path) -> u64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis() as u64)
}

/// An archived todo as the reader shows it. No PLAN placement and no claim:
/// it left both when it was archived.
fn archived_doc(path: &Path, text: &str) -> AiTodoDoc {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let parsed = parse_file_name(&name);
    let fallback = parsed.as_ref().map(|p| p.key.canonical()).unwrap_or_else(|| name.trim_end_matches(".md").to_string());
    let head = parse_head(text, &fallback);
    let id = parsed.map(|p| p.key.canonical()).unwrap_or(fallback);
    let (why, sections) = parse_sections(text);
    AiTodoDoc {
        entry: AiTodoEntry {
            name,
            path: path.to_string_lossy().into_owned(),
            id,
            title: head.title,
            summary: head.summary,
            origin: head.origin,
            todo_type: head.todo_type,
            worth: head.worth,
            complexity: head.complexity,
            due: head.due,
            claimed: false,
            group: None,
            plan_index: None,
            mtime_ms: mtime_ms(path),
        },
        why,
        sections,
    }
}

/// Searches `<repo>/.claude/todos/` (and `done/` when `include_archived`).
/// An empty or whitespace query finds nothing.
pub fn search(repo: &Path, query: &str, include_archived: bool) -> TodoSearch {
    let needle = query.trim().to_lowercase();
    if needle.is_empty() {
        return TodoSearch::default();
    }
    let dir = todos_dir(repo);
    let mut result = TodoSearch::default();
    for (path, text) in read_todo_files(&dir) {
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        if matches(&name, &text, &needle) {
            let id = parse_file_name(&name).map(|p| p.key.canonical()).unwrap_or_else(|| name.trim_end_matches(".md").to_string());
            result.live_ids.push(id);
        }
    }
    result.live_ids.sort();
    if include_archived {
        let mut hits: Vec<AiTodoDoc> = read_todo_files(&dir.join("done"))
            .into_iter()
            .filter(|(path, text)| matches(&path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(), text, &needle))
            .map(|(path, text)| archived_doc(&path, &text))
            .collect();
        // Newest first: the todo Joe just finished is the likeliest one he wants.
        hits.sort_by(|a, b| b.entry.mtime_ms.cmp(&a.entry.mtime_ms).then_with(|| a.entry.id.cmp(&b.entry.id)));
        result.archived_truncated = hits.len() > MAX_ARCHIVED_HITS;
        hits.truncate(MAX_ARCHIVED_HITS);
        result.archived = hits;
    }
    result
}

/// The Backlog search box's read of todo text: live todos whose file holds
/// `query`, and (when asked) archived ones from `done/`, in full. Desktop-only
/// and local-chat-only: it reads this machine's disk, so it has no RPC twin.
#[tauri::command]
pub async fn search_ai_todos(cwd: String, query: String, include_archived: bool) -> Result<TodoSearch, String> {
    // The scan reads files, so it runs off the async worker.
    tokio::task::spawn_blocking(move || search(Path::new(&cwd), &query, include_archived))
        .await
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo_with(files: &[(&str, &str)]) -> std::path::PathBuf {
        use std::sync::atomic::{AtomicU32, Ordering};
        static N: AtomicU32 = AtomicU32::new(0);
        let repo = std::env::temp_dir().join(format!("cc_todo_search_{}_{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
        let todos = repo.join(".claude").join("todos");
        std::fs::create_dir_all(todos.join("done")).unwrap();
        for (rel, body) in files {
            std::fs::write(todos.join(rel), body).unwrap();
        }
        repo
    }

    #[test]
    fn an_archived_todo_is_found_by_its_bare_number_and_its_full_id() {
        let repo = repo_with(&[("done/pc-1757-ship-it.md", "# Ship it\n\n## Goal\n\nShip.\n")]);
        for q in ["1757", "pc-1757", "PC-1757", "ship"] {
            let r = search(&repo, q, true);
            assert_eq!(r.archived.iter().map(|d| d.entry.id.as_str()).collect::<Vec<_>>(), ["pc-1757"], "query {q}");
        }
        std::fs::remove_dir_all(&repo).ok();
    }

    #[test]
    fn archived_todos_stay_out_unless_asked_for() {
        let repo = repo_with(&[("done/pc-1757-ship-it.md", "# Ship it\n"), ("pc-0002-live.md", "# Live one\n")]);
        let r = search(&repo, "1757", false);
        assert!(r.archived.is_empty());
        std::fs::remove_dir_all(&repo).ok();
    }

    #[test]
    fn a_live_todo_is_found_by_its_body_text() {
        let repo = repo_with(&[
            ("pc-0002-live.md", "# Live one\n\n## Context\n\nThe flux capacitor leaks.\n"),
            ("pc-0003-other.md", "# Other\n"),
            ("PLAN.md", "## Now\n- pc-0002 flux capacitor\n"),
        ]);
        let r = search(&repo, "Flux Capacitor", false);
        assert_eq!(r.live_ids, ["pc-0002"]);
        std::fs::remove_dir_all(&repo).ok();
    }

    #[test]
    fn a_comment_only_mention_does_not_match() {
        let repo = repo_with(&[("pc-0002-live.md", "# Live one\n<!-- cleanup: secretword -->\n")]);
        assert!(search(&repo, "secretword", false).live_ids.is_empty());
        std::fs::remove_dir_all(&repo).ok();
    }

    #[test]
    fn an_empty_query_and_a_missing_folder_find_nothing() {
        let repo = repo_with(&[("pc-0002-live.md", "# Live one\n")]);
        assert_eq!(search(&repo, "   ", true), TodoSearch::default());
        std::fs::remove_dir_all(&repo).ok();
        assert_eq!(search(&repo, "live", true), TodoSearch::default());
    }

    #[test]
    fn archived_hits_are_capped_and_say_so() {
        let files: Vec<(String, String)> =
            (0..(MAX_ARCHIVED_HITS + 3)).map(|i| (format!("done/pc-{:04}-x.md", i + 1), "# Needle\n".to_string())).collect();
        let refs: Vec<(&str, &str)> = files.iter().map(|(a, b)| (a.as_str(), b.as_str())).collect();
        let repo = repo_with(&refs);
        let r = search(&repo, "needle", true);
        assert_eq!(r.archived.len(), MAX_ARCHIVED_HITS);
        assert!(r.archived_truncated);
        std::fs::remove_dir_all(&repo).ok();
    }
}
