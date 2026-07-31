use std::io::{BufRead, BufReader};
use std::path::Path;

use super::title::{
    assistant_text, extract_cc_title, is_real_user_turn, is_titleable_user_turn,
    normalise_and_truncate, user_prompt_label, TITLE_MILESTONES,
};

// Keep in sync with title.rs's session_title precedence (last_override_title >
// ai_milestone_title > first_user_prompt) - this is a one-pass reimplementation.

/// Combined per-transcript scan result for building a `HistoryEntry` in one
/// file read: resolved title (same override > milestone > first-prompt
/// precedence as `session_title`), last-seen model, and the last
/// `<cc-status:..>` marker seen.
#[derive(Debug, Clone, Default)]
pub struct TranscriptScan {
    pub title: Option<String>,
    pub model: Option<String>,
    pub last_status: Option<String>,
}

/// One forward pass computing everything a History row needs, so listing past
/// sessions never opens a transcript twice per entry. Folds
/// `last_override_title`'s tail-only fast path into the same full scan
/// `ai_milestone_title` already does — needed anyway now that model/status
/// also require one, so the tail shortcut no longer saves a read.
pub fn scan_transcript(path: &Path, max_chars: usize) -> TranscriptScan {
    let mut out = TranscriptScan::default();
    let Ok(file) = std::fs::File::open(path) else { return out };
    let reader = BufReader::new(file);

    let mut turn = 0usize;
    let mut latest_marker: Option<String> = None;
    let mut milestone_title: Option<String> = None;
    let mut first_prompt: Option<String> = None;
    let mut system_model: Option<String> = None;

    for line in reader.lines().map_while(|r| r.ok()) {
        if line.trim().is_empty() { continue }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
        let ty = v.get("type").and_then(|t| t.as_str());

        // Sticky human override, last non-blank wins (mirrors last_override_title,
        // just observed forward instead of via a separate tail read).
        match ty {
            Some("custom-title") => {
                if let Some(s) = v.get("customTitle").and_then(|s| s.as_str()).filter(|s| !s.trim().is_empty()) {
                    out.title = normalise_and_truncate(s, max_chars);
                }
            }
            Some("agent-name") => {
                if let Some(s) = v.get("agentName").and_then(|s| s.as_str()).filter(|s| !s.trim().is_empty()) {
                    out.title = normalise_and_truncate(s, max_chars);
                }
            }
            Some("system") if system_model.is_none()
                && v.get("subtype").and_then(|s| s.as_str()) == Some("init") =>
            {
                system_model = v.get("model").and_then(|s| s.as_str()).filter(|s| !s.is_empty()).map(String::from);
            }
            _ => {}
        }

        if turn == 0 && first_prompt.is_none() && is_real_user_turn(&v) {
            if let Some(msg) = v.get("message") {
                first_prompt = user_prompt_label(msg, max_chars);
            }
        }

        if is_titleable_user_turn(&v) {
            if TITLE_MILESTONES.contains(&turn) { milestone_title = latest_marker.clone(); }
            turn += 1;
            continue;
        }
        if let Some(text) = assistant_text(&v) {
            if let Some(t) = extract_cc_title(&text) {
                if !t.trim().is_empty() { latest_marker = Some(t); }
            }
            if let Some(status) = crate::chat::markers::detect_awaiting(&text) {
                out.last_status = Some(status);
            }
        }
        if ty == Some("assistant") {
            if let Some(m) = v.get("message").and_then(|m| m.get("model")).and_then(|s| s.as_str()).filter(|s| !s.is_empty()) {
                out.model = Some(m.to_string());
            }
        }
    }
    if TITLE_MILESTONES.contains(&turn) { milestone_title = latest_marker.clone(); }

    if out.title.is_none() {
        out.title = milestone_title.or(latest_marker)
            .and_then(|t| normalise_and_truncate(&t, max_chars))
            .or(first_prompt);
    }
    out.model = out.model.or(system_model);
    out
}
