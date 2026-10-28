//! AI-todos IPC: count/list the backlog `.md` task files under `<cwd>/.claude/todos/`.
//! Split out of `misc.rs` so each module keeps a single responsibility.

#[derive(serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct AiTodoEntry {
    pub name: String,
    pub path: String,
}

use crate::project_dashboard::todo_stats::{is_backlog_file, todos_dir};

/// Only top-level backlog files count as todos: `.md` files directly in the
/// dir, excluding `PLAN.md` (the ordered pointer lane, not a task itself).
fn is_backlog_entry(e: &std::fs::DirEntry) -> bool {
    is_backlog_file(&e.path())
}

/// Count backlog .md files in `<cwd>/.claude/todos/`. Returns 0 if the
/// directory does not exist.
#[tauri::command]
pub async fn count_ai_todos(cwd: String) -> usize {
    let dir = todos_dir(std::path::Path::new(&cwd));
    std::fs::read_dir(&dir)
        .map(|rd| rd.filter_map(|e| e.ok()).filter(is_backlog_entry).count())
        .unwrap_or(0)
}

/// The statusbar's todos chip. A chat mirrored from a paired machine has its
/// `cwd` on that machine's disk, so its list is read there (one hop through
/// the daemon, which forwards by `session_id`); an unreachable host reads as
/// no todos, the same as a missing dir.
#[tauri::command]
pub async fn list_ai_todos(
    cwd: String,
    session_id: Option<String>,
    state: tauri::State<'_, crate::state::AppState>,
) -> Result<Vec<AiTodoEntry>, String> {
    if let Some(client) = super::mirror::mirrored_client(&state, session_id.as_deref()).await {
        let sid = session_id.as_deref().unwrap_or_default();
        return Ok(client.list_ai_todos(sid, &cwd).await.unwrap_or_else(|e| {
            log::warn!("list_ai_todos: mirrored session {sid} read failed: {e}");
            Vec::new()
        }));
    }
    Ok(list_ai_todos_local(cwd).await)
}

/// List backlog .md files in `<cwd>/.claude/todos/`, sorted by name. Returns
/// an empty vec if the directory does not exist.
pub async fn list_ai_todos_local(cwd: String) -> Vec<AiTodoEntry> {
    let dir = todos_dir(std::path::Path::new(&cwd));
    let mut entries: Vec<AiTodoEntry> = std::fs::read_dir(&dir)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .filter(is_backlog_entry)
                .map(|e| {
                    let path = e.path();
                    let name = path
                        .file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .into_owned();
                    let full_path = path.to_string_lossy().into_owned();
                    AiTodoEntry { name, path: full_path }
                })
                .collect()
        })
        .unwrap_or_default();
    entries.sort_by(|a, b| a.name.cmp(&b.name));
    entries
}
