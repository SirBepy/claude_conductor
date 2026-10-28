//! AI-todos IPC: count/list/read the backlog `.md` task files under
//! `<cwd>/.claude/todos/`, and the Backlog panel's desktop-only actions
//! (archive, plan moves, start a chat). Split out of `misc.rs` so each module
//! keeps a single responsibility; the parsing and PLAN.md editing live in
//! `project_dashboard` (`todo_ids`, `todo_read`, `plan_edit`, `todo_actions`).

use crate::project_dashboard::todo_stats::{is_backlog_file, todos_dir};
use crate::project_dashboard::{todo_actions, todo_ids, todo_read};

/// One backlog todo as the list and the statusbar chip see it. Fields beyond
/// `name`/`path` default so a paired machine on an older build, which sends
/// only those two, still deserializes.
#[derive(Clone, Debug, Default, PartialEq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[serde(default)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct AiTodoEntry {
    pub name: String,
    pub path: String,
    /// Canonical `pc-1407`; a legacy `1407-x.md` reads as `pc-1407`.
    pub id: String,
    /// The `# ` heading, else the file slug prettified.
    pub title: String,
    /// The `**Summary:**` line, else the first sentence of `## Goal`.
    pub summary: Option<String>,
    /// `dev` or `ai`.
    pub origin: Option<String>,
    /// The `**Type:**` line.
    pub todo_type: Option<String>,
    /// `worth=N` from the cleanup comment.
    pub worth: Option<u8>,
    /// `complexity=X` from the cleanup comment, as written (e.g. `HARD`).
    pub complexity: Option<String>,
    /// A live claim exists: a chat is working on it.
    pub claimed: bool,
    /// The PLAN.md `## ` heading the id sits under; `None` when unplanned.
    pub group: Option<String>,
    /// Order among the id lines of the whole PLAN.md.
    pub plan_index: Option<u32>,
    #[ts(type = "number")]
    pub mtime_ms: u64,
}

/// The Backlog panel's list: the PLAN.md groups in file order (empty ones
/// included) and every backlog todo.
#[derive(Clone, Debug, Default, PartialEq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[serde(default)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct AiBacklog {
    pub groups: Vec<String>,
    pub todos: Vec<AiTodoEntry>,
}

/// One `## ` section of a todo, comments already stripped.
#[derive(Clone, Debug, Default, PartialEq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[serde(default)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct AiTodoSection {
    pub heading: String,
    pub markdown: String,
}

/// A todo for the reader: its list entry, the `## Why` body, and every other
/// section in file order.
#[derive(Clone, Debug, Default, PartialEq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[serde(default)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct AiTodoDoc {
    pub entry: AiTodoEntry,
    pub why: Option<String>,
    pub sections: Vec<AiTodoSection>,
}

/// What an archive leaves behind, and exactly what `ai_todo_unarchive` needs
/// to put it back.
#[derive(Clone, Debug, Default, PartialEq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[serde(default)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct AiTodoArchived {
    pub id: String,
    pub done_path: String,
    pub original_path: String,
    /// The file as it was before the note was appended.
    pub original_content: String,
    /// The PLAN.md line that was pruned, if there was one.
    pub plan_line: Option<String>,
    /// Its line index in PLAN.md before the prune.
    pub plan_line_index: Option<u32>,
}

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

/// Every backlog todo of `<cwd>/.claude/todos/`, ordered by id. Empty if the
/// directory does not exist.
pub async fn list_ai_todos_local(cwd: String) -> Vec<AiTodoEntry> {
    list_ai_backlog_local(cwd).await.todos
}

/// The Backlog panel's list, forwarded to the host machine for a mirrored
/// chat the way `list_ai_todos` is; an unreachable host reads as an empty
/// backlog.
#[tauri::command]
pub async fn list_ai_backlog(
    cwd: String,
    session_id: Option<String>,
    state: tauri::State<'_, crate::state::AppState>,
) -> Result<AiBacklog, String> {
    if let Some(client) = super::mirror::mirrored_client(&state, session_id.as_deref()).await {
        let sid = session_id.as_deref().unwrap_or_default();
        return Ok(client.list_ai_backlog(sid, &cwd).await.unwrap_or_else(|e| {
            log::warn!("list_ai_backlog: mirrored session {sid} read failed: {e}");
            AiBacklog::default()
        }));
    }
    Ok(list_ai_backlog_local(cwd).await)
}

pub async fn list_ai_backlog_local(cwd: String) -> AiBacklog {
    todo_read::list_backlog_for_repo(&cwd)
}

/// One todo for the reader. `id` takes `pc-1407`, `pc-0007`, a bare `1407` or a
/// legacy file stem. Forwarded for a mirrored chat; there an unreachable host
/// is an error, because the reader has nothing to show instead.
#[tauri::command]
pub async fn read_ai_todo(
    cwd: String,
    id: String,
    session_id: Option<String>,
    state: tauri::State<'_, crate::state::AppState>,
) -> Result<AiTodoDoc, String> {
    if let Some(client) = super::mirror::mirrored_client(&state, session_id.as_deref()).await {
        let sid = session_id.as_deref().unwrap_or_default();
        return client.read_ai_todo(sid, &cwd, &id).await.map_err(|e| e.to_string());
    }
    read_ai_todo_local(cwd, id).await
}

pub async fn read_ai_todo_local(cwd: String, id: String) -> Result<AiTodoDoc, String> {
    todo_read::read_doc(&todos_dir(std::path::Path::new(&cwd)), &id, &todo_ids::device_label())
}

/// Moves a todo into `done/`: appends the optional note under `## Notes`,
/// prunes its PLAN.md line, and returns what `ai_todo_unarchive` needs. Refuses
/// while a live claim exists. Desktop-local only; never reachable over the
/// phone or peer transport.
#[tauri::command]
pub async fn ai_todo_archive(cwd: String, id: String, note: Option<String>) -> Result<AiTodoArchived, String> {
    todo_actions::archive(&todos_dir(std::path::Path::new(&cwd)), &id, note.as_deref(), &todo_ids::device_label())
}

/// Undoes `ai_todo_archive`: restores the file, removes the `done/` copy and
/// puts the PLAN.md line back at its old index.
#[tauri::command]
pub async fn ai_todo_unarchive(cwd: String, archived: AiTodoArchived) -> Result<(), String> {
    todo_actions::unarchive(&todos_dir(std::path::Path::new(&cwd)), &archived)
}

/// Puts `id` under `## <group>` at `index` among that group's visible items
/// (`None` unplans it).
#[tauri::command]
pub async fn ai_todo_plan_move(cwd: String, id: String, group: Option<String>, index: u32) -> Result<(), String> {
    todo_actions::plan_move(
        &todos_dir(std::path::Path::new(&cwd)),
        &id,
        group.as_deref(),
        index,
        &todo_ids::device_label(),
    )
}

/// Reorders whole `## ` sections of PLAN.md to match `groups`.
#[tauri::command]
pub async fn ai_todo_plan_reorder_groups(cwd: String, groups: Vec<String>) -> Result<(), String> {
    todo_actions::plan_reorder_groups(&todos_dir(std::path::Path::new(&cwd)), &groups)
}

/// Starts a new chat in project `cwd` whose first message is `Do todo <id>`
/// and returns its session id. The spawn runs in the daemon, through the same
/// caller-less spawn the `spawn_chat` RPC uses.
#[tauri::command]
pub async fn ai_todo_start_chat(
    cwd: String,
    id: String,
    state: tauri::State<'_, crate::state::AppState>,
) -> Result<String, String> {
    let dir = todos_dir(std::path::Path::new(&cwd));
    let canonical = todo_actions::canonical_id_of(&dir, &id, &todo_ids::device_label())?;
    let client = state.client().await.ok_or_else(|| "the daemon is not connected".to_string())?;
    client.ai_todo_start_chat(&cwd, &canonical).await.map_err(|e| e.to_string())
}
