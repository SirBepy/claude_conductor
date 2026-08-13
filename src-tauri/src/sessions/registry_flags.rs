use super::registry::Registry;

impl Registry {
    /// Set the self-reported turn status. `None` clears it (e.g. when a new
    /// turn starts). No-op if session is unknown.
    pub fn set_awaiting(&self, session_id: &str, awaiting: Option<String>) {
        let mut guard = self.inner.lock().unwrap();
        if let Some(i) = guard.get_mut(session_id) {
            i.awaiting = awaiting;
        }
    }

    /// Set `awaiting` only if `turn_gen` still matches `gen`. Mirrors
    /// `set_busy_false_if_gen`: a stale interrupted turn's late result line
    /// must not stamp its status onto a newer turn. Returns true if applied.
    pub fn set_awaiting_if_gen(&self, session_id: &str, awaiting: Option<String>, gen: u64) -> bool {
        let mut guard = self.inner.lock().unwrap();
        if let Some(i) = guard.get_mut(session_id) {
            if i.turn_gen == gen {
                i.awaiting = awaiting;
                return true;
            }
        }
        false
    }

    /// Whether `turn_sound` should fire for a completed live turn, deduping
    /// repeated `question` in a row (todo 564): `done` always fires,
    /// `question` fires only if it differs from the last-notified state,
    /// anything else resets that state without firing.
    pub fn should_notify_turn_sound(&self, session_id: &str, awaiting: Option<&str>) -> bool {
        let mut guard = self.inner.lock().unwrap();
        let Some(i) = guard.get_mut(session_id) else { return false };
        let should_fire = match awaiting {
            Some("done") => true,
            Some("question") => i.last_notified_awaiting.as_deref() != Some("question"),
            _ => false,
        };
        i.last_notified_awaiting = awaiting.map(str::to_string);
        should_fire
    }

    /// Clear `awaiting` only if it currently reads `"question"`. Used by the
    /// prompt-answer/expiry paths, which must not stomp a status some newer
    /// turn already wrote. Returns true if a clear actually happened.
    pub fn clear_awaiting_if_question(&self, session_id: &str) -> bool {
        let mut guard = self.inner.lock().unwrap();
        if let Some(i) = guard.get_mut(session_id) {
            if i.awaiting.as_deref() == Some("question") {
                i.awaiting = None;
                return true;
            }
        }
        false
    }

    /// Flip the daemon-authoritative "a /close run is in flight" flag. Returns
    /// true if the value actually changed (callers publish `instances_changed`
    /// only on real transitions). No-op false for unknown sessions.
    pub fn set_closing(&self, session_id: &str, closing: bool) -> bool {
        let mut guard = self.inner.lock().unwrap();
        if let Some(i) = guard.get_mut(session_id) {
            if i.closing != closing {
                i.closing = closing;
                return true;
            }
        }
        false
    }

    /// Flip the frozen flag (Chat menu's Freeze/Unfreeze toggle). Returns true
    /// if the value actually changed, mirroring `set_closing`. No-op false for
    /// unknown sessions.
    pub fn set_frozen(&self, session_id: &str, frozen: bool) -> bool {
        let mut guard = self.inner.lock().unwrap();
        if let Some(i) = guard.get_mut(session_id) {
            if i.frozen != frozen {
                i.frozen = frozen;
                return true;
            }
        }
        false
    }

    /// Flip `auto_frozen` - set alongside `set_frozen(true)` by
    /// `handle_rate_limit_rejection`, cleared alongside `set_frozen(false)` by
    /// both `unfreeze_session` and the rate-limit resume's own auto-unfreeze
    /// (`schedule_fire::fire_message`). No-op if session is unknown.
    pub fn set_auto_frozen(&self, session_id: &str, auto_frozen: bool) {
        let mut guard = self.inner.lock().unwrap();
        if let Some(i) = guard.get_mut(session_id) {
            i.auto_frozen = auto_frozen;
        }
    }

    /// Record whether the session had a turn/prompt in flight at freeze time
    /// - set at freeze, consumed once at unfreeze via `take_frozen_needs_continue`.
    /// No-op if session is unknown.
    pub fn set_frozen_needs_continue(&self, session_id: &str, needs: bool) {
        let mut guard = self.inner.lock().unwrap();
        if let Some(i) = guard.get_mut(session_id) {
            i.frozen_needs_continue = needs;
        }
    }

    /// Read and clear `frozen_needs_continue` in one step, so a stale flag can
    /// never fire the auto-continue twice - same one-shot pattern as
    /// `take_close_requested`. Returns the pre-clear value; false for unknown
    /// sessions.
    pub fn take_frozen_needs_continue(&self, session_id: &str) -> bool {
        let mut guard = self.inner.lock().unwrap();
        let Some(i) = guard.get_mut(session_id) else { return false };
        let needs = i.frozen_needs_continue;
        i.frozen_needs_continue = false;
        needs
    }

    /// Set the autopilot-active flag. `true` = /autopilot running; `false` = finished.
    /// No-op if session is unknown.
    pub fn set_autopilot(&self, session_id: &str, active: bool) {
        let mut guard = self.inner.lock().unwrap();
        if let Some(i) = guard.get_mut(session_id) {
            i.autopilot = active;
        }
    }

    /// Set the Jarvis-singleton flag (todo 272). No-op if session is unknown.
    pub fn set_jarvis(&self, session_id: &str, jarvis: bool) {
        let mut guard = self.inner.lock().unwrap();
        if let Some(i) = guard.get_mut(session_id) {
            i.jarvis = jarvis;
        }
    }

    /// Set which Jarvis session (if any) spawned this session as a worker.
    /// `None` clears it. No-op if session is unknown.
    pub fn set_worker_of(&self, session_id: &str, worker_of: Option<String>) {
        let mut guard = self.inner.lock().unwrap();
        if let Some(i) = guard.get_mut(session_id) {
            i.worker_of = worker_of;
        }
    }

    /// Path C helper: flip the `busy` flag on a session entry. Sidebar uses
    /// this to render running vs idle. No-op if session is unknown.
    /// When `busy=true`, also bumps `turn_gen` (stale-clear guard) and
    /// stamps `last_event_at` so the busy-watchdog sees a fresh turn.
    pub fn set_busy(&self, session_id: &str, busy: bool) {
        let mut guard = self.inner.lock().unwrap();
        if let Some(i) = guard.get_mut(session_id) {
            i.busy = busy;
            if busy {
                i.turn_gen = i.turn_gen.wrapping_add(1);
                i.last_event_at = Some(chrono::Utc::now().to_rfc3339());
            }
        }
    }

    /// Stamp `last_event_at` to now - the busy-watchdog's only liveness
    /// signal. Called from every event-flow site, not just turn start.
    pub fn touch_activity(&self, session_id: &str) {
        let mut guard = self.inner.lock().unwrap();
        if let Some(i) = guard.get_mut(session_id) {
            i.last_event_at = Some(chrono::Utc::now().to_rfc3339());
        }
    }

    /// Bumps `channel_epoch` for `session_id`. Called from
    /// `daemon::lifecycle::spawn_session`, the one chokepoint every
    /// spawn/respawn/restart path shares.
    pub fn bump_channel_epoch(&self, session_id: &str) {
        let mut guard = self.inner.lock().unwrap();
        if let Some(i) = guard.get_mut(session_id) {
            i.channel_epoch = i.channel_epoch.wrapping_add(1);
        }
    }

    /// Read the current `turn_gen` for a session. Used by the pump to snapshot
    /// the generation at turn-start so it can guard the turn-end `set_busy(false)`
    /// call. Returns 0 for unknown sessions.
    pub fn current_turn_gen(&self, session_id: &str) -> u64 {
        self.inner
            .lock()
            .unwrap()
            .get(session_id)
            .map(|i| i.turn_gen)
            .unwrap_or(0)
    }

    /// Set `busy=false` only if `turn_gen` still matches `gen`. A mismatch means
    /// a newer turn has started since the pump captured the generation; the stale
    /// result line should not clear the new turn's `busy=true`.
    /// Returns true if busy was actually cleared.
    pub fn set_busy_false_if_gen(&self, session_id: &str, gen: u64) -> bool {
        let mut guard = self.inner.lock().unwrap();
        if let Some(i) = guard.get_mut(session_id) {
            if i.turn_gen == gen {
                i.busy = false;
                return true;
            }
            // `gen == 0` means the pump never captured a generation, which today
            // only happens when a turn emitted no AssistantDelta: the row then
            // stays "In progress" forever. Logged separately from a genuine
            // newer-turn mismatch, which is the guard working as intended.
            if i.busy {
                log::warn!(
                    "registry: busy NOT cleared for {session_id}: pump gen {gen} != registry gen {} ({})",
                    i.turn_gen,
                    if gen == 0 { "uncaptured, turn emitted no text delta" } else { "newer turn started" }
                );
            }
        }
        false
    }

    /// Set both model and effort on a session entry. Returns true if the
    /// entry was found.
    pub fn set_model_effort(&self, session_id: &str, model: &str, effort: &str) -> bool {
        let mut guard = self.inner.lock().unwrap();
        let Some(i) = guard.get_mut(session_id) else { return false };
        i.model = model.to_string();
        i.effort = effort.to_string();
        true
    }

    /// Set only the effort on a session entry. Returns true if the entry
    /// was found.
    pub fn set_effort(&self, session_id: &str, effort: &str) -> bool {
        let mut guard = self.inner.lock().unwrap();
        let Some(i) = guard.get_mut(session_id) else { return false };
        i.effort = effort.to_string();
        true
    }

    /// Set only the model on a session entry. Returns true if the entry
    /// was found.
    pub fn set_model(&self, session_id: &str, model: &str) -> bool {
        let mut guard = self.inner.lock().unwrap();
        let Some(i) = guard.get_mut(session_id) else { return false };
        i.model = model.to_string();
        true
    }

    /// Cross-surface draft sync's cheap half: how many messages are queued
    /// for this session. Rides `instances_changed` like the flags above;
    /// full content lives in `DaemonState::draft_store`. Returns true only
    /// if the value actually changed (unknown session: false).
    pub fn set_held_count(&self, session_id: &str, count: u32) -> bool {
        let mut guard = self.inner.lock().unwrap();
        if let Some(i) = guard.get_mut(session_id) {
            if i.held_count != count {
                i.held_count = count;
                return true;
            }
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::Settings;
    use std::path::Path;
    use std::sync::Mutex;

    fn fresh_settings() -> Mutex<Settings> {
        Mutex::new(Settings::default())
    }

    #[test]
    fn set_awaiting_updates_and_clears() {
        let registry = Registry::new();
        let settings = fresh_settings();
        registry.record_interactive_session("s1", Path::new("/tmp/x"), &settings, "2026-01-01T00:00:00Z");
        assert!(registry.get("s1").unwrap().awaiting.is_none());
        registry.set_awaiting("s1", Some("question".into()));
        assert_eq!(registry.get("s1").unwrap().awaiting.as_deref(), Some("question"));
        registry.set_awaiting("s1", None);
        assert!(registry.get("s1").unwrap().awaiting.is_none());
    }

    #[test]
    fn set_busy_toggles_flag() {
        let registry = Registry::new();
        let settings = fresh_settings();
        registry.record_interactive_session(
            "sess-abc",
            Path::new("/tmp/x"),
            &settings,
            "2026-05-08T04:30:00Z",
        );
        registry.set_busy("sess-abc", true);
        assert_eq!(registry.get("sess-abc").unwrap().busy, true);
        registry.set_busy("sess-abc", false);
        assert_eq!(registry.get("sess-abc").unwrap().busy, false);
    }

    #[test]
    fn set_busy_unknown_session_is_noop() {
        let registry = Registry::new();
        registry.set_busy("missing", true);
        assert!(registry.get("missing").is_none());
    }

    /// Pins the latch documented in todo 475: `pump_turn_gen` starts at 0 and is
    /// only assigned from the AssistantDelta arm, so a turn emitting no text
    /// clears with gen 0, never matches, and the row stays "In progress".
    #[test]
    fn set_busy_false_with_uncaptured_gen_zero_never_clears() {
        let registry = Registry::new();
        let settings = fresh_settings();
        registry.record_interactive_session("s", Path::new("/tmp/x"), &settings, "2026-06-23T00:00:00Z");
        registry.set_busy("s", true);
        assert_eq!(registry.get("s").unwrap().turn_gen, 1);
        assert!(!registry.set_busy_false_if_gen("s", 0));
        assert!(registry.get("s").unwrap().busy, "busy latches on when the pump never captured a gen");
        // The captured-gen path still clears, so the guard itself is sound.
        assert!(registry.set_busy_false_if_gen("s", 1));
        assert!(!registry.get("s").unwrap().busy);
    }

    #[test]
    fn set_busy_true_bumps_turn_gen() {
        let registry = Registry::new();
        let settings = fresh_settings();
        registry.record_interactive_session("s", Path::new("/tmp/x"), &settings, "2026-06-23T00:00:00Z");
        assert_eq!(registry.get("s").unwrap().turn_gen, 0);
        registry.set_busy("s", true);
        assert_eq!(registry.get("s").unwrap().turn_gen, 1);
        // false must NOT bump gen
        registry.set_busy("s", false);
        assert_eq!(registry.get("s").unwrap().turn_gen, 1);
        registry.set_busy("s", true);
        assert_eq!(registry.get("s").unwrap().turn_gen, 2);
    }

    #[test]
    fn set_busy_false_if_gen_clears_on_match() {
        let registry = Registry::new();
        let settings = fresh_settings();
        registry.record_interactive_session("s", Path::new("/tmp/x"), &settings, "2026-06-23T00:00:00Z");
        registry.set_busy("s", true); // gen -> 1
        let gen = registry.current_turn_gen("s");
        assert_eq!(gen, 1);
        let cleared = registry.set_busy_false_if_gen("s", gen);
        assert!(cleared);
        assert_eq!(registry.get("s").unwrap().busy, false);
    }

    #[test]
    fn set_busy_false_if_gen_noop_on_stale_gen() {
        let registry = Registry::new();
        let settings = fresh_settings();
        registry.record_interactive_session("s", Path::new("/tmp/x"), &settings, "2026-06-23T00:00:00Z");
        registry.set_busy("s", true); // gen -> 1 (pump captures this)
        let pump_gen = registry.current_turn_gen("s");
        // New message arrives before pump's TurnUsage: gen -> 2
        registry.set_busy("s", true);
        // Pump tries to clear with stale gen=1 — must be a no-op
        let cleared = registry.set_busy_false_if_gen("s", pump_gen);
        assert!(!cleared);
        assert_eq!(registry.get("s").unwrap().busy, true, "new turn's busy must survive");
        assert_eq!(registry.get("s").unwrap().turn_gen, 2);
    }

    /// todo 525 root cause 1: pins the fix - the bump must happen before
    /// anything (the pump) can observe `turn_gen`, or the clear never matches.
    #[test]
    fn send_message_ordering_bump_before_write_lets_own_result_clear() {
        let registry = Registry::new();
        let settings = fresh_settings();
        registry.record_interactive_session("s", Path::new("/tmp/x"), &settings, "2026-08-13T00:00:00Z");

        // OLD (buggy) order: observed before the handler's bump.
        let observed_gen_old_order = registry.current_turn_gen("s"); // 0, stale
        registry.set_busy("s", true); // handler bumps AFTER - too late
        assert!(
            !registry.set_busy_false_if_gen("s", observed_gen_old_order),
            "the bug: a pre-bump observation can never match the post-bump gen"
        );
        assert!(registry.get("s").unwrap().busy, "busy latches on under the old ordering");

        // Fixed order: bump happens first.
        registry.set_busy("s", false);
        registry.set_busy("s", true); // handler bumps BEFORE the write
        let observed_gen_new_order = registry.current_turn_gen("s");
        assert!(
            registry.set_busy_false_if_gen("s", observed_gen_new_order),
            "the fix: a post-bump observation always matches"
        );
        assert!(!registry.get("s").unwrap().busy);
    }

    #[test]
    fn set_awaiting_if_gen_applies_on_match() {
        let registry = Registry::new();
        let settings = fresh_settings();
        registry.record_interactive_session("s", Path::new("/tmp/x"), &settings, "2026-07-11T00:00:00Z");
        registry.set_busy("s", true); // gen -> 1
        let gen = registry.current_turn_gen("s");
        assert!(registry.set_awaiting_if_gen("s", Some("done".into()), gen));
        assert_eq!(registry.get("s").unwrap().awaiting.as_deref(), Some("done"));
    }

    /// The exact "Input needed while busy" race: turn 1 is cancelled, a new
    /// turn starts (awaiting cleared, busy=true, gen bumped), then turn 1's
    /// late result line tries to write awaiting="question". The stale write
    /// must be rejected so the new turn keeps rendering In Progress.
    #[test]
    fn set_awaiting_if_gen_rejects_stale_interrupted_turn() {
        let registry = Registry::new();
        let settings = fresh_settings();
        registry.record_interactive_session("s", Path::new("/tmp/x"), &settings, "2026-07-11T00:00:00Z");
        registry.set_busy("s", true); // turn 1, gen -> 1
        let stale_gen = registry.current_turn_gen("s");
        // Cancel + new send: awaiting cleared, busy re-set (gen -> 2).
        registry.set_busy("s", false);
        registry.set_awaiting("s", None);
        registry.set_busy("s", true);
        // Turn 1's late result arrives with its captured gen.
        let applied = registry.set_awaiting_if_gen("s", Some("question".into()), stale_gen);
        assert!(!applied, "stale turn must not stamp awaiting onto the new turn");
        let i = registry.get("s").unwrap();
        assert!(i.awaiting.is_none(), "new turn's cleared awaiting must survive");
        assert!(i.busy);
    }

    #[test]
    fn should_notify_turn_sound_suppresses_repeated_question() {
        let registry = Registry::new();
        let settings = fresh_settings();
        registry.record_interactive_session("s", Path::new("/tmp/x"), &settings, "2026-08-09T00:00:00Z");
        assert!(registry.should_notify_turn_sound("s", Some("question")), "first question must fire");
        assert!(!registry.should_notify_turn_sound("s", Some("question")), "repeat question must not fire");
        assert!(!registry.should_notify_turn_sound("s", Some("question")), "third in a row still suppressed");
    }

    #[test]
    fn should_notify_turn_sound_done_always_fires() {
        let registry = Registry::new();
        let settings = fresh_settings();
        registry.record_interactive_session("s", Path::new("/tmp/x"), &settings, "2026-08-09T00:00:00Z");
        assert!(registry.should_notify_turn_sound("s", Some("done")));
        assert!(registry.should_notify_turn_sound("s", Some("done")), "done fires every time, no dedup");
    }

    #[test]
    fn should_notify_turn_sound_refires_after_intervening_state() {
        let registry = Registry::new();
        let settings = fresh_settings();
        registry.record_interactive_session("s", Path::new("/tmp/x"), &settings, "2026-08-09T00:00:00Z");
        assert!(registry.should_notify_turn_sound("s", Some("question")));
        // A background task resumed it and it went "working" in between -
        // not itself a firing state, but must reset the dedup key.
        assert!(!registry.should_notify_turn_sound("s", Some("working")));
        assert!(registry.should_notify_turn_sound("s", Some("question")), "re-asking after an intervening state must notify again");
    }

    #[test]
    fn should_notify_turn_sound_unknown_session_is_noop() {
        let registry = Registry::new();
        assert!(!registry.should_notify_turn_sound("ghost", Some("question")));
    }

    #[test]
    fn set_awaiting_if_gen_unknown_session_is_noop() {
        let registry = Registry::new();
        assert!(!registry.set_awaiting_if_gen("ghost", Some("done".into()), 0));
    }

    #[test]
    fn current_turn_gen_returns_zero_for_unknown() {
        let registry = Registry::new();
        assert_eq!(registry.current_turn_gen("ghost"), 0);
    }

    #[test]
    fn set_frozen_toggles_and_reports_change() {
        let registry = Registry::new();
        let settings = fresh_settings();
        registry.record_interactive_session("s", Path::new("/tmp/x"), &settings, "2026-08-01T00:00:00Z");
        assert!(!registry.get("s").unwrap().frozen);
        assert!(registry.set_frozen("s", true), "flipping false->true must report a change");
        assert!(registry.get("s").unwrap().frozen);
        assert!(!registry.set_frozen("s", true), "already true - no change");
        assert!(registry.set_frozen("s", false), "flipping true->false must report a change");
        assert!(!registry.get("s").unwrap().frozen);
    }

    #[test]
    fn set_frozen_unknown_session_is_noop() {
        let registry = Registry::new();
        assert!(!registry.set_frozen("ghost", true));
    }

    #[test]
    fn set_auto_frozen_is_independent_of_frozen() {
        let registry = Registry::new();
        let settings = fresh_settings();
        registry.record_interactive_session("s", Path::new("/tmp/x"), &settings, "2026-08-11T00:00:00Z");
        assert!(!registry.get("s").unwrap().auto_frozen);
        registry.set_frozen("s", true);
        registry.set_auto_frozen("s", true);
        assert!(registry.get("s").unwrap().auto_frozen);
        // Clearing `frozen` alone (e.g. a manual unfreeze) must not implicitly
        // clear `auto_frozen` - callers own that pairing explicitly.
        registry.set_frozen("s", false);
        assert!(registry.get("s").unwrap().auto_frozen, "set_frozen must not touch auto_frozen");
        registry.set_auto_frozen("s", false);
        assert!(!registry.get("s").unwrap().auto_frozen);
    }

    #[test]
    fn frozen_needs_continue_is_consumed_once() {
        let registry = Registry::new();
        let settings = fresh_settings();
        registry.record_interactive_session("s", Path::new("/tmp/x"), &settings, "2026-08-01T00:00:00Z");
        registry.set_frozen_needs_continue("s", true);
        assert!(registry.take_frozen_needs_continue("s"), "first take must return the set value");
        assert!(!registry.take_frozen_needs_continue("s"), "a second take must find it already cleared");
    }

    #[test]
    fn set_held_count_toggles_and_reports_change() {
        let registry = Registry::new();
        let settings = fresh_settings();
        registry.record_interactive_session("s", Path::new("/tmp/x"), &settings, "2026-08-13T00:00:00Z");
        assert_eq!(registry.get("s").unwrap().held_count, 0);
        assert!(registry.set_held_count("s", 2), "0->2 must report a change");
        assert_eq!(registry.get("s").unwrap().held_count, 2);
        assert!(!registry.set_held_count("s", 2), "same value - no change");
        assert!(registry.set_held_count("s", 0), "2->0 must report a change");
    }

    #[test]
    fn set_held_count_unknown_session_is_noop() {
        let registry = Registry::new();
        assert!(!registry.set_held_count("ghost", 1));
    }
}
