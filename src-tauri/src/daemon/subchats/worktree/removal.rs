//! Removing a sub's worktree and branch when it is safe, and finishing a removal git
//! gave up part way. Split out of `worktree.rs`; the parent's private helpers come in
//! through `use super::*`.

use super::*;

mod module_keep;

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
pub(in crate::daemon::subchats) fn unlink_reparse_points(root: &Path) -> Result<(), String> {
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
pub(in crate::daemon::subchats) fn is_link(meta: &std::fs::Metadata) -> bool {
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
pub(super) fn uncommitted_in(wt: &Path) -> Vec<String> {
    settle_index(wt);
    run(wt, &["status", "--porcelain=v1", "--untracked-files=normal"])
        .out
        .lines()
        .filter(|l| l.len() > 3)
        .map(|l| l[3..].trim().trim_matches('"').to_string())
        .filter(|p| !std::fs::symlink_metadata(wt.join(p.trim_end_matches('/'))).is_ok_and(|m| is_link(&m)))
        .collect()
}

/// Removes the sub's worktree and branch when its commits are merged and nothing
/// is uncommitted; otherwise leaves everything where it is and says why.
pub fn remove_if_safe(info: &WorktreeInfo) -> Removal {
    remove_if_safe_onto(info, &branch_ref(&info.target))
}

/// The tree of a visiting sub whose home merged `merged_head`, which must be
/// everything its branch holds: the branch counts as merged into `refs/cc-sub/<id>/target`,
/// the copy of its home's target this clone keeps, moved to that head first. Every
/// other check of [`remove_if_safe`] still applies. `true` when the tree is gone.
pub(crate) fn remove_landed(sub_id: &str, info: &WorktreeInfo, merged_head: &str) -> bool {
    let repo = Path::new(&info.repo);
    let target_ref = format!("refs/cc-sub/{sub_id}/target");
    if !run(repo, &["update-ref", &target_ref, merged_head]).ok {
        return false;
    }
    match remove_if_safe_onto(info, &target_ref) {
        Removal::Removed | Removal::BuildLeft(_) => true,
        Removal::Kept(why) => {
            log::warn!("subchats: the tree of landed sub {sub_id} stays: {why}");
            false
        }
    }
}

fn remove_if_safe_onto(info: &WorktreeInfo, target_ref: &str) -> Removal {
    let lock = repo_lock(Path::new(&info.repo));
    let _held = lock.lock().unwrap_or_else(|p| p.into_inner());
    let (repo, wt) = (Path::new(&info.repo), Path::new(&info.path));
    let forget_branch = || {
        if branch_exists(repo, &info.branch) && is_ancestor(repo, &branch_ref(&info.branch), target_ref) {
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
        let unmerged = count(repo, &format!("{target_ref}..{}", branch_ref(&info.branch))).unwrap_or(1);
        if unmerged > 0 {
            return Removal::Kept(format!("{unmerged} commit{} on branch {} {} not merged into {}", if unmerged == 1 { "" } else { "s" }, info.branch, if unmerged == 1 { "is" } else { "are" }, info.target));
        }
    }
    // Commits on a detached HEAD are on no branch, so the check on `info.branch`
    // above does not see them.
    if let Some(why) = worktree_safety::detached_risk(wt) {
        return Removal::Kept(why);
    }
    let mut dirty = uncommitted_in(wt);
    // A submodule moved to another commit the branch never recorded is not work of
    // its own: `keep_modules` below saves that commit before anything is deleted.
    let drifted = module_keep::drifted_modules(wt);
    dirty.retain(|p| !drifted.iter().any(|d| d == p.trim_end_matches('/')));
    if !dirty.is_empty() {
        let shown: Vec<String> = dirty.iter().take(6).cloned().collect();
        return Removal::Kept(format!("it has uncommitted work: {}{}", shown.join(", "), if dirty.len() > shown.len() { " and more" } else { "" }));
    }
    // `git status` leaves ignored files out and the removal deletes them.
    let ignored = worktree_safety::ignored_work(wt);
    if !ignored.is_empty() {
        let shown: Vec<String> = ignored.iter().take(6).cloned().collect();
        return Removal::Kept(format!(
            "it holds files git ignores that removing the tree would delete: {}{}",
            shown.join(", "),
            if ignored.len() > shown.len() { " and more" } else { "" }
        ));
    }
    // Done before anything is unlinked or deleted: a kept tree stays whole, and a
    // submodule commit no remote has is saved in the main checkout first.
    if let Some(why) = module_keep::keep_modules(repo, wt, &info.branch, &drifted) {
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
pub(super) fn is_registered(repo: &Path, path: &str) -> bool {
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
pub(super) fn remove_retrying(info: &WorktreeInfo) -> Removal {
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

