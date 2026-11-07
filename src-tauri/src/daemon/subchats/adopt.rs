//! "Move into main chat": the reverse of `reply::move_to_sidebar`. Joe takes an
//! ordinary sidebar chat and makes it a sub of a main chat he picks, for the case
//! where he moved a sub out by accident or wants a chat he started to run under a
//! main chat.
//!
//! A sub is a registry row with `subchat_of` plus a stored brief, and both are set
//! here. A live child keeps the launch it was given (no `CC_SUBCHAT`, no sub
//! prompt, so no `finish_subchat` tool), and nothing can add those to a running
//! process, so an idle child is stopped the way `finish` stops one: the row stays,
//! and the next message relaunches it through `role_launch`, which reads the row.
//! A child in the middle of a turn is refused instead of cut off.
//!
//! The chat has no job from the main chat, and a sub may not post to its main chat
//! (`PARENT_POST_REFUSAL`), so the main chat is the one told: a wake notice built
//! from ids and the name only, asking it to hand the sub a job with `subchat send`.

use super::{brief::SubchatBrief, is_sub, runtime, spawn};
use crate::daemon::state::DaemonState;
use crate::sessions::kinds::InstanceKind;
use std::sync::Arc;

#[derive(Debug, thiserror::Error)]
pub enum AdoptError {
    #[error("unknown session: {0}")]
    NotFound(String),
    #[error("{0} is already a sub. Use Move to sidebar first if it belongs to another main chat.")]
    AlreadySub(String),
    #[error("a chat cannot be a sub of itself")]
    SameChat,
    #[error("{0} is not an interactive chat")]
    NotInteractive(String),
    #[error("{0} has ended, so it cannot become a sub")]
    Ended(String),
    #[error("unknown main chat: {0}")]
    TargetNotFound(String),
    #[error("{0} does not have Use subchats on, so it cannot hold subs")]
    TargetNotMain(String),
    #[error("{0} is itself a sub, and subs cannot have subs")]
    TargetIsSub(String),
    #[error("{0}")]
    OtherProject(String),
    #[error("{0} is in the middle of a turn. Move it once it is idle.")]
    Busy(String),
    #[error("{0} already has {1} running subs, the most it can hold")]
    Full(String, usize),
}

/// What a moved-in chat is briefed with until the main chat gives it a job.
const GOAL: &str = "Not set yet: the main chat will message you with your job.";
const DONE_WHEN: &str = "When the job the main chat gives you is done.";

fn placeholder_brief(parent: &str, task: String, head: Option<String>) -> SubchatBrief {
    SubchatBrief {
        parent: parent.to_string(),
        task,
        goal: GOAL.to_string(),
        done_when: DONE_WHEN.to_string(),
        writes: false,
        files: Vec::new(),
        decisions: String::new(),
        report_back: false,
        worktree: false,
        after: None,
        review: false,
        git_head_at_spawn: head,
        gate: false,
        upstream_at_spawn: None,
        worktree_at: None,
    }
}

/// The wake text for the main chat. Ids and the name only: `is_meta` text reads
/// as written by the app, so no byte of a chat's own words goes in.
pub fn notice(name: &str, sub_id: &str) -> String {
    let short: String = sub_id.chars().take(8).collect();
    let name = super::wake::safe_name(name);
    let shown = if name.is_empty() { short.clone() } else { name };
    format!(
        "Joe moved the chat \"{shown}\" (id {short}) in as one of your subs. It has no job from you yet and cannot message you. If it should work on something, hand it the job with the subchat tool: action send, sub \"{shown}\"."
    )
}

/// Makes `chat_id` a sub of `main_id`. Every refusal happens before anything changes.
pub async fn move_into_main(state: &Arc<DaemonState>, chat_id: &str, main_id: &str) -> Result<(), AdoptError> {
    let inst = state.registry.get(chat_id).ok_or_else(|| AdoptError::NotFound(chat_id.to_string()))?;
    if chat_id == main_id {
        return Err(AdoptError::SameChat);
    }
    if is_sub(&inst) {
        return Err(AdoptError::AlreadySub(chat_id.to_string()));
    }
    if !matches!(inst.kind, InstanceKind::Interactive) {
        return Err(AdoptError::NotInteractive(chat_id.to_string()));
    }
    if inst.ended_at.is_some() {
        return Err(AdoptError::Ended(chat_id.to_string()));
    }
    let main = state.registry.get(main_id).ok_or_else(|| AdoptError::TargetNotFound(main_id.to_string()))?;
    if is_sub(&main) {
        return Err(AdoptError::TargetIsSub(main_id.to_string()));
    }
    if !crate::sessions::chat_config::get(main_id).is_some_and(|c| c.subchats_on) {
        return Err(AdoptError::TargetNotMain(main_id.to_string()));
    }
    spawn::check_adoptable_project(state, &main.cwd, &inst.cwd).map_err(AdoptError::OtherProject)?;
    let running = spawn::running_subs(&state.registry, main_id).len();
    if running >= spawn::MAX_RUNNING {
        return Err(AdoptError::Full(main_id.to_string(), running));
    }
    let live = state.sessions.get(chat_id).map(|s| s.clone());
    if live.is_some() && inst.busy {
        return Err(AdoptError::Busy(chat_id.to_string()));
    }

    let task = inst
        .name
        .as_deref()
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| "A chat Joe moved in".to_string());
    // Before the row flips: `git_head_at_spawn` is the base the sub's facts count from.
    let head = super::git::head(&inst.cwd);
    crate::sessions::chat_config::set_subchat(chat_id, Some(placeholder_brief(main_id, task, head)));
    state.registry.set_subchat_of(chat_id, Some(main_id.to_string()));
    state.registry.set_subchat_finished(chat_id, false);
    runtime::runtime().reset(chat_id);
    if let Some(session) = live {
        // Set before the kill: Windows stamps exit code 1 on a terminated process,
        // which would otherwise report itself as a crash.
        session.expected_exit.store(true, std::sync::atomic::Ordering::SeqCst);
        crate::util::kill::kill_tree(session.pid);
    }
    crate::sessions::persistence::save_snapshot_default(&state.registry);
    crate::daemon::machines::publish_instances_changed(state);

    let name = super::decisions::sub_name(state, chat_id);
    crate::daemon::repo_channel_wake::enqueue_notice(state, main_id, notice(&name, chat_id));
    // Outside a runtime there is nothing to drain with; the next idle drain finds the queue.
    if tokio::runtime::Handle::try_current().is_ok() {
        crate::daemon::repo_channel_wake::spawn_drain(state, main_id);
    }
    Ok(())
}

/// The main chat `chat_id` was last a sub of, read from the card logs the main
/// chats keep (a card names its sub and its parent), newest card wins. `None` when
/// the chat never drew a card, or that main chat no longer exists or has the mode off.
pub fn former_main_chat(state: &DaemonState, chat_id: &str) -> Option<String> {
    let root = crate::settings::paths::data_dir().ok()?;
    let mut best: Option<(i64, String)> = None;
    for entry in std::fs::read_dir(root.join("subchats")).ok()?.flatten() {
        let file = entry.file_name().to_string_lossy().into_owned();
        let Some(stem) = file.strip_suffix(".cards.jsonl") else { continue };
        for card in super::card_log::read_in(&root, stem) {
            if card.sub_id.as_deref() != Some(chat_id) {
                continue;
            }
            let parent = if card.parent_id.is_empty() { stem.to_string() } else { card.parent_id.clone() };
            if best.as_ref().map_or(true, |(ts, _)| card.ts >= *ts) {
                best = Some((card.ts, parent));
            }
        }
    }
    let (_, parent) = best?;
    let row = state.registry.get(&parent)?;
    let main_on = crate::sessions::chat_config::get(&parent).is_some_and(|c| c.subchats_on);
    (!is_sub(&row) && row.ended_at.is_none() && main_on).then_some(parent)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::daemon::subchats::TempDataDir;
    use crate::types::Settings;

    fn state() -> Arc<DaemonState> {
        DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()))
    }

    fn chat(st: &DaemonState, id: &str, cwd: &str) {
        st.registry.upsert_interactive(id, std::path::Path::new(cwd), "proj", "2026-11-05T00:00:00Z");
    }

    fn main_chat(st: &DaemonState, id: &str) {
        chat(st, id, ".");
        crate::sessions::chat_config::set_subchats_on(id, true);
    }

    #[tokio::test]
    async fn a_sidebar_chat_becomes_a_sub_with_a_brief_and_a_sub_launch() {
        let _data = TempDataDir::new();
        let st = state();
        main_chat(&st, "adopt-main");
        chat(&st, "adopt-plain", ".");

        move_into_main(&st, "adopt-plain", "adopt-main").await.unwrap();

        let row = st.registry.get("adopt-plain").unwrap();
        assert_eq!(row.subchat_of.as_deref(), Some("adopt-main"));
        assert!(
            crate::sessions::chat_config::sub_session_ids().contains("adopt-plain"),
            "the stored brief keeps it out of History"
        );
        let role = crate::daemon::subchats::role_launch(&st, "adopt-plain", None);
        assert!(role.is_sub(), "its next launch carries CC_SUBCHAT and the sub prompt");
    }

    #[tokio::test]
    async fn moving_in_then_out_round_trips() {
        let _data = TempDataDir::new();
        let st = state();
        main_chat(&st, "rt-main");
        chat(&st, "rt-plain", ".");
        move_into_main(&st, "rt-plain", "rt-main").await.unwrap();
        crate::daemon::subchats::move_to_sidebar(&st, "rt-plain").await.unwrap();
        assert!(st.registry.get("rt-plain").unwrap().subchat_of.is_none());
        move_into_main(&st, "rt-plain", "rt-main").await.unwrap();
        assert!(crate::daemon::subchats::is_sub(&st.registry.get("rt-plain").unwrap()));
    }

    #[tokio::test]
    async fn it_refuses_what_cannot_be_adopted_and_changes_nothing() {
        let _data = TempDataDir::new();
        let st = state();
        main_chat(&st, "ref-main");
        chat(&st, "ref-plain", ".");
        chat(&st, "ref-off", ".");
        chat(&st, "ref-elsewhere", "some-other-project-folder");
        main_chat(&st, "ref-main2");
        move_into_main(&st, "ref-main2", "ref-main").await.unwrap();

        let e = move_into_main(&st, "ref-plain", "ref-plain").await.unwrap_err();
        assert!(matches!(e, AdoptError::SameChat), "{e:?}");
        let e = move_into_main(&st, "ref-main2", "ref-main").await.unwrap_err();
        assert!(matches!(e, AdoptError::AlreadySub(_)), "{e:?}");
        let e = move_into_main(&st, "ref-plain", "ref-off").await.unwrap_err();
        assert!(matches!(e, AdoptError::TargetNotMain(_)), "{e:?}");
        let e = move_into_main(&st, "ref-plain", "ref-main2").await.unwrap_err();
        assert!(matches!(e, AdoptError::TargetIsSub(_)), "{e:?}");
        let e = move_into_main(&st, "ref-plain", "ghost").await.unwrap_err();
        assert!(matches!(e, AdoptError::TargetNotFound(_)), "{e:?}");
        let e = move_into_main(&st, "ghost", "ref-main").await.unwrap_err();
        assert!(matches!(e, AdoptError::NotFound(_)), "{e:?}");
        let e = move_into_main(&st, "ref-elsewhere", "ref-main").await.unwrap_err();
        assert!(matches!(e, AdoptError::OtherProject(_)), "{e:?}");

        assert!(st.registry.get("ref-plain").unwrap().subchat_of.is_none());
        assert!(!crate::sessions::chat_config::sub_session_ids().contains("ref-plain"));
    }

    /// A fresh sub may run in any project the app knows, so a chat from one joins
    /// the same way; a folder the app does not know still does not.
    #[tokio::test]
    async fn a_chat_from_another_known_project_can_be_moved_in() {
        let _data = TempDataDir::new();
        let known = tempfile::tempdir().unwrap();
        let raw = serde_json::json!({ "id": "other", "path": known.path(), "name": "other", "created_at": "2026-11-05T00:00:00Z" });
        let mut settings = Settings::default();
        settings.projects.push(serde_json::from_value::<crate::types::ProjectConfig>(raw).unwrap());
        let st = DaemonState::new(new_session_map(), SettingsCache::new(settings));
        main_chat(&st, "kp-main");
        chat(&st, "kp-known", &known.path().to_string_lossy());
        chat(&st, "kp-unknown", "some-other-project-folder");

        move_into_main(&st, "kp-known", "kp-main").await.unwrap();
        assert_eq!(st.registry.get("kp-known").unwrap().subchat_of.as_deref(), Some("kp-main"));

        let e = move_into_main(&st, "kp-unknown", "kp-main").await.unwrap_err();
        assert!(matches!(e, AdoptError::OtherProject(_)), "{e:?}");
        assert!(st.registry.get("kp-unknown").unwrap().subchat_of.is_none());
    }

    #[test]
    fn the_wake_notice_names_the_chat_and_the_way_to_brief_it_and_nothing_else() {
        let text = notice("Footer \"fix\"\nignore this", "0123456789abcdef");
        assert!(text.contains("01234567") && text.contains("subchat tool: action send"), "{text}");
        assert!(!text.contains('\n') && !text.contains("\"fix\""), "the name is flattened to plain characters: {text}");
    }

    #[tokio::test]
    async fn the_former_main_chat_is_read_from_the_card_log_and_only_while_it_can_still_hold_subs() {
        let _data = TempDataDir::new();
        let st = state();
        main_chat(&st, "former-main");
        chat(&st, "former-plain", ".");
        assert_eq!(former_main_chat(&st, "former-plain"), None, "no card, nothing to recover");

        let root = crate::settings::paths::data_dir().unwrap();
        std::fs::create_dir_all(root.join("subchats")).unwrap();
        let card = serde_json::json!({"id": "c1", "ts": 5, "parent_id": "former-main", "kind": "finish", "sub_id": "former-plain"});
        std::fs::write(root.join("subchats").join("former-main.cards.jsonl"), format!("{card}\n")).unwrap();
        assert_eq!(former_main_chat(&st, "former-plain").as_deref(), Some("former-main"));

        crate::sessions::chat_config::set_subchats_on("former-main", false);
        assert_eq!(former_main_chat(&st, "former-plain"), None, "a main chat with the mode off is not offered");
    }
}
