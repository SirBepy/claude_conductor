//! `report_turn_status` MCP tool (todo 435): replaces the `<cc-status:..>`/
//! `<cc-title:..>` text markers with a schema-enforced tool call. Records
//! into the registry's `reported_status` side map, stamped with the current
//! `turn_gen`; the Stop hook and pump's result-line handler consume it.

use crate::daemon::state::DaemonState;
use serde_json::{json, Value};
use std::sync::Arc;

const VALID_STATUSES: [&str; 4] = ["done", "question", "waiting", "working"];

pub(crate) fn report_status(
    state: &Arc<DaemonState>,
    session_id: &str,
    status: &str,
    title: Option<&str>,
) -> Result<Value, String> {
    if !VALID_STATUSES.contains(&status) {
        return Err(format!(
            "invalid status '{status}': must be one of done|question|waiting|working"
        ));
    }
    let gen = state.registry.current_turn_gen(session_id);
    state.registry.set_reported_status(
        session_id,
        gen,
        status.to_string(),
        title.map(|s| s.to_string()),
    );
    // Watchdog signal (todo 525): a self-report is activity too.
    state.registry.touch_activity(session_id);
    Ok(json!({"ok": true}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::types::Settings;

    fn test_state() -> Arc<DaemonState> {
        DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()))
    }

    #[test]
    fn rejects_invalid_status() {
        let state = test_state();
        let r = report_status(&state, "s", "bogus", None);
        assert!(r.is_err());
        assert!(r.unwrap_err().contains("bogus"));
    }

    #[test]
    fn valid_status_records_reported_status() {
        let state = test_state();
        let r = report_status(&state, "s", "done", Some("Fix login bug"));
        assert_eq!(r, Ok(json!({"ok": true})));
        let peeked = state.registry.peek_reported_status("s").unwrap();
        assert_eq!(peeked.status, "done");
        assert_eq!(peeked.title.as_deref(), Some("Fix login bug"));
    }

    #[test]
    fn title_is_optional() {
        let state = test_state();
        report_status(&state, "s", "working", None).unwrap();
        let peeked = state.registry.peek_reported_status("s").unwrap();
        assert_eq!(peeked.title, None);
    }
}
