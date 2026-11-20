use super::*;

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

pub(super) fn blocked(verdict: &'static str, text: String, points: Vec<String>) -> Landing {
    Landing::Blocked(Blocked { verdict, text, points, cause: Cause::Other })
}

pub(super) fn caused(cause: Cause, landing: Landing) -> Landing {
    match landing {
        Landing::Blocked(b) => Landing::Blocked(Blocked { cause, ..b }),
        other => other,
    }
}

pub(super) fn conflict_landing(info: &WorktreeInfo, files: Vec<String>) -> Landing {
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
pub(super) fn land_with(sub_id: &str, info: &WorktreeInfo, between: &mut dyn FnMut(usize)) -> Landing {
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
pub(super) fn overwritten_files(err: &str) -> Vec<String> {
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
        Landing::Blocked(b) => super::super::merge_followup::on_blocked(state, sub_id, info, b),
        _ => super::super::merge_followup::on_landed(state, sub_id),
    }
    landing
}

/// [`land_and_report`] as a merge in its own right (a retry by the tick or the main chat): counted
/// like the one `defer` runs, so a gate that asks meanwhile waits for it.
pub(in super::super) fn land_counted(state: &Arc<DaemonState>, sub_id: &str, info: &WorktreeInfo) -> Landing {
    let key = project_key(Path::new(&info.repo));
    let in_flight = begin_merge(&key);
    let landing = land_and_report(state, sub_id, info);
    drop(in_flight);
    super::super::writers::sweep(state);
    landing
}

/// The hook `subchats::on_finished` calls first. For a worktree sub it merges on
/// its own thread (a rebase and a merge are git work, and `on_finished` runs
/// inside the pump), then calls `rest`, which draws the finish card and starts
/// whatever waited for this sub, so both see what landed. Returns false for any
/// other sub, which the caller then finishes at once.
pub(in super::super) fn defer(state: &Arc<DaemonState>, sub_id: &str, rest: fn(&Arc<DaemonState>, &str)) -> bool {
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
        super::super::writers::sweep(&state);
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
pub(in super::super) fn free_build_folder_in_background(state: &Arc<DaemonState>, sub_id: &str) {
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
pub(super) fn free_build_folder(state: &DaemonState, sub_id: &str, info: &WorktreeInfo, seen: u64) {
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
pub(super) struct BuildGuard {
    pub(super) continued: std::sync::atomic::AtomicU64,
    pub(super) delete: Mutex<()>,
}

pub(super) static BUILD_GUARDS: Mutex<Option<HashMap<String, Arc<BuildGuard>>>> = Mutex::new(None);

pub(super) fn build_guard(sub_id: &str) -> Arc<BuildGuard> {
    let mut all = BUILD_GUARDS.lock().unwrap_or_else(|e| e.into_inner());
    all.get_or_insert_with(HashMap::new).entry(sub_id.to_string()).or_default().clone()
}

/// How many continues the sub has had so far.
pub(super) fn continued_count(sub_id: &str) -> u64 {
    build_guard(sub_id).continued.load(std::sync::atomic::Ordering::SeqCst)
}

/// Counts a continue. Waits while a delete of this sub's build folder runs, which is
/// the point: the turn that follows must not start a build into a folder going away.
pub(super) fn note_continued(sub_id: &str) {
    let guard = build_guard(sub_id);
    let _wait = guard.delete.lock().unwrap_or_else(|e| e.into_inner());
    guard.continued.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
}
