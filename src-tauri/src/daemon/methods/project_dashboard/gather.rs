//! What the read RPCs need from the running daemon: the stored groups, the
//! known projects, and every live chat with its derived status. Gathered once
//! per call so the pure builders in `project_dashboard::*` see one consistent
//! moment.

use super::ensure_seeded;
use crate::daemon::state::DaemonState;
use crate::project_dashboard::snapshot_parts::{chat_status, parse_ms, prompt_sessions};
use crate::project_dashboard::targets::ProjectInfo;
use crate::project_dashboard::types::cwd_key;
use crate::project_dashboard::{store, GroupDef};
use crate::types::Instance;

pub(super) struct LiveChat {
    pub inst: Instance,
    pub status: &'static str,
}

impl LiveChat {
    pub fn title(&self) -> String {
        self.inst.name.clone().filter(|n| !n.trim().is_empty()).unwrap_or_else(|| "New chat".to_string())
    }

    /// Last event for a running chat, else when it started: "how long has it
    /// been in this state" is what the row shows.
    pub fn at_ms(&self) -> i64 {
        self.inst
            .last_event_at
            .as_deref()
            .and_then(parse_ms)
            .or_else(|| parse_ms(&self.inst.started_at))
            .unwrap_or(0)
    }
}

pub(super) struct Gathered {
    pub groups: Vec<GroupDef>,
    pub projects: Vec<ProjectInfo>,
    pub live: Vec<LiveChat>,
    pub now_ms: i64,
}

/// Jarvis and its workers live outside the Chats list, so they stay out of the
/// dashboard's counts too.
fn counts_as_live(i: &Instance) -> bool {
    i.end_reason.is_none() && i.ended_at.is_none() && !i.jarvis && i.worker_of.is_none()
}

pub(super) async fn gather(state: &DaemonState) -> Gathered {
    ensure_seeded(state);
    let groups = store::load().groups;
    // Same two exclusions the project pickers apply: Jarvis's home folder and
    // scratch dirs are never something to open a dashboard for.
    let jarvis = crate::settings::paths::data_dir().ok().map(|d| cwd_key(&d.join("jarvis-home").to_string_lossy()));
    let projects: Vec<ProjectInfo> = state
        .settings
        .snapshot()
        .projects
        .iter()
        .filter(|p| !crate::settings::identity::is_ephemeral_root_path(&p.path))
        .filter(|p| jarvis.as_ref().is_none_or(|j| *j != cwd_key(&p.path.to_string_lossy())))
        .map(|p| ProjectInfo {
            id: p.id.clone(),
            path: p.path.to_string_lossy().into_owned(),
            name: p.name.clone(),
            last_active_ms: p.last_active_at.as_deref().and_then(parse_ms).unwrap_or(0),
            exists: p.path.exists(),
        })
        .collect();
    let prompts = prompt_sessions(&state.list_prompts().await);
    let live = state
        .registry
        .list()
        .into_iter()
        .filter(counts_as_live)
        .map(|inst| {
            let status = chat_status(inst.awaiting.as_deref(), inst.busy, prompts.contains(&inst.session_id));
            LiveChat { inst, status }
        })
        .collect();
    Gathered { groups, projects, live, now_ms: chrono::Utc::now().timestamp_millis() }
}
