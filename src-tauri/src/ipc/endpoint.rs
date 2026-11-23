//! Desktop IPC for `AccountKind::Endpoint` accounts (docs/architecture/providers.md).
//! Desktop-process Tauri commands like `add_api_credit_account`: they write
//! `accounts.json` and the DPAPI key file directly, so nothing here has a daemon
//! method, a `TRANSPORT_TABLE` row, or a path for the key to cross a remote
//! transport. Removing one is the ordinary `remove_account`, which already
//! deletes the key file next to the profile folder.

use crate::accounts::endpoint::{self as endpoints, EndpointUpdate};
use crate::accounts::{api_credit as credit_accounts, Account, EndpointAuth, EndpointPreset};
use crate::settings::paths;
use crate::state::AppState;
use tauri::{AppHandle, State};

/// Adds an Endpoint account. The key is stored DPAPI-wrapped beside the other
/// account secrets, never in `accounts.json`. Not checked against the provider:
/// each vendor's "is this key good" route differs, and a wrong key shows at the
/// first turn. Never becomes the default account on its own.
#[tauri::command]
pub async fn add_endpoint_account(
    label: String,
    preset: EndpointPreset,
    base_url: String,
    auth_style: EndpointAuth,
    models: Vec<String>,
    api_key: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<Account, String> {
    let label = label.trim().to_string();
    if label.is_empty() {
        return Err("Give the account a label".to_string());
    }
    let api_key = endpoints::check_key(&api_key)?;
    let config = endpoints::check_config(preset, &base_url, auth_style, &models)?;
    let account = endpoints::create_endpoint_account(&label, config, &api_key).map_err(|e| format!("{e:#}"))?;
    super::api_credit::emit_settings_changed(&state, &app);
    Ok(account)
}

/// Edits an Endpoint account's label, preset, base URL, auth style or model
/// list; a `None` leaves that field alone. The key is `replace_endpoint_key`'s.
#[tauri::command]
pub async fn update_endpoint_account(
    account_id: String,
    label: Option<String>,
    preset: Option<EndpointPreset>,
    base_url: Option<String>,
    auth_style: Option<EndpointAuth>,
    models: Option<Vec<String>>,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<Account, String> {
    let accounts_file = paths::accounts_file().map_err(|e| e.to_string())?;
    let updated = endpoints::update_endpoint_account_in(
        &accounts_file,
        &account_id,
        EndpointUpdate { label, preset, base_url, auth_style, models },
    )?;
    super::api_credit::emit_settings_changed(&state, &app);
    Ok(updated)
}

/// Replaces an Endpoint account's stored key (rotated, revoked, mistyped).
#[tauri::command]
pub async fn replace_endpoint_key(account_id: String, api_key: String) -> Result<(), String> {
    let api_key = endpoints::check_key(&api_key)?;
    endpoints::require_endpoint_account(&crate::accounts::load_registry(), &account_id)?;
    credit_accounts::save_api_key(&account_id, &api_key).map_err(|e| format!("{e:#}"))
}
