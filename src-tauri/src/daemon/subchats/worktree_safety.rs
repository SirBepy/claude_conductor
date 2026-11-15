//! What removing a sub's worktree, or rebasing it, must check beyond `git status`
//! (the removal and update steps live in `worktree.rs`).
//!
//! - Ignored files: `git status` omits them and `git worktree remove` deletes
//!   them, so a sub's output under a git-ignored path (`.for_bepy/screenshots`,
//!   `.claude/todos/*`) would go silently. [`ignored_work`] lists what is the
//!   sub's and not build output or what the setup generated.
//! - A detached `HEAD`: commits made there belong to no branch, so removing the
//!   tree makes them unreachable ([`detached_risk`]).
//! - A rebase the daemon left half done when it was killed: the tree stays
//!   detached and every later update refused. The daemon marks the rebases it
//!   starts ([`RebaseMark`]), so [`settle_rebase`] can abort its own and leave a
//!   sub's (a conflict it is resolving by hand) alone.

use super::worktree::{current_branch, is_link, run, short};
use std::collections::HashSet;
use std::path::{Path, PathBuf};

/// Project folders a package of its own lives in (`src-tauri/target`,
/// `android/app/build`).
const PROJECT_ROOTS: [&str; 7] = ["src-tauri", "android", "app", "e2e", "browser-extension", "vendor", "tauri_kit"];

/// Build-output names that are also ordinary folder names. These count at the top of the
/// tree, under [`PROJECT_ROOTS`], or beside a build manifest (`backend/target/` next to
/// `backend/Cargo.toml`), never under a folder like `docs/`, where `docs/build/x.md` is a
/// sub's own ignored file. The other names (`node_modules`, `.venv`, ...) are
/// toolchain-only and count at any depth.
const GENERIC_OUTPUT: [&str; 3] = ["target", "build", "dist"];

/// A file whose presence says the folder holding it is a package with its own build.
const MANIFESTS: [&str; 7] = ["Cargo.toml", "package.json", "pyproject.toml", "build.gradle", "build.gradle.kts", "pom.xml", "CMakeLists.txt"];

/// Folders every toolchain regenerates, so their contents are never a sub's
/// work: matched on any path component, with the [`GENERIC_OUTPUT`] names held to
/// the stricter rule above.
const BUILD_OUTPUT: [&str; 12] = [
    "target",
    "node_modules",
    "dist",
    "build",
    ".gradle",
    "__pycache__",
    ".pytest_cache",
    ".venv",
    ".next",
    ".turbo",
    ".vite",
    ".cache",
];

/// Inside the worktree's git dir, like the setup marker: what the ignored paths
/// were when the setup finished. Removed with the worktree.
const SETUP_IGNORED: &str = "cc-setup-ignored";

/// Inside the worktree's git dir while the daemon runs a rebase there.
const REBASING: &str = "cc-rebasing";

fn git_dir(wt: &Path) -> Option<PathBuf> {
    let o = run(wt, &["rev-parse", "--absolute-git-dir"]);
    o.ok.then(|| PathBuf::from(o.out.trim()))
}

// ---- ignored files ------------------------------------------------------------------

/// Every path git ignores in `wt`, relative, a folder with a trailing slash. An
/// ignored folder is one entry: git does not look inside it.
fn ignored_paths(wt: &Path) -> Result<Vec<String>, String> {
    let o = run(wt, &["-c", "core.quotepath=false", "status", "--porcelain=v1", "--ignored=matching", "--untracked-files=normal"]);
    if !o.ok {
        return Err(short(&o.err, 200));
    }
    Ok(o.out.lines().filter_map(|l| l.strip_prefix("!! ")).map(|p| p.trim().trim_matches('"').to_string()).collect())
}

/// Also codegen output (`src-tauri/gen/schemas` is rewritten by every cargo
/// build, so a sub that built always has it; `gen/android` is the bootstrap's),
/// a `target-*` folder (a toolchain's private build folder) and a generated
/// source such as `src/types/ipc.generated.ts`.
fn is_build_output(wt: &Path, path: &str) -> bool {
    let parts: Vec<&str> = path.split('/').filter(|p| !p.is_empty()).collect();
    let last = parts.len().saturating_sub(1);
    // Narrow on purpose: a sub's own ignored file may sit under any other `gen`
    // folder or have `target-` in a file name, and must keep the tree.
    let owns_a_build = |i: usize| {
        parts[..i].iter().all(|p| PROJECT_ROOTS.contains(p)) || {
            let dir = parts[..i].iter().fold(wt.to_path_buf(), |d, p| d.join(p));
            MANIFESTS.iter().any(|m| dir.join(m).is_file())
        }
    };
    parts.iter().enumerate().any(|(i, part)| {
        (BUILD_OUTPUT.contains(part) && (!GENERIC_OUTPUT.contains(part) || owns_a_build(i)))
            || (part.starts_with("target-") && (i < last || path.ends_with('/')))
    })
        || parts.windows(2).any(|w| w[0] == "gen" && matches!(w[1], "schemas" | "android"))
        || (parts.last().is_some_and(|f| f.ends_with(".generated.ts")) && !path.ends_with('/'))
}

#[cfg(test)]
mod tests {
    use super::is_build_output;
    use std::path::Path;

    fn out(path: &str) -> bool {
        is_build_output(Path::new("/no/such/worktree"), path)
    }

    #[test]
    fn toolchain_folders_count_at_the_top_and_under_a_project_folder() {
        for p in ["target/", "node_modules/", "dist/", "build/", "src-tauri/target/", "android/app/build/", "android/src-tauri/target/", "e2e/node_modules/", "node_modules/x/build/"] {
            assert!(out(p), "{p} is build output");
        }
    }

    /// A sub's own ignored note under `docs/build/` is work, not build output: it kept
    /// being deleted with the tree because the name matched at any depth.
    #[test]
    fn a_look_alike_folder_deeper_in_the_tree_is_the_subs_own_work() {
        for p in ["docs/build/x.md", "docs/dist/", "notes/target/plan.md", "scripts/build/local.env", "src/build/"] {
            assert!(!out(p), "{p} is not build output");
        }
    }

    /// Other layouts keep their build folders out of the way: a toolchain-only name
    /// counts anywhere, and a generic one counts beside its package's manifest.
    #[test]
    fn a_package_elsewhere_in_the_tree_keeps_its_build_output_out_of_the_way() {
        let dir = tempfile::tempdir().unwrap();
        let wt = dir.path();
        std::fs::create_dir_all(wt.join("backend")).unwrap();
        std::fs::write(wt.join("backend").join("Cargo.toml"), "[package]
").unwrap();
        std::fs::create_dir_all(wt.join("docs")).unwrap();
        std::fs::create_dir_all(wt.join("frontend").join("dist")).unwrap();
        for p in ["backend/target/", "packages/web/node_modules/", "api/.venv/", "web/.next/", "docs/node_modules/x"] {
            assert!(is_build_output(wt, p), "{p} is build output");
        }
        assert!(!is_build_output(wt, "docs/build/x.md"), "docs has no manifest");
        assert!(!is_build_output(wt, "frontend/dist/"), "no manifest beside it");
    }
}

/// Remembers the ignored paths a finished setup left (a bootstrap script's
/// generated files are ignored by git too, and are nobody's work). A tree set up
/// before this record existed has none, so all its ignored files count.
pub(super) fn record_setup(wt: &Path) {
    let Some(dir) = git_dir(wt) else { return };
    let Ok(paths) = ignored_paths(wt) else { return };
    let mut text = paths.join("\n");
    text.push('\n');
    if let Err(e) = std::fs::write(dir.join(SETUP_IGNORED), text) {
        log::warn!("subchats: could not record the setup's ignored files for {}: {e}", wt.display());
    }
}

/// The sub's own ignored files: ignored paths that are not build output, not a
/// link into the main checkout (the `node_modules` junction) and not there when
/// the setup finished. A file added inside an ignored folder the setup already
/// made is not seen: git reports the folder, not its files.
pub(super) fn ignored_work(wt: &Path) -> Vec<String> {
    let known: HashSet<String> = git_dir(wt)
        .and_then(|d| std::fs::read_to_string(d.join(SETUP_IGNORED)).ok())
        .map(|t| t.lines().map(str::to_string).collect())
        .unwrap_or_default();
    // A git that cannot list the ignored files must not read as "none": the tree
    // would be removed with whatever they hold.
    let paths = match ignored_paths(wt) {
        Ok(p) => p,
        Err(why) => return vec![format!("(git could not list the ignored files: {why})")],
    };
    paths
        .into_iter()
        .filter(|p| !is_build_output(wt, p) && !known.contains(p))
        .filter(|p| !std::fs::symlink_metadata(wt.join(p.trim_end_matches('/'))).is_ok_and(|m| is_link(&m)))
        .collect()
}

// ---- a detached HEAD --------------------------------------------------------------------

/// Why the tree cannot go because its `HEAD` is detached on commits no branch or
/// remote holds, or `None`. A detached `HEAD` that a branch holds loses nothing.
pub(super) fn detached_risk(wt: &Path) -> Option<String> {
    if current_branch(wt).is_some() {
        return None;
    }
    let unheld = run(wt, &["rev-list", "-n", "1", "HEAD", "--not", "--branches", "--remotes"]);
    if !unheld.ok {
        return Some(format!("its HEAD is detached and could not be checked for commits no branch holds: {}", short(&unheld.err, 200)));
    }
    (!unheld.out.trim().is_empty())
        .then(|| "its HEAD is detached on commits no branch holds, and removing the tree would lose them".to_string())
}

// ---- a rebase left half done ---------------------------------------------------------------

fn rebase_in_progress(wt: &Path) -> bool {
    ["rebase-merge", "rebase-apply"].iter().any(|name| {
        let o = run(wt, &["rev-parse", "--git-path", name]);
        // Relative to `wt`, or absolute in a linked worktree: `join` takes either.
        o.ok && wt.join(o.out.trim()).is_dir()
    })
}

/// Written before the daemon starts a rebase in `wt` and removed once none is
/// left going, so a mark found on a rebase in progress means the daemon died
/// inside it. Held under the repo lock, which is what keeps a second rebase of
/// this process out of the same tree.
pub(super) struct RebaseMark {
    wt: PathBuf,
    file: Option<PathBuf>,
}

impl RebaseMark {
    pub(super) fn set(wt: &Path) -> Self {
        let file = git_dir(wt).map(|d| d.join(REBASING));
        if let Some(f) = &file {
            let _ = std::fs::write(f, "rebasing\n");
        }
        RebaseMark { wt: wt.to_path_buf(), file }
    }
}

impl Drop for RebaseMark {
    fn drop(&mut self) {
        // A rebase an abort could not end keeps its mark: it is still the app's.
        if let Some(f) = &self.file {
            if !rebase_in_progress(&self.wt) {
                let _ = std::fs::remove_file(f);
            }
        }
    }
}

/// Ends a rebase the daemon itself left half done (killed mid-rebase), which also
/// puts the tree back on its branch. `Err` names a rebase it must not touch (the
/// sub's own) or could not end.
pub(super) fn settle_rebase(wt: &Path) -> Result<(), String> {
    let Some(mark) = git_dir(wt).map(|d| d.join(REBASING)) else { return Ok(()) };
    if !rebase_in_progress(wt) {
        let _ = std::fs::remove_file(&mark);
        return Ok(());
    }
    if !mark.is_file() {
        return Err("a rebase is in progress in its worktree that the app did not start (it is resolving a conflict, or left one half done): finish it with git rebase --continue or give it up with git rebase --abort".to_string());
    }
    let aborted = run(wt, &["rebase", "--abort"]);
    if rebase_in_progress(wt) {
        return Err(format!("a rebase the app left half done could not be aborted: {}", short(&aborted.err, 200)));
    }
    let _ = std::fs::remove_file(&mark);
    log::warn!("subchats: aborted a rebase the daemon left half done in {}", wt.display());
    Ok(())
}
