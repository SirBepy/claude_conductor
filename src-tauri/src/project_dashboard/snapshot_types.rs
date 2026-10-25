//! Wire types for the dashboard's read half: the target list, one target's
//! snapshot, and its transcript-mined history. Never persisted, so unlike
//! `types.rs` these fields carry no `#[serde(default)]`.
//!
//! Every string-union field (`kind`, `status`) is a plain `String` with its
//! allowed values in the doc comment: ts-rs ignores serde's `rename_all`, and a
//! `String` is the one spelling that reaches TS exactly as the daemon sends it.
//! Millisecond timestamps are `#[ts(type = "number")]` because ts-rs would emit
//! `bigint` for an `i64`, which JSON never produces.

use super::types::CardView;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Which dashboard to open. `kind` is `"project"` (`id` = the project's cwd as
/// stored in `Settings.projects`) or `"group"` (`id` = `GroupDef.id`).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct DashboardTargetRef {
    pub kind: String,
    pub id: String,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct RepoRef {
    pub cwd: String,
    pub name: String,
    /// `None` for a group repo that is not a known project (no chats, todos or
    /// drafts can be keyed to it).
    pub project_id: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct DashboardTarget {
    /// `"project"` or `"group"`.
    pub kind: String,
    pub id: String,
    pub name: String,
    pub repos: Vec<RepoRef>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct DashboardListRow {
    pub target: DashboardTarget,
    #[ts(type = "number")]
    pub last_active_ms: i64,
    pub live_count: u32,
    pub question_count: u32,
    pub working_count: u32,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct DashTodo {
    pub id: String,
    pub project_id: String,
    pub text: String,
    pub origin_session_id: Option<String>,
    pub repo_cwd: String,
    pub by_ai: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct DashChatRow {
    pub session_id: String,
    pub title: String,
    /// `"question"`, `"working"`, `"your_turn"`, `"waiting"` or `"ended"`.
    pub status: String,
    pub repo_cwd: String,
    /// Last activity for a live chat, end time for an ended one.
    #[ts(type = "number")]
    pub at_ms: i64,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct PlanItem {
    pub id: Option<String>,
    pub text: String,
    pub section: String,
    pub priority: bool,
    pub repo_cwd: String,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct ScheduledRow {
    pub id: String,
    pub label: String,
    #[ts(type = "number")]
    pub fire_at_ms: i64,
    pub repo_cwd: String,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct CommitRow {
    pub short_sha: String,
    pub message: String,
    #[ts(type = "number")]
    pub timestamp_ms: i64,
    pub pushed: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct RepoShip {
    pub cwd: String,
    pub name: String,
    /// Empty for a folder that is not a git repo.
    pub branch: String,
    pub ahead: u32,
    pub behind: u32,
    pub has_upstream: bool,
    pub dirty_count: u32,
    pub recent_commits: Vec<CommitRow>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct ServerRow {
    pub name: String,
    pub port: u16,
    pub repo_cwd: String,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct DashboardSnapshot {
    pub target: DashboardTarget,
    pub your_todos: Vec<DashTodo>,
    pub chats_running: Vec<DashChatRow>,
    pub chats_recent: Vec<DashChatRow>,
    pub plan: Vec<PlanItem>,
    pub scheduled: Vec<ScheduledRow>,
    pub ship: Vec<RepoShip>,
    pub servers: Vec<ServerRow>,
    pub cards: Vec<CardView>,
    pub hidden_builtins: Vec<String>,
    /// Quick-action chips the dev (or a chat) pinned for this target, in order.
    /// Empty means "show the most-used commands instead".
    pub pinned_actions: Vec<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct QuickAction {
    /// The command as typed, leading slash included.
    pub command: String,
    pub count: u32,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct OutcomeRow {
    pub session_id: String,
    pub title: String,
    pub text: String,
    #[ts(type = "number")]
    pub at_ms: i64,
    pub repo_cwd: String,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct GalleryItem {
    /// Opaque; hand it to `dashboard_gallery_image`.
    pub id: String,
    pub session_id: String,
    pub title: String,
    #[ts(type = "number")]
    pub at_ms: i64,
    pub repo_cwd: String,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct FileRow {
    pub path: String,
    pub session_id: String,
    pub chat_title: String,
    #[ts(type = "number")]
    pub at_ms: i64,
    pub exists: bool,
    pub repo_cwd: String,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct DashboardHistory {
    pub quick_actions: Vec<QuickAction>,
    pub outcomes: Vec<OutcomeRow>,
    pub gallery: Vec<GalleryItem>,
    pub files: Vec<FileRow>,
}
