//! Turn-end verdict logic for `/hooks/stop`: whether report_turn_status and
//! send_message were both called this turn, and what to do about it. Split
//! out of `stop.rs` (todo 900) - this is the pure decision core; `stop.rs`
//! keeps the route handler that reads live session state and dispatches on
//! these verdicts.

/// One reason per missing combination: both checks fold into a single block
/// because `stop_hook_active` caps the retry at one block per turn.
pub(super) const REPORT_MISSING_REASON: &str = "Call the report_turn_status tool as the very last thing you do before ending your turn - required every turn, even a tool-only one with no chat reply. It requires a 'status' argument (one of done|question|waiting|working) - calling it with no arguments will fail.";
pub(super) const SEND_MISSING_REASON: &str = "Call the send_message tool before ending your turn - it is the ONLY channel Joe sees. Your assistant text and tool-call narration are not rendered in the chat at all. Send him a terse, self-contained summary of what happened this turn.";
/// todo 818: `ask_user_question` answers `{"acknowledged": true}` the instant
/// the daemon takes the card, so a card that surfaced NOWHERE looks identical
/// to a delivered one and the turn ends waiting for an answer nobody can give.
pub(super) const QUESTION_UNDELIVERED_REASON: &str = "Your ask_user_question card was accepted but never surfaced - this session is not in the app's live registry, so no window, sidebar row or phone ever showed it and no answer can ever arrive. Do NOT end the turn waiting on it: ask the same question as plain text through send_message instead, and carry on from the user's reply.";
pub(super) const BOTH_MISSING_REASON: &str = "Before ending your turn, call BOTH tools: report_turn_status (required every turn, even a tool-only one with no chat reply; it requires a 'status' argument - one of done|question|waiting|working, calling it with no arguments will fail) and send_message (the ONLY channel Joe sees - your assistant text and tool-call narration are not rendered in the chat at all; send him a terse, self-contained summary of what happened this turn).";
/// todo 824: shown instead of a block when this session's MCP transport
/// isn't attached, so report_turn_status/send_message are unreachable and
/// demanding them would be an unsatisfiable loop.
pub(super) const MCP_UNAVAILABLE_REASON: &str = "report_turn_status/send_message weren't called, but this session's MCP transport isn't attached right now, so those tools are unreachable - not blocking on it. Assistant text is a real fallback channel; use it if you need to reach Joe, and the MCP tools again once they reappear.";
/// todo 824 (remaining half): the MCP child is a fresh, HTTP-only process
/// per turn with no attach/detach event to observe, so a disconnect can only
/// be inferred from turns where neither tool call landed. One miss is
/// tolerated; two straight is treated as the transport being down.
const MCP_DISCONNECT_STREAK_THRESHOLD: u32 = 2;

/// `mcp_config_written` is the SPAWN-time proxy (still valid on its own: a
/// session whose .mcp.json write failed never had a working transport at
/// all). `miss_streak` is the live half: consecutive turns since the last
/// successful report_turn_status/send_message call.
pub(super) fn mcp_is_attached(mcp_config_written: bool, miss_streak: u32) -> bool {
    mcp_config_written && miss_streak < MCP_DISCONNECT_STREAK_THRESHOLD
}

/// Verdict from [`missing_requirement_reason`]: `Block` halts the turn end,
/// `Inform` returns a non-blocking, softened note (MCP transport down),
/// `Ok` lets the turn end silently.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum TurnEndVerdict {
    Ok,
    Block(&'static str),
    Inform(&'static str),
}

/// What [`streak_update`] says to do to `mcp_miss_streak` this turn.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum StreakUpdate {
    Reset,
    Increment,
    /// A `stop_hook_active` retry: same turn re-evaluated, not new evidence -
    /// distinct from `Reset`, which would erase a genuine increment the FIRST
    /// call on this turn already made.
    Unchanged,
}

/// Narrows the streak increment to misses that are plausibly MCP-attributable
/// (todo 824 remaining 1): a lone `Block`/`Inform` verdict looks identical to
/// a model that simply forgot both tools, so `mcp_tool_used_this_turn` (a
/// relayed MCP tool call landing at the daemon) is required as positive proof.
pub(super) fn streak_update(stop_hook_active: Option<bool>, verdict: &TurnEndVerdict, mcp_tool_used_this_turn: bool) -> StreakUpdate {
    if stop_hook_active == Some(true) {
        return StreakUpdate::Unchanged;
    }
    if mcp_tool_used_this_turn {
        return StreakUpdate::Reset;
    }
    match verdict {
        TurnEndVerdict::Ok => StreakUpdate::Reset,
        TurnEndVerdict::Block(_) | TurnEndVerdict::Inform(_) => StreakUpdate::Increment,
    }
}

/// `Some(true)` means a prior Stop already blocked this turn, so never block again.
/// Pure so it stays testable without a live Session/ChildStdin.
///
/// `status` gates the send_message half: a turn reporting `working`/`waiting`
/// is mid-chain and something will re-invoke Claude, so silence is fine there.
/// Same for `done` on a wake-opened turn (todo 607, `opened_by_wake`) - nobody
/// asked, so `done` owes only the report, not a chat message.
/// `mcp_attached` false (todo 824) degrades a missing call to `Inform`
/// instead of `Block`: the tool itself is unreachable then.
pub(super) fn missing_requirement_reason(
    stop_hook_active: Option<bool>,
    has_report: bool,
    has_send: bool,
    status: Option<&str>,
    opened_by_wake: bool,
    mcp_attached: bool,
) -> TurnEndVerdict {
    if stop_hook_active == Some(true) {
        return TurnEndVerdict::Ok;
    }
    let send_required = !opened_by_wake && !matches!(status, Some("working") | Some("waiting"));
    let missing = match (has_report, has_send || !send_required) {
        (false, false) => Some(BOTH_MISSING_REASON),
        (false, true) => Some(REPORT_MISSING_REASON),
        (true, false) => Some(SEND_MISSING_REASON),
        (true, true) => None,
    };
    match missing {
        None => TurnEndVerdict::Ok,
        Some(reason) if mcp_attached => TurnEndVerdict::Block(reason),
        Some(_) => TurnEndVerdict::Inform(MCP_UNAVAILABLE_REASON),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DONE: Option<&str> = Some("done");

    #[test]
    fn report_present_send_absent_blocks_with_send_reason() {
        assert_eq!(missing_requirement_reason(None, true, false, DONE, false, true), TurnEndVerdict::Block(SEND_MISSING_REASON));
    }

    #[test]
    fn report_absent_send_present_blocks_with_report_reason() {
        assert_eq!(missing_requirement_reason(None, false, true, DONE, false, true), TurnEndVerdict::Block(REPORT_MISSING_REASON));
    }

    #[test]
    fn both_absent_blocks_with_combined_reason() {
        assert_eq!(missing_requirement_reason(None, false, false, DONE, false, true), TurnEndVerdict::Block(BOTH_MISSING_REASON));
    }

    #[test]
    fn both_present_does_not_block() {
        assert_eq!(missing_requirement_reason(None, true, true, DONE, false, true), TurnEndVerdict::Ok);
    }

    #[test]
    fn stop_hook_active_true_never_blocks_even_with_both_missing() {
        assert_eq!(missing_requirement_reason(Some(true), false, false, DONE, false, true), TurnEndVerdict::Ok);
    }

    #[test]
    fn stop_hook_active_false_still_enforces() {
        assert_eq!(missing_requirement_reason(Some(false), false, false, DONE, false, true), TurnEndVerdict::Block(BOTH_MISSING_REASON));
    }

    #[test]
    fn mid_chain_working_turn_may_stay_silent() {
        assert_eq!(missing_requirement_reason(None, true, false, Some("working"), false, true), TurnEndVerdict::Ok);
    }

    #[test]
    fn mid_chain_waiting_turn_may_stay_silent() {
        assert_eq!(missing_requirement_reason(None, true, false, Some("waiting"), false, true), TurnEndVerdict::Ok);
    }

    #[test]
    fn a_silent_working_turn_still_owes_a_status_report() {
        assert_eq!(
            missing_requirement_reason(None, false, false, Some("working"), false, true),
            TurnEndVerdict::Block(REPORT_MISSING_REASON),
        );
    }

    #[test]
    fn question_turn_still_requires_a_message() {
        assert_eq!(
            missing_requirement_reason(None, true, false, Some("question"), false, true),
            TurnEndVerdict::Block(SEND_MISSING_REASON),
        );
    }

    #[test]
    fn unreported_status_defaults_to_requiring_a_message() {
        assert_eq!(missing_requirement_reason(None, true, false, None, false, true), TurnEndVerdict::Block(SEND_MISSING_REASON));
    }

    #[test]
    fn wake_opened_done_turn_may_stay_silent() {
        // todo 607: a peer-channel/Jarvis/scheduled wake that resolves to
        // "nothing to do" has nobody to answer - report still required, but
        // `done` no longer compels a chat message.
        assert_eq!(missing_requirement_reason(None, true, false, DONE, true, true), TurnEndVerdict::Ok);
    }

    #[test]
    fn wake_opened_turn_still_owes_a_status_report() {
        assert_eq!(
            missing_requirement_reason(None, false, false, DONE, true, true),
            TurnEndVerdict::Block(REPORT_MISSING_REASON),
        );
    }

    #[test]
    fn user_opened_done_turn_still_requires_a_message() {
        // Unchanged: opened_by_wake=false is the default path every existing
        // `DONE` test above already covers, restated here for contrast with
        // the wake-opened cases.
        assert_eq!(missing_requirement_reason(None, true, false, DONE, false, true), TurnEndVerdict::Block(SEND_MISSING_REASON));
    }

    // todo 824: MCP transport not attached degrades every would-be block to
    // a non-blocking, softened note instead.
    #[test]
    fn mcp_not_attached_informs_instead_of_blocking_on_send() {
        assert_eq!(missing_requirement_reason(None, true, false, DONE, false, false), TurnEndVerdict::Inform(MCP_UNAVAILABLE_REASON));
    }

    #[test]
    fn mcp_not_attached_informs_instead_of_blocking_on_report() {
        assert_eq!(missing_requirement_reason(None, false, true, DONE, false, false), TurnEndVerdict::Inform(MCP_UNAVAILABLE_REASON));
    }

    #[test]
    fn mcp_not_attached_informs_instead_of_blocking_on_both() {
        assert_eq!(missing_requirement_reason(None, false, false, DONE, false, false), TurnEndVerdict::Inform(MCP_UNAVAILABLE_REASON));
    }

    #[test]
    fn mcp_not_attached_still_silent_when_nothing_missing() {
        assert_eq!(missing_requirement_reason(None, true, true, DONE, false, false), TurnEndVerdict::Ok);
    }

    #[test]
    fn mcp_not_attached_stop_hook_active_still_never_blocks() {
        assert_eq!(missing_requirement_reason(Some(true), false, false, DONE, false, false), TurnEndVerdict::Ok);
    }

    // todo 824: `mcp_is_attached` combines the spawn-time proxy with the live
    // miss-streak signal - a mid-session disconnect (config written fine, but
    // report_turn_status/send_message stop landing) is the case the earlier
    // fix in this file could not see.
    #[test]
    fn never_configured_is_never_attached_even_with_no_misses_yet() {
        assert!(!mcp_is_attached(false, 0));
    }

    #[test]
    fn configured_session_tolerates_a_single_miss() {
        assert!(mcp_is_attached(true, 0));
        assert!(mcp_is_attached(true, 1));
    }

    #[test]
    fn mid_session_disconnect_degrades_after_two_straight_misses() {
        assert!(!mcp_is_attached(true, 2));
        assert!(!mcp_is_attached(true, 5));
    }

    // todo 824 remaining 1: the streak must only count misses that are
    // plausibly MCP-attributable, not any Block/Inform verdict.
    #[test]
    fn a_miss_with_no_mcp_tool_used_increments_the_streak() {
        assert_eq!(streak_update(None, &TurnEndVerdict::Block(SEND_MISSING_REASON), false), StreakUpdate::Increment);
        assert_eq!(streak_update(None, &TurnEndVerdict::Inform(MCP_UNAVAILABLE_REASON), false), StreakUpdate::Increment);
    }

    #[test]
    fn a_miss_with_an_mcp_tool_used_resets_instead_of_incrementing() {
        assert_eq!(streak_update(None, &TurnEndVerdict::Block(SEND_MISSING_REASON), true), StreakUpdate::Reset);
        assert_eq!(streak_update(None, &TurnEndVerdict::Inform(MCP_UNAVAILABLE_REASON), true), StreakUpdate::Reset);
    }

    #[test]
    fn a_clean_turn_always_resets_regardless_of_mcp_tool_use() {
        assert_eq!(streak_update(None, &TurnEndVerdict::Ok, false), StreakUpdate::Reset);
        assert_eq!(streak_update(None, &TurnEndVerdict::Ok, true), StreakUpdate::Reset);
    }

    #[test]
    fn stop_hook_active_retry_never_touches_the_streak_either_way() {
        // Even a verdict that would otherwise increment/reset must be ignored:
        // this is the SAME turn being re-evaluated, not new evidence.
        assert_eq!(streak_update(Some(true), &TurnEndVerdict::Block(SEND_MISSING_REASON), false), StreakUpdate::Unchanged);
        assert_eq!(streak_update(Some(true), &TurnEndVerdict::Ok, true), StreakUpdate::Unchanged);
    }

    /// End-to-end (todo 824 remaining 1): two straight no-tool misses still
    /// cross the threshold and flip `mcp_is_attached` to false - the existing
    /// behaviour this narrowing must not break.
    #[test]
    fn two_straight_no_tool_misses_still_flip_mcp_is_attached_to_false() {
        let mut streak = 0u32;
        for _ in 0..2 {
            let verdict = TurnEndVerdict::Block(SEND_MISSING_REASON);
            match streak_update(None, &verdict, false) {
                StreakUpdate::Increment => streak += 1,
                StreakUpdate::Reset => streak = 0,
                StreakUpdate::Unchanged => {}
            }
        }
        assert_eq!(streak, 2);
        assert!(!mcp_is_attached(true, streak));
    }

    /// A tool-using turn in between resets the count, so an MCP-healthy
    /// session that occasionally forgets one tool never crosses the threshold.
    #[test]
    fn an_mcp_tool_use_in_between_misses_prevents_crossing_the_threshold() {
        let mut streak = 0u32;
        let miss = TurnEndVerdict::Block(SEND_MISSING_REASON);
        for used in [false, true, false] {
            match streak_update(None, &miss, used) {
                StreakUpdate::Increment => streak += 1,
                StreakUpdate::Reset => streak = 0,
                StreakUpdate::Unchanged => {}
            }
        }
        assert_eq!(streak, 1);
        assert!(mcp_is_attached(true, streak));
    }
}
