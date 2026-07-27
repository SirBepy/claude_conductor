//! Account registry management: list, remove (full teardown), logout (cookie
//! only), update (cosmetic fields), and set-default. Distinct from the
//! `wizard` module (which only ever creates one), and from `identity` (which
//! is read-only identity/drift surfaces).

use crate::accounts::model::Account;
use crate::accounts::{profile, store as accounts_store};
use crate::settings::paths;
use crate::state::AppState;
use tauri::{AppHandle, Emitter, State};

#[tauri::command]
pub fn list_accounts() -> Result<Vec<Account>, String> {
    let path = paths::accounts_file().map_err(|e| e.to_string())?;
    Ok(accounts_store::load(&path))
}

/// Full teardown: drop the record, delete its profile dir (junctions only -
/// never recurses into `~/.claude` targets, see `accounts::profile`), its
/// chrome profile dir, and its stored cookie. Clears `default_account_id` if
/// it pointed at the removed account.
#[tauri::command]
pub fn remove_account(account_id: String, state: State<AppState>, app: AppHandle) -> Result<(), String> {
    let accounts_path = paths::accounts_file().map_err(|e| e.to_string())?;
    let mut accounts = accounts_store::load(&accounts_path);
    let idx = accounts
        .iter()
        .position(|a| a.id == account_id)
        .ok_or_else(|| format!("no account with id {account_id}"))?;

    // Delete the profile dir BEFORE dropping the record: a locked dir (e.g.
    // the wizard's /login terminal still has its cwd inside it, os error 32)
    // must fail the whole removal and keep the account visible, not leave a
    // registry-less orphan dir behind (past incident, 2026-07-08).
    let removed = accounts[idx].clone();
    profile::delete_profile_dir(&removed.config_dir).map_err(|e| {
        format!(
            "could not delete the profile folder (close any terminal or program using {}): {e}",
            removed.config_dir.display()
        )
    })?;
    if removed.chrome_profile_dir.exists() {
        let _ = std::fs::remove_dir_all(&removed.chrome_profile_dir);
    }
    let session_file = paths::account_session_file(&removed.id).map_err(|e| e.to_string())?;
    let _ = crate::auth::session::clear(&session_file);

    accounts.remove(idx);
    accounts_store::save(&accounts_path, &accounts).map_err(|e| e.to_string())?;

    let settings_path = paths::settings_file().map_err(|e| e.to_string())?;
    let snapshot = {
        let mut settings = state.settings.lock().unwrap();
        if settings.default_account_id.as_deref() == Some(account_id.as_str()) {
            settings.default_account_id = None;
            let _ = crate::settings::save(&settings_path, &settings);
        }
        settings.clone()
    };
    // Tray only re-renders on "settings-changed"/"usage-updated" - without
    // this, a removed account would stay visible in the tray tooltip/menu
    // until the next scheduled poll (up to 600s), even though the account
    // list itself changed regardless of whether default_account_id did.
    let _ = app.emit("settings-changed", &snapshot);
    Ok(())
}

/// Per-account "log out": delete the stored cookie only. Keeps the record and
/// profile dir intact (CLI credentials untouched); chats simply stop
/// spawning for it until the cookie is recaptured. Never touches app data.
#[tauri::command]
pub fn logout_account(account_id: String, state: State<AppState>, app: AppHandle) -> Result<(), String> {
    let session_file = paths::account_session_file(&account_id).map_err(|e| e.to_string())?;
    crate::auth::session::clear(&session_file).map_err(|e| e.to_string())?;
    // Tray only re-renders on "settings-changed"/"usage-updated" - without
    // this, the account's now-missing cookie (chats stop spawning for it)
    // would be invisible in the tray until the next scheduled poll (up to
    // 600s). No settings actually changed; re-emitting the current snapshot
    // is just how the tray's existing listener is wired to trigger a rebuild.
    let snapshot = state.settings.lock().unwrap().clone();
    let _ = app.emit("settings-changed", &snapshot);
    Ok(())
}

/// Renames/recolours/re-icons an existing account (Settings > Accounts edit
/// panel), and/or flips its Jarvis fleet-eligibility opt-in (todo 272). Any
/// field left `None` is left untouched. Never touches identity, credentials,
/// or the cookie.
#[tauri::command]
pub fn update_account(
    account_id: String,
    label: Option<String>,
    colour: Option<String>,
    icon: Option<String>,
    fleet_eligible: Option<bool>,
    state: State<AppState>,
    app: AppHandle,
) -> Result<Account, String> {
    let accounts_path = paths::accounts_file().map_err(|e| e.to_string())?;
    let mut accounts = accounts_store::load(&accounts_path);
    let account = accounts
        .iter_mut()
        .find(|a| a.id == account_id)
        .ok_or_else(|| format!("no account with id {account_id}"))?;
    if let Some(label) = label {
        if label.trim().is_empty() {
            return Err("label must not be empty".to_string());
        }
        account.label = label;
    }
    if let Some(colour) = colour {
        account.colour = colour;
    }
    if let Some(icon) = icon {
        account.icon = icon;
    }
    if let Some(fleet_eligible) = fleet_eligible {
        account.fleet_eligible = fleet_eligible;
    }
    let updated = account.clone();
    accounts_store::save(&accounts_path, &accounts).map_err(|e| e.to_string())?;

    // Tray reads label/colour/icon for its per-account rows - without this
    // it would show the stale values until the next scheduled poll.
    let snapshot = state.settings.lock().unwrap().clone();
    let _ = app.emit("settings-changed", &snapshot);
    Ok(updated)
}

#[tauri::command]
pub async fn set_default_account(
    account_id: Option<String>,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(), String> {
    if let Some(id) = &account_id {
        let accounts_path = paths::accounts_file().map_err(|e| e.to_string())?;
        let accounts = accounts_store::load(&accounts_path);
        if !accounts.iter().any(|a| &a.id == id) {
            return Err(format!("no account with id {id}"));
        }
    }
    let settings_path = paths::settings_file().map_err(|e| e.to_string())?;
    let snapshot = {
        let mut settings = state.settings.lock().unwrap();
        settings.default_account_id = account_id;
        settings.clone()
    };
    crate::settings::save(&settings_path, &snapshot).map_err(|e| e.to_string())?;
    // Keep the daemon's cached default_account_id from going stale for the
    // lifetime of an already-connected session - see push_settings_to_daemon.
    crate::daemon_link::push_settings_to_daemon(&state, &snapshot).await;
    let _ = app.emit("settings-changed", &snapshot);
    Ok(())
}
