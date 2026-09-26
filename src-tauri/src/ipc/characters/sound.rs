//! Character sound-slot playback and asset-preview IPC commands, split out of
//! `ipc/characters.rs` (todo 949's fallback group) once the whitelist split
//! alone did not clear the ~300-line rule.

use crate::characters;
use crate::characters::slots::Slot;
use crate::state::AppState;
use tauri::{AppHandle, State};

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
