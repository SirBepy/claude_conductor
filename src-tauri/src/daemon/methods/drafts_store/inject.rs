//! The per-turn `UserPromptSubmit` injection block: what's open, what the user
//! edited since the authoring session's last turn, and marking it served.

use super::publish_changed;
use crate::daemon::methods::channel::caller_project;
use crate::daemon::state::DaemonState;
use crate::sessions::message_drafts::{self as store, DraftState, MessageDraft};
use std::sync::Arc;

/// Hard ceiling on injected cards: this text is rebuilt every turn.
const MAX_INJECTED: usize = 12;
/// Cards whose full before/after bodies ride along after a user edit. Beyond
/// this the block names them and stops, rather than growing without bound.
const MAX_DIFFED: usize = 2;
const DIFF_EXCERPT: usize = 600;
const SHORT_ID_LEN: usize = 8;

fn short(id: &str) -> String {
    id.chars().take(SHORT_ID_LEN).collect()
}

fn excerpt(body: &str) -> String {
    let cut: String = body.chars().take(DIFF_EXCERPT).collect();
    if cut.chars().count() < body.chars().count() {
        format!("{cut}...")
    } else {
        cut
    }
}

fn open_line(d: &MessageDraft, viewer_session_id: &str) -> String {
    let handles: Vec<String> = d.variants.iter().map(store::handle_of).collect();
    let scope = if d.origin_session_id == viewer_session_id {
        String::new()
    } else {
        format!(" (chat: {})", d.origin_label)
    };
    format!("- [{}] {} - {}{scope}", handles.join(", "), d.topic, short(&d.id))
}

/// The per-turn `UserPromptSubmit` block, or None when there is nothing open
/// and nothing edited. Callers MUST treat rendering as consumption: `mark_seen`
/// runs in the same daemon call, so an edit is reported exactly once.
pub(crate) fn render_for_injection(state: &Arc<DaemonState>, session_id: &str) -> Option<String> {
    let project_id = caller_project(state, session_id).ok()?;
    let drafts = store::list(&project_id);

    let open: Vec<&MessageDraft> = drafts.iter().filter(|d| d.state != DraftState::Copied).collect();
    let edited: Vec<&MessageDraft> = drafts
        .iter()
        .filter(|d| !d.seen_by_origin && d.origin_session_id == session_id)
        .collect();
    if open.is_empty() && edited.is_empty() {
        return None;
    }

    let mut out = String::from(
        "[drafts] Message drafts you wrote for the user to send somewhere else, living in this \
         project's Drafts panel. Never paste a draft message into chat - write it there with the \
         `write_draft` tool (add|revise|variant|drop) and refer to it by its handle.\n",
    );
    if !open.is_empty() {
        out.push_str(&format!("Open ({}):\n", open.len()));
        for d in open.iter().take(MAX_INJECTED) {
            out.push_str(&open_line(d, session_id));
            out.push('\n');
        }
        if open.len() > MAX_INJECTED {
            out.push_str(&format!("...and {} more.\n", open.len() - MAX_INJECTED));
        }
    }
    if !edited.is_empty() {
        out.push_str(
            "He edited these himself since your last turn. Read what he changed and carry that \
             preference into every later draft; do not revert it.\n",
        );
        for d in edited.iter().take(MAX_DIFFED) {
            for v in &d.variants {
                let mine = store::last_ai_body(v);
                let theirs = store::current_body(v);
                if mine == theirs {
                    continue;
                }
                out.push_str(&format!("[{}] {}\n", store::handle_of(v), d.topic));
                out.push_str(&format!("  yours: {}\n", excerpt(mine)));
                out.push_str(&format!("  his:   {}\n", excerpt(theirs)));
            }
        }
        if edited.len() > MAX_DIFFED {
            let rest: Vec<String> = edited
                .iter()
                .skip(MAX_DIFFED)
                .flat_map(|d| d.variants.iter().map(store::handle_of))
                .collect();
            out.push_str(&format!("Also edited, not shown: {}.\n", rest.join(", ")));
        }
    }
    Some(out)
}

/// Flips this session's edited cards back to seen. The injection hook calls it
/// in the same request that serves the block.
pub(crate) fn mark_drafts_seen(state: &Arc<DaemonState>, session_id: &str) -> usize {
    let Ok(project_id) = caller_project(state, session_id) else { return 0 };
    let flipped = store::mark_seen(&project_id, session_id);
    if flipped > 0 {
        publish_changed(state, &project_id);
    }
    flipped
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sessions::message_drafts::{DraftAuthor, DraftVariant, DraftVersion};

    fn variant(recipient: &str, n: u32, bodies: &[(&str, DraftAuthor)]) -> DraftVariant {
        let versions: Vec<DraftVersion> = bodies
            .iter()
            .enumerate()
            .map(|(i, (body, author))| DraftVersion {
                n: i as u32 + 1,
                body: (*body).to_string(),
                author: *author,
                note: String::new(),
                created_at: "2026-08-26T00:00:00Z".to_string(),
            })
            .collect();
        let current = versions.len() as u32;
        DraftVariant { recipient: recipient.to_string(), handle_n: n, versions, current }
    }

    fn draft(variants: Vec<DraftVariant>) -> MessageDraft {
        MessageDraft {
            id: "abcdef1234-5678".to_string(),
            topic: "Sprint slip".to_string(),
            brief: String::new(),
            receipts: vec![],
            variants,
            state: DraftState::NeedsYou,
            origin_session_id: "s1".to_string(),
            origin_label: "chat A".to_string(),
            created_at: "2026-08-26T00:00:00Z".to_string(),
            updated_at: "2026-08-26T00:00:00Z".to_string(),
            seen_by_origin: true,
        }
    }

    #[test]
    fn open_line_marks_another_chats_card_but_not_your_own() {
        let d = draft(vec![variant("Bruno", 2, &[("hey", DraftAuthor::Ai)])]);
        assert_eq!(open_line(&d, "s1"), "- [Bruno #2] Sprint slip - abcdef12");
        assert!(open_line(&d, "s2").ends_with("(chat: chat A)"));
    }

    #[test]
    fn open_line_lists_every_recipient_handle() {
        let d = draft(vec![
            variant("Bruno", 2, &[("technical", DraftAuthor::Ai)]),
            variant("Ana", 1, &[("plain", DraftAuthor::Ai)]),
        ]);
        assert!(open_line(&d, "s1").starts_with("- [Bruno #2, Ana #1]"), "got {}", open_line(&d, "s1"));
    }

    #[test]
    fn excerpt_only_marks_truncation_when_it_truncated() {
        assert_eq!(excerpt("short"), "short");
        let long = "y".repeat(DIFF_EXCERPT + 10);
        let cut = excerpt(&long);
        assert!(cut.ends_with("..."));
        assert_eq!(cut.chars().count(), DIFF_EXCERPT + 3);
    }
}
