use super::*;

/// The trees of subs that were closed (by hand, or with their main chat) but are
/// still on disk: a removal failed, or the daemon stopped while it ran. Each
/// is removed by the same safety checks as at the end, on a thread of its own
/// (a tree with a build folder is gigabytes). A tree that has to stay is logged
/// only: the sub's end already logged why it stayed, and `auto_close::tick` runs this
/// again every hour, so a kept tree is retried until it is merged and clean.
///
/// The same pass then frees the build folders of finished subs that sit idle
/// (`sweep_targets`), on the same thread and after the removals, so the two never
/// work on one folder at once. A sweep that starts while another of the same daemon
/// still runs (the boot one is slow on a big tree, and the first hourly tick can land
/// inside it) does nothing: [`begin_sweep`] lets one run at a time.
pub(in super::super) fn sweep_ended(state: &Arc<DaemonState>) {
    sweep_ended_at(state, std::time::SystemTime::now());
}

/// The daemons (by state address) a sweep currently runs for.
pub(super) static SWEEPING: Mutex<Vec<usize>> = Mutex::new(Vec::new());

/// The right to sweep, held until dropped.
pub(super) struct SweepSlot(pub(super) usize);

impl Drop for SweepSlot {
    fn drop(&mut self) {
        SWEEPING.lock().unwrap_or_else(|p| p.into_inner()).retain(|k| *k != self.0);
    }
}

/// The right to sweep for `state`, or `None` while a sweep for it runs. Keyed by the
/// daemon state, so two test daemons in one process never block each other.
pub(super) fn begin_sweep(state: &Arc<DaemonState>) -> Option<SweepSlot> {
    let key = Arc::as_ptr(state) as usize;
    let mut running = SWEEPING.lock().unwrap_or_else(|p| p.into_inner());
    if running.contains(&key) {
        return None;
    }
    running.push(key);
    Some(SweepSlot(key))
}

/// [`sweep_ended`] with the clock the idle time is judged by.
pub(super) fn sweep_ended_at(state: &Arc<DaemonState>, now: std::time::SystemTime) {
    let Some(slot) = begin_sweep(state) else {
        log::info!("subchats: a worktree sweep is still running, so this one is skipped");
        return;
    };
    // The boot sweep counts as the pass the hourly tick would make next.
    super::super::auto_close::note_tree_pass();
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
        let _slot = slot;
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
pub(super) fn in_use(state: &DaemonState, info: &WorktreeInfo) -> bool {
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
pub(super) const TARGET_IDLE: Duration = Duration::from_secs(3 * 3600);

/// The `.claude/worktrees` folder of every repo that has a sub the registry knows.
pub(super) fn target_roots(state: &DaemonState) -> Vec<PathBuf> {
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
pub(super) fn holder_is_idle(state: &DaemonState, root: &Path, name: &str) -> bool {
    let closed = root.join(name).join(CLOSED_MARK).is_file();
    let rows: Vec<_> = state.registry.list().into_iter().filter(|i| i.subchat_of.is_some() && format!("sub-{}", short_id(&i.session_id)) == name).collect();
    !rows.is_empty()
        && rows.iter().all(|i| {
            let id = &i.session_id;
            !i.busy
                && !i.local_task_running
                && !super::super::held::is_held(id)
                && !super::super::pending_merges::contains(id)
                && (i.subchat_finished || (i.ended_at.is_some() && closed))
        })
}

/// Frees the build folder of every idle finished sub (`build_target::sweep_idle`)
/// and logs what the folders hold in total and what went, so their growth is visible.
pub(super) fn sweep_targets(state: &DaemonState, roots: &[PathBuf], now: std::time::SystemTime) {
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
