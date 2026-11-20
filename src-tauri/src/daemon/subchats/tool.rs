//! The `subchat` MCP tool: how a main chat looks up and talks to its subs
//! (spec section 5). One tool with seven actions, listed for every chat because
//! the MCP tool list is fixed when the server process starts and cannot follow
//! a mid-chat toggle. A chat with no subs, and a sub itself, get a refusal
//! naming the fix.
//!
//! - `list`: each sub's name, status, tier and one-line task.
//! - `status {sub}`: its verdict, summary, facts and progress.
//! - `log`: the main chat's decisions log.
//! - `send {sub | all, writes?, text?, question?}`: passes a message to a sub.
//!   A `question` marks it as one of Joe's questions: the sub's next finish
//!   card carries it and is drawn as the answer, so the main chat relays nothing.
//! - `retry {sub}`, `merge {sub}`, `drop {sub}`: how the main chat fixes a sub's
//!   plumbing after the app woke it about it (`plumbing`): start a sub that could
//!   not start, land a finished sub's refused merge, or end a sub that never ran
//!   (and give up a refused merge, leaving the commits on the sub's branch).
//!
//! Results stay short, because this feature exists to keep the main chat's
//! context small. What a sub wrote (verdict, summary) comes back in a tool
//! result, never in `is_meta` text, and says so.
//!
//! **`send` never takes the message from the main agent.** The agent only picks
//! the target; what the sub gets is Joe's latest typed message, copied verbatim
//! from [`super::joe_message`], image mentions included, whenever he typed one the
//! sub has not had. `text` can follow it, framed as coming from the main chat and
//! not typed by Joe, but never replaces it. `text` alone is sent only when there is
//! no Joe message to copy (or this sub already had it): the main agent's own instruction.

use super::facts::Facts;
use super::held::subs_of;
use super::remote::records::{self, RemoteState, RemoteSub};
use super::remote::actions;
use super::{card_log, decisions, finish, followup, joe_message, spawn as spawn_mod, ContinueError};
use crate::daemon::state::DaemonState;
use crate::types::chat::ContentBlock;
use crate::types::Instance;
use crate::util::text::flat_clip;
use serde_json::{json, Value};
use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

mod view;
mod send;
mod remote;
pub use view::*;
pub(crate) use send::*;
pub(super) use remote::*;

pub const SUB_CALLER_REFUSAL: &str = "A sub does not use the subchat tool: it manages subs, and you are one. Ask Joe on a card with ask_user_question, and end your job with finish_subchat.";
pub const NO_SUBS_MODE_OFF: &str = "This chat has no subs. Subchats mode is off for it: Joe turns it on in this chat's menu (Use subchats), and then spawn_chat starts a sub for a job he names.";
pub const NO_SUBS_YET: &str = "This chat has no subs yet. Start one with spawn_chat (name, task, goal, done_when, writes), then use this tool to check on it or pass it a message.";
pub const NO_MESSAGE_REFUSAL: &str = "There is no message from Joe in this turn to pass on: this turn was not opened by something he typed. To tell a sub something yourself, call send again with text.";

/// What a sub is told when the main chat itself gave the instruction.
const MAIN_CHAT_FRAME: &str = "From the main chat (not typed by Joe): ";

/// Longest one-line task `list` shows per sub.
const TASK_CAP: usize = 110;
/// Cap on the decisions log `log` returns. The newest entries are kept and the
/// file path is named for the rest, so one call cannot dump a long history into
/// the main chat.
const LOG_CAP: usize = 6000;
/// How often a held message checks whether its sub went idle. There is no
/// deadline: the text waits for as long as the sub lives (see `followup`).
const HOLD_POLL: Duration = Duration::from_secs(2);
/// Longest list `list` returns; the rest are counted and named by `status`.
const LIST_CAP: usize = 20;

/// The tool. `caller` is the chat that called it. Always returns a JSON value
/// with `ok`; an `ok:false` carries the fix in `error`.
pub async fn run(state: &Arc<DaemonState>, caller: &str, args: &Value) -> Value {
    let owner = state.clone();
    let has = |id: &str| crate::context_status::resolve_transcript(&state.registry, id).is_some();
    run_with(
        state,
        caller,
        args,
        real_facts,
        move |sub_id, text| {
            let state = owner.clone();
            async move { super::continue_sub(&state, &sub_id, &text).await }
        },
        &has,
    )
    .await
}

/// `drop`: ends a sub that never started (it is queued, or its hold was lost), for
/// a job the main chat no longer wants. It never ran, so nothing is lost, and its
/// row stops counting toward the cap. On a finished sub whose merge was refused it
/// gives the merge up instead: the commits stay on the sub's branch and a sub
/// waiting for it goes on. Any other sub that ran is Joe's to end, from its card or
/// the chat menu, so it is refused here.
fn drop_action(state: &Arc<DaemonState>, subs: &[Instance], query: &str) -> Value {
    let sub = match resolve(subs, query) {
        Ok(s) => s,
        Err(e) => return refusal(e),
    };
    if sub.ended_at.is_none() && super::merge_followup::unresolved(&sub.session_id) {
        // A sub working again (told to resolve its conflict) merges at its next
        // finish, so there is nothing to give up yet.
        if !sub.subchat_finished {
            return refusal(format!("{} is working on its refused merge and merges when it finishes, so there is nothing to drop.", label(sub)));
        }
        let branch = super::worktree::info_of(&sub.session_id).map(|i| i.branch).unwrap_or_default();
        super::merge_followup::leave(state, &sub.session_id);
        return json!({"ok": true, "left": label(sub), "note": format!("its merge is given up: its commits stay on branch {branch}, and a sub waiting for it starts")});
    }
    match super::queued::drop_now(state, &sub.session_id) {
        Ok(name) => json!({"ok": true, "dropped": name, "note": "ended without ever running; it no longer counts toward the cap, and a sub waiting for it asks Joe on a card"}),
        Err(e) => refusal(e),
    }
}

/// `retry`: starts a sub the app could not start, by the code behind the old "Try
/// again" card.
async fn retry_action(state: &Arc<DaemonState>, subs: &[Instance], query: &str) -> Value {
    let sub = match resolve(subs, query) {
        Ok(s) => s,
        Err(e) => return refusal(e),
    };
    match super::held::retry(state, &sub.session_id).await {
        Ok(()) => json!({"ok": true, "started": label(sub)}),
        Err(e) => refusal(e),
    }
}

/// `merge`: lands a finished worktree sub's commits now, by the code behind the old
/// "Merge again" card.
async fn merge_action(state: &Arc<DaemonState>, subs: &[Instance], query: &str) -> Value {
    let sub = match resolve(subs, query) {
        Ok(s) => s,
        Err(e) => return refusal(e),
    };
    match super::merge_followup::merge_now(state, &sub.session_id).await {
        Ok(what) => json!({"ok": true, "merged": what}),
        Err(e) => refusal(e),
    }
}

/// [`run`] with the facts reader, the "wake this sub with this text" step and the
/// "does this sub have a transcript" lookup injected, so a test starts no `claude`,
/// runs no git and reads no transcript folder.
pub async fn run_with<F, Fut>(
    state: &Arc<DaemonState>,
    caller: &str,
    args: &Value,
    facts: FactsFn,
    resume: F,
    has_transcript: &(dyn Fn(&str) -> bool + Sync),
) -> Value
where
    F: Fn(String, String) -> Fut + Clone + Send + Sync + 'static,
    Fut: Future<Output = Result<(), ContinueError>> + Send + 'static,
{
    let Some(me) = state.registry.get(caller) else { return refusal(format!("unknown session: {caller}")) };
    if super::is_sub(&me) {
        return refusal(SUB_CALLER_REFUSAL);
    }
    let subs = subs_of(state, caller);
    let remote = remote_of(caller);
    if subs.is_empty() && remote.is_empty() {
        let on = crate::sessions::chat_config::get(caller).is_some_and(|c| c.subchats_on);
        return refusal(if on { NO_SUBS_YET } else { NO_SUBS_MODE_OFF });
    }
    let action = args["action"].as_str().unwrap_or("");
    let sub = args["sub"].as_str().unwrap_or("");
    match action {
        "list" => list_with_remote(state, &subs, &remote),
        "status" => match resolve(&subs, sub) {
            Err(e) => match resolve_remote(&remote, sub) {
                Some(rec) => status_remote(state, rec).await,
                None => refusal(e),
            },
            Ok(_) => status(state, &subs, sub, facts),
        },
        "log" => log_action(caller),
        "send" => send(state, caller, &subs, &remote, args, resume, has_transcript).await,
        "drop" => match resolve(&subs, sub) {
            Err(e) => match resolve_remote(&remote, sub) {
                Some(rec) => drop_remote(state, rec).await,
                None => refusal(e),
            },
            Ok(_) => drop_action(state, &subs, sub),
        },
        "retry" => match resolve(&subs, sub) {
            Err(e) => match resolve_remote(&remote, sub) {
                Some(rec) => {
                    // A sub still waiting on an `after` is started by this machine; one the host
                    // registered and could not launch is retried on the host.
                    let started = if rec.state == RemoteState::Held { super::remote::after::retry(state, rec).await } else { actions::retry(state, rec).await };
                    match started {
                        Ok(()) => json!({"ok": true, "started": actions::name_of(rec)}),
                        Err(e) => refusal(e),
                    }
                }
                None => refusal(e),
            },
            Ok(_) => retry_action(state, &subs, sub).await,
        },
        "merge" => match resolve(&subs, sub) {
            Err(e) => match resolve_remote(&remote, sub) {
                Some(rec) => match super::merge_followup::merge_now(state, &rec.sub_id).await {
                    Ok(what) => json!({"ok": true, "merged": what}),
                    Err(e) => refusal(e),
                },
                None => refusal(e),
            },
            Ok(_) => merge_action(state, &subs, sub).await,
        },
        other => refusal(format!("action must be list, status, log, send, retry, merge or drop, not \"{other}\".")),
    }
}

#[cfg(test)]
mod tests;
