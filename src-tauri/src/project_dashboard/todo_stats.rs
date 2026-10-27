//! Per-day todo counts for the dashboard's Todos chart, read from the file
//! timestamps under `<repo>/.claude/todos/`. The folder is git-excluded and a
//! todo file carries no date fields, so the filesystem is the only record of
//! when a todo was written or finished: a file's creation time is when it was
//! written, and a `done/` file's last write is when it was finished (completing
//! a todo appends its completion note, and the move into `done/` keeps both
//! times).

use super::snapshot_types::{TodoDay, TodoStats};
use chrono::{Duration, Local, NaiveDate};
use std::path::{Path, PathBuf};
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

/// Where a repo keeps its todos. Every reader of the backlog resolves the
/// folder through this, so a move of the folder is a one-line change.
pub fn todos_dir(repo: &Path) -> PathBuf {
    repo.join(".claude").join("todos")
}

/// A todo file is any `.md` except `PLAN.md`, which is the ordered pointer
/// lane over the backlog, not a task itself.
pub fn is_backlog_file(p: &Path) -> bool {
    p.extension().and_then(|e| e.to_str()) == Some("md")
        && p.file_name().and_then(|n| n.to_str()) != Some("PLAN.md")
}

/// A claim older than this is a dead session's leftover: `/pickup` may delete
/// and re-take it, so the dashboard and the slash menu must not count it.
/// Only the mtime half of `/pickup`'s staleness rule is mirrored; the owner
/// pid check lives in the claim script and is not worth duplicating here.
const CLAIM_STALE_AFTER: std::time::Duration = std::time::Duration::from_secs(4 * 60 * 60);

/// Whether todo `id` holds a live claim in `<todos_dir>/.claims/`. A colliding
/// id is claimed as `<id>-<slug>.claim`, so both spellings count. An mtime
/// that cannot be read, or that lies in the future (clock skew), counts as
/// live: hiding a real claim is worse than showing a stale one.
pub fn claim_is_live(todos_dir: &Path, id: &str) -> bool {
    let Ok(entries) = std::fs::read_dir(todos_dir.join(".claims")) else { return false };
    let slug_prefix = format!("{id}-");
    let exact = format!("{id}.claim");
    entries.flatten().any(|ent| {
        let name = ent.file_name().to_string_lossy().into_owned();
        if name != exact && !(name.starts_with(&slug_prefix) && name.ends_with(".claim")) {
            return false;
        }
        let age = ent.metadata().and_then(|m| m.modified()).ok().and_then(|t| SystemTime::now().duration_since(t).ok());
        age.is_none_or(|a| a < CLAIM_STALE_AFTER)
    })
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
    let dir = todos_dir(Path::new(repo_cwd));
    let mut out = Vec::new();
    let mut claimed = 0;
    for (sub, done) in [(dir.clone(), false), (dir.join("done"), true)] {
        let Ok(entries) = std::fs::read_dir(&sub) else { continue };
        for ent in entries.flatten() {
            let p = ent.path();
            if !is_backlog_file(&p) {
                continue;
            }
            let Ok(meta) = ent.metadata() else { continue };
            let Some(created) = created_at(&meta) else { continue };
            let finished = if done { meta.modified().ok().map(local_date) } else { None };
            if !done {
                let name = ent.file_name();
                if todo_id(&name.to_string_lossy()).is_some_and(|id| claim_is_live(&dir, id)) {
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

    /// Sets a file's mtime `hours` into the past.
    fn backdate(path: &Path, hours: u64) {
        let past = SystemTime::now() - std::time::Duration::from_secs(hours * 60 * 60);
        std::fs::OpenOptions::new().write(true).open(path).unwrap().set_modified(past).unwrap();
    }

    fn claims_dir(files: &[&str]) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join(".claims")).unwrap();
        for f in files {
            std::fs::write(dir.path().join(".claims").join(f), "session: s").unwrap();
        }
        dir
    }

    #[test]
    fn a_fresh_claim_is_live() {
        let dir = claims_dir(&["7.claim"]);
        assert!(claim_is_live(dir.path(), "7"));
        assert!(!claim_is_live(dir.path(), "8"));
    }

    #[test]
    fn a_claim_older_than_four_hours_is_not_live() {
        let dir = claims_dir(&["7.claim"]);
        let claim = dir.path().join(".claims").join("7.claim");
        backdate(&claim, 3);
        assert!(claim_is_live(dir.path(), "7"));
        backdate(&claim, 5);
        assert!(!claim_is_live(dir.path(), "7"));
    }

    #[test]
    fn a_slug_suffixed_claim_counts_but_a_longer_id_does_not() {
        let dir = claims_dir(&["7-handoff.claim", "70.claim", "71-x.claim"]);
        assert!(claim_is_live(dir.path(), "7"));
        assert!(!claim_is_live(dir.path(), "8"));
        let only_longer = claims_dir(&["70.claim", "71-x.claim"]);
        assert!(!claim_is_live(only_longer.path(), "7"));
    }

    #[test]
    fn no_claims_folder_is_no_claim() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!claim_is_live(dir.path(), "7"));
    }

    #[test]
    fn read_repo_counts_a_slug_claim_and_skips_a_stale_one() {
        let dir = tempfile::tempdir().unwrap();
        let todos = todos_dir(dir.path());
        std::fs::create_dir_all(todos.join(".claims")).unwrap();
        for f in ["1-a.md", "2-b.md", "3-c.md"] {
            std::fs::write(todos.join(f), "x").unwrap();
        }
        std::fs::write(todos.join(".claims").join("1-a.claim"), "s").unwrap();
        std::fs::write(todos.join(".claims").join("2.claim"), "s").unwrap();
        backdate(&todos.join(".claims").join("2.claim"), 9);
        let (_, claimed) = read_repo(&dir.path().to_string_lossy());
        assert_eq!(claimed, 1);
    }

    #[test]
    fn todos_live_under_dot_claude_todos() {
        assert_eq!(todos_dir(Path::new("repo")), Path::new("repo").join(".claude").join("todos"));
    }

    #[test]
    fn a_backlog_file_is_a_markdown_file_that_is_not_the_plan() {
        assert!(is_backlog_file(Path::new("12-do-it.md")));
        assert!(!is_backlog_file(Path::new("PLAN.md")));
        assert!(!is_backlog_file(Path::new("12-do-it.txt")));
        assert!(!is_backlog_file(Path::new("12-do-it")));
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
