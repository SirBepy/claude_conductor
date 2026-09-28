//! Global hook-registration IPC commands, split out of `ipc/projects.rs`
//! (todo 941) along that file's own `// --- Hook registration ---` section
//! seam, matching the precedent set by `ipc/token_source.rs` (todo 630).

use crate::state::AppState;
use crate::settings::{self, paths};
use tauri::{AppHandle, Emitter, State};

#[tauri::command]
pub fn get_hook_registration_state(
    state: State<AppState>,
    app: AppHandle,
) -> serde_json::Value {
    // Self-heal: if global settings already contain our hook entries
    // (e.g. app-data was wiped on reinstall but ~/.claude/settings.json
    // survived), flip the local flag so the consent modal stops
    // re-prompting forever.
    let needs_heal = {
        let s = state.settings.lock().unwrap();
        !s.hooks_registered && !s.hook_registration_declined
    };
    if needs_heal && crate::hooks::is_installed_globally() {
        let snapshot = {
            let mut g = state.settings.lock().unwrap();
            g.hooks_registered = true;
            g.hook_install_version = crate::hooks::CURRENT_INSTALL_VERSION;
            g.clone()
        };
        let saved = match paths::settings_file() {
            Ok(path) => match settings::save(&path, &snapshot) {
                Ok(()) => true,
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
    serde_json::json!({
        "registered": s.hooks_registered,
        "declined": s.hook_registration_declined,
        "port": s.hook_port,
    })
}

#[tauri::command]
pub fn register_hooks_globally(
    state: State<AppState>,
    app: AppHandle,
) -> Result<(), String> {
    let port = {
        let s = state.settings.lock().unwrap();
        s.hook_port.ok_or_else(|| "hook server not started yet".to_string())?
    };
    crate::hooks::install(crate::hooks::HookConfig { port })
        .map_err(|e| e.to_string())?;
    let snapshot = {
        let mut g = state.settings.lock().unwrap();
        g.hooks_registered = true;
        g.hook_registration_declined = false;
        g.hook_install_version = crate::hooks::CURRENT_INSTALL_VERSION;
        g.clone()
    };
    let path = paths::settings_file().map_err(|e| e.to_string())?;
    settings::save(&path, &snapshot).map_err(|e| e.to_string())?;
    let _ = app.emit("settings-changed", snapshot);
    Ok(())
}

#[tauri::command]
pub fn skip_hook_registration(
    state: State<AppState>,
    app: AppHandle,
) -> Result<(), String> {
    let snapshot = {
        let mut g = state.settings.lock().unwrap();
        g.hook_registration_declined = true;
        g.clone()
    };
    let path = paths::settings_file().map_err(|e| e.to_string())?;
    settings::save(&path, &snapshot).map_err(|e| e.to_string())?;
    let _ = app.emit("settings-changed", snapshot);
    Ok(())
}
