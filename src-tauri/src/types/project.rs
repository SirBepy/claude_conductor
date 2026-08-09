use serde::{Deserialize, Serialize};
use super::automation::{AutomationConfig, EndReason};
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

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, ts_rs::TS)]
#[serde(rename_all = "lowercase")]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub enum ProjectsSortBy {
    Recent,
    Live,
    Name,
    Tokens,
}

impl Default for ProjectsSortBy {
    fn default() -> Self { ProjectsSortBy::Recent }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, ts_rs::TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct ProjectConfig {
    pub id: String,
    pub path: std::path::PathBuf,
    pub name: String,
    #[serde(default)]
    pub avatar: Avatar,
    #[serde(default)]
    pub automation: Option<AutomationConfig>,
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
    #[serde(default)]
    pub bridge_session_id: Option<String>,
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
    pub automation_enabled: bool,
    pub tokens_7d: u64,
    pub live: u32,
    pub any_remote: bool,
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
    fn project_config_roundtrips_json() {
        let p = ProjectConfig {
            id: "abc".into(),
            path: std::path::PathBuf::from("C:/x/y"),
            name: "YProject".into(),
            avatar: Avatar::Emoji("🪶".into()),
            automation: None,
            created_at: "2026-04-21T00:00:00Z".into(),
            last_active_at: None,
            whitelist: CharacterWhitelist::default(),
            preferred_account_id: None,
            last_worktree_path: None,
            last_start_folder_rel: None,
        };
        let raw = serde_json::to_string(&p).unwrap();
        let back: ProjectConfig = serde_json::from_str(&raw).unwrap();
        assert_eq!(p, back);
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
            channel_epoch: 0,
            account_id: None,
            rate_limited_resets_at: None,
            rate_limited_type: None,
            frozen: false,
            frozen_needs_continue: false,
        };
        let raw = serde_json::to_string(&i).unwrap();
        let back: Instance = serde_json::from_str(&raw).unwrap();
        assert_eq!(i, back);
    }
}
