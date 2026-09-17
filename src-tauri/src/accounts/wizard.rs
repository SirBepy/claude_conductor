//! In-memory state for an in-progress "add account" wizard run. Never
//! persisted - if the app restarts mid-wizard, the session is gone and the
//! frontend starts over (the profile dir itself is safe either way: a
//! restart just means the next wizard run adopts it).

use super::identity::OauthAccountInfo;
use super::login_step::LoginWatch;
use std::path::PathBuf;

/// One in-progress add-account attempt, keyed by a random session id in
/// `AppState::account_wizard_sessions`.
#[derive(Debug, Clone)]
pub struct WizardSession {
    /// Id this account will get if the wizard completes (minted up front so
    /// the chrome-profile dir and, later, the sessionKey file can both be
    /// keyed by it consistently - see `settings::paths::account_*`).
    pub account_id: String,
    pub slug: String,
    pub config_dir: PathBuf,
    pub chrome_profile_dir: PathBuf,
    /// True only if THIS wizard run created `config_dir` fresh (not an
    /// adoption of a pre-existing dir). Cancel only deletes the dir when this
    /// is true - an adopted dir predates the wizard and is never ours to
    /// delete.
    pub created_new_dir: bool,
    /// The identity `config_dir` already held before this login attempt
    /// started (adoption case only). Used to detect a mismatched re-login
    /// into a different account inside the same dir.
    pub pre_existing_identity: Option<OauthAccountInfo>,
    /// Credential fingerprints of every OTHER profile dir, captured when the
    /// login terminal spawned - lets `check_login` warn when a /login landed
    /// in the wrong profile (see `login_step::detect_misdirected_login`).
    pub login_watch: LoginWatch,
    /// Filled in once `check_login` observes a fresh, non-duplicate identity.
    pub verified_identity: Option<OauthAccountInfo>,
    /// Filled in once the web-cookie capture step succeeds. Kept in memory
    /// only; never logged, never written to settings. Cleared (dropped) when
    /// the session is removed from the map on finalize or cancel.
    pub session_key: Option<String>,
}
