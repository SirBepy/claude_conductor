//! Global hook-registration IPC commands, split out of `ipc/projects.rs`
//! (todo 941) along that file's own `// --- Hook registration ---` section
//! seam, matching the precedent set by `ipc/token_source.rs` (todo 630).

use crate::state::AppState;
use crate::settings::{self, paths};
use tauri::{AppHandle, Emitter, State};

#[tauri::command]
pub async fn get_hook_registration_state(
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<serde_json::Value, String> {
    // Self-heal: if global settings already contain our hook entries
    // (e.g. app-data was wiped on reinstall but ~/.claude/settings.json
    // survived), flip the local flag so the consent modal stops
    // re-prompting forever.
    let needs_heal = {
        let s = state.settings.lock().unwrap();
        !s.hooks_registered && !s.hook_registration_declined
    };
    if needs_heal && crate::hooks::is_installed_globally() {
        // Built off a CLONE, not the live guard (todo 1004, item 6): the
        // cache is only overwritten after `settings::save` actually succeeds,
        // so a failed save can never leave the cache claiming
        // `hooks_registered` when disk doesn't have it.
        let mut snapshot = state.settings.lock().unwrap().clone();
        snapshot.hooks_registered = true;
        snapshot.hook_install_version = crate::hooks::CURRENT_INSTALL_VERSION;
        snapshot.bump_generation();
        let saved = match paths::settings_file() {
            Ok(path) => match settings::save(&path, &snapshot) {
                Ok(()) => {
                    *state.settings.lock().unwrap() = snapshot.clone();
                    true
                }
                Err(e) => {
                    log::error!("[settings] hook self-heal: save to {path:?} failed: {e:#}");
                    false
                }
            },
            Err(e) => {
                log::error!("[settings] hook self-heal: could not resolve settings path: {e}");
                false
            }
        };
        // Don't claim success to any settings-changed listener for a write
        // that didn't land.
        if saved {
            let _ = app.emit("settings-changed", snapshot);
        }
    }
    let s = state.settings.lock().unwrap();
    Ok(serde_json::json!({
        "registered": s.hooks_registered,
        "declined": s.hook_registration_declined,
        "port": s.hook_port,
    }))
}

#[tauri::command]
pub async fn register_hooks_globally(
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(), String> {
    let port = {
        let s = state.settings.lock().unwrap();
        s.hook_port.ok_or_else(|| "hook server not started yet".to_string())?
    };
    crate::hooks::install(crate::hooks::HookConfig { port })
        .map_err(|e| e.to_string())?;
    let path = paths::settings_file().map_err(|e| e.to_string())?;
    let snapshot = settings::mutate_and_save(&state.settings, &path, |s| {
        s.hooks_registered = true;
        s.hook_registration_declined = false;
        s.hook_install_version = crate::hooks::CURRENT_INSTALL_VERSION;
        Ok(())
    })?;
    let _ = app.emit("settings-changed", snapshot);
    Ok(())
}

#[tauri::command]
pub async fn skip_hook_registration(
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(), String> {
    let path = paths::settings_file().map_err(|e| e.to_string())?;
    let snapshot = settings::mutate_and_save(&state.settings, &path, |s| {
        s.hook_registration_declined = true;
        Ok(())
    })?;
    let _ = app.emit("settings-changed", snapshot);
    Ok(())
}
