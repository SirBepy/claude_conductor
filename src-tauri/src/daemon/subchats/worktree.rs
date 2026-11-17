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

// ---- creating the tree --------------------------------------------------------------

/// What setting a tree up involves, decided from the files that exist so the
/// sub's first message can say it before the work runs.
#[derive(Clone, Debug, PartialEq)]
pub enum Setup {
    /// The repo's own `scripts/bootstrap-worktree.ps1`, run in the new tree.
    Script,
    /// A link from the new tree's `node_modules` to the main checkout's.
    Junction { link: PathBuf, target: PathBuf },
    Nothing,
}

pub struct Prepared {
    pub info: WorktreeInfo,
    pub setup: Setup,
}

/// Said in the spawn result and the first message when the project cannot have a
/// worktree, so a sub is never started in one that does not exist.
pub enum Prepare {
    Ready(Prepared),
    /// The folder cannot have a worktree (not a repo, a detached `HEAD`, no
    /// commit). The sub runs on the main checkout and takes the writer slot.
    Unusable(String),
}

/// The project subfolder of `info.cwd` inside the worktree, `""` at its top.
fn prefix_of(info: &WorktreeInfo) -> String {
    let (cwd, root) = (path_key(&info.cwd), path_key(&info.path));
    cwd.strip_prefix(&root).map(|r| r.trim_matches('/').to_string()).unwrap_or_default()
}

fn plan_setup(top: &Path, wt: &Path, prefix: &str) -> Setup {
    if wt.join("scripts").join("bootstrap-worktree.ps1").is_file() {
        return Setup::Script;
    }
    let mut rels = vec![prefix.trim_matches('/').to_string()];
    if !prefix.is_empty() {
        rels.push(String::new());
    }
    for rel in rels {
        let (src, link) = (top.join(&rel).join("node_modules"), wt.join(&rel).join("node_modules"));
        if src.is_dir() && !link.exists() {
            return Setup::Junction { link, target: src };
        }
    }
    Setup::Nothing
}

fn ensure_excluded(repo: &Path) {
    let o = run(repo, &["rev-parse", "--git-path", "info/exclude"]);
    if !o.ok {
        return;
    }
    let file = repo.join(o.out.trim());
    let line = format!("{WORKTREES_DIR}/");
    let existing = std::fs::read_to_string(&file).unwrap_or_default();
    if existing.lines().any(|l| l.trim() == line) {
        return;
    }
    let mut text = existing;
    if !text.is_empty() && !text.ends_with('\n') {
        text.push('\n');
    }
    text.push_str(&line);
    text.push('\n');
    if let Some(dir) = file.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Err(e) = std::fs::write(&file, text) {
        log::warn!("subchats: could not exclude {line} from {}: {e}", repo.display());
    }
}

/// The part of a session id a sub's holder folder (`sub-<id>`) and branch are named by.
fn short_id(sid: &str) -> String {
    sid.chars().filter(|c| c.is_ascii_alphanumeric()).take(8).collect()
}

/// Adds the worktree for the sub whose id is `sid`, on a new branch off the
/// current `HEAD` of the repo `cwd` is in. `Err` is a failure to create it that
/// the main chat should hear at once (the folder exists, git refused);
/// [`Prepare::Unusable`] is a project that cannot have one.
pub fn prepare(cwd: &Path, sid: &str) -> Result<Prepare, String> {
    prepare_from(cwd, sid, None)
}

/// [`prepare`] for a sub visiting from another machine (`remote::host`): the
/// branch starts at `base`, the commit the home's target pointed at, instead of
/// this clone's `HEAD`, and `target` is only the home's branch name, kept so the
/// sub's first message and facts say where its commits go. This clone never
/// merges into it, so it need not exist here and the clone's own checkout may be
/// on any branch or detached. `Err` when `base` is not a commit of this clone.
pub fn prepare_at(cwd: &Path, sid: &str, base: &str, target: &str) -> Result<Prepare, String> {
    prepare_from(cwd, sid, Some((base, target)))
}

fn prepare_from(cwd: &Path, sid: &str, at: Option<(&str, &str)>) -> Result<Prepare, String> {
    let top = run(cwd, &["rev-parse", "--show-toplevel"]);
    if !top.ok || top.out.trim().is_empty() {
        return Ok(Prepare::Unusable("this folder is not a git repository".into()));
    }
    let top = PathBuf::from(top.out.trim());
    let prefix = run(cwd, &["rev-parse", "--show-prefix"]).out.trim().trim_matches('/').to_string();
    let (target, start) = match at {
        Some((base, target)) => {
            // A full hex id only: anything else could be read as an option or as a
            // ref this clone moves, and the base comes from another machine.
            let commit = super::remote::git_sync::is_commit_id(base).then(|| super::remote::git_sync::resolve_commit(&top, base)).flatten();
            let Some(commit) = commit else {
                return Err(format!("the base commit {} is not in this clone, so a worktree cannot start from it", short(base, 12)));
            };
            (target.to_string(), commit)
        }
        None => {
            let Some(target) = current_branch(&top) else {
                return Ok(Prepare::Unusable("the main checkout is on a detached HEAD, so there is no branch to merge back into".into()));
            };
            let head = run(&top, &["rev-parse", "HEAD"]);
            if !head.ok {
                return Ok(Prepare::Unusable("the repository has no commit yet".into()));
            }
            (target, head.out.trim().to_string())
        }
    };
    let id = short_id(sid);
    let holder = top.join(".claude").join("worktrees").join(format!("sub-{id}"));
    let path = holder.join(TREE_DIR);
    let branch = format!("sub/{id}");
    if holder.exists() {
        return Err(format!("{} already exists, so a worktree cannot be made there", holder.display()));
    }
    if branch_exists(&top, &branch) {
        return Err(format!("branch {branch} already exists"));
    }
    ensure_excluded(&top);
    let added = run(&top, &["worktree", "add", "-q", "-b", &branch, &path.to_string_lossy(), &start]);
    if !added.ok {
        let _ = std::fs::remove_dir_all(&holder);
        return Err(format!("git could not create the worktree: {}", short(&added.err, 300)));
    }
    // Without it a sub's builds land in the shared target dir, out of reach of the
    // removal. Best effort: a tree that builds into the shared dir still works.
    match write_build_config(&holder) {
        Ok(()) => seed_build_folder(&holder),
        Err(e) => log::warn!("subchats: could not give {} its own build folder: {e}", holder.display()),
    }
    let cwd_in = if prefix.is_empty() { path.clone() } else { path.join(&prefix) };
    let setup = plan_setup(&top, &path, &prefix);
    let info = WorktreeInfo {
        cwd: cwd_in.to_string_lossy().into_owned(),
        path: path.to_string_lossy().into_owned(),
        branch,
        target,
        repo: top.to_string_lossy().into_owned(),
        base: Some(start),
    };
    Ok(Prepare::Ready(Prepared { info, setup }))
}

/// The cargo config beside the tree. Cargo reads `.cargo/config.toml` in the
/// working folder and every folder above it, the nearest one first, so a build
/// run anywhere in the tree finds this one before `~/.cargo/config.toml` (which
/// on this machine points every project at one shared target dir). A project's
/// own `.cargo/config.toml` inside the tree is nearer still and keeps its say.
/// Never inside the tree itself, where `git add -A` would commit it.
fn write_build_config(holder: &Path) -> Result<(), String> {
    let dir = holder.join(".cargo");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // A TOML basic string: backslashes and quotes escaped, forward slashes as cargo prints them.
    let target = holder.join("target").to_string_lossy().replace('\\', "/").replace('"', "\\\"");
    let text = format!(
        "# Written by Claude Conductor for one sub's worktree, and deleted with it.\n# The sub's Rust builds go to this folder instead of a shared target dir.\n[build]\ntarget-dir = \"{target}\"\n"
    );
    std::fs::write(dir.join("config.toml"), text).map_err(|e| e.to_string())
}

/// Starts the sub's build folder from the repo's shared base of compiled
/// third-party dependencies (`build_base`), so its first build compiles only the
/// project's own crates. Best effort: without a base, or when seeding fails, the
/// folder stays empty and the sub compiles everything itself, as before.
fn seed_build_folder(holder: &Path) {
    let Some(root) = holder.parent() else { return };
    match build_base::seed(root, &holder.join("target")) {
        Ok(Some(c)) => log::info!(
            "subchats: seeded the build folder of {} from the shared base: {} compiled files shared ({} bytes), {} small files copied ({} bytes)",
            holder.display(),
            c.linked,
            c.linked_bytes,
            c.copied,
            c.copied_bytes
        ),
        Ok(None) => {}
        Err(e) => log::warn!("subchats: could not seed the build folder of {}, it builds on its own: {e}", holder.display()),
    }
}

/// The `sub-<id>/` folder holding `info`'s tree, its build config and its
/// build output, or `None` for a tree made before trees had one (directly at
/// `sub-<id>`), which has nothing beside it to remove.
fn holder_of(info: &WorktreeInfo) -> Option<PathBuf> {
    let tree = Path::new(&info.path);
    if tree.file_name()?.to_str()? != TREE_DIR {
        return None;
    }
    let holder = tree.parent()?;
    let named = holder.file_name()?.to_str()?.starts_with("sub-");
    let under = path_key(&holder.parent()?.to_string_lossy()) == path_key(&format!("{}/{WORKTREES_DIR}", info.repo));
    (named && under).then(|| holder.to_path_buf())
}

/// Notes about a fresh spawn, read once by the spawn result.
static NOTES: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);

fn put_note(sub_id: &str, note: String) {
    NOTES.lock().unwrap_or_else(|p| p.into_inner()).get_or_insert_with(HashMap::new).insert(sub_id.to_string(), note);
}

/// What `spawn_chat` tells the main chat about the worktree decision for this
/// sub, once.
pub fn take_note(sub_id: &str) -> Option<String> {
    NOTES.lock().unwrap_or_else(|p| p.into_inner()).as_mut()?.remove(sub_id)
}

/// The spawn's decision. `Ok(None)` runs the sub on the main checkout.
pub fn plan_spawn(brief: &SubchatBrief, cwd: &Path, sid: &str) -> Result<Option<Prepared>, String> {
    if !wants(brief) {
        return Ok(None);
    }
    match prepare(cwd, sid)? {
        Prepare::Ready(p) => {
            put_note(
                sid,
                format!(
                    "Running in its own worktree on branch {}; its commits are merged into {} when it finishes, so writers do not queue.",
                    p.info.branch, p.info.target
                ),
            );
            Ok(Some(p))
        }
        Prepare::Unusable(why) => {
            log::info!("subchats: no worktree for {sid}: {why}");
            put_note(sid, format!("No worktree was made ({why}), so this writer runs on the main checkout and takes the writer slot like any other."));
            Ok(None)
        }
    }
}

/// [`plan_spawn`] for a sub that carries on `old_id`'s work. Whatever the old
/// sub left uncommitted is committed as a WIP commit in its tree, and the new
/// sub's branch starts from that commit, so the work lives in git and a crash
/// between the two steps loses nothing. An old sub with nothing unmerged (or no
/// tree) is the ordinary spawn from `HEAD`. The old tree is not touched beyond
/// the commit: [`hand_over`] retires it once the new sub is registered.
pub fn plan_continue(brief: &SubchatBrief, cwd: &Path, sid: &str, old_id: &str) -> Result<Option<Prepared>, String> {
    let Some(old) = info_of(old_id).filter(|o| Path::new(&o.path).is_dir()) else { return plan_spawn(brief, cwd, sid) };
    let wt = Path::new(&old.path);
    let dirty = !run(wt, &["status", "--porcelain"]).out.trim().is_empty();
    if !dirty && unmerged_count(&old) == Some(0) {
        return plan_spawn(brief, cwd, sid);
    }
    if dirty {
        let add = run(wt, &["add", "-A"]);
        let done = add.ok && run(wt, &["-c", "commit.gpgsign=false", "commit", "--no-verify", "-q", "-m", WIP_MESSAGE]).ok;
        if !done {
            return Err(format!("the work in progress of the sub being continued could not be committed in {}, so nothing was changed", old.path));
        }
    }
    let head = run(wt, &["rev-parse", "HEAD"]);
    if !head.ok {
        return Err("the sub being continued has no commit to start from".to_string());
    }
    match prepare_at(cwd, sid, head.out.trim(), &old.target)? {
        Prepare::Ready(p) => {
            put_note(
                sid,
                format!(
                    "Running in its own worktree on branch {}, started from the work of the sub it continues (branch {}, its unfinished edits committed as a WIP commit); its commits are merged into {} when it finishes.",
                    p.info.branch, old.branch, p.info.target
                ),
            );
            Ok(Some(p))
        }
        Prepare::Unusable(why) => {
            put_note(sid, format!("No worktree was made ({why}), so this writer runs on the main checkout and takes the writer slot like any other."));
            Ok(None)
        }
    }
}

/// The commit message of the work in progress [`plan_continue`] saves.
const WIP_MESSAGE: &str = "WIP: handed to a fresh sub";

/// Retires the sub that `successor` carries on, after the successor is
/// registered: the old row is ended, and its tree and branch go because every
/// commit of the branch is on the successor's branch (checked, the same way a
/// merged tree is: the old branch must be an ancestor of the successor's, and
/// nothing may be uncommitted). A tree that fails a check
/// stays on disk, with no data lost either way.
pub async fn hand_over(state: &Arc<DaemonState>, old_id: &str, successor: &WorktreeInfo) {
    let Some(old) = info_of(old_id) else {
        super::resume::end_sub(state, old_id);
        return;
    };
    // `end_sub` would remove the tree against the target and keep it for its commits;
    // the tree is removed below against the successor, so it is detached from the row first.
    if let Some(mut cfg) = crate::sessions::chat_config::get(old_id) {
        if let Some(b) = cfg.subchat.as_mut() {
            b.worktree_at = None;
        }
        crate::sessions::chat_config::set_subchat(old_id, cfg.subchat);
    }
    // The child is stopped before the removal's checks, so nothing writes into the tree.
    super::resume::end_sub_stopped(state, old_id);
    let (old2, onto) = (old.clone(), branch_ref(&successor.branch));
    let removed = tokio::task::spawn_blocking(move || removal::remove_retrying_onto(&old2, &onto)).await;
    match removed {
        Ok(Removal::Removed) => {}
        Ok(Removal::Kept(why) | Removal::BuildLeft(why)) => {
            log::warn!("subchats: the tree of {old_id} at {} stays after its work was handed over: {why}", old.path)
        }
        Err(e) => log::warn!("subchats: removing the handed-over tree of {old_id} failed: {e}"),
    }
}

/// What the sub is told about its tree, appended to its first message.
pub fn first_message_note(p: &Prepared) -> String {
    let setup = match &p.setup {
        Setup::Script => "The app runs this repo's scripts/bootstrap-worktree.ps1 in your tree before you start, so its dependencies are installed.".to_string(),
        Setup::Junction { .. } => "Your node_modules is a link to the main checkout's node_modules: scripts and tests work, but do not install or remove packages from here. Nothing else was set up: a Python virtual environment, a built folder or any other tool the job needs is not in your tree, so set it up yourself or report it as blocked.".to_string(),
        Setup::Nothing => "Nothing was set up in your tree beyond the checkout: no dependencies, no node_modules, no virtual environment. Install what the job needs yourself, or report it as blocked.".to_string(),
    };
    let build = match holder_of(&p.info) {
        Some(holder) => format!(
            " Rust builds in your tree go to {} (a .cargo/config.toml beside your tree sets it), which is deleted with the tree: do not set CARGO_TARGET_DIR or pass --target-dir.",
            holder.join("target").display()
        ),
        None => String::new(),
    };
    format!(
        "\n\nYour working folder: you are in your own git worktree, not the main checkout, at {} on branch {} (started from {}). Commit your work on this branch. When you finish, the app brings your branch up to date with {} and merges your commits into it by itself, so do not merge, push or switch branches yourself; if that hits a conflict you will be asked to resolve it. Uncommitted edits in the main checkout and files git ignores (a .env file, local settings) are not in your tree. {setup}{build} A dev server port or a database is still shared with the main checkout and the other subs, so do not assume it is yours.",
        p.info.path, p.info.branch, p.info.target, p.info.target
    )
}

/// Registers a worktree sub's row as a held sub (no child yet) and starts it in
/// the background: the setup script can take minutes, and the main chat's
/// `spawn_chat` call must not wait on it. The launch, not this call, sets the
/// tree up (see [`before_launch`]).
pub async fn register_and_start(
    state: &Arc<DaemonState>,
    caller_session_id: &str,
    name: Option<&str>,
    inherited: &crate::sessions::chat_config::ChatConfig,
    mut spec: super::held::LaunchSpec,
    plan: &mut super::spawn::SubPlan,
    sid: String,
) -> Result<String, String> {
    let default_account_id = state.settings.snapshot().default_account_id;
    let account = crate::accounts::resolve_account(spec.account_id.as_deref(), default_account_id.as_deref()).map_err(|e| e.to_string())?;
    spec.account_id = Some(account.id);
    let sid = register_row(state, caller_session_id, name, inherited, spec, plan, sid)?;
    start_in_background(state, &sid);
    Ok(sid)
}

/// [`register_and_start`] up to the row, so a test needs no accounts file.
pub(crate) fn register_row(
    state: &Arc<DaemonState>,
    caller_session_id: &str,
    name: Option<&str>,
    inherited: &crate::sessions::chat_config::ChatConfig,
    spec: super::held::LaunchSpec,
    plan: &mut super::spawn::SubPlan,
    sid: String,
) -> Result<String, String> {
    super::held::register_held_row(state, caller_session_id, name, inherited, spec, plan, sid, SETUP_TEXT.to_string(), None)
}

fn start_in_background(state: &Arc<DaemonState>, sub_id: &str) {
    let Ok(handle) = tokio::runtime::Handle::try_current() else { return };
    let (state, sub_id) = (state.clone(), sub_id.to_string());
    handle.spawn(async move { super::writers::run_start(&state, super::writers::Start::Launch { sub_id }).await });
}

/// Throws away a worktree made for a spawn that then failed, so a refused spawn
/// leaves no folder or branch behind.
pub fn discard(info: &WorktreeInfo) {
    if let Removal::Kept(why) | Removal::BuildLeft(why) = remove_if_safe(info) {
        log::warn!("subchats: could not discard the worktree {}: {why}", info.path);
    }
}

// ---- setting up -----------------------------------------------------------------------

fn marker_path(wt: &Path) -> Option<PathBuf> {
    let o = run(wt, &["rev-parse", "--absolute-git-dir"]);
    o.ok.then(|| PathBuf::from(o.out.trim()).join("cc-setup-done"))
}

fn make_junction(link: &Path, target: &Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        // cmd reads a forward slash as a switch, and git hands paths over with them.
        let win = |p: &Path| p.to_string_lossy().replace('/', "\\");
        let mut cmd = std::process::Command::new("cmd");
        cmd.arg("/C").arg("mklink").arg("/J").arg(win(link)).arg(win(target));
        crate::util::process::hide_console(&mut cmd);
        let out = cmd.output().map_err(|e| format!("could not run mklink: {e}"))?;
        if !out.status.success() {
            return Err(format!("could not link node_modules: {}", short(&String::from_utf8_lossy(&out.stderr), 200)));
        }
    }
    #[cfg(not(windows))]
    std::os::unix::fs::symlink(target, link).map_err(|e| format!("could not link node_modules: {e}"))?;
    Ok(())
}

fn run_script(wt: &Path) -> Result<(), String> {
    let script = wt.join("scripts").join("bootstrap-worktree.ps1");
    let shell = if cfg!(windows) { "powershell" } else { "pwsh" };
    let log_path = std::env::temp_dir().join(format!("cc-worktree-setup-{}.log", uuid::Uuid::new_v4()));
    let log = std::fs::File::create(&log_path).map_err(|e| format!("could not open a setup log: {e}"))?;
    let mut cmd = std::process::Command::new(shell);
    cmd.args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
        .arg(&script)
        .current_dir(wt)
        .stdin(std::process::Stdio::null())
        .stdout(log.try_clone().map_err(|e| e.to_string())?)
        .stderr(log);
    crate::util::process::hide_console(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| format!("could not start {shell} for scripts/bootstrap-worktree.ps1: {e}"))?;
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break Ok(s),
            Ok(None) if started.elapsed() > SETUP_LIMIT => {
                crate::util::kill::kill_tree(child.id());
                let _ = child.wait();
                break Err(format!("scripts/bootstrap-worktree.ps1 ran for more than {} minutes and was stopped", SETUP_LIMIT.as_secs() / 60));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(400)),
            Err(e) => break Err(format!("could not wait for scripts/bootstrap-worktree.ps1: {e}")),
        }
    };
    let tail = std::fs::read_to_string(&log_path).unwrap_or_default();
    let _ = std::fs::remove_file(&log_path);
    let status = status?;
    if status.success() {
        return Ok(());
    }
    let tail: String = tail.chars().rev().take(600).collect::<Vec<_>>().into_iter().rev().collect();
    Err(format!("scripts/bootstrap-worktree.ps1 failed ({status}): {}", short(&tail, 400)))
}

/// Sets the tree up once: the repo's bootstrap script, else a `node_modules`
/// link. Marked done inside the worktree's git dir, so a retry or a second
/// launch does not run it again.
pub fn ensure_setup(info: &WorktreeInfo) -> Result<(), String> {
    let wt = Path::new(&info.path);
    if !wt.is_dir() {
        return Err(format!("its worktree folder {} is gone", info.path));
    }
    let marker = marker_path(wt);
    if marker.as_deref().is_some_and(Path::exists) {
        return Ok(());
    }
    match plan_setup(Path::new(&info.repo), wt, &prefix_of(info)) {
        Setup::Script => run_script(wt)?,
        Setup::Junction { link, target } => make_junction(&link, &target)?,
        Setup::Nothing => {}
    }
    // Before the marker, so a tree marked done always has the record.
    worktree_safety::record_setup(wt);
    if let Some(m) = marker {
        let _ = std::fs::write(m, "done\n");
    }
    Ok(())
}

// ---- bringing a branch up to date -------------------------------------------------------

enum Update {
    Done,
    Conflict(Vec<String>),
    Failed(String),
}

fn set_base(sub_id: &str, base: Option<String>) {
    let Some(mut brief) = crate::sessions::chat_config::get(sub_id).and_then(|c| c.subchat) else { return };
    let Some(info) = brief.worktree_at.as_mut() else { return };
    info.base = base;
    crate::sessions::chat_config::set_subchat(sub_id, Some(brief));
}

/// Clears tracked files that differ from the index in stat data or line endings
/// only. Such a file is listed by `git status` and stops `git rebase` with "You
/// have unstaged changes" although its diff is empty (a tool that rewrote it with
/// other line endings, e.g. `cargo tauri android init`). `update-index --refresh`
/// leaves it, because git decides on the file size before it looks at the bytes;
/// re-hashing the same bytes updates only the entry's stat data. Only paths
/// `git diff` reports nothing for are touched, so a real edit is never hidden.
fn settle_index(dir: &Path) {
    let _ = run(dir, &["update-index", "-q", "--refresh"]);
    let listed = run(dir, &["-c", "core.quotepath=false", "ls-files", "-m"]).lines();
    if listed.is_empty() {
        return;
    }
    let differing: std::collections::HashSet<String> =
        run(dir, &["-c", "core.quotepath=false", "diff", "--name-only"]).lines().into_iter().collect();
    let same: Vec<&str> = listed.iter().map(String::as_str).filter(|p| !differing.contains(*p)).collect();
    for chunk in same.chunks(40) {
        let mut args = vec!["update-index", "-q", "--"];
        args.extend(chunk);
        let _ = run(dir, &args);
    }
}

/// Rebases the sub's branch on the target inside its worktree. A conflict is
/// aborted, so the branch and every commit on it stay as they were. Records the
/// commit the sub's facts count from: the target's tip once the sub has no
/// commits of its own, else where its commits start.
fn update_branch(sub_id: &str, info: &WorktreeInfo) -> Update {
    update_branch_onto(sub_id, info, &branch_ref(&info.target))
}

/// [`update_branch`] against any ref: a sub visiting from another machine rebases
/// onto its private copy of its home's target (`refs/cc-sub/<id>/target`), because
/// the branch of that name in this clone is not the home's.
fn update_branch_onto(sub_id: &str, info: &WorktreeInfo, target: &str) -> Update {
    let wt = Path::new(&info.path);
    if !wt.is_dir() {
        return Update::Failed(format!("its worktree folder {} is gone", info.path));
    }
    // A daemon killed inside `git rebase` left the tree detached, which the check
    // below would refuse for ever.
    if let Err(why) = worktree_safety::settle_rebase(wt) {
        return Update::Failed(why);
    }
    if current_branch(wt).as_deref() != Some(info.branch.as_str()) {
        return Update::Failed(format!("the worktree is not on its branch {} any more", info.branch));
    }
    if !run(wt, &["rev-parse", "--verify", "--quiet", target]).ok {
        return Update::Failed(format!("the target branch {} no longer exists", info.target));
    }
    if !is_ancestor(wt, target, "HEAD") {
        settle_index(wt);
        let _mark = worktree_safety::RebaseMark::set(wt);
        let r = run(wt, &["rebase", target]);
        if !r.ok {
            let files = run(wt, &["diff", "--name-only", "--diff-filter=U"]).lines();
            let _ = run(wt, &["rebase", "--abort"]);
            return if files.is_empty() { Update::Failed(short(&r.err, 300)) } else { Update::Conflict(files) };
        }
    }
    let own = count(wt, &format!("{target}..HEAD")).unwrap_or(0);
    let base = if own == 0 { run(wt, &["rev-parse", "HEAD"]) } else { run(wt, &["merge-base", target, "HEAD"]) };
    set_base(sub_id, base.ok.then(|| base.out.trim().to_string()));
    Update::Done
}

/// What [`update_onto_ref`] did, as the host reports it to the home.
pub(crate) struct Updated {
    /// `done`, `conflict` or `failed`.
    pub status: &'static str,
    pub files: Vec<String>,
    pub why: String,
    /// The sub's branch head after the update.
    pub head: Option<String>,
    /// How many commits the branch holds that `target` lacks.
    pub ahead: u32,
}

/// Brings a visiting sub's branch up to date with `target_ref` (the host's copy of
/// its home's target), the same rebase and conflict handling a local landing runs.
pub(crate) fn update_onto_ref(sub_id: &str, info: &WorktreeInfo, target_ref: &str) -> Updated {
    let (status, files, why) = match update_branch_onto(sub_id, info, target_ref) {
        Update::Done => ("done", Vec::new(), String::new()),
        Update::Conflict(files) => ("conflict", files, String::new()),
        Update::Failed(why) => ("failed", Vec::new(), why),
    };
    let wt = Path::new(&info.path);
    let head = run(wt, &["rev-parse", "HEAD"]);
    Updated {
        status,
        files,
        why,
        head: head.ok.then(|| head.out.trim().to_string()),
        ahead: count(wt, &format!("{target_ref}..HEAD")).unwrap_or(0),
    }
}

// ---- landing ----------------------------------------------------------------------------

/// What stopped a merge, which decides who can do something about it
/// (`merge_followup`): the sub can resolve a conflict, only Joe can clear the main
/// checkout.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub enum Cause {
    /// The sub's commits conflict with the target.
    Conflict,
    /// The main checkout has uncommitted changes in files the merge would change.
    DirtyOverlap,
    /// The main checkout is on another branch than the sub started from.
    BranchSwitched,
    #[default]
    Other,
}

/// Why a merge did not happen, in the words of the card.
#[derive(Debug, Clone, PartialEq)]
pub struct Blocked {
    pub verdict: &'static str,
    pub text: String,
    pub points: Vec<String>,
    pub cause: Cause,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Landing {
    /// The sub's commits are now in the target branch.
    Merged,
    /// The branch holds no commits the target lacks.
    Nothing,
    Blocked(Blocked),
}

fn blocked(verdict: &'static str, text: String, points: Vec<String>) -> Landing {
    Landing::Blocked(Blocked { verdict, text, points, cause: Cause::Other })
}

fn caused(cause: Cause, landing: Landing) -> Landing {
    match landing {
        Landing::Blocked(b) => Landing::Blocked(Blocked { cause, ..b }),
        other => other,
    }
}

fn conflict_landing(info: &WorktreeInfo, files: Vec<String>) -> Landing {
    caused(Cause::Conflict, blocked(
        "Merge conflict",
        format!(
            "Its commits conflict with {t}. Nothing was merged, and its worktree keeps every commit. Tell the sub to bring branch {b} up to date with {t} (git rebase {t}), resolve the conflict in these files, commit, and finish again: it merges when it finishes.",
            t = info.target,
            b = info.branch
        ),
        files,
    ))
}

/// Merges the sub's commits into the target branch the main checkout has
/// checked out. `between` runs after the branch was brought up to date and
/// before the fast-forward, with the attempt number: the window a moving target
/// can slip into, and where a test moves it.
fn land_with(sub_id: &str, info: &WorktreeInfo, between: &mut dyn FnMut(usize)) -> Landing {
    let lock = repo_lock(Path::new(&info.repo));
    let _held = lock.lock().unwrap_or_else(|p| p.into_inner());
    let (repo, wt) = (Path::new(&info.repo), Path::new(&info.path));
    if !wt.is_dir() {
        return blocked("Not merged", format!("Its worktree folder {} is gone, so its commits could not be merged.", info.path), Vec::new());
    }
    let now = current_branch(repo);
    if now.as_deref() != Some(info.target.as_str()) {
        return caused(Cause::BranchSwitched, blocked(
            "Not merged",
            format!(
                "The main checkout is on {} now, but this sub started from {t}. Nothing was merged. Its commits are safe on branch {b} in its worktree: switch the main checkout back to {t}, then tell the sub to finish again.",
                now.map(|n| format!("branch {n}")).unwrap_or_else(|| "a detached HEAD".to_string()),
                t = info.target,
                b = info.branch
            ),
            Vec::new(),
        ));
    }
    if !branch_exists(wt, &info.branch) {
        return blocked("Not merged", format!("Branch {} no longer exists, so there is nothing to merge.", info.branch), Vec::new());
    }
    let ahead = count(wt, &format!("{}..{}", branch_ref(&info.target), branch_ref(&info.branch))).unwrap_or(0);
    if ahead == 0 {
        // Still brings the branch to the target, so facts count from the right base.
        let _ = update_branch(sub_id, info);
        return Landing::Nothing;
    }
    let top = run(repo, &["rev-parse", "--show-toplevel"]).out.trim().to_string();
    for attempt in 0..2 {
        match update_branch(sub_id, info) {
            Update::Done => {}
            Update::Conflict(files) => return conflict_landing(info, files),
            Update::Failed(why) => {
                return blocked("Not merged", format!("Its branch could not be brought up to date with {}: {why}. Nothing was merged and its worktree keeps every commit.", info.target), Vec::new())
            }
        }
        between(attempt);
        // Files the merge would change, against files already dirty in the main
        // checkout: an overlap is refused, so nobody's uncommitted bytes are touched.
        let changed =
            run(wt, &["-c", "core.quotepath=false", "diff", "--name-only", &branch_ref(&info.target), &branch_ref(&info.branch)]).lines();
        let dirty = git::dirty_keys(repo).unwrap_or_default();
        let overlap: Vec<String> =
            changed.into_iter().filter(|name| dirty.contains(&path_key(&format!("{top}/{name}")))).collect();
        if !overlap.is_empty() {
            return caused(Cause::DirtyOverlap, blocked(
                "Not merged",
                format!(
                    "The main checkout has uncommitted changes in files this sub also changed, so the merge was refused and nothing there was touched. Commit or move those changes, then tell the sub to finish again: it merges when it finishes. Its commits are safe on branch {}.",
                    info.branch
                ),
                overlap,
            ));
        }
        // `--no-overwrite-ignore`: the dirty check above cannot see a file git ignores
        // (a `.env`), and without the flag a sub that committed one with `add -f`
        // would have it written over the local copy.
        let merged = run(repo, &["merge", "--ff-only", "--no-overwrite-ignore", "-q", &branch_ref(&info.branch)]);
        if merged.ok {
            return Landing::Merged;
        }
        let kept = overwritten_files(&merged.err);
        if !kept.is_empty() {
            return blocked(
                "Not merged",
                format!(
                    "The main checkout has files git ignores (a .env file, local settings) where this sub committed files of the same name, so the merge was refused and nothing there was touched. Move or delete those files, then tell the sub to finish again: it merges when it finishes. Its commits are safe on branch {}.",
                    info.branch
                ),
                kept,
            );
        }
        // The target moved under the rebase: it no longer sits below the branch.
        // One more round re-bases on its new tip.
        if attempt == 0 && !is_ancestor(repo, &branch_ref(&info.target), &branch_ref(&info.branch)) {
            continue;
        }
        return blocked(
            "Not merged",
            format!("git refused to fast-forward {}: {}. Nothing was changed there, and the sub's commits are safe on branch {}.", info.target, short(&merged.err, 300), info.branch),
            Vec::new(),
        );
    }
    blocked("Not merged", format!("{} kept moving while the merge ran. Tell the sub to finish again.", info.target), Vec::new())
}

/// The paths git names when a merge would overwrite local files: the tab-indented
/// lines under "untracked working tree files would be overwritten by merge".
fn overwritten_files(err: &str) -> Vec<String> {
    let mut files = Vec::new();
    let mut listing = false;
    for line in err.lines() {
        if line.contains("would be overwritten by merge") {
            listing = true;
        } else if listing && line.starts_with(['\t', ' ']) && !line.trim().is_empty() {
            files.push(line.trim().to_string());
        } else {
            listing = false;
        }
    }
    files
}

pub fn land(sub_id: &str, info: &WorktreeInfo) -> Landing {
    land_with(sub_id, info, &mut |_| {})
}

/// Lands the sub's commits. A refusal is handed to `merge_followup`, which tells
/// the sub, keeps the merge pending, or wakes the main chat; never a card for Joe.
pub fn land_and_report(state: &Arc<DaemonState>, sub_id: &str, info: &WorktreeInfo) -> Landing {
    let landing = land(sub_id, info);
    match &landing {
        Landing::Blocked(b) => super::merge_followup::on_blocked(state, sub_id, info, b),
        _ => super::merge_followup::on_landed(state, sub_id),
    }
    landing
}

/// [`land_and_report`] as a merge in its own right (a retry by the tick or the main chat): counted
/// like the one `defer` runs, so a gate that asks meanwhile waits for it.
pub(super) fn land_counted(state: &Arc<DaemonState>, sub_id: &str, info: &WorktreeInfo) -> Landing {
    let key = project_key(Path::new(&info.repo));
    let in_flight = begin_merge(&key);
    let landing = land_and_report(state, sub_id, info);
    drop(in_flight);
    super::writers::sweep(state);
    landing
}

/// The hook `subchats::on_finished` calls first. For a worktree sub it merges on
/// its own thread (a rebase and a merge are git work, and `on_finished` runs
/// inside the pump), then calls `rest`, which draws the finish card and starts
/// whatever waited for this sub, so both see what landed. Returns false for any
/// other sub, which the caller then finishes at once.
pub(super) fn defer(state: &Arc<DaemonState>, sub_id: &str, rest: fn(&Arc<DaemonState>, &str)) -> bool {
    let Some(info) = info_of(sub_id) else { return false };
    let key = project_key(Path::new(&info.repo));
    // Counted before the thread starts, so a gate that asks in between waits. The
    // guard moves into the work: it is released when the work ends, when it panics
    // and when the thread cannot start and the work is dropped unrun.
    let in_flight = begin_merge(&key);
    let continued = continued_count(sub_id);
    let (state, id) = (state.clone(), sub_id.to_string());
    // The thread has no runtime of its own, and what follows a landing (the sub
    // waiting behind this one, a close waiting on the last sub, the cards) spawns
    // tasks onto the one that called `on_finished`. Without it entering here those
    // spawns found no runtime and did nothing until the 60 second tick.
    let runtime = tokio::runtime::Handle::try_current().ok();
    let work = move || {
        let _enter = runtime.as_ref().map(|h| h.enter());
        let landing = land_and_report(&state, &id, &info);
        drop(in_flight);
        super::writers::sweep(&state);
        rest(&state, &id);
        // After `rest`, so the card and the next sub never wait on gigabytes of deletes.
        if matches!(landing, Landing::Merged | Landing::Nothing) {
            free_build_folder(&state, &id, &info, continued);
        }
    };
    // Tests wait for the thread, so what they assert on is settled; the work itself
    // runs where production runs it.
    #[cfg(test)]
    let _ = std::thread::spawn(work).join();
    #[cfg(not(test))]
    {
        let spawned = std::thread::Builder::new().name("subchat-merge".into()).spawn(work);
        if let Err(e) = spawned {
            log::warn!("subchats: could not start the merge thread for {sub_id}: {e}");
        }
    }
    true
}

/// [`free_build_folder`] for the tree `sub_id`'s brief names, on a thread of its
/// own: a multi-gigabyte delete must not hold the finish hook (it runs inside the
/// pump) and a visiting sub has no merge thread to run it on. The continue count is
/// read here, as the merge thread reads it when it starts, so a continue after the
/// finish skips the delete.
pub(super) fn free_build_folder_in_background(state: &Arc<DaemonState>, sub_id: &str) {
    let (state, id, seen) = (state.clone(), sub_id.to_string(), continued_count(sub_id));
    let work = move || {
        if let Some(info) = info_of(&id) {
            free_build_folder(&state, &id, &info, seen);
        }
    };
    if let Err(e) = std::thread::Builder::new().name("subchat-free-build".into()).spawn(work) {
        log::warn!("subchats: could not start the build-folder delete for {sub_id}: {e}");
    }
}

/// Deletes a finished sub's build folder once its commits landed: it recompiles
/// the project's dependencies, gigabytes that nothing else frees while the sub's
/// folder lives (see `build_target`). A sub that is continued builds again into
/// the same place. Skipped while the sub has a background task, which may be a
/// build using the folder.
///
/// `seen` is [`continued_count`] read when the merge started. The folder goes only
/// while the sub's guard is held and the count still equals it, and a continue
/// (`before_continue`) takes the same guard before it counts, so a continue either
/// came first (the count moved: skipped) or waits until the delete is over, before
/// any cargo of the new turn exists.
fn free_build_folder(state: &DaemonState, sub_id: &str, info: &WorktreeInfo, seen: u64) {
    let guard = build_guard(sub_id);
    let _deleting = guard.delete.lock().unwrap_or_else(|e| e.into_inner());
    if guard.continued.load(std::sync::atomic::Ordering::SeqCst) != seen {
        return;
    }
    // The merge thread reaches here after `rest`, so a nudge may already have
    // continued the sub: a busy row may have a cargo using the folder.
    if state.registry.get(sub_id).is_some_and(|i| i.local_task_running || i.busy) {
        return;
    }
    let Some(holder) = holder_of(info) else { return };
    match build_target::free(&holder) {
        Ok(0) => {}
        Ok(bytes) => log::info!("subchats: freed {bytes} bytes of build output of finished sub {sub_id} at {}", holder.display()),
        Err(why) => log::warn!("subchats: could not free the build output of finished sub {sub_id}: {why}"),
    }
}

/// Per sub: how many times it was continued (read without waiting, so the pump thread
/// that starts a merge never stalls behind a delete) and a lock a build folder delete
/// holds while it runs (see [`free_build_folder`]).
#[derive(Default)]
struct BuildGuard {
    continued: std::sync::atomic::AtomicU64,
    delete: Mutex<()>,
}

static BUILD_GUARDS: Mutex<Option<HashMap<String, Arc<BuildGuard>>>> = Mutex::new(None);

fn build_guard(sub_id: &str) -> Arc<BuildGuard> {
    let mut all = BUILD_GUARDS.lock().unwrap_or_else(|e| e.into_inner());
    all.get_or_insert_with(HashMap::new).entry(sub_id.to_string()).or_default().clone()
}

/// How many continues the sub has had so far.
fn continued_count(sub_id: &str) -> u64 {
    build_guard(sub_id).continued.load(std::sync::atomic::Ordering::SeqCst)
}

/// Counts a continue. Waits while a delete of this sub's build folder runs, which is
/// the point: the turn that follows must not start a build into a folder going away.
fn note_continued(sub_id: &str) {
    let guard = build_guard(sub_id);
    let _wait = guard.delete.lock().unwrap_or_else(|e| e.into_inner());
    guard.continued.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
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
/// or the branch is gone.
fn unmerged_count(info: &WorktreeInfo) -> Option<u32> {
    let repo = Path::new(&info.repo);
    branch_exists(repo, &info.branch).then(|| count(repo, &format!("{}..{}", branch_ref(&info.target), branch_ref(&info.branch))))?
}

/// Whether the sub's own worktree branch holds commits its target lacks (a merge
/// refused for some cause, or never run). Closing such a sub strands them, because
/// `subchat merge` refuses an ended sub.
pub(super) fn has_unmerged(sub_id: &str) -> bool {
    info_of(sub_id).and_then(|i| unmerged_count(&i)).is_some_and(|n| n > 0)
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

/// The trees of subs that were closed (by hand, or with their main chat) but are
/// still on disk: a removal failed, or the daemon stopped while it ran. Each
/// is removed by the same safety checks as at the end, on a thread of its own
/// (a tree with a build folder is gigabytes). A tree that has to stay is logged
/// only: the sub's end already logged why it stayed, and `auto_close::tick` runs this
/// again every hour, so a kept tree is retried until it is merged and clean.
///
/// The same pass then frees the build folders of finished subs that sit idle
/// (`sweep_targets`), on the same thread and after the removals, so the two never
/// work on one folder at once and no second background task exists.
pub(super) fn sweep_ended(state: &Arc<DaemonState>) {
    sweep_ended_at(state, std::time::SystemTime::now());
}

/// [`sweep_ended`] with the clock the idle time is judged by.
fn sweep_ended_at(state: &Arc<DaemonState>, now: std::time::SystemTime) {
    let trees: Vec<(String, WorktreeInfo)> = state
        .registry
        .list()
        .into_iter()
        .filter(|i| i.subchat_of.is_some() && i.ended_at.is_some())
        .filter_map(|i| Some((i.session_id.clone(), info_of(&i.session_id)?)))
        // Only a tree `on_ended` marked: a row also ends on an app shutdown or a
        // dead process, and such a sub can still be brought back in its tree.
        .filter(|(_, info)| holder_of(info).is_some_and(|h| h.join(CLOSED_MARK).is_file()))
        .filter(|(_, info)| !in_use(state, info))
        .collect();
    let roots = target_roots(state);
    if trees.is_empty() && roots.is_empty() {
        return;
    }
    let state = state.clone();
    let work = move || {
        for (id, info) in trees {
            match remove_retrying(&info) {
                Removal::Removed => log::info!("subchats: removed the worktree of ended sub {id} at {}", info.path),
                Removal::Kept(why) | Removal::BuildLeft(why) => log::warn!("subchats: worktree of ended sub {id} at {} stays: {why}", info.path),
            }
        }
        sweep_targets(&state, &roots, now);
    };
    #[cfg(test)]
    work();
    #[cfg(not(test))]
    {
        if let Err(e) = std::thread::Builder::new().name("subchat-worktree-sweep".into()).spawn(work) {
            log::warn!("subchats: could not start the worktree sweep: {e}");
        }
    }
}

/// Whether a chat that has not ended works inside `info`'s tree (a respawned or
/// promoted row that kept it as its folder): its folder must not be deleted
/// under it, whatever the ended row's brief says.
fn in_use(state: &DaemonState, info: &WorktreeInfo) -> bool {
    let tree = format!("{}/", path_key(&info.path));
    state
        .registry
        .list()
        .into_iter()
        .filter(|i| i.ended_at.is_none())
        .any(|i| format!("{}/", path_key(&i.cwd.to_string_lossy())).starts_with(&tree))
}

/// How long a finished sub's build folder must go unwritten before the start-up
/// sweep frees it.
const TARGET_IDLE: Duration = Duration::from_secs(3 * 3600);

/// The `.claude/worktrees` folder of every repo that has a sub the registry knows.
fn target_roots(state: &DaemonState) -> Vec<PathBuf> {
    let mut seen = std::collections::HashSet::new();
    state
        .registry
        .list()
        .into_iter()
        .filter(|i| i.subchat_of.is_some())
        .filter_map(|i| info_of(&i.session_id))
        .map(|info| Path::new(&info.repo).join(WORKTREES_DIR))
        .filter(|root| seen.insert(path_key(&root.to_string_lossy())))
        .collect()
}

/// Whether the registry calls the sub of holder folder `name` (`sub-<id>`) finished
/// and idle: its turn is over (or its closed tree was kept), it has no background
/// task, is not queued or held, and no merge of it waits to land. A holder no row
/// names is not idle: nothing says it is finished.
fn holder_is_idle(state: &DaemonState, root: &Path, name: &str) -> bool {
    let closed = root.join(name).join(CLOSED_MARK).is_file();
    let rows: Vec<_> = state.registry.list().into_iter().filter(|i| i.subchat_of.is_some() && format!("sub-{}", short_id(&i.session_id)) == name).collect();
    !rows.is_empty()
        && rows.iter().all(|i| {
            let id = &i.session_id;
            !i.busy
                && !i.local_task_running
                && !super::held::is_held(id)
                && !super::pending_merges::contains(id)
                && (i.subchat_finished || (i.ended_at.is_some() && closed))
        })
}

/// Frees the build folder of every idle finished sub (`build_target::sweep_idle`)
/// and logs what the folders hold in total and what went, so their growth is visible.
fn sweep_targets(state: &DaemonState, roots: &[PathBuf], now: std::time::SystemTime) {
    let mut all = build_target::Swept::default();
    for root in roots {
        all.add(build_target::sweep_idle(root, now, TARGET_IDLE, &|name| holder_is_idle(state, root, name)));
    }
    log::info!(
        "subchats: sub build folders held {} bytes in total; freed {} bytes from {} idle finished sub(s), kept {}",
        all.total,
        all.freed,
        all.freed_subs,
        all.kept_subs
    );
}

/// Whether `sub_id` runs in its own worktree.
pub fn is_worktree_sub(sub_id: &str) -> bool {
    info_of(sub_id).is_some()
}

#[cfg(test)]
mod tests;
