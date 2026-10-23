//! Which dashboard targets are open in the Projects list, "like chats": a
//! target the dev closed stays closed until a chat starts in it, and the very
//! first run closes everything that has been idle for a week so the list does
//! not open as a wall of old projects. Pure over plain inputs.

use super::snapshot_types::DashboardListRow;
use super::store::DashboardStore;
use super::types::Scope;
use std::collections::BTreeMap;

/// First-run cut-off: a target idle for longer than this starts closed.
pub const SEED_IDLE_MS: i64 = 7 * 24 * 60 * 60 * 1000;

/// The key `closed_targets` and `pinned_actions` use for a target. It is a
/// `Scope` key, so a project's closed state survives a path-style change.
pub fn target_key(kind: &str, id: &str) -> String {
    match kind {
        "group" => Scope::Group { id: id.to_string() },
        _ => Scope::Project { cwd: id.to_string() },
    }
    .scope_key()
}

/// A target is open unless it was closed and no live chat in it started after
/// that moment. `newest_live_start_ms` is the latest start among the target's
/// live chats; a chat that was already running when the dev closed the target
/// does not reopen it, only a newer one does.
pub fn is_open(closed_at_ms: Option<i64>, newest_live_start_ms: Option<i64>) -> bool {
    match closed_at_ms {
        None => true,
        Some(closed) => newest_live_start_ms.is_some_and(|started| started > closed),
    }
}

/// Targets to close on the first run: those whose last activity is older than
/// a week. Stamped `now_ms`, so a chat started from then on reopens them.
pub fn seed_closed(rows: &[DashboardListRow], now_ms: i64) -> Vec<(String, i64)> {
    rows.iter()
        .filter(|r| r.last_active_ms < now_ms - SEED_IDLE_MS)
        .map(|r| (target_key(&r.target.kind, &r.target.id), now_ms))
        .collect()
}

/// Closed-list entries whose target is open again (a newer chat started), so
/// the caller can drop them: the dev closing it later must stamp a fresh time.
pub fn reopened_keys(rows: &[DashboardListRow], closed: &BTreeMap<String, i64>) -> Vec<String> {
    rows.iter()
        .filter(|r| r.open)
        .map(|r| target_key(&r.target.kind, &r.target.id))
        .filter(|k| closed.contains_key(k))
        .collect()
}

/// Builds the list rows and settles the stored open state around them, in
/// memory: the first run closes whatever has idled for a week, and a closed
/// target a newer chat has reopened loses its closed entry, so closing it again
/// stamps a fresh time. `build` makes the rows for a given closed map.
pub fn settle_rows(
    st: &mut DashboardStore,
    now_ms: i64,
    build: impl Fn(&BTreeMap<String, i64>) -> Vec<DashboardListRow>,
) -> Vec<DashboardListRow> {
    if !st.open_seeded {
        let seed = seed_closed(&build(&BTreeMap::new()), now_ms);
        st.seed_open_state(seed);
    }
    let rows = build(&st.closed_targets);
    for key in reopened_keys(&rows, &st.closed_targets) {
        st.open_target(&key);
    }
    rows
}

impl DashboardStore {
    pub fn close_target(&mut self, key: &str, now_ms: i64) {
        self.closed_targets.insert(key.to_string(), now_ms);
    }

    /// True when the target had been closed.
    pub fn open_target(&mut self, key: &str) -> bool {
        self.closed_targets.remove(key).is_some()
    }

    /// Runs the first-run seeding exactly once: a second call is a no-op even
    /// if the dev has reopened everything since.
    pub fn seed_open_state(&mut self, closed: Vec<(String, i64)>) -> bool {
        if self.open_seeded {
            return false;
        }
        self.closed_targets.extend(closed);
        self.open_seeded = true;
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project_dashboard::snapshot_types::DashboardTarget;

    const DAY: i64 = 24 * 60 * 60 * 1000;

    fn row(kind: &str, id: &str, last_active_ms: i64, open: bool) -> DashboardListRow {
        DashboardListRow {
            target: DashboardTarget { kind: kind.into(), id: id.into(), name: id.into(), repos: vec![] },
            last_active_ms,
            open,
            ..Default::default()
        }
    }

    #[test]
    fn a_target_never_closed_is_open() {
        assert!(is_open(None, None));
        assert!(is_open(None, Some(5)));
    }

    #[test]
    fn a_closed_target_with_no_live_chat_stays_closed() {
        assert!(!is_open(Some(1000), None));
    }

    #[test]
    fn a_chat_started_after_the_close_reopens_it() {
        assert!(is_open(Some(1000), Some(1001)));
    }

    #[test]
    fn a_chat_started_before_or_at_the_close_does_not() {
        assert!(!is_open(Some(1000), Some(999)));
        assert!(!is_open(Some(1000), Some(1000)));
    }

    #[test]
    fn target_keys_are_scope_keys_and_ignore_path_style() {
        assert_eq!(target_key("group", "g1"), "group:g1");
        assert_eq!(target_key("project", "C:\\w\\App"), target_key("project", "c:/w/app/"));
        assert!(target_key("project", "C:/w/app").starts_with("project:"));
    }

    #[test]
    fn seeding_closes_only_targets_idle_for_more_than_a_week() {
        let now = 100 * DAY;
        let rows = [
            row("project", "C:/w/old", now - 8 * DAY, true),
            row("project", "C:/w/fresh", now - 2 * DAY, true),
            row("project", "C:/w/never", 0, true),
            row("group", "g1", now - 7 * DAY, true),
        ];
        let seeded = seed_closed(&rows, now);
        let keys: Vec<&str> = seeded.iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(keys, [target_key("project", "C:/w/old"), target_key("project", "C:/w/never")]);
        assert!(seeded.iter().all(|(_, t)| *t == now), "stamped now so a later chat reopens them");
    }

    #[test]
    fn reopened_keys_are_open_rows_that_still_have_a_closed_entry() {
        let mut closed = BTreeMap::new();
        closed.insert(target_key("project", "C:/w/a"), 5);
        closed.insert(target_key("project", "C:/w/b"), 5);
        let rows = [
            row("project", "C:/w/a", 0, true),
            row("project", "C:/w/b", 0, false),
            row("project", "C:/w/c", 0, true),
        ];
        assert_eq!(reopened_keys(&rows, &closed), [target_key("project", "C:/w/a")]);
    }

    #[test]
    fn close_and_open_a_target() {
        let mut s = DashboardStore::default();
        s.close_target("project:x", 50);
        s.close_target("project:x", 90);
        assert_eq!(s.closed_targets["project:x"], 90, "closing again restamps");
        assert!(s.open_target("project:x"));
        assert!(!s.open_target("project:x"));
    }

    #[test]
    fn first_run_seeding_applies_once() {
        let mut s = DashboardStore::default();
        assert!(s.seed_open_state(vec![("project:old".into(), 7)]));
        assert!(s.open_seeded && s.closed_targets["project:old"] == 7);
        s.open_target("project:old");
        assert!(!s.seed_open_state(vec![("project:old".into(), 9)]), "never re-closes what the dev reopened");
        assert!(s.closed_targets.is_empty());
    }

    /// A fake row builder: `open` follows the closed map the way `build_targets` does.
    fn build_with(newest_start: Option<i64>) -> impl Fn(&BTreeMap<String, i64>) -> Vec<DashboardListRow> {
        move |closed| {
            let mk = |id: &str, last_active_ms: i64| {
                let key = target_key("project", id);
                let open = is_open(closed.get(&key).copied(), newest_start.filter(|_| id == "C:/w/fresh"));
                row("project", id, last_active_ms, open)
            };
            vec![mk("C:/w/old", 0), mk("C:/w/fresh", 99 * DAY)]
        }
    }

    #[test]
    fn the_first_settle_closes_the_idle_target_and_marks_seeded() {
        let mut st = DashboardStore::default();
        let rows = settle_rows(&mut st, 100 * DAY, build_with(None));
        assert!(st.open_seeded);
        assert_eq!(st.closed_targets.len(), 1);
        assert_eq!(st.closed_targets[&target_key("project", "C:/w/old")], 100 * DAY);
        assert_eq!(rows.iter().map(|r| r.open).collect::<Vec<_>>(), [false, true]);
    }

    #[test]
    fn a_later_settle_does_not_reseed_what_the_dev_reopened() {
        let mut st = DashboardStore::default();
        settle_rows(&mut st, 100 * DAY, build_with(None));
        st.open_target(&target_key("project", "C:/w/old"));
        let rows = settle_rows(&mut st, 101 * DAY, build_with(None));
        assert!(rows.iter().all(|r| r.open));
        assert!(st.closed_targets.is_empty());
    }

    #[test]
    fn a_chat_started_after_the_close_drops_the_closed_entry() {
        let mut st = DashboardStore::default();
        st.open_seeded = true;
        st.close_target(&target_key("project", "C:/w/fresh"), 500);
        let rows = settle_rows(&mut st, 1000, build_with(Some(600)));
        assert!(rows.iter().all(|r| r.open));
        assert!(st.closed_targets.is_empty(), "the entry is dropped so the next close restamps");
    }

    #[test]
    fn a_chat_started_before_the_close_leaves_it_closed() {
        let mut st = DashboardStore::default();
        st.open_seeded = true;
        st.close_target(&target_key("project", "C:/w/fresh"), 500);
        let rows = settle_rows(&mut st, 1000, build_with(Some(400)));
        assert!(!rows[1].open);
        assert_eq!(st.closed_targets.len(), 1);
    }
}
