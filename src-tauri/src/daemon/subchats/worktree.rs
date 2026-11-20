//! Every sub that edits files gets its own git worktree and branch, so writers
//! run side by side and the main checkout stays free for the merges (spec
//! section 7, Joe 2026-11-12). A read-only sub and a gate sub stay on the main
//! checkout, and so does a writer in a folder that cannot have a worktree.
//!
//! Life of a worktree sub:
//! 1. Spawn: [`plan_spawn`] makes `<repo>/.claude/worktrees/sub-<id>/` and adds the
//!    worktree as its `tree/`, on a new branch off the main checkout's `HEAD`.
//!    Beside the tree, `.cargo/config.toml` points cargo at `sub-<id>/target`: a
//!    shared target dir keeps one copy of the project's own crates per tree path
//!    that nothing ever frees (about 3GB each, 112GB on 2026-11-12). The sub's
//!    `cwd` is the tree (plus the project's own subfolder in a monorepo) and the
//!    [`WorktreeInfo`] is stored in its brief, so a restart finds the same tree.
//! 2. Launch: [`before_launch`] runs the repo's `scripts/bootstrap-worktree.ps1`
//!    when there is one, else links the main checkout's `node_modules`. It runs
//!    from the held-sub launch, off the main chat's turn, and a failure draws a
//!    `blocker` card instead of starting a sub in a broken tree.
//! 3. Continue: a finished sub keeps its worktree, because the CLI keeps a
//!    chat's transcript under its cwd. [`before_continue`] brings its branch up to
//!    date with the target by code before the message is sent.
//! 4. Finish: [`defer`] merges the sub's commits into the branch the main
//!    checkout has checked out (rebase inside the worktree, then fast-forward
//!    the target), before the finish card is drawn so the card says what landed.
//!    A refusal draws a `blocker` card naming the cause and loses nothing.
//! 5. End: [`on_ended`] removes the worktree, its branch and its build folder when
//!    the commits are merged and nothing is uncommitted, and keeps it (with a
//!    card) otherwise. [`restore`] retries that at boot for subs that ended while
//!    the daemon was down or whose removal failed.
//!
//! The main checkout belongs to Joe and to other chats. The merge never stashes,
//! resets or checks out there: it asks git for `merge --ff-only`, after naming
//! any overlap between the files it would change and the files already dirty, so
//! someone else's uncommitted bytes are never touched.

use super::brief::{SubchatBrief, WorktreeInfo};
use super::card_log::{self, BlockerCard};
use super::git::{self, path_key};
use super::{build_base, build_target, worktree_safety};
use crate::daemon::state::DaemonState;
use crate::settings::identity::project_key;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

mod create;
mod setup;
mod update;
mod land;
mod sweep;
pub use create::*;
pub use setup::*;
pub(crate) use update::*;
pub use land::*;
pub(super) use sweep::*;

/// What a worktree sub's row says while its tree is being set up.
pub const SETUP_TEXT: &str = "setting up its worktree";

/// The longest a repo's bootstrap script may run.
const SETUP_LIMIT: Duration = Duration::from_secs(15 * 60);

/// Folder under the repo that holds the sub worktrees. Excluded locally so the
/// main checkout's `git status` and a careless `git add -A` never see it.
const WORKTREES_DIR: &str = ".claude/worktrees";

/// The worktree's folder inside its holder `sub-<id>/`.
const TREE_DIR: &str = "tree";

/// File in the holder that says the sub was closed and its tree may go.
const CLOSED_MARK: &str = "closed";

/// Whether a spawn with this brief gets its own worktree: every writer except a
/// gate, which pushes from the main checkout. The brief's old `worktree` flag
/// and the project's old "Subs changing files" value are no longer read.
pub fn wants(brief: &SubchatBrief) -> bool {
    brief.writes && !brief.gate
}

/// The worktree `sub_id` runs in, from its stored brief.
pub fn info_of(sub_id: &str) -> Option<WorktreeInfo> {
    crate::sessions::chat_config::get(sub_id)?.subchat?.worktree_at
}

// ---- git ------------------------------------------------------------------------

pub(super) struct Out {
    pub(super) ok: bool,
    pub(super) out: String,
    pub(super) err: String,
}

impl Out {
    pub(super) fn lines(&self) -> Vec<String> {
        self.out.lines().map(str::trim).filter(|l| !l.is_empty()).map(str::to_string).collect()
    }
}

/// Runs git in `cwd` with the console hidden and no prompt or editor. Stdout
/// keeps leading blanks (a porcelain line starts with one).
pub(super) fn run(cwd: &Path, args: &[&str]) -> Out {
    let mut cmd = std::process::Command::new("git");
    cmd.arg("-C").arg(cwd).args(args).env("GIT_TERMINAL_PROMPT", "0").env("GIT_EDITOR", "true");
    crate::util::process::hide_console(&mut cmd);
    match cmd.output() {
        Ok(o) => Out {
            ok: o.status.success(),
            out: String::from_utf8_lossy(&o.stdout).trim_end_matches(['\n', '\r']).to_string(),
            err: String::from_utf8_lossy(&o.stderr).trim().to_string(),
        },
        Err(e) => Out { ok: false, out: String::new(), err: format!("could not run git: {e}") },
    }
}

pub(super) fn short(text: &str, max: usize) -> String {
    let one: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if one.chars().count() <= max {
        one
    } else {
        format!("{}...", one.chars().take(max).collect::<String>())
    }
}

fn branch_ref(name: &str) -> String {
    format!("refs/heads/{name}")
}

pub(super) fn current_branch(dir: &Path) -> Option<String> {
    let o = run(dir, &["symbolic-ref", "--short", "-q", "HEAD"]);
    (o.ok && !o.out.trim().is_empty()).then(|| o.out.trim().to_string())
}

fn count(dir: &Path, range: &str) -> Option<u32> {
    let o = run(dir, &["rev-list", "--count", range]);
    o.ok.then(|| o.out.trim().parse().ok()).flatten()
}

pub(super) fn is_ancestor(dir: &Path, ancestor: &str, descendant: &str) -> bool {
    run(dir, &["merge-base", "--is-ancestor", ancestor, descendant]).ok
}

fn branch_exists(dir: &Path, name: &str) -> bool {
    run(dir, &["rev-parse", "--verify", "--quiet", &branch_ref(name)]).ok
}

// ---- per-repo locks and the merges in flight --------------------------------------

static LOCKS: Mutex<Option<HashMap<String, Arc<Mutex<()>>>>> = Mutex::new(None);
static IN_FLIGHT: Mutex<Option<HashMap<String, usize>>> = Mutex::new(None);

/// One lock per repo: two subs finishing together must not rebase and
/// fast-forward over each other.
pub(super) fn repo_lock(repo: &Path) -> Arc<Mutex<()>> {
    let mut guard = LOCKS.lock().unwrap_or_else(|p| p.into_inner());
    guard.get_or_insert_with(HashMap::new).entry(project_key(repo)).or_default().clone()
}

/// One merge counted as in flight for a repo, released when dropped. A drop guard
/// so a panic in the merge, or a merge thread that never started (its closure is
/// dropped unrun), cannot leave [`merging`] true until the daemon restarts, which
/// kept a queued gate from ever starting.
#[must_use = "the merge counts as in flight only while this is held"]
pub(super) struct MergeGuard(String);

impl Drop for MergeGuard {
    fn drop(&mut self) {
        end_merge(&self.0);
    }
}

fn begin_merge(key: &str) -> MergeGuard {
    let mut guard = IN_FLIGHT.lock().unwrap_or_else(|p| p.into_inner());
    *guard.get_or_insert_with(HashMap::new).entry(key.to_string()).or_insert(0) += 1;
    MergeGuard(key.to_string())
}

fn end_merge(key: &str) {
    let mut guard = IN_FLIGHT.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(map) = guard.as_mut() {
        if let Some(n) = map.get_mut(key) {
            *n = n.saturating_sub(1);
            if *n == 0 {
                map.remove(key);
            }
        }
    }
}

#[cfg(test)]
pub(crate) fn begin_merge_for_test(key: &str) {
    // Held until `end_merge_for_test`, which a test calls by hand.
    std::mem::forget(begin_merge(key));
}

#[cfg(test)]
pub(crate) fn end_merge_for_test(key: &str) {
    end_merge(key);
}

/// Whether a finished worktree sub of the repo with this project key is still
/// being merged. A gate sub waits for this before it starts (`writers`).
pub fn merging(project_key: &str) -> bool {
    IN_FLIGHT.lock().unwrap_or_else(|p| p.into_inner()).as_ref().is_some_and(|m| m.contains_key(project_key))
}

// ---- before a start or a continue -----------------------------------------------------------

/// Words for a branch that could not be brought up to date.
fn update_blocker(info: &WorktreeInfo, update: Update) -> Option<Blocked> {
    match update {
        Update::Done => None,
        Update::Conflict(files) => match conflict_landing(info, files) {
            Landing::Blocked(b) => Some(b),
            _ => None,
        },
        Update::Failed(why) => Some(Blocked {
            verdict: "Not up to date",
            text: format!("Its branch could not be brought up to date with {}: {why}. It carries on from where it was, and its worktree keeps every commit.", info.target),
            points: Vec::new(),
            cause: Cause::Other,
        }),
    }
}

/// A continued sub's first step: its branch is brought up to date with the target
/// before its message is sent. A conflict does not stop the message (the sub is
/// the one who resolves it); like any failure here it wakes the main chat
/// (`plumbing`), never a card for Joe.
pub async fn before_continue(state: &Arc<DaemonState>, sub_id: &str) {
    let Some(info) = info_of(sub_id) else { return };
    // A closed sub brought back is not closed any more: the boot sweep must not
    // take its tree the next time its row ends some other way.
    if let Some(holder) = holder_of(&info) {
        let _ = std::fs::remove_file(holder.join(CLOSED_MARK));
    }
    // A visiting sub's target is a branch of its home machine, which this clone
    // need not have: the home brings the branch up to date itself (`sub_update_branch`).
    if super::is_visiting(sub_id) {
        // Still counted, so a build folder delete that began before this continue skips
        // itself (and one running now finishes first), as for any other sub.
        let id = sub_id.to_string();
        let _ = tokio::task::spawn_blocking(move || note_continued(&id)).await;
        return;
    }
    let id = sub_id.to_string();
    let blocker = tokio::task::spawn_blocking(move || {
        // Before anything else, and off the async thread: it can wait on a delete.
        note_continued(&id);
        let lock = repo_lock(Path::new(&info.repo));
        let _held = lock.lock().unwrap_or_else(|p| p.into_inner());
        let update = update_branch(&id, &info);
        update_blocker(&info, update)
    })
    .await
    .unwrap_or(None);
    if let Some(b) = blocker {
        // The sub was just told about this very conflict and is continuing to
        // resolve it, so a card saying "tell the sub" would only repeat itself.
        if b.cause == Cause::Conflict && super::merge_followup::was_told(sub_id) {
            return;
        }
        super::plumbing::report(state, sub_id, super::plumbing::Problem::NotUpToDate, b.text, b.points);
    }
}

/// Runs in the held launch, before the child starts: sets the tree up and brings
/// its branch up to date. `Err` stops the launch, so a sub never runs in a tree
/// that is not ready; the launch's caller hands the error to the main chat.
pub async fn before_launch(state: &Arc<DaemonState>, sub_id: &str) -> Result<(), String> {
    let Some(info) = info_of(sub_id) else { return Ok(()) };
    let setup_info = info.clone();
    let setup = tokio::task::spawn_blocking(move || ensure_setup(&setup_info)).await.unwrap_or_else(|e| Err(e.to_string()));
    // The setup can take minutes, and the sub may have ended meanwhile (its main
    // chat gone, Joe's End it), which removes the tree it was just given: a failed
    // setup or a missing tree is then no problem to report to a chat that has
    // nothing to fix.
    if state.registry.get(sub_id).is_none_or(|i| i.ended_at.is_some()) {
        return Err(super::held::ENDED_BEFORE_START.to_string());
    }
    if let Err(why) = setup {
        log::warn!("subchats: the worktree of {sub_id} at {} could not be set up: {why}", info.path);
        return Err(format!("its worktree at {} could not be set up: {why}", info.path));
    }
    before_continue(state, sub_id).await;
    Ok(())
}

// ---- removing: worktree/removal.rs ---------------------------------------------------------------

mod removal;
pub use removal::{remove_if_safe, Removal};
pub(crate) use removal::remove_landed;
pub(super) use removal::{is_link, unlink_reparse_points};
use removal::remove_retrying;
#[cfg(test)]
use removal::{is_registered, uncommitted_in};

/// Whether a kept tree's reason is work that removing it would lose (unmerged or
/// uncommitted commits and files, a submodule's commits). The reasons that are only
/// housekeeping (a folder the app did not make, a delete git or the OS left half
/// done) are listed instead, so a new reason defaults to the louder log line
/// ("it holds work"), never to silence about work.
pub(super) fn keeps_work(why: &str) -> bool {
    !(why.contains("is not a worktree this app made")
        || why.starts_with("git could not remove")
        || why.ends_with("so the folder was not removed")
        || why.contains("so the folder around it was left alone"))
}

/// What tells the boot and age sweeps a tree was closed on purpose, so they never
/// touch one whose row ended any other way (an app shutdown, a dead process).
/// `end_sub` writes it before it detaches anything.
pub(super) fn mark_closed(sub_id: &str) {
    let Some(info) = info_of(sub_id) else { return };
    if let Some(holder) = holder_of(&info).filter(|h| h.is_dir()) {
        let _ = std::fs::write(holder.join(CLOSED_MARK), "closed\n");
    }
}

/// The hook `end_sub` calls: a sub that ended removes its worktree when that is
/// safe, on its own thread (the folder can hold a `node_modules` of thousands
/// of files, and a killed child may still hold a lock for a moment). A tree that
/// has to stay (unmerged commits, uncommitted work, a detached HEAD, a submodule's
/// work) draws NO card (Joe 2026-11-17: nothing waits on him, the daemon clears
/// things itself): the app log says why, and the age sweep (`sweep_ended`, hourly
/// from `auto_close`) retries it until it is merged and clean. Commits of a sub
/// closed before it finished stay on its branch with only that log line as a trace;
/// a refused merge of a finished sub is `merge_followup`'s and `plumbing`'s, never Joe's.
pub(super) fn on_ended(_state: &Arc<DaemonState>, sub_id: &str) {
    let Some(info) = info_of(sub_id) else { return };
    mark_closed(sub_id);
    let id = sub_id.to_string();
    let work = move || match remove_retrying(&info) {
        Removal::Removed => {}
        Removal::Kept(why) if keeps_work(&why) => {
            log::warn!("subchats: worktree of {id} at {} on branch {} kept, it holds work: {why}; the age sweep retries it", info.path, info.branch);
        }
        Removal::Kept(why) | Removal::BuildLeft(why) => {
            log::warn!("subchats: worktree of {id} at {} on branch {} was left behind: {why}", info.path, info.branch);
        }
    };
    #[cfg(test)]
    work();
    #[cfg(not(test))]
    {
        if let Err(e) = std::thread::Builder::new().name("subchat-worktree-remove".into()).spawn(work) {
            log::warn!("subchats: could not start the worktree removal thread for {sub_id}: {e}");
        }
    }
}

// ---- leaving the sub role --------------------------------------------------------------------------

/// Commits on the sub's branch that the target lacks, `None` when it has no tree
/// or the branch is gone. A branch that exists but cannot be counted (the target
/// ref is missing, git failed) reads as one commit: it may hold work, and
/// `remove_if_safe_onto` keeps such a tree the same way.
fn unmerged_count(info: &WorktreeInfo) -> Option<u32> {
    let repo = Path::new(&info.repo);
    branch_exists(repo, &info.branch).then(|| count(repo, &format!("{}..{}", branch_ref(&info.target), branch_ref(&info.branch))).unwrap_or(1))
}

/// Whether the sub's own worktree branch holds commits its target lacks (a merge
/// refused for some cause, or never run). Closing such a sub strands them, because
/// `subchat merge` refuses an ended sub. A visiting sub is never unmerged here: its
/// target is a branch of its home machine, and the home lands its commits.
pub(super) fn has_unmerged(sub_id: &str) -> bool {
    #[cfg(test)]
    COUNTED_ON.lock().unwrap_or_else(|p| p.into_inner()).insert(sub_id.to_string(), std::thread::current().id());
    !super::is_visiting(sub_id) && info_of(sub_id).and_then(|i| unmerged_count(&i)).is_some_and(|n| n > 0)
}

/// [`has_unmerged`] for an async caller: the `git rev-list` behind it runs on the
/// blocking pool, so a tick that asks about many subs never holds up a runtime worker.
/// A count that could not run reads as unmerged: the sub stays open.
pub(super) async fn has_unmerged_off_worker(sub_id: &str) -> bool {
    let id = sub_id.to_string();
    tokio::task::spawn_blocking(move || has_unmerged(&id)).await.unwrap_or(true)
}

/// The thread [`has_unmerged`] last ran on for each sub, for the test that proves the
/// age close counts off the async worker.
#[cfg(test)]
static COUNTED_ON: Mutex<std::collections::BTreeMap<String, std::thread::ThreadId>> = Mutex::new(std::collections::BTreeMap::new());

#[cfg(test)]
fn counted_on(sub_id: &str) -> Option<std::thread::ThreadId> {
    COUNTED_ON.lock().unwrap_or_else(|p| p.into_inner()).get(sub_id).copied()
}

/// The subs of `parent` (running or finished, not ended) whose worktree branch
/// holds commits the target lacks, with how many. Closing the main chat would end
/// them and leave those commits on a branch nobody is looking at, so the close
/// approval names them.
pub fn unmerged_subs(state: &DaemonState, parent: &str) -> Vec<(String, u32)> {
    state
        .registry
        .list()
        .into_iter()
        .filter(|i| i.subchat_of.as_deref() == Some(parent) && i.ended_at.is_none())
        .filter_map(|i| {
            let n = unmerged_count(&info_of(&i.session_id)?).filter(|n| *n > 0)?;
            Some((super::spawn::label(&i), n))
        })
        .collect()
}

/// A worktree sub just left the sub role (Joe's "Move to sidebar", or the main
/// chat is gone and the sub was promoted): clearing its brief took the tree with
/// it, so nothing would merge it or remove it any more. This lands its commits at
/// once, the same merge a finish does, and always says in the main chat's window
/// where the branch is: the chat keeps the worktree as its folder, so it cannot be
/// removed under it. A refused merge is a `blocker` card naming the branch and
/// path. `parent` is the chat the sub had; with no window left to show it, the
/// app log carries the same words.
pub async fn on_moved(state: &Arc<DaemonState>, sub_id: &str, info: WorktreeInfo, parent: Option<String>) {
    let (id, tree) = (sub_id.to_string(), info.clone());
    let outcome = tokio::task::spawn_blocking(move || {
        let ahead = unmerged_count(&tree).unwrap_or(0);
        (ahead, land(&id, &tree))
    })
    .await;
    let Ok((ahead, landing)) = outcome else { return };
    let where_it_is = format!("It keeps its worktree at {} as its folder, on branch {}.", info.path, info.branch);
    // Only a refused merge is Joe's to act on. A clean move (merged, or nothing to
    // merge) is a fact for the app log: a `blocker` card for it would sit in Waiting
    // on you with nothing to do about it.
    let blocker = match landing {
        Landing::Blocked(b) => {
            log::warn!("subchats: {sub_id} left the sub role with its branch {} not merged: {}", info.branch, b.text);
            Blocked {
                text: format!("{} {where_it_is} It is a normal chat now: tell it to resolve this and merge the branch.", b.text),
                ..b
            }
        }
        Landing::Merged => {
            log::info!("subchats: {sub_id} left the sub role, {ahead} commit(s) merged into {}; it keeps its worktree at {} on branch {}", info.target, info.path, info.branch);
            return;
        }
        Landing::Nothing => {
            log::info!("subchats: {sub_id} left the sub role, its branch has nothing {} lacks; it keeps its worktree at {}", info.target, info.path);
            return;
        }
    };
    let Some(parent) = parent else { return };
    let card = BlockerCard { text: blocker.text, verdict: blocker.verdict.to_string(), tone: Some("bad".into()), points: blocker.points };
    card_log::on_app_blocker_for(state, &parent, sub_id, card);
}

// ---- facts and restart ---------------------------------------------------------------------------

/// Adds what landed to a finish card's facts: the branch it merges into, and
/// whether its commits are in it.
pub fn annotate(facts: &mut super::facts::Facts, brief: &SubchatBrief) {
    let Some(info) = &brief.worktree_at else { return };
    facts.merged_into = Some(info.target.clone());
    if facts.commits.unwrap_or(0) == 0 {
        return;
    }
    let repo = Path::new(&info.repo);
    if branch_exists(repo, &info.branch) && branch_exists(repo, &info.target) {
        facts.merged = Some(is_ancestor(repo, &branch_ref(&info.branch), &branch_ref(&info.target)));
    }
}

/// Boot: a worktree sub that was registered but never started (the daemon
/// stopped while its tree was being set up) is started again. Its row names it as
/// a held sub; the slot queue must not claim it, so `writers::restore` skips it.
pub fn restore(state: &Arc<DaemonState>) {
    for h in super::held::all().into_iter().filter(|h| h.after.is_none() && !super::held::waits_on_home(h)) {
        if !is_worktree_sub(&h.sub_id) || !state.registry.get(&h.sub_id).is_some_and(|i| i.ended_at.is_none()) {
            continue;
        }
        start_in_background(state, &h.sub_id);
    }
    sweep_ended(state);
}

/// Whether `sub_id` runs in its own worktree.
pub fn is_worktree_sub(sub_id: &str) -> bool {
    info_of(sub_id).is_some()
}

#[cfg(test)]
mod tests;
