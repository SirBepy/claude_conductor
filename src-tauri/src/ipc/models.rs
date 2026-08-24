//! Model-listing and availability-probe commands. Extracted from `misc.rs`
//! (ai_todo 101). Both endpoints authenticate with the Claude OAuth token in
//! `~/.claude/.credentials.json`, read via `accounts::identity::read_access_token`.
//!
//! ## Stale-token recovery (ai_todo 094-followup / 229)
//!
//! A 401 from either endpoint means the ACCESS token is stale (the app never
//! refreshes `.credentials.json` itself - locked decision, see
//! `docs/multi-account/00-overview.md`), not that the account is logged out.
//! Both `fetch_available_models` and `probe_models_availability` hand that
//! case to `models_auth::recover_from_401`, which triggers the `claude` CLI's
//! own token refresh and re-probes once. See `models_auth`'s module doc
//! comment for the full recovery story and the `AUTH_CACHE` backoff (split
//! out of this file in ai_todo 274, since it's a self-contained concern with
//! nothing to do with enumerating models).

use crate::accounts::identity::read_access_token;
use super::models_auth::{cached_needs_reauth, recover_from_401, RecoverResult};
use std::path::{Path, PathBuf};

/// Fetch the list of model IDs the signed-in account can use via the
/// Anthropic /v1/models endpoint, authenticated with the Claude OAuth token
/// stored in ~/.claude/.credentials.json.
///
/// Returns the raw list of model id strings newest-first as the API delivers
/// them. Curation (latest-per-family) and merge with user settings happen on
/// the frontend. Fails silently on any error (file missing, bad JSON, network
/// error, non-200, parse failure, or a stale token the CLI couldn't refresh)
/// and returns an empty vec, so a cold boot while offline never breaks the
/// model picker.
#[tauri::command]
pub async fn fetch_available_models() -> Vec<String> {
    match fetch_available_models_inner().await {
        Ok(models) => models,
        Err(e) => {
            log::debug!("fetch_available_models: {e}");
            vec![]
        }
    }
}

/// Config dir to probe: `account_id`'s, else the default account's. None
/// means fail open. `~/.claude` is the fallback for an EMPTY registry only -
/// it belongs to no registered account, so probing it when one IS registered
/// let an expired terminal login disable every account at once (todo 758).
fn config_dir_for_account(account_id: Option<&str>) -> Option<PathBuf> {
    let settings = crate::settings::paths::settings_file()
        .map(|p| crate::settings::load(&p))
        .ok()?;
    let resolved = crate::accounts::resolve_account(account_id, settings.default_account_id.as_deref());
    config_dir_from_resolution(resolved, || dirs::home_dir().map(|h| h.join(".claude")))
}

/// The fallback decision behind `config_dir_for_account`, split out because
/// the IO half reads the real settings/registry and can't be tested without
/// writing to the user's own AppData.
fn config_dir_from_resolution(
    resolved: Result<crate::accounts::Account, crate::accounts::AccountResolveError>,
    home_claude_dir: impl FnOnce() -> Option<PathBuf>,
) -> Option<PathBuf> {
    use crate::accounts::AccountResolveError;
    match resolved {
        Ok(account) => Some(account.config_dir),
        Err(AccountResolveError::NoAccounts) => home_claude_dir(),
        Err(_) => None,
    }
}

async fn fetch_available_models_inner() -> anyhow::Result<Vec<String>> {
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

/// Probe whether each given model id is actually usable by the signed-in
/// account.
///
/// The /v1/models listing is NOT a reliable availability signal: it keeps
/// listing models (e.g. Fable 5) even after Anthropic disables them. The free
/// /v1/messages/count_tokens endpoint, by contrast, returns 404
/// not_found_error for a disabled model, so we use it as a zero-cost probe — it
/// only counts tokens, it never generates, so it is never billed.
///
/// Returns a JSON array of `{ id, available, message, authExpired }`.
/// `message` carries the API's explanation when a model is unavailable
/// (e.g. "Claude Fable 5 is not available. Please use Opus 4.8."), null
/// otherwise. `authExpired` is true when a 401 survived a CLI-driven refresh
/// attempt - the account is genuinely logged out, not just "this model is
/// disabled"; the frontend should show a reconnect prompt, not a per-model
/// warning, and `available` is false in that case (never fail-open). Any
/// OTHER error on our side (no credentials configured yet, network failure,
/// 429, 5xx) is still treated as available=true so a transient/offline blip
/// never wrongly blocks the picker.
///
/// `account_id` names which registered account to probe under, so the
/// new-chat picker can re-probe when the user clicks a different account
/// chip. None falls back to the default account (see `config_dir_for_account`).
#[tauri::command]
pub async fn probe_models_availability(
    models: Vec<String>,
    account_id: Option<String>,
) -> serde_json::Value {
    let all_available = |models: Vec<String>| {
        serde_json::Value::Array(
            models
                .into_iter()
                .map(|id| serde_json::json!({ "id": id, "available": true, "message": null, "authExpired": false }))
                .collect(),
        )
    };
    let all_needs_reauth = |models: Vec<String>| {
        serde_json::Value::Array(
            models
                .into_iter()
                .map(|id| serde_json::json!({
                    "id": id,
                    "available": false,
                    "message": null,
                    "authExpired": true,
                }))
                .collect(),
        )
    };

    let config_dir = match config_dir_for_account(account_id.as_deref()) {
        Some(d) => d,
        None => return all_available(models),
    };

    // Backoff fast path (ai_todo 229): a config dir we already know needs
    // reauth doesn't get re-probed until the backoff window elapses.
    if cached_needs_reauth(&config_dir) {
        return all_needs_reauth(models);
    }

    let token = match read_access_token(&config_dir) {
        Some(t) => t,
        None => {
            log::debug!("probe_models_availability: no OAuth token in credentials");
            return all_available(models);
        }
    };
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            log::debug!("probe_models_availability: {e}");
            return all_available(models);
        }
    };

    let probes = models.into_iter().map(|id| {
        let client = client.clone();
        let token = token.clone();
        let config_dir = config_dir.clone();
        async move {
            let (available, message, auth_expired) =
                probe_one_model(&client, &config_dir, &token, &id).await;
            serde_json::json!({ "id": id, "available": available, "message": message, "authExpired": auth_expired })
        }
    });
    serde_json::Value::Array(futures_util::future::join_all(probes).await)
}

/// Outcome of a single count_tokens probe attempt.
enum ProbeOutcome {
    Available,
    Disabled(Option<String>),
    Unauthorized,
    /// Network error, 429, 5xx - our side misbehaving, not a real signal
    /// either way; caller fails this open.
    Other,
}

async fn probe_once(client: &reqwest::Client, token: &str, model: &str) -> ProbeOutcome {
    let body = serde_json::json!({
        "model": model,
        "messages": [{ "role": "user", "content": "hi" }],
    });
    let resp = match client
        .post("https://api.anthropic.com/v1/messages/count_tokens")
        .header("Authorization", format!("Bearer {token}"))
        .header("anthropic-version", "2023-06-01")
        .header("anthropic-beta", "oauth-2025-04-20")
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
    {
        Ok(r) => r,
        Err(_) => return ProbeOutcome::Other,
    };
    if resp.status().is_success() {
        return ProbeOutcome::Available;
    }
    if matches!(resp.status(), reqwest::StatusCode::UNAUTHORIZED | reqwest::StatusCode::FORBIDDEN) {
        return ProbeOutcome::Unauthorized;
    }
    if resp.status() != reqwest::StatusCode::NOT_FOUND {
        return ProbeOutcome::Other;
    }
    let message = resp
        .json::<serde_json::Value>()
        .await
        .ok()
        .and_then(|v| {
            v.get("error")
                .and_then(|e| e.get("message"))
                .and_then(|m| m.as_str())
                .map(String::from)
        });
    ProbeOutcome::Disabled(message)
}

/// Single count_tokens probe, with 401/403 recovery. Returns
/// `(available, optional API message, auth_expired)`.
///
/// Only a 404 not_found_error is treated as "Anthropic disabled this model"
/// (see module doc comment above). A 401/403 first triggers
/// `recover_from_401` (CLI-driven token refresh) and retries once with the
/// fresh token before concluding anything; if the retry ALSO fails auth, or
/// the CLI itself reports the account logged out, this returns
/// `auth_expired=true` with `available=false` - never fail-open on a real
/// auth failure. Any other non-auth error (429, 5xx, network blip) still
/// fails open (`available=true`) so a transient issue never wrongly blocks
/// the picker.
async fn probe_one_model(
    client: &reqwest::Client,
    config_dir: &Path,
    token: &str,
    model: &str,
) -> (bool, Option<String>, bool) {
    match probe_once(client, token, model).await {
        ProbeOutcome::Available => (true, None, false),
        ProbeOutcome::Disabled(message) => (false, message, false),
        ProbeOutcome::Other => (true, None, false),
        ProbeOutcome::Unauthorized => match recover_from_401(config_dir).await {
            RecoverResult::Refreshed(fresh_token) => match probe_once(client, &fresh_token, model).await {
                ProbeOutcome::Available => (true, None, false),
                ProbeOutcome::Disabled(message) => (false, message, false),
                ProbeOutcome::Other => (true, None, false),
                // Fresh token still 401'd - something's genuinely wrong with
                // auth beyond a stale access token; surface reconnect.
                ProbeOutcome::Unauthorized => (false, None, true),
            },
            RecoverResult::NeedsReauth => (false, None, true),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::config_dir_from_resolution;
    use crate::accounts::{Account, AccountResolveError};
    use std::path::PathBuf;

    fn acct() -> Account {
        Account {
            id: "acct-work".into(),
            label: "Work".into(),
            colour: "#fff".into(),
            icon: "user".into(),
            config_dir: PathBuf::from("C:/home/.claude-work"),
            chrome_profile_dir: PathBuf::from("C:/appdata/chrome-profiles/work"),
            email: "work@example.com".into(),
            org_uuid: "org-work".into(),
            subscription_tier: "claude_max".into(),
            created_at: "2026-07-07T00:00:00Z".into(),
            fleet_eligible: false,
        }
    }

    fn home() -> Option<PathBuf> {
        Some(PathBuf::from("C:/home/.claude"))
    }

    #[test]
    fn resolved_account_probes_its_own_dir() {
        let got = config_dir_from_resolution(Ok(acct()), home);
        assert_eq!(got, Some(PathBuf::from("C:/home/.claude-work")));
    }

    #[test]
    fn empty_registry_still_falls_back_to_home_claude() {
        let got = config_dir_from_resolution(Err(AccountResolveError::NoAccounts), home);
        assert_eq!(got, home());
    }

    // todo 758: ~/.claude belongs to no registered account, so probing it
    // when the registry IS populated let one expired terminal login disable
    // "Start session" for every account and model at once.
    #[test]
    fn populated_registry_without_a_default_never_probes_home_claude() {
        let got = config_dir_from_resolution(Err(AccountResolveError::NoDefault), home);
        assert_eq!(got, None);
    }

    #[test]
    fn unknown_account_never_probes_home_claude() {
        let got = config_dir_from_resolution(Err(AccountResolveError::NotFound("nope".into())), home);
        assert_eq!(got, None);
    }
}
