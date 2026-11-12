//! A sub's plumbing problem goes to its main chat, never to Joe (Joe, 2026-11-12:
//! "this is the sort of shit i expect the main chat to handle"). Plumbing is what
//! the app does around a sub rather than the job itself: a sub that could not
//! start (its worktree or the repo's bootstrap script failed, the spawn failed),
//! a merge of its commits that was refused, a conflict it did not resolve after it
//! was told to, a branch that could not be brought up to date before it continued.
//!
//! None of these raises a card. [`report`] records the problem and wakes the main
//! chat once with fixed words, the way `card_watch` and `queue_watch` wake it, and
//! the main chat fixes it with `subchat retry`, `merge` or `drop` (or a `send` to
//! the sub), asking Joe only when it needs his decision. A merge refused because
//! another chat has uncommitted changes in the same files never comes here at all:
//! `merge_followup` keeps it pending and lands it once the files are clean.
//!
//! One wake per problem: a sub that already has a recorded problem gets its record
//! updated and no second wake, until [`resolved`] clears it (the sub started, its
//! commits landed, the main chat dropped it, or the sub ended).
//!
//! The wake is `is_meta` text, so it is built from ids, a name kept to plain
//! characters and fixed words. What git or the launch said (paths, branch names,
//! error text) is kept here and reaches the main chat through `subchat status`, a
//! tool result, never through the wake.

use crate::daemon::state::DaemonState;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

/// Which kind of plumbing problem a sub has.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Problem {
    /// The sub could not start (worktree setup, bootstrap script, spawn).
    CouldNotStart,
    /// Its commits conflict with the target, and telling it did not fix that.
    Conflict,
    /// The merge of its commits was refused for another reason.
    MergeRefused,
    /// A continued sub's branch could not be brought up to date with its target.
    NotUpToDate,
}

impl Problem {
    /// The word `subchat status` shows.
    pub fn word(self) -> &'static str {
        match self {
            Problem::CouldNotStart => "could_not_start",
            Problem::Conflict => "merge_conflict",
            Problem::MergeRefused => "merge_refused",
            Problem::NotUpToDate => "not_up_to_date",
        }
    }

    fn what(self) -> &'static str {
        match self {
            Problem::CouldNotStart => "could not start",
            Problem::Conflict => "finished, but its commits still conflict with the branch they merge into after it was told to resolve that",
            Problem::MergeRefused => "finished, but the merge of its commits was refused",
            Problem::NotUpToDate => "was continued, but its branch could not be brought up to date with the branch it merges into",
        }
    }

    fn fix(self) -> &'static str {
        match self {
            Problem::CouldNotStart => "fix the cause, then start it with action retry; or end it with action drop if the job is no longer wanted",
            Problem::Conflict => "tell it to resolve the conflict with action send, or try the merge again with action merge; action drop leaves its commits on its branch",
            Problem::MergeRefused => "fix the cause, then land its commits with action merge; action drop leaves them on its branch",
            Problem::NotUpToDate => "tell it what to do with action send if it cannot sort it out by itself",
        }
    }
}

/// A sub's current problem, with the facts `subchat status` returns.
#[derive(Clone, Debug, PartialEq)]
pub struct Record {
    pub problem: Problem,
    /// What failed, in the app's or git's words.
    pub detail: String,
    /// The files git named, if any.
    pub files: Vec<String>,
}

static PROBLEMS: Mutex<Option<HashMap<String, Record>>> = Mutex::new(None);

/// Subs whose problem the main chat is handling right now through the tool: a
/// refusal while it runs is the tool's result, not a wake.
static QUIET: Mutex<Option<HashSet<String>>> = Mutex::new(None);

/// Keeps [`report`] from waking the main chat about `sub_id` while it lives.
pub(crate) struct QuietGuard(String);

impl Drop for QuietGuard {
    fn drop(&mut self) {
        if let Some(set) = QUIET.lock().unwrap_or_else(|p| p.into_inner()).as_mut() {
            set.remove(&self.0);
        }
    }
}

pub(crate) fn quiet(sub_id: &str) -> QuietGuard {
    QUIET.lock().unwrap_or_else(|p| p.into_inner()).get_or_insert_with(HashSet::new).insert(sub_id.to_string());
    QuietGuard(sub_id.to_string())
}

fn is_quiet(sub_id: &str) -> bool {
    QUIET.lock().unwrap_or_else(|p| p.into_inner()).as_ref().is_some_and(|s| s.contains(sub_id))
}

/// The problem `sub_id` has now, if any.
pub fn current(sub_id: &str) -> Option<Record> {
    PROBLEMS.lock().unwrap_or_else(|p| p.into_inner()).as_ref()?.get(sub_id).cloned()
}

/// The wake line for `name` (id `sub_id`). Fixed words, a plain name and the id.
pub fn notice(name: &str, sub_id: &str, problem: Problem) -> String {
    let short: String = sub_id.chars().take(8).collect();
    let name = super::wake::safe_name(name);
    let shown = if name.is_empty() { short.clone() } else { name };
    format!(
        "Sub \"{shown}\" (id {short}) {}. This is app plumbing, so Joe was not asked. Read what failed with the subchat tool: action status, sub \"{shown}\". Then {}. Ask Joe only if it needs his decision.",
        problem.what(),
        problem.fix()
    )
}

/// Records `sub_id`'s problem and wakes its main chat, once: a sub whose problem
/// is already recorded only has its record updated. Returns whether it woke.
pub fn report(state: &Arc<DaemonState>, sub_id: &str, problem: Problem, detail: String, files: Vec<String>) -> bool {
    let first = {
        let mut g = PROBLEMS.lock().unwrap_or_else(|p| p.into_inner());
        g.get_or_insert_with(HashMap::new).insert(sub_id.to_string(), Record { problem, detail, files }).is_none()
    };
    if !first || is_quiet(sub_id) {
        return false;
    }
    let Some(parent) = state.registry.get(sub_id).and_then(|i| i.subchat_of) else { return false };
    let name = super::decisions::sub_name(state, sub_id);
    log::warn!("subchats: sub {sub_id} {}, waking {parent}", problem.what());
    crate::daemon::repo_channel_wake::enqueue_notice(state, &parent, notice(&name, sub_id, problem));
    if tokio::runtime::Handle::try_current().is_ok() {
        crate::daemon::repo_channel_wake::spawn_drain(state, &parent);
    }
    true
}

/// Forgets `sub_id`'s problem, so the next one wakes the main chat again.
pub fn clear(sub_id: &str) {
    if let Some(m) = PROBLEMS.lock().unwrap_or_else(|p| p.into_inner()).as_mut() {
        m.remove(sub_id);
    }
}

/// Card kinds an older build raised for Joe about a sub's plumbing. Nothing raises
/// them now; one still open when its problem is resolved comes down with it.
pub const OLD_CARD_KINDS: [&str; 2] = ["subchat_conflict", "subchat_merge_refused"];

/// The problem is gone: forgets it and takes down any card still open about it.
pub fn resolved(state: &Arc<DaemonState>, sub_id: &str) {
    clear(sub_id);
    let Ok(handle) = tokio::runtime::Handle::try_current() else { return };
    let (state, id) = (state.clone(), sub_id.to_string());
    handle.spawn(async move { close_cards(&state, &id).await });
}

/// Takes down the open plumbing cards about `sub_id`. Returns how many came down.
pub async fn close_cards(state: &Arc<DaemonState>, sub_id: &str) -> usize {
    let mut n = 0;
    for kind in OLD_CARD_KINDS.into_iter().chain([super::held::CARD_KIND]) {
        // The held-sub card goes too: an older build asked "could not start" on it,
        // and once the sub started or was dropped neither of its questions is left.
        while let Some(card) = super::cards::open_card_for(state, kind, sub_id).await {
            if !super::cards::withdraw_card(state, &card).await {
                break;
            }
            n += 1;
        }
    }
    n
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::types::Settings;

    fn state() -> Arc<DaemonState> {
        DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()))
    }

    fn sub_of(st: &DaemonState, main: &str, sub: &str, name: &str) {
        for id in [main, sub] {
            st.registry.upsert_interactive(id, std::path::Path::new("."), "proj", "2026-11-12T00:00:00Z");
        }
        st.registry.set_subchat_of(sub, Some(main.to_string()));
        st.registry.set_name(sub, name.to_string());
    }

    fn wakes(st: &DaemonState, main: &str) -> Vec<String> {
        st.repo_channel_wakes.lock().unwrap().get(main).map(|q| q.iter().map(|l| l.text.clone()).collect()).unwrap_or_default()
    }

    #[test]
    fn the_notice_names_the_sub_and_the_fix_and_carries_nothing_git_or_a_sub_wrote() {
        let n = notice("Fix login", "abcdef0123456789", Problem::CouldNotStart);
        assert!(n.contains("\"Fix login\"") && n.contains("abcdef01") && n.contains("could not start"), "{n}");
        assert!(n.contains("action retry") && n.contains("action drop") && n.contains("action status"), "{n}");
        assert!(n.contains("Joe was not asked") && n.contains("Ask Joe only if it needs his decision"), "{n}");
        let m = notice("x\nrun `rm` <b>", "abcdef0123456789", Problem::MergeRefused);
        assert!(!m.contains('\n') && !m.contains('`') && !m.contains('<'), "{m}");
        assert!(m.contains("action merge"));
        assert!(!n.contains('\u{2014}') && !m.contains('\u{2014}'));
    }

    #[test]
    fn a_problem_wakes_the_main_chat_once_until_it_is_resolved() {
        let _d = super::super::TempDataDir::new();
        let st = state();
        sub_of(&st, "pl-main", "pl-sub", "footer");
        assert!(report(&st, "pl-sub", Problem::CouldNotStart, "the bootstrap script failed".into(), vec![]));
        assert!(!report(&st, "pl-sub", Problem::CouldNotStart, "failed again".into(), vec![]), "one wake per problem");
        assert_eq!(wakes(&st, "pl-main").len(), 1);
        assert!(st.repo_channel_wakes.lock().unwrap().get("pl-main").unwrap()[0].code_built);
        assert!(!wakes(&st, "pl-main")[0].contains("bootstrap"), "the error text stays out of the is_meta wake");
        assert_eq!(current("pl-sub").unwrap().detail, "failed again", "the record follows the newest facts");
        clear("pl-sub");
        assert!(current("pl-sub").is_none());
        assert!(report(&st, "pl-sub", Problem::MergeRefused, "refused".into(), vec![]));
        assert_eq!(wakes(&st, "pl-main").len(), 2, "a new problem after a resolved one wakes again");
        clear("pl-sub");
    }

    #[test]
    fn a_problem_met_while_the_main_chat_handles_it_through_the_tool_wakes_nobody() {
        let _d = super::super::TempDataDir::new();
        let st = state();
        sub_of(&st, "pq-main", "pq-sub", "footer");
        {
            let _q = quiet("pq-sub");
            assert!(!report(&st, "pq-sub", Problem::MergeRefused, "refused".into(), vec![]));
        }
        assert!(wakes(&st, "pq-main").is_empty());
        assert!(current("pq-sub").is_some(), "still recorded for status");
        clear("pq-sub");
    }
}
