//! Waking, nudging and ending a sub. [`continue_sub`] is the one door every
//! "send this to a sub that is not running" goes through: step 6's `subchat
//! send` and step 7's reply typed into a sub opened in place both call it, so a
//! finished or frozen sub comes back the same way no matter who asked.

use crate::daemon::lifecycle::{self, LifecycleError};
use crate::daemon::state::DaemonState;
use crate::sessions::kinds::InstanceKind;
use std::sync::Arc;

/// Text of the daemon's one nudge to a sub that ended a turn without finishing.
/// Built here and never from anything the sub wrote, so it is safe as `is_meta`
/// text. States each way out, because the sub has nothing else to go on.
pub const NUDGE_TEXT: &str = "You ended your turn without calling finish_subchat and without a question waiting for Joe. If the job is done, commit your own edits and call finish_subchat now. If you need Joe, call ask_user_question. If you cannot continue, call finish_subchat with the verdict Blocked and say why.";

#[derive(Debug, thiserror::Error)]
pub enum ContinueError {
    #[error("unknown session: {0}")]
    NotFound(String),
    #[error("{0} is not a sub")]
    NotASub(String),
    #[error("{0} has been ended and cannot continue")]
    Ended(String),
    #[error("{0} is not an interactive chat")]
    NotInteractive(String),
    /// A live child is mid-turn. The caller holds the message for the sub's
    /// next step instead (the held-message queue), as the desktop does.
    #[error("{0} is mid-turn")]
    Busy(String),
    #[error(transparent)]
    Send(#[from] LifecycleError),
}

/// What [`prepare_continue`] changed, so a failed send can put it back.
#[derive(Debug, Clone, Copy, Default)]
pub struct Prior {
    pub finished: bool,
    pub frozen: bool,
    pub auto_frozen: bool,
}

/// Checks `sub_id` can take a message and clears what would stop it:
/// `subchat_finished`, and a freeze (user, gaming-mode park or rate limit),
/// since `respawn_interactive` refuses frozen rows. Resets the Stop hook's
/// block-nudge-card sequence, because the sub is starting a new stretch of work.
pub fn prepare_continue(state: &Arc<DaemonState>, sub_id: &str) -> Result<Prior, ContinueError> {
    let inst = state.registry.get(sub_id).ok_or_else(|| ContinueError::NotFound(sub_id.to_string()))?;
    if !super::is_sub(&inst) {
        return Err(ContinueError::NotASub(sub_id.to_string()));
    }
    if inst.ended_at.is_some() {
        return Err(ContinueError::Ended(sub_id.to_string()));
    }
    if !matches!(inst.kind, InstanceKind::Interactive) {
        return Err(ContinueError::NotInteractive(sub_id.to_string()));
    }
    if inst.busy && state.sessions.contains_key(sub_id) {
        return Err(ContinueError::Busy(sub_id.to_string()));
    }
    let prior = Prior { finished: inst.subchat_finished, frozen: inst.frozen, auto_frozen: inst.auto_frozen };
    if inst.frozen {
        state.registry.set_frozen(sub_id, false);
        state.registry.set_auto_frozen(sub_id, false);
        // The message we are about to send is the continue; the unfreeze path's
        // own "continue" would be a second turn.
        state.registry.take_frozen_needs_continue(sub_id);
    }
    if inst.subchat_finished {
        state.registry.set_subchat_finished(sub_id, false);
    }
    super::runtime::runtime().reset(sub_id);
    Ok(prior)
}

fn restore(state: &DaemonState, sub_id: &str, prior: Prior) {
    if prior.finished {
        state.registry.set_subchat_finished(sub_id, true);
    }
    if prior.frozen {
        state.registry.set_frozen(sub_id, true);
        state.registry.set_auto_frozen(sub_id, prior.auto_frozen);
    }
}

/// Sends `text` to a sub as Joe's own message, waking it with its context if it
/// is finished (process gone) or frozen. The caller owns the text: step 6 passes
/// Joe's words verbatim. A failed send leaves the sub as it was found.
pub async fn continue_sub(state: &Arc<DaemonState>, sub_id: &str, text: &str) -> Result<(), ContinueError> {
    let prior = prepare_continue(state, sub_id)?;
    // A model or effort picked while the sub sat idle lands on this message.
    lifecycle::refresh_stale_launch(state, sub_id).await;
    // Same order as the desktop `send_message` RPC: busy is set before the
    // write because a warm child can answer before the write's `.await` resumes.
    state.registry.set_awaiting(sub_id, None);
    state.registry.set_busy(sub_id, true);
    crate::sessions::chat_state::set_busy(sub_id, true);
    match lifecycle::send_message_with_respawn(state, sub_id, text, false).await {
        Ok(()) => {
            crate::daemon::machines::publish_instances_changed(state);
            Ok(())
        }
        Err(e) => {
            state.registry.set_busy(sub_id, false);
            crate::sessions::chat_state::set_busy(sub_id, false);
            restore(state, sub_id, prior);
            Err(ContinueError::Send(e))
        }
    }
}

/// The daemon's own message to a sub (`NUDGE_TEXT`). `is_meta` so it reads as a
/// system note, and because the text is constant, never sub-written. Marks the
/// turn wake-opened like every daemon-injected turn.
pub async fn nudge(state: &Arc<DaemonState>, sub_id: &str, text: &str) -> Result<(), LifecycleError> {
    let inst = state.registry.get(sub_id).ok_or_else(|| LifecycleError::NotFound(sub_id.to_string()))?;
    if inst.ended_at.is_some() || inst.frozen || inst.subchat_finished {
        return Err(LifecycleError::NotFound(sub_id.to_string()));
    }
    lifecycle::send_message_with_respawn(state, sub_id, text, true).await?;
    state.registry.set_awaiting(sub_id, None);
    state.registry.set_busy_from_wake(sub_id);
    crate::sessions::chat_state::set_busy(sub_id, true);
    crate::daemon::machines::publish_instances_changed(state);
    Ok(())
}

/// Joe's "Nudge again". An idle sub is nudged at once. A sub with a live child
/// still mid-turn (the stalled one) is interrupted and nudged when that turn's
/// result line lands, because a write into a busy child re-opens the race
/// `refuse_if_busy` exists for.
pub async fn request_nudge(state: &Arc<DaemonState>, sub_id: &str) -> Result<(), LifecycleError> {
    let rt = super::runtime::runtime();
    // Joe has seen the card, so the next unfinished end goes straight back to him.
    rt.set_stage(sub_id, super::runtime::SubStage::Nudged);
    let live_and_busy = state.sessions.contains_key(sub_id) && lifecycle::is_busy(state, sub_id);
    if live_and_busy {
        rt.set_nudge_due(sub_id);
        lifecycle::cancel_turn(&state.sessions, sub_id).await?;
        return Ok(());
    }
    nudge(state, sub_id, NUDGE_TEXT).await
}

/// Joe's "End it": the sub is closed for good (unlike finish, which keeps the
/// row). Returns whether it was open.
pub fn end_sub(state: &Arc<DaemonState>, sub_id: &str) -> bool {
    let now = chrono::Utc::now().to_rfc3339();
    let ended = state.registry.mark_ended(sub_id, crate::types::EndReason::Manual, &now);
    if let Some(session) = state.sessions.get(sub_id).map(|s| s.clone()) {
        session.expected_exit.store(true, std::sync::atomic::Ordering::SeqCst);
        crate::util::kill::kill_tree(session.pid);
    }
    super::runtime::runtime().reset(sub_id);
    if ended {
        crate::daemon::machines::publish_instances_changed(state);
    }
    ended
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::types::Settings;

    fn state() -> Arc<DaemonState> {
        DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()))
    }

    fn sub(st: &DaemonState, tag: &str) -> String {
        let (main, sub) = (format!("{tag}-main"), format!("{tag}-sub"));
        st.registry.upsert_interactive(&main, std::path::Path::new("."), "proj", "2026-11-05T00:00:00Z");
        st.registry.upsert_interactive(&sub, std::path::Path::new("."), "proj", "2026-11-05T00:00:00Z");
        st.registry.set_subchat_of(&sub, Some(main));
        sub
    }

    #[test]
    fn prepare_continue_clears_the_finished_flag_and_the_freeze() {
        let st = state();
        let id = sub(&st, "prep");
        st.registry.set_subchat_finished(&id, true);
        st.registry.set_frozen(&id, true);
        st.registry.set_auto_frozen(&id, true);
        st.registry.set_frozen_needs_continue(&id, true);
        let prior = prepare_continue(&st, &id).unwrap();
        assert!(prior.finished && prior.frozen && prior.auto_frozen);
        let row = st.registry.get(&id).unwrap();
        assert!(!row.subchat_finished && !row.frozen && !row.auto_frozen);
        assert!(!st.registry.take_frozen_needs_continue(&id), "the unfreeze path's own continue must not also fire");
    }

    #[test]
    fn prepare_continue_refuses_an_ended_row_a_non_sub_and_an_unknown_one() {
        let st = state();
        let id = sub(&st, "refuse");
        st.registry.mark_ended(&id, crate::types::EndReason::Manual, "2026-11-05T00:00:00Z");
        assert!(matches!(prepare_continue(&st, &id), Err(ContinueError::Ended(_))));
        st.registry.upsert_interactive("plain", std::path::Path::new("."), "proj", "2026-11-05T00:00:00Z");
        assert!(matches!(prepare_continue(&st, "plain"), Err(ContinueError::NotASub(_))));
        assert!(matches!(prepare_continue(&st, "ghost"), Err(ContinueError::NotFound(_))));
    }

    /// Reaches `spawn_session`'s account stage, which is as far as a unit test
    /// can go without starting a real `claude`: a frozen or finished row that
    /// was not cleared first would stop earlier, as NotFound from the
    /// respawn filter.
    fn reached_the_spawn(e: &ContinueError) -> bool {
        matches!(e, ContinueError::Send(LifecycleError::NoAccounts | LifecycleError::NoDefault))
    }

    #[tokio::test]
    async fn continue_sub_resumes_a_finished_row_and_a_frozen_one() {
        let st = state();
        for (tag, finished, frozen) in [("cont-fin", true, false), ("cont-frz", false, true), ("cont-both", true, true)] {
            let id = sub(&st, tag);
            st.registry.set_subchat_finished(&id, finished);
            st.registry.set_frozen(&id, frozen);
            let err = continue_sub(&st, &id, "tweak it").await.unwrap_err();
            assert!(reached_the_spawn(&err), "{tag}: the send must reach the respawn, got {err:?}");
        }
    }

    #[tokio::test]
    async fn a_failed_continue_leaves_the_sub_as_it_was_found() {
        let st = state();
        let id = sub(&st, "restore");
        st.registry.set_subchat_finished(&id, true);
        st.registry.set_frozen(&id, true);
        st.registry.set_auto_frozen(&id, true);
        assert!(continue_sub(&st, &id, "x").await.is_err());
        let row = st.registry.get(&id).unwrap();
        assert!(row.subchat_finished && row.frozen && row.auto_frozen && !row.busy);
    }

    #[tokio::test]
    async fn nudge_refuses_a_frozen_or_finished_sub() {
        let st = state();
        let id = sub(&st, "nudge");
        st.registry.set_frozen(&id, true);
        assert!(nudge(&st, &id, NUDGE_TEXT).await.is_err());
        st.registry.set_frozen(&id, false);
        st.registry.set_subchat_finished(&id, true);
        assert!(nudge(&st, &id, NUDGE_TEXT).await.is_err());
    }

    #[tokio::test]
    async fn request_nudge_marks_the_sub_nudged_so_the_next_unfinished_end_asks_joe() {
        let st = state();
        let id = sub(&st, "reqnudge");
        let _ = request_nudge(&st, &id).await;
        assert_eq!(super::super::runtime::runtime().stage(&id), super::super::runtime::SubStage::Nudged);
        assert!(!super::super::runtime::runtime().take_nudge_due(&id), "an idle sub is nudged now, not deferred");
    }

    #[test]
    fn end_sub_marks_the_row_ended() {
        let st = state();
        let id = sub(&st, "end");
        assert!(end_sub(&st, &id));
        assert!(st.registry.get(&id).unwrap().ended_at.is_some());
        assert!(!end_sub(&st, &id), "ending twice is a no-op");
    }

    #[test]
    fn the_nudge_text_names_each_way_out_and_carries_no_dash() {
        assert!(NUDGE_TEXT.contains("finish_subchat") && NUDGE_TEXT.contains("ask_user_question"));
        assert!(!NUDGE_TEXT.contains('\u{2014}'));
    }
}
