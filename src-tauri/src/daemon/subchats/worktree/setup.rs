use super::*;

// ---- setting up -----------------------------------------------------------------------

pub(super) fn marker_path(wt: &Path) -> Option<PathBuf> {
    let o = run(wt, &["rev-parse", "--absolute-git-dir"]);
    o.ok.then(|| PathBuf::from(o.out.trim()).join("cc-setup-done"))
}

pub(super) fn make_junction(link: &Path, target: &Path) -> Result<(), String> {
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

pub(super) fn run_script(wt: &Path) -> Result<(), String> {
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
