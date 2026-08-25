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
//!
//! Split into `list.rs` (model-list fetching), `probe.rs` (availability
//! probing) and `config_dir.rs` (account/config-dir resolution) in ai_todo
//! 761; the `#[tauri::command]` fns stay here since a re-export shim breaks
//! the macro, which needs its `__cmd__*` siblings in the same module.

mod config_dir;
mod list;
mod probe;

use crate::accounts::identity::read_access_token;
use crate::ipc::models_auth::cached_needs_reauth;
use config_dir::config_dir_for_account;
use list::fetch_available_models_inner;
use probe::probe_one_model;

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
