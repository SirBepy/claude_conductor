//! Subchats: a chat with "Use subchats" on hands jobs Joe names to hidden child
//! chats (subs). This module is where that feature's daemon logic lives; add
//! submodules here rather than spreading it through the lifecycle and hook files.
//!
//! A sub is an ordinary registry row with `Instance::subchat_of` set. It is NOT
//! a Jarvis worker (`worker_of`): that field wakes its parent on every state
//! change, which is exactly what a sub must never do.

use crate::accounts::Account;
use crate::daemon::claude_config::{append_system_prompt, SUBCHAT_SUB_PROMPT};
use crate::daemon::rpc::RpcError;
use crate::daemon::state::DaemonState;
use crate::types::Instance;

/// Whether `inst` is a hidden sub of some main chat.
pub fn is_sub(inst: &Instance) -> bool {
    inst.subchat_of.is_some()
}

/// Why the mode refuses an `ApiCredit` account. Subs inherit the parent's
/// account, and that account kind is never a default or fleet member because
/// its spawns bill the Max plan's monthly API credit. The frontend repeats this
/// wording (`subchats-gate.ts`), so change both together.
pub const API_CREDIT_REFUSAL: &str =
    "Subchats are not available on an API-credit account, since every sub would spend its credit. Switch this chat to a subscription account first.";

/// Model family and effort a main chat runs on (Joe: it does little work, but
/// "you REALLY dont want it to be stupid").
const MAIN_MODEL: &str = "opus";
const MAIN_EFFORT: &str = "high";

/// The model/effort pair a main chat should run with, given what it has now.
/// Only a model that is not Opus is replaced, and only an effort below high is
/// raised: a deliberate `xhigh`/`max` pick is already at least what the mode
/// asks for, so lowering it would undo a choice Joe made.
pub fn main_launch(model: &str, effort: &str) -> (String, String) {
    let model = if model.to_ascii_lowercase().contains("opus") { model } else { MAIN_MODEL };
    let effort = if matches!(effort, "high" | "xhigh" | "max") { effort } else { MAIN_EFFORT };
    (model.to_string(), effort.to_string())
}

/// `Some(reason)` when `account_id` names an `ApiCredit` account in `accounts`.
/// An unknown or missing account passes, as everywhere else: unknown never blocks.
pub fn refusal_for_account(account_id: Option<&str>, accounts: &[Account]) -> Option<&'static str> {
    let id = account_id?;
    accounts
        .iter()
        .any(|a| a.id == id && a.is_api_credit())
        .then_some(API_CREDIT_REFUSAL)
}

/// The account `session_id` runs under: the live child's, else the registry's.
fn session_account_id(state: &DaemonState, session_id: &str) -> Option<String> {
    state
        .sessions
        .get(session_id)
        .map(|s| s.account_id.clone())
        .or_else(|| state.registry.get(session_id).and_then(|i| i.account_id))
}

/// The `set_subchats_on` decision, with the account list and the persistence
/// write injected so a test touches neither the real accounts file nor the real
/// `chat-config.json`.
///
/// Turning the mode ON refuses an API-credit chat; turning it OFF always works.
/// ON also moves the chat's recorded model/effort to [`main_launch`]. That goes
/// through the registry only: a live child keeps the pair it was launched with
/// until `lifecycle::refresh_stale_launch` respawns it just before Joe's next
/// send, which is the same path a manual model pick takes. A turn in flight is
/// never killed by the toggle. Returns the pair when it changed, so the caller
/// can record it in chat-config too.
pub fn apply_set_on(
    state: &DaemonState,
    session_id: &str,
    value: bool,
    accounts: &[Account],
    persist: impl FnOnce(&str, bool),
) -> Result<Option<(String, String)>, RpcError> {
    if value {
        if let Some(reason) = refusal_for_account(session_account_id(state, session_id).as_deref(), accounts) {
            return Err(RpcError::invalid_params(reason));
        }
    }
    persist(session_id, value);
    if !value {
        return Ok(None);
    }
    let Some(inst) = state.registry.get(session_id) else { return Ok(None) };
    let (model, effort) = main_launch(&inst.model, &inst.effort);
    if model == inst.model && effort == inst.effort {
        return Ok(None);
    }
    state.registry.set_model_effort(session_id, &model, &effort);
    Ok(Some((model, effort)))
}

/// The prompt a sub is spawned with: the shared rules plus which main chat it
/// belongs to, so its questions and `finish_subchat` read in context.
pub fn sub_prompt(parent_label: &str) -> String {
    format!("{SUBCHAT_SUB_PROMPT} Your main chat is \"{parent_label}\".")
}

/// Adds [`sub_prompt`] to a spawn's `--append-system-prompt`; the sub spawn
/// path is its intended caller.
pub fn append_sub_prompt(args: &mut [String], parent_label: &str) {
    append_system_prompt(args, &sub_prompt(parent_label));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts::AccountKind;
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::types::Settings;
    use std::cell::RefCell;

    fn account(id: &str, kind: AccountKind) -> Account {
        Account {
            id: id.into(),
            label: id.into(),
            colour: "#fff".into(),
            icon: "key".into(),
            config_dir: std::path::PathBuf::from("C:/home/.claude-x"),
            chrome_profile_dir: std::path::PathBuf::from("C:/appdata/chrome-profiles/x"),
            email: String::new(),
            org_uuid: "ORG".into(),
            subscription_tier: String::new(),
            created_at: "2026-11-04T00:00:00Z".into(),
            fleet_eligible: false,
            kind,
        }
    }

    fn state() -> std::sync::Arc<DaemonState> {
        DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()))
    }

    fn chat(state: &DaemonState, id: &str, account: Option<&str>, model: &str, effort: &str) {
        state.registry.upsert_interactive(id, std::path::Path::new("."), "proj", "2026-11-04T00:00:00Z");
        if let Some(a) = account {
            state.registry.set_account(id, a);
        }
        state.registry.set_model_effort(id, model, effort);
    }

    #[test]
    fn an_api_credit_chat_cannot_turn_the_mode_on_and_nothing_is_written() {
        let st = state();
        chat(&st, "s1", Some("api-1"), "sonnet", "low");
        let accounts = [account("api-1", AccountKind::ApiCredit), account("sub-1", AccountKind::Subscription)];
        let wrote = RefCell::new(Vec::new());
        let err = apply_set_on(&st, "s1", true, &accounts, |id, v| wrote.borrow_mut().push((id.to_string(), v)))
            .expect_err("refused");
        assert!(err.message.contains("API-credit"), "{}", err.message);
        assert!(wrote.borrow().is_empty(), "a refused toggle must not persist");
        let inst = st.registry.get("s1").unwrap();
        assert_eq!((inst.model.as_str(), inst.effort.as_str()), ("sonnet", "low"), "model untouched on refusal");
    }

    #[test]
    fn an_api_credit_chat_can_still_turn_the_mode_off() {
        let st = state();
        chat(&st, "s1", Some("api-1"), "opus", "high");
        let accounts = [account("api-1", AccountKind::ApiCredit)];
        let wrote = RefCell::new(Vec::new());
        apply_set_on(&st, "s1", false, &accounts, |id, v| wrote.borrow_mut().push((id.to_string(), v))).unwrap();
        assert_eq!(*wrote.borrow(), vec![("s1".to_string(), false)]);
    }

    #[test]
    fn a_subscription_chat_turns_on_persists_and_moves_to_opus_high() {
        let st = state();
        chat(&st, "s1", Some("sub-1"), "sonnet", "medium");
        let accounts = [account("sub-1", AccountKind::Subscription)];
        let wrote = RefCell::new(Vec::new());
        let applied = apply_set_on(&st, "s1", true, &accounts, |id, v| wrote.borrow_mut().push((id.to_string(), v)))
            .unwrap();
        assert_eq!(*wrote.borrow(), vec![("s1".to_string(), true)]);
        assert_eq!(applied, Some(("opus".to_string(), "high".to_string())));
        let inst = st.registry.get("s1").unwrap();
        assert_eq!((inst.model.as_str(), inst.effort.as_str()), ("opus", "high"));
    }

    #[test]
    fn turning_it_off_keeps_the_model_it_was_moved_to() {
        let st = state();
        chat(&st, "s1", None, "opus", "high");
        let applied = apply_set_on(&st, "s1", false, &[], |_, _| {}).unwrap();
        assert_eq!(applied, None);
        assert_eq!(st.registry.get("s1").unwrap().model, "opus", "no way to know the pre-mode model, so it stays");
    }

    #[test]
    fn main_launch_keeps_an_opus_model_and_a_high_or_better_effort() {
        assert_eq!(main_launch("claude-opus-4-8", "max"), ("claude-opus-4-8".to_string(), "max".to_string()));
        assert_eq!(main_launch("opus", "xhigh"), ("opus".to_string(), "xhigh".to_string()));
        assert_eq!(main_launch("sonnet", "low"), ("opus".to_string(), "high".to_string()));
        assert_eq!(main_launch("", ""), ("opus".to_string(), "high".to_string()), "an unrecorded pair becomes opus/high");
        assert_eq!(main_launch("opus", "medium"), ("opus".to_string(), "high".to_string()));
    }

    #[test]
    fn an_unknown_account_never_refuses() {
        assert_eq!(refusal_for_account(None, &[]), None);
        assert_eq!(refusal_for_account(Some("ghost"), &[account("a", AccountKind::ApiCredit)]), None);
    }

    #[test]
    fn is_sub_reads_the_parent_link_only() {
        let st = state();
        chat(&st, "main", None, "opus", "high");
        chat(&st, "sub", None, "sonnet", "high");
        st.registry.set_subchat_of("sub", Some("main".into()));
        chat(&st, "worker", None, "sonnet", "high");
        st.registry.set_worker_of("worker", Some("jarvis".into()));
        assert!(!is_sub(&st.registry.get("worker").unwrap()), "a Jarvis worker is not a sub");
        assert!(is_sub(&st.registry.get("sub").unwrap()));
        assert!(!is_sub(&st.registry.get("main").unwrap()));
    }

    #[test]
    fn sub_prompt_names_the_main_chat_and_lands_in_the_appended_system_prompt() {
        let mut args = vec!["--append-system-prompt".to_string(), "base".to_string()];
        append_sub_prompt(&mut args, "CV redesign");
        assert!(args[1].starts_with("base"));
        assert!(args[1].contains("finish_subchat"));
        assert!(args[1].contains("Your main chat is \"CV redesign\"."));
    }
}
