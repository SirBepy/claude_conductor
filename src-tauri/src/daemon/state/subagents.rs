//! Which `Agent` calls are in flight per session, and which ones an interrupt
//! killed before they could report back.
//!
//! `cancel_turn` aborts the whole turn, so every subagent still running dies
//! with it - silently, from the model's side: the tool results it was waiting
//! on simply never arrive, and the next turn starts with no record that work
//! was lost. Nudges (`hooks_server::nudge`) mean an interrupt is now a
//! deliberate choice rather than the only way to be heard, but when one does
//! happen the next turn should be told what it cost, so the work can be
//! re-dispatched instead of quietly dropped.
//!
//! Fed by the `SubagentStart`/`SubagentStop` hooks. A subagent that was killed
//! never fires `SubagentStop`, which is exactly what makes the live set at
//! interrupt time the set that died.

use super::*;

/// One in-flight `Agent` call. `agent_type` is the agent name the dispatch
/// asked for ("Explore", "general-purpose", ...) - the only part of a killed
/// subagent worth putting in front of the model, since the prompt that
/// dispatched it is already in its own transcript.
#[derive(Debug, Clone, PartialEq)]
pub struct LiveSubagent {
    pub agent_id: String,
    pub agent_type: String,
}

/// Ceiling on tracked subagents per session. A fan-out of this size is
/// already pathological; the cap just stops a session that somehow never
/// fires `SubagentStop` from growing the map without bound.
const MAX_TRACKED: usize = 64;

impl DaemonState {
    /// `SubagentStart`: an `Agent` call just began.
    pub fn subagent_started(&self, session_id: &str, agent_id: &str, agent_type: &str) {
        if agent_id.is_empty() {
            return;
        }
        let mut live = self.live_subagents.lock().unwrap();
        let entry = live.entry(session_id.to_string()).or_default();
        if entry.len() >= MAX_TRACKED || entry.iter().any(|s| s.agent_id == agent_id) {
            return;
        }
        entry.push(LiveSubagent {
            agent_id: agent_id.to_string(),
            agent_type: agent_type.to_string(),
        });
    }

    /// `SubagentStop`: it concluded on its own, so it is not a casualty.
    pub fn subagent_finished(&self, session_id: &str, agent_id: &str) {
        let mut live = self.live_subagents.lock().unwrap();
        if let Some(entry) = live.get_mut(session_id) {
            entry.retain(|s| s.agent_id != agent_id);
            if entry.is_empty() {
                live.remove(session_id);
            }
        }
    }

    /// An interrupt just landed: everything still live died with the turn.
    /// Moves it to the killed set, where it waits for the next turn to start.
    /// Accumulates rather than replaces, so two interrupts in a row before the
    /// next prompt still report both sets.
    pub fn record_subagents_killed_by_interrupt(&self, session_id: &str) {
        let Some(dead) = self.live_subagents.lock().unwrap().remove(session_id) else { return };
        if dead.is_empty() {
            return;
        }
        log::info!(
            "cancel_turn killed {} in-flight subagent(s) for {session_id}: {}",
            dead.len(),
            dead.iter().map(|s| s.agent_type.as_str()).collect::<Vec<_>>().join(", ")
        );
        self.killed_subagents.lock().unwrap().entry(session_id.to_string()).or_default().extend(dead);
    }

    /// Drains the killed set for the next turn's injection. Consuming read:
    /// the report is worth making once, and a turn that has already been told
    /// does not need telling again.
    pub fn take_subagents_killed_by_interrupt(&self, session_id: &str) -> Vec<LiveSubagent> {
        self.killed_subagents.lock().unwrap().remove(session_id).unwrap_or_default()
    }

    /// Turn ended normally. Anything still tracked finished without firing
    /// `SubagentStop` (or failed), and carrying it into the next turn would
    /// make a later interrupt report subagents that were never running.
    pub fn clear_live_subagents(&self, session_id: &str) {
        self.live_subagents.lock().unwrap().remove(session_id);
    }

    #[cfg(test)]
    pub(crate) fn live_subagents_for(&self, session_id: &str) -> Vec<LiveSubagent> {
        self.live_subagents.lock().unwrap().get(session_id).cloned().unwrap_or_default()
    }
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

    #[test]
    fn an_interrupt_reports_only_what_was_still_running() {
        let st = state();
        st.subagent_started("s1", "a1", "Explore");
        st.subagent_started("s1", "a2", "general-purpose");
        st.subagent_finished("s1", "a1");

        st.record_subagents_killed_by_interrupt("s1");

        let killed = st.take_subagents_killed_by_interrupt("s1");
        assert_eq!(killed.len(), 1);
        assert_eq!(killed[0].agent_type, "general-purpose");
    }

    #[test]
    fn the_report_is_made_once() {
        let st = state();
        st.subagent_started("s1", "a1", "Explore");
        st.record_subagents_killed_by_interrupt("s1");

        assert_eq!(st.take_subagents_killed_by_interrupt("s1").len(), 1);
        assert!(st.take_subagents_killed_by_interrupt("s1").is_empty());
    }

    #[test]
    fn an_interrupt_with_nothing_running_reports_nothing() {
        let st = state();
        st.record_subagents_killed_by_interrupt("s1");
        assert!(st.take_subagents_killed_by_interrupt("s1").is_empty());
    }

    // Two interrupts before the next prompt must not lose the first casualty.
    #[test]
    fn a_second_interrupt_adds_to_an_unreported_set() {
        let st = state();
        st.subagent_started("s1", "a1", "Explore");
        st.record_subagents_killed_by_interrupt("s1");
        st.subagent_started("s1", "a2", "Plan");
        st.record_subagents_killed_by_interrupt("s1");

        assert_eq!(st.take_subagents_killed_by_interrupt("s1").len(), 2);
    }

    #[test]
    fn a_normal_turn_end_leaves_nothing_for_a_later_interrupt_to_blame() {
        let st = state();
        st.subagent_started("s1", "a1", "Explore");
        st.clear_live_subagents("s1");

        st.record_subagents_killed_by_interrupt("s1");
        assert!(st.take_subagents_killed_by_interrupt("s1").is_empty());
    }

    #[test]
    fn sessions_do_not_see_each_others_subagents() {
        let st = state();
        st.subagent_started("s1", "a1", "Explore");
        st.subagent_started("s2", "a2", "Plan");

        st.record_subagents_killed_by_interrupt("s1");

        assert!(st.take_subagents_killed_by_interrupt("s2").is_empty());
        assert_eq!(st.live_subagents_for("s2").len(), 1);
    }

    #[test]
    fn a_repeated_start_for_one_agent_id_is_tracked_once() {
        let st = state();
        st.subagent_started("s1", "a1", "Explore");
        st.subagent_started("s1", "a1", "Explore");
        assert_eq!(st.live_subagents_for("s1").len(), 1);
    }
}
