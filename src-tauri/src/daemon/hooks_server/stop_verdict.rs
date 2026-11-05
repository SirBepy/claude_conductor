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
/// Status `question` means "Joe must answer something", and the only place he
/// can answer is a card. Asking in chat text leaves him reading a paragraph and
/// typing a reply the app has no row, ring or notification for.
pub(super) const QUESTION_NEEDS_CARD_REASON: &str = "You reported status 'question' but no ask_user_question card is up, so Joe has nothing to answer: your chat text is not where he answers, and he is never expected to read a message and type a reply. If you need his input, call ask_user_question now with the real question and its options, then end the turn with report_turn_status question. If you do not actually need an answer, call send_message with your summary and report_turn_status with status done instead.";
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

/// A chat's sidebar title is only the model's own when `report_turn_status`
/// carried `title`; otherwise it falls back to the first prompt cut to width.
/// Asked for once per turn end until the chat has one (it freezes after that).
pub(super) const TITLE_MISSING_REASON: &str = "This chat has no title yet. Call report_turn_status again, this time with a 'title' argument: 2-4 words naming the chat's topic, not its outcome (e.g. \"Supabase setup\"). It is shown in the sidebar and never changes after the first one.";

/// True when the turn may end but the chat still needs its title. Runs only
/// after `missing_requirement_reason` said `Ok`, so the single block that
/// `stop_hook_active` allows is not spent twice. A `working` turn is mid-chain
/// and a later turn can carry the title; a wake-opened turn has no user topic.
///
/// A title already in the `transcript` (a curated rename or an earlier AI one)
/// also satisfies it. That read is last on purpose: it opens a file, so it only
/// happens once every cheaper gate says a title is owed.
pub(super) fn title_missing(
    stop_hook_active: Option<bool>,
    has_current_report: bool,
    status: Option<&str>,
    report_title: Option<&str>,
    opened_by_wake: bool,
    mcp_attached: bool,
    transcript: &std::path::Path,
) -> bool {
    stop_hook_active != Some(true)
        && has_current_report
        && mcp_attached
        && !opened_by_wake
        && status != Some("working")
        && report_title.map_or(true, |t| t.trim().is_empty())
        && crate::tokens::curated_or_ai_title(transcript, 60).is_none()
}

/// What a sub is told when its turn ends unfinished. Only what it should act on:
/// the per-turn `report_turn_status`/`send_message` duty does not apply to a sub,
/// so this never mentions either.
pub(super) const SUB_NOT_FINISHED_REASON: &str = "You ended your turn without calling finish_subchat. If the job is done, commit your own edits and call finish_subchat now. If you need Joe, call ask_user_question. Otherwise keep working.";

pub(super) use crate::daemon::subchats::runtime::SubStage;

/// What the Stop hook does about a sub's turn end.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum SubTurnEnd {
    /// Let the turn end.
    Allow,
    /// Spend the one block `stop_hook_active` allows.
    Block(&'static str),
    /// The daemon sends one nudge once the turn is over.
    Nudge,
    /// Joe gets a card: open it, nudge again, end it.
    Card,
    /// The same card, raised without blocking the turn, because the sub has no MCP
    /// transport and so cannot finish or ask.
    CardNoTransport,
}

/// Everything the sub decision reads, gathered by `stop.rs`.
#[derive(Debug, Default, Clone, Copy)]
pub(super) struct SubTurnFacts {
    /// A `finish_subchat` call this turn was accepted, so the turn is meant to end.
    pub finishing: bool,
    /// A pending question or permission card, background work, or a pause (a
    /// freeze, a gaming-mode park, a rate limit; see `subchats::pause`): the turn
    /// ends without being unfinished business.
    pub exempt: bool,
    pub stop_hook_active: bool,
    /// The sub reported `question` but no card is up (015b8b4f's rule). It gets
    /// its own block text, since the fix is a card, not a finish.
    pub question_without_card: bool,
    /// `finish_subchat` and `ask_user_question` are reachable. When the MCP
    /// transport is down neither can be called, so there is nothing to demand.
    pub mcp_attached: bool,
}

/// The sub half of the turn-end decision, and the stage it leaves the sub in.
/// A sub ending a turn without finishing and with nothing pending is blocked
/// once, then nudged once by the daemon, then Joe gets a card (spec section 9).
/// Pure so the whole sequence is testable without a session.
///
/// `Allow` for a finishing or exempt turn resets the sequence: the sub is doing
/// something legitimate, so a later unfinished end starts from the top.
pub(super) fn sub_turn_end(stage: SubStage, f: SubTurnFacts) -> (SubStage, SubTurnEnd) {
    if f.finishing || f.exempt {
        return (SubStage::Fresh, SubTurnEnd::Allow);
    }
    // With the transport down neither `finish_subchat` nor `ask_user_question` can
    // be called, so a block or a nudge would demand what the sub cannot do. Letting
    // the turn end silently would leave Joe nothing to see, though, so he gets the
    // card at once. The stage goes to Nudged so a later unfinished end is a card
    // again, as in the normal sequence.
    if !f.mcp_attached {
        return (SubStage::Nudged, SubTurnEnd::CardNoTransport);
    }
    match stage {
        // `stop_hook_active` set on a first end means something else already
        // spent the block (the undelivered-question block), so go on to the nudge.
        SubStage::Fresh if !f.stop_hook_active => {
            let reason = if f.question_without_card { QUESTION_NEEDS_CARD_REASON } else { SUB_NOT_FINISHED_REASON };
            (SubStage::Blocked, SubTurnEnd::Block(reason))
        }
        SubStage::Fresh | SubStage::Blocked => (SubStage::Nudged, SubTurnEnd::Nudge),
        SubStage::Nudged => (SubStage::Nudged, SubTurnEnd::Card),
    }
}

/// `Some(true)` means a prior Stop already blocked this turn, so never block again.
/// Pure so it stays testable without a live Session/ChildStdin.
///
/// `status` gates the send_message half: a turn reporting `working`/`waiting`
/// is mid-chain and something will re-invoke Claude, so silence is fine there.
/// Same for `done` on a wake-opened turn (todo 607, `opened_by_wake`) - nobody
/// asked, so `done` owes only the report, not a chat message.
/// `question` is exempt too, but only when `question_card_posted` (the registry
/// saw an `ask_user_question` card this turn): the card is already the message,
/// and a bubble beside it would only point at the card. Without a card the
/// status is just the model's claim, so the turn is blocked once with
/// `QUESTION_NEEDS_CARD_REASON` (call the tool, or report done).
/// `mcp_attached` false (todo 824) degrades a missing call to `Inform`
/// instead of `Block`: the tool itself is unreachable then.
pub(super) fn missing_requirement_reason(
    stop_hook_active: Option<bool>,
    has_report: bool,
    has_send: bool,
    status: Option<&str>,
    opened_by_wake: bool,
    mcp_attached: bool,
    question_card_posted: bool,
) -> TurnEndVerdict {
    if stop_hook_active == Some(true) {
        return TurnEndVerdict::Ok;
    }
    // `question` is the model's own claim, and a question asked in plain
    // assistant text is rendered nowhere: with no card the turn cannot end on it.
    // The one block `stop_hook_active` allows is spent here, and the retry then
    // passes, where the row settles without input needed (`settled_awaiting_for`
    // drops a `question` report that no open card backs). An unattached MCP
    // transport cannot call `ask_user_question` either, so it only informs.
    if status == Some("question") && !question_card_posted {
        return if mcp_attached {
            TurnEndVerdict::Block(QUESTION_NEEDS_CARD_REASON)
        } else {
            TurnEndVerdict::Inform(MCP_UNAVAILABLE_REASON)
        };
    }
    // Past the guard above, a `question` status has its card, which is the message.
    let silent_ok = matches!(status, Some("working") | Some("waiting") | Some("question"));
    let send_required = !opened_by_wake && !silent_ok;
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

    // ── a sub's turn end ────────────────────────────────────────────────────

    fn facts() -> SubTurnFacts {
        SubTurnFacts { mcp_attached: true, ..SubTurnFacts::default() }
    }

    #[test]
    fn a_sub_is_blocked_once_then_nudged_once_then_carded() {
        let (s, a) = sub_turn_end(SubStage::Fresh, facts());
        assert_eq!((s, a), (SubStage::Blocked, SubTurnEnd::Block(SUB_NOT_FINISHED_REASON)));
        let retry = SubTurnFacts { stop_hook_active: true, ..facts() };
        assert_eq!(sub_turn_end(SubStage::Blocked, retry), (SubStage::Nudged, SubTurnEnd::Nudge));
        assert_eq!(sub_turn_end(SubStage::Nudged, facts()), (SubStage::Nudged, SubTurnEnd::Card));
        // Joe's "nudge again" leaves the stage Nudged, so the next unfinished end is a card again.
        assert_eq!(sub_turn_end(SubStage::Nudged, facts()).1, SubTurnEnd::Card);
    }

    #[test]
    fn a_first_end_that_already_has_stop_hook_active_goes_straight_to_the_nudge() {
        let f = SubTurnFacts { stop_hook_active: true, ..facts() };
        assert_eq!(sub_turn_end(SubStage::Fresh, f), (SubStage::Nudged, SubTurnEnd::Nudge));
    }

    #[test]
    fn every_exemption_allows_and_resets_whatever_the_stage() {
        for stage in [SubStage::Fresh, SubStage::Blocked, SubStage::Nudged] {
            for f in [
                SubTurnFacts { finishing: true, ..facts() },
                SubTurnFacts { exempt: true, ..facts() },
                SubTurnFacts { exempt: true, mcp_attached: false, ..facts() },
            ] {
                assert_eq!(sub_turn_end(stage, f), (SubStage::Fresh, SubTurnEnd::Allow), "{stage:?} {f:?}");
            }
        }
    }

    #[test]
    fn a_sub_with_no_mcp_transport_gets_a_card_and_is_never_blocked_or_nudged() {
        let down = SubTurnFacts { mcp_attached: false, ..facts() };
        for stage in [SubStage::Fresh, SubStage::Blocked, SubStage::Nudged] {
            assert_eq!(sub_turn_end(stage, down), (SubStage::Nudged, SubTurnEnd::CardNoTransport), "{stage:?}");
        }
        // A block text would tell a sub to call tools it cannot reach.
        let retry = SubTurnFacts { stop_hook_active: true, ..down };
        assert_eq!(sub_turn_end(SubStage::Fresh, retry).1, SubTurnEnd::CardNoTransport);
    }

    #[test]
    fn a_question_status_without_a_card_gets_the_card_text_not_the_finish_text() {
        let f = SubTurnFacts { question_without_card: true, ..facts() };
        assert_eq!(sub_turn_end(SubStage::Fresh, f).1, SubTurnEnd::Block(QUESTION_NEEDS_CARD_REASON));
    }

    #[test]
    fn report_present_send_absent_blocks_with_send_reason() {
        assert_eq!(missing_requirement_reason(None, true, false, DONE, false, true, false), TurnEndVerdict::Block(SEND_MISSING_REASON));
    }

    #[test]
    fn report_absent_send_present_blocks_with_report_reason() {
        assert_eq!(missing_requirement_reason(None, false, true, DONE, false, true, false), TurnEndVerdict::Block(REPORT_MISSING_REASON));
    }

    #[test]
    fn both_absent_blocks_with_combined_reason() {
        assert_eq!(missing_requirement_reason(None, false, false, DONE, false, true, false), TurnEndVerdict::Block(BOTH_MISSING_REASON));
    }

    #[test]
    fn both_present_does_not_block() {
        assert_eq!(missing_requirement_reason(None, true, true, DONE, false, true, false), TurnEndVerdict::Ok);
    }

    #[test]
    fn stop_hook_active_true_never_blocks_even_with_both_missing() {
        assert_eq!(missing_requirement_reason(Some(true), false, false, DONE, false, true, false), TurnEndVerdict::Ok);
    }

    #[test]
    fn stop_hook_active_false_still_enforces() {
        assert_eq!(missing_requirement_reason(Some(false), false, false, DONE, false, true, false), TurnEndVerdict::Block(BOTH_MISSING_REASON));
    }

    #[test]
    fn mid_chain_working_turn_may_stay_silent() {
        assert_eq!(missing_requirement_reason(None, true, false, Some("working"), false, true, false), TurnEndVerdict::Ok);
    }

    #[test]
    fn mid_chain_waiting_turn_may_stay_silent() {
        assert_eq!(missing_requirement_reason(None, true, false, Some("waiting"), false, true, false), TurnEndVerdict::Ok);
    }

    #[test]
    fn a_silent_working_turn_still_owes_a_status_report() {
        assert_eq!(
            missing_requirement_reason(None, false, false, Some("working"), false, true, false),
            TurnEndVerdict::Block(REPORT_MISSING_REASON),
        );
    }

    #[test]
    fn question_turn_may_stay_silent_because_the_card_is_the_message() {
        assert_eq!(missing_requirement_reason(None, true, false, Some("question"), false, true, true), TurnEndVerdict::Ok);
    }

    /// The model's own `question` status is not proof of a card: asking in
    /// plain assistant text renders nowhere, so the turn is blocked once and
    /// told to call `ask_user_question`, whether or not it also sent a message.
    #[test]
    fn question_status_without_a_posted_card_is_blocked_and_told_to_ask_with_a_card() {
        for has_send in [false, true] {
            assert_eq!(
                missing_requirement_reason(None, true, has_send, Some("question"), false, true, false),
                TurnEndVerdict::Block(QUESTION_NEEDS_CARD_REASON),
                "has_send={has_send}",
            );
        }
        // A wake-opened turn has nobody to answer unless a card is up, so the
        // message exemption does not rescue it either.
        assert_eq!(
            missing_requirement_reason(None, true, false, Some("question"), true, true, false),
            TurnEndVerdict::Block(QUESTION_NEEDS_CARD_REASON),
        );
    }

    /// A session whose MCP tools are unreachable cannot post a card, so it
    /// keeps the non-blocking note rather than an unsatisfiable loop.
    #[test]
    fn question_status_without_a_card_only_informs_when_mcp_is_not_attached() {
        assert_eq!(
            missing_requirement_reason(None, true, false, Some("question"), false, false, false),
            TurnEndVerdict::Inform(MCP_UNAVAILABLE_REASON),
        );
    }

    /// A chat that already sent its message and then reports done after the
    /// block is the exit the reason offers: it must pass on the retry.
    #[test]
    fn done_after_the_question_block_passes() {
        assert_eq!(missing_requirement_reason(Some(true), true, true, DONE, false, true, false), TurnEndVerdict::Ok);
    }

    #[test]
    fn question_status_without_a_card_is_not_blocked_on_the_stop_hook_retry() {
        assert_eq!(missing_requirement_reason(Some(true), true, false, Some("question"), false, true, false), TurnEndVerdict::Ok);
    }

    #[test]
    fn a_silent_question_turn_still_owes_a_status_report() {
        assert_eq!(
            missing_requirement_reason(None, false, false, Some("question"), false, true, true),
            TurnEndVerdict::Block(REPORT_MISSING_REASON),
        );
    }

    #[test]
    fn unreported_status_defaults_to_requiring_a_message() {
        assert_eq!(missing_requirement_reason(None, true, false, None, false, true, false), TurnEndVerdict::Block(SEND_MISSING_REASON));
    }

    #[test]
    fn wake_opened_done_turn_may_stay_silent() {
        // todo 607: a peer-channel/Jarvis/scheduled wake that resolves to
        // "nothing to do" has nobody to answer - report still required, but
        // `done` no longer compels a chat message.
        assert_eq!(missing_requirement_reason(None, true, false, DONE, true, true, false), TurnEndVerdict::Ok);
    }

    #[test]
    fn wake_opened_turn_still_owes_a_status_report() {
        assert_eq!(
            missing_requirement_reason(None, false, false, DONE, true, true, false),
            TurnEndVerdict::Block(REPORT_MISSING_REASON),
        );
    }

    #[test]
    fn user_opened_done_turn_still_requires_a_message() {
        // Unchanged: opened_by_wake=false is the default path every existing
        // `DONE` test above already covers, restated here for contrast with
        // the wake-opened cases.
        assert_eq!(missing_requirement_reason(None, true, false, DONE, false, true, false), TurnEndVerdict::Block(SEND_MISSING_REASON));
    }

    /// A transcript line list written to a temp file; `title_missing` reads it
    /// only once every cheaper gate passes.
    fn transcript(lines: &[&str]) -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.jsonl");
        std::fs::write(&path, lines.join("\n")).unwrap();
        (dir, path)
    }

    const FIRST_PROMPT: &str = r#"{"type":"user","message":{"role":"user","content":"just chatting"}}"#;

    #[test]
    fn title_is_demanded_once_a_titleless_chat_reports_without_one() {
        // A bare first prompt is not a title, so the transcript does not satisfy the gate.
        let (_dir, tp) = transcript(&[FIRST_PROMPT]);
        assert!(title_missing(None, true, DONE, None, false, true, &tp));
        assert!(title_missing(None, true, DONE, Some("  "), false, true, &tp));
        // An unreadable transcript counts as titleless rather than silencing the gate.
        assert!(title_missing(None, true, DONE, None, false, true, std::path::Path::new("no/such/transcript.jsonl")));
    }

    #[test]
    fn title_not_demanded_when_supplied_or_unenforceable() {
        let (_dir, tp) = transcript(&[FIRST_PROMPT]);
        assert!(!title_missing(None, true, DONE, Some("Auth setup"), false, true, &tp));
        assert!(!title_missing(Some(true), true, DONE, None, false, true, &tp));
        assert!(!title_missing(None, true, Some("working"), None, false, true, &tp));
        assert!(!title_missing(None, true, DONE, None, true, true, &tp));
        assert!(!title_missing(None, true, DONE, None, false, false, &tp));
        assert!(!title_missing(None, false, DONE, None, false, true, &tp));
    }

    #[test]
    fn title_not_demanded_when_the_transcript_already_holds_one() {
        let ai = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"<cc-title:Auth setup>"}]}}"#;
        let (_d1, ai_tp) = transcript(&[FIRST_PROMPT, ai]);
        assert!(!title_missing(None, true, DONE, None, false, true, &ai_tp));

        let renamed = r#"{"type":"custom-title","customTitle":"Human Named It"}"#;
        let (_d2, renamed_tp) = transcript(&[FIRST_PROMPT, renamed]);
        assert!(!title_missing(None, true, DONE, None, false, true, &renamed_tp));
    }

    // todo 824: MCP transport not attached degrades every would-be block to
    // a non-blocking, softened note instead.
    #[test]
    fn mcp_not_attached_informs_instead_of_blocking_on_send() {
        assert_eq!(missing_requirement_reason(None, true, false, DONE, false, false, false), TurnEndVerdict::Inform(MCP_UNAVAILABLE_REASON));
    }

    #[test]
    fn mcp_not_attached_informs_instead_of_blocking_on_report() {
        assert_eq!(missing_requirement_reason(None, false, true, DONE, false, false, false), TurnEndVerdict::Inform(MCP_UNAVAILABLE_REASON));
    }

    #[test]
    fn mcp_not_attached_informs_instead_of_blocking_on_both() {
        assert_eq!(missing_requirement_reason(None, false, false, DONE, false, false, false), TurnEndVerdict::Inform(MCP_UNAVAILABLE_REASON));
    }

    #[test]
    fn mcp_not_attached_still_silent_when_nothing_missing() {
        assert_eq!(missing_requirement_reason(None, true, true, DONE, false, false, false), TurnEndVerdict::Ok);
    }

    #[test]
    fn mcp_not_attached_stop_hook_active_still_never_blocks() {
        assert_eq!(missing_requirement_reason(Some(true), false, false, DONE, false, false, false), TurnEndVerdict::Ok);
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
