//! Identity/re-auth surfaces: the terminal's own identity, an account's live
//! identity + drift/cookie status (Settings > Accounts), and the two actions
//! that fix drift or a missing cookie without touching the account record.

use crate::accounts::{drift, identity, login_step, store as accounts_store, OauthAccountInfo};
use crate::settings::paths;
use serde::Serialize;
use tauri::AppHandle;

/// The terminal's observed identity (`~/.claude.json`, HOME dir, not inside
/// `~/.claude`). Read-only - the terminal is never an app account.
#[tauri::command]
pub fn get_terminal_identity() -> Option<OauthAccountInfo> {
    let home = dirs::home_dir()?;
    crate::accounts::terminal_identity(&home)
}

/// The Settings > Accounts identity surface (multi-account milestone 07):
/// the profile dir's LIVE `oauthAccount` (may differ from the registry
/// record if someone ran `/login` again since onboarding), the CLI token's
/// expiry, whether a web cookie is currently saved, and a drift flag/message
/// reusing `accounts::drift`'s comparison. All reads, never writes.
#[derive(Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct AccountIdentity {
    pub oauth_account: Option<OauthAccountInfo>,
    pub token_expires_at: Option<i64>,
    pub refresh_token_expires_at: Option<i64>,
    pub has_cookie: bool,
    pub drift: bool,
    pub drift_message: Option<String>,
}

#[tauri::command]
pub fn get_account_identity(account_id: String) -> Result<AccountIdentity, String> {
    let accounts_path = paths::accounts_file().map_err(|e| e.to_string())?;
    let accounts = accounts_store::load(&accounts_path);
    let account = accounts
        .iter()
        .find(|a| a.id == account_id)
        .ok_or_else(|| format!("no account with id {account_id}"))?;

    let oauth_account = identity::read_oauth_account(&account.config_dir);
    let token_expires_at = identity::read_token_expiry(&account.config_dir);
    let refresh_token_expires_at = identity::read_refresh_token_expires_at(&account.config_dir);
    let (is_drift, drift_message) = match drift::compare(account, oauth_account.as_ref(), token_expires_at.is_some()) {
        Ok(()) => (false, None),
        Err(e) => (true, Some(e.to_string())),
    };
    let session_file = paths::account_session_file(&account.id).map_err(|e| e.to_string())?;
    let has_cookie = crate::auth::session::load(&session_file).is_some();

    Ok(AccountIdentity {
        oauth_account,
        token_expires_at,
        refresh_token_expires_at,
        has_cookie,
        drift: is_drift,
        drift_message,
    })
}

/// Re-auth: relaunches the same visible `/login` terminal step the wizard
/// uses, targeted at an EXISTING account's `config_dir`. For when the CLI
/// identity has drifted or the token needs a fresh interactive login - the
/// account record, colour, icon, and cookie are untouched.
#[tauri::command]
pub fn reauth_account(account_id: String) -> Result<(), String> {
    let accounts_path = paths::accounts_file().map_err(|e| e.to_string())?;
    let accounts = accounts_store::load(&accounts_path);
    let account = accounts
        .iter()
        .find(|a| a.id == account_id)
        .ok_or_else(|| format!("no account with id {account_id}"))?;
    login_step::spawn_login_terminal(&account.config_dir, &account.label).map_err(|e| e.to_string())
}

/// Per-account cookie (re)capture for accounts that skipped the browser step
/// during onboarding, or whose cookie was cleared by "Log out". Mirrors
/// `add_account_capture_cookie` + the session-key-save half of
/// `add_account_finalize`, but runs directly against an already-registered
/// account instead of an in-flight wizard session.
#[tauri::command]
pub async fn recapture_account_cookie(account_id: String, app: AppHandle) -> Result<(), String> {
    let (chrome_profile_dir, org_uuid) = {
        let accounts_path = paths::accounts_file().map_err(|e| e.to_string())?;
        let accounts = accounts_store::load(&accounts_path);
        let account = accounts
            .iter()
            .find(|a| a.id == account_id)
            .ok_or_else(|| format!("no account with id {account_id}"))?;
        (account.chrome_profile_dir.clone(), account.org_uuid.clone())
    };

    let session_key = crate::auth::login_flow::run_for_account(app, chrome_profile_dir)
        .await
        .map_err(|e| e.to_string())?;

    let orgs = crate::scraping::client::fetch_org_list("https://claude.ai", &session_key)
        .await
        .map_err(|e| e.to_string())?;
    if !orgs.iter().any(|o| o.uuid == org_uuid) {
        return Err(
            "the browser login belongs to a different account than this profile - log into the same account"
                .to_string(),
        );
    }

    let session_file = paths::account_session_file(&account_id).map_err(|e| e.to_string())?;
    crate::auth::session::save(&session_file, &session_key).map_err(|e| e.to_string())
}
