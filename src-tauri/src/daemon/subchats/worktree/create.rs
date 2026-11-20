use super::*;

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
pub(super) fn prefix_of(info: &WorktreeInfo) -> String {
    let (cwd, root) = (path_key(&info.cwd), path_key(&info.path));
    cwd.strip_prefix(&root).map(|r| r.trim_matches('/').to_string()).unwrap_or_default()
}

pub(super) fn plan_setup(top: &Path, wt: &Path, prefix: &str) -> Setup {
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

pub(super) fn ensure_excluded(repo: &Path) {
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
pub(super) fn short_id(sid: &str) -> String {
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

pub(super) fn prepare_from(cwd: &Path, sid: &str, at: Option<(&str, &str)>) -> Result<Prepare, String> {
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
            let commit = super::super::remote::git_sync::is_commit_id(base).then(|| super::super::remote::git_sync::resolve_commit(&top, base)).flatten();
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
pub(super) fn write_build_config(holder: &Path) -> Result<(), String> {
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
pub(super) fn seed_build_folder(holder: &Path) {
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
pub(super) fn holder_of(info: &WorktreeInfo) -> Option<PathBuf> {
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
pub(super) static NOTES: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);

pub(super) fn put_note(sub_id: &str, note: String) {
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
pub(super) const WIP_MESSAGE: &str = "WIP: handed to a fresh sub";

/// Retires the sub that `successor` carries on, after the successor is
/// registered: the old row is ended, and its tree and branch go because every
/// commit of the branch is on the successor's branch (checked, the same way a
/// merged tree is: the old branch must be an ancestor of the successor's, and
/// nothing may be uncommitted). A tree that fails a check
/// stays on disk, with no data lost either way.
pub async fn hand_over(state: &Arc<DaemonState>, old_id: &str, successor: &WorktreeInfo) {
    let Some(old) = info_of(old_id) else {
        super::super::resume::end_sub(state, old_id);
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
    super::super::resume::end_sub_stopped(state, old_id);
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
    mut spec: super::super::held::LaunchSpec,
    plan: &mut super::super::spawn::SubPlan,
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
    spec: super::super::held::LaunchSpec,
    plan: &mut super::super::spawn::SubPlan,
    sid: String,
) -> Result<String, String> {
    let continued_from = plan.continue_from.clone();
    let registered = super::super::held::register_held_row(state, caller_session_id, name, inherited, spec, plan, sid, SETUP_TEXT.to_string(), None)?;
    // Recorded with the row and before the launch, which builds the sub's first decisions rider
    // from it: a carried-on sub reads its predecessor's `decided` and `ruled_out` rows.
    if let Some(old) = continued_from {
        super::super::decisions::record_continuation(caller_session_id, &registered, &old);
    }
    Ok(registered)
}

pub(super) fn start_in_background(state: &Arc<DaemonState>, sub_id: &str) {
    let Ok(handle) = tokio::runtime::Handle::try_current() else { return };
    let (state, sub_id) = (state.clone(), sub_id.to_string());
    handle.spawn(async move { super::super::writers::run_start(&state, super::super::writers::Start::Launch { sub_id }).await });
}

/// Throws away a worktree made for a spawn that then failed, so a refused spawn
/// leaves no folder or branch behind.
pub fn discard(info: &WorktreeInfo) {
    if let Removal::Kept(why) | Removal::BuildLeft(why) = remove_if_safe(info) {
        log::warn!("subchats: could not discard the worktree {}: {why}", info.path);
    }
}
