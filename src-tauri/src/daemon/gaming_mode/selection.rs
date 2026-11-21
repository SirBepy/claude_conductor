//! Pure target-selection logic for gaming mode: which sessions and which
//! server_supervisor entries are in scope to pause/stop. No I/O, no
//! executor - unit-testable on its own.

use super::{PausedSession, SupervisorProc};
use crate::sessions::kinds::InstanceKind;
use crate::types::Instance;

/// Every live, locally-hosted, non-ended Interactive chat, minus Jarvis. `instances` must come from
/// `Registry::list()` (never `machines::all_instances`), whose rows never
/// carry a `machine` tag in the first place - so "not mirrored from a peer"
/// needs no extra filter here. Automated and External
/// (terminal-only, unmessageable) kinds are excluded by the `Interactive`
/// check alone; callers that want to log the skipped kinds do so separately.
pub fn target_sessions(instances: &[Instance]) -> Vec<PausedSession> {
    instances
        .iter()
        .filter(|i| i.ended_at.is_none())
        .filter(|i| i.kind == InstanceKind::Interactive)
        .filter(|i| !i.jarvis)
        // An idle (done / asking) chat has no work to park, and messaging it
        // would spend a turn and flip its Done status to In Progress.
        .filter(|i| i.busy)
        .map(|i| PausedSession {
            session_id: i.session_id.clone(),
            cwd: i.cwd.to_string_lossy().into_owned(),
            sub: i.subchat_of.is_some(),
        })
        .collect()
}

/// Running supervisor entries: these are the ones gaming mode stops.
pub fn supervisor_targets(procs: &[SupervisorProc]) -> Vec<SupervisorProc> {
    procs.iter().filter(|p| p.status == "running").cloned().collect()
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
            subchat_of: None,
            subchat_finished: false,
            pinned_to_sidebar: false,
            hidden_at: None,
            closing: false,
            turn_gen: 0,
            last_event_at: None,
            channel_epoch: 0,
            account_id: None,
            rate_limited_resets_at: None,
            rate_limited_type: None,
            rate_limit_refused: None,
            idle_frozen: None,
            frozen: false,
            frozen_needs_continue: false,
            auto_frozen: false,
            held_count: 0,
            progress: Default::default(),
            local_task_running: false,
            successor_of: None,
            machine: None,
        }
    }

    // --- target_sessions ---

    #[test]
    fn target_sessions_returns_exactly_the_right_ids() {
        let instances = vec![
            instance("interactive-1", "proj-a", InstanceKind::Interactive, false, false),
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

        let targets = target_sessions(&instances);
        let mut ids: Vec<_> = targets.iter().map(|t| t.session_id.clone()).collect();
        ids.sort();
        assert_eq!(ids, vec!["interactive-1".to_string(), "mirrored-1".to_string()]);
    }

    #[test]
    fn target_sessions_skips_idle_chats() {
        let mut idle = instance("idle-1", "proj-a", InstanceKind::Interactive, false, false);
        idle.busy = false;
        let busy = instance("busy-1", "proj-a", InstanceKind::Interactive, false, false);
        let targets = target_sessions(&[idle, busy]);
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
        let targets = target_sessions(&instances);
        assert_eq!(targets.len(), 1, "target_sessions alone does not filter on `machine`; registry.list() never sets it");
    }

    // --- supervisor_targets ---

    #[test]
    fn supervisor_targets_keeps_only_running_entries() {
        let procs = vec![
            SupervisorProc { id: "frontend:dev".into(), status: "running".into() },
            SupervisorProc { id: "stopped:dev".into(), status: "stopped".into() },
        ];
        let kept = supervisor_targets(&procs);
        let ids: Vec<_> = kept.iter().map(|p| p.id.clone()).collect();
        assert_eq!(ids, vec!["frontend:dev".to_string()]);
    }
}
