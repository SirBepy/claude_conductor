use serde::{Deserialize, Serialize};
use super::session_end::EndReason;
use crate::sessions::kinds::InstanceKind;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, ts_rs::TS)]
#[serde(tag = "mode", rename_all = "lowercase")]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub enum CharacterWhitelist {
    Default,
    All,
    Custom { games: Vec<String>, ids: Vec<String> },
}

impl Default for CharacterWhitelist {
    fn default() -> Self { CharacterWhitelist::Default }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, ts_rs::TS)]
#[serde(tag = "kind", content = "value", rename_all = "lowercase")]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub enum Avatar {
    None,
    Emoji(String),
    Image(std::path::PathBuf),
    Character(String),
}

impl Default for Avatar {
    fn default() -> Self { Avatar::None }
}

/// One project-listed HTTP MCP server: the name becomes the `mcp__<name>__`
/// tool prefix.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, ts_rs::TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct ProjectMcpServer {
    // Defaulted so a trimmed entry in settings.json cannot fail the whole file's
    // deserialization; `project_mcp::check` rejects an empty name or url.
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub url: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, ts_rs::TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct ProjectConfig {
    pub id: String,
    pub path: std::path::PathBuf,
    pub name: String,
    #[serde(default)]
    pub avatar: Avatar,
    pub created_at: String,
    #[serde(default)]
    pub last_active_at: Option<String>,
    #[serde(default)]
    pub whitelist: CharacterWhitelist,
    /// Registry account new chats in this project spawn under. `None` falls
    /// back to `Settings.default_account_id` (multi-account milestone 04) -
    /// see `docs/multi-account/04-project-binding.md`.
    #[serde(default)]
    pub preferred_account_id: Option<String>,
    /// Last worktree path opened for this project (absolute), so the
    /// location picker can default to it next time instead of always
    /// starting at the main worktree.
    #[serde(default)]
    pub last_worktree_path: Option<String>,
    /// Last CLAUDE.md start-folder chosen, relative to whichever worktree
    /// was open at the time (empty string means the worktree's own root).
    /// Not necessarily valid for a *different* worktree - callers must
    /// re-verify it still exists after a worktree switch and fall back to
    /// root if not, since different checkouts can have different layouts.
    #[serde(default)]
    pub last_start_folder_rel: Option<String>,
    /// Loads the spawning account's claude.ai connectors (Google Drive etc.)
    /// into this project's chats. Chats run `--strict-mcp-config`, so only
    /// these explicitly named proxy entries get through, never the local
    /// user-scope servers whose failed auth broke MCP init (todo 867).
    #[serde(default)]
    pub claude_ai_connectors: bool,
    /// The project's own HTTP MCP servers (e.g. a local app's `/mcp`), merged
    /// into each turn's generated config after a reachability probe. Never
    /// read from a repo file: only what Joe entered here runs.
    #[serde(default)]
    pub mcp_servers: Vec<ProjectMcpServer>,
    /// Where this project's tickets live, so chat mentions link to them.
    /// `None` infers from the git remote (`tickets::infer_from_remote`).
    #[serde(default)]
    pub tracker: Option<crate::tickets::TicketTracker>,
    /// Gaming mode's per-project allowlist: a chat under this project is
    /// never parked, and a supervised dev-server entry rooted under this
    /// project's path is never stopped, while gaming mode is on. Default
    /// false so an existing project opts in explicitly.
    #[serde(default)]
    pub keep_running_in_gaming_mode: bool,
    /// Model a new chat in this project opens on. `None` follows the global
    /// default (Settings' `defaultModel`, kept in `extra`). Stored as a model
    /// family (`sonnet`), like every other persisted model value.
    #[serde(default)]
    pub default_model: Option<String>,
    /// Effort a new chat in this project opens on; `None` follows the global default.
    #[serde(default)]
    pub default_effort: Option<String>,
    /// What a sub of a "Use subchats" chat must show before it can finish.
    #[serde(default)]
    pub subchat_check: SubchatCheck,
    /// How subs that edit files share this project's tree.
    #[serde(default)]
    pub subchat_writers: SubchatWriters,
}

/// Project setting "Check a sub's work". `FactsAndReviewer` is the default:
/// a sub that changed files must run a fresh reviewer subagent on its own diff
/// before it can finish.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq, ts_rs::TS)]
#[serde(rename_all = "snake_case")]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub enum SubchatCheck {
    #[default]
    FactsAndReviewer,
    FactsOnly,
}

/// Project setting "Subs changing files". `OneAtATime` is the default: one
/// writing sub per project, the next one queues.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq, ts_rs::TS)]
#[serde(rename_all = "snake_case")]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub enum SubchatWriters {
    #[default]
    OneAtATime,
    WorktreeEach,
}

/// Which paired peer machine an `Instance` row is mirrored from, and
/// whether that peer's link is currently live. `online: false` means the
/// row is stale (last known state before the link dropped), kept visible
/// rather than vanished so a sidebar entry doesn't flicker out on a blip.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, ts_rs::TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct MachineRef {
    pub id: String,
    pub label: String,
    pub online: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, ts_rs::TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct Instance {
    pub session_id: String,
    pub pid: u32,
    pub cwd: std::path::PathBuf,
    pub project_id: String,
    pub kind: InstanceKind,
    #[serde(default)]
    pub is_remote: bool,
    pub started_at: String,
    #[serde(default)]
    pub transcript_path: Option<std::path::PathBuf>,
    /// Short label derived from the transcript's first user prompt
    /// (truncated). Mirrors what `/resume` shows so the user can tell
    /// concurrent sessions apart at a glance. None until the prompt
    /// is resolved (sessions start before the user types anything).
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub ended_at: Option<String>,
    #[serde(default)]
    pub end_reason: Option<EndReason>,
    /// Path C: marks an Interactive session as having a turn currently
    /// in flight (a `claude -p --resume` child is running). Sidebar
    /// renders this as "running" vs "idle/needs input". False at rest.
    #[serde(default)]
    pub busy: bool,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub effort: String,
    /// Self-reported turn status from the last completed turn.
    /// `Some("question")` = Claude ended with a question; `Some("done")` = done normally.
    /// `None` until the first turn completes or after a new turn starts.
    #[serde(default)]
    pub awaiting: Option<String>,
    /// Last `awaiting` value used for the `turn_sound` dedup decision (todo
    /// 564) - not what's displayed. Lets N consecutive `question` turns
    /// notify once instead of N times.
    #[serde(skip, default)]
    #[ts(skip)]
    pub last_notified_awaiting: Option<String>,
    /// True while /autopilot is active in this session. Set via `<cc-autopilot:on>`
    /// marker, cleared by `<cc-autopilot:off>` or session end.
    #[serde(default)]
    pub autopilot: bool,
    /// True for the singleton Jarvis orchestrator session (todo 272). Set once,
    /// at spawn time, by `ensure_jarvis_session`; never flips back.
    #[serde(default)]
    pub jarvis: bool,
    /// Set on a worker session spawned BY Jarvis, to the Jarvis session's id.
    /// `None` for every ordinary session and for Jarvis itself. Later chunks
    /// use this to route worker status back to the orchestrator.
    #[serde(default)]
    pub worker_of: Option<String>,
    /// True while a `/close` skill run is in flight for this session (the pump
    /// saw the turn's first live output and the user opened it with `/close`,
    /// and the close has neither confirmed nor stood down yet). Daemon-
    /// authoritative so EVERY window's sidebar can render the "Closing" segment
    /// - the old signal was a per-window in-memory Set that only the window
    /// whose composer sent the /close ever populated. Cleared at any turn
    /// boundary that did not confirm the close (teardown is driven separately by
    /// the `close_session` MCP tool's `close_requested` flag).
    #[serde(default)]
    pub closing: bool,
    /// Monotonically increasing counter bumped each time `busy` is set to true
    /// (i.e. each time a new turn starts). Used by the pump to detect whether a
    /// newer turn has started since the pump began draining the previous one, so
    /// the stale `set_busy(false)` from the old turn's result line doesn't
    /// overwrite the new turn's `busy=true`. Never sent to the webview.
    #[serde(skip, default)]
    #[ts(skip)]
    pub turn_gen: u64,
    /// Wall-clock RFC3339 of the last event of ANY kind seen for this
    /// session (turn-start bump, stdout line, report_turn_status) - the
    /// busy-watchdog backstop's only signal. Never sent to the webview.
    #[serde(skip, default)]
    #[ts(skip)]
    pub last_event_at: Option<String>,
    /// Bumped daemon-side each time this session's broadcast channel is
    /// (re)created. Unlike `turn_gen`, this crosses the RPC boundary.
    #[serde(default)]
    #[ts(skip)]
    pub channel_epoch: u64,
    /// The registry account this session was spawned under. `None` for
    /// sessions that predate milestone 02, or for terminal-observed
    /// (non-app-spawned) sessions, which are attributed to the terminal's
    /// identity instead - see `docs/multi-account/02-chat-routing.md` step 5.
    #[serde(default)]
    pub account_id: Option<String>,
    /// Unix seconds at which this session's account leaves its rate-limit
    /// window, set when the CLI rejects a turn. Never cleared on a timer:
    /// every consumer treats it as live only while `now < resets_at`, so an
    /// unattended app expires the state without needing a turn to run.
    #[serde(default)]
    pub rate_limited_resets_at: Option<i64>,
    /// Which window was hit: `five_hour` | `seven_day` | `weekly`. Paired with
    /// `rate_limited_resets_at`; meaningless on its own.
    #[serde(default)]
    pub rate_limited_type: Option<String>,
    /// True once the user froze this session (Chat menu toggle) - live child
    /// force-killed; only explicit unfreeze respawns it. Never implies `ended_at`.
    #[serde(default)]
    pub frozen: bool,
    /// Set when freezing cancelled an in-flight turn; consumed once by
    /// unfreeze to auto-send "continue". Internal only, never sent to the webview.
    #[serde(skip, default)]
    #[ts(skip)]
    pub frozen_needs_continue: bool,
    /// True when `frozen` was set by `handle_rate_limit_rejection` (out of
    /// quota) rather than the user clicking "Freeze chat". Distinguishes the
    /// two so the queued rate-limit resume (`schedule_fire::fire_message`) may
    /// clear ONLY a freeze it caused itself, never a deliberate manual one.
    #[serde(default)]
    pub auto_frozen: bool,
    /// Count of messages queued (held) while a turn runs - cross-surface
    /// sync's cheap half, rides `instances_changed` so every surface shows
    /// the chip without fetching drafts. Full content is fetched on demand
    /// from `DaemonState::draft_store` (never broadcast).
    #[serde(default)]
    pub held_count: u32,
    /// A background process from the last turn is still alive on THIS machine.
    /// `awaiting` cannot answer that: it calls a live poller and a pending
    /// scheduled wake both "waiting", and only the first dies on sleep.
    #[serde(default)]
    pub local_task_running: bool,
    /// Set by the `respawn` MCP tool to the id of the chat being taken over.
    /// A fresh context window needs a fresh id, so this link is how the
    /// sidebar moves the user onto the successor instead of stranding them.
    #[serde(default)]
    pub successor_of: Option<String>,
    /// Set on a hidden sub of a "Use subchats" chat, to that main chat's id.
    /// `None` for every ordinary session. A separate field from `worker_of` on
    /// purpose: Jarvis's wake-on-every-state routing keys on `worker_of`, and a
    /// sub must not wake its parent.
    #[serde(default)]
    pub subchat_of: Option<String>,
    /// True once a sub called its finish tool: idle and hidden, it keeps its
    /// row and context and wakes on a follow-up. Never implies `ended_at`.
    #[serde(default)]
    pub subchat_finished: bool,
    /// Joe pinned this sub to the sidebar (chat menu "Pin to sidemenu"). Only
    /// adds a sidebar shortcut: the sub stays a sub of its main chat. Survives a
    /// restart through the registry snapshot.
    #[serde(default)]
    pub pinned_to_sidebar: bool,
    /// Set only for a row mirrored in from a paired peer machine (multi-
    /// machine federation) - `None` means this session lives on THIS
    /// daemon. Stamped by `daemon::machines::all_instances`, never by the
    /// registry itself (a registry row is always locally hosted).
    #[serde(default)]
    pub machine: Option<MachineRef>,
    /// What the sidebar row shows beyond the status flags: the latest
    /// `write_plan` checklist and when the row last changed busy/idle.
    #[serde(default)]
    pub progress: SessionProgress,
}

/// One step of the plan a chat wrote with `write_plan`, as the sidebar ring
/// and hover card read it. `status` is `pending` | `active` | `done` | `skipped`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, ts_rs::TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct PlanStepSnapshot {
    pub text: String,
    pub status: String,
}

/// Progress details that ride `Instance` so every window, the phone and a
/// paired peer's mirror of this row all see them without a second fetch.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default, ts_rs::TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct SessionProgress {
    /// The latest `write_plan` call of the CURRENT turn; cleared when a new
    /// turn opens, because a plan belongs to the turn that wrote it. `None` for
    /// a chat that never wrote one. `TodoWrite` checklists never reach the
    /// daemon, so they are not here.
    #[serde(default)]
    pub plan: Option<Vec<PlanStepSnapshot>>,
    /// RFC3339 of the last busy/idle flip: how long the row has been working
    /// (turn timer) or waiting/done. `None` until the first flip this run.
    #[serde(default)]
    pub state_since: Option<String>,
    /// Set on a sub the daemon holds without a child ("waiting for header"): the
    /// row exists and counts as running, but nothing has started it yet. Clients
    /// draw it as queued. Not persisted with the row; `subchats::held` owns the
    /// durable copy and re-stamps this at boot. Optional on the wire so a client
    /// that builds a `progress` by literal does not have to name it.
    #[serde(default)]
    #[ts(optional)]
    pub waiting_for: Option<String>,
    /// A sub's place in the writer queue while `waiting_for` is set, 1 = next. `None`
    /// for a sub that waits on an `after` target (its `waiting_for` names it) and for
    /// any sub not waiting. Cleared with `waiting_for`; in memory only.
    #[serde(default)]
    #[ts(optional)]
    pub queue_place: Option<u32>,
    /// Name of the sub holding the writer slot a queued sub waits behind; set and
    /// cleared with `queue_place`.
    #[serde(default)]
    #[ts(optional)]
    pub queue_behind: Option<String>,
    /// A sub's last turn ended and it never called finish: set when its busy flag
    /// falls, cleared when a turn starts, when it finishes or when it ends. Says
    /// nothing about WHY it stopped, so a client puts asking, paused and queued
    /// first. In memory only (a restart ends every turn). `Some(true)` or absent:
    /// an `Option` so a client that builds a `progress` by literal need not name it.
    #[serde(default)]
    #[ts(optional)]
    pub stopped_unfinished: Option<bool>,
    /// The latest tool call of a sub in words ("Editing footer.css") and when it
    /// was made (RFC3339). Replaced by each call and kept after the turn ends, so a
    /// stopped sub still shows where it stopped. In memory only.
    #[serde(default)]
    #[ts(optional)]
    pub last_action: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub last_action_at: Option<String>,
    /// Gaming mode parked this chat (`gaming_mode::is_parked`). Mirrored onto the
    /// row because a park freezes nothing, so no other flag says it. `Some(true)`
    /// or absent, like `stopped_unfinished`.
    #[serde(default)]
    #[ts(optional)]
    pub parked: Option<bool>,
}

impl SessionProgress {
    /// The sub's last turn ended and it never finished (see `stopped_unfinished`).
    pub fn is_stopped(&self) -> bool {
        self.stopped_unfinished == Some(true)
    }

    /// Gaming mode parked this chat (see `parked`).
    pub fn is_parked(&self) -> bool {
        self.parked == Some(true)
    }
}

/// Shape served to the webview. Same as `Instance` for now; kept as a
/// distinct type so future payload tweaks don't require a registry-wide
/// schema change.
pub type InstanceSummary = Instance;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, ts_rs::TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct ProjectGroup {
    pub id: Option<String>,
    pub path: String,
    pub name: String,
    pub parent_segment: Option<String>,
    pub avatar: Avatar,
    pub tokens_7d: u64,
    pub live: u32,
    pub any_automated: bool,
    pub last_active_at: Option<String>,
    pub path_exists: bool,
    /// Git worktrees of this repo that were folded out of the top-level
    /// picker list (see `ipc::project_groups::fold_worktrees`). Empty for
    /// projects with no known worktrees.
    #[serde(default)]
    pub worktrees: Vec<WorktreeSummary>,
    /// Mirrors `ProjectConfig.last_worktree_path`/`last_start_folder_rel` so
    /// the location picker can seed its chips without a separate
    /// `get_project` round-trip. `None` when the project has no settings
    /// entry yet (id is also `None` in that case).
    #[serde(default)]
    pub last_worktree_path: Option<String>,
    #[serde(default)]
    pub last_start_folder_rel: Option<String>,
}

/// A git worktree belonging to a `ProjectGroup`, surfaced by the project
/// picker instead of appearing as its own top-level entry. Cheap fields
/// only (no git subprocess calls) - branch name and staleness are fetched
/// on demand via `list_worktree_details` when the user opens the
/// new/existing/default sub-picker.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, ts_rs::TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct WorktreeSummary {
    pub path: String,
    pub name: String,
    pub tokens_7d: u64,
    pub live: u32,
    pub last_active_at: Option<String>,
    pub path_exists: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_project_mcp_entry_missing_a_key_still_deserializes() {
        let s: ProjectMcpServer = serde_json::from_str(r#"{"name":"rodge"}"#).unwrap();
        assert_eq!(s.name, "rodge");
        assert_eq!(s.url, "");
    }

    #[test]
    fn project_config_roundtrips_json() {
        let p = ProjectConfig {
            id: "abc".into(),
            path: std::path::PathBuf::from("C:/x/y"),
            name: "YProject".into(),
            avatar: Avatar::Emoji("🪶".into()),
            created_at: "2026-04-21T00:00:00Z".into(),
            last_active_at: None,
            whitelist: CharacterWhitelist::default(),
            preferred_account_id: None,
            last_worktree_path: None,
            last_start_folder_rel: None,
            claude_ai_connectors: false,
            mcp_servers: Vec::new(),
            tracker: None,
            keep_running_in_gaming_mode: false,
            default_model: Some("sonnet".into()),
            default_effort: Some("high".into()),
            subchat_check: SubchatCheck::FactsOnly,
            subchat_writers: SubchatWriters::WorktreeEach,
        };
        let raw = serde_json::to_string(&p).unwrap();
        assert!(raw.contains(r#""subchat_check":"facts_only""#) && raw.contains(r#""subchat_writers":"worktree_each""#));
        let back: ProjectConfig = serde_json::from_str(&raw).unwrap();
        assert_eq!(p, back);
    }

    // A settings.json written before the subchat settings existed must keep
    // loading with the contract's defaults, or every project would be lost.
    #[test]
    fn project_config_without_subchat_fields_still_loads_with_defaults() {
        let raw = r#"{"id":"abc","path":"C:/x/y","name":"Y","created_at":"2026-04-21T00:00:00Z"}"#;
        let p: ProjectConfig = serde_json::from_str(raw).unwrap();
        assert_eq!(p.subchat_check, SubchatCheck::FactsAndReviewer);
        assert_eq!(p.subchat_writers, SubchatWriters::OneAtATime);
    }

    #[test]
    fn project_config_without_default_model_fields_still_loads() {
        // A settings.json written before the fields existed must keep loading.
        let raw = r#"{"id":"abc","path":"C:/x/y","name":"Y","created_at":"2026-04-21T00:00:00Z"}"#;
        let p: ProjectConfig = serde_json::from_str(raw).unwrap();
        assert_eq!(p.default_model, None);
        assert_eq!(p.default_effort, None);
    }

    #[test]
    fn character_whitelist_default_serializes() {
        let w = CharacterWhitelist::Default;
        let raw = serde_json::to_string(&w).unwrap();
        assert_eq!(raw, r#"{"mode":"default"}"#);
        let back: CharacterWhitelist = serde_json::from_str(&raw).unwrap();
        assert_eq!(w, back);
    }

    #[test]
    fn character_whitelist_all_serializes() {
        let w = CharacterWhitelist::All;
        let raw = serde_json::to_string(&w).unwrap();
        assert_eq!(raw, r#"{"mode":"all"}"#);
        let back: CharacterWhitelist = serde_json::from_str(&raw).unwrap();
        assert_eq!(w, back);
    }

    #[test]
    fn character_whitelist_custom_serializes() {
        let w = CharacterWhitelist::Custom {
            games: vec!["heroes-of-the-storm".to_string()],
            ids: vec!["abathur".to_string()],
        };
        let raw = serde_json::to_string(&w).unwrap();
        assert_eq!(raw, r#"{"mode":"custom","games":["heroes-of-the-storm"],"ids":["abathur"]}"#);
        let back: CharacterWhitelist = serde_json::from_str(&raw).unwrap();
        assert_eq!(w, back);
    }

    #[test]
    fn avatar_serializes_as_tagged_enum() {
        let a = Avatar::Emoji("🦊".into());
        let raw = serde_json::to_string(&a).unwrap();
        assert_eq!(raw, r#"{"kind":"emoji","value":"🦊"}"#);
        let back: Avatar = serde_json::from_str(&raw).unwrap();
        assert_eq!(a, back);
    }

    #[test]
    fn avatar_character_serializes_as_tagged_enum() {
        let a = Avatar::Character("peon".into());
        let raw = serde_json::to_string(&a).unwrap();
        assert_eq!(raw, r#"{"kind":"character","value":"peon"}"#);
        let back: Avatar = serde_json::from_str(&raw).unwrap();
        assert_eq!(a, back);
    }

    #[test]
    fn instance_roundtrips_json() {
        let i = Instance {
            session_id: "s1".into(),
            pid: 1234,
            cwd: std::path::PathBuf::from("C:/x"),
            project_id: "proj-a".into(),
            kind: InstanceKind::External,
            is_remote: false,
            started_at: "2026-04-21T10:00:00Z".into(),
            transcript_path: Some(std::path::PathBuf::from("C:/t/abc.jsonl")),
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
            progress: Default::default(),
            local_task_running: false,
            successor_of: None,
            subchat_of: Some("main-1".into()),
            subchat_finished: true,
            pinned_to_sidebar: false,
            machine: None,
        };
        let raw = serde_json::to_string(&i).unwrap();
        let back: Instance = serde_json::from_str(&raw).unwrap();
        assert_eq!(i, back);
    }

    // A paired peer on an older build, or a restored snapshot, still sends the
    // retired `bridge_session_id` key; the row must keep loading.
    #[test]
    fn instance_loads_a_payload_carrying_the_retired_bridge_session_id_key() {
        let raw = r#"{"session_id":"s1","pid":1,"cwd":"C:/x","project_id":"p","kind":"external","started_at":"2026-04-21T10:00:00Z","bridge_session_id":"abc"}"#;
        let got: Instance = serde_json::from_str(raw).unwrap();
        assert_eq!(got.session_id, "s1");
    }
}
