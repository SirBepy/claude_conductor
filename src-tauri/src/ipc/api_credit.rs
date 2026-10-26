//! Desktop IPC for the API-credit status the daemon keeps (`daemon::api_credit`).
//! Proxies over the daemon pipe, same pattern as `ipc/hidden_chats.rs`: the
//! daemon owns the figures and the send gate that reads them.

use crate::accounts::api_credit as credit_accounts;
use crate::accounts::{Account, ApiCreditStatus};
use crate::auth::login_flow::{self, LoginTarget};
use crate::scraping::{fetch_web_account, CONSOLE_BASE_URL};
use crate::settings::paths;
use crate::state::AppState;
use std::collections::HashMap;
use tauri::{AppHandle, Emitter, State};

const CLAUDE_AI_BASE_URL: &str = "https://claude.ai";

#[tauri::command]
pub async fn get_api_credit_status(
    state: State<'_, AppState>,
) -> Result<HashMap<String, ApiCreditStatus>, String> {
    let client = state.client().await.ok_or_else(|| "daemon client not connected".to_string())?;
    let v = client.get_api_credit_status().await.map_err(|e| e.to_string())?;
    serde_json::from_value(v).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn refresh_api_credit_status(
    account_id: String,
    state: State<'_, AppState>,
) -> Result<ApiCreditStatus, String> {
    let client = state.client().await.ok_or_else(|| "daemon client not connected".to_string())?;
    let v = client.refresh_api_credit_status(&account_id).await.map_err(|e| e.to_string())?;
    serde_json::from_value(v).map_err(|e| e.to_string())
}

/// Saves the account's Console `sessionKey` only after the Console accepts it
/// for the account's organisation; the error says so when it does not.
#[tauri::command]
pub async fn set_console_session(
    account_id: String,
    session_key: String,
    state: State<'_, AppState>,
) -> Result<ApiCreditStatus, String> {
    let client = state.client().await.ok_or_else(|| "daemon client not connected".to_string())?;
    let v = client.set_console_session(&account_id, &session_key).await.map_err(|e| e.to_string())?;
    serde_json::from_value(v).map_err(|e| e.to_string())
}

/// Trimmed `(label, api_key)`, or the message the Settings form shows.
fn check_add_inputs(label: &str, api_key: &str) -> Result<(String, String), String> {
    let (label, api_key) = (label.trim(), api_key.trim());
    if label.is_empty() {
        return Err("Give the account a label".to_string());
    }
    if api_key.is_empty() {
        return Err("Paste the API key".to_string());
    }
    if !api_key.starts_with("sk-ant-") {
        return Err("That doesn't look like an Anthropic API key (it starts with sk-ant-)".to_string());
    }
    Ok((label.to_string(), api_key.to_string()))
}

/// First Console (`api`-capable) org of the claude.ai login `session_key`, with
/// that login's email. `None` on any failure: the lookup only saves the user a
/// later step, so it must never block creating the account.
async fn console_identity(base_url: &str, session_key: &str) -> Option<(String, String)> {
    let identity = fetch_web_account(base_url, session_key).await.ok()?;
    let org = identity.api_org()?.uuid.clone();
    Some((org, identity.email_address))
}

/// Console org + email for a new account, borrowed from the default (else first)
/// Subscription account's stored claude.ai cookie; empty strings when unavailable.
async fn lookup_console_identity(default_account_id: Option<String>) -> (String, String) {
    let accounts = crate::accounts::load_registry();
    let Some(account) = credit_accounts::pick_lookup_account(&accounts, default_account_id.as_deref()) else {
        return Default::default();
    };
    let Some(cookie) = paths::account_session_file(&account.id)
        .ok()
        .and_then(|f| crate::auth::session::load(&f))
    else {
        return Default::default();
    };
    console_identity(CLAUDE_AI_BASE_URL, &cookie).await.unwrap_or_default()
}

fn emit_settings_changed(state: &AppState, app: &AppHandle) {
    let snapshot = state.settings.lock().unwrap().clone();
    let _ = app.emit("settings-changed", &snapshot);
}

/// Adds an API-credit account. The key is checked against Anthropic first (free
/// `GET /v1/models`), so a bad or workspace-less key never creates anything.
/// The Console org and email are filled from an existing Subscription login when
/// possible; otherwise `connect_console_login` fills them later. Never becomes
/// the default account.
#[tauri::command]
pub async fn add_api_credit_account(
    label: String,
    api_key: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<Account, String> {
    let (label, api_key) = check_add_inputs(&label, &api_key)?;
    credit_accounts::validate_api_key(credit_accounts::ANTHROPIC_API_BASE_URL, &api_key).await?;
    let default_id = state.settings.lock().unwrap().default_account_id.clone();
    let (org_uuid, email) = lookup_console_identity(default_id).await;
    let account = credit_accounts::create_api_credit_account(&label, &api_key, &org_uuid, &email)
        .map_err(|e| format!("{e:#}"))?;
    emit_settings_changed(&state, &app);
    Ok(account)
}

/// Opens a browser on platform.claude.com, captures the Console `sessionKey`
/// once the user signs in, fills the account's missing org uuid / email from it,
/// then hands the cookie to the daemon's `set_console_session` (validate, save,
/// refresh) and returns the fresh status.
#[tauri::command]
pub async fn connect_console_login(
    account_id: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<ApiCreditStatus, String> {
    let account = crate::accounts::load_registry()
        .into_iter()
        .find(|a| a.id == account_id)
        .ok_or_else(|| format!("no account with id {account_id}"))?;
    if !account.is_api_credit() {
        return Err("Connect Console only applies to an API-credit account".to_string());
    }

    let cookie = login_flow::run_for_account_at(app.clone(), account.chrome_profile_dir.clone(), LoginTarget::CONSOLE)
        .await
        .map_err(|e| e.to_string())?;

    if account.org_uuid.is_empty() {
        let (org_uuid, email) = console_identity(CONSOLE_BASE_URL, &cookie).await.ok_or_else(|| {
            "That Console login has no API organization. Sign in with the account that owns the API credit.".to_string()
        })?;
        let accounts_file = paths::accounts_file().map_err(|e| e.to_string())?;
        if credit_accounts::fill_missing_identity(&accounts_file, &account.id, &org_uuid, &email)
            .map_err(|e| format!("{e:#}"))?
        {
            emit_settings_changed(&state, &app);
        }
    }

    let client = state.client().await.ok_or_else(|| "daemon client not connected".to_string())?;
    let v = client.set_console_session(&account.id, &cookie).await.map_err(|e| e.to_string())?;
    serde_json::from_value(v).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn add_inputs_are_trimmed_and_refuse_empty_or_non_anthropic_keys() {
        assert_eq!(
            check_add_inputs("  Max credit ", "  sk-ant-dummy  "),
            Ok(("Max credit".to_string(), "sk-ant-dummy".to_string()))
        );
        assert_eq!(check_add_inputs("  ", "sk-ant-dummy").unwrap_err(), "Give the account a label");
        assert_eq!(check_add_inputs("x", "  ").unwrap_err(), "Paste the API key");
        assert!(check_add_inputs("x", "sk-openai-dummy").unwrap_err().contains("sk-ant-"));
    }

    #[tokio::test]
    async fn console_identity_takes_the_api_org_and_the_email() {
        let mut server = mockito::Server::new_async().await;
        let _m = server.mock("GET", "/api/account")
            .with_status(200).with_header("content-type", "application/json")
            .with_body(r#"{"email_address":"joe@example.com","memberships":[
                {"organization":{"uuid":"ORG-CHAT","capabilities":["claude_max","chat"]}},
                {"organization":{"uuid":"ORG-API","capabilities":["api","api_individual"]}}]}"#)
            .create_async().await;
        assert_eq!(
            console_identity(&server.url(), "dummy-cookie").await,
            Some(("ORG-API".to_string(), "joe@example.com".to_string()))
        );
    }

    #[tokio::test]
    async fn console_identity_is_none_on_rejection_or_without_an_api_org() {
        let mut server = mockito::Server::new_async().await;
        let m = server.mock("GET", "/api/account").with_status(403).create_async().await;
        assert_eq!(console_identity(&server.url(), "dummy-cookie").await, None);
        m.remove_async().await;
        let _m = server.mock("GET", "/api/account")
            .with_status(200).with_header("content-type", "application/json")
            .with_body(r#"{"email_address":"a@x.com","memberships":[{"organization":{"uuid":"C","capabilities":["chat"]}}]}"#)
            .create_async().await;
        assert_eq!(console_identity(&server.url(), "dummy-cookie").await, None);
    }
}
