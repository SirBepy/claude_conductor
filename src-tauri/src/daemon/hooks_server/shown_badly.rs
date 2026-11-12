//! Append-only record of cards that showed Joe data badly, at
//! `<data_dir>/shown-badly.jsonl`, so they get fixed in batches. Two sources
//! write here:
//!
//! - `joe`: the "Shown badly" item of a send_message card's right-click menu
//!   (a long-press on the phone), through the `flag_shown_badly` RPC
//!   (`methods/registry/shown_badly.rs`), with an optional note in his words.
//! - `claude`: `send_message`'s optional `unsure_how_to_show`, filled when the
//!   chat was not sure which kind, visual or card fits the data. The message is
//!   still sent; the reason becomes the note.
//!
//! Each line keeps the card's send_message input as the chat had it, so a later
//! batch can redraw or re-judge it without the transcript. Rotation and the test
//! root are `rejected_sends`'s, and `scripts/release-report.ps1` groups this file
//! since the last `VERSION:` commit next to the rejected sends.

use crate::daemon::state::DaemonState;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

const FILE: &str = "shown-badly.jsonl";

/// Joe's note and Claude's reason: a sentence, never an essay, since the card
/// itself is in the record already.
pub(crate) const MAX_NOTE: usize = 500;

/// A card's whole send_message input, details included, stays far under this;
/// past it the caller is not sending a card.
pub(crate) const MAX_MESSAGE_BYTES: usize = 64 * 1024;

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum Source {
    Joe,
    Claude,
}

impl Source {
    fn as_str(self) -> &'static str {
        match self {
            Source::Joe => "joe",
            Source::Claude => "claude",
        }
    }
}

fn path_in(root: &Path) -> PathBuf {
    root.join(FILE)
}

/// Records one card. `message` is its send_message input (kind, verdict, text,
/// ...); the chat's title and project come from this daemon's instances (a
/// mirrored peer chat included), never from the caller. Never fails the caller:
/// a log that cannot be written only costs the record.
pub(crate) fn record(state: &DaemonState, source: Source, session_id: &str, message_id: Option<&str>, message: Value, note: &str) {
    let inst = state.registry.get(session_id).or_else(|| {
        crate::daemon::machines::all_instances(state).into_iter().find(|i| i.session_id == session_id)
    });
    let line = json!({
        "at": chrono::Utc::now().to_rfc3339(),
        "source": source.as_str(),
        "session_id": session_id,
        "chat_title": inst.as_ref().and_then(|i| i.name.clone()),
        "project": inst.as_ref().map(|i| i.project_id.clone()),
        "kind": message.get("kind").and_then(Value::as_str),
        "message_id": message_id,
        "note": note.trim(),
        "message": message,
    });
    let Some(root) = super::rejected_sends::log_root() else { return };
    if let Err(e) = super::rejected_sends::append_rotating(&path_in(&root), &line) {
        log::warn!("shown-badly: could not write the record: {e}");
    }
}

/// Test-only: the records written under `root`, oldest first.
#[cfg(test)]
pub(crate) fn read_records(root: &Path) -> Vec<Value> {
    let raw = std::fs::read_to_string(path_in(root)).unwrap_or_default();
    raw.lines().map(|l| serde_json::from_str(l).unwrap()).collect()
}

#[cfg(test)]
pub(crate) use super::rejected_sends::capture_in;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::types::Settings;

    fn state() -> std::sync::Arc<DaemonState> {
        DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()))
    }

    #[test]
    fn a_record_carries_the_card_the_chat_and_the_note() {
        let dir = tempfile::tempdir().unwrap();
        let _capture = capture_in(dir.path());
        let st = state();
        st.registry.upsert_interactive("sb1", Path::new("."), "proj", "2026-11-11T00:00:00Z");
        record(&st, Source::Joe, "sb1", Some("toolu_1"), json!({"kind": "blocker", "text": "x"}), "  two cards, one label  ");
        let rows = read_records(dir.path());
        assert_eq!(rows.len(), 1);
        let r = &rows[0];
        assert_eq!(r["source"], "joe");
        assert_eq!(r["kind"], "blocker");
        assert_eq!(r["project"], "proj");
        assert_eq!(r["message_id"], "toolu_1");
        assert_eq!(r["note"], "two cards, one label");
        assert_eq!(r["message"]["text"], "x");
        assert!(r.get("chat_title").is_some(), "the title key is always written, null when the chat has none");
    }

    #[test]
    fn an_unknown_chat_is_still_recorded() {
        let dir = tempfile::tempdir().unwrap();
        let _capture = capture_in(dir.path());
        record(&state(), Source::Claude, "gone", None, json!({"kind": "answer"}), "");
        let rows = read_records(dir.path());
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["source"], "claude");
        assert!(rows[0]["project"].is_null());
    }
}
