use std::path::{Path, PathBuf};

use tauri::{AppHandle, Emitter, State};

use crate::settings::{self, paths};
use crate::slash::{enumerate, scope, SlashEntry};
use crate::state::AppState;

#[tauri::command]
pub async fn list_slash_commands(
    project_dir: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<SlashEntry>, String> {
    let project = project_dir.map(PathBuf::from);
    let settings = state.settings.lock().unwrap().clone();
    tauri::async_runtime::spawn_blocking(move || enumerate::scan_menu(project.as_deref(), &settings))
        .await
        .map_err(|e| e.to_string())
}

/// The composer's "Enable here": adds the project owning `project_dir` to
/// `key`'s skill scope, then restarts the chat's live `claude` (history kept)
/// so its per-chat `--settings` picks the skill up. Claude Code reads that
/// file only at spawn (checked 2026-10-30: rewriting it mid-session changed
/// nothing). Returns whether a live process was restarted; a draft with no
/// process yet just spawns with the new scope on its first send.
#[tauri::command]
pub async fn enable_skill_here(
    project_dir: String,
    key: String,
    session_id: Option<String>,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<bool, String> {
    let settings_path = paths::settings_file().map_err(|e| e.to_string())?;
    let snapshot = settings::mutate_and_save(&state.settings, &settings_path, |s| {
        let project = scope::project_id(s, Some(Path::new(&project_dir)))
            .ok_or_else(|| format!("not_a_project: {project_dir}"))?;
        scope::add_project(s, &key, &project);
        Ok(())
    })?;
    // The daemon spawns off its own settings cache, so it must have the new
    // scope before the restart below re-reads it.
    crate::daemon_link::push_settings_to_daemon(&state, &snapshot).await;
    let _ = app.emit("settings-changed", snapshot);
    let Some(session_id) = session_id else { return Ok(false) };
    let restarted = {
        let client = state.client().await.ok_or_else(|| "daemon client not connected".to_string())?;
        client.restart_session_process(&session_id).await.map_err(|e| e.to_string())?
    };
    // Same as set_session_model: the respawned child streams on a new
    // broadcast channel, so this window has to attach again.
    if restarted {
        super::daemon_bridge::reattach(&app, &session_id).await?;
    }
    Ok(restarted)
}
