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
///
/// It also fires whenever no client confirmed in the window (the app closed, the
/// main chat's row not loaded yet), while the durable card stays queued and shows
/// as soon as Joe opens the main chat. So the sub is told the card is still
/// there, to end its turn, and that finishing is refused while it is open. The
/// old wording said to finish what did not need his answer and report the block,
/// which sent the sub off to finish with a question still waiting.
pub const UNCONFIRMED_NOTE: &str = "Could not confirm any client actually received this question within the timeout window, so it may \
not have shown yet. The card is still queued for Joe and appears as soon as he opens the main chat. Do \
not re-send it with send_message: your chat is hidden, so nobody would read it. Do not call \
finish_subchat while the card is open, because that is refused. End your turn now without finishing, \
and carry on when his answer arrives as a new message.";

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

/// Longest task line a card shows, in characters.
const TASK_LINE_MAX: usize = 80;

/// The first line of the brief's task, cut to [`TASK_LINE_MAX`] characters with an
/// ellipsis. The sub keeps the whole text in its first message; the card is one
/// line under a header, and a brief's opening paragraph is not a title. A blank
/// task is `None`, because the card would otherwise draw an empty line.
fn task_line(brief: Option<&super::SubchatBrief>) -> Option<String> {
    let first = brief?.task.lines().map(str::trim).find(|l| !l.is_empty())?;
    if first.chars().count() <= TASK_LINE_MAX {
        return Some(first.to_string());
    }
    let cut: String = first.chars().take(TASK_LINE_MAX - 1).collect();
    Some(format!("{}\u{2026}", cut.trim_end()))
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

    /// The first run showed a brief's opening paragraph as the card's task line.
    #[test]
    fn the_task_line_is_the_first_line_cut_at_eighty_characters_with_an_ellipsis() {
        let mut brief: crate::daemon::subchats::SubchatBrief = serde_json::from_value(json!({})).unwrap();
        brief.task = "Redesign the CV header\nKeep the grid. Ask Joe on a question card (the ask_user_question tool, domain ux) before changing colours.".into();
        assert_eq!(task_line(Some(&brief)).as_deref(), Some("Redesign the CV header"), "only the first line");
        brief.task = "\n\n  Second line wins when the first is blank\nthird".into();
        assert_eq!(task_line(Some(&brief)).as_deref(), Some("Second line wins when the first is blank"));
        brief.task = "Ask Joe on a question card (the ask_user_question tool, domain ux) before you change anything about the header".into();
        let line = task_line(Some(&brief)).unwrap();
        assert_eq!(line.chars().count(), TASK_LINE_MAX, "{line}");
        assert!(line.ends_with('\u{2026}') && line.starts_with("Ask Joe on a question card"), "{line}");
        brief.task = "x".repeat(TASK_LINE_MAX);
        assert_eq!(task_line(Some(&brief)).unwrap(), "x".repeat(TASK_LINE_MAX), "exactly at the cap is not cut");
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

    #[test]
    fn unconfirmed_note_keeps_the_card_alive_and_tells_the_sub_to_end_its_turn_not_finish() {
        let n = UNCONFIRMED_NOTE;
        assert!(n.contains("still queued for Joe"), "the card has not gone anywhere: {n}");
        assert!(n.contains("End your turn now without finishing"), "{n}");
        assert!(n.contains("carry on when his answer arrives"), "{n}");
        assert!(n.contains("finish_subchat") && n.contains("refused"), "{n}");
        assert!(!n.contains("Finish the part of the job"), "the old advice sent the sub off to finish: {n}");
        assert!(!n.contains("final report"), "{n}");
        assert!(!n.contains('\u{2014}'));
    }
}
