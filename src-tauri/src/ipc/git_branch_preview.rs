//! Read-only branch-file listing for Code mode's branch preview: lists a
//! branch's full tree without checking it out. Shares `run_git` and
//! `reject_option_like` with `git_diff`'s PR/commit-diff commands but has no
//! other dependency on that module.

use tauri::State;

use super::git::run_git;
use super::git_diff::reject_option_like;
use crate::ipc::mirror::mirrored_client;
use crate::state::AppState;

/// Repo-relative file list for `<branch>` without checking it out, for the
/// read-only branch-preview scope: `git ls-tree -r --name-only -z
/// --end-of-options <branch>`. `--end-of-options` (git's own
/// end-of-option-parsing marker) plus `reject_option_like` below both exist
/// so a crafted branch name can never be read as a git flag - this is
/// phone-reachable, same concern as `get_range_files`/`get_file_at_rev` in
/// `git_diff`.
///
/// `pub(crate)` pure local read, reused directly by the daemon's own
/// `list_branch_files` RPC handler (`daemon/methods/pr_review.rs`) - see
/// `git::get_git_dirty_local`'s doc for why the Tauri-facing wrapper below
/// is split out from this one.
pub(crate) async fn list_branch_files_local(cwd: String, branch: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        reject_option_like("branch", &branch)?;
        let out = run_git(&cwd, &["ls-tree", "-r", "--name-only", "-z", "--end-of-options", &branch])?;
        Ok(out.split('\0').filter(|s| !s.is_empty()).map(str::to_string).collect())
    })
    .await
    .map_err(|e| format!("list_branch_files join error: {e}"))?
}

/// Tauri-facing command: routes to the owning peer when `session_id`
/// resolves to a mirrored session (G10, docs/multi-machine.md), else runs
/// the same local read as before.
#[tauri::command]
pub async fn list_branch_files(
    cwd: String,
    branch: String,
    session_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<String>, String> {
    if let Some(client) = mirrored_client(&state, session_id.as_deref()).await {
        return client
            .list_branch_files(session_id.as_deref().unwrap(), &cwd, &branch)
            .await
            .map_err(|e| e.to_string());
    }
    list_branch_files_local(cwd, branch).await
}

#[cfg(test)]
mod branch_files_tests {
    use super::*;
    use super::super::git_diff::{get_file_diff_local, get_range_files_local};

    /// A repo with a base commit on the default branch plus a `feature`
    /// branch adding one more file. Returns the default branch's own name
    /// (varies with `init.defaultBranch`) so the test never hardcodes it.
    fn two_branch_repo() -> (tempfile::TempDir, String, String) {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().to_string_lossy().to_string();
        let git = |args: &[&str]| run_git(&repo, args).unwrap();
        git(&["init", "-q"]);
        git(&["config", "user.email", "test@example.com"]);
        git(&["config", "user.name", "test"]);
        std::fs::write(dir.path().join("base.txt"), "base\n").unwrap();
        git(&["add", "base.txt"]);
        git(&["commit", "-q", "-m", "base"]);
        let base_branch = run_git(&repo, &["branch", "--show-current"]).unwrap();
        git(&["checkout", "-q", "-b", "feature"]);
        std::fs::write(dir.path().join("feature.txt"), "feature\n").unwrap();
        std::fs::write(dir.path().join("base.txt"), "base\nfeature-added-line\n").unwrap();
        git(&["add", "feature.txt", "base.txt"]);
        git(&["commit", "-q", "-m", "feature file"]);
        git(&["checkout", "-q", &base_branch]);
        (dir, repo, base_branch)
    }

    #[tokio::test]
    async fn lists_the_other_branchs_files_without_checking_it_out() {
        let (_dir, repo, base_branch) = two_branch_repo();
        let head_before = run_git(&repo, &["rev-parse", "HEAD"]).unwrap();
        let status_before = run_git(&repo, &["status", "--porcelain"]).unwrap();

        let files = list_branch_files_local(repo.clone(), "feature".into()).await.unwrap();
        assert!(files.contains(&"feature.txt".to_string()), "{files:?}");
        assert!(files.contains(&"base.txt".to_string()), "{files:?}");

        assert_eq!(run_git(&repo, &["rev-parse", "HEAD"]).unwrap(), head_before, "HEAD moved");
        assert_eq!(run_git(&repo, &["status", "--porcelain"]).unwrap(), status_before, "working tree changed");
        assert_eq!(run_git(&repo, &["branch", "--show-current"]).unwrap(), base_branch, "branch changed");
    }

    #[tokio::test]
    async fn rejects_a_dash_prefixed_branch_name() {
        let (_dir, repo, _base) = two_branch_repo();
        let err = list_branch_files_local(repo, "--output=x".into()).await.unwrap_err();
        assert!(err.contains("branch"), "{err}");
    }

    #[tokio::test]
    async fn range_files_with_base_diffs_head_to_branch_not_the_worktree() {
        let (dir, repo, _base) = two_branch_repo();
        // Dirtying the checked-out branch's worktree must not leak into a
        // base=HEAD..feature diff: both ends are already pinned commits.
        std::fs::write(dir.path().join("base.txt"), "base\nuncommitted-edit\n").unwrap();

        let files = get_range_files_local(repo, None, Some("feature".into()), Some("HEAD".into())).await.unwrap();
        assert_eq!(files.len(), 2, "uncommitted edit must not appear: {files:?}");

        let added = files.iter().find(|f| f.path == "feature.txt").expect("feature-only file listed");
        assert_eq!(added.status, "A", "{files:?}");

        let modified = files.iter().find(|f| f.path == "base.txt").expect("branch-changed file listed");
        assert_eq!(modified.status, "M", "{files:?}");
        assert_eq!((modified.added, modified.removed), (1, 0), "{files:?}");
    }

    #[tokio::test]
    async fn file_diff_with_base_shows_the_branchs_added_line() {
        let (dir, repo, _base) = two_branch_repo();
        std::fs::write(dir.path().join("base.txt"), "base\nuncommitted-edit\n").unwrap();

        let diff = get_file_diff_local(repo, None, Some("feature".into()), Some("HEAD".into()), "base.txt".into(), None)
            .await
            .unwrap();
        assert!(diff.contains("+feature-added-line"), "{diff}");
        assert!(!diff.contains("uncommitted-edit"), "{diff}");
    }

    #[tokio::test]
    async fn rejects_a_dash_prefixed_base() {
        let (_dir, repo, _base) = two_branch_repo();
        let err = get_range_files_local(repo, None, Some("feature".into()), Some("--output=x".into())).await.unwrap_err();
        assert!(err.contains("base"), "{err}");
    }
}
