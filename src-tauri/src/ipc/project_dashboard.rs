//! Desktop IPC mirror for the daemon-owned project dashboard config (groups and
//! custom cards). Proxies to the daemon over its RPC pipe, same pattern as
//! `ipc/user_todos.rs`: the daemon is a separate process, so none of these
//! touch the store directly. Desktop only - the daemon never exposes these
//! methods to a phone or a paired machine.

use crate::project_dashboard::{
    CardResult, DashboardHistory, DashboardListRow, DashboardSnapshot, DashboardTargetRef, GroupDef, Scope,
};
use crate::state::AppState;
use tauri::State;

async fn client(state: &State<'_, AppState>) -> Result<crate::daemon_client::PersistentClient, String> {
    state.client().await.ok_or_else(|| "daemon client not connected".to_string())
}

/// `id` absent creates a group; present edits it.
#[tauri::command]
pub async fn dashboard_group_upsert(
    id: Option<String>,
    name: String,
    repos: Vec<String>,
    state: State<'_, AppState>,
) -> Result<GroupDef, String> {
    let v = client(&state)
        .await?
        .dashboard_group_upsert(id.as_deref(), &name, repos)
        .await
        .map_err(|e| e.to_string())?;
    serde_json::from_value(v).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn dashboard_group_delete(id: String, state: State<'_, AppState>) -> Result<(), String> {
    client(&state).await?.dashboard_group_delete(&id).await.map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn dashboard_card_refresh(id: String, state: State<'_, AppState>) -> Result<CardResult, String> {
    let v = client(&state).await?.dashboard_card_refresh(&id).await.map_err(|e| e.to_string())?;
    serde_json::from_value(v).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn dashboard_card_set_enabled(id: String, enabled: bool, state: State<'_, AppState>) -> Result<(), String> {
    client(&state).await?.dashboard_card_set_enabled(&id, enabled).await.map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn dashboard_card_delete(id: String, state: State<'_, AppState>) -> Result<(), String> {
    client(&state).await?.dashboard_card_delete(&id).await.map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn dashboard_builtin_set_hidden(
    scope: Scope,
    builtin: String,
    hidden: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let scope = serde_json::to_value(scope).map_err(|e| e.to_string())?;
    client(&state)
        .await?
        .dashboard_builtin_set_hidden(scope, &builtin, hidden)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Project-keyed todo tick. `next` is `open`/`done`/`archived`.
#[tauri::command]
pub async fn dashboard_todo_set_state(
    project_id: String,
    id: String,
    next: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    client(&state).await?.dashboard_todo_set_state(&project_id, &id, &next).await.map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn dashboard_list_targets(state: State<'_, AppState>) -> Result<Vec<DashboardListRow>, String> {
    let v = client(&state).await?.dashboard_list_targets().await.map_err(|e| e.to_string())?;
    serde_json::from_value(v).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn dashboard_snapshot(
    target: DashboardTargetRef,
    state: State<'_, AppState>,
) -> Result<DashboardSnapshot, String> {
    let target = serde_json::to_value(target).map_err(|e| e.to_string())?;
    let v = client(&state).await?.dashboard_snapshot(target).await.map_err(|e| e.to_string())?;
    serde_json::from_value(v).map_err(|e| e.to_string())
}

/// The transcript-mining half, fetched after the snapshot has painted.
#[tauri::command]
pub async fn dashboard_history(
    target: DashboardTargetRef,
    state: State<'_, AppState>,
) -> Result<DashboardHistory, String> {
    let target = serde_json::to_value(target).map_err(|e| e.to_string())?;
    let v = client(&state).await?.dashboard_history(target).await.map_err(|e| e.to_string())?;
    serde_json::from_value(v).map_err(|e| e.to_string())
}

/// A `data:<mime>;base64,...` URL for one gallery item.
#[tauri::command]
pub async fn dashboard_gallery_image(id: String, state: State<'_, AppState>) -> Result<String, String> {
    let v = client(&state).await?.dashboard_gallery_image(&id).await.map_err(|e| e.to_string())?;
    serde_json::from_value(v).map_err(|e| e.to_string())
}

/// Hides a target from the Projects list until a chat starts in it.
#[tauri::command]
pub async fn dashboard_close_target(target: DashboardTargetRef, state: State<'_, AppState>) -> Result<(), String> {
    let target = serde_json::to_value(target).map_err(|e| e.to_string())?;
    client(&state).await?.dashboard_close_target(target).await.map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn dashboard_open_target(target: DashboardTargetRef, state: State<'_, AppState>) -> Result<(), String> {
    let target = serde_json::to_value(target).map_err(|e| e.to_string())?;
    client(&state).await?.dashboard_open_target(target).await.map_err(|e| e.to_string())?;
    Ok(())
}

/// Replaces a target's pinned quick-action chips. Returns the normalised list
/// the daemon stored (trimmed, deduped), or the daemon's refusal text.
#[tauri::command]
pub async fn dashboard_set_pinned_actions(
    scope: Scope,
    actions: Vec<String>,
    state: State<'_, AppState>,
) -> Result<Vec<String>, String> {
    let scope = serde_json::to_value(scope).map_err(|e| e.to_string())?;
    let v = client(&state).await?.dashboard_set_pinned_actions(scope, actions).await.map_err(|e| e.to_string())?;
    serde_json::from_value(v["actions"].clone()).map_err(|e| e.to_string())
}

