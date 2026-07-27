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
    inner: Mutex<HashMap<String, Instance>>,
    /// `account_id` -> (reset unix secs, window kind). Kept alongside the
    /// instances rather than only on them, so a session spawned *after* the
    /// rejection is born blocked instead of looking healthy until it tries a
    /// turn and gets rejected itself. Entries are never swept on a timer:
    /// a past `resets_at` reads as "not blocked" everywhere.
    rate_limits: Mutex<HashMap<String, (i64, String)>>,
    /// `session_id` -> live background-task count from the session's most
    /// recent Stop hook (`background_tasks` in the payload - ground truth from
    /// the CLI, unlike the self-reported `<cc-status:..>` marker). A side map,
    /// not a field on `Instance`: internal to the daemon, never serialized to
    /// the frontend. Consumed by the pump's result-line handler to override a
    /// marker that claims "done" while the CLI says tasks are still running.
    background_tasks: Mutex<HashMap<String, usize>>,
    /// `session_id`s whose `/close` run has explicitly confirmed teardown via
    /// the `cc_conductor` `close_session` MCP tool (POSTed to
    /// `/sessions/close-confirm`). Set mid-turn by the tool call; consumed by
    /// the pump at turn end to mark_ended + kill the process. A side map, not
    /// an `Instance` field: it's a transient one-shot signal, never serialized.
    /// Deterministic replacement for parsing a `<cc-close:done>` text marker.
    close_requested: Mutex<std::collections::HashSet<String>>,
}

impl Registry {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
            rate_limits: Mutex::new(HashMap::new()),
            background_tasks: Mutex::new(HashMap::new()),
            close_requested: Mutex::new(std::collections::HashSet::new()),
        }
    }

    /// Record that the `/close` skill confirmed teardown for this session (the
    /// `close_session` MCP tool fired). The pump consumes it at turn end.
    pub fn set_close_requested(&self, session_id: &str) {
        self.close_requested.lock().unwrap().insert(session_id.to_string());
    }

    /// Consume the close-confirmed flag: returns true once, then clears it, so
    /// a stale flag can never re-tear-down a resumed session on a later turn.
    pub fn take_close_requested(&self, session_id: &str) -> bool {
        self.close_requested.lock().unwrap().remove(session_id)
    }

    /// Record the live background-task count the Stop hook reported for this
    /// session's just-ended turn. Zero removes the entry.
    pub fn set_background_tasks(&self, session_id: &str, count: usize) {
        let mut guard = self.background_tasks.lock().unwrap();
        if count == 0 {
            guard.remove(session_id);
        } else {
            guard.insert(session_id.to_string(), count);
        }
    }

    /// Background-task count from the session's most recent Stop hook.
    /// Zero when the session never reported (or reported none).
    pub fn background_tasks(&self, session_id: &str) -> usize {
        self.background_tasks.lock().unwrap().get(session_id).copied().unwrap_or(0)
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
            autopilot: false,
            jarvis: false,
            worker_of: None,
            closing: false,
            turn_gen: 0,
            account_id: None,
            rate_limited_resets_at: None,
            rate_limited_type: None,
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
            autopilot: false,
            jarvis: false,
            worker_of: None,
            closing: false,
            turn_gen: 0,
            account_id: None,
            rate_limited_resets_at: None,
            rate_limited_type: None,
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
            autopilot: false,
            jarvis: false,
            worker_of: None,
            closing: false,
            turn_gen: 0,
            account_id: None,
            rate_limited_resets_at: None,
            rate_limited_type: None,
        };
        guard.insert(session_id.to_string(), instance);
    }

    /// Set the self-reported turn status. `None` clears it (e.g. when a new
    /// turn starts). No-op if session is unknown.
    pub fn set_awaiting(&self, session_id: &str, awaiting: Option<String>) {
        let mut guard = self.inner.lock().unwrap();
        if let Some(i) = guard.get_mut(session_id) {
            i.awaiting = awaiting;
        }
    }

    /// Set `awaiting` only if `turn_gen` still matches `gen`. Mirrors
    /// `set_busy_false_if_gen`: a cancelled/interrupted turn's late result line
    /// must not stamp its stale status ("question"/"waiting") onto a newer turn
    /// that already cleared `awaiting` and set `busy=true`. Returns true if
    /// applied.
    pub fn set_awaiting_if_gen(&self, session_id: &str, awaiting: Option<String>, gen: u64) -> bool {
        let mut guard = self.inner.lock().unwrap();
        if let Some(i) = guard.get_mut(session_id) {
            if i.turn_gen == gen {
                i.awaiting = awaiting;
                return true;
            }
        }
        false
    }

    /// Clear `awaiting` only if it currently reads `"question"`. Used by the
    /// prompt-answer/expiry paths: they know the user just resolved (or the
    /// daemon just invalidated) a question prompt, but must not stomp a status
    /// some newer turn already wrote (`working`/`waiting`/`done`). Returns
    /// true if a clear actually happened.
    pub fn clear_awaiting_if_question(&self, session_id: &str) -> bool {
        let mut guard = self.inner.lock().unwrap();
        if let Some(i) = guard.get_mut(session_id) {
            if i.awaiting.as_deref() == Some("question") {
                i.awaiting = None;
                return true;
            }
        }
        false
    }

    /// Flip the daemon-authoritative "a /close run is in flight" flag. Returns
    /// true if the value actually changed (callers publish `instances_changed`
    /// only on real transitions). No-op false for unknown sessions.
    pub fn set_closing(&self, session_id: &str, closing: bool) -> bool {
        let mut guard = self.inner.lock().unwrap();
        if let Some(i) = guard.get_mut(session_id) {
            if i.closing != closing {
                i.closing = closing;
                return true;
            }
        }
        false
    }

    /// Set the autopilot-active flag. `true` = /autopilot running; `false` = finished.
    /// No-op if session is unknown.
    pub fn set_autopilot(&self, session_id: &str, active: bool) {
        let mut guard = self.inner.lock().unwrap();
        if let Some(i) = guard.get_mut(session_id) {
            i.autopilot = active;
        }
    }

    /// Set the Jarvis-singleton flag (todo 272). No-op if session is unknown.
    pub fn set_jarvis(&self, session_id: &str, jarvis: bool) {
        let mut guard = self.inner.lock().unwrap();
        if let Some(i) = guard.get_mut(session_id) {
            i.jarvis = jarvis;
        }
    }

    /// Set which Jarvis session (if any) spawned this session as a worker.
    /// `None` clears it. No-op if session is unknown.
    pub fn set_worker_of(&self, session_id: &str, worker_of: Option<String>) {
        let mut guard = self.inner.lock().unwrap();
        if let Some(i) = guard.get_mut(session_id) {
            i.worker_of = worker_of;
        }
    }

    /// Path C helper: flip the `busy` flag on a session entry. Sidebar uses
    /// this to render running vs idle. No-op if session is unknown.
    /// When `busy=true`, also bumps `turn_gen` so the pump can detect stale
    /// set_busy(false) calls from a prior turn draining after a new message arrived.
    pub fn set_busy(&self, session_id: &str, busy: bool) {
        let mut guard = self.inner.lock().unwrap();
        if let Some(i) = guard.get_mut(session_id) {
            i.busy = busy;
            if busy {
                i.turn_gen = i.turn_gen.wrapping_add(1);
            }
        }
    }

    /// Read the current `turn_gen` for a session. Used by the pump to snapshot
    /// the generation at turn-start so it can guard the turn-end `set_busy(false)`
    /// call. Returns 0 for unknown sessions.
    pub fn current_turn_gen(&self, session_id: &str) -> u64 {
        self.inner
            .lock()
            .unwrap()
            .get(session_id)
            .map(|i| i.turn_gen)
            .unwrap_or(0)
    }

    /// Set `busy=false` only if `turn_gen` still matches `gen`. A mismatch means
    /// a newer turn has started since the pump captured the generation; the stale
    /// result line should not clear the new turn's `busy=true`.
    /// Returns true if busy was actually cleared.
    pub fn set_busy_false_if_gen(&self, session_id: &str, gen: u64) -> bool {
        let mut guard = self.inner.lock().unwrap();
        if let Some(i) = guard.get_mut(session_id) {
            if i.turn_gen == gen {
                i.busy = false;
                return true;
            }
        }
        false
    }

    /// Set both model and effort on a session entry. Returns true if the
    /// entry was found.
    pub fn set_model_effort(&self, session_id: &str, model: &str, effort: &str) -> bool {
        let mut guard = self.inner.lock().unwrap();
        let Some(i) = guard.get_mut(session_id) else { return false };
        i.model = model.to_string();
        i.effort = effort.to_string();
        true
    }

    /// Set only the effort on a session entry. Returns true if the entry
    /// was found.
    pub fn set_effort(&self, session_id: &str, effort: &str) -> bool {
        let mut guard = self.inner.lock().unwrap();
        let Some(i) = guard.get_mut(session_id) else { return false };
        i.effort = effort.to_string();
        true
    }

    /// Set the registry account this session was spawned under. Returns true
    /// if the entry was found. Also stamps the account's current rate-limit
    /// window onto the instance, so a chat started while the account is
    /// exhausted shows as blocked immediately rather than after its own
    /// rejected turn.
    pub fn set_account(&self, session_id: &str, account_id: &str) -> bool {
        let limits = self.rate_limits.lock().unwrap();
        let stamp = limits.get(account_id).cloned();
        drop(limits);
        let mut guard = self.inner.lock().unwrap();
        let Some(i) = guard.get_mut(session_id) else { return false };
        i.account_id = Some(account_id.to_string());
        if let Some((resets_at, kind)) = stamp {
            i.rate_limited_resets_at = Some(resets_at);
            i.rate_limited_type = Some(kind);
        }
        true
    }

    /// Record that `account_id` is rate limited until `resets_at` (unix secs),
    /// and stamp every live instance on that account. One account's window
    /// blocks all of its sessions at once, which is why this is account-keyed
    /// rather than session-keyed. Returns the session ids that were marked,
    /// in a stable order, so the caller can schedule one resume per session.
    pub fn set_rate_limited_for_account(
        &self,
        account_id: &str,
        resets_at: i64,
        kind: &str,
    ) -> Vec<String> {
        self.rate_limits
            .lock()
            .unwrap()
            .insert(account_id.to_string(), (resets_at, kind.to_string()));
        let mut guard = self.inner.lock().unwrap();
        let mut marked: Vec<String> = guard
            .values_mut()
            .filter(|i| i.ended_at.is_none() && i.account_id.as_deref() == Some(account_id))
            .map(|i| {
                i.rate_limited_resets_at = Some(resets_at);
                i.rate_limited_type = Some(kind.to_string());
                i.session_id.clone()
            })
            .collect();
        marked.sort();
        marked
    }

    /// Hygiene only: a turn completed on this account, so whatever window we
    /// recorded is demonstrably over. Correctness never depends on this being
    /// called, because every consumer already treats a past `resets_at` as
    /// unblocked.
    pub fn clear_rate_limit_for_account(&self, account_id: &str) {
        if self.rate_limits.lock().unwrap().remove(account_id).is_none() {
            return;
        }
        let mut guard = self.inner.lock().unwrap();
        for i in guard.values_mut() {
            if i.account_id.as_deref() == Some(account_id) {
                i.rate_limited_resets_at = None;
                i.rate_limited_type = None;
            }
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
    fn set_awaiting_updates_and_clears() {
        let registry = Registry::new();
        let settings = fresh_settings();
        registry.record_interactive_session("s1", Path::new("/tmp/x"), &settings, "2026-01-01T00:00:00Z");
        assert!(registry.get("s1").unwrap().awaiting.is_none());
        registry.set_awaiting("s1", Some("question".into()));
        assert_eq!(registry.get("s1").unwrap().awaiting.as_deref(), Some("question"));
        registry.set_awaiting("s1", None);
        assert!(registry.get("s1").unwrap().awaiting.is_none());
    }

    #[test]
    fn set_busy_toggles_flag() {
        let registry = Registry::new();
        let settings = fresh_settings();
        registry.record_interactive_session(
            "sess-abc",
            Path::new("/tmp/x"),
            &settings,
            "2026-05-08T04:30:00Z",
        );
        registry.set_busy("sess-abc", true);
        assert_eq!(registry.get("sess-abc").unwrap().busy, true);
        registry.set_busy("sess-abc", false);
        assert_eq!(registry.get("sess-abc").unwrap().busy, false);
    }

    #[test]
    fn set_busy_unknown_session_is_noop() {
        let registry = Registry::new();
        registry.set_busy("missing", true);
        assert!(registry.get("missing").is_none());
    }

    #[test]
    fn set_busy_true_bumps_turn_gen() {
        let registry = Registry::new();
        let settings = fresh_settings();
        registry.record_interactive_session("s", Path::new("/tmp/x"), &settings, "2026-06-23T00:00:00Z");
        assert_eq!(registry.get("s").unwrap().turn_gen, 0);
        registry.set_busy("s", true);
        assert_eq!(registry.get("s").unwrap().turn_gen, 1);
        // false must NOT bump gen
        registry.set_busy("s", false);
        assert_eq!(registry.get("s").unwrap().turn_gen, 1);
        registry.set_busy("s", true);
        assert_eq!(registry.get("s").unwrap().turn_gen, 2);
    }

    #[test]
    fn set_busy_false_if_gen_clears_on_match() {
        let registry = Registry::new();
        let settings = fresh_settings();
        registry.record_interactive_session("s", Path::new("/tmp/x"), &settings, "2026-06-23T00:00:00Z");
        registry.set_busy("s", true); // gen -> 1
        let gen = registry.current_turn_gen("s");
        assert_eq!(gen, 1);
        let cleared = registry.set_busy_false_if_gen("s", gen);
        assert!(cleared);
        assert_eq!(registry.get("s").unwrap().busy, false);
    }

    #[test]
    fn set_busy_false_if_gen_noop_on_stale_gen() {
        let registry = Registry::new();
        let settings = fresh_settings();
        registry.record_interactive_session("s", Path::new("/tmp/x"), &settings, "2026-06-23T00:00:00Z");
        registry.set_busy("s", true); // gen -> 1 (pump captures this)
        let pump_gen = registry.current_turn_gen("s");
        // New message arrives before pump's TurnUsage: gen -> 2
        registry.set_busy("s", true);
        // Pump tries to clear with stale gen=1 — must be a no-op
        let cleared = registry.set_busy_false_if_gen("s", pump_gen);
        assert!(!cleared);
        assert_eq!(registry.get("s").unwrap().busy, true, "new turn's busy must survive");
        assert_eq!(registry.get("s").unwrap().turn_gen, 2);
    }

    #[test]
    fn set_awaiting_if_gen_applies_on_match() {
        let registry = Registry::new();
        let settings = fresh_settings();
        registry.record_interactive_session("s", Path::new("/tmp/x"), &settings, "2026-07-11T00:00:00Z");
        registry.set_busy("s", true); // gen -> 1
        let gen = registry.current_turn_gen("s");
        assert!(registry.set_awaiting_if_gen("s", Some("done".into()), gen));
        assert_eq!(registry.get("s").unwrap().awaiting.as_deref(), Some("done"));
    }

    /// The exact "Input needed while busy" race: turn 1 is cancelled, a new
    /// turn starts (awaiting cleared, busy=true, gen bumped), then turn 1's
    /// late result line tries to write awaiting="question". The stale write
    /// must be rejected so the new turn keeps rendering In Progress.
    #[test]
    fn set_awaiting_if_gen_rejects_stale_interrupted_turn() {
        let registry = Registry::new();
        let settings = fresh_settings();
        registry.record_interactive_session("s", Path::new("/tmp/x"), &settings, "2026-07-11T00:00:00Z");
        registry.set_busy("s", true); // turn 1, gen -> 1
        let stale_gen = registry.current_turn_gen("s");
        // Cancel + new send: awaiting cleared, busy re-set (gen -> 2).
        registry.set_busy("s", false);
        registry.set_awaiting("s", None);
        registry.set_busy("s", true);
        // Turn 1's late result arrives with its captured gen.
        let applied = registry.set_awaiting_if_gen("s", Some("question".into()), stale_gen);
        assert!(!applied, "stale turn must not stamp awaiting onto the new turn");
        let i = registry.get("s").unwrap();
        assert!(i.awaiting.is_none(), "new turn's cleared awaiting must survive");
        assert!(i.busy);
    }

    #[test]
    fn background_tasks_roundtrip_and_zero_clears() {
        let registry = Registry::new();
        assert_eq!(registry.background_tasks("s"), 0);
        registry.set_background_tasks("s", 3);
        assert_eq!(registry.background_tasks("s"), 3);
        registry.set_background_tasks("s", 0);
        assert_eq!(registry.background_tasks("s"), 0);
    }

    #[test]
    fn set_awaiting_if_gen_unknown_session_is_noop() {
        let registry = Registry::new();
        assert!(!registry.set_awaiting_if_gen("ghost", Some("done".into()), 0));
    }

    #[test]
    fn current_turn_gen_returns_zero_for_unknown() {
        let registry = Registry::new();
        assert_eq!(registry.current_turn_gen("ghost"), 0);
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

    #[test]
    fn rate_limit_marks_only_the_matching_account() {
        let registry = Registry::new();
        let settings = fresh_settings();
        for sid in ["a1", "a2", "b1"] {
            registry.record_interactive_session(sid, Path::new("/tmp/x"), &settings, "2026-07-07T00:00:00Z");
        }
        registry.set_account("a1", "acct-a");
        registry.set_account("a2", "acct-a");
        registry.set_account("b1", "acct-b");

        let marked = registry.set_rate_limited_for_account("acct-a", 1_800_000_000, "five_hour");

        assert_eq!(marked, vec!["a1".to_string(), "a2".to_string()]);
        for sid in ["a1", "a2"] {
            let i = registry.get(sid).unwrap();
            assert_eq!(i.rate_limited_resets_at, Some(1_800_000_000));
            assert_eq!(i.rate_limited_type.as_deref(), Some("five_hour"));
        }
        let b = registry.get("b1").unwrap();
        assert_eq!(b.rate_limited_resets_at, None, "other accounts must be untouched");
    }

    #[test]
    fn rate_limit_does_not_mark_ended_sessions() {
        let registry = Registry::new();
        let settings = fresh_settings();
        registry.record_interactive_session("live", Path::new("/tmp/x"), &settings, "2026-07-07T00:00:00Z");
        registry.record_interactive_session("dead", Path::new("/tmp/x"), &settings, "2026-07-07T00:00:00Z");
        registry.set_account("live", "acct-a");
        registry.set_account("dead", "acct-a");
        registry.mark_ended("dead", EndReason::Manual, "2026-07-07T01:00:00Z");

        let marked = registry.set_rate_limited_for_account("acct-a", 1_800_000_000, "five_hour");

        assert_eq!(marked, vec!["live".to_string()]);
        assert_eq!(registry.get("dead").unwrap().rate_limited_resets_at, None);
    }

    /// A chat started while its account is already exhausted must be born
    /// blocked, not look healthy until its own first turn is rejected.
    #[test]
    fn set_account_seeds_an_active_rate_limit() {
        let registry = Registry::new();
        let settings = fresh_settings();
        registry.set_rate_limited_for_account("acct-a", 1_800_000_000, "seven_day");
        registry.record_interactive_session("fresh", Path::new("/tmp/x"), &settings, "2026-07-07T00:00:00Z");
        assert_eq!(registry.get("fresh").unwrap().rate_limited_resets_at, None);

        registry.set_account("fresh", "acct-a");

        let i = registry.get("fresh").unwrap();
        assert_eq!(i.rate_limited_resets_at, Some(1_800_000_000));
        assert_eq!(i.rate_limited_type.as_deref(), Some("seven_day"));
    }

    #[test]
    fn clearing_a_rate_limit_unblocks_that_accounts_sessions() {
        let registry = Registry::new();
        let settings = fresh_settings();
        registry.record_interactive_session("a1", Path::new("/tmp/x"), &settings, "2026-07-07T00:00:00Z");
        registry.set_account("a1", "acct-a");
        registry.set_rate_limited_for_account("acct-a", 1_800_000_000, "five_hour");

        registry.clear_rate_limit_for_account("acct-a");

        assert_eq!(registry.get("a1").unwrap().rate_limited_resets_at, None);
        // And the seed is gone, so a later session is not born blocked.
        registry.record_interactive_session("a2", Path::new("/tmp/x"), &settings, "2026-07-07T00:00:00Z");
        registry.set_account("a2", "acct-a");
        assert_eq!(registry.get("a2").unwrap().rate_limited_resets_at, None);
    }

    #[test]
    fn set_account_records_attribution() {
        let registry = Registry::new();
        let settings = fresh_settings();
        registry.record_interactive_session("s1", Path::new("/tmp/x"), &settings, "2026-07-07T00:00:00Z");
        assert_eq!(registry.get("s1").unwrap().account_id, None);
        assert!(registry.set_account("s1", "acct-work"));
        assert_eq!(registry.get("s1").unwrap().account_id.as_deref(), Some("acct-work"));
    }

    #[test]
    fn set_account_unknown_session_is_noop() {
        let registry = Registry::new();
        assert!(!registry.set_account("ghost", "acct-work"));
    }
}
