use super::registry::Registry;

/// See `Registry::reported_status`.
#[derive(Clone, Debug)]
pub struct ReportedStatus {
    pub turn_gen: u64,
    pub status: String,
    pub title: Option<String>,
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
    pub fn set_reported_status(&self, session_id: &str, turn_gen: u64, status: String, title: Option<String>) {
        self.reported_status
            .lock()
            .unwrap()
            .insert(session_id.to_string(), ReportedStatus { turn_gen, status, title });
    }

    /// Peek without consuming - the Stop hook fires before the pump's
    /// result-line handler, which is the one that `take`s it.
    pub fn peek_reported_status(&self, session_id: &str) -> Option<ReportedStatus> {
        self.reported_status.lock().unwrap().get(session_id).cloned()
    }

    /// Consume: always removes the entry, but only returns it on a gen
    /// match - mirrors `set_awaiting_if_gen`'s stale-turn guard.
    pub fn take_reported_status_if_gen(&self, session_id: &str, gen: u64) -> Option<ReportedStatus> {
        // Runs after the Stop hook has read both, so this is also where
        // message_sent_gen self-cleans instead of growing per session forever.
        self.message_sent_gen.lock().unwrap().remove(session_id);
        let entry = self.reported_status.lock().unwrap().remove(session_id)?;
        if entry.turn_gen == gen { Some(entry) } else { None }
    }

    /// Record that `send_message` succeeded for this session during
    /// `turn_gen`. Mirrors `set_reported_status`'s gen-stamped storage.
    pub fn mark_message_sent(&self, session_id: &str, turn_gen: u64) {
        self.message_sent_gen.lock().unwrap().insert(session_id.to_string(), turn_gen);
    }

    pub fn peek_message_sent_gen(&self, session_id: &str) -> Option<u64> {
        self.message_sent_gen.lock().unwrap().get(session_id).copied()
    }

    /// Record the live background-task count the Stop hook reported for this
    /// session's just-ended turn. Zero removes the entry.
    pub fn set_background_tasks(&self, session_id: &str, count: usize) {
        let mut guard = self.background_tasks.lock().unwrap();
        if count == 0 {
            guard.remove(session_id);
        } else {
            guard.insert(session_id.to_string(), count);
        }
    }

    /// Background-task count from the session's most recent Stop hook.
    /// Zero when the session never reported (or reported none).
    pub fn background_tasks(&self, session_id: &str) -> usize {
        self.background_tasks.lock().unwrap().get(session_id).copied().unwrap_or(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn background_tasks_roundtrip_and_zero_clears() {
        let registry = Registry::new();
        assert_eq!(registry.background_tasks("s"), 0);
        registry.set_background_tasks("s", 3);
        assert_eq!(registry.background_tasks("s"), 3);
        registry.set_background_tasks("s", 0);
        assert_eq!(registry.background_tasks("s"), 0);
    }

    #[test]
    fn reported_status_peek_then_take_roundtrip() {
        let registry = Registry::new();
        registry.set_reported_status("s", 1, "done".into(), Some("Fix login bug".into()));
        let peeked = registry.peek_reported_status("s").unwrap();
        assert_eq!(peeked.status, "done");
        assert_eq!(peeked.title.as_deref(), Some("Fix login bug"));
        let taken = registry.take_reported_status_if_gen("s", 1).unwrap();
        assert_eq!(taken.status, "done");
        assert!(registry.peek_reported_status("s").is_none(), "take must consume the entry");
    }

    #[test]
    fn reported_status_take_rejects_stale_gen_but_still_consumes() {
        let registry = Registry::new();
        registry.set_reported_status("s", 1, "done".into(), None);
        assert!(registry.take_reported_status_if_gen("s", 2).is_none(), "stale gen must not apply");
        assert!(registry.peek_reported_status("s").is_none(), "must consume even on mismatch");
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
}
