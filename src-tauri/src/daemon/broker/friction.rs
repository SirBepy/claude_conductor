//! The friction counter: how often the broker refused a chat something Joe could fix,
//! per day, read back from `broker-audit.jsonl` (the audit log is the only store, nothing
//! is kept in memory, so the counts survive a daemon restart and a rotated file just starts
//! over).
//!
//! **What counts.** A line whose `outcome` is `denied_policy`, `denied_owner` or
//! `denied_scope`: each is a call a policy row, an owned object or a binding line would have
//! let through, so each costs Joe a card or an edit. `denied_guard` (an absolute path, a path or
//! query the guards refuse, an unknown service, a method that is no read) is a malformed call no row can allow, so it is
//! reported beside the count and never in it. `upstream_error`, `no_secret`, `error` and the
//! `CARD` lines are not denials.
//!
//! The count is by outcome, not by reason: a `denied_owner` that came from a failed owner lookup
//! (the service was down) or a `denied_scope` for a call with no scope at all (a front wiring bug)
//! counts although no row or binding would fix it. The day's audit lines carry the `reason`.
//!
//! **The target.** [`TARGET_PER_DAY`] friction denials or fewer per day, from day
//! [`TARGET_DAY`] on, where day 1 is the UTC date of the first line in the audit log. The
//! plan (docs/api-broker-plan.md, step 8) sets it; a day over target means a missing policy
//! row, a missing binding or a chat that keeps asking for something it should not, and the
//! audit lines of that day name which.
//!
//! Days are UTC dates (the audit `ts` is UTC), so the day turns over at 01:00 or 02:00 in
//! Croatia, not at midnight.

use chrono::NaiveDate;
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::io::BufRead;
use std::path::Path;

/// Friction denials per day the broker should stay at or under once it has run [`TARGET_DAY`] days.
pub const TARGET_PER_DAY: usize = 2;
/// The day number (1 = the first day with an audit line) from which [`TARGET_PER_DAY`] applies.
pub const TARGET_DAY: u32 = 7;
/// The outcomes that count toward the target.
pub const FRICTION_OUTCOMES: [&str; 3] = ["denied_policy", "denied_owner", "denied_scope"];
const GUARD_OUTCOME: &str = "denied_guard";
/// The most days one report holds, so a bad `days` argument cannot build a huge list.
pub const MAX_WINDOW_DAYS: usize = 90;

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize)]
pub struct Day {
    /// `YYYY-MM-DD`, UTC.
    pub date: String,
    /// Broker calls that day (`CARD` lines are not calls).
    pub calls: usize,
    /// Denials that count toward the target.
    pub friction: usize,
    /// `friction` split by outcome (only outcomes seen that day).
    pub by_outcome: BTreeMap<String, usize>,
    /// `denied_guard` lines, reported but not counted.
    pub guard_denials: usize,
    /// `friction > TARGET_PER_DAY`, whatever the day number: read it with `Report::target_due`.
    pub over_target: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Report {
    pub target_per_day: usize,
    pub target_day: u32,
    /// The date the report was cut for.
    pub today: String,
    /// The UTC date of the first line in the audit log, if there is one.
    pub first_day: Option<String>,
    /// 1 on `first_day`, counting up; `None` with no audit lines.
    pub day_number: Option<u32>,
    /// True once `day_number` has reached `target_day`.
    pub target_due: bool,
    pub today_friction: usize,
    /// `today_friction <= target_per_day`, whatever the day number (before `target_due` the target does
    /// not apply yet). Today is still open, so this can turn false later in the day.
    pub within_target: bool,
    /// Oldest first, one entry per date up to today, zero days included.
    pub days: Vec<Day>,
    /// Lines that were not JSON or had no readable date (a half-written last line, say), left out.
    pub skipped_lines: usize,
}

fn date_of(ts: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(ts.get(..10)?, "%Y-%m-%d").ok()
}

/// Reads the audit log at `path` and cuts a report for `today`, listing the last `window_days` days
/// (1 to [`MAX_WINDOW_DAYS`]). A missing file is an empty report, not an error.
pub fn report(path: &Path, today: NaiveDate, window_days: usize) -> Result<Report, String> {
    let window_days = window_days.clamp(1, MAX_WINDOW_DAYS);
    let first_listed = today - chrono::Days::new(window_days as u64 - 1);
    let mut days: BTreeMap<NaiveDate, Day> = BTreeMap::new();
    let mut first_day: Option<NaiveDate> = None;
    let mut skipped = 0usize;

    match std::fs::File::open(path) {
        Ok(f) => {
            for line in std::io::BufReader::new(f).lines() {
                let line = match line {
                    Ok(l) => l,
                    // A line that is not UTF-8 is as unreadable as one that is not JSON.
                    Err(e) if e.kind() == std::io::ErrorKind::InvalidData => {
                        skipped += 1;
                        continue;
                    }
                    // Any other read error repeats forever on the same handle (a directory opens on Unix and
                    // errors on every read), so stop and report what was read.
                    Err(_) => {
                        skipped += 1;
                        break;
                    }
                };
                if line.trim().is_empty() {
                    continue;
                }
                let parsed = serde_json::from_str::<Value>(&line).ok();
                let Some((v, date)) = parsed.as_ref().and_then(|v| Some((v, date_of(v["ts"].as_str()?)?))) else {
                    skipped += 1;
                    continue;
                };
                first_day = Some(first_day.map_or(date, |d| d.min(date)));
                if date < first_listed || date > today {
                    continue;
                }
                if v["method"] == "CARD" {
                    continue;
                }
                let day = days.entry(date).or_default();
                day.calls += 1;
                match v["outcome"].as_str() {
                    Some(o) if FRICTION_OUTCOMES.contains(&o) => {
                        day.friction += 1;
                        *day.by_outcome.entry(o.to_string()).or_default() += 1;
                    }
                    Some(GUARD_OUTCOME) => day.guard_denials += 1,
                    _ => {}
                }
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("cannot read the broker audit log: {e}")),
    }

    let listed: Vec<Day> = (0..window_days)
        .map(|i| first_listed + chrono::Days::new(i as u64))
        .map(|date| {
            let mut day = days.remove(&date).unwrap_or_default();
            day.date = date.to_string();
            day.over_target = day.friction > TARGET_PER_DAY;
            day
        })
        .collect();
    let today_friction = listed.last().map_or(0, |d| d.friction);
    // A first line dated after `today` (a clock set back) would make a negative day number.
    let day_number = first_day.map(|f| (today - f).num_days().max(0) as u32 + 1);
    Ok(Report {
        target_per_day: TARGET_PER_DAY,
        target_day: TARGET_DAY,
        today: today.to_string(),
        first_day: first_day.map(|d| d.to_string()),
        day_number,
        target_due: day_number.is_some_and(|n| n >= TARGET_DAY),
        today_friction,
        within_target: today_friction <= TARGET_PER_DAY,
        days: listed,
        skipped_lines: skipped,
    })
}

/// [`report`] for the current UTC date.
pub fn report_now(path: &Path, window_days: usize) -> Result<Report, String> {
    report(path, chrono::Utc::now().date_naive(), window_days)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::broker::audit::{AuditEntry, AuditLog};
    use serde_json::json;

    fn d(s: &str) -> NaiveDate {
        NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap()
    }

    fn line(ts: &str, method: &str, outcome: &str) -> String {
        json!({"ts": ts, "session": "s", "service": "shortcut", "method": method, "path": "/x", "outcome": outcome}).to_string()
    }

    fn write(dir: &tempfile::TempDir, lines: &[String]) -> std::path::PathBuf {
        let p = dir.path().join("broker-audit.jsonl");
        std::fs::write(&p, lines.join("\n") + "\n").unwrap();
        p
    }

    #[test]
    fn a_missing_audit_file_is_an_empty_report_within_target() {
        let dir = tempfile::tempdir().unwrap();
        let r = report(&dir.path().join("nope.jsonl"), d("2026-11-18"), 3).unwrap();
        assert_eq!((r.first_day, r.day_number, r.target_due, r.today_friction, r.within_target), (None, None, false, 0, true));
        assert_eq!(r.days.len(), 3);
        assert_eq!(r.days.iter().map(|x| x.date.as_str()).collect::<Vec<_>>(), ["2026-11-16", "2026-11-17", "2026-11-18"]);
        assert!(r.days.iter().all(|x| x.calls == 0 && x.friction == 0));
    }

    #[test]
    fn only_policy_owner_and_scope_denials_count_and_guard_denials_are_listed_apart() {
        let dir = tempfile::tempdir().unwrap();
        let t = "2026-11-18T10:00:00.000Z";
        let p = write(
            &dir,
            &[
                line(t, "GET", "ok"),
                line(t, "GET", "denied_policy"),
                line(t, "POST", "denied_policy"),
                line(t, "PUT", "denied_owner"),
                line(t, "GET", "denied_scope"),
                line(t, "GET", "denied_guard"),
                line(t, "GET", "upstream_error"),
                line(t, "GET", "no_secret"),
                line(t, "GET", "error"),
                line(t, "CARD", "card_policy"),
                line(t, "CARD", "card_declined"),
            ],
        );
        let r = report(&p, d("2026-11-18"), 1).unwrap();
        let day = &r.days[0];
        assert_eq!(day.friction, 4);
        assert_eq!(day.guard_denials, 1);
        assert_eq!(day.calls, 9, "the two CARD lines are events, not calls");
        assert_eq!(day.by_outcome, BTreeMap::from([("denied_owner".to_string(), 1), ("denied_policy".to_string(), 2), ("denied_scope".to_string(), 1)]));
        assert!(day.over_target && !r.within_target && r.today_friction == 4);
    }

    #[test]
    fn exactly_the_target_is_within_it_and_one_more_is_not() {
        let dir = tempfile::tempdir().unwrap();
        let t = "2026-11-18T10:00:00.000Z";
        let two = write(&dir, &[line(t, "GET", "denied_policy"), line(t, "GET", "denied_scope")]);
        assert!(report(&two, d("2026-11-18"), 1).unwrap().within_target);
        let three = write(&dir, &[line(t, "GET", "denied_policy"), line(t, "GET", "denied_scope"), line(t, "GET", "denied_owner")]);
        let r = report(&three, d("2026-11-18"), 1).unwrap();
        assert!(!r.within_target && r.days[0].over_target);
        assert_eq!((TARGET_PER_DAY, TARGET_DAY), (2, 7), "the plan's target: 2 or fewer per day by day 7");
    }

    #[test]
    fn days_are_utc_dates_with_zero_days_filled_and_old_days_left_out_of_the_window() {
        let dir = tempfile::tempdir().unwrap();
        let p = write(
            &dir,
            &[
                line("2026-11-10T23:59:59.999Z", "GET", "denied_policy"),
                line("2026-11-16T00:00:00.000Z", "GET", "denied_policy"),
                line("2026-11-16T23:59:59.999Z", "GET", "denied_policy"),
                line("2026-11-18T00:00:00.000Z", "GET", "denied_scope"),
                // A line from tomorrow (clock skew) belongs to no listed day.
                line("2026-11-19T00:00:01.000Z", "GET", "denied_scope"),
            ],
        );
        let r = report(&p, d("2026-11-18"), 3).unwrap();
        let counts: Vec<(&str, usize)> = r.days.iter().map(|x| (x.date.as_str(), x.friction)).collect();
        assert_eq!(counts, [("2026-11-16", 2), ("2026-11-17", 0), ("2026-11-18", 1)]);
        assert_eq!(r.today_friction, 1);
    }

    #[test]
    fn day_seven_is_the_seventh_date_counting_the_first_line_s_date_as_day_one() {
        let dir = tempfile::tempdir().unwrap();
        let p = write(&dir, &[line("2026-11-12T08:00:00.000Z", "GET", "ok")]);
        let at = |day: &str| report(&p, d(day), 1).unwrap();
        assert_eq!((at("2026-11-12").day_number, at("2026-11-12").target_due), (Some(1), false));
        assert_eq!((at("2026-11-17").day_number, at("2026-11-17").target_due), (Some(6), false));
        let seven = at("2026-11-18");
        assert_eq!((seven.day_number, seven.target_due, seven.first_day.as_deref()), (Some(7), true, Some("2026-11-12")));
        // The first line is found even when it is older than the listed window.
        assert_eq!(at("2026-12-01").day_number, Some(20));
        // A first line dated after today never gives a day number below 1.
        assert_eq!(report(&p, d("2026-11-01"), 1).unwrap().day_number, Some(1));
    }

    #[test]
    fn a_half_written_or_foreign_line_is_skipped_and_counted_not_fatal() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.jsonl");
        let mut text = line("2026-11-18T10:00:00.000Z", "GET", "denied_policy") + "\n";
        text += "{\"ts\":\"2026-11-18T10:00:0\n"; // a write cut off
        text += "not json at all\n{\"outcome\":\"denied_policy\"}\n\n";
        std::fs::write(&p, text).unwrap();
        let r = report(&p, d("2026-11-18"), 1).unwrap();
        assert_eq!((r.today_friction, r.skipped_lines), (1, 3));
    }

    #[test]
    fn the_window_is_clamped_to_at_least_one_day_and_at_most_the_cap() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("none.jsonl");
        assert_eq!(report(&p, d("2026-11-18"), 0).unwrap().days.len(), 1);
        assert_eq!(report(&p, d("2026-11-18"), 100_000).unwrap().days.len(), MAX_WINDOW_DAYS);
    }

    /// The counter must read what the engine really writes, not a hand-made line shape.
    #[test]
    fn it_reads_the_lines_the_audit_log_writes() {
        let dir = tempfile::tempdir().unwrap();
        let log = AuditLog::new(dir.path().join("broker-audit.jsonl"));
        let entry = |outcome: &'static str, method: &str| AuditEntry {
            session: "s".into(),
            service: "shortcut".into(),
            method: method.into(),
            path: "/api/v3/stories/1".into(),
            status: None,
            outcome,
            reason: None,
            req_bytes: 0,
            resp_bytes: 0,
            unmasked: false,
        };
        for (o, m) in [("denied_policy", "POST"), ("denied_owner", "PUT"), ("ok", "GET"), ("card_policy", "CARD")] {
            log.record(&entry(o, m)).unwrap();
        }
        let r = report_now(log.path(), 2).unwrap();
        assert_eq!((r.today_friction, r.days.last().unwrap().calls, r.day_number), (2, 3, Some(1)));
    }

    #[test]
    fn a_report_serializes_with_the_field_names_the_method_documents() {
        let dir = tempfile::tempdir().unwrap();
        let v = serde_json::to_value(report(&dir.path().join("x"), d("2026-11-18"), 1).unwrap()).unwrap();
        for k in ["target_per_day", "target_day", "today", "first_day", "day_number", "target_due", "today_friction", "within_target", "days", "skipped_lines"] {
            assert!(v.get(k).is_some(), "missing {k}: {v}");
        }
        assert_eq!(v["target_per_day"], json!(2));
        assert_eq!(v["target_day"], json!(7));
    }
}
