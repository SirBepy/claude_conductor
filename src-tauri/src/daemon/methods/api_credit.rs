//! API-credit status RPCs: read the cached Console figures per `ApiCredit`
//! account, force a re-read, and store a Console login after proving it works.
//! The figures themselves are kept by `daemon::api_credit`.

use crate::accounts::{Account, ApiCreditStatus};
use crate::daemon::api_credit as hub;
use crate::daemon::rpc::{Router, RpcError};
use crate::daemon::state::DaemonState;
use crate::scraping::{fetch_spend_limits, ScrapeError, CONSOLE_BASE_URL};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

#[derive(Deserialize)]
struct AccountParams {
    account_id: String,
}

#[derive(Deserialize)]
struct SetConsoleSessionParams {
    account_id: String,
    session_key: String,
}

/// The registered ApiCredit account `account_id`, or an `invalid_params` that
/// says which of the two things was wrong.
fn api_credit_account(account_id: &str) -> Result<Account, RpcError> {
    let account = crate::accounts::load_registry()
        .into_iter()
        .find(|a| a.id == account_id)
        .ok_or_else(|| RpcError::invalid_params(format!("unknown account {account_id}")))?;
    if !account.is_api_credit() {
        return Err(RpcError::invalid_params(format!(
            "account {account_id} is not an API-credit account"
        )));
    }
    Ok(account)
}

fn parse<T: for<'de> Deserialize<'de>>(params: Option<Value>) -> Result<T, RpcError> {
    serde_json::from_value(params.unwrap_or(Value::Null))
        .map_err(|e| RpcError::invalid_params(e.to_string()))
}

/// Proves `session_key` can read `account`'s Console org (the spend-limit read
/// is the cheapest authenticated route), and only then saves it through
/// `save` and returns the freshly fetched status. A rejected key is never
/// stored, so a typo cannot overwrite a working login.
async fn connect_console(
    state: &DaemonState,
    account: &Account,
    session_key: &str,
    base_url: &str,
    save: impl FnOnce(&str, &str) -> anyhow::Result<()>,
) -> Result<ApiCreditStatus, RpcError> {
    let key = session_key.trim();
    if key.is_empty() {
        return Err(RpcError::invalid_params("session_key must not be empty"));
    }
    match fetch_spend_limits(base_url, key, &account.org_uuid).await {
        Ok(_) => {}
        Err(ScrapeError::Unauthorized | ScrapeError::Forbidden) => {
            return Err(RpcError::invalid_params(
                "The Console did not accept that login for this account's organisation. \
                 Sign in at platform.claude.com with the account that owns the API credit \
                 and copy its sessionKey cookie again.",
            ));
        }
        Err(e) => return Err(RpcError::internal(format!("could not reach the Console: {e:#}"))),
    }
    save(&account.id, key).map_err(|e| RpcError::internal(format!("saving the Console login: {e:#}")))?;
    let status = crate::accounts::api_credit_status::fetch_status(base_url, &account.id, &account.org_uuid, Some(key)).await;
    hub::store(state, status.clone());
    Ok(status)
}

pub fn register_api_credit(router: &mut Router, state: Arc<DaemonState>) {
    // Cached figures for every ApiCredit account that has been polled:
    // `{ [account_id]: ApiCreditStatus }`. Pure memory read, never a Console call.
    {
        let state = state.clone();
        router.register("get_api_credit_status", move |_params, _ctx| {
            let state = state.clone();
            async move { Ok(json!(state.api_credit.snapshot())) }
        });
    }
    // Forces a Console read for one account and returns the new status.
    {
        let state = state.clone();
        router.register("refresh_api_credit_status", move |params, _ctx| {
            let state = state.clone();
            async move {
                let p: AccountParams = parse(params)?;
                let account = api_credit_account(&p.account_id)?;
                Ok(json!(hub::refresh_account(&state, &account).await))
            }
        });
    }
    // Stores the Console `sessionKey` for an account after validating it, then
    // returns the refreshed status. Desktop pipe only (absent from the remote
    // transport table): it writes a credential.
    {
        let state = state.clone();
        router.register("set_console_session", move |params, _ctx| {
            let state = state.clone();
            async move {
                let p: SetConsoleSessionParams = parse(params)?;
                let account = api_credit_account(&p.account_id)?;
                let status = connect_console(
                    &state,
                    &account,
                    &p.session_key,
                    CONSOLE_BASE_URL,
                    crate::accounts::api_credit::save_console_session,
                )
                .await?;
                Ok(json!(status))
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::types::Settings;
    use std::cell::RefCell;

    fn account() -> Account {
        Account {
            id: "api-1".into(),
            label: "API credit".into(),
            colour: "#fff".into(),
            icon: "key".into(),
            config_dir: std::path::PathBuf::from("C:/home/.claude-api-credit"),
            chrome_profile_dir: std::path::PathBuf::from("C:/appdata/chrome-profiles/api-1"),
            email: String::new(),
            org_uuid: "ORG".into(),
            subscription_tier: String::new(),
            created_at: "2026-10-26T00:00:00Z".into(),
            fleet_eligible: false,
            kind: crate::accounts::AccountKind::ApiCredit,
        }
    }

    fn state() -> Arc<DaemonState> {
        DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()))
    }

    #[tokio::test]
    async fn a_working_login_is_saved_then_fetched_and_cached() {
        let mut server = mockito::Server::new_async().await;
        let _l = server.mock("GET", "/api/organizations/ORG/spend_limits")
            .match_header("cookie", "sessionKey=sk-good")
            .with_status(200).with_header("content-type", "application/json")
            .with_body(r#"{"spend_limits":[{"limit_usd":20000,"limit_action":"notify_and_pause"}],"enforced_limit_usd":20000000}"#)
            .create_async().await;
        let _c = server.mock("GET", "/api/organizations/ORG/prepaid/credits")
            .with_status(200).with_header("content-type", "application/json")
            .with_body(r#"{"amount":20416,"currency":"USD","promo_tranches":[{"program_id":"subscription_api_credit","granted_amount_minor_units":20000,"remaining_amount_minor_units":17871}],"tranches":[]}"#)
            .create_async().await;
        let _s = server.mock("GET", "/api/organizations/ORG/current_spend")
            .with_status(200).with_header("content-type", "application/json")
            .with_body(r#"{"amount":2128,"resets_at":"2026-11-01T00:00:00Z"}"#)
            .create_async().await;
        let st = state();
        let saved = RefCell::new(Vec::new());

        let status = connect_console(&st, &account(), "  sk-good  ", &server.url(), |id, key| {
            saved.borrow_mut().push((id.to_string(), key.to_string()));
            Ok(())
        })
        .await
        .unwrap();

        assert_eq!(saved.into_inner(), vec![("api-1".to_string(), "sk-good".to_string())]);
        assert_eq!(status.max_grant_remaining_cents, Some(17871));
        assert!(!status.blocked);
        assert_eq!(st.api_credit.get("api-1"), Some(status), "the refreshed status is cached");
    }

    #[tokio::test]
    async fn a_rejected_login_is_never_saved() {
        let mut server = mockito::Server::new_async().await;
        let _l = server.mock("GET", "/api/organizations/ORG/spend_limits")
            .with_status(403).create_async().await;
        let st = state();
        let saved = RefCell::new(false);

        let err = connect_console(&st, &account(), "sk-bad", &server.url(), |_, _| {
            *saved.borrow_mut() = true;
            Ok(())
        })
        .await
        .unwrap_err();

        assert_eq!(err.code, RpcError::invalid_params("").code);
        assert!(!saved.into_inner(), "a login the Console refuses must not overwrite the stored one");
        assert!(st.api_credit.get("api-1").is_none());
    }

    #[tokio::test]
    async fn an_empty_key_is_refused_without_a_request() {
        let err = connect_console(&state(), &account(), "   ", "http://127.0.0.1:1", |_, _| Ok(()))
            .await
            .unwrap_err();
        assert_eq!(err.code, RpcError::invalid_params("").code);
    }
}
