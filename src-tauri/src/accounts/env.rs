//! Per-account child-process environment: the `CLAUDE_CONFIG_DIR` override
//! plus the scrub list every `claude` spawn site must apply. See
//! `docs/multi-account/02-chat-routing.md` step 1.

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
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpawnEnv {
    pub set: Vec<(String, String)>,
    pub unset: Vec<String>,
}

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
