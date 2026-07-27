//! Add-account wizard flow (browser-first since 2026-07-08): `add_account_create`
//! (profile dir only, no terminal) -> `add_account_capture_cookie` (web
//! sessionKey + identity from `GET /api/account`) -> when the dir has no
//! valid credentials, `add_account_start_cli_login` (spawn the `/login`
//! terminal) + poll `add_account_check_login` until `Ready` ->
//! `add_account_finalize` (persist). The browser step is skippable; the flow
//! then degrades to the original CLI-identity path. `add_account_cancel` at
//! any point cleans up a dir THIS wizard run created (never an adopted
//! pre-existing dir).

use crate::accounts::model::{slugify, Account};
use crate::accounts::{login_step, profile, store as accounts_store, OauthAccountInfo, WizardSession};
use crate::settings::paths;
use crate::state::AppState;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

fn home_claude_dir() -> Result<std::path::PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "could not resolve home dir".to_string())?;
    Ok(home.join(".claude"))
}

#[derive(Serialize, ts_rs::TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct AddAccountSession {
    pub session_id: String,
    pub config_dir: std::path::PathBuf,
    /// True if `config_dir` already existed (adoption path). Only meaningful
    /// to the user when `existing_identity` is also set - a cancelled wizard
    /// run can leave an empty husk dir behind (the open terminal locks it
    /// against deletion), and adopting a husk is indistinguishable from a
    /// fresh add.
    pub adopted_existing: bool,
    pub existing_identity: Option<OauthAccountInfo>,
    /// True when the dir already holds a valid (parseable) `.credentials.json`
    /// - the CLI `/login` step is unnecessary and the wizard can go straight
    /// from the browser step to finalize (browser-first flow, 2026-07-08).
    pub has_credentials: bool,
}

#[derive(Serialize, Debug, ts_rs::TS)]
#[serde(tag = "status")]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub enum LoginCheckOutcome {
    /// No complete login observed in the profile dir yet; keep polling.
    /// `misdirected` carries a hint when a login was just observed landing in
    /// a DIFFERENT profile (wrong terminal) - a nudge, not a hard failure,
    /// since token auto-refresh also rewrites credentials files.
    /// `credentials_no_profile` is true when the dir already holds a valid
    /// `.credentials.json` but the CLI hasn't written `oauthAccount` yet - the
    /// user isn't stuck waiting on `/login`, they just haven't run an
    /// interactive turn in that terminal since.
    Pending { misdirected: Option<String>, credentials_no_profile: bool },
    /// A fresh, non-duplicate identity was observed - ready to capture the
    /// cookie and/or finalize.
    Ready { identity: OauthAccountInfo },
    /// The dir being adopted already belonged to a different account than
    /// the one that just logged in.
    Mismatch { existing_email: String, new_email: String },
    /// This org/email is already registered under another account.
    Duplicate { existing_label: String },
}

/// Step 1: create (or adopt) the profile dir. No terminal is spawned here -
/// the browser step comes first; the `/login` terminal only spawns on demand
/// via `add_account_start_cli_login` when the dir has no credentials yet.
/// `slug` defaults to a slugified `label` when omitted.
#[tauri::command]
pub fn add_account_create(
    label: String,
    slug: Option<String>,
    state: State<AppState>,
) -> Result<AddAccountSession, String> {
    let slug = slug.unwrap_or_else(|| slugify(&label));
    if slug.trim().is_empty() {
        return Err("slug must not be empty".to_string());
    }
    let home_claude = home_claude_dir()?;
    let outcome = profile::create_or_adopt_profile_dir(&home_claude, &slug)
        .map_err(|e| e.to_string())?;

    // A collision with an already-REGISTERED account's dir is a slug clash,
    // not a fresh add or a legitimate hand-built-dir adoption. Since that
    // dir already existed, create_or_adopt_profile_dir only filled in
    // (harmless, idempotent) missing links - nothing to clean up here.
    let accounts_path = paths::accounts_file().map_err(|e| e.to_string())?;
    let registered = accounts_store::load(&accounts_path);
    if registered.iter().any(|a| a.config_dir == outcome.config_dir) {
        return Err(format!("\"{slug}\" is already a registered account"));
    }

    let existing_identity = crate::accounts::identity::read_oauth_account(&outcome.config_dir);
    let has_credentials = crate::accounts::identity::read_token_expiry(&outcome.config_dir).is_some();

    let account_id = uuid::Uuid::new_v4().to_string();
    let chrome_profile_dir =
        paths::account_chrome_profile_dir(&account_id).map_err(|e| e.to_string())?;
    let session_id = uuid::Uuid::new_v4().to_string();

    let result = AddAccountSession {
        session_id: session_id.clone(),
        config_dir: outcome.config_dir.clone(),
        adopted_existing: !outcome.created_new,
        existing_identity: existing_identity.clone(),
        has_credentials,
    };
    let session = WizardSession {
        account_id,
        slug,
        config_dir: outcome.config_dir,
        chrome_profile_dir,
        created_new_dir: outcome.created_new,
        pre_existing_identity: existing_identity,
        login_watch: login_step::LoginWatch::default(),
        verified_identity: None,
        session_key: None,
    };
    state.account_wizard_sessions.lock().unwrap().insert(session_id, session);
    Ok(result)
}

/// Spawns the visible `/login` terminal for an in-progress wizard session and
/// arms the misdirected-login watch. Called when the flow actually needs a
/// CLI login (fresh dir, or the user skipped the browser step). Returns the
/// terminal window title so the UI can say exactly which window to type into.
/// Idempotent-ish: calling again just spawns another terminal (matches the
/// reauth behavior); the watch baseline resets each call.
#[tauri::command]
pub fn add_account_start_cli_login(
    session_id: String,
    state: State<AppState>,
) -> Result<String, String> {
    let (config_dir, slug) = {
        let sessions = state.account_wizard_sessions.lock().unwrap();
        let session = sessions
            .get(&session_id)
            .ok_or_else(|| "wizard session not found or already finished".to_string())?;
        (session.config_dir.clone(), session.slug.clone())
    };

    let watch = dirs::home_dir()
        .map(|home| login_step::capture_login_watch(&home, &config_dir))
        .unwrap_or_default();
    login_step::spawn_login_terminal(&config_dir, &slug).map_err(|e| e.to_string())?;

    let mut sessions = state.account_wizard_sessions.lock().unwrap();
    if let Some(session) = sessions.get_mut(&session_id) {
        session.login_watch = watch;
    }
    Ok(login_step::login_terminal_title(&slug))
}

/// Pure decision core of `add_account_check_login`, split out for unit tests.
/// `web_identity` is the browser-derived identity when the cookie step
/// already ran (browser-first flow): it upgrades `CredentialsNoProfile` to
/// `Ready` (the credentials exist and the account is known) and mismatch-
/// checks a CLI login against what the browser said.
fn resolve_login_outcome(
    poll: login_step::LoginPollResult,
    web_identity: Option<&OauthAccountInfo>,
    pre_existing_identity: Option<&OauthAccountInfo>,
    registered: &[Account],
    config_dir: &std::path::Path,
    misdirected: Option<String>,
) -> LoginCheckOutcome {
    let identity = match poll {
        login_step::LoginPollResult::Pending => {
            return LoginCheckOutcome::Pending { misdirected, credentials_no_profile: false }
        }
        login_step::LoginPollResult::CredentialsNoProfile => {
            // Valid credentials + a browser-confirmed identity = complete;
            // the CLI just never writes `oauthAccount` outside /login itself.
            match web_identity {
                Some(web) => return LoginCheckOutcome::Ready { identity: web.clone() },
                None => {
                    return LoginCheckOutcome::Pending { misdirected, credentials_no_profile: true }
                }
            }
        }
        login_step::LoginPollResult::Ready(identity) => identity,
    };

    let mismatch_against = |other: &OauthAccountInfo| {
        other.organization_uuid != identity.organization_uuid
            || !other.email_address.eq_ignore_ascii_case(&identity.email_address)
    };
    if let Some(pre) = pre_existing_identity {
        if mismatch_against(pre) {
            return LoginCheckOutcome::Mismatch {
                existing_email: pre.email_address.clone(),
                new_email: identity.email_address.clone(),
            };
        }
    }
    if let Some(web) = web_identity {
        if mismatch_against(web) {
            return LoginCheckOutcome::Mismatch {
                existing_email: web.email_address.clone(),
                new_email: identity.email_address.clone(),
            };
        }
    }

    if let Some(dup) = accounts_store::find_duplicate(
        registered,
        &identity.organization_uuid,
        &identity.email_address,
        Some(config_dir),
    ) {
        return LoginCheckOutcome::Duplicate { existing_label: dup.label.clone() };
    }

    LoginCheckOutcome::Ready { identity }
}

/// CLI-login step: poll for a fresh `oauthAccount` (or, browser-first, for
/// credentials landing in a dir whose identity the cookie already confirmed).
/// Call repeatedly until it stops returning `Pending` (or the user cancels /
/// a frontend-owned timeout fires `add_account_cancel`).
#[tauri::command]
pub fn add_account_check_login(
    session_id: String,
    state: State<AppState>,
) -> Result<LoginCheckOutcome, String> {
    let accounts_path = paths::accounts_file().map_err(|e| e.to_string())?;
    let registered = accounts_store::load(&accounts_path);

    let mut sessions = state.account_wizard_sessions.lock().unwrap();
    let session = sessions
        .get_mut(&session_id)
        .ok_or_else(|| "wizard session not found or already finished".to_string())?;

    let outcome = resolve_login_outcome(
        login_step::poll_login(&session.config_dir),
        session.verified_identity.as_ref(),
        session.pre_existing_identity.as_ref(),
        &registered,
        &session.config_dir,
        login_step::detect_misdirected_login(&session.login_watch),
    );
    if let LoginCheckOutcome::Ready { identity } = &outcome {
        session.verified_identity = Some(identity.clone());
    }
    Ok(outcome)
}

/// Browser-login step (step 2 in the browser-first flow): grab the web
/// `sessionKey` cookie via the existing CDP browser flow (own chrome profile
/// dir per account) and derive the account identity from `GET /api/account`
/// (email + chat-capable org - one login can also hold an API-only Console
/// org, see `WebAccountIdentity::chat_org`). Runs the same dedup check the
/// CLI path uses, and cross-checks against any identity already known (CLI
/// `Ready` when the user did /login first, or an adopted dir's pre-existing
/// `oauthAccount`). Returns the derived identity for the wizard to display.
#[tauri::command]
pub async fn add_account_capture_cookie(
    session_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<OauthAccountInfo, String> {
    let (chrome_profile_dir, config_dir, known_identity) = {
        let sessions = state.account_wizard_sessions.lock().unwrap();
        let session = sessions
            .get(&session_id)
            .ok_or_else(|| "wizard session not found or already finished".to_string())?;
        let known = session
            .verified_identity
            .clone()
            .or_else(|| session.pre_existing_identity.clone());
        (session.chrome_profile_dir.clone(), session.config_dir.clone(), known)
    };

    let session_key = crate::auth::login_flow::run_for_account(app, chrome_profile_dir)
        .await
        .map_err(|e| e.to_string())?;

    let account = crate::scraping::client::fetch_web_account("https://claude.ai", &session_key)
        .await
        .map_err(|e| e.to_string())?;
    let org = account
        .chat_org()
        .ok_or_else(|| "the browser account has no claude.ai organization".to_string())?;
    let identity = OauthAccountInfo {
        email_address: account.email_address.clone(),
        organization_uuid: org.uuid.clone(),
        organization_name: org.name.clone(),
        organization_type: org.subscription_tier(),
    };

    // Cross-check: when this profile dir already has a known identity (CLI
    // login ran first, or an adopted dir's oauthAccount), the browser login
    // must belong to the same account. Membership in the same org is the
    // comparison (org uuid), matching the old org-list cross-check.
    if let Some(known) = &known_identity {
        if known.organization_uuid != identity.organization_uuid {
            return Err(format!(
                "the browser login ({}) belongs to a different account than this profile ({}) - log into the same account",
                identity.email_address, known.email_address
            ));
        }
    }

    let accounts_path = paths::accounts_file().map_err(|e| e.to_string())?;
    let registered = accounts_store::load(&accounts_path);
    if let Some(dup) = accounts_store::find_duplicate(
        &registered,
        &identity.organization_uuid,
        &identity.email_address,
        Some(config_dir.as_path()),
    ) {
        return Err(format!("already added as \"{}\"", dup.label));
    }

    let mut sessions = state.account_wizard_sessions.lock().unwrap();
    if let Some(session) = sessions.get_mut(&session_id) {
        session.session_key = Some(session_key);
        // A CLI-verified identity (organizationType straight from the CLI)
        // stays authoritative; only fill in when the browser is the first
        // identity source.
        if session.verified_identity.is_none() {
            session.verified_identity = Some(identity.clone());
        }
    }
    Ok(identity)
}

/// Cancel an in-progress wizard run. Deletes the profile dir ONLY if this
/// wizard run created it fresh (never an adopted pre-existing dir).
#[tauri::command]
pub fn add_account_cancel(session_id: String, state: State<AppState>) -> Result<(), String> {
    let session = state.account_wizard_sessions.lock().unwrap().remove(&session_id);
    if let Some(session) = session {
        if session.created_new_dir {
            profile::delete_profile_dir(&session.config_dir).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Step 3: persist the account. Requires a `Ready` identity from
/// `add_account_check_login`; the web cookie (if captured) is persisted
/// alongside, keyed by the new account id. Also runs the best-effort
/// legacy-history migration (milestone 08): if a legacy `session.txt` is
/// still live and its org list contains this account's `org_uuid`, its usage
/// history + capacity re-key to it and the legacy cookie retires. Async
/// (unlike the other wizard steps) purely so that network call can run
/// in-line without blocking the caller on a spawned task; a migration
/// failure never fails account creation.
#[tauri::command]
pub async fn add_account_finalize(
    session_id: String,
    label: String,
    colour: String,
    icon: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<Account, String> {
    // Validate BEFORE removing the session from the map - a failed guard must
    // leave the wizard resumable, not orphan it.
    let session = {
        let mut sessions = state.account_wizard_sessions.lock().unwrap();
        let session = sessions
            .get(&session_id)
            .ok_or_else(|| "wizard session not found or already finished".to_string())?;
        if session.verified_identity.is_none() {
            return Err("complete the browser or CLI login before finalizing".to_string());
        }
        // Browser-first flow: an identity can exist without credentials
        // (fresh dir + cookie captured, CLI step never run). Such an account
        // could never spawn a chat - refuse to persist it.
        if crate::accounts::identity::read_token_expiry(&session.config_dir).is_none() {
            return Err(
                "this profile has no CLI credentials yet - complete the /login step before finalizing"
                    .to_string(),
            );
        }
        sessions.remove(&session_id).expect("session existed under the same lock")
    };
    let identity = session.verified_identity.expect("checked above");
    if identity.organization_type.is_none() {
        // Not fatal - the account still gets created - but a silently empty
        // tier is how ai_todo 173 (fibo showing "Unknown plan") went
        // unnoticed. Surface it in the log so a future org shape we don't
        // recognize is visible instead of silently swallowed.
        log::warn!(
            "add_account_finalize: no subscription tier resolved for org {} ({}) - \
             will show as \"Unknown plan\" until fixed and re-added",
            identity.organization_uuid,
            identity.email_address
        );
    }

    let account = Account {
        id: session.account_id,
        label,
        colour,
        icon,
        config_dir: session.config_dir,
        chrome_profile_dir: session.chrome_profile_dir,
        email: identity.email_address,
        org_uuid: identity.organization_uuid,
        subscription_tier: identity.organization_type.unwrap_or_default(),
        created_at: chrono::Utc::now().to_rfc3339(),
        // New accounts default out of the Jarvis fleet pool - Joe opts each
        // one in explicitly via the accounts settings toggle (todo 272).
        fleet_eligible: false,
    };

    if let Some(session_key) = session.session_key {
        let session_file = paths::account_session_file(&account.id).map_err(|e| e.to_string())?;
        crate::auth::session::save(&session_file, &session_key).map_err(|e| e.to_string())?;
    }

    let accounts_path = paths::accounts_file().map_err(|e| e.to_string())?;
    let mut accounts = accounts_store::load(&accounts_path);
    let was_first_account = accounts.is_empty();
    accounts.push(account.clone());
    accounts_store::save(&accounts_path, &accounts).map_err(|e| e.to_string())?;

    // The first account becomes the default. Nothing else ever sets
    // `default_account_id` (only the per-row "Set as default" menu item does),
    // and every spawn path that omits an explicit `account_id` - scheduled
    // `NewChat` items, channels, the news summarizer - refuses outright
    // without one. Leaving it unset would make a single-account install fail
    // those flows with an error about accounts it plainly has.
    if was_first_account {
        crate::ipc::accounts::set_default_account(Some(account.id.clone()), state.clone(), app.clone())
            .await?;
    }

    // Tray only re-renders on "settings-changed"/"usage-updated" - without
    // this, a freshly-added account is invisible in the tray tooltip/menu
    // until the next scheduled poll (up to 600s).
    {
        let snapshot = state.settings.lock().unwrap().clone();
        let _ = app.emit("settings-changed", &snapshot);
    }

    // Best-effort legacy -> this-account migration (milestone 08). The
    // network fetch (`legacy_org_uuids`) runs BEFORE the `state.db` lock is
    // taken below, so the sync `MutexGuard` never has to live across an
    // `.await` point.
    if paths::session_file().map(|p| p.exists()).unwrap_or(false) {
        let legacy_session = paths::session_file().map_err(|e| e.to_string())?;
        match crate::accounts::migration::legacy_org_uuids(&legacy_session).await {
            Ok(org_uuids) => {
                let conn_guard = state.db.lock().unwrap();
                match crate::accounts::migration::apply_migration_if_matching(
                    &account,
                    &org_uuids,
                    conn_guard.conn(),
                ) {
                    Ok(crate::accounts::migration::MigrationOutcome::Migrated { rows_rekeyed, .. }) => {
                        log::info!(
                            "migration: re-keyed {rows_rekeyed} legacy usage row(s) to account {}",
                            account.id
                        );
                    }
                    Ok(crate::accounts::migration::MigrationOutcome::NoMatch) => {}
                    Err(e) => log::warn!("migration: re-key failed for account {}: {e:#}", account.id),
                }
            }
            Err(e) => log::warn!("migration: could not read legacy org list: {e:#}"),
        }
    }

    Ok(account)
}

#[cfg(test)]
#[path = "wizard_tests.rs"]
mod tests;
