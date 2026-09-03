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
}

#[cfg(test)]
mod tests {
    use super::*;

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
