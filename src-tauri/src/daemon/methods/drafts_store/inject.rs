//! The per-turn `UserPromptSubmit` injection block: what's open, what the user
//! edited since the authoring session's last turn, and marking it served.

use super::publish_changed;
use crate::daemon::methods::channel::caller_project;
use crate::daemon::methods::injection_util::{append_capped, short};
use crate::daemon::state::DaemonState;
use crate::sessions::message_drafts::{self as store, DraftState, MessageDraft};
use std::sync::Arc;

/// Hard ceiling on injected cards: this text is rebuilt every turn.
const MAX_INJECTED: usize = 12;
/// Cards whose full before/after bodies ride along after a user edit. Beyond
/// this the block names them and stops, rather than growing without bound.
const MAX_DIFFED: usize = 2;
const DIFF_EXCERPT: usize = 600;

fn excerpt(body: &str) -> String {
    let cut: String = body.chars().take(DIFF_EXCERPT).collect();
    if cut.chars().count() < body.chars().count() {
        format!("{cut}...")
    } else {
        cut
    }
}

fn open_line(d: &MessageDraft) -> String {
    let handles: Vec<String> = d.variants.iter().map(store::handle_of).collect();
    format!("- [{}] {} - {}", handles.join(", "), d.topic, short(&d.id))
}

/// The per-turn `UserPromptSubmit` block, or None when this chat has nothing
/// open and nothing edited. Callers MUST treat rendering as consumption:
/// `mark_seen` runs in the same daemon call, so an edit is reported exactly
/// once.
pub(crate) fn render_for_injection(state: &Arc<DaemonState>, session_id: &str) -> Option<String> {
    let project_id = caller_project(state, session_id).ok()?;
    let drafts = store::list(&project_id);

    // Own chat only (Joe 2026-09-26). The store stays project-wide and the
    // panel still lists every card, but this block is rebuilt every single
    // turn, so one unanswered draft was costing EVERY chat in the project a
    // line forever - nothing drains the list until someone presses Copy. A
    // chat that never wrote a draft now gets no block at all.
    let open: Vec<&MessageDraft> = drafts
        .iter()
        .filter(|d| d.state != DraftState::Copied && d.origin_session_id == session_id)
        .collect();
    let edited: Vec<&MessageDraft> = drafts
        .iter()
        .filter(|d| !d.seen_by_origin && d.origin_session_id == session_id)
        .collect();
    if open.is_empty() && edited.is_empty() {
        return None;
    }

    let mut out = String::from(
        "[drafts] Message drafts YOU wrote in THIS chat for the user to send somewhere else. Each \
         one lives in this project's Drafts panel and renders inline in this transcript, where he \
         can read, edit and copy it. Drafts from the project's other chats are deliberately not \
         listed here - the panel holds them. Never paste a draft message into your chat text - \
         write it with the `write_draft` tool (add|revise|variant|drop) and refer to it by its \
         handle.\n",
    );
    if !open.is_empty() {
        out.push_str(&format!("Open ({}):\n", open.len()));
        append_capped(&mut out, &open, MAX_INJECTED, |d| open_line(d));
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
    use crate::daemon::methods::drafts_store::write_draft;
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::sessions::message_drafts::{DraftAuthor, DraftVariant, DraftVersion};
    use crate::types::Settings;
    use serde_json::json;

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
    fn open_line_carries_handle_topic_and_short_id() {
        let d = draft(vec![variant("Bruno", 2, &[("hey", DraftAuthor::Ai)])]);
        assert_eq!(open_line(&d), "- [Bruno #2] Sprint slip - abcdef12");
    }

    #[test]
    fn open_line_lists_every_recipient_handle() {
        let d = draft(vec![
            variant("Bruno", 2, &[("technical", DraftAuthor::Ai)]),
            variant("Ana", 1, &[("plain", DraftAuthor::Ai)]),
        ]);
        assert!(open_line(&d).starts_with("- [Bruno #2, Ana #1]"), "got {}", open_line(&d));
    }

    #[test]
    fn excerpt_only_marks_truncation_when_it_truncated() {
        assert_eq!(excerpt("short"), "short");
        let long = "y".repeat(DIFF_EXCERPT + 10);
        let cut = excerpt(&long);
        assert!(cut.ends_with("..."));
        assert_eq!(cut.chars().count(), DIFF_EXCERPT + 3);
    }

    /// Two sessions in one project, one draft each: `render_for_injection`
    /// scopes the Open list to the caller's own chat (todo 984, pins
    /// `b896fbaa`'s `d.origin_session_id == session_id` clause). Fresh uuids
    /// for session and project ids per
    /// `project_lib_tests_shared_static_session_ids_collide` - the store
    /// writes real on-disk state under `<app-data>/message-drafts/<project_id>.json`.
    fn two_sessions_one_project() -> (Arc<DaemonState>, String, String, String) {
        let state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        let project_id = format!("proj-inject-scope-{}", uuid::Uuid::new_v4());
        let s1 = format!("s1-{}", uuid::Uuid::new_v4());
        let s2 = format!("s2-{}", uuid::Uuid::new_v4());
        state.registry.upsert_interactive(&s1, std::path::Path::new("."), &project_id, "2026-08-26T00:00:00Z");
        state.registry.upsert_interactive(&s2, std::path::Path::new("."), &project_id, "2026-08-26T00:00:00Z");
        write_draft(
            &state,
            &s1,
            "add",
            &json!({"topic": "s1 topic", "recipient": "Bruno", "body": "hi from s1"}),
        )
        .expect("s1 can write a draft");
        write_draft(
            &state,
            &s2,
            "add",
            &json!({"topic": "s2 topic", "recipient": "Ana", "body": "hi from s2"}),
        )
        .expect("s2 can write a draft");
        (state, project_id, s1, s2)
    }

    #[test]
    fn render_for_injection_only_lists_the_callers_own_open_draft() {
        let (state, _project_id, s1, _s2) = two_sessions_one_project();

        let block = render_for_injection(&state, &s1).expect("s1 wrote an open draft");
        assert!(block.contains("s1 topic"), "got {block}");
        assert!(!block.contains("s2 topic"), "got {block}");
    }

    #[test]
    fn render_for_injection_is_symmetric_for_the_other_session() {
        let (state, _project_id, _s1, s2) = two_sessions_one_project();

        let block = render_for_injection(&state, &s2).expect("s2 wrote an open draft");
        assert!(block.contains("s2 topic"), "got {block}");
        assert!(!block.contains("s1 topic"), "got {block}");
    }

    #[test]
    fn a_session_with_no_drafts_of_its_own_gets_no_block_even_with_a_peer_open_one() {
        let state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        let project_id = format!("proj-inject-scope-{}", uuid::Uuid::new_v4());
        let author = format!("author-{}", uuid::Uuid::new_v4());
        let bystander = format!("bystander-{}", uuid::Uuid::new_v4());
        state.registry.upsert_interactive(&author, std::path::Path::new("."), &project_id, "2026-08-26T00:00:00Z");
        state.registry.upsert_interactive(&bystander, std::path::Path::new("."), &project_id, "2026-08-26T00:00:00Z");
        write_draft(
            &state,
            &author,
            "add",
            &json!({"topic": "someone else's topic", "recipient": "Bruno", "body": "hi"}),
        )
        .expect("author can write a draft");

        assert!(
            render_for_injection(&state, &bystander).is_none(),
            "a chat that never wrote a draft must get no block, not an empty one"
        );
    }
}
