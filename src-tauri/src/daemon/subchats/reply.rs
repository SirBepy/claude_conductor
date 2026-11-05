//! Joe's two moves on a sub he opened in the main chat's window: typing to it,
//! and "Move to sidebar".

use super::{continue_sub, is_sub, runtime, ContinueError};
use crate::daemon::state::DaemonState;
use std::sync::Arc;

/// Routes a send that targets a sub through [`continue_sub`], the one door that
/// clears `subchat_finished` and a freeze. `None` means the ordinary send path
/// applies: the id is not a sub, or it is a live, unfrozen, unfinished child
/// (running or idle between turns), whose normal path already writes to it and
/// refuses a mid-turn write with the busy error the clients hold the message for.
///
/// A sub with no live child falls in here even when it was never finished, so a
/// crashed one resumes the same way instead of through the desktop's own
/// resume-and-retry, which does not know about the sub flags.
pub async fn route_send(
    state: &Arc<DaemonState>,
    session_id: &str,
    text: &str,
) -> Option<Result<(), ContinueError>> {
    let inst = state.registry.get(session_id)?;
    if !is_sub(&inst) {
        return None;
    }
    let live = state.sessions.contains_key(session_id);
    if live && !inst.subchat_finished && !inst.frozen {
        return None;
    }
    match continue_sub(state, session_id, text).await {
        // A child that started a turn between the check and the send: the
        // ordinary path refuses it with the busy error, and the client queues.
        Err(ContinueError::Busy(_)) => None,
        done => Some(done),
    }
}

#[derive(Debug, thiserror::Error)]
pub enum MoveError {
    #[error("unknown session: {0}")]
    NotFound(String),
    #[error("{0} is not a sub")]
    NotASub(String),
    /// A queued sub has no conversation yet; as a sidebar chat it would be an
    /// empty row that cannot resume.
    #[error("{0} has not started yet, so it cannot move to the sidebar. Drop it, or wait for it to start.")]
    Held(String),
}

/// Turns a sub into an ordinary chat for good, and ends every rule that treated
/// it as a sub.
///
/// Three things make a chat a sub and all three clear: `subchat_of` (the sidebar
/// and every list filter on it), the stored brief (past-chat lists read that, so
/// without it the chat stays out of History), and `subchat_finished`.
/// Waiting state tied to the sub role is dropped too: the finish request, the
/// nudge sequence, and any card the daemon raised about it (a stalled-sub card's
/// "End it" would otherwise end a chat Joe just promoted).
///
/// A live child keeps what it was launched with until its next launch: the
/// `CC_SUBCHAT` marking (so `finish_subchat` stays listed) and the sub prompt.
/// Neither can act on the daemon any more, since the finish request and the Stop
/// hook read the registry row, and `finish_subchat` now answers that this chat is
/// not a sub. `role_launch` reads the row on every relaunch, so the next spawn is
/// a plain chat.
pub async fn move_to_sidebar(state: &Arc<DaemonState>, sub_id: &str) -> Result<(), MoveError> {
    let inst = state.registry.get(sub_id).ok_or_else(|| MoveError::NotFound(sub_id.to_string()))?;
    if !is_sub(&inst) {
        return Err(MoveError::NotASub(sub_id.to_string()));
    }
    if super::held::is_held(sub_id) {
        return Err(MoveError::Held(sub_id.to_string()));
    }
    let parent = inst.subchat_of.clone();
    state.registry.set_subchat_of(sub_id, None);
    state.registry.set_subchat_finished(sub_id, false);
    crate::sessions::chat_config::set_subchat(sub_id, None);
    runtime::runtime().reset(sub_id);
    withdraw_cards_about(state, sub_id).await;
    crate::sessions::persistence::save_snapshot_default(&state.registry);
    crate::daemon::machines::publish_instances_changed(state);
    // A main chat waiting on "Wait for them" may have just lost its last running sub.
    if let Some(parent) = parent {
        super::closing::after_leaving(state, &parent);
    }
    Ok(())
}

/// Takes down every card the daemon raised about `sub_id` as a sub.
async fn withdraw_cards_about(state: &Arc<DaemonState>, sub_id: &str) {
    let open: Vec<String> = state
        .list_prompts()
        .await
        .into_iter()
        .filter(|p| {
            p["payload"]["daemon_card"].as_bool() == Some(true) && p["payload"]["sub_id"].as_str() == Some(sub_id)
        })
        .filter_map(|p| p["id"].as_str().map(str::to_string))
        .collect();
    for id in open {
        super::cards::withdraw_card(state, &id).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::daemon::subchats::{store_sub_brief, TempDataDir};
    use crate::types::Settings;

    fn state() -> Arc<DaemonState> {
        DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()))
    }

    fn sub(st: &DaemonState, tag: &str) -> String {
        let (main, sub) = (format!("{tag}-main"), format!("{tag}-sub"));
        st.registry.upsert_interactive(&main, std::path::Path::new("."), "proj", "2026-11-05T00:00:00Z");
        st.registry.upsert_interactive(&sub, std::path::Path::new("."), "proj", "2026-11-05T00:00:00Z");
        st.registry.set_subchat_of(&sub, Some(main.clone()));
        store_sub_brief(&sub, &main);
        sub
    }

    #[tokio::test]
    async fn a_send_to_a_finished_sub_goes_through_continue_sub_and_clears_the_flag() {
        let _data = TempDataDir::new();
        let st = state();
        let id = sub(&st, "route-fin");
        st.registry.set_subchat_finished(&id, true);
        let done = route_send(&st, &id, "tweak it").await.expect("a finished sub is routed");
        // No account in a unit test, so the respawn stops at the spawn: what
        // matters is that continue_sub ran, which clears the flag first and
        // restores it only when the send fails, so a failed one is the proof.
        let err = done.unwrap_err();
        assert!(matches!(err, ContinueError::Send(_)), "got {err:?}");
        assert!(st.registry.get(&id).unwrap().subchat_finished, "a failed continue puts the finished flag back");
    }

    #[tokio::test]
    async fn a_send_to_a_frozen_or_dead_sub_is_routed_and_a_plain_chat_is_not() {
        let _data = TempDataDir::new();
        let st = state();
        let frozen = sub(&st, "route-frz");
        st.registry.set_frozen(&frozen, true);
        assert!(route_send(&st, &frozen, "x").await.is_some(), "a frozen sub resumes through continue_sub");
        let dead = sub(&st, "route-dead");
        assert!(route_send(&st, &dead, "x").await.is_some(), "a sub with no child resumes through continue_sub");
        st.registry.upsert_interactive("plain", std::path::Path::new("."), "proj", "2026-11-05T00:00:00Z");
        assert!(route_send(&st, "plain", "x").await.is_none(), "an ordinary chat keeps its own send path");
        assert!(route_send(&st, "ghost", "x").await.is_none(), "an unknown id keeps its own send path");
    }

    #[tokio::test]
    async fn moving_a_sub_clears_the_parent_the_brief_and_the_finished_flag() {
        let _data = TempDataDir::new();
        let st = state();
        let id = sub(&st, "move-all");
        st.registry.set_subchat_finished(&id, true);
        assert!(crate::sessions::chat_config::sub_session_ids().contains(&id));

        move_to_sidebar(&st, &id).await.unwrap();

        let row = st.registry.get(&id).unwrap();
        assert!(row.subchat_of.is_none() && !row.subchat_finished);
        assert!(
            !crate::sessions::chat_config::sub_session_ids().contains(&id),
            "the stored brief is what keeps a sub out of History"
        );
        // Moved out of the sub set, so the past-chat lists stop subtracting it.
        assert!(!crate::daemon::subchats::hidden_from_past_chats(Vec::new()).contains(&id));
    }

    #[tokio::test]
    async fn a_moved_chat_is_no_longer_refused_as_a_sub() {
        let _data = TempDataDir::new();
        let st = state();
        let id = sub(&st, "move-refuse");
        st.registry.set_subchat_finished(&id, true);
        move_to_sidebar(&st, &id).await.unwrap();

        assert!(route_send(&st, &id, "x").await.is_none(), "a moved chat takes the ordinary send path");
        assert!(matches!(
            crate::daemon::subchats::continue_sub(&st, &id, "x").await,
            Err(ContinueError::NotASub(_))
        ));
        let role = crate::daemon::subchats::role_launch(&st, &id, None);
        assert!(!role.is_sub(), "the next launch carries no CC_SUBCHAT and no sub prompt");
        assert_eq!(
            crate::daemon::subchats::display_session_id(&st, &id),
            id,
            "its cards now show in its own window: list_pending_prompts re-stamps from the registry"
        );
    }

    #[tokio::test]
    async fn moving_refuses_a_chat_that_is_not_a_sub_and_an_unknown_one() {
        let _data = TempDataDir::new();
        let st = state();
        st.registry.upsert_interactive("plain-mv", std::path::Path::new("."), "proj", "2026-11-05T00:00:00Z");
        assert!(matches!(move_to_sidebar(&st, "plain-mv").await, Err(MoveError::NotASub(_))));
        assert!(matches!(move_to_sidebar(&st, "ghost-mv").await, Err(MoveError::NotFound(_))));
    }

    #[tokio::test]
    async fn moving_stops_a_running_subs_finish_rule_and_takes_down_its_stalled_card() {
        let _data = TempDataDir::new();
        let st = state();
        let id = sub(&st, "move-run");
        let main = st.registry.get(&id).unwrap().subchat_of.unwrap();
        let card = crate::daemon::subchats::cards::raise_card(
            &st,
            crate::daemon::subchats::cards::RaisedCard {
                kind: "subchat_stuck",
                display_session_id: main,
                sub_id: Some(id.clone()),
                header: "Sub stalled".into(),
                question: "q".into(),
                options: vec![crate::daemon::subchats::cards::CardOption::new("End it", "d")],
                domain: None,
            },
        )
        .await
        .unwrap();
        runtime::runtime().set_stage(&id, runtime::SubStage::Nudged);

        move_to_sidebar(&st, &id).await.unwrap();

        assert_eq!(runtime::runtime().stage(&id), runtime::SubStage::default(), "the nudge sequence is dropped");
        assert!(
            crate::daemon::subchats::cards::open_card_for(&st, "subchat_stuck", &id).await.is_none(),
            "a stalled-sub card about a promoted chat has nothing left to act on"
        );
        assert_eq!(card.answer().await, crate::daemon::subchats::cards::CardAnswer::Withdrawn);
        let refused = crate::daemon::subchats::finish::request_finish_with(
            &st,
            &id,
            crate::daemon::subchats::finish::FinishArgs::default(),
            None,
        )
        .await
        .unwrap_err();
        assert!(refused.contains("not one"), "finish_subchat now says this chat is not a sub: {refused}");
    }
}
