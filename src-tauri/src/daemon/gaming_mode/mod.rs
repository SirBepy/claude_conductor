//! Gaming mode: one switch that parks every eligible chat and stops every
//! supervised dev server, Docker container and Docker Desktop itself, then
//! reverses all of it on the way back off. Replaces the hand-run Jarvis
//! sequence (todo source: dev-origin, approved 2026-10-13) with a
//! daemon-owned, restart-safe version.
//!
//! Delivery into a chat (park on, resume on off) reuses the EXACT mechanism
//! `daemon::schedule_fire::fire_message`/`respawn_for_message` already give
//! every other out-of-band send: a `ScheduledKind::Message` item, persisted
//! to `scheduled-items.json` and picked up by `daemon::schedule`'s tick loop.
//! That loop already defers into a busy session (`is_message_session_busy`,
//! retried every ~30s inside the grace window) and already respawns a
//! session with no live child (`respawn_for_message`) - this module invents
//! no second delivery path, it only enqueues through
//! [`GamingModeExecutor::queue_message`].
//!
//! Every side effect that reaches outside this process (the supervisor HTTP
//! API, `docker`, `docker desktop`, and the message enqueue itself) goes
//! through the [`GamingModeExecutor`] trait so tests exercise a
//! `FakeExecutor` that only records calls - [`executor::RealExecutor`] is
//! wired at daemon startup and is never constructed by a test.
//!
//! Split across this folder (todo 1139/1145): this file keeps the trait,
//! the persisted/response shapes, and the `turn_on`/`turn_off` orchestration;
//! [`executor`] holds the side-effecting `RealExecutor`; [`selection`] holds
//! the pure target-selection logic; [`persist`] holds the on-disk state file.

mod executor;
mod persist;
mod selection;

use crate::sessions::kinds::InstanceKind;
use crate::types::{Instance, ProjectConfig};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use executor::RealExecutor;
use selection::{allowlisted_roots, supervisor_targets, target_sessions};

pub use persist::{config_path_for, load_file};
use persist::save_file;

/// Verbatim-in-spirit park instruction (source todo, 2026-10-13): finish
/// cleanly, kill self-started loops/servers, start nothing new, never leave
/// a half-done commit/push, and say where it stopped.
pub const PARK_MESSAGE: &str = "Gaming mode is turning on. Finish the current step cleanly, kill your own \
tests/builds/loops/dev servers, do not re-arm loops or schedule anything, start no new work, never leave a \
half-done commit or push, end with a short stopping note saying where you stopped.";

pub const RESUME_MESSAGE: &str = "Gaming mode is off. Resume from your stopping note.";

/// One session gaming mode parked, enough to respawn-and-message it again on
/// resume even across a daemon restart (`cwd` is required by
/// `ScheduledKind::Message`'s own respawn path).
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct PausedSession {
    pub session_id: String,
    pub cwd: String,
}

/// One server_supervisor entry gaming mode stopped, enough to restart it by
/// id on resume.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct StoppedProc {
    pub id: String,
}

/// Persisted at `<app_data>/gaming-mode{instance_suffix}.json`. Written
/// atomically BEFORE any side effect runs (`turn_on`), so a crash mid-pause
/// still leaves enough on disk for `turn_off` to undo exactly what was
/// started, even across a daemon/app restart in between.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct GamingModeFile {
    #[serde(default)]
    pub on: bool,
    #[serde(default)]
    pub started_at: Option<String>,
    #[serde(default)]
    pub paused_sessions: Vec<PausedSession>,
    #[serde(default)]
    pub stopped_procs: Vec<StoppedProc>,
    #[serde(default)]
    pub stopped_containers: Vec<String>,
    #[serde(default)]
    pub docker_desktop_was_running: bool,
}

/// `get_gaming_mode`/`set_gaming_mode` RPC response shape: the persisted
/// state plus a short human summary of the last transition.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct GamingModeSummary {
    pub on: bool,
    pub paused_sessions: usize,
    pub stopped_procs: usize,
    pub stopped_containers: usize,
    pub docker_desktop_stopped: bool,
}

/// One server_supervisor entry, as surfaced by `GET /procs` joined against
/// its project's `root` the same way `sv.ps1 ensure` resolves it (`/procs`
/// gives `id`/`status`, the project root comes from a sibling
/// `projects.json` keyed by the id's `<project>:` prefix - see
/// `~/.claude/skills/supervised-run/sv.ps1`'s `Get-ProjectsRegistry`, read
/// this session). `root` is `None` when that join fails (unknown project,
/// or a supervisor build with a different projects.json shape); such an
/// entry is treated as NOT allowlisted - gaming mode errs toward stopping an
/// unresolvable entry rather than silently sparing it.
#[derive(Clone, Debug, PartialEq)]
pub struct SupervisorProc {
    pub id: String,
    pub root: Option<String>,
    pub status: String,
}

/// Every outside-this-process effect gaming mode performs, behind one trait
/// so `turn_on`/`turn_off` are unit-testable without touching a real
/// supervisor, Docker, or the scheduled-items store. [`executor::RealExecutor`]
/// is the only production implementation; every test in this module uses
/// `FakeExecutor` instead.
pub trait GamingModeExecutor: Send + Sync {
    /// `GET /procs` from server_supervisor, already joined with `root`.
    /// `Err` (supervisor unreachable) is tolerated by callers: logged, then
    /// treated as "nothing to stop", never a hard failure of the whole toggle.
    fn supervisor_procs(&self) -> Result<Vec<SupervisorProc>, String>;
    fn supervisor_stop(&self, id: &str) -> Result<(), String>;
    fn supervisor_start(&self, id: &str) -> Result<(), String>;
    /// `docker ps -q` equivalent: ids of currently RUNNING containers only.
    fn docker_running_containers(&self) -> Result<Vec<String>, String>;
    fn docker_stop(&self, ids: &[String]) -> Result<(), String>;
    fn docker_start(&self, ids: &[String]) -> Result<(), String>;
    fn docker_desktop_running(&self) -> bool;
    fn docker_desktop_stop(&self);
    fn docker_desktop_start(&self);
    /// Enqueues `prompt` into `session_id` via the existing scheduled-message
    /// delivery path (busy-retry + dead-respawn both live in
    /// `daemon::schedule`'s tick loop, not here).
    fn queue_message(&self, session_id: &str, cwd: &str, prompt: &str);
}

// --- Orchestration ---

/// Turns gaming mode on: computes targets, persists the full plan BEFORE any
/// side effect, then runs the side effects in the order the spec fixes
/// (message delivery, supervisor stops, docker stop, Docker Desktop stop).
/// Idempotent: a second `turn_on` while already on is a no-op that returns
/// the existing summary, never a double-pause.
pub fn turn_on(
    instances: &[Instance],
    projects: &[ProjectConfig],
    exec: &dyn GamingModeExecutor,
) -> GamingModeSummary {
    let existing = load_file();
    if existing.on {
        return summary_of(&existing);
    }

    for skipped in instances.iter().filter(|i| i.ended_at.is_none() && i.kind == InstanceKind::External) {
        log::info!("gaming-mode: skipping external (terminal-only) session {} - cannot be messaged", skipped.session_id);
    }

    let targets = target_sessions(instances, projects);
    let procs = exec.supervisor_procs().unwrap_or_else(|e| {
        log::warn!("gaming-mode: supervisor_procs failed, treating as nothing to stop: {e}");
        Vec::new()
    });
    let roots = allowlisted_roots(projects);
    let stop_targets = supervisor_targets(&procs, &roots);
    let containers = exec.docker_running_containers().unwrap_or_else(|e| {
        log::warn!("gaming-mode: docker_running_containers failed, treating as nothing to stop: {e}");
        Vec::new()
    });
    let docker_desktop_was_running = exec.docker_desktop_running();

    let file = GamingModeFile {
        on: true,
        started_at: Some(chrono::Utc::now().to_rfc3339()),
        paused_sessions: targets.clone(),
        stopped_procs: stop_targets.iter().map(|p| StoppedProc { id: p.id.clone() }).collect(),
        stopped_containers: containers.clone(),
        docker_desktop_was_running,
    };
    // Persisted BEFORE any side effect below, so a crash mid-pause still
    // leaves `turn_off` enough to undo everything already started.
    save_file(&file);

    for s in &targets {
        exec.queue_message(&s.session_id, &s.cwd, PARK_MESSAGE);
    }
    for p in &stop_targets {
        if let Err(e) = exec.supervisor_stop(&p.id) {
            log::warn!("gaming-mode: supervisor_stop({}) failed: {e}", p.id);
        }
    }
    if !containers.is_empty() {
        if let Err(e) = exec.docker_stop(&containers) {
            log::warn!("gaming-mode: docker_stop failed: {e}");
        }
    }
    if docker_desktop_was_running {
        exec.docker_desktop_stop();
    }

    summary_of(&file)
}

/// Turns gaming mode off: reverses exactly what the persisted file (which may
/// have been loaded fresh after a daemon/app restart - see module doc)
/// recorded, in the spec's fixed order, then clears the file last.
/// Idempotent: a second `turn_off` while already off is a no-op.
pub fn turn_off(exec: &dyn GamingModeExecutor) -> GamingModeSummary {
    let file = load_file();
    if !file.on {
        return summary_of(&file);
    }

    if file.docker_desktop_was_running {
        exec.docker_desktop_start();
    }
    if !file.stopped_containers.is_empty() {
        if let Err(e) = exec.docker_start(&file.stopped_containers) {
            log::warn!("gaming-mode: docker_start failed: {e}");
        }
    }
    for p in &file.stopped_procs {
        if let Err(e) = exec.supervisor_start(&p.id) {
            log::warn!("gaming-mode: supervisor_start({}) failed: {e}", p.id);
        }
    }
    for s in &file.paused_sessions {
        exec.queue_message(&s.session_id, &s.cwd, RESUME_MESSAGE);
    }

    // Counts describe what this call just undid; `on` reflects the state
    // AFTER this transition (false), not `file.on` (still true - it's the
    // pre-transition record this call is reversing).
    let summary = GamingModeSummary {
        on: false,
        paused_sessions: file.paused_sessions.len(),
        stopped_procs: file.stopped_procs.len(),
        stopped_containers: file.stopped_containers.len(),
        docker_desktop_stopped: false,
    };
    save_file(&GamingModeFile::default());
    summary
}

/// Shared by `get_gaming_mode`'s RPC handler too (`methods::gaming_mode`),
/// so the "already on"/"already off" summary shape is computed in one place.
pub fn summary_of(file: &GamingModeFile) -> GamingModeSummary {
    GamingModeSummary {
        on: file.on,
        paused_sessions: file.paused_sessions.len(),
        stopped_procs: file.stopped_procs.len(),
        stopped_containers: file.stopped_containers.len(),
        docker_desktop_stopped: file.on && file.docker_desktop_was_running,
    }
}

/// Convenience used by the RPC layer: runs the real toggle against the
/// daemon's live registry/settings snapshot and `RealExecutor`.
pub fn set_on(state: &Arc<crate::daemon::state::DaemonState>, on: bool) -> GamingModeSummary {
    let exec = RealExecutor;
    if on {
        let instances = state.registry.list();
        let projects = state.settings.snapshot().projects;
        turn_on(&instances, &projects, &exec)
    } else {
        turn_off(&exec)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::Mutex as StdMutex;

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

    /// Isolates `config_path()`'s target file per test by scoping
    /// `CC_DATA_DIR` (the same env var `settings::paths::resolve_data_dir`
    /// already reads) to a fresh tempdir for the duration of the closure.
    /// Guarded by the crate's shared env-mutation lock
    /// (`util::ENV_MUTATION_LOCK`), not a local one - a per-module mutex
    /// alone doesn't stop a DIFFERENT module's env-mutating test from
    /// stomping this one under the multi-threaded test runner.
    fn with_isolated_data_dir<T>(f: impl FnOnce() -> T) -> T {
        let _guard = crate::util::ENV_MUTATION_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let tmp = tempfile::tempdir().unwrap();
        let prev = std::env::var("CC_DATA_DIR").ok();
        std::env::set_var("CC_DATA_DIR", tmp.path());
        let result = f();
        match prev {
            Some(v) => std::env::set_var("CC_DATA_DIR", v),
            None => std::env::remove_var("CC_DATA_DIR"),
        }
        result
    }

    // --- Fake executor + turn_on/turn_off ---

    #[derive(Default)]
    struct FakeExecutor {
        calls: StdMutex<Vec<String>>,
        procs: Vec<SupervisorProc>,
        containers: Vec<String>,
        docker_desktop_running: bool,
    }

    impl FakeExecutor {
        fn calls(&self) -> Vec<String> {
            self.calls.lock().unwrap().clone()
        }
    }

    impl GamingModeExecutor for FakeExecutor {
        fn supervisor_procs(&self) -> Result<Vec<SupervisorProc>, String> {
            self.calls.lock().unwrap().push("supervisor_procs".into());
            Ok(self.procs.clone())
        }
        fn supervisor_stop(&self, id: &str) -> Result<(), String> {
            self.calls.lock().unwrap().push(format!("supervisor_stop({id})"));
            Ok(())
        }
        fn supervisor_start(&self, id: &str) -> Result<(), String> {
            self.calls.lock().unwrap().push(format!("supervisor_start({id})"));
            Ok(())
        }
        fn docker_running_containers(&self) -> Result<Vec<String>, String> {
            self.calls.lock().unwrap().push("docker_running_containers".into());
            Ok(self.containers.clone())
        }
        fn docker_stop(&self, ids: &[String]) -> Result<(), String> {
            self.calls.lock().unwrap().push(format!("docker_stop({})", ids.join(",")));
            Ok(())
        }
        fn docker_start(&self, ids: &[String]) -> Result<(), String> {
            self.calls.lock().unwrap().push(format!("docker_start({})", ids.join(",")));
            Ok(())
        }
        fn docker_desktop_running(&self) -> bool {
            self.calls.lock().unwrap().push("docker_desktop_running".into());
            self.docker_desktop_running
        }
        fn docker_desktop_stop(&self) {
            self.calls.lock().unwrap().push("docker_desktop_stop".into());
        }
        fn docker_desktop_start(&self) {
            self.calls.lock().unwrap().push("docker_desktop_start".into());
        }
        fn queue_message(&self, session_id: &str, _cwd: &str, prompt: &str) {
            let tag = if prompt == PARK_MESSAGE { "park" } else { "resume" };
            self.calls.lock().unwrap().push(format!("queue_message({session_id},{tag})"));
        }
    }

    #[test]
    fn turn_on_persists_state_before_any_side_effect_and_records_calls_in_order() {
        with_isolated_data_dir(|| {
            let instances = vec![instance("s1", "proj-a", InstanceKind::Interactive, false, false)];
            let projects = vec![];
            let exec = FakeExecutor {
                procs: vec![SupervisorProc { id: "frontend:dev".into(), root: Some("C:/proj/frontend".into()), status: "running".into() }],
                containers: vec!["abc123".into()],
                docker_desktop_running: true,
                ..Default::default()
            };

            let summary = turn_on(&instances, &projects, &exec);

            assert!(summary.on);
            assert_eq!(summary.paused_sessions, 1);
            assert_eq!(summary.stopped_procs, 1);
            assert_eq!(summary.stopped_containers, 1);
            assert!(summary.docker_desktop_stopped);

            // The file on disk must already reflect the full plan - read
            // independently of the in-memory summary to prove the write
            // actually landed, not just that turn_on returned a summary.
            let persisted = load_file();
            assert!(persisted.on);
            assert_eq!(persisted.paused_sessions, vec![PausedSession { session_id: "s1".into(), cwd: "C:/proj/proj-a".into() }]);
            assert_eq!(persisted.stopped_procs, vec![StoppedProc { id: "frontend:dev".into() }]);
            assert_eq!(persisted.stopped_containers, vec!["abc123".to_string()]);
            assert!(persisted.docker_desktop_was_running);

            assert_eq!(
                exec.calls(),
                vec![
                    "supervisor_procs".to_string(),
                    "docker_running_containers".to_string(),
                    "docker_desktop_running".to_string(),
                    "queue_message(s1,park)".to_string(),
                    "supervisor_stop(frontend:dev)".to_string(),
                    "docker_stop(abc123)".to_string(),
                    "docker_desktop_stop".to_string(),
                ],
            );
        });
    }

    #[test]
    fn turn_on_is_a_noop_when_already_on() {
        with_isolated_data_dir(|| {
            let exec = FakeExecutor::default();
            let first = turn_on(&[], &[], &exec);
            assert!(first.on);
            let calls_after_first = exec.calls().len();

            let second = turn_on(&[], &[], &exec);
            assert_eq!(second, first, "a second turn_on while already on must return the same summary");
            assert_eq!(exec.calls().len(), calls_after_first, "must not re-run any side effect");
        });
    }

    #[test]
    fn turn_off_restarts_exactly_what_turn_on_stopped_and_resumes_exactly_the_paused_sessions() {
        with_isolated_data_dir(|| {
            let instances = vec![
                instance("s1", "proj-a", InstanceKind::Interactive, false, false),
                instance("s2", "proj-b", InstanceKind::Interactive, false, false),
            ];
            let exec = FakeExecutor {
                procs: vec![SupervisorProc { id: "frontend:dev".into(), root: Some("C:/proj/frontend".into()), status: "running".into() }],
                containers: vec!["abc123".into(), "def456".into()],
                docker_desktop_running: true,
                ..Default::default()
            };
            turn_on(&instances, &[], &exec);

            let off = turn_off(&exec);
            assert!(!off.on);
            assert_eq!(off.paused_sessions, 2);
            assert_eq!(off.stopped_procs, 1);
            assert_eq!(off.stopped_containers, 2);

            let calls = exec.calls();
            let off_calls = &calls[calls.len() - 5..];
            assert_eq!(
                off_calls,
                &[
                    "docker_desktop_start".to_string(),
                    "docker_start(abc123,def456)".to_string(),
                    "supervisor_start(frontend:dev)".to_string(),
                    "queue_message(s1,resume)".to_string(),
                    "queue_message(s2,resume)".to_string(),
                ],
            );

            assert!(!load_file().on, "state must be cleared after turn_off");
        });
    }

    #[test]
    fn turn_off_on_a_freshly_loaded_state_object_still_resumes_everything() {
        // Simulates a daemon restart between ON and OFF: turn_off here never
        // sees the in-memory GamingModeFile turn_on built, only what
        // load_file() reads back off disk.
        with_isolated_data_dir(|| {
            let instances = vec![instance("s1", "proj-a", InstanceKind::Interactive, false, false)];
            let on_exec = FakeExecutor::default();
            turn_on(&instances, &[], &on_exec);

            // Fresh executor too - nothing carries over from the ON call
            // except what landed on disk.
            let off_exec = FakeExecutor::default();
            let off = turn_off(&off_exec);
            assert_eq!(off.paused_sessions, 1);
            assert!(off_exec.calls().contains(&"queue_message(s1,resume)".to_string()));
            assert!(!load_file().on);
        });
    }

    #[test]
    fn turn_off_is_a_noop_when_already_off() {
        with_isolated_data_dir(|| {
            let exec = FakeExecutor::default();
            let result = turn_off(&exec);
            assert!(!result.on);
            assert!(exec.calls().is_empty(), "must not call anything when there is nothing to undo");
        });
    }
}
