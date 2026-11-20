//! The save step before a compaction (docs/forever-chat-plan.md B1 and section 5).
//!
//! A forever chat never reaches rule 12's close, so what it learned (a memory, a
//! todo, its retro) would live only in a summary the CLI writes of it. Before the
//! daemon sends `/compact` it therefore gives the chat one ordinary turn to save
//! that (`~/.claude/refs/save-step.md`, "whenever the app asks for it before a
//! compaction") and writes its retro, then compacts when that turn ends.
//!
//! The turn is bounded, because a compaction must never wait on a chat that will
//! not finish: [`SAVE_LIMIT`] after the ask the idle sweep interrupts it, and the
//! turn's end starts the compaction either way. An ask is not repeated within
//! [`SAVE_FRESH`], so a save that was cut short, or a compaction skipped behind it
//! (a card opened meanwhile), never costs a second turn. An API-credit account and
//! Jarvis skip the step: the first pays full price for every extra turn and cannot
//! afford even this one, the second is a router, not a chat that does work to save.

use super::{Facts, Skip, Trigger, IDLE_FLOOR_TOKENS};
use std::time::Duration;

/// How long the save turn may run before the idle sweep interrupts it. A turn
/// that writes a few memory and todo files takes well under this.
pub const SAVE_LIMIT: Duration = Duration::from_secs(5 * 60);

/// A save asked this recently counts as done: the next compaction goes straight
/// out.
pub const SAVE_FRESH: Duration = Duration::from_secs(30 * 60);

/// Whether a chat whose last ask was `since_last` ago is due another one.
pub fn due(since_last: Option<Duration>) -> bool {
    since_last.is_none_or(|d| d >= SAVE_FRESH)
}

/// What the chat is told. Built by the daemon alone, so it may travel as an
/// `is_meta` turn (no byte of it comes from a sub or a peer). `retro` is false
/// for a chat `main_chat_retro` refuses.
pub fn ask_text(retro: bool) -> String {
    let mut text = String::from(
        "The app is about to compact this chat in place, so everything not saved by the end of this turn survives only as a summary. Do the save step now: follow ~/.claude/refs/save-step.md if it exists (memory, then todos), and otherwise save any lasting fact, correction or deferred work from this chat that is not saved yet. A chat with nothing new since its last save step skips it silently.",
    );
    if retro {
        text.push_str(" Then write this chat's retro with the main_chat_retro tool; a chat that is compacted instead of closed never reaches rule 12's close, and a second call today rewrites the first.");
    }
    text.push_str(" Start no new work, send Joe no message and ask him nothing. Keep this turn short: it is cut off after 5 minutes and the compaction goes ahead either way.");
    text
}

/// Whether the compaction a save turn was asked for still goes ahead once that
/// turn ended. The trigger's own quiet-time test is not repeated, since the save
/// turn itself was the chat's last activity; its size test is, because the CLI may
/// have compacted the chat meanwhile.
pub fn decide_after_save(f: &Facts, trigger: Trigger) -> Result<(), Skip> {
    if !f.main_chat {
        return Err(Skip::NotMainChat);
    }
    if trigger != Trigger::Manual {
        let threshold = f.threshold.filter(|t| t.on).ok_or(Skip::Off)?;
        let occupancy = f.occupancy.ok_or(Skip::NoUsageYet)?;
        let floor = if trigger == Trigger::Idle { IDLE_FLOOR_TOKENS } else { threshold.tokens };
        if occupancy < floor {
            return Err(Skip::BelowThreshold);
        }
        if f.retry_at.is_some_and(|at| occupancy < at) {
            return Err(Skip::RecentlyFailed);
        }
    }
    if trigger == Trigger::Idle && f.api_credit {
        return Err(Skip::ApiCreditAccount);
    }
    super::ready(f)
}
