//! Free-text time and repeat-rule parsing for the `schedule` tool's `add`,
//! split out of the parent module (todo 1011) because both halves share the
//! Local/Utc conversion and neither touches the store: pure functions the
//! parent's `build_item` calls, easy to unit-test without
//! `scheduled-items.json`.

use chrono::{DateTime, Datelike, Local, NaiveDateTime, TimeZone, Utc};
use crate::sessions::scheduled_items::{Recurrence, RecurrenceRule};

/// Exactly one of `in_minutes` / `at`. `in_minutes` is the form the tool
/// description steers toward, because a model reliably knows "20 minutes from
/// now" and does not reliably know the current wall-clock time; `at` is
/// resolved in LOCAL time, matching `recurrence::next_occurrence` and what
/// the Schedule panel displays.
pub(super) fn resolve_fire_at(
    in_minutes: Option<i64>,
    at: Option<&str>,
    now: DateTime<Utc>,
) -> Result<DateTime<Utc>, String> {
    match (in_minutes, at.map(str::trim).filter(|s| !s.is_empty())) {
        (Some(_), Some(_)) => Err("pass either in_minutes or at, not both".to_string()),
        (None, None) => Err("add needs in_minutes or at".to_string()),
        (Some(mins), None) => {
            if mins < 1 {
                return Err("in_minutes must be at least 1".to_string());
            }
            Ok(now + chrono::Duration::minutes(mins))
        }
        (None, Some(text)) => {
            let naive = parse_local_stamp(text)
                .ok_or_else(|| format!("could not read {text:?} as a local YYYY-MM-DDTHH:MM"))?;
            // Ambiguous (DST fall-back) picks the earliest, matching
            // `recurrence::local_at`; a nonexistent local time (spring-forward
            // gap) is a real error here rather than a silent nudge, since the
            // user named this exact minute.
            let local = match Local.from_local_datetime(&naive) {
                chrono::LocalResult::Single(dt) => dt,
                chrono::LocalResult::Ambiguous(earliest, _) => earliest,
                chrono::LocalResult::None => {
                    return Err(format!("{text:?} does not exist in the local timezone (DST gap)"))
                }
            };
            let utc = local.with_timezone(&Utc);
            if utc <= now {
                return Err(format!("{text:?} is in the past"));
            }
            Ok(utc)
        }
    }
}

fn parse_local_stamp(text: &str) -> Option<NaiveDateTime> {
    for fmt in ["%Y-%m-%dT%H:%M", "%Y-%m-%d %H:%M", "%Y-%m-%dT%H:%M:%S"] {
        if let Ok(dt) = NaiveDateTime::parse_from_str(text, fmt) {
            return Some(dt);
        }
    }
    None
}

/// `repeat` -> the store's `Recurrence`. The time-of-day comes from the first
/// fire rather than a separate argument, so "in 90 minutes, every day" cannot
/// disagree with itself.
pub(super) fn resolve_recurrence(
    repeat: Option<&str>,
    fire_at: DateTime<Utc>,
) -> Result<Option<Recurrence>, String> {
    let Some(raw) = repeat.map(str::trim).filter(|r| !r.is_empty()) else {
        return Ok(None);
    };
    let local = fire_at.with_timezone(&Local);
    let time = local.format("%H:%M").to_string();
    let lowered = raw.to_ascii_lowercase();
    let rule = match lowered.as_str() {
        "daily" | "day" | "every-day" => RecurrenceRule::Daily,
        // 0=Mon..6=Sun, per `RecurrenceRule::Weekly`'s own doc comment.
        "weekdays" | "weekday" => RecurrenceRule::Weekly { weekdays: vec![0, 1, 2, 3, 4] },
        "weekly" | "week" => RecurrenceRule::Weekly {
            weekdays: vec![local.weekday().num_days_from_monday() as u8],
        },
        other => {
            let n = other
                .strip_prefix("every-")
                .and_then(|rest| rest.strip_suffix("-days").or_else(|| rest.strip_suffix("-day")))
                .and_then(|n| n.parse::<u32>().ok())
                .filter(|n| *n >= 1)
                .ok_or_else(|| {
                    format!("unknown repeat {raw:?}; expected daily, weekdays, weekly or every-N-days")
                })?;
            RecurrenceRule::EveryNDays { n }
        }
    };
    Ok(Some(Recurrence { time, rule }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn utc(s: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(s).unwrap().with_timezone(&Utc)
    }

    #[test]
    fn relative_offset_lands_that_many_minutes_out() {
        let now = utc("2026-01-05T10:00:00Z");
        let got = resolve_fire_at(Some(90), None, now).unwrap();
        assert_eq!(got, utc("2026-01-05T11:30:00Z"));
    }

    #[test]
    fn both_time_forms_at_once_is_an_error() {
        let now = utc("2026-01-05T10:00:00Z");
        assert!(resolve_fire_at(Some(5), Some("2026-01-06T09:00"), now).is_err());
    }

    #[test]
    fn neither_time_form_is_an_error() {
        let now = utc("2026-01-05T10:00:00Z");
        assert!(resolve_fire_at(None, None, now).is_err());
        assert!(resolve_fire_at(None, Some("   "), now).is_err());
    }

    #[test]
    fn a_zero_or_negative_offset_is_refused() {
        let now = utc("2026-01-05T10:00:00Z");
        assert!(resolve_fire_at(Some(0), None, now).is_err());
        assert!(resolve_fire_at(Some(-30), None, now).is_err());
    }

    /// The whole reason `at` is second-class: a model that misjudges the
    /// current time writes a stamp that already passed, and an item created in
    /// the past would sit `Pending` only until the next tick swept it to
    /// `Missed`. Fail at the call instead, where the model can correct itself.
    #[test]
    fn an_at_in_the_past_is_refused() {
        let now = Utc::now();
        let past = (now - chrono::Duration::days(2))
            .with_timezone(&Local)
            .format("%Y-%m-%dT%H:%M")
            .to_string();
        assert!(resolve_fire_at(None, Some(&past), now).is_err());
    }

    #[test]
    fn an_at_in_the_future_parses_as_local() {
        let now = Utc::now();
        let future_local = (now + chrono::Duration::days(3)).with_timezone(&Local);
        let text = future_local.format("%Y-%m-%dT%H:%M").to_string();
        let got = resolve_fire_at(None, Some(&text), now).unwrap();
        assert_eq!(
            got.with_timezone(&Local).format("%Y-%m-%dT%H:%M").to_string(),
            text,
            "round-trips through the local timezone, not UTC"
        );
    }

    #[test]
    fn unparsable_at_reports_the_expected_shape() {
        let now = utc("2026-01-05T10:00:00Z");
        let err = resolve_fire_at(None, Some("next tuesday"), now).unwrap_err();
        assert!(err.contains("YYYY-MM-DD"), "got {err}");
    }

    #[test]
    fn no_repeat_means_a_one_shot() {
        assert!(resolve_recurrence(None, utc("2026-01-05T10:00:00Z")).unwrap().is_none());
        assert!(resolve_recurrence(Some("  "), utc("2026-01-05T10:00:00Z")).unwrap().is_none());
    }

    #[test]
    fn repeat_takes_its_time_of_day_from_the_first_fire() {
        let fire = utc("2026-01-05T10:17:00Z");
        let rec = resolve_recurrence(Some("daily"), fire).unwrap().unwrap();
        let expected = fire.with_timezone(&Local).format("%H:%M").to_string();
        assert_eq!(rec.time, expected);
        assert_eq!(rec.rule, RecurrenceRule::Daily);
    }

    #[test]
    fn weekdays_is_monday_to_friday() {
        let rec = resolve_recurrence(Some("weekdays"), utc("2026-01-05T10:00:00Z")).unwrap().unwrap();
        assert_eq!(rec.rule, RecurrenceRule::Weekly { weekdays: vec![0, 1, 2, 3, 4] });
    }

    #[test]
    fn weekly_uses_the_first_fires_own_weekday() {
        let fire = utc("2026-01-07T12:00:00Z");
        let rec = resolve_recurrence(Some("weekly"), fire).unwrap().unwrap();
        let expected = fire.with_timezone(&Local).weekday().num_days_from_monday() as u8;
        assert_eq!(rec.rule, RecurrenceRule::Weekly { weekdays: vec![expected] });
    }

    #[test]
    fn every_n_days_parses_its_n() {
        let rec = resolve_recurrence(Some("every-3-days"), utc("2026-01-05T10:00:00Z"))
            .unwrap()
            .unwrap();
        assert_eq!(rec.rule, RecurrenceRule::EveryNDays { n: 3 });
    }

    #[test]
    fn an_unknown_repeat_word_is_an_error_not_a_silent_one_shot() {
        let err = resolve_recurrence(Some("fortnightly"), utc("2026-01-05T10:00:00Z")).unwrap_err();
        assert!(err.contains("every-N-days"), "got {err}");
    }

    #[test]
    fn every_zero_days_is_refused() {
        assert!(resolve_recurrence(Some("every-0-days"), utc("2026-01-05T10:00:00Z")).is_err());
    }
}
