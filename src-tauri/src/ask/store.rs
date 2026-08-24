//! Per-chat Ask thread store: `<data>/ask/<chat_session_id>.json`.
//! Keyed by the CHAT's session id, not the sidecar's, so dropping a deleted
//! chat's threads is one unlink.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, ts_rs::TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct AskMessage {
    /// `"user"` or `"assistant"`.
    pub role: String,
    pub text: String,
    pub ts: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, ts_rs::TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct AskThread {
    pub id: String,
    /// Auto-titled from the first question; the index shows this.
    pub title: String,
    pub created_at: i64,
    pub updated_at: i64,
    /// The sidecar's own `claude` session id, so a follow-up can `--resume` it.
    /// `None` until the first answer comes back.
    pub sidecar_session_id: Option<String>,
    pub messages: Vec<AskMessage>,
}

impl AskThread {
    pub fn new(id: String, now: i64) -> Self {
        Self {
            id,
            title: String::new(),
            created_at: now,
            updated_at: now,
            sidecar_session_id: None,
            messages: Vec::new(),
        }
    }
}

pub fn ask_dir() -> Result<PathBuf> {
    let dir = crate::settings::paths::data_dir()?.join("ask");
    std::fs::create_dir_all(&dir).context("create ask dir")?;
    Ok(dir)
}

/// Sanitised so a hostile/odd session id can't escape the ask dir.
fn file_for(chat_session_id: &str) -> Result<PathBuf> {
    let safe: String = chat_session_id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    Ok(ask_dir()?.join(format!("{safe}.json")))
}

pub fn load(chat_session_id: &str) -> Vec<AskThread> {
    let Ok(path) = file_for(chat_session_id) else { return Vec::new() };
    let Ok(bytes) = std::fs::read(&path) else { return Vec::new() };
    serde_json::from_slice(&bytes).unwrap_or_default()
}

pub fn save(chat_session_id: &str, threads: &[AskThread]) -> Result<()> {
    let path = file_for(chat_session_id)?;
    let json = serde_json::to_vec_pretty(threads).context("serialize ask threads")?;
    std::fs::write(&path, json).with_context(|| format!("write {}", path.display()))?;
    Ok(())
}

/// Drops every thread for a chat. Called when the chat itself is deleted.
pub fn drop_for_chat(chat_session_id: &str) {
    if let Ok(path) = file_for(chat_session_id) {
        let _ = std::fs::remove_file(path);
    }
}

pub fn delete_thread(chat_session_id: &str, thread_id: &str) -> Result<Vec<AskThread>> {
    let mut threads = load(chat_session_id);
    threads.retain(|t| t.id != thread_id);
    save(chat_session_id, &threads)?;
    Ok(threads)
}

/// First line of the first question, clipped. Used as the index label.
pub fn title_from(question: &str) -> String {
    let line = question.lines().find(|l| !l.trim().is_empty()).unwrap_or("").trim();
    let mut out: String = line.chars().take(60).collect();
    if line.chars().count() > 60 {
        out.push_str("...");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn title_from_clips_and_skips_blank_lines() {
        assert_eq!(title_from("\n\nwhat was i meant to do here\nmore"), "what was i meant to do here");
        let long = "x".repeat(80);
        let t = title_from(&long);
        assert_eq!(t.chars().count(), 63);
        assert!(t.ends_with("..."));
    }

    #[test]
    fn title_from_empty_is_empty() {
        assert_eq!(title_from("   \n  "), "");
    }

    #[test]
    fn file_for_rejects_path_traversal() {
        let p = file_for("../../etc/passwd").unwrap();
        assert_eq!(p.parent(), Some(ask_dir().unwrap().as_path()));
        assert!(!p.to_string_lossy().contains(".."));
    }

    #[test]
    fn load_missing_chat_is_empty_not_error() {
        assert!(load("no-such-session-id-12345").is_empty());
    }
}
