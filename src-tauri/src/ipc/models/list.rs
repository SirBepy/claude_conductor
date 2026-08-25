//! Model-list fetching, the guts behind `fetch_available_models`. Split out
//! of `mod.rs` (ai_todo 761).

use super::config_dir::config_dir_for_account;
use crate::accounts::identity::read_access_token;
use crate::ipc::models_auth::{cached_needs_reauth, recover_from_401, RecoverResult};

pub(super) async fn fetch_available_models_inner() -> anyhow::Result<Vec<String>> {
    let config_dir = config_dir_for_account(None)
        .ok_or_else(|| anyhow::anyhow!("no resolvable account to read the model list under"))?;
    if cached_needs_reauth(&config_dir) {
        return Err(anyhow::anyhow!("auth expired - reconnect required (backoff)"));
    }
    let token = read_access_token(&config_dir)
        .ok_or_else(|| anyhow::anyhow!("no OAuth token in credentials"))?;

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()?;
    match fetch_models_list(&client, &token).await {
        Ok(ids) => Ok(ids),
        Err(ListFetchError::Unauthorized) => match recover_from_401(&config_dir).await {
            RecoverResult::Refreshed(fresh_token) => {
                fetch_models_list(&client, &fresh_token).await.map_err(|_| {
                    anyhow::anyhow!("auth still failing after CLI refresh")
                })
            }
            RecoverResult::NeedsReauth => Err(anyhow::anyhow!("auth expired - reconnect required")),
        },
        Err(ListFetchError::Other(e)) => Err(e),
    }
}

enum ListFetchError {
    Unauthorized,
    Other(anyhow::Error),
}

async fn fetch_models_list(client: &reqwest::Client, token: &str) -> Result<Vec<String>, ListFetchError> {
    let resp = client
        .get("https://api.anthropic.com/v1/models")
        .header("Authorization", format!("Bearer {token}"))
        .header("anthropic-version", "2023-06-01")
        .header("anthropic-beta", "oauth-2025-04-20")
        .send()
        .await
        .map_err(|e| ListFetchError::Other(e.into()))?;
    if matches!(resp.status(), reqwest::StatusCode::UNAUTHORIZED | reqwest::StatusCode::FORBIDDEN) {
        return Err(ListFetchError::Unauthorized);
    }
    let resp = resp.error_for_status().map_err(|e| ListFetchError::Other(e.into()))?;
    let body: serde_json::Value = resp.json().await.map_err(|e| ListFetchError::Other(e.into()))?;
    let ids = body
        .get("data")
        .and_then(|d| d.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|item| item.get("id").and_then(|v| v.as_str()).map(String::from))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Ok(ids)
}
