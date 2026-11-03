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

/// Unix-second cutoff for the 7-day window ending today: local midnight of the
/// oldest day, matching the dashboard charts that bucket by local day. A UTC
/// midnight would cut the first hours off the oldest bar for anyone ahead of
/// UTC. Skill events with `timestamp >= cutoff` belong to the window. `0` if the
/// date math fails, which just widens the window harmlessly.
fn week_cutoff_unix() -> i64 {
    week_cutoff_at(chrono::Local::now()).unwrap_or(0)
}

/// `week_cutoff_unix` for an explicit "now", generic over the zone so a test
/// can pin an offset instead of depending on the machine's own.
fn week_cutoff_at<Tz: chrono::TimeZone>(now: chrono::DateTime<Tz>) -> Option<i64> {
    let oldest = now.date_naive().checked_sub_days(chrono::Days::new(6))?;
    let midnight = oldest.and_hms_opt(0, 0, 0)?;
    // `earliest` picks the first instant when a DST fold repeats midnight.
    let start = midnight.and_local_timezone(now.timezone()).earliest()?;
    Some(start.timestamp())
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

#[cfg(test)]
mod tests {
    use super::week_cutoff_at;
    use chrono::{FixedOffset, TimeZone};

    #[test]
    fn week_cutoff_is_local_midnight_six_days_back() {
        // 00:30 on 2026-11-03 in UTC+1 is still 2026-11-02 in UTC; the window's
        // oldest local day is 2026-10-28, which began at 2026-10-27T23:00Z.
        let plus1 = FixedOffset::east_opt(3600).unwrap();
        let now = plus1.with_ymd_and_hms(2026, 11, 3, 0, 30, 0).unwrap();
        let expect = chrono::Utc.with_ymd_and_hms(2026, 10, 27, 23, 0, 0).unwrap().timestamp();
        assert_eq!(week_cutoff_at(now), Some(expect));

        // Behind UTC the local midnight is later than the UTC one.
        let minus8 = FixedOffset::west_opt(8 * 3600).unwrap();
        let now = minus8.with_ymd_and_hms(2026, 11, 3, 20, 0, 0).unwrap();
        let expect = chrono::Utc.with_ymd_and_hms(2026, 10, 28, 8, 0, 0).unwrap().timestamp();
        assert_eq!(week_cutoff_at(now), Some(expect));
    }
}
