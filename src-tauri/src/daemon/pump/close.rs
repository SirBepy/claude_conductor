use crate::daemon::session::Session;
use crate::daemon::state::DaemonState;
use std::sync::Arc;

/// Daemon-authoritative close teardown: mark the session ended and force the
/// `claude` process tree down. Fired when the `close_session` MCP tool's
/// `close_requested` flag is observed at turn end. Idempotent, so the
/// result-line and EOF handlers can both call it safely.
///
/// `spawn_chat`'s respawn branch reuses this exact path to tear down the
/// predecessor (it stamps `close_requested` on the caller directly, not via
/// the MCP tool), which makes this the teardown moment the held-message
/// sweep below needs: the very last point before the predecessor is gone.
pub(crate) fn finalize_close(state: &Arc<DaemonState>, session: &Session) {
    // The `close_session` tool already refused a chat with running subs, so this
    // is the backstop for one that gained a sub between that call and the turn
    // end. A `respawn` predecessor is not held: its subs move to the successor.
    if crate::daemon::subchats::closing::request_close(state, &session.session_id) {
        log::info!("daemon: session {} close held, it has running subs; Joe was asked", session.session_id);
        return;
    }
    let now = chrono::Utc::now().to_rfc3339();
    if state.registry.mark_ended(&session.session_id, crate::types::EndReason::Manual, &now) {
        log::info!(
            "daemon: session {} close confirmed via close_session tool; marked ended, killing process tree",
            session.session_id
        );
    }
    session.expected_exit.store(true, std::sync::atomic::Ordering::SeqCst);
    crate::util::kill::kill_tree(session.pid);
    carry_held_messages_to_successor(state, &session.session_id);
    // Its finished subs close with it, and a respawn's subs follow the successor.
    // Detached: this runs inside the pump's result handler.
    if let Ok(handle) = tokio::runtime::Handle::try_current() {
        let (state, parent) = (state.clone(), session.session_id.clone());
        handle.spawn(async move { crate::daemon::subchats::closing::settle_family(&state, &parent).await });
    }
}

/// Second sweep, beyond `spawn_chat`'s respawn-time
/// `DraftStore::move_held`. That move runs once, at respawn time; anything
/// staged on the predecessor afterward - a second window/phone surface still
/// following it, or an `add_held_message` round trip that resolved against
/// the old id after the move already ran - would otherwise strand there
/// until the predecessor ends. Finds the live session (if any) whose
/// `successor_of` points at the session now closing and hands its held
/// queue over at the very last moment teardown allows. A no-op for an
/// ordinary close with no respawn successor.
fn carry_held_messages_to_successor(state: &Arc<DaemonState>, closing_session_id: &str) {
    let successor_id = state
        .registry
        .list()
        .into_iter()
        .find(|i| i.successor_of.as_deref() == Some(closing_session_id) && i.end_reason.is_none())
        .map(|i| i.session_id);
    let Some(successor_id) = successor_id else { return };
    if state.draft_store.move_held(closing_session_id, &successor_id) > 0 {
        crate::daemon::methods::drafts::sync_held_count(state, closing_session_id);
        crate::daemon::methods::drafts::sync_held_count(state, &successor_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::daemon::state::DaemonState;
    use crate::types::{ContentBlock, Settings};
    use std::sync::Mutex as StdMutex;

    fn state_with_sessions(ids: &[&str]) -> Arc<DaemonState> {
        let st = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        let settings = StdMutex::new(Settings::default());
        for id in ids {
            st.registry.record_interactive_session(
                id,
                std::path::Path::new("/tmp/x"),
                &settings,
                "2026-10-16T00:00:00Z",
            );
        }
        st
    }

    fn held_texts(st: &Arc<DaemonState>, sid: &str) -> Vec<String> {
        st.draft_store
            .get(sid)
            .held
            .iter()
            .map(|i| match i.blocks.first() {
                Some(ContentBlock::Text { text }) => text.clone(),
                _ => String::new(),
            })
            .collect()
    }

    /// The exact gap: `spawn_chat`'s respawn-time `move_held` already
    /// ran (mirrored here by moving "queued at respawn" over by hand), then a
    /// second message gets staged on the predecessor - a surface that hadn't
    /// followed the successor yet. Before the teardown sweep, that message
    /// is still filed under "old" even though "old" is about to disappear.
    #[test]
    fn message_staged_on_predecessor_after_respawn_move_strands_without_the_sweep() {
        let st = state_with_sessions(&["old", "new"]);
        st.registry.set_successor_of("new", "old");
        // The respawn-time move (01e613c7) already ran and emptied "old".
        st.draft_store.add_held("new", vec![ContentBlock::Text { text: "queued at respawn".into() }]);
        // A late add lands on "old" in the follow window - before the sweep
        // runs, it is NOT yet visible on "new".
        st.draft_store.add_held("old", vec![ContentBlock::Text { text: "staged late".into() }]);
        assert_eq!(
            held_texts(&st, "new"),
            ["queued at respawn"],
            "gap reproduced: the late add has not reached the successor yet"
        );
    }

    /// Same setup, but drives it through the real teardown path: the sweep
    /// inside `finalize_close` must carry the late add over before "old" is
    /// gone for good.
    #[test]
    fn teardown_sweep_carries_a_late_held_message_to_the_successor() {
        let st = state_with_sessions(&["old", "new"]);
        st.registry.set_successor_of("new", "old");
        st.draft_store.add_held("new", vec![ContentBlock::Text { text: "queued at respawn".into() }]);
        st.draft_store.add_held("old", vec![ContentBlock::Text { text: "staged late".into() }]);

        carry_held_messages_to_successor(&st, "old");

        assert!(st.draft_store.get("old").held.is_empty(), "nothing must be left stranded on the predecessor");
        assert_eq!(held_texts(&st, "new"), ["queued at respawn", "staged late"]);
        assert_eq!(st.registry.get("new").unwrap().held_count, 2, "sidebar chip must reflect the carried-over item");
        assert_eq!(st.registry.get("old").unwrap().held_count, 0);
    }

    /// An ordinary close (no respawn, no successor) must be an inert
    /// no-op: nothing to find, nothing to move.
    #[test]
    fn sweep_is_a_noop_when_no_successor_exists() {
        let st = state_with_sessions(&["solo"]);
        st.draft_store.add_held("solo", vec![ContentBlock::Text { text: "never queued for anyone".into() }]);
        carry_held_messages_to_successor(&st, "solo");
        assert_eq!(held_texts(&st, "solo"), ["never queued for anyone"], "nothing to carry, nothing changes");
    }

    /// A successor that has itself already ended (e.g. a chained respawn)
    /// must not receive a carry - `end_reason.is_none()` is the liveness
    /// filter, mirroring the live-session guard `move_held`'s caller already
    /// relies on at respawn time.
    #[test]
    fn sweep_skips_a_successor_that_has_already_ended() {
        let st = state_with_sessions(&["old", "new"]);
        st.registry.set_successor_of("new", "old");
        st.registry.mark_ended("new", crate::types::EndReason::Manual, "2026-10-16T00:00:01Z");
        st.draft_store.add_held("old", vec![ContentBlock::Text { text: "staged late".into() }]);
        carry_held_messages_to_successor(&st, "old");
        assert_eq!(held_texts(&st, "old"), ["staged late"], "an ended successor must not receive the carry");
    }
}
