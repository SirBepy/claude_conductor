//! Git worktree IPC: on-demand branch/staleness detail for the picker's
//! new/existing/default sub-picker, plus create/remove commands. Split out
//! of `project_groups.rs`, which only does the cheap fold-into-parent pass
//! (no git subprocess calls) that runs on every `list_project_groups` call.

use crate::ipc::git::run_git;

#[derive(serde::Serialize, ts_rs::TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct WorktreeDetail {
    pub path: String,
    pub name: String,
    pub branch: Option<String>,
    pub last_commit_at: Option<String>,
    pub stale: bool,
    pub stale_reason: Option<String>,
}

/// Days of inactivity after which a worktree is flagged stale (absent a
/// merged-branch verdict, which takes priority regardless of recency).
const STALE_AFTER_DAYS: i64 = 21;

/// Returns every worktree of `repo_path` (excluding the main worktree
/// itself) with branch + staleness detail. Staleness: the branch is fully
/// merged into the repo's default branch, or its last commit is older than
/// `STALE_AFTER_DAYS`. Best-effort - a worktree entry git can't fully
/// resolve (detached HEAD, branch deleted) still appears with `None` fields
/// rather than being dropped.
#[tauri::command]
pub async fn list_worktree_details(repo_path: String) -> Result<Vec<WorktreeDetail>, String> {
    tauri::async_runtime::spawn_blocking(move || list_worktree_details_sync(&repo_path))
        .await
        .map_err(|e| format!("list_worktree_details join error: {e}"))?
}

fn list_worktree_details_sync(repo_path: &str) -> Result<Vec<WorktreeDetail>, String> {
    let porcelain = run_git(repo_path, &["worktree", "list", "--porcelain"])?;
    let default_branch = default_branch_name(repo_path);
    let entries = parse_worktree_porcelain(&porcelain);

    let main = std::path::Path::new(repo_path);
    Ok(entries
        .into_iter()
        .filter(|e| std::path::Path::new(&e.path) != main)
        .map(|e| {
            let last_commit_at = e.branch.as_deref().and_then(|b| last_commit_iso(repo_path, b));
            let merged = match (&e.branch, &default_branch) {
                (Some(b), Some(d)) if b != d => is_merged(repo_path, b, d),
                _ => false,
            };
            let stale_by_age = last_commit_at
                .as_deref()
                .map(|iso| days_since(iso) >= STALE_AFTER_DAYS)
                .unwrap_or(false);
            let (stale, stale_reason) = if merged {
                (true, Some(format!("merged into {}", default_branch.clone().unwrap_or_default())))
            } else if stale_by_age {
                (true, Some(format!("no commits in {STALE_AFTER_DAYS}+ days")))
            } else {
                (false, None)
            };
            let name = std::path::Path::new(&e.path)
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or(&e.path)
                .to_string();
            WorktreeDetail { path: e.path, name, branch: e.branch, last_commit_at, stale, stale_reason }
        })
        .collect())
}

struct RawWorktree {
    path: String,
    branch: Option<String>,
}

/// Parses `git worktree list --porcelain` output. Each entry is a blank-line
/// separated block starting with `worktree <path>`, optionally followed by
/// `branch refs/heads/<name>` (absent for detached-HEAD checkouts).
fn parse_worktree_porcelain(raw: &str) -> Vec<RawWorktree> {
    let mut out = Vec::new();
    let mut cur_path: Option<String> = None;
    let mut cur_branch: Option<String> = None;
    let flush = |path: &mut Option<String>, branch: &mut Option<String>, out: &mut Vec<RawWorktree>| {
        if let Some(p) = path.take() {
            out.push(RawWorktree { path: p, branch: branch.take() });
        }
    };
    for line in raw.lines() {
        if let Some(p) = line.strip_prefix("worktree ") {
            flush(&mut cur_path, &mut cur_branch, &mut out);
            cur_path = Some(p.trim().to_string());
        } else if let Some(b) = line.strip_prefix("branch ") {
            cur_branch = Some(b.trim().trim_start_matches("refs/heads/").to_string());
        } else if line.trim().is_empty() {
            flush(&mut cur_path, &mut cur_branch, &mut out);
        }
    }
    flush(&mut cur_path, &mut cur_branch, &mut out);
    out
}

/// Best-effort default branch name: prefers `origin/HEAD`'s target, falls
/// back to whichever of `main`/`master` exists locally.
fn default_branch_name(repo_path: &str) -> Option<String> {
    if let Ok(sym) = run_git(repo_path, &["symbolic-ref", "refs/remotes/origin/HEAD"]) {
        if let Some(name) = sym.trim().strip_prefix("refs/remotes/origin/") {
            if !name.is_empty() {
                return Some(name.to_string());
            }
        }
    }
    for candidate in ["main", "master"] {
        if run_git(repo_path, &["show-ref", "--verify", "--quiet", &format!("refs/heads/{candidate}")]).is_ok() {
            return Some(candidate.to_string());
        }
    }
    None
}

fn is_merged(repo_path: &str, branch: &str, default_branch: &str) -> bool {
    run_git(repo_path, &["merge-base", "--is-ancestor", branch, default_branch]).is_ok()
}

fn last_commit_iso(repo_path: &str, branch: &str) -> Option<String> {
    run_git(repo_path, &["log", "-1", "--format=%cI", branch]).ok().filter(|s| !s.is_empty())
}

/// Days between an RFC3339 timestamp and now. Unparsable input counts as 0
/// days old (never flagged stale by age alone) rather than erroring.
fn days_since(iso: &str) -> i64 {
    match chrono::DateTime::parse_from_rfc3339(iso) {
        Ok(t) => (chrono::Utc::now() - t.with_timezone(&chrono::Utc)).num_days(),
        Err(_) => 0,
    }
}

/// Creates a new worktree at `<repo_path>/.claude/worktrees/<name>`,
/// matching the layout already used by this project's own worktrees (e.g.
/// `fibo\.claude\worktrees\v2-frontend-shell`). `worktree_name` defaults to
/// a filesystem-safe slug of `branch_name`. If `branch_name` already exists
/// locally, the worktree checks it out as-is (`base_branch` is ignored);
/// otherwise a new branch is created from `base_branch` (defaults to HEAD).
#[tauri::command]
pub async fn create_worktree(
    repo_path: String,
    branch_name: String,
    worktree_name: Option<String>,
    base_branch: Option<String>,
) -> Result<WorktreeDetail, String> {
    tauri::async_runtime::spawn_blocking(move || {
        create_worktree_sync(&repo_path, &branch_name, worktree_name.as_deref(), base_branch.as_deref())
    })
    .await
    .map_err(|e| format!("create_worktree join error: {e}"))?
}

fn create_worktree_sync(
    repo_path: &str,
    branch_name: &str,
    worktree_name: Option<&str>,
    base_branch: Option<&str>,
) -> Result<WorktreeDetail, String> {
    let branch_name = branch_name.trim();
    if branch_name.is_empty() {
        return Err("Branch name can't be empty".to_string());
    }
    let name = worktree_name
        .map(slugify)
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| slugify(branch_name));
    if name.is_empty() {
        return Err("Couldn't derive a worktree folder name from that branch name".to_string());
    }

    let target = std::path::Path::new(repo_path).join(".claude").join("worktrees").join(&name);
    if target.exists() {
        return Err(format!("A worktree already exists at .claude/worktrees/{name}"));
    }
    let target_str = target.to_string_lossy().into_owned();

    let branch_exists = run_git(repo_path, &["show-ref", "--verify", "--quiet", &format!("refs/heads/{branch_name}")]).is_ok();
    if branch_exists {
        run_git(repo_path, &["worktree", "add", &target_str, branch_name])?;
    } else {
        let mut args = vec!["worktree", "add", &target_str, "-b", branch_name];
        if let Some(base) = base_branch.map(str::trim).filter(|s| !s.is_empty()) {
            args.push(base);
        }
        run_git(repo_path, &args)?;
    }

    Ok(WorktreeDetail {
        path: target_str,
        name,
        branch: Some(branch_name.to_string()),
        last_commit_at: last_commit_iso(repo_path, branch_name),
        stale: false,
        stale_reason: None,
    })
}

/// Lowercases, replaces any run of non-alphanumeric characters with a single
/// `-`, and trims leading/trailing `-`. Used both as the default worktree
/// folder name and to keep user-supplied names filesystem-safe (no `..`,
/// path separators, or other traversal-capable characters survive).
fn slugify(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut last_was_dash = false;
    for c in s.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
            last_was_dash = false;
        } else if !last_was_dash && !out.is_empty() {
            out.push('-');
            last_was_dash = true;
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    out
}

/// Removes a worktree and prunes stale administrative metadata. `force`
/// passes `--force` to `git worktree remove`, required when the worktree
/// has uncommitted changes or untracked files - callers must have already
/// confirmed that with the user before setting it.
#[tauri::command]
pub async fn remove_worktree(repo_path: String, worktree_path: String, force: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut args = vec!["worktree", "remove", worktree_path.as_str()];
        if force {
            args.push("--force");
        }
        run_git(&repo_path, &args)?;
        // Best-effort: clears any leftover administrative files. A failure
        // here doesn't mean the removal above failed.
        let _ = run_git(&repo_path, &["worktree", "prune"]);
        Ok(())
    })
    .await
    .map_err(|e| format!("remove_worktree join error: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_porcelain_with_branch() {
        let raw = "worktree /repo\nHEAD abc123\nbranch refs/heads/main\n\nworktree /repo/.claude/worktrees/foo\nHEAD def456\nbranch refs/heads/feature-x\n\n";
        let entries = parse_worktree_porcelain(raw);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].path, "/repo");
        assert_eq!(entries[0].branch.as_deref(), Some("main"));
        assert_eq!(entries[1].path, "/repo/.claude/worktrees/foo");
        assert_eq!(entries[1].branch.as_deref(), Some("feature-x"));
    }

    #[test]
    fn parses_detached_head_without_branch() {
        let raw = "worktree /repo/.claude/worktrees/detached\nHEAD abc123\ndetached\n";
        let entries = parse_worktree_porcelain(raw);
        assert_eq!(entries.len(), 1);
        assert!(entries[0].branch.is_none());
    }

    #[test]
    fn days_since_unparsable_is_zero() {
        assert_eq!(days_since("not-a-date"), 0);
    }

    #[test]
    fn days_since_recent_timestamp_is_zero() {
        let now = chrono::Utc::now().to_rfc3339();
        assert_eq!(days_since(&now), 0);
    }

    #[test]
    fn slugify_lowercases_and_dashes() {
        assert_eq!(slugify("Fix Login Bug"), "fix-login-bug");
    }

    #[test]
    fn slugify_collapses_runs_of_punctuation() {
        assert_eq!(slugify("feature/foo_bar--baz"), "feature-foo-bar-baz");
    }

    #[test]
    fn slugify_strips_traversal_characters() {
        assert_eq!(slugify("../../etc/passwd"), "etc-passwd");
    }

    #[test]
    fn slugify_trims_trailing_dashes() {
        assert_eq!(slugify("feature!!!"), "feature");
    }
}
