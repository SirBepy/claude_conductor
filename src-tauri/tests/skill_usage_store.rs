use claude_conductor_lib::skill_usage::store;
use claude_conductor_lib::skill_usage::types::{
    InvocationSource, SkillUsageEvent, TokenBreakdown,
};

fn ev(day: &str, skill: &str, session: &str, source: InvocationSource, total: u64) -> SkillUsageEvent {
    SkillUsageEvent {
        ts: format!("{day}T12:00:00Z"),
        skill: skill.to_string(),
        session_id: session.to_string(),
        project: "proj".into(),
        source,
        tokens: TokenBreakdown { input: total, output: 0, cache_read: 0, cache_create: 0 },
    }
}

#[test]
fn append_then_get_detail_roundtrips() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    let e1 = ev("2026-05-11", "commit", "s1", InvocationSource::Manual, 100);
    let e2 = ev("2026-05-11", "commit", "s2", InvocationSource::Auto, 200);
    store::append_events(dir, &[e1, e2]).unwrap();
    let detail = store::get_detail(dir, "2026-05-11", "commit");
    assert_eq!(detail.events.len(), 2);
    assert_eq!(detail.invocations.total, 2);
    assert_eq!(detail.invocations.manual, 1);
    assert_eq!(detail.invocations.auto, 1);
}

#[test]
fn mark_session_dedupes() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    store::mark_session(dir, "s1", "2026-05-11").unwrap();
    store::mark_session(dir, "s1", "2026-05-11").unwrap();
    store::mark_session(dir, "s2", "2026-05-11").unwrap();
    let week = store::get_week(dir, "2026-05-11");
    assert_eq!(week.total_sessions, 2);
}

#[test]
fn get_week_aggregates_across_days() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    store::append_events(dir, &[
        ev("2026-05-09", "commit", "s1", InvocationSource::Manual, 100),
        ev("2026-05-10", "commit", "s2", InvocationSource::Skill, 200),
        ev("2026-05-11", "rate-it", "s3", InvocationSource::Auto, 50),
    ]).unwrap();
    for (sid, day) in [("s1","2026-05-09"),("s2","2026-05-10"),("s3","2026-05-11")] {
        store::mark_session(dir, sid, day).unwrap();
    }
    let week = store::get_week(dir, "2026-05-11");
    assert_eq!(week.total_sessions, 3);
    let commit = week.entries.iter().find(|e| e.skill == "commit").unwrap();
    assert_eq!(commit.invocations.total, 2);
    assert_eq!(commit.chats, 2);
    assert_eq!(commit.tokens.total(), 300);
    let rate = week.entries.iter().find(|e| e.skill == "rate-it").unwrap();
    assert_eq!(rate.invocations.total, 1);
}

#[test]
fn get_week_excludes_old_days() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    store::append_events(dir, &[
        ev("2026-05-03", "old-skill", "s0", InvocationSource::Manual, 999),
        ev("2026-05-11", "new-skill", "s1", InvocationSource::Manual, 10),
    ]).unwrap();
    let week = store::get_week(dir, "2026-05-11");
    assert!(week.entries.iter().all(|e| e.skill != "old-skill"));
    assert!(week.entries.iter().any(|e| e.skill == "new-skill"));
}

#[test]
fn get_detail_groups_by_skill_only() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    store::append_events(dir, &[
        ev("2026-05-10", "commit", "s1", InvocationSource::Manual, 100),
        ev("2026-05-11", "rate-it", "s1", InvocationSource::Manual, 50),
        ev("2026-05-11", "commit", "s2", InvocationSource::Auto, 200),
    ]).unwrap();
    let detail = store::get_detail(dir, "2026-05-11", "commit");
    assert_eq!(detail.events.len(), 2);
    assert!(detail.events.iter().all(|e| e.skill == "commit"));
}

/// A session marked at 23:30 local time in a zone behind UTC belongs to that local
/// day, which the UTC date has already left: the writer and the reader must agree on
/// the local one or `total_sessions` and the events cover different windows.
#[test]
fn a_session_marked_late_in_a_zone_behind_utc_is_counted_on_its_local_day() {
    use chrono::TimeZone;
    let behind = chrono::FixedOffset::west_opt(5 * 3600).unwrap();
    let late = behind.with_ymd_and_hms(2026, 5, 11, 23, 30, 0).unwrap();
    assert_eq!(late.with_timezone(&chrono::Utc).format("%Y-%m-%d").to_string(), "2026-05-12", "the UTC date has moved on");
    let day = store::day_of_now(&late);
    assert_eq!(day, "2026-05-11");

    let tmp = tempfile::tempdir().unwrap();
    store::mark_session(tmp.path(), "s1", &day).unwrap();
    // Six days on the local day is still in the 7-day window; seven days on it has left it.
    assert!(store::week_sessions(tmp.path(), "2026-05-17").contains("s1"));
    assert!(!store::week_sessions(tmp.path(), "2026-05-18").contains("s1"));
}
