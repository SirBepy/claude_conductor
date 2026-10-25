//! What a dev or a chat may store: input rules for card buttons and pinned
//! quick actions. Pure, so they are tested without a store.

use super::store::DashboardStore;
use super::types::{CardAction, CardConfig, CardDisplay};

pub const ACTION_LABEL_MAX_CHARS: usize = 60;
/// Re-sent inside every dashboard snapshot, so it stays a card, not an app.
pub const HTML_TEMPLATE_MAX_BYTES: usize = 64 * 1024;
pub const PINNED_MAX: usize = 20;
/// A slash command line, not a document: longer is a paste gone wrong.
const COMMAND_MAX_CHARS: usize = 200;
/// A card button's prompt is a quick ask, not a spec; the card's own data is
/// appended to it at click time, so it never has to carry any.
pub const ACTION_PROMPT_MAX_CHARS: usize = 1000;

/// Trims and checks a card's button in place: a label to show, and a prompt
/// (a slash command or plain text) that the button sends as a new chat's
/// first message, followed by the card's current data.
pub fn validate_card(card: &mut CardConfig) -> Result<(), String> {
    if let CardDisplay::Html { template } = &card.display {
        if template.trim().is_empty() {
            return Err("display.template is required for an html card".to_string());
        }
        if template.len() > HTML_TEMPLATE_MAX_BYTES {
            return Err(format!("display.template is longer than {} KB", HTML_TEMPLATE_MAX_BYTES / 1024));
        }
    }
    let Some(CardAction { label, command }) = card.action.as_mut() else { return Ok(()) };
    *label = label.trim().to_string();
    *command = command.trim().to_string();
    if label.is_empty() {
        return Err("action.label is required".to_string());
    }
    if label.chars().count() > ACTION_LABEL_MAX_CHARS {
        return Err(format!("action.label is longer than {ACTION_LABEL_MAX_CHARS} characters"));
    }
    if command.is_empty() || command == "/" {
        return Err("action.command is required: a slash command like /sync or a short prompt".to_string());
    }
    if command.chars().count() > ACTION_PROMPT_MAX_CHARS {
        return Err(format!("action.command is longer than {ACTION_PROMPT_MAX_CHARS} characters"));
    }
    Ok(())
}

/// Normalises a pinned quick-action list: trimmed, each a slash command,
/// duplicates dropped (first wins, order kept), at most `PINNED_MAX`. `/close`
/// is refused because a one-click chip that ends the chat it launches from is
/// never what pinning means.
pub fn normalize_pinned(actions: Vec<String>) -> Result<Vec<String>, String> {
    let mut out: Vec<String> = Vec::new();
    for raw in actions {
        let a = raw.trim().to_string();
        if !a.starts_with('/') || a.len() < 2 {
            return Err(format!("{a:?} is not a slash command (must start with /)"));
        }
        if a.chars().count() > COMMAND_MAX_CHARS {
            return Err(format!("a pinned command is longer than {COMMAND_MAX_CHARS} characters"));
        }
        if a.split_whitespace().next().is_some_and(|w| w.eq_ignore_ascii_case("/close")) {
            return Err("/close cannot be pinned".to_string());
        }
        if !out.contains(&a) {
            out.push(a);
        }
    }
    if out.len() > PINNED_MAX {
        return Err(format!("at most {PINNED_MAX} pinned actions"));
    }
    Ok(out)
}

impl DashboardStore {
    /// Replaces a scope's pinned quick actions with the normalised list; an
    /// empty list removes the entry so "none pinned" stores nothing.
    pub fn set_pinned_actions(&mut self, scope_key: &str, actions: Vec<String>) -> Result<Vec<String>, String> {
        let actions = normalize_pinned(actions)?;
        if actions.is_empty() {
            self.pinned_actions.remove(scope_key);
        } else {
            self.pinned_actions.insert(scope_key.to_string(), actions.clone());
        }
        Ok(actions)
    }

    pub fn pinned_for(&self, scope_key: &str) -> Vec<String> {
        self.pinned_actions.get(scope_key).cloned().unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn with_action(label: &str, command: &str) -> CardConfig {
        CardConfig { action: Some(CardAction { label: label.into(), command: command.into() }), ..Default::default() }
    }

    #[test]
    fn an_html_card_needs_a_template_within_the_cap() {
        let html = |t: String| CardConfig { display: CardDisplay::Html { template: t }, ..Default::default() };
        assert!(validate_card(&mut html("<b>hi</b>".into())).is_ok());
        assert!(validate_card(&mut html("  ".into())).unwrap_err().contains("template is required"));
        assert!(validate_card(&mut html("x".repeat(HTML_TEMPLATE_MAX_BYTES + 1))).unwrap_err().contains("longer than"));
    }

    #[test]
    fn no_action_is_fine() {
        assert!(validate_card(&mut CardConfig::default()).is_ok());
    }

    #[test]
    fn a_good_action_is_trimmed() {
        let mut c = with_action("  Log time ", " /clockify-log ");
        validate_card(&mut c).unwrap();
        assert_eq!(c.action, Some(CardAction { label: "Log time".into(), command: "/clockify-log".into() }));
    }

    #[test]
    fn a_plain_prompt_is_a_valid_action() {
        let mut c = with_action("Triage", " Which of these need me today? ");
        validate_card(&mut c).unwrap();
        assert_eq!(c.action.unwrap().command, "Which of these need me today?");
        assert!(validate_card(&mut with_action("ok", &"p".repeat(ACTION_PROMPT_MAX_CHARS))).is_ok());
    }

    #[test]
    fn bad_actions_are_refused() {
        assert!(validate_card(&mut with_action("", "/x")).is_err());
        assert!(validate_card(&mut with_action("   ", "/x")).is_err());
        assert!(validate_card(&mut with_action("ok", "/")).is_err());
        assert!(validate_card(&mut with_action("ok", "")).is_err());
        assert!(validate_card(&mut with_action("ok", "  ")).is_err());
        assert!(validate_card(&mut with_action("ok", &"p".repeat(ACTION_PROMPT_MAX_CHARS + 1))).is_err());
        assert!(validate_card(&mut with_action(&"l".repeat(61), "/x")).is_err());
        assert!(validate_card(&mut with_action(&"l".repeat(60), "/x")).is_ok());
    }

    #[test]
    fn pinned_actions_are_trimmed_deduped_and_keep_order() {
        let got = normalize_pinned(vec![" /commit ".into(), "/test".into(), "/commit".into(), "/review src".into()]).unwrap();
        assert_eq!(got, ["/commit", "/test", "/review src"]);
        assert!(normalize_pinned(vec![]).unwrap().is_empty());
    }

    #[test]
    fn pinned_actions_must_be_slash_commands() {
        assert!(normalize_pinned(vec!["commit".into()]).is_err());
        assert!(normalize_pinned(vec!["".into()]).is_err());
        assert!(normalize_pinned(vec!["/".into()]).is_err());
    }

    #[test]
    fn close_is_refused_even_with_arguments_or_case() {
        assert!(normalize_pinned(vec!["/close".into()]).is_err());
        assert!(normalize_pinned(vec!["/CLOSE now".into()]).is_err());
        assert!(normalize_pinned(vec!["/closer".into()]).is_ok(), "only the exact command is refused");
    }

    #[test]
    fn at_most_twenty_after_dedupe() {
        let twenty: Vec<String> = (0..20).map(|i| format!("/c{i}")).collect();
        assert_eq!(normalize_pinned(twenty.clone()).unwrap().len(), 20);
        let mut over = twenty.clone();
        over.push("/c20".into());
        assert!(normalize_pinned(over).is_err());
        let mut dup = twenty;
        dup.push("/c3".into());
        assert_eq!(normalize_pinned(dup).unwrap().len(), 20, "a duplicate does not count");
    }

    #[test]
    fn pinned_actions_set_replace_and_clear() {
        let mut s = DashboardStore::default();
        let got = s.set_pinned_actions("group:g", vec![" /a ".into(), "/b".into(), "/a".into()]).unwrap();
        assert_eq!(got, ["/a", "/b"]);
        assert_eq!(s.pinned_for("group:g"), ["/a", "/b"]);
        assert!(s.pinned_for("group:other").is_empty());
        s.set_pinned_actions("group:g", vec!["/c".into()]).unwrap();
        assert_eq!(s.pinned_for("group:g"), ["/c"]);
        s.set_pinned_actions("group:g", vec![]).unwrap();
        assert!(s.pinned_actions.is_empty(), "an empty list stores nothing");
    }

    #[test]
    fn a_rejected_pin_list_leaves_the_stored_one_alone() {
        let mut s = DashboardStore::default();
        s.set_pinned_actions("group:g", vec!["/a".into()]).unwrap();
        assert!(s.set_pinned_actions("group:g", vec!["/close".into()]).is_err());
        assert!(s.set_pinned_actions("group:g", vec!["nope".into()]).is_err());
        assert_eq!(s.pinned_for("group:g"), ["/a"]);
    }
}
