//! Pure building blocks of `dashboard_snapshot`: how a live chat's status is
//! derived, which drafts count as open, how stored rows map onto the wire
//! rows. The daemon method gathers state and calls these.

use super::snapshot_types::{NeedsYouItem, RepoRef, ScheduledRow};
use super::targets::chat_in_repo;
use crate::sessions::message_drafts::{DraftState, MessageDraft};
use crate::sessions::scheduled_items::{ScheduledItem, ScheduledKind, ScheduledStatus};
use serde_json::Value;
use std::collections::HashMap;

/// Mirrors `drafts-grouping.ts`'s `STALE_MS`: a draft nobody touched for a week
/// stops counting as open.
const DRAFT_STALE_MS: i64 = 7 * 24 * 60 * 60 * 1000;

pub const SCHEDULED_CAP: usize = 4;
const LABEL_CHARS: usize = 80;
const DETAIL_CHARS: usize = 140;

pub fn parse_ms(rfc3339: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(rfc3339).ok().map(|d| d.timestamp_millis())
}

pub fn clip(s: &str, max: usize) -> String {
    let flat: String = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= max {
        return flat;
    }
    let cut: String = flat.chars().take(max).collect();
    format!("{}...", cut.trim_end())
}

/// Question beats working beats waiting beats your_turn. An open prompt counts
/// as a question even when `awaiting` has not caught up (the registry is set
/// after the prompt is recorded), and `awaiting == "working"` is background
/// work, which the sidebar also shows as working.
pub fn chat_status(awaiting: Option<&str>, busy: bool, has_prompt: bool) -> &'static str {
    if awaiting == Some("question") || has_prompt {
        "question"
    } else if busy || awaiting == Some("working") {
        "working"
    } else if awaiting == Some("waiting") {
        "waiting"
    } else {
        "your_turn"
    }
}

/// Sessions with an open question or permission prompt, each mapped to a short
/// description of the first one (prompts arrive oldest first).
pub fn prompt_sessions(prompts: &[Value]) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for p in prompts {
        let event = p["event"].as_str().unwrap_or("");
        if event != "question-requested" && event != "permission-requested" {
            continue;
        }
        let Some(sid) = p["payload"]["session_id"].as_str().filter(|s| !s.is_empty()) else { continue };
        let detail = if event == "question-requested" {
            p["payload"]["questions"][0]["question"].as_str().map(|q| clip(q, DETAIL_CHARS))
        } else {
            p["payload"]["tool_name"].as_str().map(|t| format!("Wants permission to use {t}"))
        };
        out.entry(sid.to_string()).or_insert_with(|| detail.unwrap_or_else(|| "Asked you a question".to_string()));
    }
    out
}

pub fn draft_is_open(d: &MessageDraft, now_ms: i64) -> bool {
    if d.state != DraftState::NeedsYou {
        return false;
    }
    match parse_ms(&d.updated_at) {
        Some(touched) => now_ms - touched < DRAFT_STALE_MS,
        None => true,
    }
}

pub fn draft_item(d: &MessageDraft, repo_cwd: &str) -> NeedsYouItem {
    let to = d.variants.first().map(|v| v.recipient.trim()).filter(|r| !r.is_empty());
    NeedsYouItem {
        kind: "draft".into(),
        title: d.topic.clone(),
        detail: to.map(|r| format!("Draft for {r}")).unwrap_or_else(|| "Draft waiting on you".into()),
        session_id: Some(d.origin_session_id.clone()).filter(|s| !s.is_empty()),
        draft_id: Some(d.id.clone()),
        repo_cwd: repo_cwd.to_string(),
        at_ms: parse_ms(&d.updated_at).unwrap_or(0),
    }
}

/// A pending scheduled item as a row, if it targets one of the repos. Items
/// with no repo (Jarvis hygiene) and items already fired never show.
pub fn scheduled_row(item: &ScheduledItem, repos: &[RepoRef]) -> Option<ScheduledRow> {
    if item.status != ScheduledStatus::Pending {
        return None;
    }
    let cwd = match &item.kind {
        ScheduledKind::Message { cwd, .. } | ScheduledKind::NewChat { cwd, .. } => cwd,
        ScheduledKind::JarvisHygiene => return None,
    };
    let repo = repos.iter().find(|r| chat_in_repo("", cwd, r))?;
    Some(ScheduledRow {
        id: item.id.clone(),
        label: clip(&item.prompt, LABEL_CHARS),
        fire_at_ms: parse_ms(&item.fire_at)?,
        repo_cwd: repo.cwd.clone(),
    })
}

/// Soonest first, capped.
pub fn soonest_scheduled(mut rows: Vec<ScheduledRow>) -> Vec<ScheduledRow> {
    rows.sort_by_key(|r| r.fire_at_ms);
    rows.truncate(SCHEDULED_CAP);
    rows
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sessions::message_drafts::{DraftAuthor, DraftVariant, DraftVersion};
    use serde_json::json;

    #[test]
    fn question_beats_working_beats_waiting_beats_your_turn() {
        assert_eq!(chat_status(Some("question"), true, false), "question");
        assert_eq!(chat_status(None, true, true), "question");
        assert_eq!(chat_status(Some("waiting"), true, false), "working");
        assert_eq!(chat_status(Some("waiting"), false, false), "waiting");
        assert_eq!(chat_status(Some("working"), false, false), "working");
        assert_eq!(chat_status(Some("done"), false, false), "your_turn");
        assert_eq!(chat_status(None, false, false), "your_turn");
    }

    #[test]
    fn prompts_map_to_their_session_with_the_first_ones_detail() {
        let prompts = vec![
            json!({"event": "question-requested", "payload": {"session_id": "s1", "questions": [{"question": "Ship it?"}]}}),
            json!({"event": "question-requested", "payload": {"session_id": "s1", "questions": [{"question": "Second?"}]}}),
            json!({"event": "permission-requested", "payload": {"session_id": "s2", "tool_name": "Bash"}}),
            json!({"event": "secret-requested", "payload": {"session_id": "s3"}}),
            json!({"event": "question-requested", "payload": {"questions": []}}),
        ];
        let m = prompt_sessions(&prompts);
        assert_eq!(m.len(), 2);
        assert_eq!(m["s1"], "Ship it?");
        assert_eq!(m["s2"], "Wants permission to use Bash");
    }

    #[test]
    fn a_question_prompt_without_text_still_has_a_detail() {
        let m = prompt_sessions(&[json!({"event": "question-requested", "payload": {"session_id": "s1"}})]);
        assert_eq!(m["s1"], "Asked you a question");
    }

    fn draft(state: DraftState, updated_at: &str) -> MessageDraft {
        MessageDraft {
            id: "d1".into(),
            topic: "Reply to Bruno".into(),
            brief: String::new(),
            receipts: vec![],
            variants: vec![DraftVariant {
                recipient: "Bruno".into(),
                handle_n: 1,
                versions: vec![DraftVersion {
                    n: 1,
                    body: "hi".into(),
                    author: DraftAuthor::Ai,
                    note: String::new(),
                    created_at: updated_at.into(),
                }],
                current: 1,
                person: None,
                platform: None,
            }],
            state,
            origin_session_id: "sess-1".into(),
            origin_label: "chat".into(),
            created_at: updated_at.into(),
            updated_at: updated_at.into(),
            seen_by_origin: true,
        }
    }

    #[test]
    fn only_a_fresh_needs_you_draft_is_open() {
        let now = parse_ms("2026-10-22T12:00:00Z").unwrap();
        assert!(draft_is_open(&draft(DraftState::NeedsYou, "2026-10-21T12:00:00Z"), now));
        assert!(!draft_is_open(&draft(DraftState::NeedsYou, "2026-10-10T12:00:00Z"), now));
        assert!(!draft_is_open(&draft(DraftState::Copied, "2026-10-22T11:00:00Z"), now));
        assert!(!draft_is_open(&draft(DraftState::Archived, "2026-10-22T11:00:00Z"), now));
        assert!(draft_is_open(&draft(DraftState::NeedsYou, "not a date"), now));
    }

    #[test]
    fn a_draft_item_names_its_recipient_and_origin_chat() {
        let item = draft_item(&draft(DraftState::NeedsYou, "2026-10-22T11:00:00Z"), "C:/w/app");
        assert_eq!(item.kind, "draft");
        assert_eq!(item.title, "Reply to Bruno");
        assert_eq!(item.detail, "Draft for Bruno");
        assert_eq!(item.session_id.as_deref(), Some("sess-1"));
        assert_eq!(item.draft_id.as_deref(), Some("d1"));
        assert!(item.at_ms > 0);
    }

    fn item(status: ScheduledStatus, kind: ScheduledKind, fire_at: &str) -> ScheduledItem {
        ScheduledItem {
            id: uuid::Uuid::new_v4().to_string(),
            kind,
            prompt: "run the nightly check".into(),
            fire_at: fire_at.into(),
            recurrence: None,
            status,
            created_at: fire_at.into(),
            last_fired_at: None,
            last_result: None,
            last_session_id: None,
        }
    }

    fn repo(cwd: &str) -> RepoRef {
        RepoRef { cwd: cwd.into(), name: "app".into(), project_id: None }
    }

    #[test]
    fn only_pending_items_for_a_repo_become_rows() {
        let repos = [repo("C:/w/app")];
        let msg = ScheduledKind::Message { session_id: "s".into(), cwd: "c:\\w\\APP".into() };
        let row = scheduled_row(&item(ScheduledStatus::Pending, msg.clone(), "2026-10-23T09:00:00Z"), &repos).unwrap();
        assert_eq!(row.repo_cwd, "C:/w/app");
        assert_eq!(row.label, "run the nightly check");
        assert!(scheduled_row(&item(ScheduledStatus::Sent, msg, "2026-10-23T09:00:00Z"), &repos).is_none());
        let other = ScheduledKind::Message { session_id: "s".into(), cwd: "C:/w/other".into() };
        assert!(scheduled_row(&item(ScheduledStatus::Pending, other, "2026-10-23T09:00:00Z"), &repos).is_none());
        assert!(scheduled_row(&item(ScheduledStatus::Pending, ScheduledKind::JarvisHygiene, "2026-10-23T09:00:00Z"), &repos).is_none());
    }

    #[test]
    fn scheduled_rows_sort_soonest_first_and_cap_at_four() {
        let rows: Vec<ScheduledRow> = [50, 10, 40, 20, 30, 60]
            .iter()
            .map(|t| ScheduledRow { id: t.to_string(), label: String::new(), fire_at_ms: *t, repo_cwd: String::new() })
            .collect();
        let out = soonest_scheduled(rows);
        let times: Vec<i64> = out.iter().map(|r| r.fire_at_ms).collect();
        assert_eq!(times, [10, 20, 30, 40]);
    }

    #[test]
    fn clip_flattens_whitespace_and_truncates() {
        assert_eq!(clip("a\n  b\tc", 10), "a b c");
        assert_eq!(clip(&"x".repeat(20), 5), "xxxxx...");
    }
}
