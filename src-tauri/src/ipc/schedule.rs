//! Scheduled messages / scheduled new-chats: app-side IPC surface.
//!
//! `chat-config.json`'s rule is "daemon sole writer, app reads the shared
//! file directly" (`ipc/misc.rs::get_session_config` / `list_auto_accept`).
//! The scheduled-items store follows the analogous split: the daemon's
//! scheduler tick loop (`daemon::schedule`) continuously rewrites
//! `scheduled-items.json` as items fire, so every APP-INITIATED mutation
//! (create/update/delete/fire-now) must also round-trip through the daemon
//! (`daemon::methods::schedule`) rather than writing the file from this
//! process - otherwise a write racing the tick loop could clobber a fire in
//! progress. Reads (`schedule_list`) are safe to do directly, same as
//! `get_session_config`/`list_auto_accept`.
//!
//! `schedule_list_external` is unrelated to that store: it's a read-only scan
//! of Windows Task Scheduler one-shot sidecars (`/schedule-once`), never
//! written by this app, so there is nothing to route through the daemon.

use crate::sessions::scheduled_items::{Recurrence, ScheduledItem, ScheduledKind};
use crate::state::AppState;
use serde::Serialize;
use tauri::State;

/// All scheduled items. Direct file read (see module doc); ordering is left
/// to the frontend.
#[tauri::command]
pub async fn schedule_list() -> Vec<ScheduledItem> {
    crate::sessions::scheduled_items::list()
}

#[tauri::command]
pub async fn schedule_create(
    kind: ScheduledKind,
    prompt: String,
    fire_at: String,
    recurrence: Option<Recurrence>,
    state: State<'_, AppState>,
) -> Result<ScheduledItem, String> {
    let guard = state.daemon_client.lock().await;
    let client = guard.as_ref().ok_or_else(|| "daemon client not connected".to_string())?;
    let kind_v = serde_json::to_value(&kind).map_err(|e| e.to_string())?;
    let recurrence_v = recurrence
        .as_ref()
        .map(serde_json::to_value)
        .transpose()
        .map_err(|e| e.to_string())?;
    let result = client
        .schedule_create(kind_v, &prompt, &fire_at, recurrence_v)
        .await
        .map_err(|e| e.to_string())?;
    serde_json::from_value(result).map_err(|e| e.to_string())
}

/// Overwrites an existing item (edit prompt/time/recurrence, or a status
/// change like acknowledging a Missed item). `item` is a full round-tripped
/// `ScheduledItem` from `schedule_list`; the daemon rejects an unknown id.
#[tauri::command]
pub async fn schedule_update(item: ScheduledItem, state: State<'_, AppState>) -> Result<(), String> {
    let guard = state.daemon_client.lock().await;
    let client = guard.as_ref().ok_or_else(|| "daemon client not connected".to_string())?;
    let v = serde_json::to_value(&item).map_err(|e| e.to_string())?;
    client.schedule_update(v).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn schedule_delete(id: String, state: State<'_, AppState>) -> Result<(), String> {
    let guard = state.daemon_client.lock().await;
    let client = guard.as_ref().ok_or_else(|| "daemon client not connected".to_string())?;
    client.schedule_delete(&id).await.map_err(|e| e.to_string())
}

/// Fires a scheduled item immediately instead of waiting for the next ~30s
/// scheduler tick.
#[tauri::command]
pub async fn schedule_fire_now(id: String, state: State<'_, AppState>) -> Result<(), String> {
    let guard = state.daemon_client.lock().await;
    let client = guard.as_ref().ok_or_else(|| "daemon client not connected".to_string())?;
    client.schedule_fire_now(&id).await.map_err(|e| e.to_string())
}

/// A Windows Task Scheduler one-shot registered by the `/schedule-once`
/// skill, surfaced read-only in the unified schedule view. `fire_at` here is
/// the sidecar's local "yyyy-MM-dd HH:mm:ss" `humanTime` string, NOT the UTC
/// RFC3339 `ScheduledItem::fire_at` - these jobs are entirely outside this
/// app's control, so there is nothing to normalize it against.
#[derive(Clone, Debug, Serialize, ts_rs::TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct ExternalScheduledJob {
    pub id: String,
    pub label: String,
    pub fire_at: Option<String>,
    pub cwd: Option<String>,
    pub detail: Option<String>,
}

/// Leniently parses a `/schedule-once` job sidecar
/// (`%LOCALAPPDATA%\ClaudeScheduleOnce\jobs\<task>.json`). Field names are
/// exactly what `schedule-once.ps1` writes (verified against that script -
/// no sidecars existed on this machine at implementation time to inspect
/// directly). `#[serde(default)]` on every field so an older/newer sidecar
/// shape never fails to parse; missing fields just render as empty/None.
#[derive(Debug, Default, serde::Deserialize)]
struct ScheduleOnceSidecar {
    #[serde(default, rename = "taskName")]
    task_name: String,
    #[serde(default)]
    mode: String,
    #[serde(default)]
    payload: String,
    #[serde(default, rename = "workDir")]
    work_dir: String,
    #[serde(default, rename = "humanTime")]
    human_time: String,
}

#[tauri::command]
pub async fn schedule_list_external() -> Vec<ExternalScheduledJob> {
    list_external_jobs()
}

#[cfg(windows)]
fn list_external_jobs() -> Vec<ExternalScheduledJob> {
    let Some(local_app_data) = dirs::data_local_dir() else { return Vec::new() };
    let jobs_dir = local_app_data.join("ClaudeScheduleOnce").join("jobs");
    let Ok(entries) = std::fs::read_dir(&jobs_dir) else { return Vec::new() };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Ok(raw) = std::fs::read_to_string(&path) else { continue };
        let Ok(sidecar) = serde_json::from_str::<ScheduleOnceSidecar>(&raw) else { continue };
        let fallback_id = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        let id = if sidecar.task_name.is_empty() { fallback_id } else { sidecar.task_name.clone() };
        let label = if sidecar.task_name.is_empty() { "Scheduled task".to_string() } else { sidecar.task_name.clone() };
        out.push(ExternalScheduledJob {
            id,
            label,
            fire_at: (!sidecar.human_time.is_empty()).then_some(sidecar.human_time),
            cwd: (!sidecar.work_dir.is_empty()).then_some(sidecar.work_dir),
            detail: Some(external_detail(&sidecar.mode, &sidecar.payload)),
        });
    }
    out
}

#[cfg(not(windows))]
fn list_external_jobs() -> Vec<ExternalScheduledJob> {
    Vec::new()
}

#[cfg(windows)]
fn external_detail(mode: &str, payload: &str) -> String {
    let truncated: String = payload.chars().take(120).collect();
    if mode.is_empty() {
        truncated
    } else {
        format!("[{mode}] {truncated}")
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn sidecar_parses_the_documented_schedule_once_shape() {
        let raw = r#"{
            "taskName": "ClaudeOnce_test-job_20260709-153000",
            "mode": "prompt",
            "payload": "do the thing",
            "workDir": "C:\\proj",
            "permMode": "acceptEdits",
            "model": "",
            "effort": "",
            "claudeExe": "C:\\claude.exe",
            "humanTime": "2026-07-09 15:30:00",
            "createdAt": "2026-07-09 12:00:00"
        }"#;
        let sidecar: ScheduleOnceSidecar = serde_json::from_str(raw).expect("must parse");
        assert_eq!(sidecar.task_name, "ClaudeOnce_test-job_20260709-153000");
        assert_eq!(sidecar.mode, "prompt");
        assert_eq!(sidecar.work_dir, "C:\\proj");
        assert_eq!(sidecar.human_time, "2026-07-09 15:30:00");
    }

    #[test]
    fn sidecar_missing_fields_default_instead_of_failing() {
        let sidecar: ScheduleOnceSidecar = serde_json::from_str("{}").expect("must parse with all defaults");
        assert!(sidecar.task_name.is_empty());
        assert!(sidecar.human_time.is_empty());
    }

    #[test]
    fn list_external_jobs_returns_empty_when_dir_missing() {
        // No assertion on a real ClaudeScheduleOnce dir existing - this just
        // proves the function never panics/errors when it doesn't.
        let _ = list_external_jobs();
    }
}
