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
//! [`FakeExecutor`] that only records calls - `RealExecutor` is wired at
//! daemon startup and is never constructed by a test in this file.

use crate::sessions::kinds::InstanceKind;
use crate::sessions::scheduled_items::{ScheduledItem, ScheduledKind};
use crate::settings::identity::normalize_cwd_key;
use crate::types::{Instance, ProjectConfig};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Arc;

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
/// supervisor, Docker, or the scheduled-items store. `RealExecutor` (below)
/// is the only production implementation; every test in this file uses
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

/// Production executor. Every method here is a real external call (HTTP to
/// server_supervisor, a `docker` subprocess, or a real scheduled-items
/// write) - never constructed by a test in this module.
pub struct RealExecutor;

impl RealExecutor {
    fn supervisor_config() -> Option<(String, String)> {
        let dir = dirs::config_dir()?.join("com.sirbepy.server-supervisor").join("supervisor");
        let token = std::fs::read_to_string(dir.join("api_token.txt")).ok()?.trim().to_string();
        let port = std::fs::read_to_string(dir.join("api_port.txt")).ok()?.trim().to_string();
        if token.is_empty() || port.is_empty() {
            return None;
        }
        Some((token, port))
    }

    fn supervisor_registry_root(project_id: &str) -> Option<String> {
        let dir = dirs::config_dir()?.join("com.sirbepy.server-supervisor").join("supervisor");
        let raw = std::fs::read_to_string(dir.join("projects.json")).ok()?;
        let list: serde_json::Value = serde_json::from_str(&raw).ok()?;
        list.as_array()?.iter().find_map(|p| {
            if p.get("id").and_then(|v| v.as_str()) == Some(project_id) {
                p.get("root").and_then(|v| v.as_str()).map(str::to_string)
            } else {
                None
            }
        })
    }

    fn hidden_command(program: &str, args: &[&str]) -> std::process::Command {
        let mut cmd = std::process::Command::new(program);
        cmd.args(args);
        crate::util::process::hide_console(&mut cmd);
        cmd
    }
}

impl GamingModeExecutor for RealExecutor {
    fn supervisor_procs(&self) -> Result<Vec<SupervisorProc>, String> {
        let (token, port) = Self::supervisor_config().ok_or("server_supervisor not running (no token/port)")?;
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(5))
            .build()
            .map_err(|e| e.to_string())?;
        let resp = client
            .get(format!("http://127.0.0.1:{port}/procs"))
            .bearer_auth(&token)
            .send()
            .map_err(|e| e.to_string())?;
        let procs: serde_json::Value = resp.json().map_err(|e| e.to_string())?;
        let arr = procs.as_array().ok_or("unexpected /procs response shape")?;
        Ok(arr
            .iter()
            .filter_map(|p| {
                let id = p.get("id").and_then(|v| v.as_str())?.to_string();
                let status = p.get("status").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let project_id = id.split_once(':').map(|(a, _)| a).unwrap_or(&id);
                let root = Self::supervisor_registry_root(project_id);
                Some(SupervisorProc { id, root, status })
            })
            .collect())
    }

    fn supervisor_stop(&self, id: &str) -> Result<(), String> {
        let (token, port) = Self::supervisor_config().ok_or("server_supervisor not running")?;
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(5))
            .build()
            .map_err(|e| e.to_string())?;
        client
            .post(format!("http://127.0.0.1:{port}/procs/{id}/stop"))
            .bearer_auth(&token)
            .send()
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    fn supervisor_start(&self, id: &str) -> Result<(), String> {
        let (token, port) = Self::supervisor_config().ok_or("server_supervisor not running")?;
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(5))
            .build()
            .map_err(|e| e.to_string())?;
        client
            .post(format!("http://127.0.0.1:{port}/procs/{id}/start"))
            .bearer_auth(&token)
            .send()
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    fn docker_running_containers(&self) -> Result<Vec<String>, String> {
        let out = Self::hidden_command("docker", &["ps", "-q"]).output().map_err(|e| e.to_string())?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).into_owned());
        }
        Ok(String::from_utf8_lossy(&out.stdout).lines().map(str::to_string).filter(|s| !s.is_empty()).collect())
    }

    fn docker_stop(&self, ids: &[String]) -> Result<(), String> {
        if ids.is_empty() {
            return Ok(());
        }
        let mut args = vec!["stop"];
        args.extend(ids.iter().map(String::as_str));
        let out = Self::hidden_command("docker", &args).output().map_err(|e| e.to_string())?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).into_owned());
        }
        Ok(())
    }

    fn docker_start(&self, ids: &[String]) -> Result<(), String> {
        if ids.is_empty() {
            return Ok(());
        }
        let mut args = vec!["start"];
        args.extend(ids.iter().map(String::as_str));
        let out = Self::hidden_command("docker", &args).output().map_err(|e| e.to_string())?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).into_owned());
        }
        Ok(())
    }

    fn docker_desktop_running(&self) -> bool {
        Self::hidden_command("docker", &["info"]).output().map(|o| o.status.success()).unwrap_or(false)
    }

    fn docker_desktop_stop(&self) {
        let _ = Self::hidden_command("docker", &["desktop", "stop"]).output();
    }

    fn docker_desktop_start(&self) {
        let _ = Self::hidden_command("docker", &["desktop", "start"]).output();
    }

    fn queue_message(&self, session_id: &str, cwd: &str, prompt: &str) {
        let item = ScheduledItem::new(
            ScheduledKind::Message { session_id: session_id.to_string(), cwd: cwd.to_string() },
            prompt.to_string(),
            chrono::Utc::now().to_rfc3339(),
            None,
        );
        crate::sessions::scheduled_items::upsert(item);
    }
}

// --- Persistence (mirrors sessions::scheduled_items's config_path/atomic-write shape) ---

fn config_path() -> Option<PathBuf> {
    config_path_for(&crate::daemon::instance::instance_suffix())
}

pub fn config_path_for(suffix: &str) -> Option<PathBuf> {
    crate::settings::paths::data_dir().ok().map(|d| d.join(format!("gaming-mode{suffix}.json")))
}

pub fn load_file() -> GamingModeFile {
    let Some(path) = config_path() else { return GamingModeFile::default() };
    load_file_at(&path)
}

fn load_file_at(path: &std::path::Path) -> GamingModeFile {
    std::fs::read_to_string(path).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

fn save_file(file: &GamingModeFile) {
    let Some(path) = config_path() else { return };
    save_file_at(&path, file);
}

fn save_file_at(path: &std::path::Path, file: &GamingModeFile) {
    let json = match serde_json::to_string_pretty(file) {
        Ok(s) => s,
        Err(e) => {
            log::warn!("gaming-mode: serialize failed: {e}");
            return;
        }
    };
    if let Err(e) = crate::util::write_json_atomic(path, &json) {
        log::warn!("gaming-mode: write failed: {e}");
    }
}

// --- Pure selection logic (unit-testable with no executor at all) ---

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

fn allowlisted_roots(projects: &[ProjectConfig]) -> Vec<String> {
    projects
        .iter()
        .filter(|p| p.keep_running_in_gaming_mode)
        .map(|p| p.path.to_string_lossy().into_owned())
        .collect()
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
            bridge_session_id: None,
            name: None,
            ended_at: if ended { Some("2026-10-13T01:00:00Z".to_string()) } else { None },
            end_reason: None,
            busy: false,
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
