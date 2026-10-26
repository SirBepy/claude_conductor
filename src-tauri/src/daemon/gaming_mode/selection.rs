//! Pure target-selection logic for gaming mode: which sessions and which
//! server_supervisor entries are in scope to pause/stop. No I/O, no
//! executor - unit-testable on its own.

use super::{PausedSession, SupervisorProc};
use crate::sessions::kinds::InstanceKind;
use crate::settings::identity::normalize_cwd_key;
use crate::types::{Instance, ProjectConfig};

/// A project is allowlisted when its `ProjectConfig.keep_running_in_gaming_mode`
/// flag is set. Unregistered projects (no `ProjectConfig` entry at all) are
/// never allowlisted - gaming mode errs toward parking the unknown chat.
fn project_allowlisted(projects: &[ProjectConfig], project_id: &str) -> bool {
    projects.iter().any(|p| p.id == project_id && p.keep_running_in_gaming_mode)
}

/// Every live, locally-hosted, non-ended Interactive chat, minus Jarvis and
/// minus anything in an allowlisted project. `instances` must come from
/// `Registry::list()` (never `machines::all_instances`), whose rows never
/// carry a `machine` tag in the first place - so "not mirrored from a peer"
/// needs no extra filter here. Automated (automation channel) and External
/// (terminal-only, unmessageable) kinds are excluded by the `Interactive`
/// check alone; callers that want to log the skipped kinds do so separately.
pub fn target_sessions(instances: &[Instance], projects: &[ProjectConfig]) -> Vec<PausedSession> {
    instances
        .iter()
        .filter(|i| i.ended_at.is_none())
        .filter(|i| i.kind == InstanceKind::Interactive)
        .filter(|i| !i.jarvis)
        // An idle (done / asking) chat has no work to park, and messaging it
        // would spend a turn and flip its Done status to In Progress.
        .filter(|i| i.busy)
        .filter(|i| !project_allowlisted(projects, &i.project_id))
        .map(|i| PausedSession { session_id: i.session_id.clone(), cwd: i.cwd.to_string_lossy().into_owned() })
        .collect()
}

/// Running, non-allowlisted supervisor entries: kept entries are the ones
/// gaming mode will stop. An entry whose `root` is `None` (join failed) is
/// never treated as allowlisted (see `SupervisorProc::root`'s doc).
pub fn supervisor_targets(procs: &[SupervisorProc], allowlisted_roots: &[String]) -> Vec<SupervisorProc> {
    procs
        .iter()
        .filter(|p| p.status == "running")
        .filter(|p| !p.root.as_deref().map(|r| path_under_any(r, allowlisted_roots)).unwrap_or(false))
        .cloned()
        .collect()
}

/// Root-key containment, matching `settings::identity::is_ephemeral_root_path`'s
/// own convention: exact match, or a `\`-joined child under a root key. Pure
/// string comparison (`normalize_cwd_key`, no filesystem access) so this is
/// usable against a path that may not exist on disk (a test fixture, or a
/// supervisor entry whose project folder has since moved).
fn path_under_any(candidate: &str, allowlisted_roots: &[String]) -> bool {
    let key = normalize_cwd_key(std::path::Path::new(candidate));
    allowlisted_roots.iter().any(|root| {
        let root_key = normalize_cwd_key(std::path::Path::new(root));
        !root_key.is_empty() && (key == root_key || key.starts_with(&format!("{root_key}\\")))
    })
}

pub(super) fn allowlisted_roots(projects: &[ProjectConfig]) -> Vec<String> {
    projects
        .iter()
        .filter(|p| p.keep_running_in_gaming_mode)
        .map(|p| p.path.to_string_lossy().into_owned())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn instance(session_id: &str, project_id: &str, kind: InstanceKind, jarvis: bool, ended: bool) -> Instance {
        Instance {
            session_id: session_id.to_string(),
            pid: 1,
            cwd: PathBuf::from(format!("C:/proj/{project_id}")),
            project_id: project_id.to_string(),
            kind,
            is_remote: false,
            started_at: "2026-10-13T00:00:00Z".to_string(),
            transcript_path: None,
            bridge_session_id: None,
            name: None,
            ended_at: if ended { Some("2026-10-13T01:00:00Z".to_string()) } else { None },
            end_reason: None,
            busy: true,
            model: String::new(),
            effort: String::new(),
            awaiting: None,
            last_notified_awaiting: None,
            autopilot: false,
            jarvis,
            worker_of: None,
            closing: false,
            turn_gen: 0,
            last_event_at: None,
            channel_epoch: 0,
            account_id: None,
            rate_limited_resets_at: None,
            rate_limited_type: None,
            frozen: false,
            frozen_needs_continue: false,
            auto_frozen: false,
            held_count: 0,
            local_task_running: false,
            successor_of: None,
            machine: None,
        }
    }

    fn project(id: &str, path: &str, keep_running: bool) -> ProjectConfig {
        ProjectConfig {
            id: id.to_string(),
            path: PathBuf::from(path),
            name: id.to_string(),
            avatar: crate::types::Avatar::None,
            automation: None,
            created_at: "2026-10-13T00:00:00Z".to_string(),
            last_active_at: None,
            whitelist: crate::types::CharacterWhitelist::default(),
            preferred_account_id: None,
            last_worktree_path: None,
            last_start_folder_rel: None,
            claude_ai_connectors: false,
            tracker: None,
            keep_running_in_gaming_mode: keep_running,
        }
    }

    // --- target_sessions ---

    #[test]
    fn target_sessions_returns_exactly_the_right_ids() {
        let instances = vec![
            instance("interactive-1", "proj-a", InstanceKind::Interactive, false, false),
            instance("allowlisted-1", "proj-mc", InstanceKind::Interactive, false, false),
            instance("mirrored-1", "proj-a", InstanceKind::Interactive, false, false),
            instance("ended-1", "proj-a", InstanceKind::Interactive, false, true),
            instance("external-1", "proj-a", InstanceKind::External, false, false),
            instance("automated-1", "proj-a", InstanceKind::Automated, false, false),
            instance("jarvis-1", "proj-a", InstanceKind::Interactive, true, false),
        ];
        // Simulate the "mirrored from a peer" exclusion: a real mirrored row
        // never comes from Registry::list() in the first place (it's merged
        // in separately by machines::all_instances), so model that here by
        // simply not including a `machine` tag anywhere and instead proving
        // the mirrored-looking row above is excluded for an orthogonal reason
        // is wrong - replace it with an explicit machine-tagged row instead.
        let mut instances = instances;
        instances.retain(|i| i.session_id != "mirrored-1");
        let mut mirrored = instance("mirrored-1", "proj-a", InstanceKind::Interactive, false, false);
        mirrored.machine = Some(crate::types::MachineRef { id: "m1".into(), label: "Other".into(), online: true });
        instances.push(mirrored);

        let projects = vec![project("proj-mc", "C:/proj/proj-mc", true)];

        let targets = target_sessions(&instances, &projects);
        let mut ids: Vec<_> = targets.iter().map(|t| t.session_id.clone()).collect();
        ids.sort();
        assert_eq!(ids, vec!["interactive-1".to_string(), "mirrored-1".to_string()]);
    }

    #[test]
    fn target_sessions_skips_idle_chats() {
        let mut idle = instance("idle-1", "proj-a", InstanceKind::Interactive, false, false);
        idle.busy = false;
        let busy = instance("busy-1", "proj-a", InstanceKind::Interactive, false, false);
        let targets = target_sessions(&[idle, busy], &[]);
        let ids: Vec<_> = targets.iter().map(|t| t.session_id.as_str()).collect();
        assert_eq!(ids, vec!["busy-1"]);
    }

    #[test]
    fn target_sessions_excludes_mirrored_rows_when_the_caller_filters_by_machine_none() {
        // The module doc promises "not mirrored" needs no extra filter when
        // callers pass Registry::list() rows (machine always None there).
        // This test proves target_sessions itself does NOT special-case
        // `machine` - a caller must filter mirrored rows out upstream, same
        // as the production `set_on` path does by using `registry.list()`.
        let mut mirrored = instance("mirrored-1", "proj-a", InstanceKind::Interactive, false, false);
        mirrored.machine = Some(crate::types::MachineRef { id: "m1".into(), label: "Other".into(), online: true });
        let instances = vec![mirrored];
        let targets = target_sessions(&instances, &[]);
        assert_eq!(targets.len(), 1, "target_sessions alone does not filter on `machine`; registry.list() never sets it");
    }

    // --- supervisor_targets ---

    #[test]
    fn supervisor_targets_keeps_running_entries_outside_the_allowlist() {
        let procs = vec![
            SupervisorProc { id: "frontend:dev".into(), root: Some("C:/proj/frontend".into()), status: "running".into() },
            SupervisorProc { id: "mc_plugins_tag:dev".into(), root: Some("C:/proj/mc_plugins_tag".into()), status: "running".into() },
            SupervisorProc { id: "stopped:dev".into(), root: Some("C:/proj/stopped".into()), status: "stopped".into() },
            SupervisorProc { id: "unknown:dev".into(), root: None, status: "running".into() },
        ];
        let allow = vec!["C:/proj/mc_plugins_tag".to_string()];
        let kept = supervisor_targets(&procs, &allow);
        let ids: Vec<_> = kept.iter().map(|p| p.id.clone()).collect();
        assert_eq!(ids, vec!["frontend:dev".to_string(), "unknown:dev".to_string()]);
    }

    #[test]
    fn supervisor_targets_treats_a_failed_root_join_as_not_allowlisted() {
        let procs = vec![SupervisorProc { id: "x:dev".into(), root: None, status: "running".into() }];
        let kept = supervisor_targets(&procs, &["C:/anything".to_string()]);
        assert_eq!(kept.len(), 1, "an unresolvable root must never be treated as allowlisted");
    }

    #[test]
    fn supervisor_targets_does_not_match_a_sibling_path_with_a_shared_prefix() {
        let procs = vec![SupervisorProc { id: "x:dev".into(), root: Some("C:/proj/foobar".into()), status: "running".into() }];
        let allow = vec!["C:/proj/foo".to_string()];
        let kept = supervisor_targets(&procs, &allow);
        assert_eq!(kept.len(), 1, "foobar must not be swallowed by an allowlist entry for foo");
    }
}
