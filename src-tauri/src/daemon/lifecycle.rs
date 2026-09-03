//! Per-session lifecycle: spawn / send_message / cancel_turn / end_session.
//! Owns the long-lived `claude -p --input-format stream-json` subprocess
//! per session and the stdout reader task that fans events into the
//! session's broadcast channel.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use thiserror::Error;

mod spawn;
mod teardown;
pub use spawn::*;
pub use teardown::*;

const VALID_MODELS: &[&str] = &["haiku", "sonnet", "opus", "fable"];
const VALID_EFFORTS: &[&str] = &["low", "medium", "high", "xhigh", "max"];

/// RPC code for [`LifecycleError::Busy`]. Distinct from `-32004` (NotFound),
/// which the desktop answers with a respawn-and-retry - a busy session must
/// not be retried, it must be held.
pub const SESSION_BUSY_CODE: i32 = -32006;

/// `Err` when the session is mid-turn (todo 873). The daemon has no turn
/// queue, so a second write into a live child re-opens the cancel-then-send
/// race that latched `busy`; frontends match `SESSION_BUSY:` on the message
/// and re-stage into the held queue. Mirrors `schedule_fire.rs`'s refusal.
pub fn refuse_if_busy(
    state: &crate::daemon::state::DaemonState,
    session_id: &str,
) -> Result<(), LifecycleError> {
    if state.registry.get(session_id).map(|i| i.busy).unwrap_or(false) {
        return Err(LifecycleError::Busy(session_id.to_string()));
    }
    Ok(())
}

/// Accept both bare family aliases (`opus`) and full model ids
/// (`claude-opus-4-8`). The session model picker is now data-driven from
/// `/v1/models`, which returns full ids; claude's `--model` flag accepts
/// either form, so validation only needs the family to be recognizable.
pub(crate) fn is_valid_model(model: &str) -> bool {
    let m = model.to_ascii_lowercase();
    VALID_MODELS.iter().any(|fam| m.contains(fam))
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct StartSessionParams {
    pub cwd: PathBuf,
    pub model: String,
    pub effort: String,
    /// If Some, resume an existing session JSONL; if None, generate a new UUID.
    pub resume_id: Option<String>,
    /// If true, spawn claude with `--remote-control`. Defaults to false when the
    /// caller omits it so non-chat spawn paths never register a bridge.
    #[serde(default)]
    pub remote: bool,
    /// Registry account id to spawn under. `Some(id)` is a caller-picked
    /// account - the new-chat account picker (milestone 04) supplies this
    /// explicitly. `None` resolves to the daemon's cached
    /// `Settings.default_account_id`, which every other spawn path (and the
    /// picker itself when "default" is selected) relies on.
    #[serde(default)]
    pub account_id: Option<String>,
    /// Fork `resume_id`'s transcript into a fresh session id instead of
    /// resuming it in place. Used by `move_session_to_account` so a chat can
    /// continue on a different account without ever rebinding an existing
    /// session id, which would break the one-account-per-session invariant.
    /// Requires `resume_id`; ignored otherwise.
    #[serde(default)]
    pub fork: bool,
    /// Caller-supplied id for the "mint a new id" branch, so the caller can
    /// register the id's chat-config (auto-accept) before the child boots -
    /// see `move_session_to_account`. `None` falls back to a fresh UUID.
    #[serde(default)]
    pub new_session_id: Option<String>,
}

#[derive(Debug, Error)]
pub enum LifecycleError {
    #[error("invalid model or effort: model={0}, effort={1}")]
    InvalidConfig(String, String),
    #[error("metered billing detected: {0}")]
    MeteredBilling(String),
    #[error("session id {0} already exists in map")]
    AlreadyExists(String),
    #[error("session id {0} not found")]
    NotFound(String),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("cwd does not exist: {0}")]
    CwdMissing(PathBuf),
    #[error("no accounts registered - add an account before starting a chat")]
    NoAccounts,
    #[error("no default account set - pick one in Settings > Accounts")]
    NoDefault,
    #[error("account {0} not found in the registry")]
    AccountNotFound(String),
    #[error("account drift: {0}")]
    AccountDrift(String),
    #[error("account credentials: {0}")]
    AccountCredentials(String),
    #[error("session {0} is frozen - unfreeze it first")]
    Frozen(String),
    /// The `SESSION_BUSY:` prefix is load-bearing: it rides `ClientError::Rpc`'s
    /// Display all the way to the webview, where `isSessionBusyError` keys off it.
    #[error("SESSION_BUSY: session {0} is mid-turn - hold this message until the turn ends")]
    Busy(String),
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::daemon::state::DaemonState;
    use crate::types::Settings;

    #[test]
    fn refuse_if_busy_only_refuses_a_mid_turn_session() {
        let state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        let settings = std::sync::Mutex::new(Settings::default());
        state.registry.record_interactive_session(
            "s",
            std::path::Path::new("/tmp/x"),
            &settings,
            "2026-09-03T00:00:00Z",
        );

        assert!(refuse_if_busy(&state, "s").is_ok(), "an idle session must accept a send");
        assert!(refuse_if_busy(&state, "ghost").is_ok(), "an unknown session is NotFound's call, not ours");

        state.registry.set_busy("s", true);
        let err = refuse_if_busy(&state, "s").expect_err("a mid-turn session must be refused");
        assert!(
            err.to_string().starts_with("SESSION_BUSY:"),
            "the frontend re-stage path keys off this prefix: {err}"
        );
    }
}
