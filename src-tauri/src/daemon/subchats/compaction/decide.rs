use super::*;

// ---- the decision ---------------------------------------------------------

/// Why a chat is not compacted now. The text is what `compact_now` answers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Skip {
    NotMainChat,
    Unavailable,
    NoLiveChild,
    FirstAfterRestart,
    AlreadyCompacting,
    Busy,
    CardOpen,
    HeldMessages,
    LineBackWaiting,
    ScheduleDueSoon,
    RecentlyFailed,
    Off,
    NoUsageYet,
    BelowThreshold,
    ApiCreditAccount,
    NotIdle,
}

impl Skip {
    /// A skip about something open on the chat that the chat's own owner clears
    /// without the chat saying a word (an answered card, a delivered held message, a
    /// passed schedule, an ended turn), so the idle sweep must judge it again on the
    /// next tick. Every other skip changes only with new activity, which re-arms the
    /// chat anyway.
    pub(super) fn clears_by_itself(self) -> bool {
        matches!(
            self,
            Skip::CardOpen
                | Skip::HeldMessages
                | Skip::LineBackWaiting
                | Skip::ScheduleDueSoon
                | Skip::Busy
                | Skip::AlreadyCompacting
                // A rate-limit window or an API-credit cap ends with no line from the chat.
                | Skip::Unavailable
        )
    }

    pub fn reason(self) -> &'static str {
        match self {
            Skip::NotMainChat => "only a main chat (\"Use subchats\" on) is compacted",
            Skip::Unavailable => "the chat is closed, closing, frozen or rate limited",
            Skip::NoLiveChild => "the chat has no running process; send it a message first",
            Skip::FirstAfterRestart => {
                "the chat was resumed and has not finished a turn yet; send it a message first"
            }
            Skip::AlreadyCompacting => "the chat is already compacting",
            Skip::Busy => "the chat is in the middle of a turn",
            Skip::CardOpen => "a question card is waiting in the chat",
            Skip::HeldMessages => "a held message is waiting to be sent",
            Skip::LineBackWaiting => "a finished sub's line is waiting for Joe's next message",
            Skip::ScheduleDueSoon => "a scheduled message to the chat is due within 5 minutes",
            Skip::RecentlyFailed => "the last compaction did not compact; the next try waits for the chat to grow",
            Skip::Off => "automatic compaction is off for this project",
            Skip::NoUsageYet => "the chat's context size is not known yet",
            Skip::BelowThreshold => "the chat is below its compaction threshold",
            Skip::ApiCreditAccount => "an API-credit chat is never compacted on idle (its prompt cache lasts 5 minutes)",
            Skip::NotIdle => "the chat has not been idle for 30 minutes",
        }
    }
}

/// Everything the decision reads, gathered by [`facts`].
#[derive(Debug, Clone, Default)]
pub struct Facts {
    pub main_chat: bool,
    pub unavailable: bool,
    pub live_child: bool,
    /// A resumed child that has not ended a live turn yet.
    pub first_after_restart: bool,
    pub compacting: bool,
    pub busy: bool,
    pub card_open: bool,
    pub held_messages: bool,
    pub line_back_waiting: bool,
    pub schedule_due_soon: bool,
    pub occupancy: Option<u64>,
    pub threshold: Option<Threshold>,
    /// See [`RETRY_GROWTH_TOKENS`].
    pub retry_at: Option<u64>,
    /// The chat's account is an API-credit one.
    pub api_credit: bool,
    /// How long the chat has been silent; `None` when nothing was seen from it.
    pub idle_for: Option<Duration>,
    /// The save step is due before this compaction ([`save_step`]): not asked
    /// lately, and the chat is neither Jarvis nor on an API-credit account.
    pub save_step: bool,
}

/// Whether to compact now. `auto` is the turn-end trigger, which also needs
/// the threshold on and passed (checked first, so a chat below it is never
/// reported as "past threshold, not now"); the manual `compact_now` skips that
/// part only.
pub fn decide(f: &Facts, auto: bool) -> Result<(), Skip> {
    if !f.main_chat {
        return Err(Skip::NotMainChat);
    }
    if auto {
        let threshold = f.threshold.filter(|t| t.on).ok_or(Skip::Off)?;
        let occupancy = f.occupancy.ok_or(Skip::NoUsageYet)?;
        if occupancy < threshold.tokens {
            return Err(Skip::BelowThreshold);
        }
        if f.retry_at.is_some_and(|at| occupancy < at) {
            return Err(Skip::RecentlyFailed);
        }
    }
    ready(f)
}

/// The idle trigger's decision: a quiet [`IDLE_COMPACT_AFTER`] and past
/// [`IDLE_FLOOR_TOKENS`] on a subscription account, then the same readiness
/// checks as every other trigger. Off when automatic compaction is off.
pub fn decide_idle(f: &Facts) -> Result<(), Skip> {
    if !f.main_chat {
        return Err(Skip::NotMainChat);
    }
    f.threshold.filter(|t| t.on).ok_or(Skip::Off)?;
    // On usage credits the prompt cache lives 5 minutes (docs/chat-heads-design.md),
    // so at 30 minutes idle a compaction is a cold, full-price read of the chat.
    if f.api_credit {
        return Err(Skip::ApiCreditAccount);
    }
    let occupancy = f.occupancy.ok_or(Skip::NoUsageYet)?;
    if occupancy < IDLE_FLOOR_TOKENS {
        return Err(Skip::BelowThreshold);
    }
    if f.idle_for.is_none_or(|d| d < IDLE_COMPACT_AFTER) {
        return Err(Skip::NotIdle);
    }
    if f.retry_at.is_some_and(|at| occupancy < at) {
        return Err(Skip::RecentlyFailed);
    }
    ready(f)
}

/// Whether idle compaction of this chat is still ahead and needs its live child, so the
/// idle freeze (`idle_freeze`) must leave it running: a main chat past
/// [`IDLE_FLOOR_TOKENS`] on a subscription account with the automatic trigger on, quiet
/// for less than [`IDLE_COMPACT_AFTER`] plus `grace`. The compaction runs at
/// [`IDLE_COMPACT_AFTER`] and keeps the chat busy; the `grace` bound (the freeze delay)
/// stops a compaction skipped for a reason that only new activity clears (a resumed
/// child, a finished sub's waiting line) from keeping the child for good. The freeze
/// clock starts when this turns false, so such a chat is frozen `grace` after that point.
pub fn idle_compaction_pending(f: &Facts, grace: Duration) -> bool {
    let Some(occupancy) = f.occupancy else { return false };
    f.main_chat
        && f.threshold.is_some_and(|t| t.on)
        && !f.api_credit
        && f.live_child
        && occupancy >= IDLE_FLOOR_TOKENS
        && !f.retry_at.is_some_and(|at| occupancy < at)
        && f.idle_for.is_some_and(|d| d < IDLE_COMPACT_AFTER.saturating_add(grace))
}

pub(super) fn ready(f: &Facts) -> Result<(), Skip> {
    let checks = [
        (f.unavailable, Skip::Unavailable),
        (!f.live_child, Skip::NoLiveChild),
        (f.first_after_restart, Skip::FirstAfterRestart),
        (f.compacting, Skip::AlreadyCompacting),
        (f.busy, Skip::Busy),
        (f.card_open, Skip::CardOpen),
        (f.held_messages, Skip::HeldMessages),
        (f.line_back_waiting, Skip::LineBackWaiting),
        (f.schedule_due_soon, Skip::ScheduleDueSoon),
    ];
    match checks.iter().find(|(hit, _)| *hit) {
        Some((_, skip)) => Err(*skip),
        None => Ok(()),
    }
}

/// Whether a scheduled message to `session_id` fires before `now + margin`.
pub(super) fn schedule_due_soon(session_id: &str, now: chrono::DateTime<chrono::Utc>) -> bool {
    use crate::sessions::scheduled_items::{ScheduledKind, ScheduledStatus};
    let horizon = now + chrono::Duration::seconds(SCHEDULE_MARGIN_SECS);
    crate::sessions::scheduled_items::list().iter().any(|item| {
        matches!(item.status, ScheduledStatus::Pending)
            && matches!(&item.kind, ScheduledKind::Message { session_id: s, .. } if s == session_id)
            && chrono::DateTime::parse_from_rfc3339(&item.fire_at).is_ok_and(|at| at <= horizon)
    })
}

/// Whether a non-quiet card shows in `session_id`'s window: one it asked, or a
/// sub's that is drawn there.
pub(super) async fn card_open(state: &DaemonState, session_id: &str) -> bool {
    state.list_prompts().await.iter().any(|v| {
        let p = &v["payload"];
        !crate::daemon::state::is_quiet(v)
            && (p["session_id"].as_str() == Some(session_id) || p["display_session_id"].as_str() == Some(session_id))
    })
}

pub async fn facts(state: &Arc<DaemonState>, session_id: &str) -> Facts {
    let inst = state.registry.get(session_id);
    let cfg = crate::sessions::chat_config::get(session_id).unwrap_or_default();
    let live = state.sessions.get(session_id).map(|s| s.pid);
    let (first_after_restart, compacting, occupancy, retry_at, idle_for, save_due) = {
        let all = chats();
        match all.get(session_id) {
            Some(c) => (
                live.is_some_and(|pid| c.pid == pid && c.resumed && !c.live_turn_ended),
                compacting_in(c),
                c.occupancy,
                c.retry_at,
                c.last_activity.map(|t| t.elapsed()),
                !saving_in(c) && save_step::due(c.last_save.map(|t| t.elapsed())),
            ),
            None => (live.is_some(), false, None, None, None, true),
        }
    };
    let account_id = inst
        .as_ref()
        .and_then(|i| i.account_id.clone())
        .filter(|a| !a.is_empty())
        .or_else(|| state.sessions.get(session_id).map(|s| s.account_id.clone()));
    let api_credit = account_id.is_some_and(|id| crate::accounts::load_registry().iter().any(|a| a.id == id && a.is_api_credit()));
    let now = chrono::Utc::now();
    // An API-credit account at its cap pays for nothing, a compaction included:
    // it is a full model call over the whole context.
    let unavailable = inst.as_ref().is_none_or(|i| {
        i.ended_at.is_some()
            || i.frozen
            || i.closing
            || i.rate_limited_resets_at.is_some_and(|t| t > now.timestamp())
    }) || crate::daemon::lifecycle::refuse_if_api_credit_blocked(state, session_id).is_err();
    let threshold = inst
        .as_ref()
        .map(|i| threshold_for(&state.settings.snapshot().extra, &i.project_id));
    Facts {
        // Jarvis is compacted like a main chat (Joe, 2026-11-16: "i never have to
        // compact or respawn a chat"), though it has no subchats mode.
        main_chat: (cfg.subchats_on || is_jarvis(state, session_id))
            && inst.as_ref().is_some_and(|i| {
                !super::super::is_sub(i) && matches!(i.kind, crate::sessions::kinds::InstanceKind::Interactive)
            }),
        unavailable,
        live_child: live.is_some(),
        first_after_restart,
        compacting,
        busy: inst.as_ref().is_some_and(|i| i.busy),
        card_open: card_open(state, session_id).await,
        held_messages: state.draft_store.held_count(session_id) > 0,
        line_back_waiting: super::super::back::peek(session_id).is_some(),
        schedule_due_soon: schedule_due_soon(session_id, now),
        occupancy,
        threshold,
        retry_at,
        api_credit,
        idle_for,
        save_step: save_due && !api_credit && !is_jarvis(state, session_id),
    }
}

pub(super) fn is_jarvis(state: &DaemonState, session_id: &str) -> bool {
    state.settings.snapshot().jarvis_session_id.as_deref() == Some(session_id)
}
