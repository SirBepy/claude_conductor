//! Rate-limit rejection handling: what happens when the CLI reports an
//! account is out of quota mid-turn. Split out of `daemon::lifecycle`
//! (ai_todo 214) because it is a self-contained concern - it only touches
//! `state.registry` (`set_rate_limited_for_account`/`clear_rate_limit_for_
//! account`), `crate::sessions::scheduled_items` (dedupe + upsert), and
//! `crate::daemon::schedule::next_stagger_slot` - with no dependency on the
//! process-spawning machinery that dominates `lifecycle.rs`.

use crate::daemon::session::Session;
use crate::daemon::state::DaemonState;
use std::sync::Arc;

/// The CLI rejected a turn because the account is out of quota. Three effects:
///
/// 1. Mark EVERY live session on that account blocked. One account's window
///    blocks all of its chats at once, even the idle ones, and the UI has to
///    say so before the user types into a chat that cannot answer.
/// 2. Queue a resume for THIS session only. It is the one whose turn died
///    mid-flight; the account's other sessions are merely unable to start, and
///    have no interrupted work to replay.
/// 3. Auto-freeze THIS session (`auto_frozen`) until the queued resume above
///    actually fires and sends - never needs a manual unfreeze.
///
/// The resume is a real persisted `ScheduledItem`, not an in-process timer, so
/// it survives an app restart and shows up in the schedule view where the user
/// can see, edit, or cancel it.
pub(crate) fn handle_rate_limit_rejection(
    state: &Arc<DaemonState>,
    session: &Arc<Session>,
    body: &str,
    saw_stream_turn: bool,
) {
    let Ok(info) = serde_json::from_str::<serde_json::Value>(body) else {
        log::warn!("daemon: rate_limit body was not JSON: {body}");
        return;
    };
    let Some(resets_at) = info.get("resetsAt").and_then(|v| v.as_i64()) else {
        log::warn!("daemon: rate_limit body has no resetsAt: {body}");
        return;
    };
    let window = info.get("rateLimitType").and_then(|v| v.as_str()).unwrap_or("five_hour");
    let blocked = state
        .registry
        .set_rate_limited_for_account(&session.account_id, resets_at, window);
    log::info!(
        "daemon: account {} rate limited ({window}) until {resets_at}; {} session(s) blocked",
        session.account_id,
        blocked.len()
    );

    // Replay the exact prompt when the turn died before producing anything.
    // Once output has streamed, resending the prompt would redo finished work,
    // so nudge instead. Either way it must read sensibly in the schedule view.
    let prompt = if saw_stream_turn {
        "Continue from where you left off.".to_string()
    } else {
        session
            .last_prompt
            .lock()
            .ok()
            .map(|p| p.clone())
            .filter(|p| !p.trim().is_empty())
            .unwrap_or_else(|| "Continue from where you left off.".to_string())
    };

    // A second rejection for the same session (user retried, got blocked again)
    // must not leave two resumes queued for one chat.
    while let Some(existing) =
        crate::sessions::scheduled_items::find_pending_message_for_session(&session.session_id)
    {
        crate::sessions::scheduled_items::delete(&existing.id);
    }

    let fire_at =
        crate::daemon::schedule::next_stagger_slot(state, Some(&session.account_id), resets_at);
    let item = crate::sessions::scheduled_items::ScheduledItem::new(
        crate::sessions::scheduled_items::ScheduledKind::Message {
            session_id: session.session_id.clone(),
            cwd: session.cwd.to_string_lossy().to_string(),
        },
        prompt,
        fire_at.to_rfc3339(),
        None,
    );
    crate::sessions::scheduled_items::upsert(item);

    // Skip if already frozen - never stomps a manual freeze's own
    // `frozen_needs_continue` bookkeeping (the resume above replaces it).
    if !state.registry.get(&session.session_id).map(|i| i.frozen).unwrap_or(false) {
        state.registry.set_frozen(&session.session_id, true);
        state.registry.set_auto_frozen(&session.session_id, true);
    }
    crate::sessions::persistence::save_snapshot_default(&state.registry);

    state.notifier.publish(
        "instances_changed",
        serde_json::json!({"instances": state.registry.list()}),
    );
    state.notifier.publish(
        "scheduled_items_changed",
        serde_json::json!({"items": crate::sessions::scheduled_items::list()}),
    );
}

#[cfg(test)]
mod tests {
    #[test]
    fn rate_limited_sentinel_round_trips() {
        use crate::daemon::schedule::parse_rate_limited as parse;
        assert_eq!(parse("RATE_LIMITED:1800000000"), Some(1_800_000_000));
        assert_eq!(parse("sent"), None);
        assert_eq!(parse("RATE_LIMITED:not-a-number"), None);
    }
}
