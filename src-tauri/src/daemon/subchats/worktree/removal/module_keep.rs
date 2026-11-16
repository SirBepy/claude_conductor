//! Keeping a submodule's commits when a sub's tree is removed. A worktree's
//! submodules keep their git dirs inside the worktree's own, and removing the tree
//! (always `--force`, git refuses a tree with an initialised module) deletes them:
//! a commit made only there would be gone. So before the tree goes, every commit no
//! remote has is fetched into the main checkout's copy of the module under
//! `refs/cc-sub-kept/<sub>/<n>` and the ref is read back. Split out of
//! `removal.rs`; the parent's private helpers come in through `use super::*`.

use super::*;

/// The ref namespace the saved tips live under, in the main checkout's module.
const KEPT_NS: &str = "refs/cc-sub-kept";

/// The paths of the tree's initialised submodules.
fn module_paths(wt: &Path) -> Vec<String> {
    let status = run(wt, &["submodule", "status", "--recursive"]);
    let mut paths = Vec::new();
    for line in status.out.lines() {
        // `<flag><sha> <path> (<describe>)`; the flag `-` is a module never cloned here.
        let Some(flag) = line.chars().next() else { continue };
        if flag == '-' {
            continue;
        }
        let rest = line[flag.len_utf8()..].trim_start();
        let path = rest.split_once(' ').map(|(_, p)| p).unwrap_or("");
        let path = path.rsplit_once(" (").map_or(path, |(p, _)| p).trim();
        if !path.is_empty() {
            paths.push(path.to_string());
        }
    }
    paths
}

/// The submodules whose pointer in the tree differs from what the branch records
/// (the module was moved to another commit and the parent never committed it).
/// The parent's status lists such a module as modified, which is not work of its
/// own: the commit it moved to is what matters, and [`keep_modules`] saves that.
/// What happens inside the module is still checked there.
pub(super) fn drifted_modules(wt: &Path) -> Vec<String> {
    let modules = module_paths(wt);
    if modules.is_empty() {
        return Vec::new();
    }
    run(wt, &["status", "--porcelain=v1", "--untracked-files=no"])
        .out
        .lines()
        .filter(|l| l.len() > 3)
        .filter(|l| l[..2].chars().all(|c| c == ' ' || c == 'M'))
        .map(|l| l[3..].trim().trim_matches('"').to_string())
        .filter(|p| modules.contains(p))
        .collect()
}

/// A commit to save: the ref it was read from and its id.
struct Tip {
    source: String,
    sha: String,
}

/// The commits of the module at `dir` that must survive: the tip of HEAD and of
/// each local branch that holds a commit no remote-tracking ref has, plus HEAD
/// itself when `keep_head` (the tree's pointer moved to it).
fn tips_to_keep(dir: &Path, keep_head: bool) -> Result<Vec<Tip>, String> {
    let mut candidates = vec![Tip { source: "HEAD".into(), sha: String::new() }];
    let branches = run(dir, &["for-each-ref", "--format=%(refname)", "refs/heads"]);
    if !branches.ok {
        return Err(format!("its branches could not be listed: {}", short(&branches.err, 200)));
    }
    candidates.extend(branches.out.lines().map(|r| Tip { source: r.trim().to_string(), sha: String::new() }).filter(|t| !t.source.is_empty()));
    let mut tips: Vec<Tip> = Vec::new();
    for mut tip in candidates {
        let sha = run(dir, &["rev-parse", "--verify", "--quiet", &format!("{}^{{commit}}", tip.source)]);
        if !sha.ok {
            // A module with no commit yet has no HEAD, and nothing to lose.
            continue;
        }
        tip.sha = sha.out.trim().to_string();
        if tips.iter().any(|t| t.sha == tip.sha) {
            continue;
        }
        let unpublished = run(dir, &["rev-list", "-n", "1", &tip.sha, "--not", "--remotes"]);
        if !unpublished.ok {
            return Err(format!("it could not be checked for commits only this tree has: {}", short(&unpublished.err, 200)));
        }
        if !unpublished.out.trim().is_empty() || (keep_head && tip.source == "HEAD") {
            tips.push(tip);
        }
    }
    Ok(tips)
}

/// Fetches `tip` from the tree's module at `from` into the main checkout's module
/// at `into` as `refs/cc-sub-kept/<id>/<n>` and reads the ref back. A tip already
/// saved under an earlier number of `id` is not saved twice.
fn save_tip(into: &Path, from: &Path, id: &str, tip: &Tip) -> Result<(), String> {
    let existing = run(into, &["for-each-ref", "--format=%(objectname) %(refname)", &format!("{KEPT_NS}/{id}/")]);
    let mut next = 1u32;
    for line in existing.out.lines() {
        let Some((sha, name)) = line.split_once(' ') else { continue };
        if sha == tip.sha {
            return Ok(());
        }
        if let Some(n) = name.rsplit('/').next().and_then(|n| n.parse::<u32>().ok()) {
            next = next.max(n + 1);
        }
    }
    let kept = format!("{KEPT_NS}/{id}/{next}");
    let from_arg = from.to_string_lossy();
    let fetched = run(into, &["fetch", "--quiet", "--no-tags", &from_arg, &format!("{}:{kept}", tip.source)]);
    if !fetched.ok {
        return Err(short(&fetched.err, 200));
    }
    let back = run(into, &["rev-parse", "--verify", "--quiet", &format!("{kept}^{{commit}}")]);
    if !back.ok || back.out.trim() != tip.sha {
        return Err(format!("{kept} did not read back as {}", short(&tip.sha, 12)));
    }
    log::info!("subchats: kept submodule commit {} as {kept} in {}", short(&tip.sha, 12), into.display());
    Ok(())
}

/// Why the tree cannot be deleted because of a submodule in it, or `None` once
/// every commit it holds that no remote has is saved in the main checkout's
/// module. A module with uncommitted work, or one that cannot be checked or saved,
/// keeps the tree. Nothing is saved while any module still has work, so a kept
/// tree stays as it was. `drifted` is [`drifted_modules`] of `wt`.
pub(super) fn keep_modules(repo: &Path, wt: &Path, branch: &str, drifted: &[String]) -> Option<String> {
    let id = branch.strip_prefix("sub/").unwrap_or(branch).replace('/', "-");
    let mut plans: Vec<(String, Vec<Tip>)> = Vec::new();
    for path in module_paths(wt) {
        let dir = wt.join(&path);
        let dirty = uncommitted_in(&dir);
        if !dirty.is_empty() {
            return Some(format!("its submodule {path} has uncommitted work: {}", dirty.iter().take(6).cloned().collect::<Vec<_>>().join(", ")));
        }
        match tips_to_keep(&dir, drifted.contains(&path)) {
            Ok(tips) if tips.is_empty() => {}
            Ok(tips) => plans.push((path, tips)),
            Err(why) => return Some(format!("its submodule {path}: {why}")),
        }
    }
    for (path, tips) in plans {
        let into = repo.join(&path);
        // A module the main checkout never set up has no git dir of its own, and a
        // fetch run there would land in the superproject.
        if !into.join(".git").exists() {
            return Some(format!(
                "its submodule {path} holds commits no remote has, and the main checkout has no copy of that module to save them in, so removing the tree would delete them"
            ));
        }
        for tip in &tips {
            if let Err(why) = save_tip(&into, &wt.join(&path), &id, tip) {
                return Some(format!("its submodule {path} holds commits no remote has, and saving them in the main checkout failed ({why}), so removing the tree would delete them"));
            }
        }
    }
    None
}
