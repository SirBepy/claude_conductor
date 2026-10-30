use crate::settings::paths;
use crate::skill_usage::store;
use crate::skill_usage::types::{InstalledSkill, SkillDetail, SkillUsageEvent, SkillUsageWeek};
use crate::slash::{enumerate, SlashSource};
use crate::state::AppState;
use std::path::PathBuf;
use tauri::State;

fn today_utc() -> String {
    chrono::Utc::now().format("%Y-%m-%d").to_string()
}

/// Unix-second cutoff for the 7-day window ending today (start of the oldest
/// day). Skill events with `timestamp >= cutoff` belong to the window. `0` if
/// the date math fails, which just widens the window harmlessly.
fn week_cutoff_unix() -> i64 {
    let today = today_utc();
    store::week_cutoff_day(&today)
        .map(|day| format!("{day}T00:00:00Z"))
        .and_then(|s| crate::storage::usage_store::rfc3339_to_unix(&s).ok())
        .unwrap_or(0)
}

/// Loads the window's skill events from the SQLite store (the daemon now writes
/// there; the per-day JSONL files are legacy). `total_sessions` still derives
/// from the file-based `mark_session` markers, which have no DB equivalent.
#[tauri::command]
pub async fn get_skill_usage_week(state: State<'_, AppState>) -> Result<SkillUsageWeek, String> {
    let cutoff = week_cutoff_unix();
    let events: Vec<SkillUsageEvent> = {
        let mgr = state.db.lock().unwrap();
        store::get_skill_events_from_db(mgr.conn(), cutoff).map_err(|e| e.to_string())?
    };
    tauri::async_runtime::spawn_blocking(move || {
        let dir = paths::skill_usage_dir().map_err(|e| e.to_string())?;
        let sessions = store::week_sessions(&dir, &today_utc());
        Ok(store::aggregate_week(&events, &sessions))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn get_skill_usage_detail(
    state: State<'_, AppState>,
    skill: String,
) -> Result<SkillDetail, String> {
    let cutoff = week_cutoff_unix();
    let events: Vec<SkillUsageEvent> = {
        let mgr = state.db.lock().unwrap();
        store::get_skill_events_from_db(mgr.conn(), cutoff).map_err(|e| e.to_string())?
    };
    tauri::async_runtime::spawn_blocking(move || {
        Ok(store::aggregate_detail(&events, &skill))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Lists every skill installed on disk under `~/.claude/skills/`,
/// `~/.claude/plugins/cache/<plugin>/<version>/skills/`, and each known
/// project's `<project>/.claude/skills/`. Plugin skills get keyed as
/// `<plugin>:<skill>` to match what the Skill tool emits.
#[tauri::command]
pub async fn list_installed_skills(state: State<'_, AppState>) -> Result<Vec<InstalledSkill>, String> {
    let project_paths: Vec<PathBuf> = state
        .settings
        .lock()
        .unwrap()
        .projects
        .iter()
        .map(|p| p.path.clone())
        .collect();
    tauri::async_runtime::spawn_blocking(move || {
        let project_refs: Vec<&std::path::Path> = project_paths.iter().map(|p| p.as_path()).collect();
        let entries = enumerate::scan_all_multi(&project_refs);
        let mut out: Vec<InstalledSkill> = entries
            .into_iter()
            .filter_map(|e| match e.source {
                SlashSource::UserSkill => Some(InstalledSkill {
                    skill: e.name,
                    description: e.description,
                    plugin: None,
                    project: None,
                    scope_key: e.scope_key,
                }),
                SlashSource::PluginSkill { plugin } => Some(InstalledSkill {
                    skill: format!("{plugin}:{}", e.name),
                    description: e.description,
                    plugin: Some(plugin),
                    project: None,
                    scope_key: e.scope_key,
                }),
                SlashSource::ProjectSkill { project } => Some(InstalledSkill {
                    skill: e.name,
                    description: e.description,
                    plugin: None,
                    project: Some(project),
                    scope_key: None,
                }),
                _ => None,
            })
            .collect();
        out.sort_by(|a, b| a.skill.to_lowercase().cmp(&b.skill.to_lowercase()));
        Ok::<Vec<InstalledSkill>, String>(out)
    })
    .await
    .map_err(|e| e.to_string())?
}
