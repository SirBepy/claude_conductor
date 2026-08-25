//! Account/config-dir resolution shared by both model commands. Split out of
//! `mod.rs` (ai_todo 761).

use std::path::PathBuf;

/// Config dir to probe: `account_id`'s, else the default account's. None
/// means fail open. `~/.claude` is the fallback for an EMPTY registry only -
/// it belongs to no registered account, so probing it when one IS registered
/// let an expired terminal login disable every account at once (todo 758).
pub(super) fn config_dir_for_account(account_id: Option<&str>) -> Option<PathBuf> {
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
