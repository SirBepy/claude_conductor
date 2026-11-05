//! Joe's follow-up to a sub that was busy when `subchat send` reached it.
//!
//! The text is held in the daemon's draft store so the sub's next tool batch
//! picks it up (`hooks_server::nudge`), and a loop (`tool::flush_when_idle`)
//! delivers it when the sub goes idle. Both live in memory, and the tool answers
//! "Passed to X" the moment the text is held, so a restart or a long wait would
//! lose words Joe was told had arrived. This module keeps a second copy on disk
//! until the text is delivered:
//!
//! - `<data_dir>/subchats/<sub_id>.held.jsonl`, one line per held message.
//! - [`restore`] re-holds what is left at boot and starts the same loop again,
//!   which has no timeout while the sub lives.
//! - A sub that ends with text still undelivered raises a card in its main chat
//!   carrying that text, so Joe can send it again. Nothing is dropped silently.
//!
//! A line leaves the file only when its text is delivered (the loop, or the
//! mid-turn hook via [`settle_many`]), is gone from the draft store (Joe cleared
//! it, or a window took it), or went into a card.

use super::cards::{self, CardOption, RaisedCard};
use super::decisions::{data_root, file_stem};
use crate::daemon::state::DaemonState;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

/// `card_kind` of the note raised for text a sub never received.
pub const KIND: &str = "subchat_undelivered";
pub const GOT_IT: &str = "Got it";

/// The longest text a card shows. Joe's own words are kept whole up to this; a
/// pasted wall of text is cut with a note rather than filling the card.
const CARD_TEXT_CAP: usize = 1500;

/// One held message.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct Held {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub text: String,
}

/// Serializes the read-modify-write of every held file in the process.
static LOCK: Mutex<()> = Mutex::new(());

/// (sub id, draft-store item id) -> held-file line id. The draft store's ids are
/// per process and per sub, so this link is rebuilt at [`restore`] and never saved.
static LINKS: Mutex<Option<HashMap<(String, u64), String>>> = Mutex::new(None);

fn path_in(root: &Path, sub_id: &str) -> PathBuf {
    root.join("subchats").join(format!("{}.held.jsonl", file_stem(sub_id)))
}

pub(crate) fn list_in(root: &Path, sub_id: &str) -> Vec<Held> {
    let Ok(raw) = std::fs::read_to_string(path_in(root, sub_id)) else { return Vec::new() };
    raw.lines().filter_map(|l| serde_json::from_str(l).ok()).collect()
}

fn write_all(root: &Path, sub_id: &str, held: &[Held]) -> std::io::Result<()> {
    let path = path_in(root, sub_id);
    if held.is_empty() {
        let _ = std::fs::remove_file(&path);
        return Ok(());
    }
    let mut text = String::new();
    for h in held {
        text.push_str(&serde_json::to_string(h).map_err(std::io::Error::other)?);
        text.push('\n');
    }
    crate::util::write_json_atomic(&path, &text)
}

/// Stores `text` for `sub_id` and returns the line's id, or `None` when it could
/// not be written (the message is then held in memory only).
pub(crate) fn add_in(root: &Path, sub_id: &str, text: &str) -> Option<String> {
    let _g = LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let mut held = list_in(root, sub_id);
    let id = uuid::Uuid::new_v4().to_string();
    held.push(Held { id: id.clone(), text: text.to_string() });
    match write_all(root, sub_id, &held) {
        Ok(()) => Some(id),
        Err(e) => {
            log::warn!("subchats: could not store a held message for {sub_id}: {e}");
            None
        }
    }
}

/// Removes line `entry` and returns it, `None` when it was already gone. Whoever
/// gets `Some` owns the text, so a card and a delivery cannot both claim it.
pub(crate) fn take_in(root: &Path, sub_id: &str, entry: &str) -> Option<Held> {
    let _g = LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let mut held = list_in(root, sub_id);
    let at = held.iter().position(|h| h.id == entry)?;
    let taken = held.remove(at);
    if let Err(e) = write_all(root, sub_id, &held) {
        log::warn!("subchats: could not update the held messages of {sub_id}: {e}");
    }
    Some(taken)
}

/// Removes and returns every line for `sub_id`.
pub(crate) fn take_all_in(root: &Path, sub_id: &str) -> Vec<Held> {
    let _g = LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let held = list_in(root, sub_id);
    if !held.is_empty() {
        let _ = std::fs::remove_file(path_in(root, sub_id));
    }
    held
}

/// Every sub with a held file.
pub(crate) fn sub_ids_in(root: &Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(root.join("subchats")) else { return Vec::new() };
    entries
        .filter_map(|e| e.ok())
        .filter_map(|e| e.file_name().to_str().and_then(|n| n.strip_suffix(".held.jsonl")).map(str::to_string))
        .collect()
}

fn links() -> std::sync::MutexGuard<'static, Option<HashMap<(String, u64), String>>> {
    LINKS.lock().unwrap_or_else(|p| p.into_inner())
}

/// Stores `text` and returns its line id; empty when it could not be stored or
/// there is no data dir.
pub fn add(sub_id: &str, text: &str) -> String {
    data_root().and_then(|root| add_in(&root, sub_id, text)).unwrap_or_default()
}

/// Ties a draft-store item to its line, so delivering the item settles the line.
pub fn link(sub_id: &str, item_id: u64, entry: &str) {
    if !entry.is_empty() {
        links().get_or_insert_with(HashMap::new).insert((sub_id.to_string(), item_id), entry.to_string());
    }
}

/// The line behind a draft-store item. Empty when it has none.
pub(crate) fn entry_of(sub_id: &str, item_id: u64) -> String {
    links().as_ref().and_then(|m| m.get(&(sub_id.to_string(), item_id)).cloned()).unwrap_or_default()
}

/// Forgets the tie between a draft-store item and its line, which stays.
pub(crate) fn forget_link(sub_id: &str, item_id: u64) {
    if let Some(m) = links().as_mut() {
        m.remove(&(sub_id.to_string(), item_id));
    }
}

/// Drops line `entry` (empty is "none"): its text reached the sub, or is no
/// longer ours to send.
pub(crate) fn settle_entry(sub_id: &str, entry: &str) {
    if entry.is_empty() {
        return;
    }
    if let Some(root) = data_root() {
        take_in(&root, sub_id, entry);
    }
}

/// Claims line `entry` for a card. True when the caller now owns the text: the
/// line was still there, or it never had one (held in memory only).
pub(crate) fn claim_entry(sub_id: &str, entry: &str) -> bool {
    if entry.is_empty() {
        return true;
    }
    data_root().and_then(|root| take_in(&root, sub_id, entry)).is_some()
}

/// The text of a draft-store item reached its sub, or is no longer ours to send:
/// drops its line.
pub fn settle(sub_id: &str, item_id: u64) {
    let entry = entry_of(sub_id, item_id);
    forget_link(sub_id, item_id);
    settle_entry(sub_id, &entry);
}

/// [`settle`] for the items the mid-turn hook just delivered.
pub fn settle_many(sub_id: &str, item_ids: &[u64]) {
    for id in item_ids {
        settle(sub_id, *id);
    }
}

fn quoted(text: &str) -> String {
    let shown: String = text.chars().take(CARD_TEXT_CAP).collect();
    let cut = if text.chars().count() > CARD_TEXT_CAP { "\n> (cut here, the rest was too long for this card)" } else { "" };
    format!("{}{cut}", shown.lines().map(|l| format!("> {l}")).collect::<Vec<_>>().join("\n"))
}

fn parent_of(state: &DaemonState, sub_id: &str) -> Option<String> {
    state
        .registry
        .get(sub_id)
        .and_then(|i| i.subchat_of)
        .or_else(|| crate::sessions::chat_config::get(sub_id).and_then(|c| c.subchat).map(|b| b.parent))
}

fn name_of(state: &DaemonState, sub_id: &str) -> String {
    state
        .registry
        .get(sub_id)
        .as_ref()
        .map(super::tool::label)
        .or_else(|| {
            crate::sessions::chat_config::get(sub_id)
                .and_then(|c| c.subchat)
                .map(|b| b.task.trim().chars().take(40).collect::<String>())
                .filter(|t| !t.is_empty())
        })
        .unwrap_or_else(|| "A sub".to_string())
}

/// Puts the text a sub never received in front of Joe, in its main chat, so he can
/// send it again. True when the card went up. When the main chat is gone too there
/// is no window to show it in, which is logged with the text's length only.
pub async fn raise_undelivered(state: &Arc<DaemonState>, sub_id: &str, texts: &[String]) -> bool {
    if texts.is_empty() {
        return true;
    }
    let Some(parent) = parent_of(state, sub_id) else {
        log::warn!("subchats: {sub_id} ended with {} undelivered message(s) and has no main chat to tell", texts.len());
        return false;
    };
    let body = texts.iter().map(|t| quoted(t)).collect::<Vec<_>>().join("\n\n");
    let n = texts.len();
    let card = RaisedCard {
        kind: KIND,
        display_session_id: parent,
        sub_id: Some(sub_id.to_string()),
        header: "Message not delivered".to_string(),
        question: format!(
            "**{}** ended before it took {}:\n\n{body}\n\nIt was not delivered. Send it again if it still matters.",
            name_of(state, sub_id),
            if n == 1 { "this message of yours" } else { "these messages of yours" },
        ),
        options: vec![CardOption::new(GOT_IT, "Dismiss this note")],
        domain: None,
    };
    match cards::raise_card(state, card).await {
        Ok(_) => true,
        Err(e) => {
            log::warn!("subchats: could not tell the main chat about {n} undelivered message(s) for {sub_id}: {e}");
            false
        }
    }
}

/// The registry just ended `session_id`. If it was a sub with held text still on
/// disk, the text goes to a card. Detached: the hook that calls this is sync.
pub fn on_sub_ended(state: &Arc<DaemonState>, session_id: &str) {
    let Some(root) = data_root() else { return };
    if !path_in(&root, session_id).exists() {
        return;
    }
    let Ok(handle) = tokio::runtime::Handle::try_current() else { return };
    let (state, sub) = (state.clone(), session_id.to_string());
    handle.spawn(async move {
        let texts: Vec<String> = take_all_in(&root, &sub).into_iter().map(|h| h.text).collect();
        raise_undelivered(&state, &sub, &texts).await;
    });
}

/// Boot: gives every held message a way to reach its sub again. A live sub gets
/// the text re-held and its flush loop restarted; text for a sub that ended while
/// the daemon was down goes to a card; text for a sub that became an ordinary chat
/// is held in that chat's own queue, which its window flushes.
pub async fn restore(state: &Arc<DaemonState>) {
    let state_for_resume = state.clone();
    restore_with(state, move |sub_id, text| {
        let state = state_for_resume.clone();
        async move { super::continue_sub(&state, &sub_id, &text).await }
    })
    .await;
}

pub(crate) async fn restore_with<F, Fut>(state: &Arc<DaemonState>, resume: F)
where
    F: Fn(String, String) -> Fut + Clone + Send + Sync + 'static,
    Fut: std::future::Future<Output = Result<(), super::ContinueError>> + Send + 'static,
{
    let Some(root) = data_root() else { return };
    for sub_id in sub_ids_in(&root) {
        let row = state.registry.get(&sub_id);
        let live = row.as_ref().is_some_and(|i| i.ended_at.is_none() && i.end_reason.is_none());
        if live && row.as_ref().is_some_and(super::is_sub) {
            for h in list_in(&root, &sub_id) {
                super::tool::hold_and_flush(state, &sub_id, &h.text, &h.id, resume.clone());
            }
            continue;
        }
        let held = take_all_in(&root, &sub_id);
        if live {
            for h in &held {
                super::tool::hold_plain(state, &sub_id, &h.text);
            }
        } else {
            let texts: Vec<String> = held.into_iter().map(|h| h.text).collect();
            raise_undelivered(state, &sub_id, &texts).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_held_message_is_stored_per_sub_and_taken_once() {
        let dir = tempfile::tempdir().unwrap();
        let a = add_in(dir.path(), "fu-a", "make it sticky").unwrap();
        let b = add_in(dir.path(), "fu-a", "and teal").unwrap();
        add_in(dir.path(), "fu-b", "other sub").unwrap();
        assert_eq!(list_in(dir.path(), "fu-a").iter().map(|h| h.text.as_str()).collect::<Vec<_>>(), ["make it sticky", "and teal"]);
        let mut ids = sub_ids_in(dir.path());
        ids.sort();
        assert_eq!(ids, ["fu-a", "fu-b"]);
        assert_eq!(take_in(dir.path(), "fu-a", &a).unwrap().text, "make it sticky");
        assert!(take_in(dir.path(), "fu-a", &a).is_none(), "whoever took it owns it; a second claim gets nothing");
        assert_eq!(list_in(dir.path(), "fu-a").len(), 1);
        assert_eq!(take_in(dir.path(), "fu-a", &b).unwrap().text, "and teal");
        assert!(!path_in(dir.path(), "fu-a").exists(), "an empty file is removed");
        assert_eq!(take_all_in(dir.path(), "fu-b").len(), 1);
        assert!(sub_ids_in(dir.path()).is_empty());
    }

    #[test]
    fn text_is_kept_word_for_word_across_lines_and_quotes() {
        let dir = tempfile::tempdir().unwrap();
        let text = "line one\n\"quoted\" and \\ backslash\n<file:C:/Users/joe/shot 1.png>";
        add_in(dir.path(), "fu-words", text).unwrap();
        assert_eq!(list_in(dir.path(), "fu-words")[0].text, text);
    }

    #[test]
    fn a_session_id_cannot_leave_the_folder() {
        let dir = tempfile::tempdir().unwrap();
        add_in(dir.path(), "../escape", "x").unwrap();
        assert!(path_in(dir.path(), "../escape").starts_with(dir.path().join("subchats")));
        assert!(!dir.path().join("escape.held.jsonl").exists());
    }

    #[test]
    fn a_card_shows_joes_words_and_cuts_only_a_very_long_paste() {
        assert_eq!(quoted("tabs\nnot spaces"), "> tabs\n> not spaces");
        let long = "x".repeat(CARD_TEXT_CAP + 50);
        let q = quoted(&long);
        assert!(q.contains("cut here") && q.chars().count() < CARD_TEXT_CAP + 100);
    }
}
