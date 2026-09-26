//! Project- and default-level character whitelist IPC commands, split out of
//! `ipc/characters.rs` (todo 949) once that file passed the ~300-line rule.

use crate::characters::{self, Character};
use crate::characters::whitelist;
use crate::settings::persist;
use crate::state::AppState;
use crate::types::CharacterWhitelist;
use tauri::{AppHandle, State};

/// Get the whitelist for a specific project.
#[tauri::command]
pub fn get_project_whitelist(project_id: String, state: State<AppState>) -> CharacterWhitelist {
    state
        .settings
        .lock()
        .unwrap()
        .projects
        .iter()
        .find(|p| p.id == project_id)
        .map(|p| p.whitelist.clone())
        .unwrap_or(CharacterWhitelist::Default)
}

/// Set the whitelist for a specific project.
#[tauri::command]
pub async fn set_project_whitelist(
    project_id: String,
    whitelist: CharacterWhitelist,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(), String> {
    let snapshot = {
        let mut s = state.settings.lock().unwrap();
        let p = s.projects.iter_mut().find(|p| p.id == project_id)
            .ok_or_else(|| format!("project not found: {project_id}"))?;
        p.whitelist = whitelist;
        s.clone()
    };
    persist(&app, &snapshot);
    super::push_to_daemon(&state, &snapshot).await;
    Ok(())
}

/// Get the settings-level default whitelist.
#[tauri::command]
pub fn get_default_whitelist(state: State<AppState>) -> CharacterWhitelist {
    state.settings.lock().unwrap().default_character_whitelist.clone()
}

/// Set the settings-level default whitelist.
#[tauri::command]
pub async fn set_default_whitelist(
    whitelist: CharacterWhitelist,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(), String> {
    let snapshot = {
        let mut s = state.settings.lock().unwrap();
        s.default_character_whitelist = whitelist;
        s.clone()
    };
    persist(&app, &snapshot);
    super::push_to_daemon(&state, &snapshot).await;
    Ok(())
}

/// Resolve the effective whitelist for a project to a list of Character objects.
/// Used by the modal's "Whitelisted" tab.
#[tauri::command]
pub fn resolve_whitelist_characters(project_id: String, state: State<AppState>) -> Vec<Character> {
    let s = state.settings.lock().unwrap();
    let proj_wl = s
        .projects
        .iter()
        .find(|p| p.id == project_id)
        .map(|p| p.whitelist.clone())
        .unwrap_or(CharacterWhitelist::Default);
    let default_wl = s.default_character_whitelist.clone();
    drop(s);

    let all = characters::list();
    let resolved_ids = whitelist::resolve(&proj_wl, &default_wl, &all);
    // Map ids back to Character, preserving the sorted order from resolve().
    resolved_ids
        .iter()
        .filter_map(|id| characters::get(id))
        .collect()
}
