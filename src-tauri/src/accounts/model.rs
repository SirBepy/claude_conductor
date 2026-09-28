//! The `Account` record. No CLI-token field: CLI credentials live inside
//! `config_dir`, minted and refreshed by Claude Code's own `/login`, and the
//! app only ever reads them. The web `sessionKey` cookie is stored out of
//! band, keyed by `id` (see `crate::auth::session` + `settings::paths`).

use serde::{Deserialize, Serialize};

/// `id`, `config_dir`, `chrome_profile_dir`, `email`, `org_uuid` and
/// `created_at` deliberately carry NO `#[serde(default)]`, mirroring
/// `ProjectConfig`'s own id/path/name/created_at: they are identity or
/// filesystem-path fields where a silently-defaulted empty value is actively
/// dangerous (an empty `config_dir`/`chrome_profile_dir` resolves relative to
/// cwd - wrong-account credential/profile access - and an empty
/// `email`/`org_uuid` would falsely "match" every other broken entry in
/// `find_duplicate`'s comparisons). A JSON object missing one of these is
/// genuine corruption; `accounts::store::load`'s per-entry lenient parse
/// (mirroring `deserialize_lenient_projects`) drops just that one account
/// instead of failing the whole registry. The cosmetic/informational fields
/// below use `#[serde(default)]` because a blank fallback for them is
/// harmless.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, ts_rs::TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct Account {
    pub id: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub colour: String,
    #[serde(default)]
    pub icon: String,
    pub config_dir: std::path::PathBuf,
    pub chrome_profile_dir: std::path::PathBuf,
    pub email: String,
    pub org_uuid: String,
    /// Raw `organizationType` from `oauthAccount` (e.g. whatever Claude Code's
    /// `.claude.json` calls the Pro/Max/Team tier). Passed through verbatim;
    /// human-friendly labeling is a frontend concern.
    #[serde(default)]
    pub subscription_tier: String,
    pub created_at: String,
    /// Opt-in for Jarvis fleet worker spawns (todo 272, "Fleet account
    /// allocation"): only accounts with this set to `true` are eligible to be
    /// auto-picked by `pick_worker_account`, or named explicitly in a
    /// `spawn_worker` call. `#[serde(default)]` so every pre-existing
    /// `accounts.json` on disk (written before this field existed) loads as
    /// `false` - work accounts are never silently drafted into a fleet.
    /// `Settings.default_account_id` is always eligible regardless of this
    /// flag (see `accounts::eligible_pool`), so the pool is never empty and
    /// v1's spawn-under-default behavior is preserved when nothing is opted
    /// in.
    #[serde(default)]
    pub fleet_eligible: bool,
}

/// Turns a free-typed label into a filesystem- and slug-safe identifier used
/// for the profile dir name (`~/.claude-<slug>`) and default chrome-profile
/// naming. Lowercases, keeps `[a-z0-9-]`, collapses everything else to `-`,
/// trims leading/trailing dashes, and falls back to `"account"` if that
/// leaves nothing usable.
pub fn slugify(label: &str) -> String {
    let mut out = String::with_capacity(label.len());
    let mut last_was_dash = false;
    for ch in label.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
            last_was_dash = false;
        } else if !last_was_dash && !out.is_empty() {
            out.push('-');
            last_was_dash = true;
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    if out.is_empty() {
        "account".to_string()
    } else {
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugify_lowercases_and_collapses_separators() {
        assert_eq!(slugify("Personal"), "personal");
        assert_eq!(slugify("Work (Fibo)"), "work-fibo");
        assert_eq!(slugify("  spaced   out  "), "spaced-out");
    }

    #[test]
    fn slugify_falls_back_when_nothing_usable() {
        assert_eq!(slugify("!!!"), "account");
        assert_eq!(slugify(""), "account");
    }

    #[test]
    fn account_roundtrips_json() {
        let a = Account {
            id: "id-1".into(),
            label: "Personal".into(),
            colour: "#ff0000".into(),
            icon: "user".into(),
            config_dir: std::path::PathBuf::from("C:/home/.claude-personal"),
            chrome_profile_dir: std::path::PathBuf::from("C:/appdata/chrome-profiles/id-1"),
            email: "a@example.com".into(),
            org_uuid: "org-1".into(),
            subscription_tier: "claude_max".into(),
            created_at: "2026-07-07T00:00:00Z".into(),
            fleet_eligible: false,
        };
        let raw = serde_json::to_string(&a).unwrap();
        let back: Account = serde_json::from_str(&raw).unwrap();
        assert_eq!(a, back);
    }
}
