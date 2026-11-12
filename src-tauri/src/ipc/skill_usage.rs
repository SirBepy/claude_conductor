use crate::settings::paths;
use crate::skill_usage::store;
use crate::skill_usage::types::{DayRuns, InstalledSkill, SkillDetail, SkillUsageEvent, SkillUsageWeek};
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
/// UTC. Skill events with `timestamp >= cutoff` belong to the window. `0` only if
/// the date arithmetic overflows, and 0 means all-time, so it must stay
/// unreachable for any real date.
fn week_cutoff_unix() -> i64 {
    week_cutoff_at(chrono::Local::now()).unwrap_or(0)
}

/// The longest local-midnight gap searched past, in 15-minute steps: a skipped
/// whole day (Samoa, 2011) plus the quarter-hour offsets some zones use.
const GAP_SEARCH_STEPS: i64 = 4 * 25;

/// `week_cutoff_unix` for an explicit "now", generic over the zone so a test
/// can pin an offset instead of depending on the machine's own.
fn week_cutoff_at<Tz: chrono::TimeZone>(now: chrono::DateTime<Tz>) -> Option<i64> {
    let oldest = now.date_naive().checked_sub_days(chrono::Days::new(6))?;
    let midnight = oldest.and_hms_opt(0, 0, 0)?;
    // A zone that springs forward at midnight (Chile in September, Lebanon,
    // Cuba) has no local 00:00 that day, so the window starts at the first local
    // time that exists. `earliest` picks the first instant when a fold repeats it.
    let start = (0..=GAP_SEARCH_STEPS).find_map(|step| {
        let candidate = midnight.checked_add_signed(chrono::Duration::minutes(15 * step))?;
        candidate.and_local_timezone(now.timezone()).earliest()
    })?;
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

/// Per-local-day run counts for the given skills over the 7-day window, in one
/// read. The Home "Skill runs per day" chart used to call
/// `get_skill_usage_detail` once per skill just to bucket timestamps.
#[tauri::command]
pub async fn get_skill_runs_per_day(
    state: State<'_, AppState>,
    skills: Vec<String>,
) -> Result<Vec<DayRuns>, String> {
    let cutoff = week_cutoff_unix();
    let events: Vec<SkillUsageEvent> = {
        let mgr = state.db.lock().unwrap();
        store::get_skill_events_from_db(mgr.conn(), cutoff).map_err(|e| e.to_string())?
    };
    tauri::async_runtime::spawn_blocking(move || {
        Ok(store::aggregate_runs_per_day(&events, &skills, &chrono::Local))
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
    use chrono::{FixedOffset, Offset, TimeZone};

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

    /// A zone whose spring-forward lands on local midnight, like Chile's
    /// September change: at 04:00Z on 2026-09-06 clocks jump from 00:00 (UTC-4)
    /// to 01:00 (UTC-3), so local 00:00..01:00 that day does not exist. chrono-tz
    /// is not a dependency, so the one rule the test needs is spelled out.
    #[derive(Clone, Copy, Debug)]
    struct MidnightGapZone;

    #[derive(Clone, Copy, Debug)]
    struct GapOffset(i32);

    impl Offset for GapOffset {
        fn fix(&self) -> FixedOffset {
            FixedOffset::east_opt(self.0).unwrap()
        }
    }

    const BEFORE: i32 = -4 * 3600;
    const AFTER: i32 = -3 * 3600;

    fn jump() -> chrono::NaiveDateTime {
        chrono::NaiveDate::from_ymd_opt(2026, 9, 6).unwrap().and_hms_opt(4, 0, 0).unwrap()
    }

    impl TimeZone for MidnightGapZone {
        type Offset = GapOffset;

        fn from_offset(_: &GapOffset) -> Self {
            MidnightGapZone
        }

        fn offset_from_local_date(&self, local: &chrono::NaiveDate) -> chrono::LocalResult<GapOffset> {
            self.offset_from_local_datetime(&local.and_hms_opt(12, 0, 0).unwrap())
        }

        fn offset_from_local_datetime(
            &self,
            local: &chrono::NaiveDateTime,
        ) -> chrono::LocalResult<GapOffset> {
            let as_before = *local - chrono::Duration::seconds(i64::from(BEFORE));
            let as_after = *local - chrono::Duration::seconds(i64::from(AFTER));
            match (as_before < jump(), as_after >= jump()) {
                (true, true) => chrono::LocalResult::Ambiguous(GapOffset(BEFORE), GapOffset(AFTER)),
                (true, false) => chrono::LocalResult::Single(GapOffset(BEFORE)),
                (false, true) => chrono::LocalResult::Single(GapOffset(AFTER)),
                (false, false) => chrono::LocalResult::None,
            }
        }

        fn offset_from_utc_date(&self, utc: &chrono::NaiveDate) -> GapOffset {
            self.offset_from_utc_datetime(&utc.and_hms_opt(0, 0, 0).unwrap())
        }

        fn offset_from_utc_datetime(&self, utc: &chrono::NaiveDateTime) -> GapOffset {
            GapOffset(if *utc < jump() { BEFORE } else { AFTER })
        }
    }

    // `None` here used to fall through to `unwrap_or(0)`, which made the skill
    // window all-time. The window's start is the first local instant that exists
    // on its oldest day.
    #[test]
    fn week_cutoff_survives_a_local_midnight_that_does_not_exist() {
        let now = MidnightGapZone.with_ymd_and_hms(2026, 9, 12, 12, 0, 0).unwrap();
        let expect = chrono::Utc.with_ymd_and_hms(2026, 9, 6, 4, 0, 0).unwrap().timestamp();
        assert_eq!(week_cutoff_at(now), Some(expect));
    }
}
