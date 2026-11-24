//! Per-account child-process environment: the `CLAUDE_CONFIG_DIR` override
//! plus the scrub list every `claude` spawn site must apply. See
//! `docs/multi-account/02-chat-routing.md` step 1.

use super::model::{EndpointAuth, EndpointConfig};
use std::collections::BTreeMap;
use std::path::Path;

/// Env vars that must never reach a spawned `claude` child, regardless of the
/// daemon's own ambient env. `CLAUDE_CODE_OAUTH_TOKEN` outranks
/// `.credentials.json` in claude's auth precedence, so a stray ambient token
/// would silently rebind the child to a different account than the one
/// `CLAUDE_CONFIG_DIR` points at - the old (dead) plan whitelisted this var;
/// this scrub list is what replaces it.
pub const SCRUBBED_ENV_VARS: &[&str] = &[
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
];

/// The env mutation a spawn site applies to its child: one override
/// (`CLAUDE_CONFIG_DIR`) plus the scrub list. Built once per spawn and
/// applied identically whether the spawn goes through `Command::env`
/// (tokio/std) or a raw Windows `CreateProcessW` env block.
#[derive(Clone, PartialEq, Eq)]
pub struct SpawnEnv {
    pub set: Vec<(String, String)>,
    pub unset: Vec<String>,
}

/// Hand-written so a `{:?}` of a spawn env (it lands in logs and assert
/// failures) never prints an injected API key or endpoint token.
impl std::fmt::Debug for SpawnEnv {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let set: Vec<(&str, &str)> = self
            .set
            .iter()
            .map(|(k, v)| (k.as_str(), if k == API_KEY_ENV || k == AUTH_TOKEN_ENV { "<redacted>" } else { v.as_str() }))
            .collect();
        f.debug_struct("SpawnEnv").field("set", &set).field("unset", &self.unset).finish()
    }
}

/// The one var an `ApiCredit` account's spawn injects instead of scrubbing.
pub const API_KEY_ENV: &str = "ANTHROPIC_API_KEY";
/// The bearer-token var an `Endpoint` account with `EndpointAuth::Bearer` injects.
pub const AUTH_TOKEN_ENV: &str = "ANTHROPIC_AUTH_TOKEN";
/// Where the CLI sends its requests; set for an `Endpoint` account only.
pub const BASE_URL_ENV: &str = "ANTHROPIC_BASE_URL";
/// Every model alias the CLI resolves on its own, plus the subagent model: all
/// pinned to the chat's model id on an `Endpoint` account, so a helper the chat
/// starts inside itself (a subagent, a `haiku` side call) cannot reach for a
/// Claude model id the provider does not serve.
pub const ENDPOINT_MODEL_PIN_ENVS: [&str; 5] = [
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "ANTHROPIC_DEFAULT_FABLE_MODEL",
    "CLAUDE_CODE_SUBAGENT_MODEL",
];

/// The two vars that tell the CLI the real window of a model it does not know:
/// the window it assumes, and the one it auto-compacts against. Both are
/// documented in Anthropic's Claude Code env-var reference (checked 2026-11-24;
/// the first from a summarised fetch), and Kimi's own guide reportedly sets both.
pub const ENDPOINT_WINDOW_ENVS: [&str; 2] = ["CLAUDE_CODE_MAX_CONTEXT_TOKENS", "CLAUDE_CODE_AUTO_COMPACT_WINDOW"];

impl SpawnEnv {
    /// Builds the env mutation for spawning under `account_config_dir`.
    ///
    /// Also forces git non-interactive: a headless spawned agent can never
    /// dismiss a GUI credential prompt, so one popping up on Joe's desktop is
    /// always wrong here, not gated by a setting.
    pub fn for_account(account_config_dir: &Path) -> Self {
        Self {
            set: vec![
                (
                    "CLAUDE_CONFIG_DIR".to_string(),
                    account_config_dir.to_string_lossy().into_owned(),
                ),
                ("GIT_TERMINAL_PROMPT".to_string(), "0".to_string()),
                ("GCM_INTERACTIVE".to_string(), "never".to_string()),
            ],
            unset: SCRUBBED_ENV_VARS.iter().map(|s| s.to_string()).collect(),
        }
    }

    /// The env for a chat on an `ApiCredit` account: everything
    /// [`Self::for_account`] does, except `ANTHROPIC_API_KEY` is set to
    /// `api_key` rather than scrubbed. `ANTHROPIC_AUTH_TOKEN` and
    /// `CLAUDE_CODE_OAUTH_TOKEN` are still removed, so the key is the only
    /// credential the child can see.
    pub fn for_api_credit_account(account_config_dir: &Path, api_key: &str) -> Self {
        let mut env = Self::for_account(account_config_dir);
        env.unset.retain(|k| k != API_KEY_ENV);
        env.set.push((API_KEY_ENV.to_string(), api_key.to_string()));
        env
    }

    /// The env for a chat on an `Endpoint` account: everything
    /// [`Self::for_account`] does (OAuth token, API key and auth token all
    /// scrubbed first), then `ANTHROPIC_BASE_URL`, the key in the var the
    /// account's auth style names, and the model pins. Bearer sets
    /// `ANTHROPIC_AUTH_TOKEN` and holds `ANTHROPIC_API_KEY` at the empty string
    /// (the CLI then sends no `x-api-key`); x-api-key sets `ANTHROPIC_API_KEY`
    /// and leaves the token unset. No `User-Agent` var exists here: the CLI
    /// sends its own, and a provider's terms may forbid changing it.
    pub fn for_endpoint_account(account_config_dir: &Path, endpoint: &EndpointConfig, key: &str, model: &str) -> Self {
        let mut env = Self::for_account(account_config_dir);
        env.set.push((BASE_URL_ENV.to_string(), endpoint.base_url.clone()));
        match endpoint.auth_style {
            EndpointAuth::Bearer => {
                env.unset.retain(|k| k != AUTH_TOKEN_ENV && k != API_KEY_ENV);
                env.set.push((AUTH_TOKEN_ENV.to_string(), key.to_string()));
                env.set.push((API_KEY_ENV.to_string(), String::new()));
            }
            EndpointAuth::XApiKey => {
                env.unset.retain(|k| k != API_KEY_ENV);
                env.set.push((API_KEY_ENV.to_string(), key.to_string()));
            }
        }
        for var in ENDPOINT_MODEL_PIN_ENVS {
            env.set.push((var.to_string(), model.to_string()));
        }
        // The CLI assumes 200K for an id it does not know, which compacts a 262K
        // chat early and misreads its size. With no stated window, nothing is set.
        if let Some(window) = endpoint.context_window(model) {
            for var in ENDPOINT_WINDOW_ENVS {
                env.set.push((var.to_string(), window.to_string()));
            }
        }
        env
    }

    /// Applies `set`/`unset` to a `tokio::process::Command`.
    pub fn apply_tokio(&self, cmd: &mut tokio::process::Command) {
        for k in &self.unset {
            cmd.env_remove(k);
        }
        for (k, v) in &self.set {
            cmd.env(k, v);
        }
    }

    /// Applies `set`/`unset` to a `std::process::Command`.
    pub fn apply_std(&self, cmd: &mut std::process::Command) {
        for k in &self.unset {
            cmd.env_remove(k);
        }
        for (k, v) in &self.set {
            cmd.env(k, v);
        }
    }

    /// The full effective child env: `ambient` (injected so tests never read
    /// the real process env) with `unset` keys removed and `set` keys
    /// applied on top. Used both for the billing gate (which must evaluate
    /// what the child will actually see, not the daemon's ambient env alone)
    /// and to build the Windows env block.
    pub fn effective_env(
        &self,
        ambient: impl IntoIterator<Item = (String, String)>,
    ) -> BTreeMap<String, String> {
        let mut map: BTreeMap<String, String> = ambient.into_iter().collect();
        for k in &self.unset {
            map.remove(k);
        }
        for (k, v) in &self.set {
            map.insert(k.clone(), v.clone());
        }
        map
    }
}

/// Builds a Windows `CreateProcessW` `lpEnvironment` block from a
/// `key=value` map: UTF-16 `KEY=VALUE\0` per entry, sorted case-insensitively
/// (the documented Win32 convention some CRTs rely on to binary-search the
/// block), double-null-terminated. Caller must also pass
/// `CREATE_UNICODE_ENVIRONMENT` in `dwCreationFlags` - without it Windows
/// reads this block as ANSI.
pub fn windows_env_block(vars: &BTreeMap<String, String>) -> Vec<u16> {
    let mut entries: Vec<(&String, &String)> = vars.iter().collect();
    entries.sort_by(|a, b| a.0.to_uppercase().cmp(&b.0.to_uppercase()));
    let mut block: Vec<u16> = Vec::new();
    for (k, v) in &entries {
        block.extend(format!("{k}={v}").encode_utf16());
        block.push(0);
    }
    // Each entry above already ends in one null; the block itself needs a
    // second, terminating null right after. An empty map has no per-entry
    // null yet, so it needs both.
    if entries.is_empty() {
        block.push(0);
    }
    block.push(0);
    block
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn for_account_sets_config_dir_and_lists_scrub_vars() {
        let env = SpawnEnv::for_account(&PathBuf::from("C:/home/.claude-work"));
        assert_eq!(env.set, vec![
            ("CLAUDE_CONFIG_DIR".to_string(), "C:/home/.claude-work".to_string()),
            ("GIT_TERMINAL_PROMPT".to_string(), "0".to_string()),
            ("GCM_INTERACTIVE".to_string(), "never".to_string()),
        ]);
        assert_eq!(env.unset, vec![
            "ANTHROPIC_API_KEY".to_string(),
            "ANTHROPIC_AUTH_TOKEN".to_string(),
            "CLAUDE_CODE_OAUTH_TOKEN".to_string(),
        ]);
    }

    #[test]
    fn for_account_sets_git_noninteractive_vars() {
        let env = SpawnEnv::for_account(&PathBuf::from("C:/home/.claude-work"));
        assert!(env.set.contains(&("GIT_TERMINAL_PROMPT".to_string(), "0".to_string())));
        assert!(env.set.contains(&("GCM_INTERACTIVE".to_string(), "never".to_string())));
    }

    #[test]
    fn effective_env_scrubs_tokens_and_applies_override() {
        let env = SpawnEnv::for_account(&PathBuf::from("/home/.claude-work"));
        let ambient = vec![
            ("CLAUDE_CODE_OAUTH_TOKEN".to_string(), "stray-token".to_string()),
            ("ANTHROPIC_API_KEY".to_string(), "sk-stray".to_string()),
            ("PATH".to_string(), "/usr/bin".to_string()),
        ];
        let eff = env.effective_env(ambient);
        assert_eq!(eff.get("CLAUDE_CONFIG_DIR").map(String::as_str), Some("/home/.claude-work"));
        assert!(!eff.contains_key("CLAUDE_CODE_OAUTH_TOKEN"));
        assert!(!eff.contains_key("ANTHROPIC_API_KEY"));
        assert_eq!(eff.get("PATH").map(String::as_str), Some("/usr/bin"));
    }

    #[test]
    fn effective_env_override_wins_if_ambient_already_had_config_dir() {
        let env = SpawnEnv::for_account(&PathBuf::from("/home/.claude-work"));
        let ambient = vec![("CLAUDE_CONFIG_DIR".to_string(), "/home/.claude-stale".to_string())];
        let eff = env.effective_env(ambient);
        assert_eq!(eff.get("CLAUDE_CONFIG_DIR").map(String::as_str), Some("/home/.claude-work"));
    }

    #[test]
    fn for_account_never_injects_an_api_key() {
        // The Subscription env stays the scrub list plus the config dir: the
        // ApiCredit variant must not leak into it.
        let env = SpawnEnv::for_account(&PathBuf::from("C:/home/.claude-work"));
        assert!(!env.set.iter().any(|(k, _)| k == API_KEY_ENV));
        assert!(env.unset.iter().any(|k| k == API_KEY_ENV));
    }

    #[test]
    fn api_credit_env_injects_the_key_and_still_scrubs_the_other_tokens() {
        let env = SpawnEnv::for_api_credit_account(&PathBuf::from("C:/home/.claude-api"), "sk-ant-real");
        assert!(env.set.contains(&("ANTHROPIC_API_KEY".to_string(), "sk-ant-real".to_string())));
        assert!(env.set.contains(&("CLAUDE_CONFIG_DIR".to_string(), "C:/home/.claude-api".to_string())));
        assert!(!env.unset.contains(&"ANTHROPIC_API_KEY".to_string()));
        assert!(env.unset.contains(&"ANTHROPIC_AUTH_TOKEN".to_string()));
        assert!(env.unset.contains(&"CLAUDE_CODE_OAUTH_TOKEN".to_string()));

        let ambient = vec![
            ("ANTHROPIC_API_KEY".to_string(), "sk-stray".to_string()),
            ("ANTHROPIC_AUTH_TOKEN".to_string(), "proxy".to_string()),
            ("CLAUDE_CODE_OAUTH_TOKEN".to_string(), "oat".to_string()),
        ];
        let eff = env.effective_env(ambient);
        assert_eq!(
            eff.get("ANTHROPIC_API_KEY").map(String::as_str),
            Some("sk-ant-real"),
            "the account's key beats an ambient one"
        );
        assert!(!eff.contains_key("ANTHROPIC_AUTH_TOKEN"));
        assert!(!eff.contains_key("CLAUDE_CODE_OAUTH_TOKEN"));
    }

    fn endpoint(auth: EndpointAuth) -> EndpointConfig {
        EndpointConfig { base_url: "https://api.example.test/anthropic".into(), auth_style: auth, ..Default::default() }
    }

    fn ambient_oauth_and_keys() -> Vec<(String, String)> {
        vec![
            ("ANTHROPIC_API_KEY".to_string(), "sk-stray".to_string()),
            ("ANTHROPIC_AUTH_TOKEN".to_string(), "proxy-stray".to_string()),
            ("CLAUDE_CODE_OAUTH_TOKEN".to_string(), "oat-stray".to_string()),
        ]
    }

    #[test]
    fn endpoint_bearer_env_sets_the_token_blanks_the_api_key_and_scrubs_oauth() {
        let env = SpawnEnv::for_endpoint_account(&PathBuf::from("C:/h/.claude-kimi"), &endpoint(EndpointAuth::Bearer), "tok-1", "deepseek-v4-pro");
        let eff = env.effective_env(ambient_oauth_and_keys());
        assert_eq!(eff.get("ANTHROPIC_BASE_URL").map(String::as_str), Some("https://api.example.test/anthropic"));
        assert_eq!(eff.get("ANTHROPIC_AUTH_TOKEN").map(String::as_str), Some("tok-1"));
        assert_eq!(eff.get("ANTHROPIC_API_KEY").map(String::as_str), Some(""), "an empty key, so the CLI sends no x-api-key");
        assert!(!eff.contains_key("CLAUDE_CODE_OAUTH_TOKEN"));
        assert_eq!(eff.get("CLAUDE_CONFIG_DIR").map(String::as_str), Some("C:/h/.claude-kimi"));
    }

    #[test]
    fn endpoint_x_api_key_env_sets_the_key_and_leaves_the_token_unset() {
        let env = SpawnEnv::for_endpoint_account(&PathBuf::from("C:/h/.claude-ds"), &endpoint(EndpointAuth::XApiKey), "key-1", "deepseek-v4-pro");
        let eff = env.effective_env(ambient_oauth_and_keys());
        assert_eq!(eff.get("ANTHROPIC_API_KEY").map(String::as_str), Some("key-1"));
        assert!(!eff.contains_key("ANTHROPIC_AUTH_TOKEN"), "a stray ambient token must not outrank the key");
        assert!(!eff.contains_key("CLAUDE_CODE_OAUTH_TOKEN"));
    }

    #[test]
    fn endpoint_env_pins_every_model_alias_and_the_subagent_model_to_the_chats_model() {
        for auth in [EndpointAuth::Bearer, EndpointAuth::XApiKey] {
            let env = SpawnEnv::for_endpoint_account(&PathBuf::from("C:/h/.claude-x"), &endpoint(auth), "k", "k3.1-pro[1m]");
            for var in [
                "ANTHROPIC_DEFAULT_OPUS_MODEL",
                "ANTHROPIC_DEFAULT_SONNET_MODEL",
                "ANTHROPIC_DEFAULT_HAIKU_MODEL",
                "ANTHROPIC_DEFAULT_FABLE_MODEL",
                "CLAUDE_CODE_SUBAGENT_MODEL",
            ] {
                assert!(env.set.contains(&(var.to_string(), "k3.1-pro[1m]".to_string())), "{var}");
            }
        }
    }

    fn kimi() -> EndpointConfig {
        EndpointConfig { preset: super::super::model::EndpointPreset::KimiCode, ..endpoint(EndpointAuth::Bearer) }
    }

    #[test]
    fn a_kimi_chat_tells_the_cli_its_real_window() {
        let eff = SpawnEnv::for_endpoint_account(&PathBuf::from("C:/h/.claude-k"), &kimi(), "k", "k3.1-pro")
            .effective_env(Vec::new());
        for var in ENDPOINT_WINDOW_ENVS {
            assert_eq!(eff.get(var).map(String::as_str), Some("262144"), "{var}");
        }
        // A `[1m]` id has no verified window: the CLI is told nothing rather than a guess.
        let env = SpawnEnv::for_endpoint_account(&PathBuf::from("C:/h/.claude-k"), &kimi(), "k", "k3.1-pro[1m]");
        assert!(!env.set.iter().any(|(k, _)| ENDPOINT_WINDOW_ENVS.contains(&k.as_str())));
    }

    #[test]
    fn an_endpoint_with_no_stated_window_sets_no_window_vars() {
        let env = SpawnEnv::for_endpoint_account(&PathBuf::from("C:/h/.claude-x"), &endpoint(EndpointAuth::Bearer), "k", "m");
        assert!(!env.set.iter().any(|(k, _)| ENDPOINT_WINDOW_ENVS.contains(&k.as_str())));
    }

    #[test]
    fn endpoint_env_never_sets_or_unsets_a_user_agent() {
        let env = SpawnEnv::for_endpoint_account(&PathBuf::from("C:/h/.claude-x"), &endpoint(EndpointAuth::Bearer), "k", "m");
        let touches_ua = |k: &String| k.to_ascii_uppercase().contains("USER_AGENT") || k.to_ascii_uppercase().contains("USERAGENT");
        assert!(!env.set.iter().map(|(k, _)| k).any(touches_ua));
        assert!(!env.unset.iter().any(touches_ua));
    }

    #[test]
    fn the_other_account_envs_carry_no_endpoint_vars() {
        for env in [SpawnEnv::for_account(&PathBuf::from("C:/h/.claude-a")), SpawnEnv::for_api_credit_account(&PathBuf::from("C:/h/.claude-b"), "sk-ant-x")] {
            assert!(!env.set.iter().any(|(k, _)| k == "ANTHROPIC_BASE_URL" || k.starts_with("ANTHROPIC_DEFAULT_") || k == "CLAUDE_CODE_SUBAGENT_MODEL"));
        }
    }

    #[test]
    fn debug_output_redacts_the_endpoint_token() {
        let env = SpawnEnv::for_endpoint_account(&PathBuf::from("C:/h/.claude-x"), &endpoint(EndpointAuth::Bearer), "tok-secret", "m");
        assert!(!format!("{env:?}").contains("tok-secret"));
        let env = SpawnEnv::for_endpoint_account(&PathBuf::from("C:/h/.claude-x"), &endpoint(EndpointAuth::XApiKey), "key-secret", "m");
        assert!(!format!("{env:?}").contains("key-secret"));
    }

    #[test]
    fn debug_output_redacts_the_api_key() {
        let env = SpawnEnv::for_api_credit_account(&PathBuf::from("C:/home/.claude-api"), "sk-ant-secret");
        assert!(!format!("{env:?}").contains("sk-ant-secret"));
    }

    #[test]
    fn windows_env_block_is_sorted_utf16_double_null_terminated() {
        let mut vars = BTreeMap::new();
        vars.insert("path".to_string(), "C:/bin".to_string());
        vars.insert("CLAUDE_CONFIG_DIR".to_string(), "C:/home/.claude-work".to_string());
        let block = windows_env_block(&vars);

        // Split on single-null terminators to recover each "KEY=VALUE" entry.
        let mut entries: Vec<String> = Vec::new();
        let mut cur: Vec<u16> = Vec::new();
        for &u in &block {
            if u == 0 {
                if cur.is_empty() {
                    break; // second consecutive null = end of block
                }
                entries.push(String::from_utf16(&cur).unwrap());
                cur.clear();
            } else {
                cur.push(u);
            }
        }
        // Sorted case-insensitively: CLAUDE_CONFIG_DIR before path.
        assert_eq!(entries, vec![
            "CLAUDE_CONFIG_DIR=C:/home/.claude-work".to_string(),
            "path=C:/bin".to_string(),
        ]);
        // Double-null terminated: last two u16 are both 0.
        assert_eq!(&block[block.len() - 2..], &[0, 0]);
    }

    #[test]
    fn windows_env_block_empty_map_is_just_double_null() {
        let block = windows_env_block(&BTreeMap::new());
        assert_eq!(block, vec![0, 0]);
    }
}
