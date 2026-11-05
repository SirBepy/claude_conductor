//! Where a sub's question, permission and secret cards show.
//!
//! A sub asks, but Joe answers in the main chat's window, so every prompt
//! payload names two sessions: `session_id` is the asker and stays the answer
//! target (the answer, the Skip line and the card's text box all go to it), and
//! `display_session_id` is the chat whose window shows the card.

use crate::daemon::state::DaemonState;
use serde_json::{json, Value};

/// What a sub is told when its question reached no client. The generic wording
/// ("re-send via send_message") would be wrong here: a sub's chat has no sidebar
/// row, so a plain message would reach nobody.
pub const UNCONFIRMED_NOTE: &str = "Could not confirm any client actually received this question \
within the timeout window, so it may not have reached Joe. Do not re-send it with send_message: your \
chat is hidden, so nobody would read it. Do not wait any longer on this call. Finish the part of the \
job that does not need his answer, and say in your final report what you were blocked on.";

/// The chat whose window shows `session_id`'s cards: its parent when it is a
/// sub, else the session itself. A Jarvis worker has no `subchat_of`, so it
/// stays its own display chat and keeps today's routing.
pub fn display_session_id(state: &DaemonState, session_id: &str) -> String {
    state
        .registry
        .get(session_id)
        .and_then(|i| i.subchat_of)
        .unwrap_or_else(|| session_id.to_string())
}

/// Whether `session_id` is a hidden sub of a main chat.
pub fn is_sub_session(state: &DaemonState, session_id: &str) -> bool {
    state.registry.get(session_id).is_some_and(|i| super::is_sub(&i))
}

/// The one-line task a sub was given, shown on its card because Joe does not
/// read the sub. `None` for a chat with no stored brief; the card omits the line.
pub fn sub_task(session_id: &str) -> Option<String> {
    let cfg = crate::sessions::chat_config::get(session_id)?;
    task_line(cfg.subchat.as_ref())
}

/// The brief's task, trimmed. A blank one is `None`, because the card would
/// otherwise draw an empty line under the header.
fn task_line(brief: Option<&super::SubchatBrief>) -> Option<String> {
    let task = brief?.task.trim();
    (!task.is_empty()).then(|| task.to_string())
}

/// Adds the routing fields to a prompt payload in place. `display_session_id`
/// is always set when there is an asker; `sub_name` and `sub_task` only for a
/// sub, and any stale copies are dropped first so re-stamping a listed prompt
/// after its sub was promoted to the sidebar leaves no ghost label.
pub fn stamp_prompt_routing(state: &DaemonState, payload: &mut Value, session_id: Option<&str>) {
    let (Some(sid), Some(map)) = (session_id, payload.as_object_mut()) else { return };
    map.remove("sub_name");
    map.remove("sub_task");
    map.insert("display_session_id".into(), json!(display_session_id(state, sid)));
    let Some(inst) = state.registry.get(sid) else { return };
    if !super::is_sub(&inst) {
        return;
    }
    if let Some(name) = inst.name.filter(|n| !n.trim().is_empty()) {
        map.insert("sub_name".into(), json!(name));
    }
    if let Some(task) = sub_task(sid) {
        map.insert("sub_task".into(), json!(task));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::types::Settings;
    use std::sync::Arc;

    fn state() -> Arc<DaemonState> {
        DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()))
    }

    fn chat(state: &DaemonState, id: &str) {
        state.registry.upsert_interactive(id, std::path::Path::new("."), "proj", "2026-11-05T00:00:00Z");
    }

    #[test]
    fn the_task_line_comes_from_the_brief_and_a_blank_one_is_omitted() {
        let mut brief: crate::daemon::subchats::SubchatBrief = serde_json::from_value(json!({})).unwrap();
        assert_eq!(task_line(None), None, "no brief, no line");
        brief.task = "   ".into();
        assert_eq!(task_line(Some(&brief)), None, "a blank task draws nothing");
        brief.task = "  Redesign the CV header ".into();
        assert_eq!(task_line(Some(&brief)).as_deref(), Some("Redesign the CV header"));
    }

    #[test]
    fn a_subs_prompt_names_its_parent_as_the_display_chat_and_keeps_itself_as_the_asker() {
        let st = state();
        chat(&st, "main");
        chat(&st, "sub");
        st.registry.set_subchat_of("sub", Some("main".into()));
        let mut payload = json!({"id": "q1", "session_id": "sub"});
        stamp_prompt_routing(&st, &mut payload, Some("sub"));
        assert_eq!(payload["session_id"], "sub", "the answer target never moves");
        assert_eq!(payload["display_session_id"], "main");
    }

    #[test]
    fn a_normal_chats_prompt_displays_on_itself_and_carries_no_sub_fields() {
        let st = state();
        chat(&st, "solo");
        let mut payload = json!({"id": "q1", "session_id": "solo"});
        stamp_prompt_routing(&st, &mut payload, Some("solo"));
        assert_eq!(payload["display_session_id"], "solo");
        assert!(payload.get("sub_name").is_none());
        assert!(payload.get("sub_task").is_none());
    }

    #[test]
    fn a_jarvis_workers_prompt_keeps_displaying_on_the_worker() {
        let st = state();
        chat(&st, "jarvis");
        chat(&st, "worker");
        st.registry.set_worker_of("worker", Some("jarvis".into()));
        let mut payload = json!({"id": "q1", "session_id": "worker"});
        stamp_prompt_routing(&st, &mut payload, Some("worker"));
        assert_eq!(payload["display_session_id"], "worker", "worker_of must not reroute a card");
        assert!(payload.get("sub_name").is_none());
    }

    #[test]
    fn a_sub_carries_its_row_name_and_omits_a_missing_task() {
        let st = state();
        chat(&st, "main");
        chat(&st, "sub");
        st.registry.set_subchat_of("sub", Some("main".into()));
        st.registry.set_name("sub", "Fix login test".to_string());
        let mut payload = json!({"id": "q1", "session_id": "sub"});
        stamp_prompt_routing(&st, &mut payload, Some("sub"));
        assert_eq!(payload["sub_name"], "Fix login test");
        assert!(payload.get("sub_task").is_none(), "no stored brief yet, so the card gets no task line");
    }

    #[test]
    fn restamping_after_a_sub_is_promoted_drops_the_stale_sub_labels() {
        let st = state();
        chat(&st, "main");
        chat(&st, "sub");
        st.registry.set_subchat_of("sub", Some("main".into()));
        st.registry.set_name("sub", "Fix login test".to_string());
        let mut payload = json!({"id": "q1", "session_id": "sub"});
        stamp_prompt_routing(&st, &mut payload, Some("sub"));
        st.registry.set_subchat_of("sub", None);
        stamp_prompt_routing(&st, &mut payload, Some("sub"));
        assert_eq!(payload["display_session_id"], "sub");
        assert!(payload.get("sub_name").is_none());
    }

    #[test]
    fn a_prompt_with_no_asker_is_left_alone() {
        let st = state();
        let mut payload = json!({"id": "q1"});
        stamp_prompt_routing(&st, &mut payload, None);
        assert_eq!(payload, json!({"id": "q1"}));
    }

    #[test]
    fn unconfirmed_note_does_not_send_a_sub_to_a_chat_nobody_reads() {
        assert!(UNCONFIRMED_NOTE.contains("Do not re-send it with send_message"));
    }
}
