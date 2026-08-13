//! In-memory instance registry.
//!
//! Keyed by `session_id`. The canonical source for "what Claude Code
//! processes are currently alive across the machine". Populated by
//! `hook_server.rs` (SessionStart hook), `detector.rs` (ps reconcile),
//! and `channels.rs` (future, Plan C). Any mutation emits an
//! `instances-changed` Tauri event so the webview refreshes.

use crate::sessions::kinds::InstanceKind;
use crate::settings;
use crate::types::{EndReason, Instance, Settings};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

#[derive(Clone, Debug)]
pub struct RegisterInput {
    pub session_id: String,
    pub cwd: PathBuf,
    pub pid: u32,
    pub kind: InstanceKind,
    pub is_remote: bool,
    pub transcript_path: Option<PathBuf>,
    pub started_at: String,
}

pub struct Registry {
    // pub(super): also read/written from sibling `registry_flags`/`registry_account`/
    // `registry_turn` impls.
    pub(super) inner: Mutex<HashMap<String, Instance>>,
    /// `account_id` -> (reset unix secs, window kind). Kept alongside the
    /// instances rather than only on them, so a session spawned *after* the
    /// rejection is born blocked instead of looking healthy until it tries a
    /// turn and gets rejected itself. Entries are never swept on a timer:
    /// a past `resets_at` reads as "not blocked" everywhere.
    pub(super) rate_limits: Mutex<HashMap<String, (i64, String)>>,
    /// `session_id` -> live background-task count from the session's most
    /// recent Stop hook (`background_tasks` in the payload - ground truth from
    /// the CLI, unlike the self-reported `<cc-status:..>` marker). A side map,
    /// not a field on `Instance`: internal to the daemon, never serialized to
    /// the frontend. Consumed by the pump's result-line handler to override a
    /// marker that claims "done" while the CLI says tasks are still running.
    pub(super) background_tasks: Mutex<HashMap<String, usize>>,
    /// `session_id`s whose `/close` run has explicitly confirmed teardown via
    /// the `cc_conductor` `close_session` MCP tool (POSTed to
    /// `/sessions/close-confirm`). Set mid-turn by the tool call; consumed by
    /// the pump at turn end to mark_ended + kill the process. A side map, not
    /// an `Instance` field: it's a transient one-shot signal, never serialized.
    /// Deterministic replacement for parsing a `<cc-close:done>` text marker.
    pub(super) close_requested: Mutex<std::collections::HashSet<String>>,
    /// This turn's self-reported status (`report_turn_status` MCP tool,
    /// todo 435), keyed by session_id. Side map, not an `Instance` field:
    /// transient, never serialized to the frontend.
    pub(super) reported_status: Mutex<HashMap<String, super::registry_turn::ReportedStatus>>,
    /// `session_id` -> `turn_gen` of the last turn `send_message` succeeded in.
    /// Gen-stamped like `reported_status` so Stop enforces both the same way.
    pub(super) message_sent_gen: Mutex<HashMap<String, u64>>,
    /// `session_id` -> `turn_gen` a daemon wake (repo-channel peer, Jarvis, or
    /// scheduled fire) opened, as opposed to a real user message. Consulted by
    /// the Stop hook (todo 607) so a wake-opened turn's `done` report doesn't
    /// force a chat message the dev never asked for.
    pub(super) turn_opened_by_wake: Mutex<HashMap<String, u64>>,
}

impl Registry {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
            rate_limits: Mutex::new(HashMap::new()),
            background_tasks: Mutex::new(HashMap::new()),
            close_requested: Mutex::new(std::collections::HashSet::new()),
            reported_status: Mutex::new(HashMap::new()),
            message_sent_gen: Mutex::new(HashMap::new()),
            turn_opened_by_wake: Mutex::new(HashMap::new()),
        }
    }

    /// Inserts or updates an instance. Returns `(project_id, created_new)`.
    /// `project_id` is resolved via `settings::upsert_project_for_cwd`.
    /// If the session is already registered, the existing project id is
    /// kept and `created_new` is `false`.
    pub fn register(
        &self,
        input: RegisterInput,
        settings: &Mutex<Settings>,
        now: &str,
    ) -> (String, bool) {
        let mut guard = self.inner.lock().unwrap();
        if let Some(existing) = guard.get(&input.session_id) {
            return (existing.project_id.clone(), false);
        }
        let (project_id, _) = {
            let mut s = settings.lock().unwrap();
            settings::upsert_project_for_cwd(&mut s, &input.cwd, now)
        };
        let instance = Instance {
            session_id: input.session_id.clone(),
            pid: input.pid,
            cwd: input.cwd,
            project_id: project_id.clone(),
            kind: input.kind,
            is_remote: input.is_remote,
            started_at: input.started_at,
            transcript_path: input.transcript_path,
            bridge_session_id: None,
            name: None,
            ended_at: None,
            end_reason: None,
            busy: false,
            model: String::new(),
            effort: String::new(),
            awaiting: None,
            last_notified_awaiting: None,
            autopilot: false,
            jarvis: false,
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
        };
        guard.insert(input.session_id, instance);
        (project_id, true)
    }

    /// Path C helper: insert (or upgrade) an Interactive session entry.
    ///
    /// - If `session_id` is unknown, inserts a fresh Instance with kind=Interactive,
    ///   pid=0 (Path C has no persistent process between turns), and resolves
    ///   project_id via `settings::upsert_project_for_cwd`.
    /// - If `session_id` already exists (e.g. takeover from Manual), mutates the
    ///   existing entry: kind -> Interactive, busy -> false, ended_at/end_reason cleared,
    ///   project_id and pid preserved.
    ///
    /// Returns the resolved project_id.
    pub fn record_interactive_session(
        &self,
        session_id: &str,
        cwd: &std::path::Path,
        settings: &Mutex<Settings>,
        now: &str,
    ) -> String {
        let mut guard = self.inner.lock().unwrap();
        if let Some(existing) = guard.get_mut(session_id) {
            existing.kind = InstanceKind::Interactive;
            existing.busy = false;
            existing.ended_at = None;
            existing.end_reason = None;
            return existing.project_id.clone();
        }
        let (project_id, _) = {
            let mut s = settings.lock().unwrap();
            settings::upsert_project_for_cwd(&mut s, cwd, now)
        };
        let instance = Instance {
            session_id: session_id.to_string(),
            pid: 0,
            cwd: cwd.to_path_buf(),
            project_id: project_id.clone(),
            kind: InstanceKind::Interactive,
            is_remote: false,
            started_at: now.to_string(),
            transcript_path: None,
            bridge_session_id: None,
            name: None,
            ended_at: None,
            end_reason: None,
            busy: false,
            model: String::new(),
            effort: String::new(),
            awaiting: None,
            last_notified_awaiting: None,
            autopilot: false,
            jarvis: false,
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
        };
        guard.insert(session_id.to_string(), instance);
        project_id
    }

    /// Like `record_interactive_session` but takes a pre-resolved `project_id`
    /// instead of locking settings to upsert one. Used from the chat IPC layer
    /// where settings has already been read on the calling thread (the
    /// `&Mutex<Settings>` reference can't survive a `spawn_blocking` move).
    pub fn upsert_interactive(
        &self,
        session_id: &str,
        cwd: &std::path::Path,
        project_id: &str,
        now: &str,
    ) {
        let mut guard = self.inner.lock().unwrap();
        if let Some(existing) = guard.get_mut(session_id) {
            existing.kind = InstanceKind::Interactive;
            existing.busy = false;
            existing.ended_at = None;
            existing.end_reason = None;
            return;
        }
        let instance = Instance {
            session_id: session_id.to_string(),
            pid: 0,
            cwd: cwd.to_path_buf(),
            project_id: project_id.to_string(),
            kind: InstanceKind::Interactive,
            is_remote: false,
            started_at: now.to_string(),
            transcript_path: None,
            bridge_session_id: None,
            name: None,
            ended_at: None,
            end_reason: None,
            busy: false,
            model: String::new(),
            effort: String::new(),
            awaiting: None,
            last_notified_awaiting: None,
            autopilot: false,
            jarvis: false,
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
        };
        guard.insert(session_id.to_string(), instance);
    }

    /// Late-set `is_remote` after `upsert_interactive`, when `start_session`
    /// arrived over the phone/remote surface. The hook's channel pid-match
    /// tagging never reaches daemon-spawned sessions since `register()`
    /// no-ops once the entry already exists (inserted here first).
    pub fn set_is_remote(&self, session_id: &str, is_remote: bool) {
        let mut guard = self.inner.lock().unwrap();
        if let Some(i) = guard.get_mut(session_id) {
            i.is_remote = is_remote;
        }
    }

    /// Convert an Interactive session to External so the terminal owns it after
    /// "Open in Terminal". Sets pid=0 (terminal will update it via `set_pid`
    /// when its SessionStart hook fires). Returns true if the entry was found
    /// and actually changed.
    pub fn externalize_session(&self, session_id: &str) -> bool {
        let mut guard = self.inner.lock().unwrap();
        let Some(inst) = guard.get_mut(session_id) else { return false };
        if inst.kind == InstanceKind::External { return false; }
        inst.kind = InstanceKind::External;
        inst.pid = 0;
        inst.busy = false;
        true
    }

    /// Marks an instance as ended. Idempotent: returns `true` only the
    /// first time (when `end_reason` flips from None to Some).
    pub fn mark_ended(&self, session_id: &str, reason: EndReason, when: &str) -> bool {
        let mut guard = self.inner.lock().unwrap();
        let Some(inst) = guard.get_mut(session_id) else { return false };
        if inst.end_reason.is_some() { return false; }
        inst.end_reason = Some(reason);
        inst.ended_at = Some(when.to_string());
        true
    }

    pub fn set_bridge_session_id(&self, session_id: &str, bridge_id: String) {
        let mut guard = self.inner.lock().unwrap();
        if let Some(i) = guard.get_mut(session_id) {
            i.bridge_session_id = Some(bridge_id);
        }
    }

    /// Late-binding pid update. Used when the SessionStart hook
    /// payload omitted pid (Claude Code v2.x doesn't include it) and
    /// we resolved it later by scanning `~/.claude/sessions/*.json`
    /// for the matching `sessionId`. Returns true if pid actually
    /// changed (so callers can decide whether to emit an update).
    pub fn set_pid(&self, session_id: &str, pid: u32) -> bool {
        let mut guard = self.inner.lock().unwrap();
        let Some(i) = guard.get_mut(session_id) else { return false };
        if i.pid == pid { return false; }
        i.pid = pid;
        true
    }

    /// Upgrade a session's kind. Only flips `External` -> the given kind so we
    /// never clobber an `Interactive`/`Automated` entry. Returns true if changed.
    pub fn set_kind(&self, session_id: &str, kind: InstanceKind, is_remote: bool) -> bool {
        let mut guard = self.inner.lock().unwrap();
        let Some(i) = guard.get_mut(session_id) else { return false };
        if i.kind != InstanceKind::External { return false; }
        if i.kind == kind && i.is_remote == is_remote { return false; }
        i.kind = kind;
        i.is_remote = is_remote;
        true
    }

    /// Upgrade every `External` instance whose pid matches `pid` to
    /// `Automated` + remote. Used by the channel lifecycle: once the daemon
    /// resolves a channel's real `claude` pid, it re-tags any session the hook
    /// already registered as External (closing the spawn-vs-hook race where the
    /// SessionStart arrives before the channel's pid is known). Returns true if
    /// any instance changed.
    pub fn retag_pid_as_automated(&self, pid: u32) -> bool {
        let mut guard = self.inner.lock().unwrap();
        let mut changed = false;
        for i in guard.values_mut() {
            if i.pid == pid && i.kind == InstanceKind::External {
                i.kind = InstanceKind::Automated;
                i.is_remote = true;
                changed = true;
            }
        }
        changed
    }

    /// Late-binding name update. Resolved from the transcript's first
    /// user prompt. Returns true if the name actually changed.
    pub fn set_name(&self, session_id: &str, name: String) -> bool {
        let mut guard = self.inner.lock().unwrap();
        let Some(i) = guard.get_mut(session_id) else { return false };
        if i.name.as_deref() == Some(name.as_str()) { return false; }
        i.name = Some(name);
        true
    }

    /// Remove ended instances whose `ended_at` is strictly before `cutoff`.
    /// Cutoff is an RFC3339 string; lexicographic comparison works on
    /// `Z`-suffix timestamps. Returns the number of instances removed, so
    /// callers can decide whether a change notification is warranted.
    pub fn prune_ended_before(&self, cutoff: &str) -> usize {
        let mut guard = self.inner.lock().unwrap();
        let before = guard.len();
        guard.retain(|_, i| match i.ended_at.as_deref() {
            None => true,
            Some(t) => t >= cutoff,
        });
        before - guard.len()
    }

    pub fn list(&self) -> Vec<Instance> {
        self.inner.lock().unwrap().values().cloned().collect()
    }

    pub fn by_cwd(&self, cwd: &std::path::Path) -> Vec<Instance> {
        self.inner
            .lock()
            .unwrap()
            .values()
            .filter(|i| i.cwd == cwd)
            .cloned()
            .collect()
    }

    pub fn by_project(&self, project_id: &str) -> Vec<Instance> {
        self.inner
            .lock()
            .unwrap()
            .values()
            .filter(|i| i.project_id == project_id)
            .cloned()
            .collect()
    }

    pub fn get(&self, session_id: &str) -> Option<Instance> {
        self.inner.lock().unwrap().get(session_id).cloned()
    }

    pub fn known_session_ids(&self) -> Vec<String> {
        self.inner.lock().unwrap().keys().cloned().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn fresh_settings() -> Mutex<Settings> {
        Mutex::new(Settings::default())
    }

    #[test]
    fn record_interactive_session_inserts_with_pid_zero_and_idle() {
        let registry = Registry::new();
        let settings = fresh_settings();
        let project_id = registry.record_interactive_session(
            "sess-abc",
            Path::new("/tmp/x"),
            &settings,
            "2026-05-08T04:30:00Z",
        );
        assert!(!project_id.is_empty());
        let entry = registry.get("sess-abc").expect("recorded");
        assert!(matches!(entry.kind, InstanceKind::Interactive));
        assert_eq!(entry.busy, false);
        assert_eq!(entry.pid, 0);
        assert_eq!(entry.project_id, project_id);
    }

    #[test]
    fn retag_pid_as_automated_upgrades_only_external() {
        let registry = Registry::new();
        let settings = fresh_settings();
        registry.register(
            RegisterInput {
                session_id: "chan-1".into(),
                cwd: PathBuf::from("/tmp/z"),
                pid: 4242,
                kind: InstanceKind::External,
                is_remote: false,
                transcript_path: None,
                started_at: "2026-05-20T00:00:00Z".into(),
            },
            &settings,
            "2026-05-20T00:00:00Z",
        );
        // Matching pid upgrades External -> Automated + remote.
        assert!(registry.retag_pid_as_automated(4242));
        let e = registry.get("chan-1").unwrap();
        assert_eq!(e.kind, InstanceKind::Automated);
        assert!(e.is_remote);
        // Idempotent: already Automated, not re-upgraded.
        assert!(!registry.retag_pid_as_automated(4242));
        // Non-matching pid: no change.
        assert!(!registry.retag_pid_as_automated(9999));
    }

    #[test]
    fn record_interactive_session_upgrades_existing_external_to_interactive() {
        let registry = Registry::new();
        let settings = fresh_settings();
        // Pre-register as External via `register`.
        let (orig_pid_proj, _) = registry.register(
            RegisterInput {
                session_id: "manual-1".into(),
                cwd: PathBuf::from("/tmp/y"),
                pid: 1234,
                kind: InstanceKind::External,
                is_remote: false,
                transcript_path: None,
                started_at: "2026-05-08T04:00:00Z".into(),
            },
            &settings,
            "2026-05-08T04:00:00Z",
        );
        assert_eq!(registry.get("manual-1").unwrap().kind, InstanceKind::External);

        // Takeover: convert to Interactive.
        let new_pid_proj = registry.record_interactive_session(
            "manual-1",
            Path::new("/tmp/y"),
            &settings,
            "2026-05-08T04:30:00Z",
        );
        let entry = registry.get("manual-1").unwrap();
        assert_eq!(entry.kind, InstanceKind::Interactive);
        assert_eq!(entry.pid, 1234, "pid preserved on takeover");
        assert_eq!(entry.busy, false);
        assert_eq!(entry.project_id, orig_pid_proj, "project_id preserved");
        assert_eq!(new_pid_proj, orig_pid_proj);
    }

    #[test]
    fn record_interactive_session_clears_ended_state_on_takeover() {
        let registry = Registry::new();
        let settings = fresh_settings();
        registry.register(
            RegisterInput {
                session_id: "ended-1".into(),
                cwd: PathBuf::from("/tmp/z"),
                pid: 99,
                kind: InstanceKind::External,
                is_remote: false,
                transcript_path: None,
                started_at: "2026-05-08T03:00:00Z".into(),
            },
            &settings,
            "2026-05-08T03:00:00Z",
        );
        registry.mark_ended("ended-1", EndReason::Manual, "2026-05-08T03:30:00Z");
        assert!(registry.get("ended-1").unwrap().ended_at.is_some());

        registry.record_interactive_session(
            "ended-1",
            Path::new("/tmp/z"),
            &settings,
            "2026-05-08T04:30:00Z",
        );
        let entry = registry.get("ended-1").unwrap();
        assert_eq!(entry.kind, InstanceKind::Interactive);
        assert!(entry.ended_at.is_none());
        assert!(entry.end_reason.is_none());
    }

    #[test]
    fn set_kind_upgrades_external_only() {
        let registry = Registry::new();
        let settings = fresh_settings();
        // Register as External.
        registry.register(
            RegisterInput {
                session_id: "ext-1".into(),
                cwd: PathBuf::from("/tmp/ext"),
                pid: 42,
                kind: InstanceKind::External,
                is_remote: false,
                transcript_path: None,
                started_at: "2026-05-20T10:00:00Z".into(),
            },
            &settings,
            "2026-05-20T10:00:00Z",
        );
        assert_eq!(registry.get("ext-1").unwrap().kind, InstanceKind::External);

        // First call: External -> Automated, returns true.
        assert!(registry.set_kind("ext-1", InstanceKind::Automated, true));
        let entry = registry.get("ext-1").unwrap();
        assert_eq!(entry.kind, InstanceKind::Automated);
        assert_eq!(entry.is_remote, true);

        // Second call: already Automated (not External), returns false.
        assert!(!registry.set_kind("ext-1", InstanceKind::Automated, true));
        // Kind must not have been downgraded.
        assert_eq!(registry.get("ext-1").unwrap().kind, InstanceKind::Automated);
    }
}
