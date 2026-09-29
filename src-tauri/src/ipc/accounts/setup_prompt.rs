//! One-time "set up your accounts" migration prompt (milestone 08): tells the
//! dashboard whether to nudge the user into onboarding when a legacy,
//! pre-multi-account `session.txt` is still live and the registry is empty.

use crate::settings::paths;
use crate::state::AppState;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

#[derive(Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct AccountsSetupPromptState {
    pub should_show: bool,
}

/// Whether the dashboard should surface the "set up your accounts" prompt:
/// true only while the registry is still empty AND a legacy `session.txt`
/// exists AND the user hasn't dismissed it. Adding an account (which empties
/// the registry condition) or the migration retiring `session.txt` (which
/// empties the legacy-file condition) both stop the prompt on their own, so
/// there's no separate "seen" flag beyond the explicit dismiss.
#[tauri::command]
pub fn get_accounts_setup_prompt_state(state: State<AppState>) -> Result<AccountsSetupPromptState, String> {
    let accounts_path = paths::accounts_file().map_err(|e| e.to_string())?;
    let registry_empty = crate::accounts::store::load(&accounts_path).is_empty();
    let legacy_session_exists = paths::session_file().map(|p| p.exists()).unwrap_or(false);
    let dismissed = state.settings.lock().unwrap().accounts_setup_prompt_dismissed;
    Ok(AccountsSetupPromptState {
        should_show: crate::accounts::migration::should_show_setup_prompt(
            registry_empty,
            legacy_session_exists,
            dismissed,
        ),
    })
}

/// Persists the user's "not now" / dismiss on the setup prompt. Reusing the
/// prompt's conditions means re-showing it would require BOTH the registry
/// being empty again (it won't) and this flag being unset - so this is
/// effectively permanent for this install, matching `hook_registration_
/// declined`'s pattern (`ipc::projects::skip_hook_registration`).
#[tauri::command]
pub fn dismiss_accounts_setup_prompt(state: State<AppState>, app: AppHandle) -> Result<(), String> {
    let snapshot = {
        let mut s = state.settings.lock().unwrap();
        s.accounts_setup_prompt_dismissed = true;
        s.bump_generation();
        s.clone()
    };
    let path = paths::settings_file().map_err(|e| e.to_string())?;
    crate::settings::save(&path, &snapshot).map_err(|e| e.to_string())?;
    let _ = app.emit("settings-changed", &snapshot);
    Ok(())
}
