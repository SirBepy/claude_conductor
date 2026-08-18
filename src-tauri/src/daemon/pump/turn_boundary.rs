//! Where a turn starts and stops, decided from stdout alone. `stream_event` is
//! the discriminator: claude emits it only while generating, never when
//! replaying history. Session e51363b9 spent 13 minutes working while its row
//! said Done, because a replayed `result` line read as "turn over".

/// What a stdout line means for the session's `busy`/`awaiting` state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TurnAction {
    /// Already inside a live turn - the caller has nothing to apply.
    None,
    /// A real turn just started: mark busy, drop the previous turn's status.
    TurnStarted,
    /// A real turn just ended: apply its reported status, clear busy.
    TurnEnded,
    /// A `--resume` replay's result line. Bookkeeping only; it must NOT touch
    /// busy or awaiting, because it lands inside the SAME `turn_gen` as the
    /// live turn the user just started, where the gen guard can't see it.
    ReplayedResult,
}

pub(crate) struct TurnBoundary {
    live: bool,
    replaying: bool,
}

impl TurnBoundary {
    /// Only a `--resume` child has a replay window. Outside it an eventless
    /// result really is a turn ending - todo 525's immediate CLI-side
    /// rejection never streams anything either.
    pub(crate) fn new(resumed: bool) -> Self {
        Self { live: false, replaying: resumed }
    }

    /// Call on the turn's first `stream_event` line.
    pub(crate) fn on_stream_event(&mut self) -> TurnAction {
        if self.live {
            return TurnAction::None;
        }
        self.live = true;
        self.replaying = false;
        TurnAction::TurnStarted
    }

    /// Call on every `result` line. Resets liveness so each turn is judged on
    /// its own, matching the per-turn `stream_event` signal.
    pub(crate) fn on_result_line(&mut self) -> TurnAction {
        if std::mem::replace(&mut self.live, false) {
            TurnAction::TurnEnded
        } else if self.replaying {
            TurnAction::ReplayedResult
        } else {
            TurnAction::TurnEnded
        }
    }

    pub(crate) fn is_live(&self) -> bool {
        self.live
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sessions::registry::Registry;
    use crate::types::Settings;
    use std::path::Path;
    use std::sync::Mutex;

    #[test]
    fn first_stream_event_starts_a_turn_and_later_ones_are_noops() {
        let mut turn = TurnBoundary::new(false);
        assert_eq!(turn.on_stream_event(), TurnAction::TurnStarted);
        assert_eq!(turn.on_stream_event(), TurnAction::None);
        assert!(turn.is_live());
    }

    #[test]
    fn result_line_before_the_live_turn_of_a_resumed_child_is_a_replay() {
        let mut turn = TurnBoundary::new(true);
        assert_eq!(turn.on_result_line(), TurnAction::ReplayedResult);
        assert!(!turn.is_live());
    }

    /// todo 525 root cause 2: a turn that dies before streaming anything (an
    /// immediate CLI-side rejection, e.g. rate limit) still ends the turn, so
    /// the replay guard must not swallow it on a non-resumed child.
    #[test]
    fn eventless_result_ends_the_turn_when_nothing_was_replayed() {
        let mut turn = TurnBoundary::new(false);
        assert_eq!(turn.on_result_line(), TurnAction::TurnEnded);
    }

    /// Same rejection, but on a child that HAD a replay window: once the live
    /// turn streamed once, the window is shut for the rest of the process.
    #[test]
    fn replay_window_shuts_permanently_at_the_first_stream_event() {
        let mut turn = TurnBoundary::new(true);
        assert_eq!(turn.on_result_line(), TurnAction::ReplayedResult);
        turn.on_stream_event();
        turn.on_result_line();
        assert_eq!(
            turn.on_result_line(),
            TurnAction::TurnEnded,
            "a later eventless turn must not be mistaken for the opening replay"
        );
    }

    #[test]
    fn each_turn_is_judged_independently() {
        let mut turn = TurnBoundary::new(true);
        turn.on_stream_event();
        assert_eq!(turn.on_result_line(), TurnAction::TurnEnded);
        assert_eq!(turn.on_stream_event(), TurnAction::TurnStarted, "a new turn can start again");
        assert_eq!(turn.on_result_line(), TurnAction::TurnEnded);
    }

    /// A `--resume` respawn may replay more than one prior result line before
    /// the live turn starts; none of them may end it.
    #[test]
    fn a_whole_replayed_transcript_never_ends_a_turn() {
        let mut turn = TurnBoundary::new(true);
        for _ in 0..5 {
            assert_eq!(turn.on_result_line(), TurnAction::ReplayedResult);
        }
        assert_eq!(turn.on_stream_event(), TurnAction::TurnStarted);
        assert_eq!(turn.on_result_line(), TurnAction::TurnEnded);
    }

    fn registry_with_session() -> Registry {
        let registry = Registry::new();
        let settings = Mutex::new(Settings::default());
        registry.record_interactive_session("s", Path::new("/tmp/x"), &settings, "2026-08-18T10:15:12Z");
        registry
    }

    /// The chat-20176 regression, replayed against a real Registry: the exact
    /// daemon.log sequence from 2026-08-18T10:15:12Z, which rendered Done for
    /// 13 minutes. Every assert here fails if the pump applies a
    /// `ReplayedResult` the way it used to.
    #[test]
    fn resume_replay_cannot_end_the_live_turn_it_arrived_in() {
        let registry = registry_with_session();
        let mut turn = TurnBoundary::new(true);

        // send_message: awaiting cleared, busy=true, turn_gen 0 -> 1.
        registry.set_awaiting("s", None);
        registry.set_busy("s", true);
        let pump_gen = registry.current_turn_gen("s");
        assert_eq!(pump_gen, 1);

        // claude --resume replays the PREVIOUS turn's result line first.
        assert_eq!(turn.on_result_line(), TurnAction::ReplayedResult);
        assert!(
            registry.get("s").unwrap().busy,
            "the replayed line must not clear the live turn's busy"
        );

        // The real turn starts 1s later.
        assert_eq!(turn.on_stream_event(), TurnAction::TurnStarted);
        registry.mark_turn_live("s");
        let i = registry.get("s").unwrap();
        assert!(i.busy);
        assert_eq!(
            i.turn_gen, pump_gen,
            "turn start must not bump the gen the pump already captured"
        );

        // 13 minutes later the real turn ends and reports its status.
        assert_eq!(turn.on_result_line(), TurnAction::TurnEnded);
        assert!(registry.set_awaiting_if_gen("s", Some("working".into()), pump_gen));
        assert!(registry.set_busy_false_if_gen("s", pump_gen));
        let i = registry.get("s").unwrap();
        assert!(!i.busy);
        assert_eq!(i.awaiting.as_deref(), Some("working"));
    }

    /// Why the action gate has to exist at all: a `--resume` replay lands in
    /// the SAME `turn_gen` as the live turn it interrupts, so the pump's
    /// stale-turn guard happily lets it through.
    #[test]
    fn the_gen_guard_alone_cannot_reject_a_replayed_result() {
        let registry = registry_with_session();
        registry.set_busy("s", true);
        let pump_gen = registry.current_turn_gen("s");
        assert!(
            registry.set_busy_false_if_gen("s", pump_gen),
            "the gen guard cannot tell a replay from a live turn - only TurnAction can"
        );
    }

    /// The other half of stream-derived busy: a turn nobody sent a message for
    /// (a background task finishing, a peer wake) still flips the row to In
    /// Progress instead of inheriting the last turn's reported status.
    #[test]
    fn self_resumed_turn_goes_busy_without_a_send_message() {
        let registry = registry_with_session();
        let mut turn = TurnBoundary::new(false);

        // Previous turn ended "done" and cleared busy.
        registry.set_awaiting("s", Some("done".into()));
        let gen_before = registry.current_turn_gen("s");

        assert_eq!(turn.on_stream_event(), TurnAction::TurnStarted);
        assert!(registry.mark_turn_live("s"));

        let i = registry.get("s").unwrap();
        assert!(i.busy, "a self-resumed turn must read as In Progress");
        assert!(i.awaiting.is_none(), "the previous turn's status must not linger");
        assert_eq!(i.turn_gen, gen_before, "no send_message means no gen bump");
    }
}
