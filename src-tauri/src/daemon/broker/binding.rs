//! Which broker services a chat may call (`ProjectConfig.broker_services`).
//!
//! The field is an `Option`: absent means "the project's tracker plus Figma",
//! worked out at read time from the project's own tracker or the git remote and
//! never written back to settings, so a later tracker change follows the
//! project. A present list is exactly what Joe bound, and `[]` binds nothing.
//!
//! The set applies to every chat the daemon spawns. A hidden sub gets its
//! parent's set: the claims the parent was last launched with when the daemon
//! holds them (so a binding Joe widened since cannot give a sub more than its
//! main chat has), else the set resolved from the root main chat's folder.
//! Autopilot is a flag on an ordinary chat, so it resolves from the project like
//! any other.

use super::services::Service;
use super::session::Role;
use crate::sessions::registry::Registry;
use crate::tickets::{TicketTracker, TrackerKind};
use crate::types::ProjectConfig;
use std::path::Path;

/// Longest chain of sub-of-sub rows followed; a cycle in bad data ends here.
const MAX_PARENT_HOPS: usize = 8;

/// The names in a stored list as a sorted, deduplicated service set. An unknown
/// name is dropped (it names nothing the engine could call).
pub fn parse_names(names: &[String]) -> Vec<Service> {
    normalize(names.iter().filter_map(|n| Service::parse(n)).collect())
}

/// Sorted by name and without repeats: the one order a token and a hint use.
pub fn normalize(mut services: Vec<Service>) -> Vec<Service> {
    services.sort_by_key(|s| s.name());
    services.dedup();
    services
}

/// What a project with no `broker_services` key gets: its tracker's service
/// (none when the tracker is off or unknown) plus Figma.
pub fn default_services(tracker: Option<&TicketTracker>) -> Vec<Service> {
    let mut out = vec![Service::Figma];
    match tracker.map(|t| t.kind) {
        Some(TrackerKind::Shortcut) => out.push(Service::Shortcut),
        Some(TrackerKind::Linear) => out.push(Service::Linear),
        Some(TrackerKind::Trello) => out.push(Service::Trello),
        Some(TrackerKind::Off) | None => {}
    }
    normalize(out)
}

/// The set for chats working under `cwd`. `tracker` is `tickets::effective_tracker`'s
/// answer for the same folder; the stored list wins over it when present.
pub fn project_services(projects: &[ProjectConfig], cwd: &Path, tracker: Option<&TicketTracker>) -> Vec<Service> {
    match crate::settings::identity::resolve_project_broker_services(projects, cwd) {
        Some(names) => parse_names(&names),
        None => default_services(tracker),
    }
}

/// The role and bound set a launch of `session_id` carries. `sub_parent` is the
/// main chat a sub belongs to (`subchats::role_launch`) and `parent_set` the
/// claims that chat was last launched with (`BrokerSessions::current`), which a
/// sub copies as is. With none (the daemon restarted since, or the parent is on
/// another machine) the set comes from the root main chat's folder, because a
/// sub works in a worktree of its own; a parent the registry does not know
/// falls back to the sub's own folder. `tracker_for` answers
/// `tickets::effective_tracker` for a folder and may run git, so callers run
/// this off the async runtime.
pub fn launch_scope(
    registry: &Registry,
    projects: &[ProjectConfig],
    sub_parent: Option<&str>,
    parent_set: Option<Vec<Service>>,
    own_cwd: &Path,
    tracker_for: impl Fn(&Path) -> Option<TicketTracker>,
) -> (Role, Vec<Service>) {
    let Some(parent) = sub_parent else {
        return (Role::Chat, project_services(projects, own_cwd, tracker_for(own_cwd).as_ref()));
    };
    if let Some(set) = parent_set {
        return (Role::Sub, normalize(set));
    }
    let mut root_cwd = own_cwd.to_path_buf();
    let mut next = Some(parent.to_string());
    for _ in 0..MAX_PARENT_HOPS {
        let Some(row) = next.take().and_then(|id| registry.get(&id)) else { break };
        root_cwd = row.cwd.clone();
        next = row.subchat_of.clone();
    }
    (Role::Sub, project_services(projects, &root_cwd, tracker_for(&root_cwd).as_ref()))
}

/// The line a refusal prints: the exact list to store. Never a card; Joe edits
/// the project's setting himself.
pub fn binding_hint(service: Service, bound: &[Service]) -> String {
    let mut with = bound.to_vec();
    with.push(service);
    let list = normalize(with).iter().map(|s| format!("{:?}", s.name())).collect::<Vec<_>>().join(", ");
    let now = if bound.is_empty() {
        "nothing".to_string()
    } else {
        bound.iter().map(|s| s.name()).collect::<Vec<_>>().join(", ")
    };
    format!(
        "to allow {name}, Joe adds it to this project's broker_services (now: {now}): \"broker_services\": [{list}]",
        name = service.name()
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sessions::registry::Registry;
    use crate::types::ProjectConfig;

    fn project(path: &str, tracker: Option<TrackerKind>, broker: Option<&[&str]>) -> ProjectConfig {
        let mut p: ProjectConfig = serde_json::from_value(serde_json::json!({
            "id": path, "path": path, "name": path, "created_at": "2026-11-18T00:00:00Z"
        }))
        .unwrap();
        p.tracker = tracker.map(|kind| TicketTracker { kind, workspace: "ws".into() });
        p.broker_services = broker.map(|b| b.iter().map(|s| s.to_string()).collect());
        p
    }

    fn names(s: &[Service]) -> Vec<&'static str> {
        s.iter().map(|s| s.name()).collect()
    }

    #[test]
    fn an_absent_field_is_the_tracker_plus_figma() {
        let t = |k| Some(TicketTracker { kind: k, workspace: "ws".into() });
        assert_eq!(names(&default_services(t(TrackerKind::Shortcut).as_ref())), ["figma", "shortcut"]);
        assert_eq!(names(&default_services(t(TrackerKind::Linear).as_ref())), ["figma", "linear"]);
        assert_eq!(names(&default_services(t(TrackerKind::Trello).as_ref())), ["figma", "trello"]);
        assert_eq!(names(&default_services(t(TrackerKind::Off).as_ref())), ["figma"]);
        assert_eq!(names(&default_services(None)), ["figma"]);
    }

    #[test]
    fn a_stored_list_wins_over_the_tracker_and_empty_binds_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let p = project(dir.path().to_str().unwrap(), Some(TrackerKind::Linear), Some(&["clockify", "Trello", "trello", "nonsense"]));
        let projects = [p];
        let tracker = projects[0].tracker.clone();
        assert_eq!(names(&project_services(&projects, dir.path(), tracker.as_ref())), ["clockify", "trello"]);

        let mut none = projects[0].clone();
        none.broker_services = Some(Vec::new());
        assert!(project_services(&[none], dir.path(), tracker.as_ref()).is_empty(), "an explicit empty list binds nothing, not the default");
    }

    #[test]
    fn a_folder_in_no_project_still_gets_the_default_from_its_remote_tracker() {
        let dir = tempfile::tempdir().unwrap();
        let tracker = Some(TicketTracker { kind: TrackerKind::Shortcut, workspace: "zirtue".into() });
        assert_eq!(names(&project_services(&[], dir.path(), tracker.as_ref())), ["figma", "shortcut"]);
    }

    #[test]
    fn the_default_is_never_written_into_the_project() {
        let dir = tempfile::tempdir().unwrap();
        let projects = [project(dir.path().to_str().unwrap(), Some(TrackerKind::Shortcut), None)];
        let _ = project_services(&projects, dir.path(), projects[0].tracker.as_ref());
        assert_eq!(projects[0].broker_services, None);
        let raw = serde_json::to_value(&projects[0]).unwrap();
        assert!(raw["broker_services"].is_null(), "resolving reads only; the stored field stays absent");
    }

    fn registry_with_rows(rows: &[(&str, &Path, Option<&str>)]) -> Registry {
        let r = Registry::new();
        for (id, cwd, parent) in rows {
            r.upsert_interactive(id, cwd, "p", "2026-11-18T00:00:00Z");
            if let Some(p) = parent {
                r.set_subchat_of(id, Some(p.to_string()));
            }
        }
        r
    }

    #[test]
    fn a_sub_inherits_its_parents_set_not_its_own_folders() {
        let main_dir = tempfile::tempdir().unwrap();
        let tree = tempfile::tempdir().unwrap();
        let projects = [project(main_dir.path().to_str().unwrap(), Some(TrackerKind::Shortcut), Some(&["clockify"]))];
        let reg = registry_with_rows(&[("main", main_dir.path(), None), ("sub", tree.path(), Some("main"))]);
        let none = |_: &Path| None;

        let (role, set) = launch_scope(&reg, &projects, Some("main"), None, tree.path(), none);
        assert_eq!(role, Role::Sub);
        assert_eq!(names(&set), ["clockify"], "the sub's folder belongs to no project, the parent's does");

        let (role, own) = launch_scope(&reg, &projects, None, None, tree.path(), none);
        assert_eq!(role, Role::Chat);
        assert_eq!(names(&own), ["figma"], "a plain chat in that folder gets only the default");
    }

    #[test]
    fn a_sub_of_a_sub_walks_up_to_the_main_chat_and_a_cycle_ends() {
        let main_dir = tempfile::tempdir().unwrap();
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        let projects = [project(main_dir.path().to_str().unwrap(), None, Some(&["hubstaff"]))];
        let reg = registry_with_rows(&[("main", main_dir.path(), None), ("mid", a.path(), Some("main")), ("leaf", b.path(), Some("mid"))]);
        let (_, set) = launch_scope(&reg, &projects, Some("mid"), None, b.path(), |_| None);
        assert_eq!(names(&set), ["hubstaff"]);

        let cyc = registry_with_rows(&[("x", a.path(), Some("y")), ("y", b.path(), Some("x"))]);
        let (_, set) = launch_scope(&cyc, &projects, Some("x"), None, a.path(), |_| None);
        assert_eq!(names(&set), ["figma"], "a cycle stops after the hop cap and resolves from where it stopped");
    }

    #[test]
    fn a_parent_the_registry_does_not_know_falls_back_to_the_subs_own_folder() {
        let dir = tempfile::tempdir().unwrap();
        let projects = [project(dir.path().to_str().unwrap(), None, Some(&["trello"]))];
        let (role, set) = launch_scope(&Registry::new(), &projects, Some("away-main"), None, dir.path(), |_| None);
        assert_eq!((role, names(&set)), (Role::Sub, vec!["trello"]));
    }

    #[test]
    fn a_sub_copies_the_claims_its_parent_runs_with_not_what_the_settings_say_now() {
        let dir = tempfile::tempdir().unwrap();
        // Joe has since widened the project to three services; the main chat still runs with one.
        let projects = [project(dir.path().to_str().unwrap(), None, Some(&["figma", "linear", "shortcut"]))];
        let reg = registry_with_rows(&[("main", dir.path(), None), ("sub", dir.path(), Some("main"))]);
        let (role, set) = launch_scope(&reg, &projects, Some("main"), Some(vec![Service::Figma]), dir.path(), |_| None);
        assert_eq!((role, names(&set)), (Role::Sub, vec!["figma"]));
    }

    #[test]
    fn the_hint_prints_the_whole_list_to_store() {
        let hint = binding_hint(Service::Linear, &[Service::Shortcut, Service::Figma]);
        assert!(hint.contains(r#""broker_services": ["figma", "linear", "shortcut"]"#), "{hint}");
        assert!(hint.contains("now: shortcut, figma"));
        assert!(binding_hint(Service::Figma, &[]).contains("now: nothing"));
    }
}
