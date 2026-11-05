//! Subchats: a chat with "Use subchats" on hands jobs Joe names to hidden child
//! chats (subs). This module is where that feature's daemon logic lives; add
//! submodules here rather than spreading it through the lifecycle and hook files.
//!
//! A sub is an ordinary registry row with `Instance::subchat_of` set. It is NOT
//! a Jarvis worker (`worker_of`): that field wakes its parent on every state
//! change, which is exactly what a sub must never do.

mod brief;
pub mod spawn;

pub use brief::{SubchatArgs, SubchatBrief};

use crate::accounts::Account;
use crate::daemon::claude_config::{append_system_prompt, SUBCHAT_SUB_PROMPT};
use crate::daemon::rpc::RpcError;
use crate::daemon::state::DaemonState;
use crate::types::Instance;
use std::sync::Arc;

pub mod cards;
pub mod finish;
pub(crate) mod git;
mod resume;
pub(crate) mod runtime;
pub mod stall;
pub mod stuck;
pub mod turn_end;

pub use resume::{continue_sub, end_sub, nudge, request_nudge, ContinueError, NUDGE_TEXT};

/// Env var that marks a sub's MCP child, so `finish_subchat` is listed for it
/// and for no other chat. Read by `mcp::server`, written by `write_mcp_config`.
pub const SUB_ENV: &str = "CC_SUBCHAT";

mod routing;
pub use routing::{
    display_session_id, is_sub_session, stamp_prompt_routing, sub_task, UNCONFIRMED_NOTE,
};

/// Whether `inst` is a hidden sub of some main chat.
pub fn is_sub(inst: &Instance) -> bool {
    inst.subchat_of.is_some()
}

/// What a sub is told when its `post_message` names its own main chat.
pub const PARENT_POST_REFUSAL: &str = "A sub does not message its main chat: the post would wake the main agent and spend its context. If you need Joe, ask on a card with ask_user_question; when the job is done, call finish_subchat. Posts to other chats still work.";

/// `Some(reason)` when `caller` is a sub and `addressed` (a `post_message`
/// `target` list or its `to`) names that sub's own parent. Broadcasts and posts
/// to anyone else (siblings, unrelated chats) pass: subs keep the repo channel
/// to coordinate on shared files.
pub fn parent_post_refusal(state: &DaemonState, caller: &str, addressed: &[String]) -> Option<&'static str> {
    let parent = state.registry.get(caller)?.subchat_of?;
    addressed.iter().any(|id| *id == parent).then_some(PARENT_POST_REFUSAL)
}

/// The one hook point for "a sub just finished". Fired by
/// [`finish::commit_finish`] after the record is stored, `subchat_finished` is
/// set and the process is stopped. The parent-side cards, the one line back,
/// the `after` chain and the decisions log all hang off this function, so each
/// adds its call here rather than into the finish path.
///
/// Synchronous on purpose: it runs inside the pump's result handler, where an
/// inline `.await` that can respawn a child makes the pump future
/// self-referential (`jarvis_wake::spawn_drain` documents it). A step that
/// needs async work spawns it from here.
pub fn on_finished(_state: &Arc<DaemonState>, sub_id: &str) {
    log::debug!("subchats: on_finished {sub_id}");
    #[cfg(test)]
    test_support::record_finished(sub_id);
}

#[cfg(test)]
pub(crate) mod test_support {
    use std::sync::Mutex;

    static FINISHED: Mutex<Vec<String>> = Mutex::new(Vec::new());

    pub fn record_finished(sub_id: &str) {
        FINISHED.lock().unwrap_or_else(|p| p.into_inner()).push(sub_id.to_string());
    }

    /// Every sub id `on_finished` has fired for in this test process.
    pub fn finished_calls() -> Vec<String> {
        FINISHED.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }
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

/// Adds [`sub_prompt`] to a spawn's `--append-system-prompt`. Idempotent: the
/// spawn path (`lifecycle::spawn_session`) calls it for every spawn and respawn
/// of a sub, since a resumed child rebuilds its argv and would otherwise lose
/// the rules, and a caller that already added it must not double them.
pub fn append_sub_prompt(args: &mut [String], parent_label: &str) {
    if args.iter().any(|a| a.contains(SUBCHAT_SUB_PROMPT)) {
        return;
    }
    append_system_prompt(args, &sub_prompt(parent_label));
}

/// The main chat `session_id` is a sub of, for a child about to be launched.
/// `explicit` is the first spawn, whose registry row does not exist yet; every
/// later launch of the same sub (a respawn after a model pick, a continue after
/// finishing) has no such argument and reads the registry row instead, so the
/// sub keeps `CC_SUBCHAT` and its prompt however it is relaunched.
pub fn launch_parent(state: &DaemonState, session_id: &str, explicit: Option<&str>) -> Option<String> {
    explicit
        .map(str::to_string)
        .or_else(|| state.registry.get(session_id).and_then(|i| i.subchat_of))
}

/// How a sub's prompt names its main chat: the chat's title, else its folder
/// name, else a plain "main chat". A label for the model to read, not an id.
pub fn parent_label(state: &DaemonState, parent_id: &str) -> String {
    state
        .registry
        .get(parent_id)
        .and_then(|p| {
            p.name
                .filter(|n| !n.trim().is_empty())
                .or_else(|| p.cwd.file_name().map(|n| n.to_string_lossy().into_owned()))
        })
        .unwrap_or_else(|| "main chat".to_string())
}

/// Points `CC_DATA_DIR` at a scratch dir for one test, so a test that writes
/// `chat-config.json` never touches the real app data, and holds the env lock
/// so two such tests never race on the variable.
#[cfg(test)]
pub(crate) struct TempDataDir {
    _guard: std::sync::MutexGuard<'static, ()>,
    _dir: tempfile::TempDir,
}

#[cfg(test)]
impl TempDataDir {
    pub(crate) fn new() -> Self {
        let guard = crate::util::ENV_MUTATION_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = tempfile::tempdir().unwrap();
        std::env::set_var("CC_DATA_DIR", dir.path());
        Self { _guard: guard, _dir: dir }
    }
}

#[cfg(test)]
impl Drop for TempDataDir {
    fn drop(&mut self) {
        std::env::remove_var("CC_DATA_DIR");
    }
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
    fn a_relaunched_sub_finds_its_parent_in_the_registry_without_the_first_spawns_arguments() {
        let st = state();
        chat(&st, "main", None, "opus", "high");
        st.registry.set_name("main", "CV redesign".into());
        chat(&st, "sub", None, "sonnet", "high");
        assert_eq!(launch_parent(&st, "sub", None), None, "a plain chat is not a sub");
        st.registry.set_subchat_of("sub", Some("main".into()));
        assert_eq!(launch_parent(&st, "sub", None).as_deref(), Some("main"));
        assert_eq!(launch_parent(&st, "fresh", Some("main")).as_deref(), Some("main"), "first spawn has no row yet");
        assert_eq!(parent_label(&st, "main"), "CV redesign");
        st.registry.set_subchat_of("sub", None);
        assert_eq!(launch_parent(&st, "sub", None), None, "Move to sidebar drops the sub marking");
    }

    #[test]
    fn append_sub_prompt_is_idempotent_so_every_respawn_can_call_it() {
        let mut args = vec!["--append-system-prompt".to_string(), "base".to_string()];
        append_sub_prompt(&mut args, "CV redesign");
        let once = args[1].clone();
        append_sub_prompt(&mut args, "CV redesign");
        assert_eq!(args[1], once, "a second call must not double the rules");
    }

    #[test]
    fn parent_label_prefers_the_title_then_the_folder_then_a_plain_name() {
        let st = state();
        st.registry.upsert_interactive("m", std::path::Path::new("C:/work/cv-site"), "proj", "2026-11-05T00:00:00Z");
        assert_eq!(parent_label(&st, "m"), "cv-site");
        st.registry.set_name("m", "CV redesign".to_string());
        assert_eq!(parent_label(&st, "m"), "CV redesign");
        assert_eq!(parent_label(&st, "gone"), "main chat");
    }

    #[test]
    fn parent_post_refusal_names_only_the_subs_own_parent() {
        let st = state();
        for id in ["m", "s", "sib", "x"] {
            st.registry.upsert_interactive(id, std::path::Path::new("."), "proj", "2026-11-05T00:00:00Z");
        }
        st.registry.set_subchat_of("s", Some("m".into()));
        st.registry.set_subchat_of("sib", Some("m".into()));
        let to = |ids: &[&str]| ids.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert!(parent_post_refusal(&st, "s", &to(&["m"])).is_some());
        assert!(parent_post_refusal(&st, "s", &to(&["sib", "m"])).is_some(), "one parent among many still refuses");
        assert!(parent_post_refusal(&st, "s", &to(&["sib"])).is_none(), "a sibling is fine");
        assert!(parent_post_refusal(&st, "s", &to(&["x"])).is_none());
        assert!(parent_post_refusal(&st, "s", &[]).is_none(), "a broadcast names nobody");
        assert!(parent_post_refusal(&st, "m", &to(&["s"])).is_none(), "the parent may post to its sub");
        assert!(parent_post_refusal(&st, "x", &to(&["m"])).is_none(), "a chat that is not a sub may post to anyone");
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
