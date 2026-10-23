//! Which dashboards exist: one per group, plus one per project no group
//! swallowed. Pure over plain inputs (the daemon method gathers settings and the
//! live registry), so the grouping and ordering rules are tested without either.

use super::open_state::{is_open, target_key};
use super::snapshot_types::{DashboardListRow, DashboardTarget, DashboardTargetRef, RepoRef};
use super::types::{cwd_key, GroupDef};
use std::collections::BTreeMap;

/// A `Settings.projects` entry, already stripped of scratch/jarvis rows by the caller.
#[derive(Clone, Debug)]
pub struct ProjectInfo {
    pub id: String,
    /// The path exactly as stored; it is the target id for a project.
    pub path: String,
    pub name: String,
    /// `ProjectConfig.last_active_at` in epoch ms, 0 when never set.
    pub last_active_ms: i64,
    pub exists: bool,
}

/// One live chat, reduced to what the list row counts.
#[derive(Clone, Debug)]
pub struct LiveChat {
    pub project_id: String,
    pub cwd: String,
    pub question: bool,
    pub working: bool,
    /// When the chat started, epoch ms: a chat newer than a close reopens the target.
    pub started_ms: i64,
}

fn basename(path: &str) -> String {
    path.replace('\\', "/").trim_end_matches('/').rsplit('/').next().unwrap_or(path).to_string()
}

fn find_project<'a>(cwd: &str, projects: &'a [ProjectInfo]) -> Option<&'a ProjectInfo> {
    let key = cwd_key(cwd);
    projects.iter().find(|p| cwd_key(&p.path) == key)
}

pub fn repo_ref(cwd: &str, projects: &[ProjectInfo]) -> RepoRef {
    match find_project(cwd, projects) {
        Some(p) => RepoRef { cwd: cwd.to_string(), name: p.name.clone(), project_id: Some(p.id.clone()) },
        None => RepoRef { cwd: cwd.to_string(), name: basename(cwd), project_id: None },
    }
}

/// True when a chat belongs to the repo. Project id is the primary key (it
/// survives a worktree cwd); the cwd comparison covers a group repo that has no
/// project id and a chat whose project row was never created.
pub fn chat_in_repo(chat_project_id: &str, chat_cwd: &str, repo: &RepoRef) -> bool {
    if let Some(pid) = &repo.project_id {
        if !chat_project_id.is_empty() && chat_project_id == pid {
            return true;
        }
    }
    cwd_key(chat_cwd) == cwd_key(&repo.cwd)
}

pub fn resolve_target(r: &DashboardTargetRef, groups: &[GroupDef], projects: &[ProjectInfo]) -> Option<DashboardTarget> {
    match r.kind.as_str() {
        "group" => {
            let g = groups.iter().find(|g| g.id == r.id)?;
            Some(group_target(g, projects))
        }
        "project" => {
            let p = find_project(&r.id, projects)?;
            Some(project_target(p))
        }
        _ => None,
    }
}

fn group_target(g: &GroupDef, projects: &[ProjectInfo]) -> DashboardTarget {
    DashboardTarget {
        kind: "group".into(),
        id: g.id.clone(),
        name: g.name.clone(),
        repos: g.repos.iter().map(|c| repo_ref(c, projects)).collect(),
    }
}

fn project_target(p: &ProjectInfo) -> DashboardTarget {
    DashboardTarget {
        kind: "project".into(),
        id: p.path.clone(),
        name: p.name.clone(),
        repos: vec![RepoRef { cwd: p.path.clone(), name: p.name.clone(), project_id: Some(p.id.clone()) }],
    }
}

fn row_for(
    target: DashboardTarget,
    projects: &[ProjectInfo],
    live: &[LiveChat],
    now_ms: i64,
    closed: &BTreeMap<String, i64>,
) -> DashboardListRow {
    let mut last_active_ms = 0i64;
    let mut newest_start_ms: Option<i64> = None;
    let (mut live_count, mut question_count, mut working_count) = (0u32, 0u32, 0u32);
    for repo in &target.repos {
        if let Some(p) = find_project(&repo.cwd, projects) {
            last_active_ms = last_active_ms.max(p.last_active_ms);
        }
        for c in live.iter().filter(|c| chat_in_repo(&c.project_id, &c.cwd, repo)) {
            live_count += 1;
            question_count += u32::from(c.question);
            working_count += u32::from(c.working);
            newest_start_ms = newest_start_ms.max(Some(c.started_ms));
            // A live chat means the project is being used right now, whatever
            // its stored last-active stamp says.
            last_active_ms = now_ms;
        }
    }
    let open = is_open(closed.get(&target_key(&target.kind, &target.id)).copied(), newest_start_ms);
    DashboardListRow { target, last_active_ms, live_count, question_count, working_count, open }
}

/// Groups first-class, then every existing project that no group lists, newest
/// activity first (ties by name so the order is stable between refreshes).
/// `closed` is the stored closed-targets map; closed rows are still returned,
/// flagged `open: false`, so the UI can offer them in a picker.
pub fn build_targets(
    groups: &[GroupDef],
    projects: &[ProjectInfo],
    live: &[LiveChat],
    now_ms: i64,
    closed: &BTreeMap<String, i64>,
) -> Vec<DashboardListRow> {
    let mut rows: Vec<DashboardListRow> =
        groups.iter().map(|g| row_for(group_target(g, projects), projects, live, now_ms, closed)).collect();
    for p in projects.iter().filter(|p| p.exists) {
        let swallowed = groups.iter().any(|g| g.repos.iter().any(|r| cwd_key(r) == cwd_key(&p.path)));
        if !swallowed {
            rows.push(row_for(project_target(p), projects, live, now_ms, closed));
        }
    }
    rows.sort_by(|a, b| {
        b.last_active_ms
            .cmp(&a.last_active_ms)
            .then_with(|| a.target.name.to_lowercase().cmp(&b.target.name.to_lowercase()))
    });
    rows
}

#[cfg(test)]
mod tests {
    use super::*;

    fn proj(id: &str, path: &str, name: &str, active: i64) -> ProjectInfo {
        ProjectInfo { id: id.into(), path: path.into(), name: name.into(), last_active_ms: active, exists: true }
    }

    fn group(id: &str, name: &str, repos: &[&str]) -> GroupDef {
        GroupDef { id: id.into(), name: name.into(), repos: repos.iter().map(|r| r.to_string()).collect(), ..Default::default() }
    }

    fn live(pid: &str, cwd: &str, question: bool, working: bool) -> LiveChat {
        LiveChat { project_id: pid.into(), cwd: cwd.into(), question, working, started_ms: 0 }
    }

    fn live_at(pid: &str, cwd: &str, started_ms: i64) -> LiveChat {
        LiveChat { started_ms, ..live(pid, cwd, false, true) }
    }

    fn closed_map(entries: &[(&str, &str, i64)]) -> BTreeMap<String, i64> {
        entries.iter().map(|(k, id, t)| (target_key(k, id), *t)).collect()
    }

    #[test]
    fn every_target_is_open_when_nothing_was_closed() {
        let projects = [proj("a", "C:/w/a", "a", 1), proj("b", "C:/w/b", "b", 2)];
        let rows = build_targets(&[], &projects, &[], 100, &BTreeMap::new());
        assert!(rows.iter().all(|r| r.open));
    }

    #[test]
    fn a_closed_target_stays_in_the_list_flagged_closed() {
        let projects = [proj("a", "C:/w/a", "a", 1), proj("b", "C:/w/b", "b", 2)];
        let closed = closed_map(&[("project", "C:/w/a/", 50)]);
        let rows = build_targets(&[], &projects, &[], 100, &closed);
        assert_eq!(rows.len(), 2);
        let a = rows.iter().find(|r| r.target.name == "a").unwrap();
        let b = rows.iter().find(|r| r.target.name == "b").unwrap();
        assert!(!a.open && b.open, "a trailing slash does not matter for the closed lookup");
    }

    #[test]
    fn a_chat_started_after_the_close_reopens_the_target_one_started_before_does_not() {
        let projects = [proj("a", "C:/w/a", "a", 1)];
        let closed = closed_map(&[("project", "C:/w/a", 1000)]);
        let newer = build_targets(&[], &projects, &[live_at("a", "C:/w/a", 1001)], 2000, &closed);
        assert!(newer[0].open);
        let older = build_targets(&[], &projects, &[live_at("a", "C:/w/a", 999)], 2000, &closed);
        assert!(!older[0].open, "a chat already running at close time does not reopen it");
        assert_eq!(older[0].live_count, 1, "it still counts as live");
    }

    #[test]
    fn a_group_reopens_when_a_chat_starts_in_any_of_its_repos() {
        let projects = [proj("a", "C:/w/api", "api", 0), proj("b", "C:/w/app", "app", 0)];
        let groups = [group("g1", "Client", &["C:/w/api", "C:/w/app"])];
        let closed = closed_map(&[("group", "g1", 500)]);
        let rows = build_targets(&groups, &projects, &[live_at("b", "C:/w/app", 600)], 700, &closed);
        assert!(rows[0].open);
        let rows = build_targets(&groups, &projects, &[], 700, &closed);
        assert!(!rows[0].open);
    }

    #[test]
    fn a_group_swallows_its_repos_from_the_project_list() {
        let projects = [proj("a", "C:/w/api", "api", 10), proj("b", "C:/w/app", "app", 20), proj("c", "C:/w/solo", "solo", 5)];
        let groups = [group("g1", "Client", &["C:\\w\\API", "C:/w/app"])];
        let rows = build_targets(&groups, &projects, &[], 1000, &BTreeMap::new());
        let names: Vec<&str> = rows.iter().map(|r| r.target.name.as_str()).collect();
        assert_eq!(names, ["Client", "solo"]);
        assert_eq!(rows[0].target.kind, "group");
        assert_eq!(rows[0].target.repos.len(), 2);
        assert_eq!(rows[0].target.repos[0].project_id.as_deref(), Some("a"));
    }

    #[test]
    fn rows_sort_by_most_recent_activity_and_a_group_takes_its_repos_max() {
        let projects = [proj("a", "C:/w/api", "api", 10), proj("b", "C:/w/app", "app", 90), proj("c", "C:/w/solo", "solo", 50)];
        let groups = [group("g1", "Client", &["C:/w/api", "C:/w/app"])];
        let rows = build_targets(&groups, &projects, &[], 1000, &BTreeMap::new());
        assert_eq!(rows[0].target.name, "Client");
        assert_eq!(rows[0].last_active_ms, 90);
        assert_eq!(rows[1].target.name, "solo");
    }

    #[test]
    fn a_live_chat_makes_its_project_the_most_recent_and_is_counted() {
        let projects = [proj("a", "C:/w/a", "a", 500), proj("b", "C:/w/b", "b", 100)];
        let chats = [live("b", "C:/w/b", true, false), live("b", "C:/w/b", false, true)];
        let rows = build_targets(&[], &projects, &chats, 9999, &BTreeMap::new());
        assert_eq!(rows[0].target.name, "b");
        assert_eq!(rows[0].last_active_ms, 9999);
        assert_eq!((rows[0].live_count, rows[0].question_count, rows[0].working_count), (2, 1, 1));
        assert_eq!((rows[1].live_count, rows[1].last_active_ms), (0, 500), "an idle project keeps its stored stamp");
    }

    #[test]
    fn a_group_counts_live_chats_across_all_its_repos() {
        let projects = [proj("a", "C:/w/api", "api", 0), proj("b", "C:/w/app", "app", 0)];
        let groups = [group("g1", "Client", &["C:/w/api", "C:/w/app"])];
        let chats = [live("a", "C:/w/api", true, false), live("b", "C:/w/app", false, true)];
        let rows = build_targets(&groups, &projects, &chats, 7, &BTreeMap::new());
        assert_eq!(rows.len(), 1);
        assert_eq!((rows[0].live_count, rows[0].question_count, rows[0].working_count), (2, 1, 1));
    }

    #[test]
    fn a_project_whose_folder_is_gone_is_skipped() {
        let mut gone = proj("a", "C:/w/gone", "gone", 99);
        gone.exists = false;
        let rows = build_targets(&[], &[gone, proj("b", "C:/w/here", "here", 1)], &[], 0, &BTreeMap::new());
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].target.name, "here");
    }

    #[test]
    fn ties_sort_by_name_so_the_order_is_stable() {
        let projects = [proj("a", "C:/w/zed", "Zed", 5), proj("b", "C:/w/alpha", "alpha", 5)];
        let rows = build_targets(&[], &projects, &[], 0, &BTreeMap::new());
        assert_eq!(rows[0].target.name, "alpha");
    }

    #[test]
    fn a_group_repo_that_is_not_a_known_project_keeps_a_folder_name_and_no_id() {
        let groups = [group("g1", "Client", &["C:/w/unknown-repo"])];
        let rows = build_targets(&groups, &[], &[], 0, &BTreeMap::new());
        let repo = &rows[0].target.repos[0];
        assert_eq!(repo.name, "unknown-repo");
        assert_eq!(repo.project_id, None);
    }

    #[test]
    fn resolve_finds_a_project_by_any_path_style_and_a_group_by_id() {
        let projects = [proj("a", "C:\\w\\App", "app", 0)];
        let groups = [group("g1", "Client", &["C:/w/app"])];
        let p = resolve_target(&DashboardTargetRef { kind: "project".into(), id: "c:/w/app/".into() }, &groups, &projects).unwrap();
        assert_eq!(p.name, "app");
        assert_eq!(p.id, "C:\\w\\App");
        let g = resolve_target(&DashboardTargetRef { kind: "group".into(), id: "g1".into() }, &groups, &projects).unwrap();
        assert_eq!(g.repos[0].project_id.as_deref(), Some("a"));
        assert!(resolve_target(&DashboardTargetRef { kind: "group".into(), id: "nope".into() }, &groups, &projects).is_none());
        assert!(resolve_target(&DashboardTargetRef { kind: "bogus".into(), id: "a".into() }, &groups, &projects).is_none());
    }

    #[test]
    fn chat_matching_prefers_project_id_then_falls_back_to_cwd() {
        let repo = RepoRef { cwd: "C:/w/app".into(), name: "app".into(), project_id: Some("p1".into()) };
        assert!(chat_in_repo("p1", "C:/w/app-worktree", &repo));
        assert!(chat_in_repo("", "c:\\w\\APP", &repo));
        assert!(!chat_in_repo("p2", "C:/w/other", &repo));
        let bare = RepoRef { cwd: "C:/w/app".into(), name: "app".into(), project_id: None };
        assert!(!chat_in_repo("p1", "C:/w/elsewhere", &bare));
    }
}
