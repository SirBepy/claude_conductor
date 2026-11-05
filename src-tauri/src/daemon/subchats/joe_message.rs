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

use std::collections::{HashMap, HashSet};
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

/// Whether `text` is a question card's answer or its extra note, which Joe
/// produced by clicking and which is never a message to pass on.
fn is_card_reply(text: &str) -> bool {
    let t = text.trim_start();
    t.starts_with("<auq-answer") || t.starts_with("<auq-extra")
}

/// Called for every message written to a chat's child. Records Joe's own typed
/// messages and clears the slot for anything else, so the slot always holds the
/// newest message and only when that message was Joe's.
pub fn note_sent(session_id: &str, text: &str, is_meta: bool, author: Option<&str>) {
    if is_meta || author.is_some() || is_card_reply(text) || text.trim().is_empty() {
        lock().remove(session_id);
        return;
    }
    lock().insert(session_id.to_string(), Slot { text: text.to_string(), passed_to: HashSet::new() });
}

/// A message Joe typed while the chat was busy, delivered into the running turn.
/// Several can arrive in one delivery; they read as Joe's one latest message in
/// the order he typed them.
pub fn note_delivered(session_id: &str, texts: &[String]) {
    let joined: Vec<&str> =
        texts.iter().map(String::as_str).filter(|t| !t.trim().is_empty() && !is_card_reply(t)).collect();
    if joined.is_empty() {
        return;
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

    #[test]
    fn joes_typed_message_is_recorded_word_for_word_with_its_image_mention() {
        let text = "nice, do the same for signup\n<file:C:/Users/joe/pics/shot 1.png>  \n  thanks";
        note_sent("jm-typed", text, false, None);
        assert_eq!(latest("jm-typed").as_deref(), Some(text), "not trimmed, not reworded");
    }

    #[test]
    fn a_daemon_injected_turn_clears_the_slot_so_a_wake_cannot_resend_an_old_message() {
        note_sent("jm-wake", "fix the footer", false, None);
        note_sent("jm-wake", "Sub finished: footer", true, None);
        assert_eq!(latest("jm-wake"), None);
    }

    #[test]
    fn an_authored_relay_and_a_card_answer_are_not_joes_message() {
        note_sent("jm-relay", "fix the footer", false, None);
        note_sent("jm-relay", "do this other thing", false, Some("jarvis-1"));
        assert_eq!(latest("jm-relay"), None, "another AI's relay is not Joe typing");
        note_sent("jm-card", "fix the footer", false, None);
        note_sent("jm-card", "<auq-answer id=\"p1\"/>User answered the question(s):\nQ: a\nA: b", false, None);
        assert_eq!(latest("jm-card"), None, "a clicked answer is not a message to pass on");
    }

    #[test]
    fn a_newer_message_replaces_the_older_one_and_resets_who_it_reached() {
        note_sent("jm-newer", "first", false, None);
        mark_passed("jm-newer", "sub-a");
        assert!(already_passed("jm-newer", "sub-a"));
        assert!(!already_passed("jm-newer", "sub-b"), "a different sub is still open");
        note_sent("jm-newer", "second", false, None);
        assert_eq!(latest("jm-newer").as_deref(), Some("second"));
        assert!(!already_passed("jm-newer", "sub-a"));
    }

    #[test]
    fn messages_delivered_mid_turn_become_the_latest_in_typing_order() {
        note_sent("jm-mid", "start the job", false, None);
        note_delivered("jm-mid", &["also the header".to_string(), "and the footer".to_string()]);
        assert_eq!(latest("jm-mid").as_deref(), Some("also the header\n\nand the footer"));
        note_delivered("jm-mid", &[]);
        assert!(latest("jm-mid").is_some(), "an empty delivery changes nothing");
        note_delivered("jm-mid", &["<auq-answer id=\"p\"/>User answered the question(s):".to_string()]);
        assert_eq!(latest("jm-mid").as_deref(), Some("also the header\n\nand the footer"), "a card answer is not a message to pass on");
    }
}
