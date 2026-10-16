use crate::daemon::session::Session;
use crate::daemon::state::DaemonState;
use std::sync::Arc;

/// True when the turn currently running was opened by the user typing `/close`.
/// Drives the daemon-authoritative `closing` row state (no text marker). The
/// actual teardown still waits for the explicit `close_session` MCP tool, so a
/// `/close --dont-close` shows "Closing" mid-run then stands back down.
pub(crate) fn turn_is_close(session: &Session) -> bool {
    session
        .last_prompt
        .lock()
        .ok()
        .map(|p| p.trim_start().starts_with("/close"))
        .unwrap_or(false)
}

/// Registry `awaiting` value for a `/close` turn that ended without ever
/// confirming via the `close_session` tool (todo 436): the model deviated
/// mid-chain rather than the tool call erroring. Reuses `awaiting` (the
/// single status source) instead of a second flag.
pub(crate) const CLOSE_FAILED_AWAITING: &str = "close_failed";

/// True when `--dont-close` appears as its own whitespace-delimited token,
/// not merely as a substring (todo 498 blind spot 4: a prompt that just
/// mentions the flag, or types `--dont-close-yet`, must not be exempted).
fn has_dont_close_arg(last_prompt: &str) -> bool {
    last_prompt.split_whitespace().any(|tok| tok == "--dont-close")
}

/// True when a `/close` turn's stand-down (closing flagged, tool never
/// confirmed) is a genuine failure rather than an intentional `--dont-close`
/// dry run. Pure so it's unit-testable without a live `Session`/`ChildStdin`
/// (mirrors `hook_session_end_should_close` in `hooks_server::lifecycle`).
pub(crate) fn close_stand_down_is_failure(last_prompt: &str, close_confirmed: bool) -> bool {
    !close_confirmed && !has_dont_close_arg(last_prompt)
}

/// EOF counterpart of `close_stand_down_is_failure`: skips the `--dont-close`
/// exemption, since a process dying mid-turn is always a failure regardless of prompt.
pub(crate) fn close_stand_down_is_failure_at_eof(close_confirmed_at_eof: bool) -> bool {
    !close_confirmed_at_eof
}

/// Daemon-authoritative `/close` teardown: mark the session ended and force the
/// `claude` process tree down. Fired when the `close_session` MCP tool's
/// `close_requested` flag is observed at turn end. Idempotent, so the
/// result-line and EOF handlers can both call it safely.
///
/// `spawn_chat`'s respawn branch reuses this exact path to tear down the
/// predecessor (it stamps `close_requested` on the caller directly, not via
/// the MCP tool), which makes this the teardown moment the held-message
/// sweep below needs: the very last point before the predecessor is gone.
pub(crate) fn finalize_close(state: &Arc<DaemonState>, session: &Session) {
    let now = chrono::Utc::now().to_rfc3339();
    if state.registry.mark_ended(&session.session_id, crate::types::EndReason::Manual, &now) {
        log::info!(
            "daemon: session {} /close confirmed via close_session tool; marked ended, killing process tree",
            session.session_id
        );
    }
    session.expected_exit.store(true, std::sync::atomic::Ordering::SeqCst);
    crate::channels::kill::kill_tree(session.pid);
    carry_held_messages_to_successor(state, &session.session_id);
}

/// Second sweep, beyond `spawn_chat`'s respawn-time
/// `DraftStore::move_held`. That move runs once, at respawn time; anything
/// staged on the predecessor afterward - a second window/phone surface still
/// following it, or an `add_held_message` round trip that resolved against
/// the old id after the move already ran - would otherwise strand there
/// until the predecessor ends. Finds the live session (if any) whose
/// `successor_of` points at the session now closing and hands its held
/// queue over at the very last moment teardown allows. A no-op for an
/// ordinary `/close` with no respawn successor.
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

    /// An ordinary `/close` (no respawn, no successor) must be an inert
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

    /// The exact todo 436 bug: a real `/close` turn ends without the
    /// `close_session` tool ever firing (model deviated, e.g. ran a
    /// terminal-kill script instead) - must be flagged as a failure.
    #[test]
    fn close_stand_down_is_failure_when_never_confirmed() {
        assert!(close_stand_down_is_failure("/close", false));
    }

    #[test]
    fn close_stand_down_not_failure_when_confirmed() {
        assert!(!close_stand_down_is_failure("/close", true));
    }

    /// `--dont-close` is an intentional dry run; standing down unconfirmed
    /// is expected there, not a failure.
    #[test]
    fn close_stand_down_not_failure_on_dont_close_flag() {
        assert!(!close_stand_down_is_failure("/close --dont-close", false));
    }

    /// The EOF branch's own logic (todo 467 blind spot 1), previously
    /// untested: a process death mid-`/close` is always a failure.
    #[test]
    fn close_stand_down_is_failure_at_eof_when_never_confirmed() {
        assert!(close_stand_down_is_failure_at_eof(false));
        assert!(!close_stand_down_is_failure_at_eof(true));
    }

    /// Unlike the result-line path, EOF grants no `--dont-close` exemption - that
    /// flag always completes normally, so reaching EOF still-closing is a genuine crash.
    #[test]
    fn eof_path_diverges_from_result_line_path_on_dont_close() {
        assert!(!close_stand_down_is_failure("/close --dont-close", false));
        assert!(close_stand_down_is_failure_at_eof(false));
    }

    /// Todo 498 blind spot 4: a genuine `--dont-close` argument still exempts.
    #[test]
    fn dont_close_word_boundary_exempts_genuine_flag() {
        assert!(!close_stand_down_is_failure("/close --dont-close", false));
        assert!(!close_stand_down_is_failure("/close --dont-close please", false));
    }

    /// A longer token that merely contains the string (a different flag name,
    /// or embedded mid-word) must NOT be exempted - only an exact
    /// whitespace-delimited token counts.
    #[test]
    fn dont_close_word_boundary_rejects_substring_mentions() {
        assert!(close_stand_down_is_failure("/close --dont-close-yet", false));
        assert!(close_stand_down_is_failure("/close xx--dont-closexx", false));
    }
}
