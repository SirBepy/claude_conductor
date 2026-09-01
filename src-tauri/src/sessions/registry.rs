//! In-memory instance registry.
//!
//! Keyed by `session_id`. The canonical source for "what Claude Code
//! processes are currently alive across the machine". Populated by
//! `hook_server.rs` (SessionStart hook), `detector.rs` (ps reconcile),
//! and `channels.rs` (future, Plan C). Any mutation emits an
//! `instances-changed` Tauri event so the webview refreshes.
//!
//! Registration/mutation methods (`register`, `mark_ended`, `set_pid`, ...)
//! live in the sibling `registry_lifecycle`; this file keeps the struct and
//! the read/query methods.

use crate::sessions::kinds::InstanceKind;
use crate::types::Instance;
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
    // `registry_turn`/`registry_lifecycle` impls.
    pub(super) inner: Mutex<HashMap<String, Instance>>,
    /// `account_id` -> (reset unix secs, window kind). Kept alongside the
    /// instances rather than only on them, so a session spawned *after* the
    /// rejection is born blocked instead of looking healthy until it tries a
    /// turn and gets rejected itself. Entries are never swept on a timer:
    /// a past `resets_at` reads as "not blocked" everywhere.
    pub(super) rate_limits: Mutex<HashMap<String, (i64, String)>>,
    /// `session_id` -> what the CLI's Stop payload says the session is still
    /// doing, per `daemon::hooks_server::activity`. A side map, not a field on
    /// `Instance`: internal to the daemon, never serialized to the frontend.
    pub(super) turn_activity: Mutex<HashMap<String, super::registry_turn::TurnActivity>>,
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
    /// `session_id` -> outcome of the last `ask_user_question` post (todo 818).
    /// Gen-stamped like the two above; the Stop hook reads it to catch a card
    /// that was accepted but never surfaced to anyone.
    pub(super) question_posted: Mutex<HashMap<String, super::registry_turn::QuestionPost>>,
    /// `session_id` -> `turn_gen` a daemon wake (repo-channel peer, Jarvis, or
    /// scheduled fire) opened, as opposed to a real user message. Consulted by
    /// the Stop hook (todo 607) so a wake-opened turn's `done` report doesn't
    /// force a chat message the dev never asked for.
    pub(super) turn_opened_by_wake: Mutex<HashMap<String, u64>>,
    /// `session_id` -> builtin `AskUserQuestion` attempts this turn. Reset by
    /// `mark_ended` and `DaemonState::expire_prompts_for_session`, so the
    /// redirect-then-fallback budget never carries over stale.
    pub(super) builtin_ask_attempts: Mutex<HashMap<String, u32>>,
    /// `session_id` -> the `turn_gen` of a turn that has been opened but not
    /// yet picked up by the pump. Written by `set_busy(true)`, consumed once by
    /// `take_pending_turn_gen`. Exists so the pump is HANDED the generation it
    /// is watching instead of inferring one from stdout timing (todo 525).
    pub(super) pending_turn_gen: Mutex<HashMap<String, u64>>,
}

impl Registry {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
            rate_limits: Mutex::new(HashMap::new()),
            turn_activity: Mutex::new(HashMap::new()),
            close_requested: Mutex::new(std::collections::HashSet::new()),
            reported_status: Mutex::new(HashMap::new()),
            message_sent_gen: Mutex::new(HashMap::new()),
            question_posted: Mutex::new(HashMap::new()),
            turn_opened_by_wake: Mutex::new(HashMap::new()),
            builtin_ask_attempts: Mutex::new(HashMap::new()),
            pending_turn_gen: Mutex::new(HashMap::new()),
        }
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

    /// Also drops entries whose owning process has died (todo 503, guards
    /// `list_peers`/`post_message`, the only callers). Skips pid=0 and
    /// `Interactive`, same as `sessions::detector::reconcile`: Path C's pid
    /// is a short-lived per-turn process, not a liveness signal.
    pub fn by_project(&self, project_id: &str) -> Vec<Instance> {
        self.inner
            .lock()
            .unwrap()
            .values()
            .filter(|i| i.project_id == project_id)
            .filter(|i| {
                i.pid == 0
                    || i.kind == InstanceKind::Interactive
                    || crate::util::process::pid_is_live(i.pid)
            })
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
