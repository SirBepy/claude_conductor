use super::registry::Registry;

/// What the CLI's own Stop payload says the session is still doing, used to
/// correct a turn that self-reported `done`. Derived in
/// `daemon::hooks_server::activity` from `background_tasks` + `session_crons`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum TurnActivity {
    #[default]
    Idle,
    /// Local compute still running - a build, a subagent fan-out.
    Working,
    /// Parked on a poller alive on THIS machine. Sleeping kills the poll, so
    /// it reads as `waiting` in the UI but still holds the machine awake.
    WaitingOnProcess,
    /// Parked on a daemon-owned scheduled wake. Nothing local to lose.
    WaitingOnSchedule,
}

impl TurnActivity {
    /// True when a process on this machine dies if the machine sleeps - the
    /// question `/sleep-when-done` actually needs answered, which the
    /// `awaiting` string alone cannot ("waiting" covers both kinds).
    pub fn holds_local_process(self) -> bool {
        matches!(self, TurnActivity::Working | TurnActivity::WaitingOnProcess)
    }

    /// Correct a self-report against what the CLI actually still has live.
    /// Only `done` or a missing report is corrected - a deliberate
    /// `question`/`waiting`/`working` is the model's call and stands.
    pub fn correct(self, reported: Option<String>) -> Option<String> {
        if !matches!(reported.as_deref(), None | Some("done")) {
            return reported;
        }
        match self {
            TurnActivity::Working => Some("working".to_string()),
            TurnActivity::WaitingOnProcess | TurnActivity::WaitingOnSchedule => {
                Some("waiting".to_string())
            }
            TurnActivity::Idle => reported,
        }
    }
}

/// See `Registry::question_posted`.
#[derive(Clone, Copy, Debug)]
pub struct QuestionPost {
    pub turn_gen: u64,
    pub surfaced: bool,
}

/// See `Registry::reported_status`.
#[derive(Clone, Debug)]
pub struct ReportedStatus {
    pub turn_gen: u64,
    pub status: String,
    pub title: Option<String>,
    /// Client-declared waiting target (todo 675): `{label, kind, href}`.
    /// Already passed through `mcp::server::waiting_target::sanitize` at MCP
    /// ingest before it ever reaches here, so `href` is either a validated
    /// http(s) URL / in-tree local path or `null` - never a raw client value.
    pub waiting_on: Option<serde_json::Value>,
}

impl Registry {
    /// Record that the `/close` skill confirmed teardown for this session (the
    /// `close_session` MCP tool fired). The pump consumes it at turn end.
    pub fn set_close_requested(&self, session_id: &str) {
        self.close_requested.lock().unwrap().insert(session_id.to_string());
    }

    /// Consume the close-confirmed flag: returns true once, then clears it, so
    /// a stale flag can never re-tear-down a resumed session on a later turn.
    pub fn take_close_requested(&self, session_id: &str) -> bool {
        self.close_requested.lock().unwrap().remove(session_id)
    }

    /// Record this turn's self-reported status, stamped with the CURRENT
    /// `turn_gen` so a later consumer can spot a stale report.
    pub fn set_reported_status(
        &self,
        session_id: &str,
        turn_gen: u64,
        status: String,
        title: Option<String>,
        waiting_on: Option<serde_json::Value>,
    ) {
        self.reported_status
            .lock()
            .unwrap()
            .insert(session_id.to_string(), ReportedStatus { turn_gen, status, title, waiting_on });
    }

    /// Peek without consuming - the Stop hook fires before the pump's
    /// result-line handler, which is the one that `take`s it.
    pub fn peek_reported_status(&self, session_id: &str) -> Option<ReportedStatus> {
        self.reported_status.lock().unwrap().get(session_id).cloned()
    }

    /// Consume: always removes the entry, but only returns it on a gen
    /// match - mirrors `set_awaiting_if_gen`'s stale-turn guard.
    pub fn take_reported_status_if_gen(&self, session_id: &str, gen: u64) -> Option<ReportedStatus> {
        // Runs after the Stop hook has read them, so this is also where the
        // per-turn side maps self-clean instead of growing per session forever.
        self.message_sent_gen.lock().unwrap().remove(session_id);
        self.question_posted.lock().unwrap().remove(session_id);
        let entry = self.reported_status.lock().unwrap().remove(session_id)?;
        if entry.turn_gen == gen {
            Some(entry)
        } else {
            // Mirrors `set_busy_false_if_gen`'s warning (registry_flags.rs:196-200):
            // a newer turn bumped turn_gen before this turn's result line was consumed.
            log::warn!(
                "registry: reported_status DISCARDED for {session_id}: pump gen {gen} != entry gen {} (newer turn started)",
                entry.turn_gen
            );
            None
        }
    }

    /// Record that `send_message` succeeded for this session during
    /// `turn_gen`. Mirrors `set_reported_status`'s gen-stamped storage.
    pub fn mark_message_sent(&self, session_id: &str, turn_gen: u64) {
        self.message_sent_gen.lock().unwrap().insert(session_id.to_string(), turn_gen);
    }

    pub fn peek_message_sent_gen(&self, session_id: &str) -> Option<u64> {
        self.message_sent_gen.lock().unwrap().get(session_id).copied()
    }

    /// Record that a `cc_conductor` MCP tool call landed at the daemon during
    /// `turn_gen` (todo 824 remaining 1) - any tool, not just
    /// report_turn_status/send_message, since the point is transport liveness.
    pub fn mark_mcp_tool_used(&self, session_id: &str, turn_gen: u64) {
        self.mcp_tool_used_gen.lock().unwrap().insert(session_id.to_string(), turn_gen);
    }

    pub fn peek_mcp_tool_used_gen(&self, session_id: &str) -> Option<u64> {
        self.mcp_tool_used_gen.lock().unwrap().get(session_id).copied()
    }

    /// Record the outcome of an `ask_user_question` post for this turn.
    /// `surfaced` is whether the session was actually flipped to "awaiting a
    /// question" - false means no window, sidebar row or phone will ever show
    /// the card, so nobody can answer it.
    pub fn mark_question_posted(&self, session_id: &str, turn_gen: u64, surfaced: bool) {
        self.question_posted
            .lock()
            .unwrap()
            .insert(session_id.to_string(), QuestionPost { turn_gen, surfaced });
    }

    /// True when this turn posted a question that never surfaced anywhere.
    /// A post from an earlier turn is ignored: it either got answered or is
    /// still legitimately open.
    pub fn question_undelivered_this_turn(&self, session_id: &str, turn_gen: u64) -> bool {
        self.question_posted
            .lock()
            .unwrap()
            .get(session_id)
            .map(|p| p.turn_gen == turn_gen && !p.surfaced)
            .unwrap_or(false)
    }

    /// Record what the Stop hook says this session is still doing. `Idle`
    /// removes the entry so a stale verdict can't outlive the turn. Also
    /// mirrors the sleep-safety half onto `Instance` - `when_done` only ever
    /// sees `Instance`, never this side map.
    pub fn set_turn_activity(&self, session_id: &str, activity: TurnActivity) {
        {
            let mut guard = self.turn_activity.lock().unwrap();
            if activity == TurnActivity::Idle {
                guard.remove(session_id);
            } else {
                guard.insert(session_id.to_string(), activity);
            }
        }
        let mut inner = self.inner.lock().unwrap();
        if let Some(i) = inner.get_mut(session_id) {
            i.local_task_running = activity.holds_local_process();
        }
    }

    /// Activity from the session's most recent Stop hook; `Idle` if it never
    /// reported.
    pub fn turn_activity(&self, session_id: &str) -> TurnActivity {
        self.turn_activity.lock().unwrap().get(session_id).copied().unwrap_or_default()
    }

    /// Record that `turn_gen` was opened by a daemon wake, not a user message.
    /// Pass the gen AFTER `set_busy(session_id, true)`, which bumps it.
    pub fn set_turn_opened_by_wake(&self, session_id: &str, turn_gen: u64) {
        self.turn_opened_by_wake.lock().unwrap().insert(session_id.to_string(), turn_gen);
    }

    /// Marks a session busy for a wake-triggered turn (jarvis/repo-channel/
    /// schedule) and stamps the wake flag to the gen `set_busy` lands on.
    /// LOAD-BEARING ORDER: `set_busy` must run first - it's what bumps
    /// `turn_gen`, so reading the gen before it would key the flag stale.
    pub fn set_busy_from_wake(&self, session_id: &str) {
        self.set_busy(session_id, true);
        let gen = self.current_turn_gen(session_id);
        self.set_turn_opened_by_wake(session_id, gen);
    }

    /// Gen-checked peek, no `take`: a stale entry is harmless since a later
    /// turn's gen won't match it.
    pub fn is_turn_opened_by_wake(&self, session_id: &str, gen: u64) -> bool {
        self.turn_opened_by_wake.lock().unwrap().get(session_id).copied() == Some(gen)
    }

    /// Record one more builtin `AskUserQuestion` PreToolUse attempt for this
    /// session and return the new count. See `Registry::builtin_ask_attempts`.
    pub fn record_builtin_ask_attempt(&self, session_id: &str) -> u32 {
        let mut guard = self.builtin_ask_attempts.lock().unwrap();
        let count = guard.entry(session_id.to_string()).or_insert(0);
        *count += 1;
        *count
    }

    /// Clear the builtin-ask attempt budget, e.g. on turn-end expiry.
    pub fn reset_builtin_ask_attempts(&self, session_id: &str) {
        self.builtin_ask_attempts.lock().unwrap().remove(session_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn corrected(activity: TurnActivity, reported: Option<&str>) -> Option<String> {
        activity.correct(reported.map(str::to_string))
    }

    #[test]
    fn a_done_report_is_corrected_to_what_the_cli_still_has_live() {
        assert_eq!(corrected(TurnActivity::Working, Some("done")).as_deref(), Some("working"));
        assert_eq!(corrected(TurnActivity::WaitingOnProcess, Some("done")).as_deref(), Some("waiting"));
    }

    /// The defect this fixes: a chat parked on `gh run watch` used to be forced
    /// to "working" by the old count-only override.
    #[test]
    fn a_missing_report_is_corrected_too() {
        assert_eq!(corrected(TurnActivity::WaitingOnSchedule, None).as_deref(), Some("waiting"));
        assert_eq!(corrected(TurnActivity::Working, None).as_deref(), Some("working"));
    }

    #[test]
    fn a_deliberate_report_is_never_overridden() {
        for reported in ["question", "waiting", "working", "close_failed"] {
            assert_eq!(
                corrected(TurnActivity::Working, Some(reported)).as_deref(),
                Some(reported),
                "{reported} is the model's call"
            );
        }
    }

    #[test]
    fn idle_activity_leaves_the_report_alone() {
        assert_eq!(corrected(TurnActivity::Idle, Some("done")).as_deref(), Some("done"));
        assert_eq!(corrected(TurnActivity::Idle, None), None);
    }

    /// Only the two kinds that leave a process alive on this machine hold it
    /// awake - a scheduled wake does not.
    #[test]
    fn holds_local_process_separates_the_two_waiting_kinds() {
        assert!(TurnActivity::Working.holds_local_process());
        assert!(TurnActivity::WaitingOnProcess.holds_local_process());
        assert!(!TurnActivity::WaitingOnSchedule.holds_local_process());
        assert!(!TurnActivity::Idle.holds_local_process());
    }

    #[test]
    fn both_waiting_kinds_still_read_as_waiting_in_the_ui() {
        assert_eq!(corrected(TurnActivity::WaitingOnSchedule, Some("done")).as_deref(), Some("waiting"));
        assert_eq!(corrected(TurnActivity::WaitingOnProcess, Some("done")).as_deref(), Some("waiting"));
    }

    #[test]
    fn set_turn_activity_mirrors_sleep_safety_onto_the_instance() {
        let registry = Registry::new();
        let settings = std::sync::Mutex::new(crate::types::Settings::default());
        registry.record_interactive_session("s", std::path::Path::new("/tmp/x"), &settings, "2026-08-18T00:00:00Z");

        registry.set_turn_activity("s", TurnActivity::WaitingOnProcess);
        assert!(registry.get("s").unwrap().local_task_running, "a live poller holds the machine awake");

        registry.set_turn_activity("s", TurnActivity::WaitingOnSchedule);
        assert!(!registry.get("s").unwrap().local_task_running, "a scheduled wake does not");

        registry.set_turn_activity("s", TurnActivity::Idle);
        assert!(!registry.get("s").unwrap().local_task_running);
    }

    #[test]
    fn turn_activity_roundtrip_and_idle_clears() {
        let registry = Registry::new();
        assert_eq!(registry.turn_activity("s"), TurnActivity::Idle);
        registry.set_turn_activity("s", TurnActivity::Working);
        assert_eq!(registry.turn_activity("s"), TurnActivity::Working);
        registry.set_turn_activity("s", TurnActivity::WaitingOnProcess);
        assert_eq!(registry.turn_activity("s"), TurnActivity::WaitingOnProcess);
        registry.set_turn_activity("s", TurnActivity::Idle);
        assert_eq!(registry.turn_activity("s"), TurnActivity::Idle);
    }

    #[test]
    fn reported_status_peek_then_take_roundtrip() {
        let registry = Registry::new();
        registry.set_reported_status("s", 1, "done".into(), Some("Fix login bug".into()), None);
        let peeked = registry.peek_reported_status("s").unwrap();
        assert_eq!(peeked.status, "done");
        assert_eq!(peeked.title.as_deref(), Some("Fix login bug"));
        let taken = registry.take_reported_status_if_gen("s", 1).unwrap();
        assert_eq!(taken.status, "done");
        assert!(registry.peek_reported_status("s").is_none(), "take must consume the entry");
    }

    /// todo 818: only an unsurfaced post from THIS turn blocks the Stop hook.
    #[test]
    fn question_undelivered_only_fires_for_an_unsurfaced_post_this_turn() {
        let registry = Registry::new();
        assert!(!registry.question_undelivered_this_turn("s", 1), "no post at all");
        registry.mark_question_posted("s", 1, true);
        assert!(!registry.question_undelivered_this_turn("s", 1), "surfaced post is fine");
        registry.mark_question_posted("s", 1, false);
        assert!(registry.question_undelivered_this_turn("s", 1));
        assert!(!registry.question_undelivered_this_turn("s", 2), "stale gen must not block");
    }

    #[test]
    fn question_post_is_consumed_with_the_turn() {
        let registry = Registry::new();
        registry.set_reported_status("s", 1, "question".into(), None, None);
        registry.mark_question_posted("s", 1, false);
        registry.take_reported_status_if_gen("s", 1);
        assert!(!registry.question_undelivered_this_turn("s", 1), "must not outlive its turn");
    }

    #[test]
    fn reported_status_take_rejects_stale_gen_but_still_consumes() {
        let registry = Registry::new();
        registry.set_reported_status("s", 1, "done".into(), None, None);
        assert!(registry.take_reported_status_if_gen("s", 2).is_none(), "stale gen must not apply");
        assert!(registry.peek_reported_status("s").is_none(), "must consume even on mismatch");
    }

    /// todo 675: a guard-sanitized waiting target round-trips through the
    /// same peek/take path as status/title, byte-identical.
    #[test]
    fn reported_status_carries_a_waiting_on_target_through_roundtrip() {
        let registry = Registry::new();
        let target = serde_json::json!({"label": "release CI", "kind": "ci", "href": "https://x/actions/runs/1"});
        registry.set_reported_status("s", 1, "waiting".into(), None, Some(target.clone()));
        assert_eq!(registry.peek_reported_status("s").unwrap().waiting_on, Some(target.clone()));
        assert_eq!(registry.take_reported_status_if_gen("s", 1).unwrap().waiting_on, Some(target));
    }

    #[test]
    fn reported_status_without_a_waiting_on_target_stays_none() {
        let registry = Registry::new();
        registry.set_reported_status("s", 1, "done".into(), None, None);
        assert_eq!(registry.peek_reported_status("s").unwrap().waiting_on, None);
    }

    #[test]
    fn reported_status_unknown_session_peek_and_take_are_none() {
        let registry = Registry::new();
        assert!(registry.peek_reported_status("ghost").is_none());
        assert!(registry.take_reported_status_if_gen("ghost", 0).is_none());
    }

    #[test]
    fn message_sent_gen_peek_roundtrip() {
        let registry = Registry::new();
        assert!(registry.peek_message_sent_gen("s").is_none());
        registry.mark_message_sent("s", 1);
        assert_eq!(registry.peek_message_sent_gen("s"), Some(1));
        registry.mark_message_sent("s", 2);
        assert_eq!(registry.peek_message_sent_gen("s"), Some(2));
    }

    #[test]
    fn mcp_tool_used_gen_peek_roundtrip() {
        let registry = Registry::new();
        assert!(registry.peek_mcp_tool_used_gen("s").is_none());
        registry.mark_mcp_tool_used("s", 1);
        assert_eq!(registry.peek_mcp_tool_used_gen("s"), Some(1));
        registry.mark_mcp_tool_used("s", 2);
        assert_eq!(registry.peek_mcp_tool_used_gen("s"), Some(2));
    }

    #[test]
    fn mcp_tool_used_gen_stale_mark_does_not_read_as_used_for_a_later_gen() {
        let registry = Registry::new();
        registry.mark_mcp_tool_used("s", 1);
        assert_ne!(registry.peek_mcp_tool_used_gen("s"), Some(2), "a gen-1 mark must not match gen 2");
    }

    #[test]
    fn turn_opened_by_wake_matches_only_the_stamped_gen() {
        let registry = Registry::new();
        assert!(!registry.is_turn_opened_by_wake("s", 1), "unknown session never matches");
        registry.set_turn_opened_by_wake("s", 1);
        assert!(registry.is_turn_opened_by_wake("s", 1));
        assert!(!registry.is_turn_opened_by_wake("s", 2), "a later user turn's gen must not match a stale wake stamp");
    }

    #[test]
    fn builtin_ask_attempt_counts_up_and_resets() {
        let registry = Registry::new();
        assert_eq!(registry.record_builtin_ask_attempt("s"), 1);
        assert_eq!(registry.record_builtin_ask_attempt("s"), 2);
        registry.reset_builtin_ask_attempts("s");
        assert_eq!(registry.record_builtin_ask_attempt("s"), 1, "reset must restart the count");
    }

    #[test]
    fn builtin_ask_attempt_counter_is_per_session() {
        let registry = Registry::new();
        registry.record_builtin_ask_attempt("s1");
        registry.record_builtin_ask_attempt("s1");
        assert_eq!(registry.record_builtin_ask_attempt("s2"), 1, "s2 must not inherit s1's count");
    }
}
