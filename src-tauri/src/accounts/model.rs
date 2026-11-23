//! The `Account` record. No CLI-token field: CLI credentials live inside
//! `config_dir`, minted and refreshed by Claude Code's own `/login`, and the
//! app only ever reads them. The web `sessionKey` cookie is stored out of
//! band, keyed by `id` (see `crate::auth::session` + `settings::paths`).

use serde::{Deserialize, Serialize};

/// How an account bills. `Subscription` is the Pro/Max OAuth login every
/// account had before this field existed, so it is the serde default: an old
/// `accounts.json` entry loads unchanged. `ApiCredit` runs a chat on an
/// `ANTHROPIC_API_KEY` that draws the Max plan's monthly API credit; it has no
/// OAuth login, so everything that reads `.credentials.json` skips it.
/// `Endpoint` runs the `claude` CLI against a third-party Anthropic-compatible
/// endpoint (Kimi Code, DeepSeek, OpenRouter, a custom URL) with that
/// provider's key; it has no OAuth login either, and its settings live in
/// [`Account::endpoint`].
#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq, ts_rs::TS)]
#[serde(rename_all = "snake_case")]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub enum AccountKind {
    #[default]
    Subscription,
    ApiCredit,
    Endpoint,
}

/// Which vendor an Endpoint account was set up from. Only a label for the UI
/// and for picking default URLs and models: every spawn reads `base_url`,
/// `auth_style` and `models`, never the preset.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq, ts_rs::TS)]
#[serde(rename_all = "snake_case")]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub enum EndpointPreset {
    KimiCode,
    Deepseek,
    Openrouter,
    #[default]
    Custom,
}

/// How the provider wants its key presented. `Bearer` sends
/// `Authorization: Bearer` (the CLI does that for `ANTHROPIC_AUTH_TOKEN`),
/// `XApiKey` sends `x-api-key` (`ANTHROPIC_API_KEY`).
#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq, ts_rs::TS)]
#[serde(rename_all = "snake_case")]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub enum EndpointAuth {
    #[default]
    Bearer,
    XApiKey,
}

/// What an Endpoint account points the CLI at. Every field is defaulted so a
/// trimmed entry cannot fail the whole registry's parse; an Endpoint account
/// whose `base_url` is blank refuses to spawn instead. The key is NOT here: it
/// lives in the DPAPI-wrapped `apikey-<id>.txt` next to the sessionKey files.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq, ts_rs::TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct EndpointConfig {
    #[serde(default)]
    pub preset: EndpointPreset,
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub auth_style: EndpointAuth,
    /// Model ids the provider serves, for the model picker. Each passes
    /// [`is_valid_endpoint_model`].
    #[serde(default)]
    pub models: Vec<String>,
}

/// Whether `id` is safe to hand to `claude --model` and to the model env vars
/// of an Endpoint account: 1 to 128 of `[A-Za-z0-9._:/~\[\]-]`. A leading `-`
/// is refused on top of that, so an id can never read as a CLI flag.
pub fn is_valid_endpoint_model(id: &str) -> bool {
    let len = id.chars().count();
    (1..=128).contains(&len)
        && !id.starts_with('-')
        && id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '/' | '~' | '[' | ']' | '-'))
}

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
    /// Billing kind. An `ApiCredit` account stores the linked Console
    /// account's email (empty when unknown) in `email` and the Console org's
    /// uuid (the membership with capability `api`) in `org_uuid`; both stay
    /// required strings for the reasons above.
    #[serde(default)]
    pub kind: AccountKind,
    /// Present on an `Endpoint` account only. `None` on every account written
    /// before this field existed.
    #[serde(default)]
    #[ts(optional)]
    pub endpoint: Option<EndpointConfig>,
}

impl Account {
    pub fn is_api_credit(&self) -> bool {
        self.kind == AccountKind::ApiCredit
    }

    pub fn is_endpoint(&self) -> bool {
        self.kind == AccountKind::Endpoint
    }
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
            kind: AccountKind::Subscription,
            endpoint: None,
        };
        let raw = serde_json::to_string(&a).unwrap();
        let back: Account = serde_json::from_str(&raw).unwrap();
        assert_eq!(a, back);
    }

    #[test]
    fn account_without_kind_loads_as_subscription() {
        // An accounts.json entry written before `kind` existed.
        let raw = r##"{"id":"id-1","label":"Personal","colour":"#fff","icon":"user",
            "config_dir":"C:/home/.claude-personal","chrome_profile_dir":"C:/x/id-1",
            "email":"a@example.com","org_uuid":"org-1","created_at":"2026-07-07T00:00:00Z"}"##;
        let a: Account = serde_json::from_str(raw).unwrap();
        assert_eq!(a.kind, AccountKind::Subscription);
        assert!(!a.is_api_credit());
        assert!(!a.is_endpoint());
        assert_eq!(a.endpoint, None);
    }

    #[test]
    fn endpoint_account_roundtrips_and_a_trimmed_config_still_loads() {
        let raw = r##"{"id":"e1","label":"Kimi","config_dir":"C:/h/.claude-kimi","chrome_profile_dir":"C:/x/e1",
            "email":"","org_uuid":"","created_at":"2026-11-23T00:00:00Z","kind":"endpoint",
            "endpoint":{"preset":"kimi_code","base_url":"https://api.kimi.ai/coding/","auth_style":"x_api_key","models":["k3.1-pro"]}}"##;
        let a: Account = serde_json::from_str(raw).unwrap();
        assert!(a.is_endpoint());
        let cfg = a.endpoint.clone().unwrap();
        assert_eq!((cfg.preset, cfg.auth_style), (EndpointPreset::KimiCode, EndpointAuth::XApiKey));
        assert_eq!(cfg.models, vec!["k3.1-pro".to_string()]);
        let back: Account = serde_json::from_str(&serde_json::to_string(&a).unwrap()).unwrap();
        assert_eq!(a, back);
        // A present-but-incomplete endpoint object must not drop the account.
        let trimmed = raw.replace(r#""preset":"kimi_code","base_url":"https://api.kimi.ai/coding/","auth_style":"x_api_key","models":["k3.1-pro"]"#, "");
        let t: Account = serde_json::from_str(&trimmed).unwrap();
        assert_eq!(t.endpoint, Some(EndpointConfig::default()));
    }

    #[test]
    fn endpoint_model_ids_follow_the_safe_charset() {
        let (max, over) = ("a".repeat(128), "a".repeat(129));
        for ok in ["deepseek-v4-pro", "k3.1-pro", "moonshotai/kimi-k2:free", "claude-opus-4-8[1m]", "x~y_z", max.as_str()] {
            assert!(is_valid_endpoint_model(ok), "{ok}");
        }
        for bad in ["", " ", "a b", "a;b", "a$(x)", "a\"b", "a`b", "--flag", "-x", "ключ", over.as_str()] {
            assert!(!is_valid_endpoint_model(bad), "{bad}");
        }
    }

    #[test]
    fn account_kind_serializes_snake_case() {
        assert_eq!(serde_json::to_string(&AccountKind::ApiCredit).unwrap(), "\"api_credit\"");
        assert_eq!(serde_json::to_string(&AccountKind::Subscription).unwrap(), "\"subscription\"");
        assert_eq!(serde_json::to_string(&AccountKind::Endpoint).unwrap(), "\"endpoint\"");
    }
}
