//! MCP-facing half of the scheduler: the `schedule` tool's `add`/`cancel`,
//! plus the `UserPromptSubmit` block that lists this session's pending items.
//!
//! Separate from `methods::schedule` (the desktop RPC surface) because the
//! caller is different in the one way that matters: the `session_id` arriving
//! here is claimed by an MCP child and untrusted, so everything the item
//! carries - cwd, model, effort, account - is re-derived from the registry
//! and `chat_config`, never taken from the request. That is the same trust
//! model `methods::spawn_chat` uses, and its `resolve_target_cwd` guard is
//! reused verbatim rather than re-implemented: a tool advertised to every
//! session must not become a way to start chats at an arbitrary path.
//!
//! There is deliberately no `list` action. Pending items ride
//! `render_for_injection` on the turn hook the daemon already fires, which
//! costs nothing when the list is empty and hands the model real ids without
//! a round trip.

use crate::daemon::state::DaemonState;
use crate::sessions::scheduled_items::{
    self, Recurrence, RecurrenceRule, ScheduledItem, ScheduledKind, ScheduledStatus,
};
use chrono::{DateTime, Datelike, Local, NaiveDateTime, TimeZone, Utc};
use serde_json::{json, Value};
use std::sync::Arc;

/// Cap on injected rows, mirroring `user_todos::MAX_INJECTED`.
const MAX_INJECTED: usize = 10;
/// Matches `user_todos`'s short-id convention so both injected lists read the
/// same way and `resolve_id` can accept either form.
const SHORT_ID_LEN: usize = 8;

/// One `add`/`cancel` call. Every field is optional at this boundary because
/// the MCP relay omits absent keys rather than sending nulls; the per-action
/// requirements are enforced below, where the error message can say which
/// field is missing.
#[derive(Debug, Default)]
pub(crate) struct ScheduleArgs {
    pub action: String,
    pub prompt: Option<String>,
    pub target: Option<String>,
    pub in_minutes: Option<i64>,
    pub at: Option<String>,
    pub repeat: Option<String>,
    pub cwd: Option<String>,
    pub name: Option<String>,
    pub id: Option<String>,
}

pub(crate) fn write_schedule(
    state: &Arc<DaemonState>,
    session_id: &str,
    args: &ScheduleArgs,
) -> Result<Value, String> {
    match args.action.as_str() {
        "add" => add(state, session_id, args, Utc::now()),
        "cancel" => cancel(state, args),
        other => Err(format!("unknown action {other:?}; expected add or cancel")),
    }
}

fn add(
    state: &Arc<DaemonState>,
    session_id: &str,
    args: &ScheduleArgs,
    now: DateTime<Utc>,
) -> Result<Value, String> {
    let caller = state
        .registry
        .get(session_id)
        .ok_or_else(|| format!("unknown caller session: {session_id}"))?;
    let prompt = args
        .prompt
        .as_deref()
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .ok_or("add needs a prompt")?;

    let fire_at = resolve_fire_at(args.in_minutes, args.at.as_deref(), now)?;
    let recurrence = resolve_recurrence(args.repeat.as_deref(), fire_at)?;
    let target = args.target.as_deref().unwrap_or("new_chat");

    let kind = match target {
        "this_chat" => {
            // Refused rather than silently downgraded: a recurring prompt into
            // the session that created it appends to one context window every
            // time it fires, so it degrades until the window is full. A
            // recurring item belongs in a fresh chat.
            if recurrence.is_some() {
                return Err(
                    "a repeating item cannot target this_chat - it would refill this session's \
                     own context on every fire. Use the default new_chat for anything recurring."
                        .to_string(),
                );
            }
            ScheduledKind::Message {
                session_id: session_id.to_string(),
                cwd: caller.cwd.to_string_lossy().to_string(),
            }
        }
        "new_chat" => {
            let requested = args
                .cwd
                .as_deref()
                .map(std::path::PathBuf::from)
                .unwrap_or_else(|| caller.cwd.clone());
            let target_cwd = crate::daemon::methods::spawn_chat::resolve_target_cwd(
                &caller.cwd,
                &requested,
                &state.settings.snapshot().projects,
            )?;
            let inherited = crate::sessions::chat_config::get(session_id).unwrap_or_default();
            ScheduledKind::NewChat {
                cwd: target_cwd.to_string_lossy().to_string(),
                model: inherited.model.clone(),
                effort: inherited.effort.clone(),
                account_id: Some(inherited.account_id.clone()).filter(|a| !a.is_empty()),
                placeholder_id: None,
                // Left to the frontend's `ensure_session_character`, same as a
                // `spawn_chat` sibling: this is a separate chat, not a handoff,
                // so it must not wear the scheduling session's face.
                character_id: None,
                auto_accept: inherited.auto_accept,
            }
        }
        other => return Err(format!("unknown target {other:?}; expected new_chat or this_chat")),
    };

    let item = ScheduledItem::new(kind, prompt.to_string(), fire_at.to_rfc3339(), recurrence);
    let id = item.id.clone();
    scheduled_items::upsert(item);
    super::schedule::publish_changed(state);
    Ok(json!({
        "ok": true,
        "id": short(&id),
        "fire_at_local": fire_at.with_timezone(&Local).format("%Y-%m-%d %H:%M").to_string(),
        "name": args.name,
    }))
}

fn cancel(state: &Arc<DaemonState>, args: &ScheduleArgs) -> Result<Value, String> {
    let wanted = args
        .id
        .as_deref()
        .map(str::trim)
        .filter(|i| !i.is_empty())
        .ok_or("cancel needs an id")?;
    let full = resolve_id(wanted).ok_or_else(|| format!("no scheduled item matching {wanted:?}"))?;
    let existed = scheduled_items::delete(&full);
    if existed {
        super::schedule::publish_changed(state);
    }
    Ok(json!({"ok": existed, "id": short(&full)}))
}

/// Exactly one of `in_minutes` / `at`. `in_minutes` is the form the tool
/// description steers toward, because a model reliably knows "20 minutes from
/// now" and does not reliably know the current wall-clock time; `at` is
/// resolved in LOCAL time, matching `recurrence::next_occurrence` and what
/// the Schedule panel displays.
fn resolve_fire_at(
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
fn resolve_recurrence(
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

fn short(id: &str) -> String {
    id.chars().take(SHORT_ID_LEN).collect()
}

/// Accepts the short id the injected list prints, or a full uuid.
fn resolve_id(wanted: &str) -> Option<String> {
    scheduled_items::list()
        .into_iter()
        .map(|it| it.id)
        .find(|id| id == wanted || id.starts_with(wanted))
}

/// Pending items this session can act on: anything firing into this session,
/// plus new-chat items aimed at the directory it is working in. Deliberately
/// not every item on the machine - an unrelated project's schedule is noise
/// here, and the point of this block is to hand over ids the model may cancel.
pub(crate) fn render_for_injection(state: &Arc<DaemonState>, session_id: &str) -> Option<String> {
    let caller = state.registry.get(session_id)?;
    let mine: Vec<ScheduledItem> = scheduled_items::list()
        .into_iter()
        .filter(|it| matches!(it.status, ScheduledStatus::Pending))
        .filter(|it| match &it.kind {
            ScheduledKind::Message { session_id: target, .. } => target == session_id,
            ScheduledKind::NewChat { cwd, .. } => {
                crate::util::same_dir(&caller.cwd, std::path::Path::new(cwd))
            }
            ScheduledKind::JarvisHygiene => false,
        })
        .collect();
    if mine.is_empty() {
        return None;
    }

    let mut out = String::from(
        "[scheduled] Prompts already queued to fire later, from the app's Schedule panel. \
         They run on their own - never re-create one, and never promise to \"remember\" to do \
         something one of these already covers. Cancel with the `schedule` tool's \
         `cancel` action and the id below.\n",
    );
    for it in mine.iter().take(MAX_INJECTED) {
        out.push_str(&line_for(it));
        out.push('\n');
    }
    if mine.len() > MAX_INJECTED {
        out.push_str(&format!("...and {} more.\n", mine.len() - MAX_INJECTED));
    }
    Some(out)
}

fn line_for(item: &ScheduledItem) -> String {
    let when = DateTime::parse_from_rfc3339(&item.fire_at)
        .map(|dt| dt.with_timezone(&Local).format("%Y-%m-%d %H:%M").to_string())
        .unwrap_or_else(|_| item.fire_at.clone());
    let repeat = match item.recurrence.as_ref().map(|r| &r.rule) {
        None => String::new(),
        Some(RecurrenceRule::Daily) => ", daily".to_string(),
        Some(RecurrenceRule::Weekly { weekdays }) => format!(", weekly on {weekdays:?}"),
        Some(RecurrenceRule::EveryNDays { n }) => format!(", every {n}d"),
    };
    let target = match &item.kind {
        ScheduledKind::Message { .. } => "this chat",
        ScheduledKind::NewChat { .. } => "new chat",
        ScheduledKind::JarvisHygiene => "jarvis",
    };
    format!("- [{}] {when}{repeat} -> {target}: {}", short(&item.id), item.prompt)
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

    #[test]
    fn short_id_is_the_injected_prefix() {
        assert_eq!(short("0123456789abcdef"), "01234567");
    }
}
