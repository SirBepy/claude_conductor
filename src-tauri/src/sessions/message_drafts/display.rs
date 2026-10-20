//! Pure lookups and display helpers over a draft: no store access, so the
//! mutation module stays about writes.

use super::types::{DraftAuthor, DraftVariant};

/// The newest version this variant got from the AI, which is what a user edit
/// diverged FROM - the other half of the diff the injected block carries.
pub fn last_ai_body(variant: &DraftVariant) -> &str {
    variant
        .versions
        .iter()
        .rev()
        .find(|v| v.author == DraftAuthor::Ai)
        .map(|v| v.body.as_str())
        .unwrap_or("")
}

/// Platforms read off a free-text recipient, first match wins. Discord sits
/// before the Claude-chat catch-all because "Server chat / Discord" is a
/// Discord channel, not another Claude chat. "Prompts" is a prompt the user
/// pastes into another Claude chat.
const PLATFORM_KEYWORDS: &[(&[&str], &str)] = &[
    (&["discord"], "Discord"),
    (&["slack"], "Slack"),
    (&["shortcut", "sc-"], "Shortcut"),
    (&["linear"], "Linear"),
    (&["github", "pull request"], "GitHub"),
    (&["email", "e-mail", "gmail"], "Email"),
    (&["standup"], "Standup"),
    (&["prompt", "claude", "chat"], "Prompts"),
];

/// What the Prompts platform was called before; drafts written then still
/// carry it on disk.
const LEGACY_PROMPTS: &str = "Claude chats";

/// A stored platform name as the panel should show it.
pub fn canonical_platform(platform: &str) -> &str {
    if platform == LEGACY_PROMPTS { "Prompts" } else { platform }
}

/// Where a draft written before `platform` was recorded gets posted, read off
/// its text. Only Shortcut leaves a trace: a member mention pasted as a
/// `shortcutapp://` link, or a leading `@name` on a draft whose topic names an
/// `sc-` ticket. A draft that only mentions a ticket (a Slack DM about sc-56160)
/// is not a Shortcut comment.
pub fn infer_platform_from_body(topic: &str, body: &str) -> Option<&'static str> {
    if body.contains("shortcutapp://") {
        return Some("Shortcut");
    }
    let mentions_first = body.trim_start().starts_with('@');
    let lower = topic.to_lowercase();
    let names_ticket = lower
        .match_indices("sc-")
        .any(|(i, m)| lower[i + m.len()..].starts_with(|c: char| c.is_ascii_digit()));
    (mentions_first && names_ticket).then_some("Shortcut")
}

/// Best guess at where a draft goes, from recipient text like "Shortcut
/// ticket sc-56117" or "Tajana (Linear comment on REV-7345)". `None` for a
/// plain name.
pub fn infer_platform(recipient: &str) -> Option<&'static str> {
    let text = recipient.to_lowercase();
    PLATFORM_KEYWORDS
        .iter()
        .find(|(words, _)| words.iter().any(|w| text.contains(w)))
        .map(|(_, platform)| *platform)
}

/// "Bruno #2". The speakable id the injected block and the panel both use.
pub fn handle_of(variant: &DraftVariant) -> String {
    format!("{} #{}", variant.recipient, variant.handle_n)
}

/// The version the card is currently showing for this variant.
pub fn current_body(variant: &DraftVariant) -> &str {
    variant
        .versions
        .iter()
        .find(|v| v.n == variant.current)
        .or_else(|| variant.versions.last())
        .map(|v| v.body.as_str())
        .unwrap_or("")
}
