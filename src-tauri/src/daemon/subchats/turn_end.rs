//! What a sub's turn ending sets in motion. The pump calls [`on_turn_end`] from
//! its result-line handler and [`on_process_exit`] from its EOF handler, the two
//! places `/close` teardown is already honoured; a sub's finish and the daemon's
//! nudge are the same shape of "act once the turn is over".

use super::finish;
use super::resume;
use super::runtime::runtime;
use crate::daemon::session::Session;
use crate::daemon::state::DaemonState;
use std::sync::Arc;

/// Called once per `result` line for every session; does nothing unless the
/// session is a sub. `turn_gen` is the gen the pump was handed for this turn.
pub fn on_turn_end(state: &Arc<DaemonState>, session: &Arc<Session>, turn_gen: u64) {
    turn_end_for(state, &session.session_id, Some(session), turn_gen);
}

/// [`on_turn_end`] with the live child optional, so tests can drive it without one.
pub(crate) fn turn_end_for(state: &Arc<DaemonState>, sub_id: &str, session: Option<&Arc<Session>>, turn_gen: u64) {
    if !state.registry.get(sub_id).is_some_and(|i| super::is_sub(&i)) {
        return;
    }
    // The stuck sweep reads this: a gen the registry holds past it is a turn
    // still open.
    runtime().note_turn_end(sub_id, turn_gen);
    if runtime().finish_pending(sub_id) {
        // Commits, or drops the request if background work started since. A
        // committed finish has stopped the process, so there is nothing to nudge.
        if finish::commit_finish(state, sub_id, session) {
            return;
        }
    }
    if runtime().take_nudge_due(sub_id) {
        let (state, sub) = (state.clone(), sub_id.to_string());
        // Detached, like `repo_channel_wake::spawn_drain`: the nudge can respawn
        // the child, and awaiting that inside the pump task is the future-size
        // cycle that function documents.
        tokio::spawn(async move {
            if let Err(e) = resume::nudge(&state, &sub, resume::NUDGE_TEXT).await {
                log::warn!("subchats: nudge for {sub} failed: {e}");
            }
        });
    }
}

/// Called when a session's process exits. A finish accepted in the turn that
/// died with the process (the `result` line did not flush) still counts.
pub fn on_process_exit(state: &Arc<DaemonState>, session: &Arc<Session>) {
    let sub_id = &session.session_id;
    if !state.registry.get(sub_id).is_some_and(|i| super::is_sub(&i)) {
        return;
    }
    if runtime().finish_pending(sub_id) && finish::commit_finish(state, sub_id, None) {
        crate::sessions::persistence::save_snapshot_default(&state.registry);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::daemon::subchats::finish::FinishRecord;
    use crate::daemon::subchats::runtime::SubStage;
    use crate::sessions::registry_turn::TurnActivity;
    use crate::types::Settings;

    fn state_with_sub(tag: &str) -> (Arc<DaemonState>, String) {
        let st = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        let (main, sub) = (format!("{tag}-main"), format!("{tag}-sub"));
        st.registry.upsert_interactive(&main, std::path::Path::new("."), "proj", "2026-11-05T00:00:00Z");
        st.registry.upsert_interactive(&sub, std::path::Path::new("."), "proj", "2026-11-05T00:00:00Z");
        st.registry.set_subchat_of(&sub, Some(main));
        (st, sub)
    }

    #[test]
    fn a_pending_finish_commits_at_turn_end_and_the_row_stays() {
        let (st, sub) = state_with_sub("te-commit");
        runtime().set_pending_finish(&sub, FinishRecord { sub_id: sub.clone(), ..FinishRecord::default() });
        turn_end_for(&st, &sub, None, 3);
        let row = st.registry.get(&sub).unwrap();
        assert!(row.subchat_finished && row.ended_at.is_none());
        assert_eq!(runtime().last_ended_gen(&sub), Some(3));
    }

    #[test]
    fn a_finish_dropped_for_background_work_leaves_the_sub_running() {
        let (st, sub) = state_with_sub("te-bg");
        runtime().set_pending_finish(&sub, FinishRecord { sub_id: sub.clone(), ..FinishRecord::default() });
        st.registry.set_turn_activity(&sub, TurnActivity::Working);
        turn_end_for(&st, &sub, None, 1);
        assert!(!st.registry.get(&sub).unwrap().subchat_finished);
    }

    #[test]
    fn a_normal_chat_turn_end_touches_nothing() {
        let st = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        st.registry.upsert_interactive("plain", std::path::Path::new("."), "proj", "2026-11-05T00:00:00Z");
        turn_end_for(&st, "plain", None, 4);
        assert_eq!(runtime().last_ended_gen("plain"), None, "no bookkeeping is created for a chat that is not a sub");
    }

    #[tokio::test]
    async fn a_due_nudge_is_taken_at_turn_end() {
        let (st, sub) = state_with_sub("te-nudge");
        runtime().set_stage(&sub, SubStage::Nudged);
        runtime().set_nudge_due(&sub);
        turn_end_for(&st, &sub, None, 2);
        assert!(!runtime().take_nudge_due(&sub), "the flag is consumed so the nudge goes out once");
    }
}
