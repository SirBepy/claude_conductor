//! The per-peer "can drive this PC's chats" switch
//! (`MachineRegistry::can_drive`). A peer with it off still SEES every chat
//! (list, history, git and file reads), and may start chats here and drive
//! those (`ChatConfig::started_by_machine`). Every other peer-callable method
//! counts as acting on a chat and is refused for a chat that peer didn't
//! start - default-deny, so a method added to the transport table later is
//! limited until someone lists it in `SEE_ONLY` on purpose.
//!
//! Enforced on the two doors a peer's calls come through: `/api/rpc`
//! (`remote_handlers::rpc_dispatch`) and the REST send route.

use serde_json::Value;

use crate::daemon::state::DaemonState;

/// Peer-callable methods that only read. Everything else a peer may call
/// acts on a chat (`remote_transport_table::TRANSPORT_TABLE`'s `PM`/`M` rows).
const SEE_ONLY: &[&str] = &[
    "list_instances",
    "list_pending_prompts",
    "get_skipped_question_marks",
    "list_auto_accept",
    "list_wrap_up_on_done",
    "load_history_page",
    "load_event_detail",
    "load_history",
    "transcript_stats",
    "read_attachment",
    // Read-only views of a chat's previews and images; a view-only peer still
    // sees what a mirrored chat shows.
    "list_previews",
    "get_preview",
    "read_image_file",
    "list_projects",
    // The new-chat picker's project list and its row icons: a view-only peer
    // still starts chats here, so it must be able to choose a project.
    "new_session_bundle",
    "get_project_icon",
    "get_project_tech",
    "get_recent_branches",
    "get_range_files",
    "get_file_diff",
    "get_file_at_rev",
    "list_branch_files",
    "get_git_info",
    "get_git_dirty",
    "get_commit_sync",
    "get_commit_history",
    "list_project_files",
    "get_session_drafts",
    "get_hidden_chats",
    "peer_unpaired",
];

/// Methods that create a new chat here. Always allowed; `rpc_dispatch`
/// stamps the result as the calling peer's own chat.
pub(crate) const STARTS_A_CHAT: &[&str] = &["start_session", "spawn_chat"];

/// Prompt answers name a prompt, and the prompt's own session is what they
/// act on, whatever `session_id` the caller sends alongside it.
const PROMPT_METHODS: &[(&str, &str)] = &[
    ("respond_permission", "request_id"),
    ("respond_question", "request_id"),
    ("confirm_question_rendered", "id"),
];

/// True when the owner switched `machine_id`'s drive switch off.
pub(crate) fn is_view_only(state: &DaemonState, machine_id: &str) -> bool {
    state.machines.get().is_some_and(|r| !r.can_drive(machine_id))
}

/// Whether `machine_id` started `session_id` on this machine.
pub(crate) fn started_by(session_id: &str, machine_id: &str) -> bool {
    crate::sessions::chat_config::get(session_id).is_some_and(|c| c.started_by_machine == machine_id)
}

/// The chat a call acts on: the owning session of a named prompt for a
/// prompt answer, otherwise `session_id` or `to_session_id`.
async fn target_session(state: &DaemonState, method: &str, params: &Value) -> Option<String> {
    if let Some((_, key)) = PROMPT_METHODS.iter().find(|(m, _)| *m == method) {
        let prompt_id = params.get(*key).and_then(Value::as_str)?;
        return state.prompt_session_id(prompt_id).await;
    }
    params
        .get("session_id")
        .or_else(|| params.get("to_session_id"))
        .and_then(Value::as_str)
        .map(str::to_string)
}

/// `Err(reason)` when a view-only peer calls a chat-acting method on a chat
/// it didn't start here. A call whose target can't be resolved is refused
/// too: ownership that can't be shown isn't assumed.
pub(crate) async fn check(state: &DaemonState, method: &str, params: &Value, machine_id: &str) -> Result<(), String> {
    check_with(state, method, params, machine_id, |sid| started_by(sid, machine_id)).await
}

/// `check` with the ownership lookup passed in, so tests never touch the
/// real chat-config.json the live daemon also writes.
async fn check_with(
    state: &DaemonState,
    method: &str,
    params: &Value,
    machine_id: &str,
    is_own: impl Fn(&str) -> bool,
) -> Result<(), String> {
    if !is_view_only(state, machine_id) || SEE_ONLY.contains(&method) || STARTS_A_CHAT.contains(&method) {
        return Ok(());
    }
    match target_session(state, method, params).await {
        Some(sid) if is_own(&sid) => Ok(()),
        _ => Err(format!(
            "this machine can view chats here but only drive the ones it started; {method} refused"
        )),
    }
}

/// Keeps only the prompts of chats `machine_id` started, for a view-only
/// peer's `list_pending_prompts`: it can't answer the others, so showing
/// them would only strand cards on its screen.
pub(crate) fn retain_own_prompts(prompts: &mut Vec<Value>, machine_id: &str) {
    retain_prompts_where(prompts, |sid| started_by(sid, machine_id));
}

fn retain_prompts_where(prompts: &mut Vec<Value>, is_own: impl Fn(&str) -> bool) {
    prompts.retain(|p| p["payload"]["session_id"].as_str().is_some_and(&is_own));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::machines::registry::PeerMachine;
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::types::Settings;
    use serde_json::json;
    use std::sync::Arc;

    fn state_with_peer(dir: &std::path::Path, view_only: bool) -> Arc<DaemonState> {
        let state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        state.init_machines(dir.to_path_buf());
        let reg = state.machines.get().unwrap();
        reg.upsert_peer(PeerMachine {
            machine_id: "mac".into(),
            label: "Mac".into(),
            os: "macos".into(),
            iroh_id: None,
            direct_url: None,
            token: "dummy-token".into(),
            reverse_device_id: None,
            added_at: 0,
        });
        assert!(reg.set_can_drive("mac", !view_only));
        state
    }

    const MINE: &str = "mac-started-chat";

    fn is_own(sid: &str) -> bool {
        sid == MINE
    }

    async fn check(state: &DaemonState, method: &str, params: &Value, machine_id: &str) -> Result<(), String> {
        check_with(state, method, params, machine_id, is_own).await
    }

    #[tokio::test]
    async fn a_peer_with_the_switch_on_drives_any_chat() {
        let dir = tempfile::tempdir().unwrap();
        let state = state_with_peer(dir.path(), false);
        let r = check(&state, "send_message", &json!({"session_id": "desktop-chat"}), "mac").await;
        assert_eq!(r, Ok(()));
    }

    #[tokio::test]
    async fn a_view_only_peer_is_refused_on_a_desktop_chat_but_drives_its_own() {
        let dir = tempfile::tempdir().unwrap();
        let state = state_with_peer(dir.path(), true);
        let mine = MINE;
        for method in ["send_message", "cancel_turn", "set_auto_accept", "set_wrap_up_on_done", "end_session", "peer_channel_post"] {
            let desktop = json!({"session_id": "desktop-chat", "to_session_id": "desktop-chat"});
            assert!(check(&state, method, &desktop, "mac").await.is_err(), "{method} on a desktop chat");
            let own = json!({"session_id": mine, "to_session_id": mine});
            assert_eq!(check(&state, method, &own, "mac").await, Ok(()), "{method} on its own chat");
        }
    }

    #[tokio::test]
    async fn a_view_only_peer_still_sees_and_starts_chats() {
        let dir = tempfile::tempdir().unwrap();
        let state = state_with_peer(dir.path(), true);
        for method in [
            "list_instances", "load_history_page", "get_git_info", "start_session", "spawn_chat", "list_wrap_up_on_done",
            "new_session_bundle", "get_project_icon", "get_project_tech",
        ] {
            assert_eq!(check(&state, method, &json!({"session_id": "desktop-chat"}), "mac").await, Ok(()), "{method}");
        }
    }

    /// The prompt's own session decides, so a peer can't answer a desktop
    /// chat's card by sending one of its own session ids next to it.
    #[tokio::test]
    async fn a_prompt_answer_is_judged_by_the_prompts_session_not_the_claimed_one() {
        let dir = tempfile::tempdir().unwrap();
        let state = state_with_peer(dir.path(), true);
        let mine = MINE;
        state.add_prompt("desk-card", "permission-requested", json!({"session_id": "desktop-chat"}), false).await;
        state.add_prompt("own-card", "permission-requested", json!({"session_id": mine}), false).await;

        let smuggled = json!({"request_id": "desk-card", "session_id": mine});
        assert!(check(&state, "respond_permission", &smuggled, "mac").await.is_err());
        let own = json!({"request_id": "own-card", "session_id": mine});
        assert_eq!(check(&state, "respond_permission", &own, "mac").await, Ok(()));
        let unknown = json!({"request_id": "gone", "session_id": mine});
        assert!(check(&state, "respond_permission", &unknown, "mac").await.is_err(), "unprovable ownership is refused");
    }

    #[test]
    fn a_view_only_peers_prompt_list_keeps_only_its_own_chats() {
        let mine = MINE;
        let mut prompts = vec![
            json!({"id": "a", "payload": {"session_id": "desktop-chat"}}),
            json!({"id": "b", "payload": {"session_id": mine}}),
        ];
        retain_prompts_where(&mut prompts, is_own);
        assert_eq!(prompts.len(), 1);
        assert_eq!(prompts[0]["id"], "b");
    }

    #[test]
    fn the_switch_survives_a_reload_and_an_unpair_clears_it() {
        let dir = tempfile::tempdir().unwrap();
        let state = state_with_peer(dir.path(), true);
        let reloaded = crate::daemon::machines::MachineRegistry::load(dir.path());
        assert!(!reloaded.can_drive("mac"));
        assert!(!reloaded.view(&reloaded.peer("mac").unwrap()).can_drive);
        state.machines.get().unwrap().remove_peer("mac");
        let reloaded = crate::daemon::machines::MachineRegistry::load(dir.path());
        assert!(reloaded.can_drive("mac"), "a re-pair after unpair starts from the default");
        assert!(!reloaded.set_can_drive("never-paired", false), "no switch for a machine that isn't paired");
    }
}
