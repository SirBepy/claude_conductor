//! CLI-driven OAuth-token recovery for `ipc/models.rs`'s Anthropic API calls.
//! Extracted from `models.rs` (ai_todo 274) - a self-contained "probe the
//! token, refresh via `claude auth status --json`, back off on repeated
//! NeedsReauth" unit that has nothing to do with enumerating models.
//!
//! ## Stale-token recovery (ai_todo 094-followup / 229)
//!
//! After the PC sleeps past the access token's TTL, the app never refreshes
//! `.credentials.json` itself (locked decision - see
//! `docs/multi-account/00-overview.md`). Only the `claude` CLI refreshes the
//! ACCESS token in place, via the refresh token, when invoked (the refresh
//! token itself has a fixed lifetime from `/login` and needs periodic
//! re-login regardless - measured 2026-08-07/08, same doc). So a 401 in
//! `ipc/models.rs` means the ACCESS token is stale, not that the account is
//! logged out - and the fix is to trigger the CLI (which may refresh in
//! place) and re-probe, never to fake availability.
//!
//! `recover_from_401` does that: it shells out to the cheapest CLI
//! invocation that reports true auth state - `claude auth status --json` -
//! under the target account's `CLAUDE_CONFIG_DIR`. That call never starts a
//! session and is never billed, but like every `claude` invocation it
//! refreshes an expired access token via the refresh token before
//! answering. If it reports `loggedIn: true`, the access token is fresh on
//! disk again and callers re-read + retry once. If it reports `loggedIn:
//! false`, the refresh token is ALSO dead (or the account was never logged
//! in) and only an interactive re-login fixes it - that state is surfaced to
//! the UI as `authExpired`, never as fail-open "available".
//!
//! `AUTH_CACHE` backs this off per config dir: once a recovery attempt comes
//! back `loggedIn: false`, repeat probes within `REFRESH_BACKOFF` reuse that
//! verdict instead of re-spawning the CLI or re-hitting the Anthropic API,
//! which is what produced the 401 log-spam in ai_todo 229.

use crate::accounts::env::SpawnEnv;
use crate::accounts::identity::read_access_token;
use once_cell::sync::Lazy;
use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Minimum time between CLI-driven refresh attempts for the same config dir
/// once one has come back "not logged in". Callers inside this window reuse
/// the cached verdict instead of spawning `claude` or hitting the API again.
const REFRESH_BACKOFF: Duration = Duration::from_secs(60);

/// Per-config-dir cache of the last CLI-driven auth recovery attempt.
struct AuthProbeCache {
    last_attempt: Instant,
    /// `true` once `claude auth status` reported `loggedIn: true` (fresh or
    /// freshly-refreshed token); `false` means the account is genuinely
    /// logged out (refresh token dead too) and needs an interactive re-login.
    logged_in: bool,
}

static AUTH_CACHE: Lazy<Mutex<HashMap<String, AuthProbeCache>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Single-flight guard: concurrent probes (the `join_all` in
/// `probe_models_availability` fires one task per model) that all see a 401
/// at once must not each spawn their own `claude auth status` - only one
/// recovery attempt should ever be in flight for a given moment.
static REFRESH_LOCK: Lazy<tokio::sync::Mutex<()>> = Lazy::new(|| tokio::sync::Mutex::new(()));

fn cache_key(config_dir: &Path) -> String {
    config_dir.to_string_lossy().into_owned()
}

/// `true` if the cache already knows (within the backoff window) that this
/// config dir needs reauth - lets callers skip the network probe entirely.
pub(super) fn cached_needs_reauth(config_dir: &Path) -> bool {
    AUTH_CACHE
        .lock()
        .unwrap()
        .get(&cache_key(config_dir))
        .is_some_and(|c| !c.logged_in && c.last_attempt.elapsed() < REFRESH_BACKOFF)
}

/// Outcome of a CLI-driven recovery attempt.
pub(super) enum RecoverResult {
    /// The CLI confirms the account is logged in (token was fresh, or it
    /// just refreshed it) - here's the current access token, safe to retry
    /// the failed request once with it.
    Refreshed(String),
    /// The CLI itself reports the account is NOT logged in (refresh token
    /// dead too, or never logged in). Only an interactive re-login fixes
    /// this - never fail open here.
    NeedsReauth,
}

/// On a 401, ask the `claude` CLI (never us) to refresh `.credentials.json`
/// in place, then report whether it worked. Honors the locked "app never
/// writes credentials" decision (`docs/multi-account/00-overview.md`) - we
/// only trigger the CLI and re-read what it wrote; we never construct or
/// write a token ourselves.
pub(super) async fn recover_from_401(config_dir: &Path) -> RecoverResult {
    let key = cache_key(config_dir);

    if let Some(cached) = AUTH_CACHE.lock().unwrap().get(&key) {
        if cached.last_attempt.elapsed() < REFRESH_BACKOFF {
            if !cached.logged_in {
                return RecoverResult::NeedsReauth;
            }
            if let Some(token) = read_access_token(config_dir) {
                return RecoverResult::Refreshed(token);
            }
        }
    }

    // Single-flight: only one `claude auth status` runs at a time, even if
    // several model probes hit 401 in the same instant.
    let _guard = REFRESH_LOCK.lock().await;

    // Another task may have just finished a recovery attempt while we were
    // waiting on the lock - reuse its verdict instead of running the CLI
    // again.
    if let Some(cached) = AUTH_CACHE.lock().unwrap().get(&key) {
        if cached.last_attempt.elapsed() < REFRESH_BACKOFF {
            if !cached.logged_in {
                return RecoverResult::NeedsReauth;
            }
            if let Some(token) = read_access_token(config_dir) {
                return RecoverResult::Refreshed(token);
            }
        }
    }

    let logged_in = run_claude_auth_status(config_dir).await;
    AUTH_CACHE.lock().unwrap().insert(
        key,
        AuthProbeCache { last_attempt: Instant::now(), logged_in },
    );

    if !logged_in {
        return RecoverResult::NeedsReauth;
    }
    match read_access_token(config_dir) {
        Some(token) => RecoverResult::Refreshed(token),
        None => RecoverResult::NeedsReauth,
    }
}

/// Runs `claude auth status --json` under `config_dir`'s `CLAUDE_CONFIG_DIR`
/// and returns whether it reports `loggedIn: true`. Chosen deliberately as
/// the lightest CLI invocation that reports true auth state: it starts no
/// session, is never billed, and exits immediately - but like every `claude`
/// invocation it refreshes an expired access token via the refresh token as
/// part of answering, which is the side effect we actually want.
async fn run_claude_auth_status(config_dir: &Path) -> bool {
    let spawn_env = SpawnEnv::for_account(config_dir);
    let mut cmd = tokio::process::Command::new("claude");
    cmd.arg("auth")
        .arg("status")
        .arg("--json")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    spawn_env.apply_tokio(&mut cmd);
    crate::util::process::hide_console_tokio(&mut cmd);

    let output = match cmd.output().await {
        Ok(o) => o,
        Err(e) => {
            log::debug!("claude auth status: spawn failed: {e}");
            return false;
        }
    };
    let parsed: serde_json::Value = match serde_json::from_slice(&output.stdout) {
        Ok(v) => v,
        Err(e) => {
            log::debug!("claude auth status: parse failed: {e}");
            return false;
        }
    };
    parsed.get("loggedIn").and_then(|v| v.as_bool()).unwrap_or(false)
}
