//! Per-day todo counts for the dashboard's Todos chart, read from the file
//! timestamps under `<repo>/.claude/todos/`. The folder is git-excluded and a
//! todo file carries no date fields, so the filesystem is the only record of
//! when a todo was written or finished: a file's creation time is when it was
//! written, and a `done/` file's last write is when it was finished (completing
//! a todo appends its completion note, and the move into `done/` keeps both
//! times).

use super::snapshot_types::{TodoDay, TodoStats};
use chrono::{Duration, Local, NaiveDate};
use std::path::Path;
use std::time::SystemTime;

/// One todo file's dates. `done` is `None` while it is still in the backlog.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TodoDates {
    pub created: NaiveDate,
    pub done: Option<NaiveDate>,
}

fn local_date(t: SystemTime) -> NaiveDate {
    chrono::DateTime::<Local>::from(t).date_naive()
}

/// Creation time where the platform records one, else the last write.
fn created_at(meta: &std::fs::Metadata) -> Option<SystemTime> {
    meta.created().or_else(|_| meta.modified()).ok()
}

fn is_todo_file(p: &Path) -> bool {
    p.extension().and_then(|e| e.to_str()) == Some("md")
        && p.file_name().and_then(|n| n.to_str()) != Some("PLAN.md")
}

/// The numeric id a todo file starts with (`1264-handoff-x.md` -> `1264`).
pub fn todo_id(file_name: &str) -> Option<&str> {
    let stem = file_name.strip_suffix(".md")?;
    let id = stem.split('-').next()?;
    (!id.is_empty() && id.chars().all(|c| c.is_ascii_digit())).then_some(id)
}

/// Every todo file of one repo, backlog and `done/`, plus how many backlog
/// todos hold a claim. A repo with no todos folder yields nothing.
pub fn read_repo(repo_cwd: &str) -> (Vec<TodoDates>, u32) {
    let dir = Path::new(repo_cwd).join(".claude").join("todos");
    let mut out = Vec::new();
    let mut claimed = 0;
    for (sub, done) in [(dir.clone(), false), (dir.join("done"), true)] {
        let Ok(entries) = std::fs::read_dir(&sub) else { continue };
        for ent in entries.flatten() {
            let p = ent.path();
            if !is_todo_file(&p) {
                continue;
            }
            let Ok(meta) = ent.metadata() else { continue };
            let Some(created) = created_at(&meta) else { continue };
            let finished = if done { meta.modified().ok().map(local_date) } else { None };
            if !done {
                let name = ent.file_name();
                let claim = todo_id(&name.to_string_lossy()).map(|id| dir.join(".claims").join(format!("{id}.claim")));
                if claim.is_some_and(|c| c.exists()) {
                    claimed += 1;
                }
            }
            out.push(TodoDates { created: local_date(created), done: finished });
        }
    }
    (out, claimed)
}

/// One row per day from the oldest todo to `today`, both included. `open` is
/// the backlog at the end of that day. A done todo whose creation time reads
/// later than its finish (a copy resets creation times) counts as created the
/// day it was finished, so it never shows as open for a negative span.
pub fn build(todos: &[TodoDates], today: NaiveDate) -> Vec<TodoDay> {
    let todos: Vec<TodoDates> = todos
        .iter()
        .map(|t| TodoDates { created: t.done.map_or(t.created, |d| t.created.min(d)), done: t.done })
        .collect();
    let Some(first) = todos.iter().map(|t| t.created).min() else { return Vec::new() };
    let mut days = Vec::new();
    let mut day = first.min(today);
    while day <= today {
        let created = todos.iter().filter(|t| t.created == day).count() as u32;
        let done = todos.iter().filter(|t| t.done == Some(day)).count() as u32;
        let open = todos.iter().filter(|t| t.created <= day && t.done.is_none_or(|d| d > day)).count() as u32;
        days.push(TodoDay { date: day.format("%Y-%m-%d").to_string(), created, done, open });
        day += Duration::days(1);
    }
    days
}

/// The chart's data for a dashboard's repos, merged into one series.
pub fn read_stats(repo_cwds: &[String]) -> TodoStats {
    let mut all = Vec::new();
    let mut claimed_now = 0;
    for cwd in repo_cwds {
        let (todos, claimed) = read_repo(cwd);
        all.extend(todos);
        claimed_now += claimed;
    }
    let open_now = all.iter().filter(|t| t.done.is_none()).count() as u32;
    TodoStats { days: build(&all, Local::now().date_naive()), open_now, claimed_now }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(s: &str) -> NaiveDate {
        NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap()
    }

    fn todo(created: &str, done: Option<&str>) -> TodoDates {
        TodoDates { created: d(created), done: done.map(d) }
    }

    #[test]
    fn every_day_from_the_oldest_todo_to_today_gets_a_row() {
        let days = build(&[todo("2026-10-01", None)], d("2026-10-04"));
        let dates: Vec<&str> = days.iter().map(|x| x.date.as_str()).collect();
        assert_eq!(dates, ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"]);
    }

    #[test]
    fn created_done_and_open_count_per_day() {
        let todos = [
            todo("2026-10-01", None),
            todo("2026-10-01", Some("2026-10-02")),
            todo("2026-10-02", Some("2026-10-02")),
            todo("2026-10-03", None),
        ];
        let days = build(&todos, d("2026-10-03"));
        let rows: Vec<(u32, u32, u32)> = days.iter().map(|x| (x.created, x.done, x.open)).collect();
        assert_eq!(rows, [(2, 0, 2), (1, 2, 1), (1, 0, 2)]);
    }

    #[test]
    fn a_done_todo_created_after_its_finish_counts_as_created_that_day() {
        let days = build(&[todo("2026-10-05", Some("2026-10-02"))], d("2026-10-05"));
        assert_eq!(days[0].date, "2026-10-02");
        assert_eq!((days[0].created, days[0].done, days[0].open), (1, 1, 0));
        assert!(days.iter().all(|x| x.open == 0));
    }

    #[test]
    fn no_todos_is_no_days() {
        assert!(build(&[], d("2026-10-05")).is_empty());
    }

    #[test]
    fn todo_ids_are_the_leading_number_only() {
        assert_eq!(todo_id("1264-handoff-x.md"), Some("1264"));
        assert_eq!(todo_id("7.md"), Some("7"));
        assert_eq!(todo_id("notes-1.md"), None);
        assert_eq!(todo_id("12-x.txt"), None);
    }

    #[test]
    fn read_stats_counts_backlog_done_and_claims_but_never_the_plan() {
        let dir = tempfile::tempdir().unwrap();
        let todos = dir.path().join(".claude").join("todos");
        std::fs::create_dir_all(todos.join("done")).unwrap();
        std::fs::create_dir_all(todos.join(".claims")).unwrap();
        for f in ["1-a.md", "2-b.md", "PLAN.md", "done/3-c.md", "done/4-d.md", "done/5-e.md"] {
            std::fs::write(todos.join(f), "x").unwrap();
        }
        std::fs::write(todos.join(".claims").join("2.claim"), "session: s").unwrap();
        let stats = read_stats(&[dir.path().to_string_lossy().into_owned()]);
        assert_eq!((stats.open_now, stats.claimed_now), (2, 1));
        let today = stats.days.last().expect("a row for today");
        assert_eq!((today.created, today.done, today.open), (5, 3, 2));
    }

    #[test]
    fn a_repo_with_no_todos_folder_has_empty_stats() {
        let dir = tempfile::tempdir().unwrap();
        let stats = read_stats(&[dir.path().to_string_lossy().into_owned()]);
        assert!(stats.days.is_empty());
        assert_eq!((stats.open_now, stats.claimed_now), (0, 0));
    }
}
