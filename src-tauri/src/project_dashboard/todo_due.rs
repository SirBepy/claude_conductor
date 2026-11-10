//! The dashboard's Due card data: which open backlog todos fall due on each of
//! the next five local days, and which are already past due. A claimed todo
//! still counts (a chat working on it has not finished it); `done/` files are
//! never read because only the backlog folder itself is listed.

use super::snapshot_types::{DueDay, DueId, DueSummary};
use super::todo_read::list_backlog_for_repo;
use chrono::{Duration, Local, NaiveDate};

/// Today plus the next four days.
const WINDOW_DAYS: i64 = 5;

/// One open todo with a parsed due date.
#[derive(Clone, Debug, PartialEq)]
pub struct DueItem {
    pub id: String,
    pub repo_cwd: String,
    pub due: NaiveDate,
}

/// Buckets `items` into the five-day window starting at `today`, plus the
/// missed list (due before `today`). Anything past the window is dropped.
/// Pure so a test can fix `today`.
pub fn due_window(items: &[DueItem], today: NaiveDate) -> DueSummary {
    let id_of = |i: &DueItem| DueId { id: i.id.clone(), repo_cwd: i.repo_cwd.clone() };
    let days = (0..WINDOW_DAYS)
        .map(|offset| {
            let day = today + Duration::days(offset);
            let ids: Vec<DueId> = items.iter().filter(|i| i.due == day).map(id_of).collect();
            DueDay { date: day.format("%Y-%m-%d").to_string(), count: ids.len() as u32, ids }
        })
        .collect();
    let missed_ids = items.iter().filter(|i| i.due < today).map(id_of).collect();
    DueSummary { days, missed_ids }
}

/// The open backlog todos of every repo that carry a valid due date.
fn read_items(repo_cwds: &[String]) -> Vec<DueItem> {
    let mut out = Vec::new();
    for cwd in repo_cwds {
        for t in list_backlog_for_repo(cwd).todos {
            let Some(due) = t.due.as_deref().and_then(|d| NaiveDate::parse_from_str(d, "%Y-%m-%d").ok()) else { continue };
            out.push(DueItem { id: t.id, repo_cwd: cwd.clone(), due });
        }
    }
    out
}

/// The Due card's data for a dashboard's repos, against the local calendar day.
pub fn read_due(repo_cwds: &[String]) -> DueSummary {
    due_window(&read_items(repo_cwds), Local::now().date_naive())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(s: &str) -> NaiveDate {
        NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap()
    }

    fn item(id: &str, due: &str) -> DueItem {
        DueItem { id: id.into(), repo_cwd: "C:/w/app".into(), due: d(due) }
    }

    #[test]
    fn the_window_is_today_plus_four_days_and_splits_missed_from_later() {
        let items = [
            item("pc-1", "2026-11-09"),
            item("pc-2", "2026-11-10"),
            item("pc-3", "2026-11-14"),
            item("pc-4", "2026-11-15"),
            item("pc-5", "2026-11-10"),
        ];
        let s = due_window(&items, d("2026-11-10"));
        let dates: Vec<&str> = s.days.iter().map(|x| x.date.as_str()).collect();
        assert_eq!(dates, ["2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13", "2026-11-14"]);
        let counts: Vec<u32> = s.days.iter().map(|x| x.count).collect();
        assert_eq!(counts, [2, 0, 0, 0, 1]);
        let today_ids: Vec<&str> = s.days[0].ids.iter().map(|x| x.id.as_str()).collect();
        assert_eq!(today_ids, ["pc-2", "pc-5"]);
        assert_eq!(s.days[4].ids[0].id, "pc-3");
        let missed: Vec<&str> = s.missed_ids.iter().map(|x| x.id.as_str()).collect();
        assert_eq!(missed, ["pc-1"], "+5 (pc-4) is outside the window and not missed");
    }

    #[test]
    fn no_items_still_yields_five_empty_days() {
        let s = due_window(&[], d("2026-12-30"));
        assert_eq!(s.days.len(), 5);
        assert_eq!(s.days[4].date, "2027-01-03", "the window crosses a year end");
        assert!(s.days.iter().all(|x| x.count == 0 && x.ids.is_empty()) && s.missed_ids.is_empty());
    }

    #[test]
    fn the_same_id_in_two_repos_stays_distinct_by_repo() {
        let mut other = item("pc-1", "2026-11-10");
        other.repo_cwd = "C:/w/other".into();
        let s = due_window(&[item("pc-1", "2026-11-10"), other], d("2026-11-10"));
        assert_eq!(s.days[0].count, 2);
        assert_ne!(s.days[0].ids[0].repo_cwd, s.days[0].ids[1].repo_cwd);
    }

    #[test]
    fn only_open_backlog_todos_with_a_valid_date_are_read() {
        let dir = tempfile::tempdir().unwrap();
        let todos = dir.path().join(".claude").join("todos");
        std::fs::create_dir_all(todos.join("done")).unwrap();
        std::fs::create_dir_all(todos.join(".claims")).unwrap();
        std::fs::write(todos.join("pc-0001-open.md"), "# A\n**Due:** 2026-11-10\n").unwrap();
        std::fs::write(todos.join("pc-0002-claimed.md"), "# B\n**Due:** 2026-11-11\n").unwrap();
        std::fs::write(todos.join(".claims/pc-0002.claim"), "s").unwrap();
        std::fs::write(todos.join("pc-0003-bad.md"), "# C\n**Due:** soon\n").unwrap();
        std::fs::write(todos.join("pc-0004-undated.md"), "# D\n").unwrap();
        std::fs::write(todos.join("done/pc-0005-done.md"), "# E\n**Due:** 2026-11-10\n").unwrap();
        let items = read_items(&[dir.path().to_string_lossy().into_owned()]);
        let ids: Vec<&str> = items.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(ids, ["pc-0001", "pc-0002"], "claimed counts, done/ and bad dates do not");
    }
}
