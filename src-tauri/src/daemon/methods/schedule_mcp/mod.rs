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
//!
//! Split into `when` (free-text time + repeat-rule parsing) and `inject`
//! (turn-hook rendering) so no file here carries every concern; this file
//! keeps the MCP dispatch, item construction, and id resolution shared by
//! `add` and `cancel`.

use super::injection_util::short;
use super::spawn_chat;
use crate::daemon::state::DaemonState;
use crate::sessions::scheduled_items::{self, ScheduledItem, ScheduledKind, ScheduledStatus};
use chrono::{DateTime, Local, Utc};
use serde_json::{json, Value};
use std::sync::Arc;

mod inject;
mod when;

pub(crate) use inject::render_for_injection;
use when::{resolve_fire_at, resolve_recurrence};

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
    let inherited = crate::sessions::chat_config::get(session_id).unwrap_or_default();
    let item = build_item(
        &caller.cwd,
        &state.settings.snapshot().projects,
        &inherited,
        session_id,
        args,
        now,
    )?;
    let id = item.id.clone();
    let fire_at = item.fire_at.clone();
    scheduled_items::upsert(item);
    super::schedule::publish_changed(state);
    Ok(json!({
        "ok": true,
        "id": short(&id),
        "fire_at_local": DateTime::parse_from_rfc3339(&fire_at)
            .map(|dt| dt.with_timezone(&Local).format("%Y-%m-%d %H:%M").to_string())
            .unwrap_or(fire_at),
        "name": args.name,
    }))
}

/// Everything `add` decides, with no store or notifier I/O, so the whole
/// decision surface (time form, recurrence, kind selection, inheritance, the
/// two refusals) is unit-testable without writing to the real
/// `scheduled-items.json`. `add` is then just this plus an `upsert` and a
/// publish.
fn build_item(
    caller_cwd: &std::path::Path,
    known_projects: &[crate::types::ProjectConfig],
    inherited: &crate::sessions::chat_config::ChatConfig,
    session_id: &str,
    args: &ScheduleArgs,
    now: DateTime<Utc>,
) -> Result<ScheduledItem, String> {
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
                cwd: caller_cwd.to_string_lossy().to_string(),
            }
        }
        "new_chat" => {
            let requested = args
                .cwd
                .as_deref()
                .map(std::path::PathBuf::from)
                .unwrap_or_else(|| caller_cwd.to_path_buf());
            let target_cwd = crate::daemon::methods::spawn_chat::resolve_target_cwd(
                caller_cwd,
                &requested,
                known_projects,
            )?;
            ScheduledKind::NewChat {
                cwd: target_cwd.to_string_lossy().to_string(),
                // Same fallbacks `spawn_chat` applies, and for the same
                // reason: a caller with no recorded `chat_config` yields an
                // EMPTY model/effort, which `fire_new_chat` would hand to
                // `StartSessionParams` verbatim at fire time - long after
                // anyone could connect the failure to this call.
                model: non_empty(&inherited.model, spawn_chat::FALLBACK_MODEL),
                effort: non_empty(&inherited.effort, spawn_chat::FALLBACK_EFFORT),
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

    Ok(ScheduledItem::new(kind, prompt.to_string(), fire_at.to_rfc3339(), recurrence))
}

fn non_empty(value: &str, fallback: &str) -> String {
    if value.is_empty() { fallback.to_string() } else { value.to_string() }
}

fn cancel(state: &Arc<DaemonState>, args: &ScheduleArgs) -> Result<Value, String> {
    let wanted = args
        .id
        .as_deref()
        .map(str::trim)
        .filter(|i| !i.is_empty())
        .ok_or("cancel needs an id")?;
    let full = resolve_id(wanted)?;
    let existed = scheduled_items::delete(&full);
    if existed {
        super::schedule::publish_changed(state);
    }
    Ok(json!({"ok": existed, "id": short(&full)}))
}

/// Accepts the short id the injected list prints, or a full uuid. Restricted
/// to `Pending` items because that's the only status `render_for_injection`
/// ever hands the model an id for; a `cancel` against a `Sent`/`Missed` item's
/// id (or its prefix) should read as "not found", not resurrect it.
fn resolve_id(wanted: &str) -> Result<String, String> {
    let pending = scheduled_items::list()
        .into_iter()
        .filter(|it| matches!(it.status, ScheduledStatus::Pending))
        .map(|it| it.id);
    resolve_unique_prefix(pending, wanted)
}

/// Pure over an id iterator so the ambiguity rule is unit-testable without
/// touching the real `scheduled-items.json`. Exact match wins outright, even
/// over a second item that merely starts with `wanted` - can't happen with
/// uuids in practice, but keeps the rule simple to state. Otherwise requires
/// EXACTLY ONE prefix hit: taking the first of several would let `cancel`
/// silently delete a different item than the one the model meant.
fn resolve_unique_prefix(ids: impl Iterator<Item = String>, wanted: &str) -> Result<String, String> {
    let ids: Vec<String> = ids.collect();
    if let Some(exact) = ids.iter().find(|id| id.as_str() == wanted) {
        return Ok(exact.clone());
    }
    let hits: Vec<&String> = ids.iter().filter(|id| id.starts_with(wanted)).collect();
    match hits.as_slice() {
        [] => Err(format!("no scheduled item matching {wanted:?}")),
        [one] => Ok((*one).clone()),
        many => Err(format!(
            "{} scheduled items match {wanted:?} - use more characters to narrow it down",
            many.len()
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn utc(s: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(s).unwrap().with_timezone(&Utc)
    }

    // --- resolve_unique_prefix: the ambiguity rule, pure over an id
    // list so none of these touch the real scheduled-items.json ---

    fn ids(raw: &[&str]) -> impl Iterator<Item = String> {
        raw.iter().map(|s| s.to_string()).collect::<Vec<_>>().into_iter()
    }

    #[test]
    fn two_items_sharing_a_prefix_is_refused_not_the_first_one() {
        let err = resolve_unique_prefix(ids(&["abcd1111", "abcd2222"]), "abcd").unwrap_err();
        assert!(err.contains('2'), "got {err}");
        assert!(err.contains("more characters"), "got {err}");
    }

    #[test]
    fn a_one_character_id_matching_several_is_refused() {
        let err = resolve_unique_prefix(ids(&["a111", "a222", "a333"]), "a").unwrap_err();
        assert!(err.contains('3'), "got {err}");
    }

    #[test]
    fn an_exact_full_uuid_resolves_even_if_it_also_prefixes_another_id() {
        assert_eq!(
            resolve_unique_prefix(ids(&["abcd1111", "abcd2222"]), "abcd1111").unwrap(),
            "abcd1111"
        );
    }

    #[test]
    fn a_unique_prefix_still_resolves() {
        assert_eq!(resolve_unique_prefix(ids(&["abcd1111", "zzzz9999"]), "abcd").unwrap(), "abcd1111");
    }

    #[test]
    fn no_match_keeps_the_original_error_wording() {
        let err = resolve_unique_prefix(ids(&["abcd1111"]), "zzzz").unwrap_err();
        assert_eq!(err, "no scheduled item matching \"zzzz\"");
    }

    // --- build_item: the whole decision surface, pure (no store I/O), so
    // these never touch the real scheduled-items.json ---

    use crate::sessions::chat_config::ChatConfig;

    fn cfg(model: &str, effort: &str) -> ChatConfig {
        ChatConfig {
            model: model.to_string(),
            effort: effort.to_string(),
            account_id: "acct-7".to_string(),
            auto_accept: true,
            ..Default::default()
        }
    }

    fn args(extra: impl FnOnce(&mut ScheduleArgs)) -> ScheduleArgs {
        let mut a = ScheduleArgs {
            action: "add".into(),
            prompt: Some("check CI".into()),
            in_minutes: Some(30),
            ..Default::default()
        };
        extra(&mut a);
        a
    }

    fn build(cfg: &ChatConfig, a: &ScheduleArgs) -> Result<ScheduledItem, String> {
        build_item(
            std::path::Path::new("C:/proj"),
            &[],
            cfg,
            "sess-1",
            a,
            utc("2026-01-05T10:00:00Z"),
        )
    }

    #[test]
    fn default_target_is_a_new_chat_inheriting_the_callers_config() {
        let item = build(&cfg("opus", "high"), &args(|_| {})).unwrap();
        match item.kind {
            ScheduledKind::NewChat { model, effort, account_id, auto_accept, character_id, .. } => {
                assert_eq!(model, "opus");
                assert_eq!(effort, "high");
                assert_eq!(account_id.as_deref(), Some("acct-7"));
                assert!(auto_accept);
                assert_eq!(character_id, None, "a scheduled chat is a sibling, not a handoff");
            }
            other => panic!("expected NewChat, got {other:?}"),
        }
        assert_eq!(item.status, ScheduledStatus::Pending);
        assert_eq!(item.prompt, "check CI");
    }

    /// The bug this test exists for: a caller with no recorded `chat_config`
    /// yields empty model/effort strings, and `fire_new_chat` hands them
    /// straight to `StartSessionParams` at fire time - hours later, where
    /// nothing connects the failure back to the call that scheduled it.
    #[test]
    fn a_caller_with_no_chat_config_gets_the_spawn_chat_fallbacks_not_empty_strings() {
        let item = build(&ChatConfig::default(), &args(|_| {})).unwrap();
        match item.kind {
            ScheduledKind::NewChat { model, effort, account_id, .. } => {
                assert_eq!(model, spawn_chat::FALLBACK_MODEL);
                assert_eq!(effort, spawn_chat::FALLBACK_EFFORT);
                assert_eq!(account_id, None, "an empty account id is None, not an empty string");
            }
            other => panic!("expected NewChat, got {other:?}"),
        }
    }

    #[test]
    fn this_chat_targets_the_calling_session_by_id_and_cwd() {
        let a = args(|a| a.target = Some("this_chat".into()));
        let item = build(&cfg("opus", "high"), &a).unwrap();
        match item.kind {
            ScheduledKind::Message { session_id, cwd } => {
                assert_eq!(session_id, "sess-1");
                assert_eq!(cwd, "C:/proj");
            }
            other => panic!("expected Message, got {other:?}"),
        }
    }

    /// A recurring Message into its own session refills that one context
    /// window on every fire. Refused at the call, never downgraded silently.
    #[test]
    fn a_repeating_this_chat_item_is_refused() {
        let a = args(|a| {
            a.target = Some("this_chat".into());
            a.repeat = Some("daily".into());
        });
        let err = build(&cfg("opus", "high"), &a).unwrap_err();
        assert!(err.contains("cannot target this_chat"), "got {err}");
    }

    #[test]
    fn a_repeating_new_chat_item_is_fine() {
        let a = args(|a| a.repeat = Some("daily".into()));
        let item = build(&cfg("opus", "high"), &a).unwrap();
        assert!(item.recurrence.is_some());
    }

    /// The guard that keeps a tool advertised to every session from starting a
    /// chat anywhere on disk. Reused from `spawn_chat`, asserted here because
    /// this call site passes its own `known_projects`.
    #[test]
    fn an_unknown_cwd_is_refused_rather_than_spawning_anywhere() {
        let a = args(|a| a.cwd = Some("C:/somewhere/else".into()));
        let err = build(&cfg("opus", "high"), &a).unwrap_err();
        assert!(err.contains("refusing"), "got {err}");
    }

    #[test]
    fn an_unknown_target_names_the_two_that_exist() {
        let a = args(|a| a.target = Some("somewhere".into()));
        let err = build(&cfg("opus", "high"), &a).unwrap_err();
        assert!(err.contains("new_chat") && err.contains("this_chat"), "got {err}");
    }

    #[test]
    fn a_blank_prompt_is_refused() {
        let a = args(|a| a.prompt = Some("   ".into()));
        assert!(build(&cfg("opus", "high"), &a).is_err());
        let a = args(|a| a.prompt = None);
        assert!(build(&cfg("opus", "high"), &a).is_err());
    }
}
