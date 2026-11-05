//! The final stamp: a sub that ends a job on Joe's judgement (taste, product, a
//! real decision) asks one question card with `final_stamp: true`. The card shows
//! the sub's picture and, under it, the same fact chips a finish card carries.
//! The daemon computes them from git and the sub's transcript when the question
//! arrives, so the sub cannot write its own.

use super::card_log;
use crate::daemon::state::DaemonState;
use serde_json::{json, Value};
use std::sync::Arc;

/// What a chat that is not a sub is told when it sets `final_stamp`.
pub const NOT_A_SUB: &str = "final_stamp is only for a sub, a hidden chat run for a main chat. This chat is not one: ask the question again without final_stamp.";

/// The `final_stamp` block of the prompt payload: `{ facts, sub_id }`. `Err` is
/// the note the caller reads when `session_id` is not a sub.
pub async fn final_stamp_payload(
    state: &Arc<DaemonState>,
    session_id: &str,
    reviewer_tool_use_id: Option<&str>,
) -> Result<Value, String> {
    let inst = state
        .registry
        .get(session_id)
        .filter(super::is_sub)
        .ok_or_else(|| NOT_A_SUB.to_string())?;
    let parent = inst.subchat_of.clone().unwrap_or_default();
    let reviewer = reviewer_tool_use_id.map(str::to_string);
    let check = super::project::check_mode(state, &inst.cwd);
    let transcript = crate::context_status::resolve_transcript(&state.registry, session_id);
    // git and a transcript read: off the async worker.
    let facts = tokio::task::spawn_blocking(move || {
        let log = card_log::read(&parent);
        card_log::sub_facts(&inst, check, reviewer.as_deref(), &log, transcript.as_deref())
    })
    .await
    .map_err(|e| format!("could not read the facts: {e}"))?;
    Ok(json!({ "sub_id": session_id, "facts": facts }))
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

    #[tokio::test]
    async fn final_stamp_is_refused_for_a_chat_that_is_not_a_sub() {
        let st = state();
        st.registry.upsert_interactive("plain", std::path::Path::new("."), "proj", "2026-11-05T00:00:00Z");
        assert_eq!(final_stamp_payload(&st, "plain", None).await.unwrap_err(), NOT_A_SUB);
        assert!(final_stamp_payload(&st, "ghost", None).await.is_err());
        assert!(final_stamp_payload(&st, "", None).await.is_err());
    }

    #[tokio::test]
    async fn a_subs_stamp_carries_code_computed_facts_with_unknown_test_and_reviewer() {
        let st = state();
        for id in ["st-main", "st-sub"] {
            st.registry.upsert_interactive(id, std::path::Path::new("."), "proj", "2026-11-05T00:00:00Z");
        }
        st.registry.set_subchat_of("st-sub", Some("st-main".into()));
        let v = final_stamp_payload(&st, "st-sub", Some("toolu_claimed")).await.unwrap();
        assert_eq!(v["sub_id"], "st-sub");
        let facts = &v["facts"];
        assert_eq!(facts["test"]["state"], "unknown", "the sub's claims are never believed: {facts}");
        assert_ne!(facts["reviewer"]["state"], "ran");
    }
}
