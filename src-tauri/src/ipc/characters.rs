//! IPC commands for character listing, assignment, asset URLs, and folder ops.

use crate::characters::{self, Character};
use crate::characters::slots::Slot;
use crate::characters::whitelist;
use crate::state::AppState;
use crate::settings::{paths, persist};
use crate::types::{Avatar, CharacterWhitelist};
use std::collections::{HashMap, HashSet};
use tauri::{AppHandle, State};

#[tauri::command]
pub fn list_characters() -> Vec<Character> {
    characters::list()
}

/// `persist` only writes settings.json and emits the in-process
/// `settings-changed` Tauri event, so without this the daemon's `SettingsCache`
/// keeps the pre-change `session_characters` / whitelists for the rest of its
/// life - and that cache is what `list_session_characters` and
/// `resolve_whitelist_characters` answer a remote client from. Every character
/// mutation below therefore ends with persist + this.
async fn push_to_daemon(state: &AppState, snapshot: &crate::types::Settings) {
    crate::daemon_link::push_settings_to_daemon(state, snapshot).await;
}

#[tauri::command]
pub async fn assign_character(
    project_id: String,
    character_id: Option<String>,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(), String> {
    let snapshot = {
        let mut s = state.settings.lock().unwrap();
        let Some(p) = s.projects.iter_mut().find(|p| p.id == project_id) else {
            return Err(format!("project not found: {project_id}"));
        };
        p.avatar = match character_id {
            Some(id) if !id.is_empty() => Avatar::Character(id),
            _ => Avatar::None,
        };
        s.clone()
    };
    persist(&app, &snapshot);
    push_to_daemon(&state, &snapshot).await;
    Ok(())
}

#[tauri::command]
pub fn play_character_slot(
    character_id: String,
    slot: Slot,
    app: AppHandle,
    state: State<AppState>,
) -> Result<(), String> {
    let settings = state.settings.lock().unwrap().clone();
    if settings.mute_all() || settings.mute_sounds() {
        return Ok(());
    }
    if settings.pause_notifications_in_meeting()
        && state.meeting_active.load(std::sync::atomic::Ordering::Relaxed)
    {
        return Ok(());
    }
    // Per-slot toggle (Settings > Sound). Defaults on when unset.
    if !settings.character_slot_enabled(slot.camel_key()) {
        return Ok(());
    }
    let Some(c) = characters::get(&character_id) else {
        return Err(format!("unknown character: {character_id}"));
    };
    let files = c.slot_files(slot);
    let Some(pick) = characters::slots::random_pick(files) else {
        return Err("slot has no files".into());
    };
    let path = c.asset_path(pick);
    crate::notifications::audio::play_path(&app, &path);
    Ok(())
}

#[tauri::command]
pub fn character_asset_url(character_id: String, file: String) -> Option<String> {
    let c = characters::get(&character_id)?;
    characters::assets::file_data_url_at(&c.asset_path(&file))
}

#[tauri::command]
pub fn preview_character_file(
    character_id: String,
    file: String,
    state: State<AppState>,
    app: AppHandle,
) -> Result<(), String> {
    let Some(c) = characters::get(&character_id) else {
        return Err(format!("unknown character: {character_id}"));
    };
    let path = c.asset_path(&file);
    if !path.exists() {
        return Err(format!("asset not found: {file}"));
    }
    state.preview.play(path, app);
    Ok(())
}

#[tauri::command]
pub fn stop_character_preview(state: State<AppState>) {
    state.preview.stop();
}

#[tauri::command]
pub fn get_characters_dir() -> Result<String, String> {
    paths::characters_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(|e| e.to_string())
}

/// Drops the in-memory character list cache. Frontend calls this after
/// the user clicks Refresh in the Characters view (e.g. after the
/// `/character-creator` skill writes a new bundle to disk).
#[tauri::command]
pub async fn invalidate_characters_cache(state: State<'_, AppState>) -> Result<(), String> {
    characters::cache::invalidate();
    // The daemon is a SEPARATE process holding its own copy of this cache, and
    // it is the one that answers `list_characters` / `character_asset_url` for
    // every remote client. Dropping only the app's copy left a newly added or
    // re-arted character invisible on the phone for the daemon's whole lifetime.
    crate::daemon_link::invalidate_daemon_characters_cache(&state).await;
    Ok(())
}

// ---------------------------------------------------------------------------
// Session-character commands
// ---------------------------------------------------------------------------

/// Prune dead sessions from session_characters. A session is dead when it
/// either does not appear in `live_ids` at all, or it does appear but its
/// `end_reason` is Some. Returns true when any entries were removed.
fn prune_dead_sessions(
    session_characters: &mut HashMap<String, String>,
    live_ids: &HashSet<String>,
) -> bool {
    let before = session_characters.len();
    session_characters.retain(|sid, _| live_ids.contains(sid));
    session_characters.len() < before
}

/// Collect the set of currently-live session ids from cached_instances.
/// A session is live when end_reason.is_none().
fn live_session_ids(state: &AppState) -> HashSet<String> {
    state
        .cached_instances
        .lock()
        .unwrap()
        .iter()
        .filter(|i| i.end_reason.is_none())
        .map(|i| i.session_id.clone())
        .collect()
}

/// Ensure a session has a character assigned. Prunes dead sessions first,
/// returns the existing assignment if already set, or picks a new one from
/// the project's whitelist while avoiding characters held by sibling sessions
/// in the same project.
#[tauri::command]
pub async fn ensure_session_character(
    session_id: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<Option<String>, String> {
    let live_ids = live_session_ids(&state);
    let instances = state.cached_instances.lock().unwrap().clone();

    // The whole settings mutation stays inside this block: its `MutexGuard` is
    // a std lock and the daemon push below is an await, so the two can never
    // overlap. `snapshot` is Some only when there is something to write out.
    let (pick, snapshot) = {
        let mut s = state.settings.lock().unwrap();
        let pruned = prune_dead_sessions(&mut s.session_characters, &live_ids);

        if let Some(existing) = s.session_characters.get(&session_id).cloned() {
            // Already assigned and session is live.
            (Some(existing), pruned.then(|| s.clone()))
        } else if let Some(inst) = instances.iter().find(|i| i.session_id == session_id) {
            let project_id = &inst.project_id;
            let proj_wl = s
                .projects
                .iter()
                .find(|p| p.id == *project_id)
                .map(|p| p.whitelist.clone())
                .unwrap_or(CharacterWhitelist::Default);

            let all = characters::list();
            let resolved = whitelist::resolve(&proj_wl, &s.default_character_whitelist, &all);

            // Chars taken by any OTHER live session (global dedup across all projects).
            let live_taken: HashSet<String> = instances
                .iter()
                .filter(|i| i.session_id != session_id && i.end_reason.is_none())
                .filter_map(|i| s.session_characters.get(&i.session_id).cloned())
                .collect();

            let pick = whitelist::pick_deterministic(&resolved, &live_taken, &session_id);
            if let Some(ref id) = pick {
                s.session_characters.insert(session_id.clone(), id.clone());
            }
            let dirty = pruned || pick.is_some();
            (pick, dirty.then(|| s.clone()))
        } else {
            // No Instance for this id, so no project to resolve a whitelist from.
            (None, pruned.then(|| s.clone()))
        }
    };

    if let Some(snapshot) = snapshot {
        persist(&app, &snapshot);
        push_to_daemon(&state, &snapshot).await;
    }

    Ok(pick)
}

/// Override or clear a session's character assignment explicitly.
#[tauri::command]
pub async fn set_session_character(
    session_id: String,
    character_id: Option<String>,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(), String> {
    let snapshot = {
        let mut s = state.settings.lock().unwrap();
        match character_id {
            Some(id) => { s.session_characters.insert(session_id, id); }
            None => { s.session_characters.remove(&session_id); }
        }
        s.clone()
    };
    persist(&app, &snapshot);
    push_to_daemon(&state, &snapshot).await;
    Ok(())
}

/// Pick a new character for a session, explicitly excluding its current one
/// so the reroll always produces something different when alternatives exist.
#[tauri::command]
pub async fn reroll_session_character(
    session_id: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<Option<String>, String> {
    let live_ids = live_session_ids(&state);
    let instances = state.cached_instances.lock().unwrap().clone();

    // Same guard-before-await shape as `ensure_session_character` above.
    let (pick, snapshot) = {
        let mut s = state.settings.lock().unwrap();
        let pruned = prune_dead_sessions(&mut s.session_characters, &live_ids);

        if let Some(inst) = instances.iter().find(|i| i.session_id == session_id) {
            let project_id = &inst.project_id;
            let proj_wl = s
                .projects
                .iter()
                .find(|p| p.id == *project_id)
                .map(|p| p.whitelist.clone())
                .unwrap_or(CharacterWhitelist::Default);

            let all = characters::list();
            let resolved = whitelist::resolve(&proj_wl, &s.default_character_whitelist, &all);

            // live_taken includes OTHER sessions PLUS the current session's char (forcing a change).
            let mut live_taken: HashSet<String> = instances
                .iter()
                .filter(|i| i.project_id == *project_id && i.end_reason.is_none())
                .filter_map(|i| s.session_characters.get(&i.session_id).cloned())
                .collect();
            // Also include current session's existing char so it can't be re-picked.
            if let Some(cur) = s.session_characters.get(&session_id).cloned() {
                live_taken.insert(cur);
            }

            let pick = whitelist::pick_random(&resolved, &live_taken);
            if let Some(ref id) = pick {
                s.session_characters.insert(session_id.clone(), id.clone());
            }
            (pick, Some(s.clone()))
        } else {
            // No Instance for this id: nothing to reroll against.
            (None, pruned.then(|| s.clone()))
        }
    };

    if let Some(snapshot) = snapshot {
        persist(&app, &snapshot);
        push_to_daemon(&state, &snapshot).await;
    }

    Ok(pick)
}

/// Return the session->character map, unpruned. A closed session's
/// assignment must survive so History can still show its portrait; pruning
/// happens only at assignment time (`ensure_session_character`,
/// `reroll_session_character`), which is where the map's growth is actually
/// bounded. Mirrors the daemon's read-only `list_session_characters` RPC.
#[tauri::command]
pub fn list_session_characters(state: State<AppState>) -> HashMap<String, String> {
    state.settings.lock().unwrap().session_characters.clone()
}

// ---------------------------------------------------------------------------
// Project whitelist commands
// ---------------------------------------------------------------------------

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
    push_to_daemon(&state, &snapshot).await;
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
    push_to_daemon(&state, &snapshot).await;
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
