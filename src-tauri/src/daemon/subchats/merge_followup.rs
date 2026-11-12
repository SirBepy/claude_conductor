//! What a refused worktree merge sets in motion. None of it raises a card for
//! Joe: a refused merge is app plumbing (Joe, 2026-11-12), so it is either fixed
//! by code or handed to the main chat (`plumbing`).
//!
//! - A conflict between the sub's commits and the target is the sub's to fix, so
//!   the first one is told to it at once, through [`super::continue_sub`], to
//!   rebase, resolve and finish again. A second conflict in a row, or a sub that
//!   could not be told, wakes the main chat.
//! - Uncommitted changes in the main checkout in a file the merge would change
//!   belong to another chat mid-edit, which nobody should be asked about: the
//!   merge is kept pending on disk (`pending_merges`) and the 60 second tick lands
//!   it, by the same code as `subchat merge`, once none of those files is dirty.
//! - Anything else (a switched branch, an ignored local file in the way, git
//!   refusing the fast-forward) wakes the main chat, which lands it with
//!   `subchat merge` once fixed, or leaves the commits on the branch with `drop`.
//!
//! Off the runtime: the merge runs on its own thread. [`super::worktree::defer`]
//! enters the runtime that called `on_finished` on that thread, which is what lets
//! the spawns below (and the ones in `held`, `closing` and `wake`) find one.

use super::brief::WorktreeInfo;
use super::card_log::{self, BlockerCard};
use super::pending_merges::{self, Cause as Pending};
use super::plumbing::{self, Problem};
use super::worktree::{self, Blocked, Cause, Landing};
use crate::daemon::state::DaemonState;
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::{Arc, Mutex};

/// Refused merges in a row per sub, counted from the first conflict until a
/// landing, the main chat's `drop` or the sub ending.
static CONFLICTS: Mutex<Option<HashMap<String, u32>>> = Mutex::new(None);

/// Subs told about the conflict that refused their merge, until it lands, is
/// dropped or the sub ends.
static TOLD: Mutex<Option<HashSet<String>>> = Mutex::new(None);

fn bump_conflicts(sub_id: &str) -> u32 {
    let mut g = CONFLICTS.lock().unwrap_or_else(|p| p.into_inner());
    let n = g.get_or_insert_with(HashMap::new).entry(sub_id.to_string()).or_insert(0);
    *n += 1;
    *n
}

fn set_told(sub_id: &str, on: bool) {
    let mut g = TOLD.lock().unwrap_or_else(|p| p.into_inner());
    let set = g.get_or_insert_with(HashSet::new);
    if on {
        set.insert(sub_id.to_string());
    } else {
        set.remove(sub_id);
    }
}

/// Whether `sub_id`'s commits were refused and have not landed or been dropped. A
/// sub waiting on it with `after` keeps waiting: starting on a base that did not
/// land would build on the wrong code. Read from `pending_merges`, so it holds
/// across a restart.
pub fn unresolved(sub_id: &str) -> bool {
    pending_merges::contains(sub_id)
}

/// Forgets a sub's refusal: its commits landed, the main chat left them, or the
/// sub ended.
pub fn forget(sub_id: &str) {
    if let Some(m) = CONFLICTS.lock().unwrap_or_else(|p| p.into_inner()).as_mut() {
        m.remove(sub_id);
    }
    set_told(sub_id, false);
    pending_merges::remove(sub_id);
    plumbing::clear(sub_id);
}

/// A landing that was not refused.
pub(super) fn on_landed(state: &Arc<DaemonState>, sub_id: &str) {
    forget(sub_id);
    plumbing::resolved(state, sub_id);
}

/// What a sub is told when its commits conflict with the target. Built here from
/// the branch names and file paths git reported, never from anything a sub wrote.
pub fn tell_text(info: &WorktreeInfo, files: &[String]) -> String {
    let list = if files.is_empty() { "the files git named".to_string() } else { files.join(", ") };
    format!(
        "Your commits could not be merged into {t}: branch {b} conflicts with it in {list}. In your worktree run git rebase {t}, resolve the conflicts, finish the rebase, commit, and call finish_subchat again: it merges when you finish. This is routine, so resolve it yourself and do not ask Joe unless a conflict is a real choice.",
        t = info.target,
        b = info.branch,
    )
}

/// Sends `text` to the sub as a new turn. In tests it records the call and the
/// text instead, so no `claude` is started.
async fn send_to_sub(state: &Arc<DaemonState>, sub_id: &str, text: &str) -> Result<(), String> {
    #[cfg(test)]
    {
        let _ = state;
        return test_support::send(sub_id, text);
    }
    #[cfg(not(test))]
    super::resume::continue_sub(state, sub_id, text).await.map_err(|e| e.to_string())
}

/// Handles a refused landing. Nothing here draws a card for Joe.
pub(super) fn on_blocked(state: &Arc<DaemonState>, sub_id: &str, info: &WorktreeInfo, b: &Blocked) {
    let pending = if b.cause == Cause::DirtyOverlap { Pending::DirtyFiles } else { Pending::Refused };
    pending_merges::store(sub_id, pending, b.points.clone());
    match b.cause {
        Cause::DirtyOverlap => {
            log::info!("subchats: the merge of {sub_id} waits for uncommitted files in the main checkout: {}", b.points.join(", "));
        }
        Cause::Conflict => {
            let first = bump_conflicts(sub_id) == 1;
            set_told(sub_id, false);
            match tokio::runtime::Handle::try_current() {
                Ok(handle) if first => {
                    // Out of "finished" now, not when the message lands: the next lines of
                    // finishing (a close waiting on its last sub, the "all finished" card)
                    // read the row, and this sub is working again.
                    state.registry.set_subchat_finished(sub_id, false);
                    crate::daemon::machines::publish_instances_changed(state);
                    set_told(sub_id, true);
                    let (state, id, info, files) = (state.clone(), sub_id.to_string(), info.clone(), b.points.clone());
                    handle.spawn(async move { tell(&state, &id, &info, &files).await });
                }
                _ => {
                    plumbing::report(state, sub_id, Problem::Conflict, b.text.clone(), b.points.clone());
                }
            }
        }
        Cause::BranchSwitched | Cause::Other => {
            plumbing::report(state, sub_id, Problem::MergeRefused, b.text.clone(), b.points.clone());
        }
    }
}

/// Tells the sub, and wakes the main chat if that did not work.
async fn tell(state: &Arc<DaemonState>, sub_id: &str, info: &WorktreeInfo, files: &[String]) {
    if let Err(e) = send_to_sub(state, sub_id, &tell_text(info, files)).await {
        log::warn!("subchats: could not tell {sub_id} to resolve its conflict: {e}");
        state.registry.set_subchat_finished(sub_id, true);
        crate::daemon::machines::publish_instances_changed(state);
        let detail = format!("Its commits conflict with {}, and it could not be told to resolve that: {e}.", info.target);
        plumbing::report(state, sub_id, Problem::Conflict, detail, files.to_vec());
    }
}

/// The main chat's `subchat drop` on a sub whose merge was refused: its commits
/// stay on its branch, nothing is pending for it any more, and whatever waited for
/// it goes on.
pub fn leave(state: &Arc<DaemonState>, sub_id: &str) {
    forget(sub_id);
    plumbing::resolved(state, sub_id);
    super::held::on_target_done(state);
}

/// The same landing the finish ran, by code, with no sub turn and no main-agent
/// turn. A refusal is handled inside `land_and_report` like any other; a landing
/// says so in the main chat's window, where the finish card said "not merged".
/// `None` when the sub has no worktree or the merge thread panicked.
async fn merge_again(state: &Arc<DaemonState>, sub_id: &str) -> Option<Landing> {
    let info = worktree::info_of(sub_id)?;
    let (st, id) = (state.clone(), sub_id.to_string());
    let landing = tokio::task::spawn_blocking(move || worktree::land_counted(&st, &id, &info)).await;
    match &landing {
        Ok(Landing::Merged) => {
            let target = worktree::info_of(sub_id).map(|i| i.target).unwrap_or_default();
            card_log::on_blocker(
                state,
                sub_id,
                BlockerCard {
                    text: format!("Its commits are now in {target}."),
                    verdict: "Merged".to_string(),
                    tone: Some("good".into()),
                    points: Vec::new(),
                },
            );
            super::held::on_target_done(state);
        }
        Ok(Landing::Nothing) => super::held::on_target_done(state),
        Ok(Landing::Blocked(_)) => {}
        Err(e) => log::warn!("subchats: the merge retry for {sub_id} panicked: {e}"),
    }
    landing.ok()
}

/// Whether the sub was told about the conflict that refused its merge: only the
/// first one in a row is, and only with a runtime to tell it on.
fn was_told(sub_id: &str) -> bool {
    TOLD.lock().unwrap_or_else(|p| p.into_inner()).as_ref().is_some_and(|s| s.contains(sub_id))
}

/// `subchat merge`: lands a finished worktree sub's commits now, by the code behind
/// the old "Merge again" card. `Ok` says what happened; `Err` says why nothing was
/// merged, in git's and the app's words (a tool result, so paths are fine here).
pub async fn merge_now(state: &Arc<DaemonState>, sub_id: &str) -> Result<String, String> {
    let inst = state.registry.get(sub_id).ok_or_else(|| format!("unknown session: {sub_id}"))?;
    let name = super::tool::label(&inst);
    let Some(info) = worktree::info_of(sub_id) else {
        return Err(format!("{name} has no worktree of its own, so there is nothing to merge: its edits are made in the main checkout."));
    };
    if inst.ended_at.is_some() || inst.end_reason.is_some() {
        return Err(format!("{name} has ended. Its commits, if any, are on branch {}.", info.branch));
    }
    if !inst.subchat_finished {
        return Err(format!("{name} has not finished: it merges by itself when it finishes."));
    }
    // A refusal is this call's result, not a wake.
    let _quiet = plumbing::quiet(sub_id);
    match merge_again(state, sub_id).await {
        Some(Landing::Merged) => Ok(format!("{name}'s commits are now in {}.", info.target)),
        Some(Landing::Nothing) => Ok(format!("{name}'s branch {} has nothing {} lacks, so there was nothing to merge.", info.branch, info.target)),
        Some(Landing::Blocked(b)) => {
            let files = if b.points.is_empty() { String::new() } else { format!(" Files: {}.", b.points.join(", ")) };
            let next = match b.cause {
                Cause::DirtyOverlap => " It stays pending and merges by itself once those files are committed in the main checkout.",
                Cause::Conflict if was_told(sub_id) => " The sub was told to rebase, resolve it and finish again.",
                Cause::Conflict => " Tell the sub to resolve it with action send.",
                _ => "",
            };
            Err(format!("Not merged: {}{files}{next}", b.text))
        }
        None => Err(format!("The merge of {name} did not run; the app log says why.")),
    }
}

/// Whether any of `files` (paths from the repo's top) is dirty in the main checkout
/// of `info`. A git failure counts as dirty: nothing is merged on a guess.
fn still_dirty(info: &WorktreeInfo, files: &[String]) -> bool {
    let repo = Path::new(&info.repo);
    let Some((true, top)) = super::git::run_git(repo, &["rev-parse", "--show-toplevel"]) else { return true };
    let top = String::from_utf8_lossy(&top).trim().to_string();
    let Some(dirty) = super::git::dirty_keys(repo) else { return true };
    files.iter().any(|f| dirty.contains(&super::git::path_key(&format!("{top}/{f}"))))
}

/// One pass of the 60 second tick over the pending merges: a sub that ended or lost
/// its worktree is forgotten, one that is working again is left to its next finish,
/// one refused for another reason is left to the sub or the main chat, and one
/// whose files are clean is landed by the same code as `subchat merge`.
/// Returns the subs whose merge was tried.
pub async fn retry_pending(state: &Arc<DaemonState>) -> Vec<String> {
    let mut tried = Vec::new();
    for p in pending_merges::all() {
        // A row this registry does not know is left alone: the watchdog's first tick
        // runs before boot restores the registry (`boot.rs`), and forgetting the
        // entry then would lose the merge.
        let Some(inst) = state.registry.get(&p.sub_id) else { continue };
        if inst.ended_at.is_some() || inst.end_reason.is_some() || worktree::info_of(&p.sub_id).is_none() {
            forget(&p.sub_id);
            continue;
        }
        if !inst.subchat_finished || p.cause != Pending::DirtyFiles {
            continue;
        }
        let Some(info) = worktree::info_of(&p.sub_id) else { continue };
        let files = p.files.clone();
        if tokio::task::spawn_blocking(move || still_dirty(&info, &files)).await.unwrap_or(true) {
            continue;
        }
        log::info!("subchats: the files that held up the merge of {} are clean, merging it", p.sub_id);
        merge_again(state, &p.sub_id).await;
        tried.push(p.sub_id);
    }
    tried
}

#[cfg(test)]
pub(crate) mod test_support {
    use std::collections::HashSet;
    use std::sync::Mutex;

    static SENT: Mutex<Vec<(String, String)>> = Mutex::new(Vec::new());
    static FAILING: Mutex<Option<HashSet<String>>> = Mutex::new(None);

    pub fn send(sub_id: &str, text: &str) -> Result<(), String> {
        if FAILING.lock().unwrap_or_else(|p| p.into_inner()).as_ref().is_some_and(|s| s.contains(sub_id)) {
            return Err("it has been ended and cannot continue".to_string());
        }
        SENT.lock().unwrap_or_else(|p| p.into_inner()).push((sub_id.to_string(), text.to_string()));
        Ok(())
    }

    /// Every text sent to `sub_id` so far, oldest first.
    pub fn sent_to(sub_id: &str) -> Vec<String> {
        SENT.lock().unwrap_or_else(|p| p.into_inner()).iter().filter(|(s, _)| s == sub_id).map(|(_, t)| t.clone()).collect()
    }

    pub fn fail_for(sub_id: &str) {
        FAILING.lock().unwrap_or_else(|p| p.into_inner()).get_or_insert_with(HashSet::new).insert(sub_id.to_string());
    }

    /// What a restart loses: the in-memory refusal state.
    pub fn forget_memory(sub_id: &str) {
        super::set_told(sub_id, false);
        if let Some(m) = super::CONFLICTS.lock().unwrap_or_else(|p| p.into_inner()).as_mut() {
            m.remove(sub_id);
        }
        crate::daemon::subchats::plumbing::clear(sub_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::daemon::subchats::cards::{self, CardOption, RaisedCard};
    use crate::daemon::subchats::git::test_repo;
    use crate::daemon::subchats::worktree::Prepare;
    use crate::daemon::subchats::{SubchatBrief, TempDataDir};
    use crate::sessions::chat_config;
    use crate::types::Settings;
    use std::path::{Path, PathBuf};

    const TS: &str = "2026-11-05T00:00:00Z";

    fn state() -> Arc<DaemonState> {
        DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()))
    }

    fn g(dir: &Path, args: &[&str]) {
        test_repo::git(dir, args);
    }

    fn commit_file(dir: &Path, name: &str, body: &str) {
        std::fs::write(dir.join(name), body).unwrap();
        g(dir, &["add", name]);
        g(dir, &["commit", "-q", "-m", &format!("edit {name}")]);
    }

    /// A finished worktree sub of a main chat at `root`: its row, its brief, a real
    /// worktree, and the finished flag the way a committed finish leaves it.
    fn finished_sub(st: &Arc<DaemonState>, tag: &str, root: &Path) -> (String, String, WorktreeInfo) {
        let sid = uuid::Uuid::new_v4().to_string();
        let Ok(Prepare::Ready(p)) = worktree::prepare(root, &sid) else { panic!("a scratch repo can have a worktree") };
        let main = format!("{tag}-main");
        st.registry.upsert_interactive(&main, root, "proj", TS);
        st.registry.upsert_interactive(&sid, Path::new(&p.info.cwd), "proj", TS);
        st.registry.set_subchat_of(&sid, Some(main.clone()));
        st.registry.set_name(&sid, tag.to_string());
        let mut brief: SubchatBrief = serde_json::from_str(r#"{"parent":"m","task":"t","goal":"g","done_when":"d","writes":true,"files":["a.txt"]}"#).unwrap();
        brief.parent = main.clone();
        brief.worktree_at = Some(p.info.clone());
        brief.git_head_at_spawn = crate::daemon::subchats::git::head(Path::new(&p.info.cwd));
        chat_config::set_subchat(&sid, Some(brief));
        st.registry.set_subchat_finished(&sid, true);
        (main, sid, p.info)
    }

    /// `land_and_report` the way `defer` runs it: on a thread that is not the runtime's,
    /// with the runtime entered.
    async fn land(st: &Arc<DaemonState>, id: &str, info: &WorktreeInfo) -> Landing {
        let (st, id, info) = (st.clone(), id.to_string(), info.clone());
        tokio::task::spawn_blocking(move || worktree::land_and_report(&st, &id, &info)).await.unwrap()
    }

    async fn until(mut done: impl FnMut() -> bool) -> bool {
        for _ in 0..400 {
            if done() {
                return true;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        false
    }

    fn blockers(main: &str) -> Vec<crate::daemon::subchats::card_log::CardEntry> {
        card_log::read(main).into_iter().filter(|c| c.kind == card_log::KIND_BLOCKER).collect()
    }

    /// The main chat's queued wakes, oldest first.
    fn wakes(st: &DaemonState, main: &str) -> Vec<String> {
        st.repo_channel_wakes.lock().unwrap().get(main).map(|q| q.iter().map(|l| l.text.clone()).collect()).unwrap_or_default()
    }

    fn conflicting(root: &Path, info: &WorktreeInfo) {
        commit_file(Path::new(&info.path), "base.txt", "sub's line\n");
        commit_file(root, "base.txt", "peer's line\n");
    }

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap()
    }

    fn read(path: &Path) -> String {
        std::fs::read_to_string(path).unwrap_or_default().replace("\r\n", "\n")
    }

    /// The first real run: the card said "Tell the sub to ..." and nobody did. Now
    /// the sub is told, and neither Joe nor the main chat hears of it.
    #[test]
    fn a_conflict_tells_the_sub_at_once_and_bothers_nobody_else() {
        let _data = TempDataDir::new();
        rt().block_on(async {
            let (_d, root) = test_repo::init();
            let st = state();
            let (main, id, info) = finished_sub(&st, "told", &root);
            conflicting(&root, &info);

            let landing = land(&st, &id, &info).await;
            assert!(matches!(landing, Landing::Blocked(ref b) if b.cause == Cause::Conflict));
            assert!(until(|| !test_support::sent_to(&id).is_empty()).await, "the sub was never told");
            let sent = test_support::sent_to(&id);
            assert_eq!(sent.len(), 1);
            for needle in [info.branch.as_str(), info.target.as_str(), "base.txt", "git rebase", "finish_subchat"] {
                assert!(sent[0].contains(needle), "{needle:?} missing: {}", sent[0]);
            }
            assert!(!st.registry.get(&id).unwrap().subchat_finished, "it is working on it again");
            assert!(unresolved(&id));
            assert!(blockers(&main).is_empty(), "no card in Joe's window");
            assert!(st.list_prompts().await.is_empty(), "and no question");
            assert!(wakes(&st, &main).is_empty(), "the sub handles it, so the main chat is not woken");
        });
    }

    /// The sub resolves it and finishes again: that lands, and the memory of the conflict goes.
    #[test]
    fn a_resolved_conflict_lands_on_the_next_finish_and_clears_the_count() {
        let _data = TempDataDir::new();
        rt().block_on(async {
            let (_d, root) = test_repo::init();
            let st = state();
            let (main, id, info) = finished_sub(&st, "resolved", &root);
            conflicting(&root, &info);
            land(&st, &id, &info).await;
            assert!(unresolved(&id));
            let wt = PathBuf::from(&info.path);
            let target = format!("refs/heads/{}", info.target);
            assert!(crate::daemon::subchats::git::run_git(&wt, &["rebase", &target]).is_some_and(|(ok, _)| !ok));
            std::fs::write(wt.join("base.txt"), "resolved\n").unwrap();
            g(&wt, &["add", "base.txt"]);
            g(&wt, &["-c", "core.editor=true", "rebase", "--continue"]);
            assert_eq!(land(&st, &id, &info).await, Landing::Merged);
            assert!(!unresolved(&id));
            // A later conflict starts the count again: the sub is told, the main chat is not woken.
            commit_file(&wt, "base.txt", "again\n");
            commit_file(&root, "base.txt", "peer again\n");
            land(&st, &id, &info).await;
            assert!(until(|| test_support::sent_to(&id).len() == 2).await);
            assert!(wakes(&st, &main).is_empty());
        });
    }

    /// Fails on the old code, which raised a "Merge conflict" card for Joe.
    #[test]
    fn a_second_conflict_in_a_row_wakes_the_main_chat_once_and_raises_no_card() {
        let _data = TempDataDir::new();
        rt().block_on(async {
            let (_d, root) = test_repo::init();
            let st = state();
            let (main, id, info) = finished_sub(&st, "twice", &root);
            conflicting(&root, &info);
            land(&st, &id, &info).await;
            assert!(until(|| test_support::sent_to(&id).len() == 1).await);
            // It finishes again without having fixed it, twice.
            st.registry.set_subchat_finished(&id, true);
            land(&st, &id, &info).await;
            st.registry.set_subchat_finished(&id, true);
            land(&st, &id, &info).await;

            assert!(st.list_prompts().await.is_empty(), "no card for Joe");
            let woken = wakes(&st, &main);
            assert_eq!(woken.len(), 1, "one wake per problem: {woken:?}");
            assert!(woken[0].contains("conflict") && woken[0].contains("action send") && woken[0].contains("action merge"), "{}", woken[0]);
            let rec = plumbing::current(&id).expect("status can show it");
            assert_eq!((rec.problem, rec.files), (Problem::Conflict, vec!["base.txt".to_string()]));
            assert_eq!(test_support::sent_to(&id).len(), 1, "the sub is told only the first time");
            assert!(unresolved(&id), "a sub waiting for it keeps waiting");
        });
    }

    #[test]
    fn dropping_a_refused_merge_forgets_it_and_lets_a_sub_waiting_behind_it_go() {
        let _data = TempDataDir::new();
        rt().block_on(async {
            let (_d, root) = test_repo::init();
            let st = state();
            let (_main, id, info) = finished_sub(&st, "leave", &root);
            conflicting(&root, &info);
            land(&st, &id, &info).await;
            st.registry.set_subchat_finished(&id, true);
            land(&st, &id, &info).await;
            assert!(unresolved(&id) && plumbing::current(&id).is_some());
            leave(&st, &id);
            assert!(!unresolved(&id) && plumbing::current(&id).is_none());
            assert_eq!(test_support::sent_to(&id).len(), 1, "the sub is not told again");
            assert!(st.registry.get(&id).unwrap().subchat_finished);
        });
    }

    #[test]
    fn a_sub_that_cannot_be_told_wakes_the_main_chat_instead_and_stays_finished() {
        let _data = TempDataDir::new();
        rt().block_on(async {
            let (_d, root) = test_repo::init();
            let st = state();
            let (main, id, info) = finished_sub(&st, "untold", &root);
            test_support::fail_for(&id);
            conflicting(&root, &info);
            land(&st, &id, &info).await;
            assert!(until(|| plumbing::current(&id).is_some()).await, "the main chat is handed it");
            let rec = plumbing::current(&id).unwrap();
            assert!(rec.detail.contains("could not be told") && rec.detail.contains("cannot continue"), "{}", rec.detail);
            assert_eq!(wakes(&st, &main).len(), 1);
            assert!(st.list_prompts().await.is_empty());
            assert!(st.registry.get(&id).unwrap().subchat_finished, "it did not start working");
        });
    }

    /// Another chat's uncommitted edits in the same file: nobody is asked, the merge
    /// waits, and the tick lands it once the file is clean, with no sub turn. Fails on
    /// the old code, which raised a "Not merged" card for Joe.
    #[test]
    fn a_dirty_overlap_raises_nothing_and_the_tick_lands_it_once_the_files_are_clean() {
        let _data = TempDataDir::new();
        rt().block_on(async {
            let (_d, root) = test_repo::init();
            let st = state();
            let (main, id, info) = finished_sub(&st, "dirty", &root);
            commit_file(Path::new(&info.path), "base.txt", "the sub's version\n");
            std::fs::write(root.join("base.txt"), "mine, not committed\n").unwrap();

            let landing = land(&st, &id, &info).await;
            assert!(matches!(landing, Landing::Blocked(ref b) if b.cause == Cause::DirtyOverlap));
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            assert!(st.list_prompts().await.is_empty(), "no card for Joe");
            assert!(blockers(&main).is_empty(), "not even a passive one");
            assert!(wakes(&st, &main).is_empty(), "and the main chat is not woken");
            assert!(plumbing::current(&id).is_none());
            assert_eq!(pending_merges::get(&id).unwrap().files, vec!["base.txt".to_string()]);
            assert!(unresolved(&id), "a sub waiting for it keeps waiting");

            // Still dirty: the tick leaves it alone and touches nothing.
            assert!(retry_pending(&st).await.is_empty());
            assert_eq!(std::fs::read(root.join("base.txt")).unwrap(), b"mine, not committed\n", "not a byte of it was touched");

            // The other chat commits or reverts its edit; the next tick lands it.
            g(&root, &["checkout", "-q", "--", "base.txt"]);
            assert_eq!(retry_pending(&st).await, vec![id.clone()]);
            assert_eq!(read(&root.join("base.txt")), "the sub's version\n", "merged into the main checkout");
            assert!(!unresolved(&id) && !pending_merges::contains(&id));
            assert!(test_support::sent_to(&id).is_empty(), "no sub turn at any point");
            assert!(wakes(&st, &main).is_empty(), "no main-chat turn either");
            assert!(blockers(&main).iter().any(|b| b.verdict == "Merged"), "the window says it landed");
        });
    }

    /// The pending merge is on disk: a restart neither forgets it nor lets a sub that
    /// waits for it start on a base that did not land.
    #[test]
    fn a_pending_merge_survives_a_restart_and_lands_after_it() {
        let _data = TempDataDir::new();
        rt().block_on(async {
            let (_d, root) = test_repo::init();
            let before = state();
            let (_main, id, info) = finished_sub(&before, "restart", &root);
            commit_file(Path::new(&info.path), "base.txt", "the sub's version\n");
            std::fs::write(root.join("base.txt"), "mine, not committed\n").unwrap();
            land(&before, &id, &info).await;
            crate::daemon::subchats::held::test_support::finish_record(&id, "Done", None);
            crate::sessions::persistence::save_snapshot_default(&before.registry);

            // A new process: the memory is gone, the registry comes back from the snapshot.
            test_support::forget_memory(&id);
            let after = state();
            let path = crate::settings::paths::interactive_sessions_file().unwrap();
            crate::sessions::persistence::populate_registry(&after.registry, crate::sessions::persistence::load_snapshot(&path));
            assert!(after.registry.get(&id).is_some_and(|i| i.subchat_finished));
            assert!(unresolved(&id), "still pending after the restart");
            assert_eq!(crate::daemon::subchats::held::after_state(&after, &id), crate::daemon::subchats::held::AfterState::Pending);

            g(&root, &["checkout", "-q", "--", "base.txt"]);
            assert_eq!(retry_pending(&after).await, vec![id.clone()]);
            assert_eq!(read(&root.join("base.txt")), "the sub's version\n");
            assert_eq!(crate::daemon::subchats::held::after_state(&after, &id), crate::daemon::subchats::held::AfterState::Clean);
        });
    }

    #[test]
    fn a_pending_merge_of_a_sub_that_ended_is_forgotten_and_one_working_again_is_left_to_its_finish() {
        let _data = TempDataDir::new();
        rt().block_on(async {
            let (_d, root) = test_repo::init();
            let st = state();
            let (_main, id, info) = finished_sub(&st, "working", &root);
            commit_file(Path::new(&info.path), "base.txt", "sub\n");
            std::fs::write(root.join("base.txt"), "dirty\n").unwrap();
            land(&st, &id, &info).await;
            g(&root, &["checkout", "-q", "--", "base.txt"]);
            st.registry.set_subchat_finished(&id, false);
            assert!(retry_pending(&st).await.is_empty(), "a sub working again merges when it finishes");
            assert!(pending_merges::contains(&id));
            st.registry.mark_ended(&id, crate::types::EndReason::Manual, TS);
            assert!(retry_pending(&st).await.is_empty());
            assert!(!pending_merges::contains(&id) && !unresolved(&id));
        });
    }

    /// A switched branch wakes the main chat (fails on the old code, a card for Joe),
    /// and `subchat merge` lands it once it is switched back.
    #[test]
    fn a_switched_branch_wakes_the_main_chat_and_merge_now_lands_it_once_switched_back() {
        let _data = TempDataDir::new();
        rt().block_on(async {
            let (_d, root) = test_repo::init();
            let st = state();
            let (main, id, info) = finished_sub(&st, "switched", &root);
            commit_file(Path::new(&info.path), "a.txt", "sub\n");
            g(&root, &["checkout", "-q", "-b", "elsewhere"]);
            let landing = land(&st, &id, &info).await;
            assert!(matches!(landing, Landing::Blocked(ref b) if b.cause == Cause::BranchSwitched));
            assert!(st.list_prompts().await.is_empty(), "no card for Joe");
            let woken = wakes(&st, &main);
            assert_eq!(woken.len(), 1);
            assert!(woken[0].contains("merge of its commits was refused") && woken[0].contains("action merge"), "{}", woken[0]);
            assert!(!woken[0].contains("elsewhere"), "git's words stay out of the wake");
            assert_eq!(plumbing::current(&id).unwrap().problem, Problem::MergeRefused);
            assert!(plumbing::current(&id).unwrap().detail.contains("elsewhere"), "status shows them");

            // Still switched: the tool says why and wakes nobody again.
            let err = merge_now(&st, &id).await.unwrap_err();
            assert!(err.starts_with("Not merged") && err.contains("elsewhere"), "{err}");
            assert_eq!(wakes(&st, &main).len(), 1);
            // A restart keeps the refusal: a sub waiting for it keeps waiting.
            test_support::forget_memory(&id);
            assert!(unresolved(&id));
            assert!(retry_pending(&st).await.is_empty(), "the tick never retries a refusal only the main chat can clear");

            g(&root, &["checkout", "-q", &info.target]);
            let ok = merge_now(&st, &id).await.unwrap();
            assert!(ok.contains("now in"), "{ok}");
            assert!(root.join("a.txt").is_file(), "merged after switching back");
            assert!(plumbing::current(&id).is_none() && !unresolved(&id));
            assert!(test_support::sent_to(&id).is_empty(), "no sub turn");
        });
    }

    #[test]
    fn merge_now_refuses_a_sub_that_is_still_working_or_has_no_worktree() {
        let _data = TempDataDir::new();
        rt().block_on(async {
            let (_d, root) = test_repo::init();
            let st = state();
            let (_main, id, _info) = finished_sub(&st, "busy", &root);
            st.registry.set_subchat_finished(&id, false);
            assert!(merge_now(&st, &id).await.unwrap_err().contains("has not finished"));
            st.registry.upsert_interactive("plain-sub", &root, "proj", TS);
            crate::daemon::subchats::store_sub_brief("plain-sub", "busy-main");
            assert!(merge_now(&st, "plain-sub").await.unwrap_err().contains("no worktree"));
        });
    }

    /// A card an older build raised about a refused merge comes down once it lands.
    #[test]
    fn an_open_plumbing_card_closes_when_its_merge_lands() {
        let _data = TempDataDir::new();
        rt().block_on(async {
            let (_d, root) = test_repo::init();
            let st = state();
            let (main, id, info) = finished_sub(&st, "oldcard", &root);
            commit_file(Path::new(&info.path), "a.txt", "sub\n");
            let card = RaisedCard {
                kind: plumbing::OLD_CARD_KINDS[1],
                display_session_id: main.clone(),
                sub_id: Some(id.clone()),
                header: "Not merged".into(),
                question: "Merge again?".into(),
                options: vec![CardOption::new("Merge again", "x"), CardOption::new("Leave it", "y")],
                domain: None,
            };
            let _h = cards::raise_card(&st, card).await.unwrap();
            assert!(cards::open_card_for(&st, plumbing::OLD_CARD_KINDS[1], &id).await.is_some());
            merge_now(&st, &id).await.unwrap();
            let mut gone = false;
            for _ in 0..400 {
                if st.list_prompts().await.is_empty() {
                    gone = true;
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
            assert!(gone, "the card came down");
        });
    }

    /// A sub that waits for this one must not start on a base that did not land.
    #[test]
    fn a_sub_with_an_unresolved_refusal_is_not_a_clean_target_for_after() {
        let _data = TempDataDir::new();
        rt().block_on(async {
            let (_d, root) = test_repo::init();
            let st = state();
            let (_main, id, info) = finished_sub(&st, "after-target", &root);
            crate::daemon::subchats::held::test_support::finish_record(&id, "Done", None);
            assert_eq!(crate::daemon::subchats::held::after_state(&st, &id), crate::daemon::subchats::held::AfterState::Clean);
            commit_file(Path::new(&info.path), "base.txt", "sub\n");
            std::fs::write(root.join("base.txt"), "dirty\n").unwrap();
            land(&st, &id, &info).await;
            assert_eq!(crate::daemon::subchats::held::after_state(&st, &id), crate::daemon::subchats::held::AfterState::Pending);
            forget(&id);
            assert_eq!(crate::daemon::subchats::held::after_state(&st, &id), crate::daemon::subchats::held::AfterState::Clean);
        });
    }

    /// The first end-to-end run: `after` started 52 seconds after its target finished,
    /// when the 60 second tick caught it. A worktree sub finishes through the merge
    /// thread, which had no runtime to spawn the start on. Here the real order runs:
    /// the finish, the merge on its thread, the rest of finishing, and the sweep.
    #[test]
    fn finishing_a_worktree_sub_starts_the_sub_waiting_for_it_at_once() {
        use crate::daemon::subchats::held::{self, Held, LaunchSpec};
        let _data = TempDataDir::new();
        rt().block_on(async {
            let (_d, root) = test_repo::init();
            let st = state();
            let (main, target, info) = finished_sub(&st, "after-1", &root);
            commit_file(Path::new(&info.path), "a.txt", "from after-1\n");
            // after-2 is registered and held behind it, with a folder that does not exist
            // so the start it is given fails before any child is spawned: the main chat
            // being told it could not start is the proof that the start was attempted.
            let waiting = format!("after-2-{}", uuid::Uuid::new_v4());
            st.registry.upsert_interactive(&waiting, &root, "proj", TS);
            st.registry.set_subchat_of(&waiting, Some(main.clone()));
            st.registry.set_name(&waiting, "after-2".to_string());
            crate::daemon::subchats::store_sub_brief(&waiting, &main);
            held::hold(
                &st,
                Held {
                    sub_id: waiting.clone(),
                    reason: "waiting for after-1".into(),
                    after: Some(target.clone()),
                    after_name: "after-1".into(),
                    launch: LaunchSpec {
                        cwd: root.join("does-not-exist"),
                        model: "sonnet".into(),
                        effort: "medium".into(),
                        account_id: None,
                        first_message: "go".into(),
                    },
                },
            )
            .unwrap();
            assert!(held::is_held(&waiting));

            // The sweep is the only thing that can start it here, and the 60 second
            // tick is not running: if the start shows up at all it came from the finish.
            crate::daemon::subchats::on_finished(&st, &target);
            assert!(
                until(|| plumbing::current(&waiting).is_some_and(|r| r.problem == Problem::CouldNotStart)).await,
                "the waiting sub was not started by the finish"
            );
            assert!(st.list_prompts().await.is_empty(), "its failed start is not Joe's card");
            assert_eq!(crate::daemon::subchats::git::head(&root), crate::daemon::subchats::git::head(Path::new(&info.path)), "and what it waited for had landed");
            plumbing::clear(&waiting);
        });
    }

    /// Without a runtime nobody can tell the sub, so the main chat is woken instead.
    #[test]
    fn with_no_runtime_a_conflict_wakes_the_main_chat_and_draws_no_card() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        let st = state();
        let (main, id, info) = finished_sub(&st, "plain-thread", &root);
        conflicting(&root, &info);
        worktree::land_and_report(&st, &id, &info);
        assert!(blockers(&main).is_empty());
        assert_eq!(wakes(&st, &main).len(), 1);
        assert!(test_support::sent_to(&id).is_empty());
    }
}
