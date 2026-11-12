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

struct Out {
    ok: bool,
    out: String,
    err: String,
}

impl Out {
    fn lines(&self) -> Vec<String> {
        self.out.lines().map(str::trim).filter(|l| !l.is_empty()).map(str::to_string).collect()
    }
}

/// Runs git in `cwd` with the console hidden and no prompt or editor. Stdout
/// keeps leading blanks (a porcelain line starts with one).
fn run(cwd: &Path, args: &[&str]) -> Out {
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

fn short(text: &str, max: usize) -> String {
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

fn current_branch(dir: &Path) -> Option<String> {
    let o = run(dir, &["symbolic-ref", "--short", "-q", "HEAD"]);
    (o.ok && !o.out.trim().is_empty()).then(|| o.out.trim().to_string())
}

fn count(dir: &Path, range: &str) -> Option<u32> {
    let o = run(dir, &["rev-list", "--count", range]);
    o.ok.then(|| o.out.trim().parse().ok()).flatten()
}

fn is_ancestor(dir: &Path, ancestor: &str, descendant: &str) -> bool {
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
fn repo_lock(repo: &Path) -> Arc<Mutex<()>> {
    let mut guard = LOCKS.lock().unwrap_or_else(|p| p.into_inner());
    guard.get_or_insert_with(HashMap::new).entry(project_key(repo)).or_default().clone()
}

fn begin_merge(key: &str) {
    let mut guard = IN_FLIGHT.lock().unwrap_or_else(|p| p.into_inner());
    *guard.get_or_insert_with(HashMap::new).entry(key.to_string()).or_insert(0) += 1;
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
    begin_merge(key);
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

/// Adds the worktree for the sub whose id is `sid`, on a new branch off the
/// current `HEAD` of the repo `cwd` is in. `Err` is a failure to create it that
/// the main chat should hear at once (the folder exists, git refused);
/// [`Prepare::Unusable`] is a project that cannot have one.
pub fn prepare(cwd: &Path, sid: &str) -> Result<Prepare, String> {
    let top = run(cwd, &["rev-parse", "--show-toplevel"]);
    if !top.ok || top.out.trim().is_empty() {
        return Ok(Prepare::Unusable("this folder is not a git repository".into()));
    }
    let top = PathBuf::from(top.out.trim());
    let prefix = run(cwd, &["rev-parse", "--show-prefix"]).out.trim().trim_matches('/').to_string();
    let Some(target) = current_branch(&top) else {
        return Ok(Prepare::Unusable("the main checkout is on a detached HEAD, so there is no branch to merge back into".into()));
    };
    let head = run(&top, &["rev-parse", "HEAD"]);
    if !head.ok {
        return Ok(Prepare::Unusable("the repository has no commit yet".into()));
    }
    let id: String = sid.chars().filter(|c| c.is_ascii_alphanumeric()).take(8).collect();
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
    let added = run(&top, &["worktree", "add", "-q", "-b", &branch, &path.to_string_lossy(), "HEAD"]);
    if !added.ok {
        let _ = std::fs::remove_dir_all(&holder);
        return Err(format!("git could not create the worktree: {}", short(&added.err, 300)));
    }
    // Without it a sub's builds land in the shared target dir, out of reach of the
    // removal. Best effort: a tree that builds into the shared dir still works.
    if let Err(e) = write_build_config(&holder) {
        log::warn!("subchats: could not give {} its own build folder: {e}", holder.display());
    }
    let cwd_in = if prefix.is_empty() { path.clone() } else { path.join(&prefix) };
    let setup = plan_setup(&top, &path, &prefix);
    let info = WorktreeInfo {
        cwd: cwd_in.to_string_lossy().into_owned(),
        path: path.to_string_lossy().into_owned(),
        branch,
        target,
        repo: top.to_string_lossy().into_owned(),
        base: Some(head.out.trim().to_string()),
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
    let wt = Path::new(&info.path);
    if !wt.is_dir() {
        return Update::Failed(format!("its worktree folder {} is gone", info.path));
    }
    if current_branch(wt).as_deref() != Some(info.branch.as_str()) {
        return Update::Failed(format!("the worktree is not on its branch {} any more", info.branch));
    }
    let target = branch_ref(&info.target);
    if !branch_exists(wt, &info.target) {
        return Update::Failed(format!("the target branch {} no longer exists", info.target));
    }
    if !is_ancestor(wt, &target, "HEAD") {
        settle_index(wt);
        let r = run(wt, &["rebase", &target]);
        if !r.ok {
            let files = run(wt, &["diff", "--name-only", "--diff-filter=U"]).lines();
            let _ = run(wt, &["rebase", "--abort"]);
            return if files.is_empty() { Update::Failed(short(&r.err, 300)) } else { Update::Conflict(files) };
        }
    }
    let own = count(wt, &format!("{target}..HEAD")).unwrap_or(0);
    let base = if own == 0 { run(wt, &["rev-parse", "HEAD"]) } else { run(wt, &["merge-base", &target, "HEAD"]) };
    set_base(sub_id, base.ok.then(|| base.out.trim().to_string()));
    Update::Done
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

/// Draws a `blocker` card in the main chat's window: only for a worktree that had
/// to stay after its sub ended, so its unmerged commits are not forgotten. `root`
/// is the data dir, `None` for the real one.
fn report(state: &Arc<DaemonState>, sub_id: &str, root: Option<&Path>, b: &Blocked) {
    let card = BlockerCard { text: b.text.clone(), verdict: b.verdict.to_string(), tone: Some("bad".into()), points: b.points.clone() };
    match root {
        Some(root) => {
            card_log::on_blocker_at(root, state, sub_id, card);
        }
        None => {
            card_log::on_blocker(state, sub_id, card);
        }
    }
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
    begin_merge(&key);
    let landing = land_and_report(state, sub_id, info);
    end_merge(&key);
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
    // Counted before the thread starts, so a gate that asks in between waits.
    begin_merge(&key);
    let (state, id) = (state.clone(), sub_id.to_string());
    // The thread has no runtime of its own, and what follows a landing (the sub
    // waiting behind this one, a close waiting on the last sub, the cards) spawns
    // tasks onto the one that called `on_finished`. Without it entering here those
    // spawns found no runtime and did nothing until the 60 second tick.
    let runtime = tokio::runtime::Handle::try_current().ok();
    let work = move || {
        let _enter = runtime.as_ref().map(|h| h.enter());
        land_and_report(&state, &id, &info);
        end_merge(&key);
        super::writers::sweep(&state);
        rest(&state, &id);
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
    let id = sub_id.to_string();
    let blocker = tokio::task::spawn_blocking(move || {
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
    if let Err(why) = setup {
        log::warn!("subchats: the worktree of {sub_id} at {} could not be set up: {why}", info.path);
        return Err(format!("its worktree at {} could not be set up: {why}", info.path));
    }
    before_continue(state, sub_id).await;
    Ok(())
}

// ---- removing ---------------------------------------------------------------------------------

#[derive(Debug, PartialEq)]
pub enum Removal {
    Removed,
    /// Kept, with the reason a card says.
    Kept(String),
    /// The tree and its branch are gone, but its build folder could not be
    /// deleted (a build still running in it holds a file), with the reason.
    BuildLeft(String),
}

impl Removal {
    /// A failure that can clear up by itself a moment later: a child that was
    /// just killed can still hold a file in the tree or its build folder.
    fn may_clear(&self) -> bool {
        match self {
            Removal::Kept(why) => why.starts_with("git could not remove"),
            Removal::BuildLeft(_) => true,
            Removal::Removed => false,
        }
    }
}

/// Unlinks every junction and symlink under `root` without following any of
/// them, so removing the tree never reaches the main checkout's `node_modules`
/// through a link (the incident `safe-remove-worktree.ps1` exists for). Returns
/// the first link that would not unlink.
fn unlink_reparse_points(root: &Path) -> Result<(), String> {
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            // `DirEntry::metadata` describes the entry itself and never follows it.
            let Ok(meta) = entry.metadata() else { continue };
            let kind = meta.file_type();
            let path = entry.path();
            if is_link(&meta) {
                // A directory link goes with remove_dir, a file link with remove_file;
                // neither follows it.
                if std::fs::remove_dir(&path).is_err() && std::fs::remove_file(&path).is_err() {
                    return Err(format!("could not unlink {}", path.display()));
                }
            } else if kind.is_dir() {
                stack.push(path);
            }
        }
    }
    Ok(())
}

/// A symlink or an NTFS junction. A junction is a reparse point that older
/// `std` versions do not report as a symlink, so the attribute is read too.
fn is_link(meta: &std::fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return true;
        }
    }
    meta.file_type().is_symlink()
}

/// Whether `wt` holds uncommitted work. A link into the main checkout (the
/// `node_modules` junction) is not work, so it is not counted.
fn uncommitted_in(wt: &Path) -> Vec<String> {
    settle_index(wt);
    run(wt, &["status", "--porcelain=v1", "--untracked-files=normal"])
        .out
        .lines()
        .filter(|l| l.len() > 3)
        .map(|l| l[3..].trim().trim_matches('"').to_string())
        .filter(|p| !std::fs::symlink_metadata(wt.join(p.trim_end_matches('/'))).is_ok_and(|m| is_link(&m)))
        .collect()
}

/// Why the tree cannot be deleted because of a submodule in it, or `None`. A
/// worktree's submodules keep their git dirs inside the worktree's own, and
/// `git worktree remove` refuses any tree with an initialised one, so removal
/// always ends in `--force`, which deletes them: a commit made only there would be
/// gone while the superproject points at it. A module is safe to delete only when
/// it has no uncommitted work and every commit on it is reachable from one of its
/// remote-tracking refs. A module that cannot be checked counts as at risk.
fn module_risk(wt: &Path) -> Option<String> {
    let status = run(wt, &["submodule", "status", "--recursive"]);
    for line in status.out.lines() {
        // `<flag><sha> <path> (<describe>)`; the flag `-` is a module never cloned here.
        let Some(flag) = line.chars().next() else { continue };
        if flag == '-' {
            continue;
        }
        let rest = line[flag.len_utf8()..].trim_start();
        let path = rest.split_once(' ').map(|(_, p)| p).unwrap_or("");
        let path = path.rsplit_once(" (").map_or(path, |(p, _)| p).trim();
        if path.is_empty() {
            continue;
        }
        let dir = wt.join(path);
        let unpublished = run(&dir, &["rev-list", "-n", "1", "--branches", "HEAD", "--not", "--remotes"]);
        if !unpublished.ok {
            return Some(format!("its submodule {path} could not be checked for commits only this tree has: {}", short(&unpublished.err, 200)));
        }
        if !unpublished.out.trim().is_empty() {
            return Some(format!("its submodule {path} holds commits no remote has, and removing the tree would delete them"));
        }
        let dirty = uncommitted_in(&dir);
        if !dirty.is_empty() {
            return Some(format!("its submodule {path} has uncommitted work: {}", dirty.iter().take(6).cloned().collect::<Vec<_>>().join(", ")));
        }
    }
    None
}

/// Removes the sub's worktree and branch when its commits are merged and nothing
/// is uncommitted; otherwise leaves everything where it is and says why.
pub fn remove_if_safe(info: &WorktreeInfo) -> Removal {
    let lock = repo_lock(Path::new(&info.repo));
    let _held = lock.lock().unwrap_or_else(|p| p.into_inner());
    let (repo, wt) = (Path::new(&info.repo), Path::new(&info.path));
    let forget_branch = || {
        if branch_exists(repo, &info.branch) && is_ancestor(repo, &branch_ref(&info.branch), &branch_ref(&info.target)) {
            let _ = run(repo, &["branch", "-D", &info.branch]);
        }
    };
    if !wt.exists() {
        let _ = run(repo, &["worktree", "prune"]);
        forget_branch();
        return remove_holder(info);
    }
    // Only a folder git itself lists as a worktree, never the main checkout, and
    // only one this module made.
    let ours = path_key(&info.path).starts_with(&format!("{}/{WORKTREES_DIR}/", path_key(&info.repo)));
    let registered = is_registered(repo, &info.path);
    if !registered && half_removed(info) {
        // An earlier removal passed every check below, and git unregistered the
        // tree and took its `.git` file before a delete failed (a file a killed
        // child still held). What is left is that tree's own files: finish it.
        if let Err(why) = unlink_reparse_points(wt) {
            return Removal::Kept(format!("{why}, so the folder was not removed"));
        }
        if let Err(e) = std::fs::remove_dir_all(wt) {
            return Removal::Kept(format!("git could not remove the folder: a delete left it half done ({e})"));
        }
        let _ = run(repo, &["worktree", "prune"]);
        forget_branch();
        return remove_holder(info);
    }
    if !registered || !ours || path_key(&info.path) == path_key(&info.repo) {
        return Removal::Kept(format!("{} is not a worktree this app made, so it was left alone", info.path));
    }
    if branch_exists(repo, &info.branch) {
        let unmerged = count(repo, &format!("{}..{}", branch_ref(&info.target), branch_ref(&info.branch))).unwrap_or(1);
        if unmerged > 0 {
            return Removal::Kept(format!("{unmerged} commit{} on branch {} {} not merged into {}", if unmerged == 1 { "" } else { "s" }, info.branch, if unmerged == 1 { "is" } else { "are" }, info.target));
        }
    }
    let dirty = uncommitted_in(wt);
    if !dirty.is_empty() {
        let shown: Vec<String> = dirty.iter().take(6).cloned().collect();
        return Removal::Kept(format!("it has uncommitted work: {}{}", shown.join(", "), if dirty.len() > shown.len() { " and more" } else { "" }));
    }
    // Checked before anything is unlinked or deleted: a kept tree stays whole.
    if let Some(why) = module_risk(wt) {
        return Removal::Kept(why);
    }
    if let Err(why) = unlink_reparse_points(wt) {
        return Removal::Kept(format!("{why}, so the folder was not removed"));
    }
    let wt_arg = wt.to_string_lossy();
    // Git for Windows stops at the first path longer than 260 characters (a deep
    // node_modules has them) unless core.longpaths is on, and it has unregistered
    // the tree by then: the folder stayed half deleted, and the retry no longer
    // knew it as ours (every worktree sub of 2026-11-10/11 was left this way).
    let mut removed = run(repo, &["-c", "core.longpaths=true", "worktree", "remove", &wt_arg]);
    if wt.exists() {
        // Every link is gone, so --force cannot reach the main checkout.
        removed = run(repo, &["-c", "core.longpaths=true", "worktree", "remove", "--force", &wt_arg]);
    }
    if wt.exists() && !is_registered(repo, &info.path) {
        // Git let go of the tree and left files behind. Every check above passed
        // and every link is gone, so what is left is this tree's own files.
        if let Err(e) = std::fs::remove_dir_all(wt) {
            removed.err = format!("{} (then: {e})", removed.err);
        }
        let _ = run(repo, &["worktree", "prune"]);
    }
    if wt.exists() {
        return Removal::Kept(format!("git could not remove the folder: {}", short(&removed.err, 200)));
    }
    forget_branch();
    remove_holder(info)
}

/// A closed sub's tree (`sub-<id>/tree`, marked by [`on_ended`]) that git no
/// longer lists and whose `.git` link is gone, with its branch merged or gone:
/// what a removal leaves when git gave up part way, after its merged, clean and
/// submodule checks passed.
fn half_removed(info: &WorktreeInfo) -> bool {
    let repo = Path::new(&info.repo);
    let merged = !branch_exists(repo, &info.branch) || is_ancestor(repo, &branch_ref(&info.branch), &branch_ref(&info.target));
    // Closed: a running sub whose `.git` link went some other way keeps its files.
    let closed = holder_of(info).is_some_and(|h| h.join(CLOSED_MARK).is_file());
    closed && !Path::new(&info.path).join(".git").exists() && merged
}

/// Whether git lists `path` as one of `repo`'s worktrees.
fn is_registered(repo: &Path, path: &str) -> bool {
    run(repo, &["worktree", "list", "--porcelain"]).out.lines().filter_map(|l| l.strip_prefix("worktree ")).any(|p| path_key(p) == path_key(path))
}

/// Deletes the `sub-<id>/` folder around a tree that is already gone: the build
/// config and cargo's output for that tree, which no other tree reads.
fn remove_holder(info: &WorktreeInfo) -> Removal {
    let Some(holder) = holder_of(info) else { return Removal::Removed };
    if !holder.exists() {
        return Removal::Removed;
    }
    if Path::new(&info.path).exists() {
        return Removal::Kept(format!("{} is still there, so the folder around it was left alone", info.path));
    }
    if let Err(why) = unlink_reparse_points(&holder) {
        return Removal::BuildLeft(why);
    }
    // The build output first: a file a killed build still holds is in there, and a
    // failure must leave the closed mark for the boot sweep to retry.
    let target = holder.join("target");
    if target.exists() {
        if let Err(e) = std::fs::remove_dir_all(&target) {
            return Removal::BuildLeft(format!("its build folder {} could not be deleted: {e}", target.display()));
        }
    }
    match std::fs::remove_dir_all(&holder) {
        Ok(()) => Removal::Removed,
        Err(e) => Removal::BuildLeft(format!("its build folder {} could not be deleted: {e}", holder.display())),
    }
}

/// [`remove_if_safe`], tried again a few times while the failure is one that a
/// just-killed child can cause.
fn remove_retrying(info: &WorktreeInfo) -> Removal {
    let mut result = remove_if_safe(info);
    for _ in 0..3 {
        if !result.may_clear() {
            break;
        }
        #[cfg(not(test))]
        std::thread::sleep(Duration::from_secs(1));
        result = remove_if_safe(info);
    }
    result
}

/// The hook `end_sub` calls: a sub that ended removes its worktree when that is
/// safe, on its own thread (the folder can hold a `node_modules` of thousands
/// of files, and a killed child may still hold a lock for a moment). A tree that
/// has to stay draws a card, so the unmerged commits are not forgotten.
pub(super) fn on_ended(state: &Arc<DaemonState>, sub_id: &str) {
    let Some(info) = info_of(sub_id) else { return };
    // What tells the boot sweep this tree was closed on purpose, so it never
    // touches one whose row ended any other way (an app shutdown, a dead process).
    if let Some(holder) = holder_of(&info).filter(|h| h.is_dir()) {
        let _ = std::fs::write(holder.join(CLOSED_MARK), "closed\n");
    }
    let (state, id) = (state.clone(), sub_id.to_string());
    let work = move || {
        let b = match remove_retrying(&info) {
            Removal::Removed => return,
            Removal::Kept(why) => Blocked {
                verdict: "Worktree kept",
                text: format!("Its worktree was kept at {} on branch {}: {why}. Nothing was deleted.", info.path, info.branch),
                points: Vec::new(),
                cause: Cause::Other,
            },
            Removal::BuildLeft(why) => Blocked {
                verdict: "Build folder left",
                text: format!("Its worktree and branch {} were removed, but {why}. It is retried when the app starts; delete it by hand to free the space sooner.", info.branch),
                points: Vec::new(),
                cause: Cause::Other,
            },
        };
        report(&state, &id, None, &b);
        // The card goes to the main chat's window, which is often the thing
        // closing (Close them too, or a closed chat's finished subs): nobody
        // may be there to read it. The app log is the place that always is.
        log::warn!("subchats: worktree of {id} at {} on branch {}: {}", info.path, info.branch, b.text);
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
    let blocker = match landing {
        Landing::Blocked(b) => {
            log::warn!("subchats: {sub_id} left the sub role with its branch {} not merged: {}", info.branch, b.text);
            Blocked { text: format!("{} {where_it_is}", b.text), ..b }
        }
        Landing::Merged => Blocked {
            verdict: "Moved with its worktree",
            text: format!(
                "It is a normal chat now. {ahead} commit{} merged into {}. {where_it_is}",
                if ahead == 1 { " was" } else { "s were" },
                info.target
            ),
            points: Vec::new(),
            cause: Cause::Other,
        },
        Landing::Nothing => Blocked {
            verdict: "Moved with its worktree",
            text: format!("It is a normal chat now. Its branch has nothing {} lacks. {where_it_is}", info.target),
            points: Vec::new(),
            cause: Cause::Other,
        },
    };
    let tone = if blocker.verdict == "Moved with its worktree" { "neutral" } else { "bad" };
    let Some(parent) = parent else { return };
    let card = BlockerCard { text: blocker.text, verdict: blocker.verdict.to_string(), tone: Some(tone.into()), points: blocker.points };
    card_log::on_blocker_for(state, &parent, sub_id, card);
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
    for h in super::held::all().into_iter().filter(|h| h.after.is_none()) {
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
/// only: its card was drawn when the sub ended, and a card on every start would
/// repeat it.
pub(super) fn sweep_ended(state: &Arc<DaemonState>) {
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
    if trees.is_empty() {
        return;
    }
    let work = move || {
        for (id, info) in trees {
            match remove_retrying(&info) {
                Removal::Removed => log::info!("subchats: removed the worktree of ended sub {id} at {}", info.path),
                Removal::Kept(why) | Removal::BuildLeft(why) => log::warn!("subchats: worktree of ended sub {id} at {} stays: {why}", info.path),
            }
        }
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

/// Whether `sub_id` runs in its own worktree.
pub fn is_worktree_sub(sub_id: &str) -> bool {
    info_of(sub_id).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::daemon::subchats::git::test_repo;
    use crate::daemon::subchats::{card_log, held, SubchatArgs, TempDataDir};
    use crate::sessions::chat_config::{self, ChatConfig};
    use crate::types::Settings;

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

    fn brief_json(writes: bool, extra: &str) -> SubchatBrief {
        serde_json::from_str(&format!(r#"{{"parent":"m","task":"t","goal":"g","done_when":"d","writes":{writes},"files":["a.txt"]{extra}}}"#)).unwrap()
    }

    /// A worktree sub of a main chat at `root`, with its row, its stored brief and
    /// a real worktree. Returns the sub's id and its tree.
    fn new_sub(st: &Arc<DaemonState>, tag: &str, root: &Path) -> (String, WorktreeInfo) {
        let sid = uuid::Uuid::new_v4().to_string();
        let Ok(Prepare::Ready(p)) = prepare(root, &sid) else { panic!("a scratch repo can have a worktree") };
        let (parent, id) = (format!("{tag}-main"), sid);
        st.registry.upsert_interactive(&parent, root, "proj", TS);
        st.registry.upsert_interactive(&id, Path::new(&p.info.cwd), "proj", TS);
        st.registry.set_subchat_of(&id, Some(parent.clone()));
        st.registry.set_name(&id, tag.to_string());
        let mut brief = brief_json(true, "");
        brief.parent = parent;
        brief.worktree_at = Some(p.info.clone());
        brief.git_head_at_spawn = git::head(Path::new(&p.info.cwd));
        chat_config::set_subchat(&id, Some(brief));
        (id, p.info)
    }

    /// Text with line endings normalised: git on Windows checks files out as CRLF.
    fn read(path: &Path) -> String {
        std::fs::read_to_string(path).unwrap_or_default().replace("\r\n", "\n")
    }

    /// The exact bytes, for the proof that nobody's uncommitted file was touched.
    fn raw(path: &Path) -> Vec<u8> {
        std::fs::read(path).unwrap_or_default()
    }

    fn target_of(root: &Path) -> String {
        current_branch(root).unwrap()
    }

    fn blockers(parent: &str) -> Vec<card_log::CardEntry> {
        card_log::read(parent).into_iter().filter(|c| c.kind == card_log::KIND_BLOCKER).collect()
    }

    /// The wakes queued for `parent`, the main chat a plumbing problem goes to.
    fn wakes(st: &DaemonState, parent: &str) -> usize {
        st.repo_channel_wakes.lock().unwrap().get(parent).map_or(0, |q| q.len())
    }

    // ---- when it applies ----------------------------------------------------------

    #[test]
    fn every_writer_gets_a_worktree_and_a_read_only_sub_or_a_gate_does_not() {
        assert!(wants(&brief_json(true, "")), "a writer gets its own tree with no setting and no flag");
        assert!(!wants(&brief_json(false, r#","worktree":true"#)), "a read-only sub stays on the main checkout");
        let mut gate = brief_json(true, r#","worktree":true"#);
        gate.gate = true;
        assert!(!wants(&gate), "a gate pushes from the main checkout");
    }

    #[test]
    fn the_spawn_makes_a_worktree_for_every_writer_and_none_for_a_read_only_sub() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        let sid = uuid::Uuid::new_v4().to_string();
        assert!(plan_spawn(&brief_json(false, ""), &root, &sid).unwrap().is_none(), "read-only");
        let made = plan_spawn(&brief_json(true, ""), &root, &sid).unwrap().expect("a writer gets a tree");
        assert!(Path::new(&made.info.path).is_dir());
        let other = uuid::Uuid::new_v4().to_string();
        let second = plan_spawn(&brief_json(true, ""), &root, &other).unwrap().expect("and so does a second writer");
        assert_ne!(made.info.path, second.info.path, "side by side, never queued");
    }

    // ---- creating it ----------------------------------------------------------------

    #[test]
    fn a_worktree_is_a_new_branch_off_head_under_the_repo_and_stays_out_of_git_status() {
        let (_d, root) = test_repo::init();
        let sid = "abcdef12-0000";
        let Ok(Prepare::Ready(p)) = prepare(&root, sid) else { panic!("ready") };
        let wt = Path::new(&p.info.path);
        assert!(wt.is_dir());
        assert_eq!(path_key(&p.info.path), path_key(&format!("{}/.claude/worktrees/sub-abcdef12/tree", root.to_string_lossy())));
        assert_eq!(p.info.branch, "sub/abcdef12");
        assert_eq!(p.info.target, target_of(&root));
        assert_eq!(git::head(wt), git::head(&root), "off the current HEAD");
        assert_eq!(current_branch(wt).as_deref(), Some("sub/abcdef12"));
        assert!(run(&root, &["status", "--porcelain"]).out.is_empty(), "the worktree folder is excluded locally: {:?}", run(&root, &["status", "--porcelain"]).out);
        assert_eq!(p.info.cwd, p.info.path, "a project at the repo top runs at the worktree top");
    }

    #[test]
    fn a_project_in_a_subfolder_runs_at_the_same_subfolder_of_its_worktree() {
        let (_d, root) = test_repo::init();
        std::fs::create_dir_all(root.join("web")).unwrap();
        commit_file(&root, "web/index.html", "<p>hi</p>\n");
        let Ok(Prepare::Ready(p)) = prepare(&root.join("web"), "11112222") else { panic!("ready") };
        assert_eq!(path_key(&p.info.cwd), path_key(&format!("{}/web", p.info.path)));
        assert!(Path::new(&p.info.cwd).join("index.html").is_file());
    }

    #[test]
    fn a_folder_that_cannot_have_a_worktree_falls_back_instead_of_failing() {
        let plain = tempfile::tempdir().unwrap();
        assert!(matches!(prepare(plain.path(), "aaaa0000"), Ok(Prepare::Unusable(w)) if w.contains("not a git repository")));
        let (_d, root) = test_repo::init();
        g(&root, &["checkout", "-q", "--detach"]);
        assert!(matches!(prepare(&root, "bbbb0000"), Ok(Prepare::Unusable(w)) if w.contains("detached")));
    }

    #[test]
    fn the_worktree_is_inside_the_same_project_and_the_checks_accept_it() {
        let (_d, root) = test_repo::init();
        let Ok(Prepare::Ready(p)) = prepare(&root, "cccc0000") else { panic!("ready") };
        assert_eq!(project_key(Path::new(&p.info.cwd)), project_key(&root), "the dashboard, list_peers and the settings lookup group it with the repo");
        assert!(crate::daemon::subchats::spawn::check_same_project(&root, Path::new(&p.info.cwd)).is_ok());
    }

    /// The project dashboard groups chats by project id and `list_peers` reads the
    /// same id: a worktree cwd must land in the repo's project, not a new one.
    #[test]
    fn a_worktree_cwd_registers_under_the_repos_own_project() {
        let (_d, root) = test_repo::init();
        let Ok(Prepare::Ready(p)) = prepare(&root, "ffff0000") else { panic!("ready") };
        let st = state();
        let (main_id, created) = st.settings.upsert_project_for_cwd(&root, TS);
        assert!(created);
        let (tree_id, created_again) = st.settings.upsert_project_for_cwd(Path::new(&p.info.cwd), TS);
        assert_eq!(tree_id, main_id, "one project, so the dashboard groups it and list_peers finds it");
        assert!(!created_again, "no second project row for the worktree");
    }

    #[test]
    fn the_first_message_says_where_the_sub_is_and_what_is_not_covered() {
        let (_d, root) = test_repo::init();
        std::fs::create_dir_all(root.join("node_modules").join("pkg")).unwrap();
        let Ok(Prepare::Ready(p)) = prepare(&root, "dddd0000") else { panic!("ready") };
        assert!(matches!(p.setup, Setup::Junction { .. }));
        let note = first_message_note(&p);
        for needle in ["own git worktree", "sub/dddd0000", &p.info.target, "node_modules is a link", "Python virtual environment", "dev server", "database", "still shared"] {
            assert!(note.contains(needle), "{needle:?} missing: {note}");
        }
        assert!(!note.contains('\u{2014}'));
        let (_d2, bare) = test_repo::init();
        let Ok(Prepare::Ready(q)) = prepare(&bare, "eeee0000") else { panic!("ready") };
        assert_eq!(q.setup, Setup::Nothing);
        assert!(first_message_note(&q).contains("Nothing was set up"));
    }

    #[test]
    fn the_spawn_result_carries_the_worktree_note_once() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        let st = state();
        let sid = uuid::Uuid::new_v4().to_string();
        let made = plan_spawn(&brief_json(true, ""), &root, &sid).unwrap().unwrap();
        let note = super::super::writers::spawn_note(&st, &sid).expect("the main chat is told");
        assert!(note["note"].as_str().unwrap().contains(&made.info.branch), "{note}");
        assert!(super::super::writers::spawn_note(&st, &sid).is_none(), "said once");
    }

    // ---- merging back ------------------------------------------------------------------

    #[test]
    fn finish_merges_the_commits_and_fast_forwards_the_checked_out_branch_and_its_files() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        let st = state();
        let (id, info) = new_sub(&st, "merge", &root);
        commit_file(Path::new(&info.path), "a.txt", "from the sub\n");
        let before = git::head(&root).unwrap();
        assert_eq!(land(&id, &info), Landing::Merged);
        assert_ne!(git::head(&root).unwrap(), before);
        assert_eq!(git::head(&root), git::head(Path::new(&info.path)), "a fast-forward, no merge commit");
        assert_eq!(read(&root.join("a.txt")), "from the sub\n", "the main checkout's files moved with its branch");
        assert!(run(&root, &["status", "--porcelain"]).out.is_empty());
    }

    #[test]
    fn a_peers_dirty_file_elsewhere_does_not_block_the_merge_and_keeps_its_bytes() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        let st = state();
        let (id, info) = new_sub(&st, "peer", &root);
        commit_file(Path::new(&info.path), "a.txt", "sub\n");
        std::fs::write(root.join("base.txt"), "someone else is editing this\n").unwrap();
        std::fs::write(root.join("scratch.txt"), "untracked\n").unwrap();
        assert_eq!(land(&id, &info), Landing::Merged);
        assert_eq!(raw(&root.join("base.txt")), b"someone else is editing this\n");
        assert_eq!(raw(&root.join("scratch.txt")), b"untracked\n");
        assert_eq!(read(&root.join("a.txt")), "sub\n");
    }

    #[test]
    fn a_dirty_overlap_refuses_keeps_the_merge_pending_on_the_file_and_clobbers_nothing() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        let st = state();
        let (id, info) = new_sub(&st, "overlap", &root);
        commit_file(Path::new(&info.path), "base.txt", "the sub's version\n");
        std::fs::write(root.join("base.txt"), "mine, not committed\n").unwrap();
        let head_before = git::head(&root).unwrap();
        let landing = land_and_report(&st, &id, &info);
        let Landing::Blocked(b) = landing else { panic!("must refuse: {landing:?}") };
        assert_eq!(b.points, vec!["base.txt".to_string()]);
        assert_eq!(raw(&root.join("base.txt")), b"mine, not committed\n", "not a byte of it was touched");
        assert_eq!(git::head(&root).unwrap(), head_before, "the target did not move");
        assert_eq!(count(Path::new(&info.path), &format!("{}..HEAD", branch_ref(&info.target))), Some(1), "the commit is safe");
        assert!(b.text.contains("uncommitted"), "{}", b.text);
        assert!(blockers("overlap-main").is_empty(), "another chat's edit is nobody's card");
        assert_eq!(wakes(&st, "overlap-main"), 0, "and wakes nobody");
        assert_eq!(super::super::pending_merges::get(&id).unwrap().files, vec!["base.txt".to_string()]);
    }

    /// A file git ignores is invisible to the dirty check, so a sub that commits
    /// one at the same path (`git add -f`) used to have its merge overwrite the
    /// local copy silently.
    #[test]
    fn an_ignored_local_file_the_merge_would_overwrite_is_refused_and_keeps_its_bytes() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        let st = state();
        commit_file(&root, ".gitignore", "secret.env\n");
        std::fs::write(root.join("secret.env"), "API_KEY=mine\n").unwrap();
        let (id, info) = new_sub(&st, "ignored", &root);
        let wt = PathBuf::from(&info.path);
        std::fs::write(wt.join("secret.env"), "API_KEY=the sub's\n").unwrap();
        g(&wt, &["add", "-f", "secret.env"]);
        g(&wt, &["commit", "-q", "-m", "add the env file"]);
        let head_before = git::head(&root).unwrap();
        let landing = land_and_report(&st, &id, &info);
        let Landing::Blocked(b) = landing else { panic!("must refuse: {landing:?}") };
        assert!(b.points.iter().any(|p| p == "secret.env"), "the card names the file: {b:?}");
        assert_eq!(raw(&root.join("secret.env")), b"API_KEY=mine\n", "not a byte of the ignored file was touched");
        assert_eq!(git::head(&root).unwrap(), head_before, "the target did not move");
        assert_eq!(count(&wt, &format!("{}..HEAD", branch_ref(&info.target))), Some(1), "the commit is safe");
        assert!(blockers("ignored-main").is_empty(), "no card for Joe");
        assert_eq!(wakes(&st, "ignored-main"), 1, "the main chat is handed it");
        assert!(super::super::plumbing::current(&id).unwrap().files.contains(&"secret.env".to_string()));
    }

    #[test]
    fn a_staged_change_in_the_main_checkout_counts_as_dirty_too() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        let st = state();
        let (id, info) = new_sub(&st, "staged", &root);
        commit_file(Path::new(&info.path), "base.txt", "sub\n");
        std::fs::write(root.join("base.txt"), "staged\n").unwrap();
        g(&root, &["add", "base.txt"]);
        assert!(matches!(land(&id, &info), Landing::Blocked(_)));
        assert_eq!(raw(&root.join("base.txt")), b"staged\n");
    }

    #[test]
    fn a_merge_conflict_keeps_the_commits_draws_no_card_and_a_resolved_finish_merges() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        let st = state();
        let (id, info) = new_sub(&st, "conflict", &root);
        let wt = PathBuf::from(&info.path);
        commit_file(&wt, "base.txt", "sub's line\n");
        commit_file(&root, "base.txt", "peer's line\n");
        let landing = land_and_report(&st, &id, &info);
        let Landing::Blocked(b) = landing else { panic!("conflicts: {landing:?}") };
        assert_eq!(b.verdict, "Merge conflict");
        assert_eq!(b.points, vec!["base.txt".to_string()]);
        assert!(wt.is_dir(), "the worktree stays");
        assert_eq!(count(&wt, &format!("{}..HEAD", branch_ref(&info.target))), Some(1), "its commit is not lost");
        assert!(run(&wt, &["status", "--porcelain"]).out.is_empty(), "the rebase was aborted, not left half done");
        assert_eq!(read(&root.join("base.txt")), "peer's line\n");
        assert!(blockers("conflict-main").is_empty(), "no card for Joe");
        // No runtime here to tell the sub on, so the main chat is handed it.
        assert_eq!(super::super::plumbing::current(&id).unwrap().files, vec!["base.txt".to_string()]);
        // The sub resolves it the way the card told it to, then finishes again.
        let t = branch_ref(&info.target);
        assert!(!run(&wt, &["rebase", &t]).ok, "the sub's own rebase hits the same conflict");
        std::fs::write(wt.join("base.txt"), "resolved\n").unwrap();
        g(&wt, &["add", "base.txt"]);
        g(&wt, &["-c", "core.editor=true", "rebase", "--continue"]);
        assert_eq!(land(&id, &info), Landing::Merged);
        assert_eq!(read(&root.join("base.txt")), "resolved\n");
    }

    #[test]
    fn a_target_that_moved_meanwhile_is_retried_once_and_both_sets_of_commits_land() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        let st = state();
        let (id, info) = new_sub(&st, "moved", &root);
        commit_file(Path::new(&info.path), "a.txt", "sub\n");
        let mut moved = |attempt: usize| {
            if attempt == 0 {
                commit_file(&root, "peer.txt", "landed while the merge ran\n");
            }
        };
        assert_eq!(land_with(&id, &info, &mut moved), Landing::Merged);
        assert_eq!(read(&root.join("a.txt")), "sub\n");
        assert_eq!(read(&root.join("peer.txt")), "landed while the merge ran\n", "the peer's commit is still there");
        assert_eq!(git::head(&root), git::head(Path::new(&info.path)));
    }

    #[test]
    fn a_target_that_keeps_moving_is_a_blocker_not_a_loop() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        let st = state();
        let (id, info) = new_sub(&st, "busy", &root);
        commit_file(Path::new(&info.path), "a.txt", "sub\n");
        let mut n = 0;
        let mut always = |_attempt: usize| {
            n += 1;
            commit_file(&root, &format!("peer{n}.txt"), "x\n");
        };
        assert!(matches!(land_with(&id, &info, &mut always), Landing::Blocked(_)));
        assert!(!root.join("a.txt").exists(), "nothing half merged");
    }

    #[test]
    fn a_branch_switched_in_the_main_checkout_is_refused_rather_than_merged_into_the_wrong_branch() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        let st = state();
        let (id, info) = new_sub(&st, "switched", &root);
        commit_file(Path::new(&info.path), "a.txt", "sub\n");
        g(&root, &["checkout", "-q", "-b", "elsewhere"]);
        let other_head = git::head(&root);
        let landing = land_and_report(&st, &id, &info);
        let Landing::Blocked(b) = landing else { panic!("refused: {landing:?}") };
        assert!(b.text.contains("elsewhere") && b.text.contains(&info.target), "{}", b.text);
        assert_eq!(git::head(&root), other_head, "the wrong branch was not touched");
        assert!(!root.join("a.txt").exists());
        assert!(blockers("switched-main").is_empty());
        assert_eq!(wakes(&st, "switched-main"), 1);
    }

    #[test]
    fn no_commits_means_no_merge() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        let st = state();
        let (id, info) = new_sub(&st, "nothing", &root);
        let before = git::head(&root);
        assert_eq!(land(&id, &info), Landing::Nothing);
        assert_eq!(git::head(&root), before);
        assert!(blockers("nothing-main").is_empty());
    }

    #[test]
    fn two_subs_finishing_together_both_land_through_the_repo_lock() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        let st = state();
        let (a, ia) = new_sub(&st, "pair-a", &root);
        let (b, ib) = new_sub(&st, "pair-b", &root);
        commit_file(Path::new(&ia.path), "a.txt", "a\n");
        commit_file(Path::new(&ib.path), "b.txt", "b\n");
        let (ta, tb) = (std::thread::spawn(move || land(&a, &ia)), std::thread::spawn(move || land(&b, &ib)));
        assert_eq!(ta.join().unwrap(), Landing::Merged);
        assert_eq!(tb.join().unwrap(), Landing::Merged);
        assert_eq!((read(&root.join("a.txt")), read(&root.join("b.txt"))), ("a\n".to_string(), "b\n".to_string()));
    }

    static REST: Mutex<Vec<(String, bool)>> = Mutex::new(Vec::new());
    fn rest_probe(_st: &Arc<DaemonState>, id: &str) {
        let landed = info_of(id).is_some_and(|i| Path::new(&i.repo).join("a.txt").exists());
        REST.lock().unwrap().push((id.to_string(), landed));
    }

    #[test]
    fn the_rest_of_finishing_runs_after_the_merge_and_only_for_a_worktree_sub() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        let st = state();
        let (id, info) = new_sub(&st, "defer", &root);
        commit_file(Path::new(&info.path), "a.txt", "sub\n");
        assert!(defer(&st, &id, rest_probe));
        assert!(REST.lock().unwrap().contains(&(id.clone(), true)), "the card and the sub waiting behind it see what landed");
        assert!(!merging(&project_key(&root)), "the merge is over");
        st.registry.upsert_interactive("plain-sub", &root, "proj", TS);
        assert!(!defer(&st, "plain-sub", rest_probe), "any other sub finishes at once");
    }

    // ---- continuing ------------------------------------------------------------------------

    #[tokio::test]
    async fn a_continued_sub_is_brought_up_to_date_before_its_message_and_its_facts_base_moves() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        let st = state();
        let (id, info) = new_sub(&st, "continue", &root);
        commit_file(Path::new(&info.path), "a.txt", "round one\n");
        assert_eq!(land(&id, &info), Landing::Merged);
        commit_file(&root, "peer.txt", "moved on\n");
        before_continue(&st, &id).await;
        let wt = Path::new(&info.path);
        assert_eq!(read(&wt.join("peer.txt")), "moved on\n", "it has what landed since");
        assert_eq!(git::head(wt), git::head(&root));
        assert_eq!(info_of(&id).unwrap().base, git::head(&root), "round two counts from here");
        assert!(blockers("continue-main").is_empty());
    }

    #[tokio::test]
    async fn a_continue_that_conflicts_wakes_the_main_chat_and_leaves_the_branch_alone() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        let st = state();
        let (id, info) = new_sub(&st, "cont-conflict", &root);
        commit_file(Path::new(&info.path), "base.txt", "sub\n");
        commit_file(&root, "base.txt", "peer\n");
        let before = git::head(Path::new(&info.path));
        before_continue(&st, &id).await;
        assert_eq!(git::head(Path::new(&info.path)), before, "nothing was rewritten");
        assert!(blockers("cont-conflict-main").is_empty(), "no card for Joe");
        assert_eq!(wakes(&st, "cont-conflict-main"), 1);
        let rec = super::super::plumbing::current(&id).unwrap();
        assert_eq!((rec.problem, rec.files), (super::super::plumbing::Problem::NotUpToDate, vec!["base.txt".to_string()]));
    }

    /// Only a sub told about this very conflict stays quiet: one whose merge waits
    /// for another chat's files still has its stale branch reported.
    #[tokio::test]
    async fn a_continue_that_conflicts_while_a_merge_waits_for_files_still_wakes_the_main_chat() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        let st = state();
        let (id, info) = new_sub(&st, "cont-pending", &root);
        commit_file(Path::new(&info.path), "base.txt", "sub\n");
        commit_file(&root, "base.txt", "peer\n");
        super::super::pending_merges::store(&id, super::super::pending_merges::Cause::DirtyFiles, vec!["other.txt".into()]);
        before_continue(&st, &id).await;
        assert_eq!(wakes(&st, "cont-pending-main"), 1);
        assert_eq!(super::super::plumbing::current(&id).unwrap().problem, super::super::plumbing::Problem::NotUpToDate);
    }

    // ---- setting up ---------------------------------------------------------------------------

    #[tokio::test]
    async fn before_launch_links_node_modules_once_and_a_junction_target_survives_removal() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        std::fs::create_dir_all(root.join("node_modules").join("pkg")).unwrap();
        std::fs::write(root.join("node_modules").join("pkg").join("index.js"), "module.exports = 1;\n").unwrap();
        let st = state();
        let (id, info) = new_sub(&st, "junction", &root);
        before_launch(&st, &id).await.unwrap();
        let link = Path::new(&info.path).join("node_modules");
        assert_eq!(read(&link.join("pkg").join("index.js")), "module.exports = 1;\n", "a JS project works in the new tree");
        assert!(is_link(&std::fs::symlink_metadata(&link).unwrap()));
        before_launch(&st, &id).await.unwrap();
        // The sub made no commits and left nothing uncommitted: removable.
        assert_eq!(remove_if_safe(&info), Removal::Removed);
        assert!(!Path::new(&info.path).exists());
        assert_eq!(read(&root.join("node_modules").join("pkg").join("index.js")), "module.exports = 1;\n", "the main checkout's node_modules is untouched");
        assert!(!branch_exists(&root, &info.branch));
        assert!(!run(&root, &["worktree", "list", "--porcelain"]).out.contains("sub-"));
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn a_failing_bootstrap_script_stops_the_launch_and_draws_no_card() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        std::fs::create_dir_all(root.join("scripts")).unwrap();
        commit_file(&root, "scripts/bootstrap-worktree.ps1", "Write-Host 'installing'\nexit 3\n");
        let st = state();
        let (id, _info) = new_sub(&st, "badscript", &root);
        let err = before_launch(&st, &id).await.expect_err("a broken tree must not start a sub");
        assert!(err.contains("could not be set up"), "{err}");
        assert!(err.contains("bootstrap-worktree.ps1"), "{err}");
        assert!(blockers("badscript-main").is_empty(), "the launch's caller hands it to the main chat");
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn the_repos_bootstrap_script_runs_once_in_the_new_tree() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        std::fs::create_dir_all(root.join("scripts")).unwrap();
        commit_file(&root, "scripts/bootstrap-worktree.ps1", "Add-Content -Path ran.txt -Value x\n");
        let st = state();
        let (id, info) = new_sub(&st, "goodscript", &root);
        before_launch(&st, &id).await.unwrap();
        before_launch(&st, &id).await.unwrap();
        assert_eq!(read(&Path::new(&info.path).join("ran.txt")).lines().count(), 1, "a second launch does not run it again");
        assert!(!root.join("ran.txt").exists(), "it ran in the worktree, not the main checkout");
    }

    #[test]
    fn registering_a_worktree_sub_holds_it_for_its_setup_without_taking_the_writer_slot() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        let st = state();
        st.registry.upsert_interactive("reg-main", &root, "proj", TS);
        let cfg = ChatConfig { subchats_on: true, ..Default::default() };
        let args = SubchatArgs {
            task: Some("Footer".into()),
            goal: Some("g".into()),
            done_when: Some("d".into()),
            writes: Some(true),
            files: Some(vec!["footer.ts".into()]),
            ..Default::default()
        };
        let mut plan = crate::daemon::subchats::spawn::plan(&st, "reg-main", &cfg, &root.to_string_lossy(), None, None, None, Some("footer"), &args, &[])
            .unwrap()
            .unwrap();
        let sid = uuid::Uuid::new_v4().to_string();
        let prepared = plan_spawn(&plan.brief, &root, &sid).unwrap().unwrap();
        plan.brief.worktree_at = Some(prepared.info.clone());
        let spec = held::LaunchSpec {
            cwd: PathBuf::from(&prepared.info.cwd),
            model: "sonnet".into(),
            effort: "high".into(),
            account_id: Some("acct".into()),
            first_message: plan.first_message.clone(),
        };
        let id = register_row(&st, "reg-main", Some("footer"), &cfg, spec, &mut plan, sid.clone()).unwrap();
        assert_eq!(id, sid);
        let inst = st.registry.get(&id).unwrap();
        assert_eq!(path_key(&inst.cwd.to_string_lossy()), path_key(&prepared.info.cwd), "the sub's cwd is its worktree");
        assert_eq!(inst.progress.waiting_for.as_deref(), Some(SETUP_TEXT));
        assert!(held::is_held(&id));
        assert_eq!(super::super::writers::holder_of(&root), None, "writers in worktrees do not queue");
        assert!(super::super::writers::queue_of(&root).is_empty());
        let stored = info_of(&id).expect("the path is recorded in the stored brief");
        assert_eq!(stored.path, prepared.info.path);
        assert_eq!(git::head(&inst.cwd), git::head(&root));
        assert!(super::super::writers::restore_inner(&st).is_empty(), "boot must not hand a worktree sub the slot");
        assert_eq!(super::super::writers::queue_of(&root), Vec::<String>::new());
    }

    #[test]
    fn the_stored_tree_survives_a_restart_and_an_old_brief_without_one_still_loads() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        let st = state();
        let (id, info) = new_sub(&st, "restart", &root);
        // A restart rebuilds everything from the stored brief.
        let reread = chat_config::get(&id).unwrap().subchat.unwrap().worktree_at.unwrap();
        assert_eq!(reread, info);
        let json = serde_json::to_string(&chat_config::get(&id).unwrap().subchat.unwrap()).unwrap();
        let again: SubchatBrief = serde_json::from_str(&json).unwrap();
        assert_eq!(again.worktree_at, Some(info));
        let old: SubchatBrief = serde_json::from_str(r#"{"parent":"m","task":"t"}"#).unwrap();
        assert_eq!(old.worktree_at, None);
    }

    // ---- removing -------------------------------------------------------------------------------

    #[test]
    fn a_worktree_with_unmerged_commits_is_kept_and_so_is_one_with_uncommitted_work() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        let st = state();
        let (_id, info) = new_sub(&st, "keep", &root);
        let wt = PathBuf::from(&info.path);
        commit_file(&wt, "a.txt", "unmerged\n");
        let Removal::Kept(why) = remove_if_safe(&info) else { panic!("must keep") };
        assert!(why.contains("not merged"), "{why}");
        assert!(wt.is_dir() && branch_exists(&root, &info.branch));
        // Merged, but a new edit is uncommitted.
        let (id2, info2) = new_sub(&st, "keep2", &root);
        let wt2 = PathBuf::from(&info2.path);
        assert_eq!(land(&id2, &info2), Landing::Nothing);
        std::fs::write(wt2.join("scratch.txt"), "half done\n").unwrap();
        let Removal::Kept(why) = remove_if_safe(&info2) else { panic!("must keep") };
        assert!(why.contains("uncommitted") && why.contains("scratch.txt"), "{why}");
        assert_eq!(read(&wt2.join("scratch.txt")), "half done\n", "nothing was deleted");
    }

    #[test]
    fn a_merged_clean_worktree_is_removed_with_its_branch() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        let st = state();
        let (id, info) = new_sub(&st, "clean", &root);
        commit_file(Path::new(&info.path), "a.txt", "x\n");
        assert_eq!(land(&id, &info), Landing::Merged);
        assert_eq!(remove_if_safe(&info), Removal::Removed);
        assert!(!Path::new(&info.path).exists());
        assert!(!branch_exists(&root, &info.branch));
        assert_eq!(read(&root.join("a.txt")), "x\n", "the merged work stays in the main checkout");
        assert_eq!(remove_if_safe(&info), Removal::Removed, "removing twice is harmless");
    }

    /// A file deeper than Windows' 260-character limit (a pnpm node_modules has
    /// hundreds) stopped `git worktree remove` half way, after git had already
    /// unregistered the tree, so the folder stayed and the retry no longer knew it
    /// as ours: every worktree sub of 2026-11-10/11 was left behind this way.
    #[test]
    fn a_tree_holding_paths_longer_than_windows_allows_is_removed_whole() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        commit_file(&root, ".gitignore", "node_modules/\n");
        let st = state();
        let (id, info) = new_sub(&st, "deep", &root);
        let wt = PathBuf::from(&info.path);
        let deep = wt.join("node_modules").join("a".repeat(60)).join("b".repeat(60)).join("c".repeat(60)).join("d".repeat(60));
        std::fs::create_dir_all(&deep).unwrap();
        std::fs::write(deep.join("index.d.ts"), "export {};\n").unwrap();
        assert!(deep.join("index.d.ts").to_string_lossy().len() > 260, "precondition: past MAX_PATH");
        assert_eq!(land(&id, &info), Landing::Nothing);
        assert_eq!(remove_if_safe(&info), Removal::Removed);
        assert!(!wt.exists(), "no half-deleted folder is left");
        assert!(!branch_exists(&root, &info.branch));
        assert!(!holder_of(&info).unwrap().exists(), "and nothing around it");
    }

    /// A shared target dir keeps a copy of the project's own crates per tree path
    /// that nothing frees (112GB on 2026-11-12): each tree builds into a folder of
    /// its own beside it, and that folder goes with the tree.
    #[test]
    fn a_tree_builds_into_its_own_folder_and_the_folder_goes_with_the_tree() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        let st = state();
        let (id, info) = new_sub(&st, "build", &root);
        let holder = holder_of(&info).expect("a new tree has a folder around it");
        let config = read(&holder.join(".cargo").join("config.toml"));
        let want = holder.join("target").to_string_lossy().replace('\\', "/");
        assert!(config.contains(&format!("target-dir = \"{want}\"")), "{config}");
        assert!(run(Path::new(&info.path), &["status", "--porcelain"]).out.is_empty(), "the config is outside the tree, so git add -A never commits it");
        let output = holder.join("target").join("debug").join("deps");
        std::fs::create_dir_all(&output).unwrap();
        std::fs::write(output.join("libapp-0123.rlib"), vec![0u8; 4096]).unwrap();
        assert_eq!(land(&id, &info), Landing::Nothing);
        assert_eq!(remove_if_safe(&info), Removal::Removed);
        assert!(!holder.exists(), "the build output and its config are deleted with the tree");
    }

    /// Cargo itself must pick the folder: a config it does not read would leave the
    /// builds in the shared dir. Skipped where CARGO_TARGET_DIR is set, which
    /// outranks any config file.
    #[test]
    fn cargo_run_in_the_tree_reports_the_trees_own_target_dir() {
        if std::env::var_os("CARGO_TARGET_DIR").is_some() || std::env::var_os("CARGO_BUILD_TARGET_DIR").is_some() {
            return;
        }
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        std::fs::create_dir_all(root.join("src")).unwrap();
        commit_file(&root, "Cargo.toml", "[package]\nname = \"probe\"\nversion = \"0.1.0\"\nedition = \"2021\"\n\n[workspace]\n");
        commit_file(&root, "src/lib.rs", "\n");
        let Ok(Prepare::Ready(p)) = prepare(&root, "c4c4c4c4") else { panic!("ready") };
        let mut cmd = std::process::Command::new("cargo");
        cmd.args(["metadata", "--format-version", "1", "--no-deps", "--offline"]).current_dir(&p.info.path);
        let out = cmd.output().expect("cargo runs");
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        let meta: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
        let got = meta["target_directory"].as_str().unwrap();
        let holder = holder_of(&p.info).unwrap();
        assert_eq!(path_key(got), path_key(&holder.join("target").to_string_lossy()));
        discard(&p.info);
    }

    /// A removal that failed when the sub ended (here: a file it left uncommitted,
    /// since deleted), or one the daemon never ran because it stopped first, is
    /// done at the next start.
    #[test]
    fn a_tree_left_by_an_ended_sub_is_removed_at_the_next_start() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        let st = state();
        let (id, info) = new_sub(&st, "sweep", &root);
        let wt = PathBuf::from(&info.path);
        std::fs::write(wt.join("scratch.txt"), "half done\n").unwrap();
        assert!(crate::daemon::subchats::end_sub(&st, &id));
        assert!(wt.is_dir(), "kept at the end: it had uncommitted work");
        std::fs::remove_file(wt.join("scratch.txt")).unwrap();
        let (live, live_info) = new_sub(&st, "sweep-live", &root);
        let (died, died_info) = new_sub(&st, "sweep-died", &root);
        st.registry.mark_ended(&died, crate::types::EndReason::ProcessGone, TS);
        sweep_ended(&st);
        assert!(!wt.exists() && !holder_of(&info).unwrap().exists(), "the closed sub's tree is gone");
        assert!(Path::new(&live_info.path).is_dir(), "a sub that has not ended keeps its tree: {live}");
        assert!(Path::new(&died_info.path).is_dir(), "a sub whose process died can be brought back, so it keeps its tree: {died}");
    }

    /// A closed sub that is brought back is not closed any more, so its mark goes
    /// and a later shutdown cannot make the boot sweep take its tree.
    #[tokio::test]
    async fn a_closed_sub_brought_back_loses_its_closed_mark() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        let st = state();
        let (id, info) = new_sub(&st, "revive", &root);
        let mark = holder_of(&info).unwrap().join(CLOSED_MARK);
        std::fs::write(&mark, "closed\n").unwrap();
        before_continue(&st, &id).await;
        assert!(!mark.exists());
    }

    /// A build that still holds a file in the build folder leaves it, and the
    /// closed mark stays so the boot sweep tries again.
    #[test]
    fn a_build_folder_that_cannot_go_yet_keeps_the_closed_mark_for_the_next_start() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        let st = state();
        let (id, info) = new_sub(&st, "held-build", &root);
        let holder = holder_of(&info).unwrap();
        std::fs::write(holder.join(CLOSED_MARK), "closed\n").unwrap();
        let deps = holder.join("target").join("debug");
        std::fs::create_dir_all(&deps).unwrap();
        let held = deps.join("app.exe");
        std::fs::write(&held, b"x").unwrap();
        assert_eq!(land(&id, &info), Landing::Nothing);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            // No FILE_SHARE_DELETE: what a running exe or a linker's open output does.
            let lock = std::fs::OpenOptions::new().read(true).share_mode(0x1).open(&held).unwrap();
            assert!(matches!(remove_if_safe(&info), Removal::BuildLeft(_)));
            assert!(holder.join(CLOSED_MARK).is_file(), "the mark is what the boot sweep looks for");
            assert!(!Path::new(&info.path).exists(), "the tree itself went");
            drop(lock);
        }
        assert_eq!(remove_if_safe(&info), Removal::Removed);
        assert!(!holder.exists());
    }

    /// A closed sub whose tree a chat that has not ended still works in (a row that
    /// kept the tree as its folder) is never swept out from under it.
    #[test]
    fn the_sweep_leaves_a_tree_a_live_chat_works_in() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        let st = state();
        let (id, info) = new_sub(&st, "sweep-used", &root);
        let wt = PathBuf::from(&info.path);
        std::fs::write(wt.join("scratch.txt"), "half done\n").unwrap();
        assert!(crate::daemon::subchats::end_sub(&st, &id));
        std::fs::remove_file(wt.join("scratch.txt")).unwrap();
        st.registry.upsert_interactive("kept-it", &wt, "proj", TS);
        sweep_ended(&st);
        assert!(wt.is_dir(), "a live chat's folder stays");
    }

    /// What git leaves when it gives up part way: the tree unregistered, its `.git`
    /// link gone, files left. The next removal finishes it instead of calling the
    /// folder someone else's.
    #[test]
    fn a_tree_git_left_half_removed_is_finished_by_the_next_removal() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        let st = state();
        let (id, info) = new_sub(&st, "half", &root);
        let wt = PathBuf::from(&info.path);
        assert_eq!(land(&id, &info), Landing::Nothing);
        std::fs::remove_file(wt.join(".git")).unwrap();
        g(&root, &["worktree", "prune"]);
        assert!(!is_registered(&root, &info.path), "precondition: git no longer lists it");
        std::fs::write(wt.join("unchecked.txt"), "a running sub's file\n").unwrap();
        assert!(matches!(remove_if_safe(&info), Removal::Kept(_)), "not closed: a running sub whose .git went missing keeps its files");
        assert!(wt.join("unchecked.txt").is_file());
        std::fs::write(holder_of(&info).unwrap().join(CLOSED_MARK), "closed\n").unwrap();
        assert_eq!(remove_if_safe(&info), Removal::Removed);
        assert!(!wt.exists() && !holder_of(&info).unwrap().exists());
        assert!(!branch_exists(&root, &info.branch));
        // A folder of ours that git never had, with its .git link, is still left alone.
        let (_id2, info2) = new_sub(&st, "half-2", &root);
        let wt2 = PathBuf::from(&info2.path);
        g(&root, &["worktree", "remove", "--force", &wt2.to_string_lossy()]);
        std::fs::create_dir_all(&wt2).unwrap();
        std::fs::write(wt2.join(".git"), "gitdir: elsewhere\n").unwrap();
        assert!(matches!(remove_if_safe(&info2), Removal::Kept(why) if why.contains("not a worktree this app made")));
        assert!(wt2.is_dir());
    }

    /// A scratch repo with an initialised submodule `mod`. The inner repo's temp
    /// dir is returned so the caller's binding keeps it alive.
    fn repo_with_module() -> (tempfile::TempDir, PathBuf, tempfile::TempDir, PathBuf) {
        let (inner_dir, inner) = test_repo::init();
        let (dir, root) = test_repo::init();
        // Git takes a plain path as the module's URL, not the `\\?\` form canonicalize gives.
        let url = inner.to_string_lossy().trim_start_matches(r"\\?\").replace('\\', "/");
        g(&root, &["-c", "protocol.file.allow=always", "submodule", "add", "-q", &url, "mod"]);
        g(&root, &["commit", "-q", "-m", "add the module"]);
        (inner_dir, inner, dir, root)
    }

    /// Initialises the module inside a sub's tree, the way a bootstrap script does.
    fn init_module(wt: &Path) -> PathBuf {
        g(wt, &["-c", "protocol.file.allow=always", "submodule", "update", "--init", "-q"]);
        let module = wt.join("mod");
        g(&module, &["config", "user.email", "t@example.com"]);
        g(&module, &["config", "user.name", "t"]);
        g(&module, &["config", "commit.gpgsign", "false"]);
        module
    }

    /// `git worktree remove` refuses any tree with an initialised submodule, so the
    /// removal always fell through to `--force`, which deletes the module's git dir
    /// with the tree: a commit made only there was lost while main pointed at it.
    #[test]
    fn a_submodule_commit_no_remote_has_keeps_the_tree_instead_of_force_removing_it() {
        let _data = TempDataDir::new();
        let (_i, _inner, _d, root) = repo_with_module();
        let st = state();
        let (id, info) = new_sub(&st, "module", &root);
        let wt = PathBuf::from(&info.path);
        let module = init_module(&wt);
        commit_file(&module, "m.txt", "only in this tree\n");
        let tip = git::head(&module).unwrap();
        g(&wt, &["add", "mod"]);
        g(&wt, &["commit", "-q", "-m", "point at the module commit"]);
        assert_eq!(land(&id, &info), Landing::Merged);
        assert!(uncommitted_in(&wt).is_empty(), "the superproject sees a clean tree, which is the trap");
        let Removal::Kept(why) = remove_if_safe(&info) else { panic!("must keep the tree") };
        assert!(why.contains("mod"), "it names the module: {why}");
        assert!(wt.is_dir(), "nothing was deleted");
        assert_eq!(git::head(&module).as_deref(), Some(tip.as_str()), "the only copy of the commit is still there");
    }

    #[test]
    fn a_submodule_at_a_pushed_commit_does_not_stop_the_removal() {
        let _data = TempDataDir::new();
        let (_i, _inner, _d, root) = repo_with_module();
        let st = state();
        let (id, info) = new_sub(&st, "module-clean", &root);
        let wt = PathBuf::from(&info.path);
        init_module(&wt);
        assert_eq!(land(&id, &info), Landing::Nothing);
        assert_eq!(remove_if_safe(&info), Removal::Removed);
        assert!(!wt.exists());
    }

    #[test]
    fn a_submodule_with_uncommitted_work_keeps_the_tree() {
        let _data = TempDataDir::new();
        let (_i, _inner, _d, root) = repo_with_module();
        let st = state();
        let (id, info) = new_sub(&st, "module-dirty", &root);
        let wt = PathBuf::from(&info.path);
        let module = init_module(&wt);
        assert_eq!(land(&id, &info), Landing::Nothing);
        std::fs::write(module.join("base.txt"), "half done\n").unwrap();
        let Removal::Kept(_) = remove_if_safe(&info) else { panic!("must keep the tree") };
        assert_eq!(read(&module.join("base.txt")), "half done\n");
    }

    /// A difference with an empty diff (a file rewritten with other line endings,
    /// which is what `cargo tauri android init` does to two tracked files) still
    /// shows as modified in `git status`, makes `git rebase` refuse with "You have
    /// unstaged changes", and counted as uncommitted work forever.
    fn eol_only_dirty_tree() -> (tempfile::TempDir, PathBuf, Arc<DaemonState>, String, WorktreeInfo) {
        let (d, root) = test_repo::init();
        g(&root, &["config", "core.autocrlf", "true"]);
        std::fs::write(root.join("eol.txt"), "one\r\ntwo\r\n").unwrap();
        g(&root, &["add", "eol.txt"]);
        g(&root, &["commit", "-q", "-m", "a file with CRLF in the work tree"]);
        let st = state();
        let (id, info) = new_sub(&st, "eol", &root);
        std::fs::write(Path::new(&info.path).join("eol.txt"), "one\ntwo\n").unwrap();
        (d, root, st, id, info)
    }

    #[test]
    fn a_line_ending_only_difference_is_not_uncommitted_work() {
        let _data = TempDataDir::new();
        let (_d, _root, _st, _id, info) = eol_only_dirty_tree();
        let wt = PathBuf::from(&info.path);
        assert!(!run(&wt, &["status", "--porcelain"]).out.is_empty(), "precondition: git status lists the file");
        assert!(run(&wt, &["diff", "--name-only"]).out.is_empty(), "precondition: and its diff is empty");
        assert!(uncommitted_in(&wt).is_empty(), "no real change, so no uncommitted work");
        assert_eq!(remove_if_safe(&info), Removal::Removed);
    }

    #[test]
    fn a_line_ending_only_difference_does_not_block_the_rebase_onto_a_moved_target() {
        let _data = TempDataDir::new();
        let (_d, root, _st, id, info) = eol_only_dirty_tree();
        let wt = PathBuf::from(&info.path);
        commit_file(&wt, "a.txt", "the sub's work\n");
        commit_file(&root, "peer.txt", "the target moved\n");
        assert_eq!(land(&id, &info), Landing::Merged, "the rebase must not stop at 'You have unstaged changes'");
        assert_eq!(read(&root.join("a.txt")), "the sub's work\n");
        assert_eq!(read(&root.join("peer.txt")), "the target moved\n");
    }

    /// Real edits stay real: settling the index must never hide work.
    #[test]
    fn a_real_edit_next_to_a_line_ending_only_difference_still_counts() {
        let _data = TempDataDir::new();
        let (_d, _root, _st, _id, info) = eol_only_dirty_tree();
        let wt = PathBuf::from(&info.path);
        std::fs::write(wt.join("base.txt"), "really changed\n").unwrap();
        assert_eq!(uncommitted_in(&wt), vec!["base.txt".to_string()]);
    }

    #[test]
    fn it_never_removes_a_folder_it_did_not_make() {
        let (_d, root) = test_repo::init();
        let info = WorktreeInfo {
            cwd: root.to_string_lossy().into_owned(),
            path: root.to_string_lossy().into_owned(),
            branch: "sub/none".into(),
            target: target_of(&root),
            repo: root.to_string_lossy().into_owned(),
            base: None,
        };
        assert!(matches!(remove_if_safe(&info), Removal::Kept(_)));
        assert!(root.join("base.txt").is_file());
    }

    #[test]
    fn ending_a_sub_removes_a_clean_merged_tree_and_keeps_an_unmerged_one_with_a_card() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        let st = state();
        let (done, done_info) = new_sub(&st, "end-clean", &root);
        commit_file(Path::new(&done_info.path), "a.txt", "x\n");
        assert_eq!(land(&done, &done_info), Landing::Merged);
        assert!(crate::daemon::subchats::end_sub(&st, &done));
        assert!(!Path::new(&done_info.path).exists(), "it goes with the sub");
        let (open, open_info) = new_sub(&st, "end-open", &root);
        commit_file(Path::new(&open_info.path), "b.txt", "unmerged\n");
        assert!(crate::daemon::subchats::end_sub(&st, &open));
        assert!(Path::new(&open_info.path).is_dir(), "unmerged work is never thrown away");
        let cards = blockers("end-open-main");
        assert_eq!(cards.len(), 1, "the close says so in a card");
        assert_eq!(cards[0].verdict, "Worktree kept");
        assert!(cards[0].text.contains("not merged"), "{}", cards[0].text);
    }

    // ---- leaving the sub role ----------------------------------------------------------------------

    /// Clearing the brief on "Move to sidebar" used to take the tree with it: nothing
    /// merged the branch, nothing removed the folder, and no card said so.
    #[tokio::test]
    async fn moving_a_worktree_sub_to_the_sidebar_merges_its_commits_and_says_where_its_branch_is() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        let st = state();
        let (id, info) = new_sub(&st, "mv", &root);
        commit_file(Path::new(&info.path), "a.txt", "from the sub\n");

        crate::daemon::subchats::move_to_sidebar(&st, &id).await.unwrap();

        assert_eq!(read(&root.join("a.txt")), "from the sub\n", "its commits landed at once");
        assert!(st.registry.get(&id).unwrap().subchat_of.is_none());
        assert!(Path::new(&info.path).is_dir(), "the chat keeps its worktree as its folder");
        let cards = blockers("mv-main");
        assert_eq!(cards.len(), 1, "{cards:?}");
        assert_eq!(cards[0].verdict, "Moved with its worktree");
        assert!(cards[0].text.contains(&info.path) && cards[0].text.contains(&info.branch), "it says where the branch is: {}", cards[0].text);
        assert!(cards[0].text.contains("1 commit was merged"), "{}", cards[0].text);
    }

    #[tokio::test]
    async fn a_conflict_on_move_is_a_blocker_card_naming_the_branch_and_path_and_loses_nothing() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        let st = state();
        let (id, info) = new_sub(&st, "mvc", &root);
        commit_file(Path::new(&info.path), "base.txt", "the sub's line\n");
        commit_file(&root, "base.txt", "the main checkout's line\n");

        crate::daemon::subchats::move_to_sidebar(&st, &id).await.unwrap();

        let cards = blockers("mvc-main");
        assert_eq!(cards.len(), 1, "{cards:?}");
        assert_eq!(cards[0].verdict, "Merge conflict");
        assert!(cards[0].text.contains(&info.path) && cards[0].text.contains(&info.branch), "{}", cards[0].text);
        assert_eq!(cards[0].points, vec!["base.txt".to_string()]);
        assert_eq!(count(Path::new(&info.path), &format!("{}..HEAD", branch_ref(&info.target))), Some(1), "the commit is safe");
        assert_eq!(read(&root.join("base.txt")), "the main checkout's line\n");
    }

    #[tokio::test]
    async fn a_sub_without_a_tree_moves_with_no_card() {
        let _data = TempDataDir::new();
        let st = state();
        st.registry.upsert_interactive("plain-main", Path::new("."), "proj", TS);
        st.registry.upsert_interactive("plain-sub", Path::new("."), "proj", TS);
        st.registry.set_subchat_of("plain-sub", Some("plain-main".into()));
        let mut brief = brief_json(false, "");
        brief.parent = "plain-main".into();
        chat_config::set_subchat("plain-sub", Some(brief));
        crate::daemon::subchats::move_to_sidebar(&st, "plain-sub").await.unwrap();
        assert!(card_log::read("plain-main").is_empty());
    }

    /// Closing the main chat ends its finished subs, and a tree with unmerged
    /// commits is kept with a card in a window that is closing.
    #[tokio::test]
    async fn closing_a_chat_whose_finished_sub_has_unmerged_commits_asks_and_names_them() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        let st = state();
        let (id, info) = new_sub(&st, "cu", &root);
        st.registry.set_subchat_finished(&id, true);
        assert!(!crate::daemon::subchats::closing::needs_approval(&st, "cu-main"), "nothing unmerged yet");
        commit_file(Path::new(&info.path), "a.txt", "unmerged\n");
        assert_eq!(unmerged_subs(&st, "cu-main"), vec![("cu".to_string(), 1)]);
        assert!(crate::daemon::subchats::closing::needs_approval(&st, "cu-main"));

        assert!(crate::daemon::subchats::closing::request_close(&st, "cu-main"), "the close is held");
        let mut card = None;
        for _ in 0..200 {
            card = st.list_prompts().await.into_iter().find(|p| p["payload"]["card_kind"] == crate::daemon::subchats::closing::KIND);
            if card.is_some() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let card = card.expect("the approval card is raised");
        let question = card["payload"]["questions"][0]["question"].as_str().unwrap();
        assert!(question.contains("unmerged commits") && question.contains("**cu** (1)"), "{question}");
        let labels: Vec<&str> =
            card["payload"]["questions"][0]["options"].as_array().unwrap().iter().map(|o| o["label"].as_str().unwrap()).collect();
        assert_eq!(labels, ["Close anyway", "Keep it open"], "nothing is running, so there is nothing to wait for");

        assert_eq!(land(&id, &info), Landing::Merged);
        assert!(!crate::daemon::subchats::closing::needs_approval(&st, "cu-main"), "merged work holds nothing");
    }

    // ---- facts ----------------------------------------------------------------------------------

    #[test]
    fn the_cards_facts_read_the_worktree_and_say_what_landed() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        let st = state();
        let (id, info) = new_sub(&st, "facts", &root);
        let wt = PathBuf::from(&info.path);
        commit_file(&wt, "a.txt", "one\n");
        commit_file(&wt, "a.txt", "two\n");
        std::fs::write(wt.join("b.txt"), "not committed\n").unwrap();
        let transcript = test_repo::transcript(_d.path(), &[("Write", &wt.join("a.txt")), ("Write", &wt.join("b.txt"))]);
        let inst = st.registry.get(&id).unwrap();
        let facts_of = |inst: &crate::types::Instance| {
            card_log::sub_facts(inst, crate::types::SubchatCheck::FactsOnly, None, &[], Some(&transcript))
        };
        let f = facts_of(&inst);
        assert_eq!(f.commits, Some(2), "counted from the tree, not the main checkout");
        assert_eq!(f.uncommitted, Some(1), "{:?}", f.uncommitted_files);
        assert_eq!(f.uncommitted_files, vec!["b.txt".to_string()]);
        assert_eq!(f.pushed, None, "no remote: not pushed stays unknown, never a guess");
        assert_eq!(f.merged_into.as_deref(), Some(info.target.as_str()));
        assert_eq!(f.merged, Some(false), "nothing landed yet");
        std::fs::remove_file(wt.join("b.txt")).unwrap();
        assert_eq!(land(&id, &info), Landing::Merged);
        let after = facts_of(&inst);
        assert_eq!(after.merged, Some(true));
        assert_eq!(after.commits, Some(2), "the base does not jump to the merged tip");
    }

    #[test]
    fn a_rebase_does_not_make_the_peers_commits_count_as_the_subs() {
        let _data = TempDataDir::new();
        let (_d, root) = test_repo::init();
        let st = state();
        let (id, info) = new_sub(&st, "rebased", &root);
        let wt = PathBuf::from(&info.path);
        commit_file(&wt, "a.txt", "mine\n");
        commit_file(&root, "peer1.txt", "p\n");
        commit_file(&root, "peer2.txt", "p\n");
        assert_eq!(land(&id, &info), Landing::Merged);
        let inst = st.registry.get(&id).unwrap();
        // Commits are attributed through the files the sub edited, so it needs a transcript.
        let transcript = test_repo::transcript(_d.path(), &[("Write", &wt.join("a.txt"))]);
        let f = card_log::sub_facts(&inst, crate::types::SubchatCheck::FactsOnly, None, &[], Some(&transcript));
        assert_eq!(f.commits, Some(1), "only the sub's own commit, not the two the peer made");
    }
}
