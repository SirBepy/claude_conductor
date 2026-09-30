//! Tauri wrappers for `crate::tickets`: the tracker a chat's cwd links
//! tickets to, and one ticket's hover-card summary.

use crate::state::AppState;
use crate::tickets::{TicketSummary, TrackerInfo, TrackerKind};
use tauri::State;

#[tauri::command]
pub async fn get_ticket_tracker(cwd: String, state: State<'_, AppState>) -> Result<Option<TrackerInfo>, String> {
    let projects = state.settings.lock().unwrap().projects.clone();
    Ok(crate::tickets::tracker_info(projects, cwd).await)
}

#[tauri::command]
pub async fn get_ticket_summary(kind: TrackerKind, workspace: String, id: String) -> Result<TicketSummary, String> {
    crate::tickets::fetch_summary(kind, &workspace, &id).await
}
