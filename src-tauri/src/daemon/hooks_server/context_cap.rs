//! Context-cap rider on the per-turn `UserPromptSubmit` injection: once a
//! chat's context passes [`CONTEXT_CAP_TOKENS`], every turn carries a note
//! telling it to hand off through `respawn`. Every API call re-reads the whole
//! context, so a 450k chat pays ~4.5x a 100k one for the same work; a
//! 2026-10-14 transcript scan put 64% of a week's cache-read spend on calls
//! above 200k. A "respawn at 30-40%" rule in a project doc had been read both
//! as used and as left, landing respawns anywhere from 250k to 770k, so the
//! number now comes from the daemon instead of the model's guess. It rides an
//! existing turn, never a wake of its own.

use crate::daemon::state::DaemonState;
use std::sync::Arc;

/// Joe's pick, 2026-10-14. A fresh chat already starts at ~50-60k (system
/// prompt, CLAUDE.md files, skill list), so this leaves ~90k of real work.
pub(crate) const CONTEXT_CAP_TOKENS: u64 = 150_000;

pub(crate) fn render_for_injection(state: &Arc<DaemonState>, session_id: &str) -> Option<String> {
    let status = crate::context_status::context_status_for_session(&state.registry, session_id)?;
    cap_note(status.occupancy)
}

fn cap_note(occupancy: u64) -> Option<String> {
    (occupancy >= CONTEXT_CAP_TOKENS).then(|| {
        format!(
            "Context cap: this chat is at {}k tokens, past the app's {}k cap. Every call re-reads all of it. Finish the current request, then call `respawn` with a complete handoff prompt instead of continuing here.",
            occupancy / 1000,
            CONTEXT_CAP_TOKENS / 1000
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn below_the_cap_injects_nothing() {
        assert_eq!(cap_note(CONTEXT_CAP_TOKENS - 1), None);
    }

    #[test]
    fn at_the_cap_names_the_size_and_respawn() {
        let note = cap_note(212_345).expect("over the cap");
        assert!(note.contains("212k"), "{note}");
        assert!(note.contains("150k"), "{note}");
        assert!(note.contains("`respawn`"), "{note}");
    }

    #[test]
    fn unknown_session_injects_nothing() {
        use crate::daemon::session::new_session_map;
        use crate::daemon::settings_cache::SettingsCache;
        let state = DaemonState::new(new_session_map(), SettingsCache::new(crate::types::Settings::default()));
        assert_eq!(render_for_injection(&state, "00000000-0000-4000-8000-00000000dead"), None);
    }
}
