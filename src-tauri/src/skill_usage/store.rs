use crate::skill_usage::types::{
    DayRuns, InvocationCounts, InvocationSource, SkillDetail, SkillUsageEntry, SkillUsageEvent,
    SkillUsageWeek, TokenBreakdown,
};
use std::collections::{BTreeSet, HashMap};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

/// Loads skill events from the consolidated SQLite store with `timestamp >=
/// since` (unix seconds), uncapped. The daemon now writes events here; this is
/// the read path that the IPC layer feeds into [`aggregate_week`] /
/// [`aggregate_detail`].
pub fn get_skill_events_from_db(
    conn: &rusqlite::Connection,
    since: i64,
) -> anyhow::Result<Vec<SkillUsageEvent>> {
    crate::storage::skill_store::get_skill_events(conn, since, -1)
}

fn day_of(ts: &str) -> &str {
    ts.split('T').next().unwrap_or(ts)
}

fn events_path(dir: &Path, day: &str) -> PathBuf {
    dir.join(format!("events-{day}.jsonl"))
}

fn sessions_path(dir: &Path, day: &str) -> PathBuf {
    dir.join(format!("sessions-{day}.json"))
}

pub fn append_events(dir: &Path, events: &[SkillUsageEvent]) -> std::io::Result<()> {
    if events.is_empty() {
        return Ok(());
    }
    std::fs::create_dir_all(dir)?;
    let mut by_day: HashMap<String, Vec<&SkillUsageEvent>> = HashMap::new();
    for e in events {
        by_day.entry(day_of(&e.ts).to_string()).or_default().push(e);
    }
    for (day, evs) in by_day {
        let path = events_path(dir, &day);
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)?;
        for e in evs {
            let line = serde_json::to_string(e).unwrap();
            writeln!(f, "{line}")?;
        }
    }
    Ok(())
}

pub fn mark_session(dir: &Path, session_id: &str, day: &str) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let path = sessions_path(dir, day);
    let mut set: BTreeSet<String> = if path.exists() {
        let raw = std::fs::read_to_string(&path)?;
        serde_json::from_str::<serde_json::Value>(&raw)
            .ok()
            .and_then(|v| v.get("session_ids").cloned())
            .and_then(|v| v.as_array().cloned())
            .map(|arr| {
                arr.into_iter()
                    .filter_map(|s| s.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default()
    } else {
        BTreeSet::new()
    };
    set.insert(session_id.to_string());
    let payload = serde_json::json!({
        "day": day,
        "session_ids": set.iter().collect::<Vec<_>>(),
    });
    crate::util::write_json_atomic(&path, &serde_json::to_string_pretty(&payload).unwrap())?;
    Ok(())
}

fn last_n_days(today: &str, n: i64) -> Vec<String> {
    let Ok(end) = chrono::NaiveDate::parse_from_str(today, "%Y-%m-%d") else {
        return vec![];
    };
    (0..n)
        .map(|i| {
            (end - chrono::Duration::days(i))
                .format("%Y-%m-%d")
                .to_string()
        })
        .collect()
}

fn read_events_for_day(dir: &Path, day: &str) -> Vec<SkillUsageEvent> {
    let path = events_path(dir, day);
    let Ok(file) = std::fs::File::open(&path) else {
        return vec![];
    };
    BufReader::new(file)
        .lines()
        .map_while(Result::ok)
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str::<SkillUsageEvent>(&l).ok())
        .collect()
}

fn read_sessions_for_day(dir: &Path, day: &str) -> BTreeSet<String> {
    let path = sessions_path(dir, day);
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return BTreeSet::new();
    };
    serde_json::from_str::<serde_json::Value>(&raw)
        .ok()
        .and_then(|v| v.get("session_ids").cloned())
        .and_then(|v| v.as_array().cloned())
        .map(|arr| {
            arr.into_iter()
                .filter_map(|s| s.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default()
}

pub fn get_week(dir: &Path, today: &str) -> SkillUsageWeek {
    let days = last_n_days(today, 7);
    let mut events: Vec<SkillUsageEvent> = Vec::new();
    let mut all_sessions: BTreeSet<String> = BTreeSet::new();
    for d in &days {
        all_sessions.extend(read_sessions_for_day(dir, d));
        events.extend(read_events_for_day(dir, d));
    }
    aggregate_week(&events, &all_sessions)
}

/// Cutoff (RFC3339, day granularity) for the 7-day window ending at `today`.
/// The oldest of the seven `last_n_days` entries, used to filter DB events.
pub fn week_cutoff_day(today: &str) -> Option<String> {
    last_n_days(today, 7).into_iter().min()
}

/// Aggregate a flat list of events plus a set of "active" session ids into the
/// weekly summary. Source-agnostic: the file-backed [`get_week`] and the
/// DB-backed IPC path both funnel through here so the output shape stays
/// identical. `all_sessions` carries the per-session markers (sessions that ran
/// at all, even with zero skill events) so `total_sessions` is unaffected by
/// where the events came from.
pub fn aggregate_week(events: &[SkillUsageEvent], all_sessions: &BTreeSet<String>) -> SkillUsageWeek {
    let mut per_skill: HashMap<String, (InvocationCounts, BTreeSet<String>, TokenBreakdown)> =
        HashMap::new();
    for e in events {
        let entry = per_skill.entry(e.skill.clone()).or_default();
        entry.0.total += 1;
        match e.source {
            InvocationSource::Manual => entry.0.manual += 1,
            InvocationSource::Skill => entry.0.skill += 1,
            InvocationSource::Auto => entry.0.auto += 1,
        }
        entry.1.insert(e.session_id.clone());
        entry.2.input += e.tokens.input;
        entry.2.output += e.tokens.output;
        entry.2.cache_read += e.tokens.cache_read;
        entry.2.cache_create += e.tokens.cache_create;
    }
    let mut entries: Vec<SkillUsageEntry> = per_skill
        .into_iter()
        .map(|(skill, (invocations, chats, tokens))| SkillUsageEntry {
            skill,
            invocations,
            chats: chats.len() as u32,
            tokens,
        })
        .collect();
    entries.sort_by(|a, b| b.tokens.total().cmp(&a.tokens.total()));
    SkillUsageWeek {
        entries,
        total_sessions: all_sessions.len() as u32,
    }
}

/// Session markers (the `mark_session` files) for the 7-day window. The DB has
/// no per-session marker, so `total_sessions` still derives from these files.
pub fn week_sessions(dir: &Path, today: &str) -> BTreeSet<String> {
    let mut all: BTreeSet<String> = BTreeSet::new();
    for d in last_n_days(today, 7) {
        all.extend(read_sessions_for_day(dir, &d));
    }
    all
}

pub fn get_detail(dir: &Path, today: &str, skill: &str) -> SkillDetail {
    let days = last_n_days(today, 7);
    let events: Vec<SkillUsageEvent> = days
        .iter()
        .flat_map(|d| read_events_for_day(dir, d))
        .collect();
    aggregate_detail(&events, skill)
}

/// Runs per day (in `tz`'s calendar) for the named skills, built from the same
/// per-skill event set `aggregate_detail` returns, so the Home chart's numbers
/// match the per-skill detail exactly. Days are ascending; an event whose `ts`
/// does not parse is dropped, as the chart's own bucketing does.
pub fn aggregate_runs_per_day<Tz: chrono::TimeZone>(
    events: &[SkillUsageEvent],
    skills: &[String],
    tz: &Tz,
) -> Vec<DayRuns>
where
    Tz::Offset: std::fmt::Display,
{
    let mut by_day: std::collections::BTreeMap<String, u32> = std::collections::BTreeMap::new();
    for skill in skills {
        for e in aggregate_detail(events, skill).events {
            let Ok(t) = chrono::DateTime::parse_from_rfc3339(&e.ts) else { continue };
            let day = t.with_timezone(tz).format("%Y-%m-%d").to_string();
            *by_day.entry(day).or_insert(0) += 1;
        }
    }
    by_day.into_iter().map(|(day, runs)| DayRuns { day, runs }).collect()
}

/// Filter a flat event list to one skill and tally invocation counts. The
/// file-backed [`get_detail`] and the DB-backed IPC path share this so the
/// output shape stays identical.
pub fn aggregate_detail(events: &[SkillUsageEvent], skill: &str) -> SkillDetail {
    let mut events: Vec<SkillUsageEvent> =
        events.iter().filter(|e| e.skill == skill).cloned().collect();
    events.sort_by(|a, b| b.ts.cmp(&a.ts));
    let mut counts = InvocationCounts::default();
    for e in &events {
        counts.total += 1;
        match e.source {
            InvocationSource::Manual => counts.manual += 1,
            InvocationSource::Skill => counts.skill += 1,
            InvocationSource::Auto => counts.auto += 1,
        }
    }
    SkillDetail {
        skill: skill.to_string(),
        invocations: counts,
        events,
    }
}

#[cfg(test)]
mod runs_per_day_tests {
    use super::*;
    use chrono::FixedOffset;

    fn ev(skill: &str, ts: &str) -> SkillUsageEvent {
        SkillUsageEvent {
            ts: ts.into(),
            skill: skill.into(),
            session_id: "s".into(),
            project: "p".into(),
            source: InvocationSource::Manual,
            tokens: TokenBreakdown::default(),
        }
    }

    #[test]
    fn runs_per_day_equals_per_skill_detail_summed_per_day() {
        // +02:00 puts 23:30Z on the next local day, so the zone is exercised.
        let tz = FixedOffset::east_opt(2 * 3600).unwrap();
        let events = vec![
            ev("a", "2026-11-10T10:00:00Z"),
            ev("a", "2026-11-10T23:30:00Z"),
            ev("b", "2026-11-10T11:00:00Z"),
            ev("b", "2026-11-11T09:00:00Z"),
            ev("c", "2026-11-11T09:00:00Z"),
            ev("a", "garbage"),
        ];
        let skills = vec!["a".to_string(), "b".to_string()];
        let got = aggregate_runs_per_day(&events, &skills, &tz);

        let mut want: std::collections::BTreeMap<String, u32> = Default::default();
        for s in &skills {
            for e in aggregate_detail(&events, s).events {
                if let Ok(t) = chrono::DateTime::parse_from_rfc3339(&e.ts) {
                    *want.entry(t.with_timezone(&tz).format("%Y-%m-%d").to_string()).or_default() += 1;
                }
            }
        }
        let want: Vec<DayRuns> = want.into_iter().map(|(day, runs)| DayRuns { day, runs }).collect();
        assert_eq!(got, want);
        assert_eq!(
            got,
            vec![
                DayRuns { day: "2026-11-10".into(), runs: 2 },
                DayRuns { day: "2026-11-11".into(), runs: 2 },
            ]
        );
    }
}
