//! Pure building blocks of `dashboard_snapshot`: how a live chat's status is
//! derived and how stored rows map onto the wire rows. The daemon method
//! gathers state and calls these.

use super::snapshot_types::{RepoRef, ScheduledRow};
use super::targets::chat_in_repo;
use crate::sessions::scheduled_items::{ScheduledItem, ScheduledKind, ScheduledStatus};
use serde_json::Value;
use std::collections::HashSet;

pub const SCHEDULED_CAP: usize = 4;
const LABEL_CHARS: usize = 80;

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

/// Sessions with an open question or permission prompt.
pub fn prompt_sessions(prompts: &[Value]) -> HashSet<String> {
    prompts
        .iter()
        .filter(|p| matches!(p["event"].as_str(), Some("question-requested" | "permission-requested")))
        .filter_map(|p| p["payload"]["session_id"].as_str().filter(|s| !s.is_empty()))
        .map(str::to_string)
        .collect()
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
    fn only_question_and_permission_prompts_mark_their_session() {
        let prompts = vec![
            json!({"event": "question-requested", "payload": {"session_id": "s1", "questions": [{"question": "Ship it?"}]}}),
            json!({"event": "question-requested", "payload": {"session_id": "s1", "questions": [{"question": "Second?"}]}}),
            json!({"event": "permission-requested", "payload": {"session_id": "s2", "tool_name": "Bash"}}),
            json!({"event": "secret-requested", "payload": {"session_id": "s3"}}),
            json!({"event": "question-requested", "payload": {"questions": []}}),
        ];
        let m = prompt_sessions(&prompts);
        assert_eq!(m, HashSet::from(["s1".to_string(), "s2".to_string()]));
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
            guard: None,
            last_skip: None,
            after_meeting: None,
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
