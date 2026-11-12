//! Joe's latest typed message to a main chat, kept so `subchat send` can copy it
//! to a sub word for word. The main agent only picks the target: if it had to
//! retype the message, a paraphrase could change what Joe asked, and a pasted
//! screenshot (a `<file:path>` mention in the text) would be lost.
//!
//! Only a message Joe typed counts. A daemon-injected turn (a wake, a nudge, a
//! schedule fire), a relay another AI authored and a question card's answer are
//! all "not Joe's message", and each one CLEARS the slot: a main chat woken by a
//! finishing sub must not resend what Joe said an hour ago. A message that
//! arrives mid-turn through the held queue is recorded by `hooks_server::nudge`
//! at the moment it is delivered, so a follow-up typed while the main agent was
//! working is still the one passed on.
//!
//! In memory on purpose: it is only read inside the turn that Joe's message
//! opened, and a restart ends that turn.
//!
//! Beside the slot, the last [`RECENT_MAX`] messages Joe typed are kept in order
//! ([`recent`]). A daemon-injected turn does not clear that list: the compaction
//! manager (`subchats::compaction`) quotes it word for word in its `/compact`
//! focus text, because a summary paraphrases and a brief must quote Joe exactly.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Mutex, OnceLock};

#[derive(Default)]
struct Slot {
    text: String,
    /// Subs this exact message already reached, so one message is not sent to
    /// the same sub twice by a retry. Sending it to a different sub is normal.
    passed_to: HashSet<String>,
}

fn slots() -> &'static Mutex<HashMap<String, Slot>> {
    static SLOTS: OnceLock<Mutex<HashMap<String, Slot>>> = OnceLock::new();
    SLOTS.get_or_init(Default::default)
}

fn lock() -> std::sync::MutexGuard<'static, HashMap<String, Slot>> {
    slots().lock().unwrap_or_else(|p| p.into_inner())
}

/// How many of Joe's typed messages [`recent`] keeps per main chat.
pub const RECENT_MAX: usize = 5;

fn recent_lock() -> std::sync::MutexGuard<'static, HashMap<String, VecDeque<String>>> {
    static RECENT: OnceLock<Mutex<HashMap<String, VecDeque<String>>>> = OnceLock::new();
    RECENT.get_or_init(Default::default).lock().unwrap_or_else(|p| p.into_inner())
}

fn push_recent(session_id: &str, text: &str) {
    let mut all = recent_lock();
    let list = all.entry(session_id.to_string()).or_default();
    list.push_back(text.to_string());
    while list.len() > RECENT_MAX {
        list.pop_front();
    }
}

/// The last [`RECENT_MAX`] messages Joe typed to `session_id`, oldest first and
/// word for word. Unlike [`latest`], a wake or a relay does not clear it.
pub fn recent(session_id: &str) -> Vec<String> {
    recent_lock().get(session_id).map(|l| l.iter().cloned().collect()).unwrap_or_default()
}

/// Whether `text` is a question card's answer or its extra note, which Joe
/// produced by clicking and which is never a message to pass on.
fn is_card_reply(text: &str) -> bool {
    let t = text.trim_start();
    t.starts_with("<auq-answer") || t.starts_with("<auq-extra")
}

/// Only a main chat (the mode on) ever reads the slot. Storing the last message of
/// every chat would hold one string per chat for as long as the daemon runs.
fn tracked(session_id: &str) -> bool {
    crate::sessions::chat_config::get(session_id).is_some_and(|c| c.subchats_on)
}

/// Called for every message written to a chat's child. Records Joe's own typed
/// messages and clears the slot for anything else, so the slot always holds the
/// newest message and only when that message was Joe's.
pub fn note_sent(session_id: &str, text: &str, is_meta: bool, author: Option<&str>) {
    if is_meta || author.is_some() || is_card_reply(text) || text.trim().is_empty() || !tracked(session_id) {
        lock().remove(session_id);
        return;
    }
    lock().insert(session_id.to_string(), Slot { text: text.to_string(), passed_to: HashSet::new() });
    push_recent(session_id, text);
}

/// A message Joe typed while the chat was busy, delivered into the running turn.
/// Several can arrive in one delivery; they read as Joe's one latest message in
/// the order he typed them.
pub fn note_delivered(session_id: &str, texts: &[String]) {
    let joined: Vec<&str> =
        texts.iter().map(String::as_str).filter(|t| !t.trim().is_empty() && !is_card_reply(t)).collect();
    if joined.is_empty() || !tracked(session_id) {
        return;
    }
    for text in &joined {
        push_recent(session_id, text);
    }
    lock().insert(session_id.to_string(), Slot { text: joined.join("\n\n"), passed_to: HashSet::new() });
}

/// Joe's latest message to `session_id`, verbatim, when the newest message the
/// chat received was his.
pub fn latest(session_id: &str) -> Option<String> {
    lock().get(session_id).map(|s| s.text.clone())
}

/// Drops the slot for `session_id`. A `respawn` calls it for both ends: the
/// predecessor's message belongs to a turn that is over, and the successor's first
/// message is the handoff its predecessor wrote, which Joe did not type.
pub fn forget(session_id: &str) {
    lock().remove(session_id);
    recent_lock().remove(session_id);
}

/// Whether the latest message already went to `sub_id`.
pub fn already_passed(session_id: &str, sub_id: &str) -> bool {
    lock().get(session_id).is_some_and(|s| s.passed_to.contains(sub_id))
}

/// Records that the latest message reached `sub_id`.
pub fn mark_passed(session_id: &str, sub_id: &str) {
    if let Some(slot) = lock().get_mut(session_id) {
        slot.passed_to.insert(sub_id.to_string());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A main chat: the only kind that stores Joe's message.
    fn on(ids: &[&str]) {
        for id in ids {
            crate::sessions::chat_config::set_subchats_on(id, true);
        }
    }

    #[test]
    fn joes_typed_message_is_recorded_word_for_word_with_its_image_mention() {
        let _data = super::super::TempDataDir::new();
        on(&["jm-typed"]);
        let text = "nice, do the same for signup\n<file:C:/Users/joe/pics/shot 1.png>  \n  thanks";
        note_sent("jm-typed", text, false, None);
        assert_eq!(latest("jm-typed").as_deref(), Some(text), "not trimmed, not reworded");
    }

    /// Only a main chat reads the slot. Storing the last message of every chat
    /// would keep one string per chat for as long as the daemon runs.
    #[test]
    fn a_chat_without_the_mode_stores_nothing() {
        let _data = super::super::TempDataDir::new();
        note_sent("jm-off", "an ordinary chat message", false, None);
        assert_eq!(latest("jm-off"), None);
        note_delivered("jm-off", &["typed mid-turn".to_string()]);
        assert_eq!(latest("jm-off"), None);
        crate::sessions::chat_config::set_subchats_on("jm-off", true);
        note_sent("jm-off", "now it counts", false, None);
        assert_eq!(latest("jm-off").as_deref(), Some("now it counts"));
    }

    #[test]
    fn a_chat_that_ends_frees_its_slot() {
        use crate::daemon::session::new_session_map;
        use crate::daemon::settings_cache::SettingsCache;
        let _data = super::super::TempDataDir::new();
        let st = crate::daemon::state::DaemonState::new(new_session_map(), SettingsCache::new(crate::types::Settings::default()));
        st.registry.upsert_interactive("jm-end", std::path::Path::new("."), "proj", "2026-11-05T00:00:00Z");
        crate::sessions::chat_config::set_subchats_on("jm-end", true);
        note_sent("jm-end", "fix the footer", false, None);
        assert!(latest("jm-end").is_some());
        st.registry.mark_ended("jm-end", crate::types::EndReason::Manual, "2026-11-05T00:00:00Z");
        assert_eq!(latest("jm-end"), None, "an ended chat's message is not kept");
    }

    #[test]
    fn a_daemon_injected_turn_clears_the_slot_so_a_wake_cannot_resend_an_old_message() {
        let _data = super::super::TempDataDir::new();
        on(&["jm-wake"]);
        note_sent("jm-wake", "fix the footer", false, None);
        note_sent("jm-wake", "Sub finished: footer", true, None);
        assert_eq!(latest("jm-wake"), None);
    }

    #[test]
    fn an_authored_relay_and_a_card_answer_are_not_joes_message() {
        let _data = super::super::TempDataDir::new();
        on(&["jm-relay", "jm-card"]);
        note_sent("jm-relay", "fix the footer", false, None);
        note_sent("jm-relay", "do this other thing", false, Some("jarvis-1"));
        assert_eq!(latest("jm-relay"), None, "another AI's relay is not Joe typing");
        note_sent("jm-card", "fix the footer", false, None);
        note_sent("jm-card", "<auq-answer id=\"p1\"/>User answered the question(s):\nQ: a\nA: b", false, None);
        assert_eq!(latest("jm-card"), None, "a clicked answer is not a message to pass on");
    }

    #[test]
    fn a_newer_message_replaces_the_older_one_and_resets_who_it_reached() {
        let _data = super::super::TempDataDir::new();
        on(&["jm-newer"]);
        note_sent("jm-newer", "first", false, None);
        mark_passed("jm-newer", "sub-a");
        assert!(already_passed("jm-newer", "sub-a"));
        assert!(!already_passed("jm-newer", "sub-b"), "a different sub is still open");
        note_sent("jm-newer", "second", false, None);
        assert_eq!(latest("jm-newer").as_deref(), Some("second"));
        assert!(!already_passed("jm-newer", "sub-a"));
    }

    /// The compaction focus text quotes these, so a wake between two of Joe's
    /// messages must not drop the older one, and only his last few are kept.
    #[test]
    fn recent_keeps_joes_last_typed_messages_across_wakes_and_drops_the_oldest() {
        let _data = super::super::TempDataDir::new();
        on(&["jm-recent"]);
        note_sent("jm-recent", "one", false, None);
        note_sent("jm-recent", "Sub finished.", true, None);
        note_sent("jm-recent", "two", false, Some("jarvis-1"));
        note_sent("jm-recent", "<auq-answer id=\"p\"/>A", false, None);
        note_delivered("jm-recent", &["three".to_string(), "four".to_string()]);
        assert_eq!(recent("jm-recent"), vec!["one", "three", "four"], "only what Joe typed, in order");
        for t in ["five", "six", "seven"] {
            note_sent("jm-recent", t, false, None);
        }
        assert_eq!(recent("jm-recent"), vec!["three", "four", "five", "six", "seven"]);
        note_sent("jm-recent-off", "not a main chat", false, None);
        assert!(recent("jm-recent-off").is_empty());
        forget("jm-recent");
        assert!(recent("jm-recent").is_empty());
    }

    #[test]
    fn messages_delivered_mid_turn_become_the_latest_in_typing_order() {
        let _data = super::super::TempDataDir::new();
        on(&["jm-mid"]);
        note_sent("jm-mid", "start the job", false, None);
        note_delivered("jm-mid", &["also the header".to_string(), "and the footer".to_string()]);
        assert_eq!(latest("jm-mid").as_deref(), Some("also the header\n\nand the footer"));
        note_delivered("jm-mid", &[]);
        assert!(latest("jm-mid").is_some(), "an empty delivery changes nothing");
        note_delivered("jm-mid", &["<auq-answer id=\"p\"/>User answered the question(s):".to_string()]);
        assert_eq!(latest("jm-mid").as_deref(), Some("also the header\n\nand the footer"), "a card answer is not a message to pass on");
    }
}
