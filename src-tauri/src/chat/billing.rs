//! Metered-billing guard. The chat hub consumes the user's Pro/Max
//! subscription quota (same pool as interactive `claude`); it refuses to run
//! under any env that would route billing to the metered Anthropic API.

#[derive(thiserror::Error, Debug)]
pub enum BillingError {
    #[error("metered billing detected: {0} is set. Running claude under the daemon would bill the metered Anthropic API instead of the Pro/Max subscription. Refusing to spawn. Unset {0} to use the subscription path, or run a non-`-p` interactive `claude` session in a terminal.")]
    Metered(String),
}

/// Env vars whose presence routes claude to metered billing instead of the
/// Pro/Max subscription. Per https://code.claude.com/docs/en/authentication
/// the auth precedence is: ANTHROPIC_API_KEY > apiKeyHelper > CLAUDE_CODE_OAUTH_TOKEN
/// > Bedrock/Vertex envs > /login OAuth. Of those, only ANTHROPIC_API_KEY,
/// Bedrock, and Vertex are guaranteed metered. ANTHROPIC_AUTH_TOKEN is for
/// custom-auth proxies and may route either way; we err on the side of refusing.
/// CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`) is subscription-billed
/// and explicitly NOT in this list.
const METERED_ENV_VARS: &[&str] = &[
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
];

/// Refuse to proceed if any env var that would route billing to the metered
/// API is set. The chat hub is designed to consume the user's existing Pro/Max
/// subscription quota (same pool as interactive `claude` sessions); we do not
/// support metered-billing operation. `env_get` is parameterised for testability.
pub fn check_metered_billing(env_get: &dyn Fn(&str) -> Option<String>) -> Result<(), BillingError> {
    check_excluding(env_get, &[])
}

/// The guard for a chat on an `ApiCredit` account, the one place an
/// `ANTHROPIC_API_KEY` is deliberate: that key draws the Max plan's API credit.
/// Allows exactly that var; `ANTHROPIC_AUTH_TOKEN`, Bedrock and Vertex still
/// refuse, since each would bill something other than the account's own key.
/// Chat spawns only: every other caller keeps [`check_metered_billing`].
pub fn check_metered_billing_api_credit(
    env_get: &dyn Fn(&str) -> Option<String>,
) -> Result<(), BillingError> {
    check_excluding(env_get, &["ANTHROPIC_API_KEY"])
}

fn check_excluding(
    env_get: &dyn Fn(&str) -> Option<String>,
    allowed: &[&str],
) -> Result<(), BillingError> {
    for key in METERED_ENV_VARS.iter().filter(|k| !allowed.contains(k)) {
        if env_get(key).map(|v| !v.is_empty()).unwrap_or(false) {
            return Err(BillingError::Metered((*key).to_string()));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn metered_billing_detected_when_anthropic_api_key_set() {
        let env = |k: &str| if k == "ANTHROPIC_API_KEY" { Some("sk-test-123".into()) } else { None };
        let r = check_metered_billing(&env);
        assert!(matches!(r, Err(BillingError::Metered(ref k)) if k == "ANTHROPIC_API_KEY"));
    }

    #[test]
    fn metered_billing_detected_for_bedrock_and_vertex() {
        for key in ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "ANTHROPIC_AUTH_TOKEN"] {
            let env = |k: &str| if k == key { Some("1".into()) } else { None };
            let r = check_metered_billing(&env);
            assert!(matches!(r, Err(BillingError::Metered(ref k)) if k == key), "key {key} not detected");
        }
    }

    #[test]
    fn metered_billing_not_detected_when_no_keys_set() {
        let env = |_: &str| None;
        assert!(check_metered_billing(&env).is_ok());
    }

    #[test]
    fn metered_billing_ignores_empty_string() {
        let env = |k: &str| if k == "ANTHROPIC_API_KEY" { Some(String::new()) } else { None };
        assert!(check_metered_billing(&env).is_ok());
    }

    #[test]
    fn metered_billing_does_not_flag_oauth_token() {
        // CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`) is subscription-billed
        // per the auth docs; must not trigger the guard.
        let env = |k: &str| if k == "CLAUDE_CODE_OAUTH_TOKEN" { Some("oat-test".into()) } else { None };
        assert!(check_metered_billing(&env).is_ok());
    }

    // Multi-account routing (docs/multi-account/02-chat-routing.md step 3):
    // every real spawn evaluates this gate against `accounts::env::SpawnEnv`'s
    // effective env, which already scrubs ANTHROPIC_API_KEY/AUTH_TOKEN/
    // OAUTH_TOKEN. These lock the resulting contract: the gate can only still
    // catch what SURVIVES the scrub (BEDROCK/VERTEX).

    #[test]
    fn metered_billing_passes_when_only_scrubbed_vars_are_set_in_ambient() {
        let spawn_env = crate::accounts::env::SpawnEnv::for_account(std::path::Path::new("/home/.claude-work"));
        let ambient = vec![
            ("ANTHROPIC_API_KEY".to_string(), "sk-stray".to_string()),
            ("ANTHROPIC_AUTH_TOKEN".to_string(), "proxy-token".to_string()),
        ];
        let effective = spawn_env.effective_env(ambient);
        assert!(check_metered_billing(&|k| effective.get(k).cloned()).is_ok());
    }

    // ApiCredit chats: ANTHROPIC_API_KEY is the account's own credential.

    #[test]
    fn api_credit_guard_allows_the_api_key() {
        let env = |k: &str| if k == "ANTHROPIC_API_KEY" { Some("sk-ant-x".into()) } else { None };
        assert!(check_metered_billing_api_credit(&env).is_ok());
    }

    #[test]
    fn api_credit_guard_still_refuses_auth_token_bedrock_and_vertex() {
        for key in ["ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX"] {
            // Even alongside the allowed key.
            let env = |k: &str| if k == key || k == "ANTHROPIC_API_KEY" { Some("1".into()) } else { None };
            let r = check_metered_billing_api_credit(&env);
            assert!(matches!(r, Err(BillingError::Metered(ref k)) if k == key), "key {key} not refused");
        }
    }

    #[test]
    fn api_credit_spawn_env_passes_the_api_credit_guard_but_not_the_strict_one() {
        let spawn_env = crate::accounts::env::SpawnEnv::for_api_credit_account(
            std::path::Path::new("/home/.claude-api"),
            "sk-ant-real",
        );
        let effective = spawn_env.effective_env(Vec::<(String, String)>::new());
        assert!(check_metered_billing_api_credit(&|k| effective.get(k).cloned()).is_ok());
        let strict = check_metered_billing(&|k| effective.get(k).cloned());
        assert!(matches!(strict, Err(BillingError::Metered(ref k)) if k == "ANTHROPIC_API_KEY"));
    }

    #[test]
    fn api_credit_spawn_env_does_not_scrub_bedrock_or_vertex() {
        let spawn_env = crate::accounts::env::SpawnEnv::for_api_credit_account(
            std::path::Path::new("/home/.claude-api"),
            "sk-ant-real",
        );
        let ambient = vec![
            ("ANTHROPIC_AUTH_TOKEN".to_string(), "proxy".to_string()),
            ("CLAUDE_CODE_USE_VERTEX".to_string(), "1".to_string()),
        ];
        let effective = spawn_env.effective_env(ambient);
        // The auth token is scrubbed, Vertex survives and refuses.
        let r = check_metered_billing_api_credit(&|k| effective.get(k).cloned());
        assert!(matches!(r, Err(BillingError::Metered(ref k)) if k == "CLAUDE_CODE_USE_VERTEX"));
    }

    #[test]
    fn metered_billing_still_catches_bedrock_surviving_the_scrub() {
        let spawn_env = crate::accounts::env::SpawnEnv::for_account(std::path::Path::new("/home/.claude-work"));
        let ambient = vec![
            ("ANTHROPIC_API_KEY".to_string(), "sk-stray".to_string()),
            ("CLAUDE_CODE_USE_BEDROCK".to_string(), "1".to_string()),
        ];
        let effective = spawn_env.effective_env(ambient);
        let r = check_metered_billing(&|k| effective.get(k).cloned());
        assert!(matches!(r, Err(BillingError::Metered(ref k)) if k == "CLAUDE_CODE_USE_BEDROCK"));
    }
}
