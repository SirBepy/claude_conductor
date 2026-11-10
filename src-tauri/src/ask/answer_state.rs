//! What the chat dashboard's Answers card remembers per chat:
//! `<data>/ask/<chat_session_id>.answers.json`, beside that chat's Ask threads.
//!
//! Kept daemon-side because a Got it must survive a reload, an app restart and
//! the other device (the persistence rule in the global CLAUDE.md), and the
//! card's threads already live here as Ask threads.
//!
//! An answer's key is the `send_message` tool_use id that drew it, or
//! `ask:<thread id>` for the reply to a question Joe started with the card's +.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// The key of the answer a + question's thread produced.
pub fn question_key(thread_id: &str) -> String {
    format!("ask:{thread_id}")
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct NewQuestion {
    pub thread_id: String,
    #[serde(default)]
    pub asked_at: i64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct AnswerState {
    /// Answer key -> when Joe pressed Got it (ms). An answer whose thread got a
    /// reply after this is unread again.
    #[serde(default)]
    pub read: BTreeMap<String, i64>,
    /// Answer key -> the Ask thread holding its follow-ups.
    #[serde(default)]
    pub threads: BTreeMap<String, String>,
    /// Questions Joe started with +, oldest first. Each one's thread is its answer.
    #[serde(default)]
    pub questions: Vec<NewQuestion>,
}

impl AnswerState {
    pub fn mark(&mut self, keys: &[String], read: bool, now: i64) {
        for k in keys.iter().map(|k| k.trim()).filter(|k| !k.is_empty()) {
            if read {
                self.read.insert(k.to_string(), now);
            } else {
                self.read.remove(k);
            }
        }
    }

    pub fn link_thread(&mut self, key: &str, thread_id: &str) {
        self.threads.insert(key.to_string(), thread_id.to_string());
    }

    pub fn add_question(&mut self, thread_id: &str, now: i64) {
        if self.questions.iter().any(|q| q.thread_id == thread_id) {
            return;
        }
        self.questions.push(NewQuestion { thread_id: thread_id.to_string(), asked_at: now });
    }

    /// The thread an answer's follow-ups go to: a + question is its own thread,
    /// unless that thread was deleted and a fresh one linked in its place.
    pub fn thread_of(&self, key: &str) -> Option<String> {
        if let Some(linked) = self.threads.get(key) {
            return Some(linked.clone());
        }
        key.strip_prefix("ask:").map(str::to_string)
    }
}

fn file_for(chat_session_id: &str) -> Result<PathBuf> {
    let safe: String = chat_session_id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    Ok(super::store::ask_dir()?.join(format!("{safe}.answers.json")))
}

/// A file that does not parse is moved aside as `.bad` rather than read as
/// empty and then overwritten, so a bad write never silently unreads a chat.
pub fn load_from(path: &Path) -> AnswerState {
    let Ok(bytes) = std::fs::read(path) else { return AnswerState::default() };
    match serde_json::from_slice(&bytes) {
        Ok(s) => s,
        Err(e) => {
            log::warn!("answer state {} unreadable, kept as .bad: {e}", path.display());
            let _ = std::fs::rename(path, path.with_extension("json.bad"));
            AnswerState::default()
        }
    }
}

pub fn save_to(path: &Path, state: &AnswerState) -> Result<()> {
    let json = serde_json::to_string_pretty(state).context("serialize answer state")?;
    crate::util::write_json_atomic(path, &json).with_context(|| format!("write {}", path.display()))?;
    Ok(())
}

/// Serializes every read-modify-write: a thread reply landing links its thread
/// while a Got it on another answer may be saving.
static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

pub fn load(chat_session_id: &str) -> AnswerState {
    match file_for(chat_session_id) {
        Ok(p) => load_from(&p),
        Err(_) => AnswerState::default(),
    }
}

/// Applies `f` to the stored state and saves it, returning the new state.
pub fn update(chat_session_id: &str, f: impl FnOnce(&mut AnswerState)) -> Result<AnswerState> {
    let _guard = LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let path = file_for(chat_session_id)?;
    let mut state = load_from(&path);
    f(&mut state);
    save_to(&path, &state)?;
    Ok(state)
}

pub fn drop_for_chat(chat_session_id: &str) {
    if let Ok(path) = file_for(chat_session_id) {
        let _ = std::fs::remove_file(path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_state_round_trips_through_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.answers.json");
        let mut s = AnswerState::default();
        s.mark(&["toolu_1".into(), "toolu_2".into()], true, 100);
        s.link_thread("toolu_2", "th-a");
        s.add_question("th-b", 200);
        save_to(&path, &s).unwrap();

        let back = load_from(&path);
        assert_eq!(back, s);
        assert_eq!(back.read.get("toolu_1"), Some(&100));
        assert_eq!(back.thread_of("toolu_2").as_deref(), Some("th-a"));
        assert_eq!(back.thread_of(&question_key("th-b")).as_deref(), Some("th-b"));
        assert_eq!(back.thread_of("toolu_1"), None);
    }

    #[test]
    fn a_relinked_question_thread_wins_over_its_own_id() {
        let mut s = AnswerState::default();
        assert_eq!(s.thread_of("ask:old").as_deref(), Some("old"));
        s.link_thread("ask:old", "fresh");
        assert_eq!(s.thread_of("ask:old").as_deref(), Some("fresh"));
    }

    #[test]
    fn unmark_removes_and_blank_keys_are_ignored() {
        let mut s = AnswerState::default();
        s.mark(&["a".into(), "  ".into()], true, 5);
        assert_eq!(s.read.len(), 1);
        s.mark(&["a".into()], false, 6);
        assert!(s.read.is_empty());
    }

    #[test]
    fn a_question_is_added_once() {
        let mut s = AnswerState::default();
        s.add_question("t", 1);
        s.add_question("t", 2);
        assert_eq!(s.questions, vec![NewQuestion { thread_id: "t".into(), asked_at: 1 }]);
    }

    #[test]
    fn a_missing_file_is_empty_and_a_bad_one_is_kept_aside() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("x.answers.json");
        assert_eq!(load_from(&path), AnswerState::default());
        std::fs::write(&path, "{not json").unwrap();
        assert_eq!(load_from(&path), AnswerState::default());
        assert!(!path.exists());
        assert!(dir.path().join("x.answers.json.bad").exists());
    }

    #[test]
    fn an_older_file_without_newer_fields_still_reads() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("o.answers.json");
        std::fs::write(&path, r#"{"read":{"k":7}}"#).unwrap();
        let s = load_from(&path);
        assert_eq!(s.read.get("k"), Some(&7));
        assert!(s.threads.is_empty() && s.questions.is_empty());
    }
}
