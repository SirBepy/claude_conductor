use super::*;

// ---- bringing a branch up to date -------------------------------------------------------

pub(super) enum Update {
    Done,
    Conflict(Vec<String>),
    Failed(String),
}

pub(super) fn set_base(sub_id: &str, base: Option<String>) {
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
pub(super) fn settle_index(dir: &Path) {
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
pub(super) fn update_branch(sub_id: &str, info: &WorktreeInfo) -> Update {
    update_branch_onto(sub_id, info, &branch_ref(&info.target))
}

/// [`update_branch`] against any ref: a sub visiting from another machine rebases
/// onto its private copy of its home's target (`refs/cc-sub/<id>/target`), because
/// the branch of that name in this clone is not the home's.
pub(super) fn update_branch_onto(sub_id: &str, info: &WorktreeInfo, target: &str) -> Update {
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
