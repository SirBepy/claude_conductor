//! Registration and mutation methods split out of `registry.rs` (todo 801):
//! `register`, `record_interactive_session`, `upsert_interactive`,
//! `externalize_session`, `mark_ended`, `set_bridge_session_id`, `set_pid`,
//! `set_kind`, `retag_pid_as_automated`, `set_name`, `prune_ended_keeping_newest`.

use super::kinds::InstanceKind;
use super::registry::{RegisterInput, Registry};
use crate::settings;
use crate::types::{EndReason, Instance, Settings};
use std::sync::Mutex;

impl Registry {
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
            local_task_running: false,
            successor_of: None,
        };
        guard.insert(input.session_id, instance);
        (project_id, true)
    }

    /// Path C helper: insert (or upgrade) an Interactive session entry.
    /// Unknown `session_id` inserts fresh (pid=0, Path C has no persistent
    /// process between turns). Existing `session_id` (e.g. takeover from
    /// Manual) mutates in place: kind/busy/ended_at/end_reason reset, project_id and pid preserved.
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
            local_task_running: false,
            successor_of: None,
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
            local_task_running: false,
            successor_of: None,
        };
        guard.insert(session_id.to_string(), instance);
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
        drop(guard);
        // Non-interactive kinds never hit `expire_prompts_for_session`'s reset,
        // so a session-end sweep here is the only cleanup they get.
        self.builtin_ask_attempts.lock().unwrap().remove(session_id);
        self.pending_turn_gen.lock().unwrap().remove(session_id);
        crate::sessions::repo_channel::forget_session(session_id);
        true
    }

    pub fn set_bridge_session_id(&self, session_id: &str, bridge_id: String) {
        let mut guard = self.inner.lock().unwrap();
        if let Some(i) = guard.get_mut(session_id) {
            i.bridge_session_id = Some(bridge_id);
        }
    }

    /// Late-binding pid update, used when the SessionStart hook payload
    /// omitted pid and it was resolved later from `~/.claude/sessions/*.json`.
    /// Returns true if pid actually changed.
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
    /// `Automated` + remote, once the channel lifecycle resolves the real
    /// `claude` pid (closes the spawn-vs-hook race). Returns true if changed.
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

    /// Keep the `keep` most recently ended instances, drop the rest. Live
    /// instances are never counted or removed. Bounds the registry by volume
    /// rather than by age, so a chat is only ever evicted once `keep` newer
    /// ones exist - a clock never retires one the dev might still want.
    pub fn prune_ended_keeping_newest(&self, keep: usize) -> usize {
        let mut guard = self.inner.lock().unwrap();
        let mut ended: Vec<(String, String)> = guard
            .iter()
            .filter_map(|(id, i)| i.ended_at.clone().map(|t| (t, id.clone())))
            .collect();
        if ended.len() <= keep {
            return 0;
        }
        // RFC3339 with a `Z` suffix sorts chronologically as a plain string,
        // so a lexicographic sort is already newest-last.
        ended.sort_unstable();
        let drop_count = ended.len() - keep;
        let doomed: std::collections::HashSet<String> =
            ended.into_iter().take(drop_count).map(|(_, id)| id).collect();
        let before = guard.len();
        guard.retain(|id, _| !doomed.contains(id));
        before - guard.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};

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

    fn register_ended(registry: &Registry, settings: &Mutex<Settings>, id: &str, ended_at: &str) {
        registry.register(
            RegisterInput {
                session_id: id.into(),
                cwd: PathBuf::from("/tmp/prune"),
                pid: 1,
                kind: InstanceKind::External,
                is_remote: false,
                transcript_path: None,
                started_at: "2026-05-08T00:00:00Z".into(),
            },
            settings,
            "2026-05-08T00:00:00Z",
        );
        registry.mark_ended(id, EndReason::Manual, ended_at);
    }

    #[test]
    fn prune_ended_keeping_newest_drops_only_the_oldest_over_the_cap() {
        let registry = Registry::new();
        let settings = fresh_settings();
        register_ended(&registry, &settings, "oldest", "2026-05-08T01:00:00Z");
        register_ended(&registry, &settings, "middle", "2026-05-08T02:00:00Z");
        register_ended(&registry, &settings, "newest", "2026-05-08T03:00:00Z");

        assert_eq!(registry.prune_ended_keeping_newest(2), 1);
        assert!(registry.get("oldest").is_none(), "the oldest ended chat is the one evicted");
        assert!(registry.get("middle").is_some());
        assert!(registry.get("newest").is_some());
    }

    #[test]
    fn prune_ended_keeping_newest_is_a_noop_under_the_cap() {
        let registry = Registry::new();
        let settings = fresh_settings();
        register_ended(&registry, &settings, "a", "2026-05-08T01:00:00Z");
        register_ended(&registry, &settings, "b", "2026-05-08T02:00:00Z");

        // However old they are, volume is what evicts - never elapsed time.
        assert_eq!(registry.prune_ended_keeping_newest(200), 0);
        assert!(registry.get("a").is_some());
        assert!(registry.get("b").is_some());
    }

    #[test]
    fn prune_ended_keeping_newest_never_counts_or_removes_a_live_session() {
        let registry = Registry::new();
        let settings = fresh_settings();
        register_ended(&registry, &settings, "ended-1", "2026-05-08T01:00:00Z");
        register_ended(&registry, &settings, "ended-2", "2026-05-08T02:00:00Z");
        registry.register(
            RegisterInput {
                session_id: "live".into(),
                cwd: PathBuf::from("/tmp/prune"),
                pid: 2,
                kind: InstanceKind::External,
                is_remote: false,
                transcript_path: None,
                started_at: "2026-05-08T00:00:00Z".into(),
            },
            &settings,
            "2026-05-08T00:00:00Z",
        );

        assert_eq!(registry.prune_ended_keeping_newest(1), 1);
        assert!(registry.get("ended-1").is_none());
        assert!(registry.get("ended-2").is_some());
        assert!(registry.get("live").is_some(), "a live session is never evicted");
    }

}
