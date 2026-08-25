//! Per-model availability probing, the guts behind `probe_models_availability`.
//! Split out of `mod.rs` (ai_todo 761).

use crate::ipc::models_auth::{recover_from_401, RecoverResult};
use std::path::Path;

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
pub(super) async fn probe_one_model(
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
