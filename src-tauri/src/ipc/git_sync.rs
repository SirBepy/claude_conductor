//! Commit-sync/history subsystem: ahead/behind commit lists, paginated commit
//! history with pushed/unpushed flags, and pushing local commits. Split out
//! of `git.rs` to keep that module to branch/repo/dirty-status concerns;
//! shares the `run_git`/`run_git_opt` helpers defined there.

use super::git::{run_git, run_git_opt};

#[derive(serde::Serialize, ts_rs::TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct CommitEntry {
    pub short_sha: String,
    pub message: String,
}

#[derive(serde::Serialize, ts_rs::TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct CommitSync {
    pub ahead: Vec<CommitEntry>,
    pub behind: Vec<CommitEntry>,
    pub has_upstream: bool,
}

/// Returns the list of commits that are ahead (local-only) and behind (upstream-only)
/// the tracking branch. Used for the VSCode-style sync popover on the commits chip.
#[tauri::command]
pub async fn get_commit_sync(cwd: String) -> CommitSync {
    let empty = CommitSync { ahead: vec![], behind: vec![], has_upstream: false };
    tauri::async_runtime::spawn_blocking(move || {
        fn parse_log(raw: Option<String>) -> Vec<CommitEntry> {
            raw.unwrap_or_default()
                .lines()
                .take(50)
                .filter_map(|l| {
                    let (sha, msg) = l.split_once('|')?;
                    Some(CommitEntry { short_sha: sha.trim().to_string(), message: msg.to_string() })
                })
                .collect()
        }
        if run_git_opt(&cwd, &["rev-parse", "@{u}"]).is_none() {
            return CommitSync { ahead: vec![], behind: vec![], has_upstream: false };
        }
        CommitSync {
            ahead: parse_log(run_git_opt(&cwd, &["log", "--pretty=format:%h|%s", "@{u}..HEAD"])),
            behind: parse_log(run_git_opt(&cwd, &["log", "--pretty=format:%h|%s", "HEAD..@{u}"])),
            has_upstream: true,
        }
    })
    .await
    .unwrap_or(empty)
}

#[derive(serde::Serialize, ts_rs::TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct CommitHistoryEntry {
    pub short_sha: String,
    pub message: String,
    pub pushed: bool,
    /// Commit (author) time, unix seconds.
    pub timestamp: i64,
}

#[derive(serde::Serialize, ts_rs::TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct CommitHistory {
    pub entries: Vec<CommitHistoryEntry>,
    pub has_more: bool,
    pub has_upstream: bool,
}

/// One page of `git log HEAD`, newest first, each commit flagged pushed or not.
/// `pushed` is set membership against `git rev-list @{u}..HEAD`, not "the first
/// N are unpushed": merging a local branch interleaves unpushed commits into
/// the date-ordered log. With no upstream, every commit reads as unpushed.
#[tauri::command]
pub async fn get_commit_history(cwd: String, offset: u32, limit: u32) -> CommitHistory {
    let limit = limit.clamp(1, 200);
    tauri::async_runtime::spawn_blocking(move || {
        let has_upstream = run_git_opt(&cwd, &["rev-parse", "@{u}"]).is_some();
        let unpushed: std::collections::HashSet<String> = run_git_opt(&cwd, &["rev-list", "@{u}..HEAD"])
            .unwrap_or_default()
            .lines()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .collect();
        // One row past the page answers has_more without a second count query.
        let count = (limit + 1).to_string();
        let skip = format!("--skip={offset}");
        let raw = run_git_opt(
            &cwd,
            &["log", "--pretty=format:%H|%h|%ct|%s", "-n", &count, &skip, "HEAD"],
        );
        let mut entries: Vec<CommitHistoryEntry> = raw
            .unwrap_or_default()
            .lines()
            .filter_map(|l| {
                let mut parts = l.splitn(4, '|');
                let full = parts.next()?.trim();
                let short = parts.next()?.trim();
                let timestamp = parts.next()?.trim().parse::<i64>().unwrap_or(0);
                let message = parts.next().unwrap_or("").to_string();
                Some(CommitHistoryEntry {
                    short_sha: short.to_string(),
                    message,
                    pushed: has_upstream && !unpushed.contains(full),
                    timestamp,
                })
            })
            .collect();
        let has_more = entries.len() as u32 > limit;
        entries.truncate(limit as usize);
        CommitHistory { entries, has_more, has_upstream }
    })
    .await
    .unwrap_or(CommitHistory { entries: vec![], has_more: false, has_upstream: false })
}

/// `publish=true` runs `git push -u origin <branch>` (no upstream yet);
/// otherwise a plain `git push`. Errors return git's raw stderr - the caller
/// decides how to display a non-fast-forward rejection, not us.
#[tauri::command]
pub async fn push_commits(cwd: String, publish: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        if publish {
            let branch = run_git_opt(&cwd, &["branch", "--show-current"])
                .ok_or_else(|| "no current branch to publish".to_string())?;
            run_git(&cwd, &["push", "-u", "origin", &branch]).map(|_| ())
        } else {
            run_git(&cwd, &["push"]).map(|_| ())
        }
    })
    .await
    .map_err(|e| format!("push task panicked: {e}"))?
}

/// Checks out an existing local branch by name. Deliberately a plain
/// `git checkout <name>` with no `--force`: git's own checkout semantics
/// already match the product decision (todo 889) - a file unchanged between
/// branches carries the dirty edit across silently, and only a change that
/// would conflict with the target branch's version makes git refuse. That
/// refusal's stderr is returned verbatim rather than forced past.
#[tauri::command]
pub async fn checkout_branch(cwd: String, name: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || run_git(&cwd, &["checkout", &name]).map(|_| ()))
        .await
        .map_err(|e| format!("checkout task panicked: {e}"))?
}

/// Fast-forward-only pull (`--ff-only`): can never create a merge commit
/// silently. A diverged/non-fast-forward upstream surfaces git's refusal
/// text instead of attempting a merge the user never asked for.
#[tauri::command]
pub async fn pull_commits(cwd: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || run_git(&cwd, &["pull", "--ff-only"]).map(|_| ()))
        .await
        .map_err(|e| format!("pull task panicked: {e}"))?
}

#[cfg(test)]
mod checkout_pull_tests {
    use std::process::Command;
    use tempfile::TempDir;

    fn git(cwd: &std::path::Path, args: &[&str]) -> std::process::Output {
        Command::new("git").arg("-C").arg(cwd).args(args).output().expect("git spawn")
    }

    fn init_repo() -> TempDir {
        let dir = TempDir::new().unwrap();
        assert!(git(dir.path(), &["init", "-q", "-b", "master"]).status.success());
        assert!(git(dir.path(), &["config", "user.email", "test@example.com"]).status.success());
        assert!(git(dir.path(), &["config", "user.name", "Test"]).status.success());
        dir
    }

    fn write(dir: &std::path::Path, name: &str, contents: &str) {
        std::fs::write(dir.join(name), contents).unwrap();
    }

    fn commit_all(dir: &std::path::Path, msg: &str) {
        assert!(git(dir, &["add", "-A"]).status.success());
        assert!(git(dir, &["commit", "-q", "-m", msg]).status.success());
    }

    #[tokio::test]
    async fn checkout_switches_to_a_clean_branch() {
        let repo = init_repo();
        write(repo.path(), "a.txt", "one");
        commit_all(repo.path(), "initial");
        assert!(git(repo.path(), &["checkout", "-q", "-b", "feature"]).status.success());
        assert!(git(repo.path(), &["checkout", "-q", "master"]).status.success());

        let cwd = repo.path().to_string_lossy().to_string();
        let result = super::checkout_branch(cwd.clone(), "feature".to_string()).await;
        assert!(result.is_ok(), "{result:?}");
        let branch = git(repo.path(), &["branch", "--show-current"]);
        assert_eq!(String::from_utf8_lossy(&branch.stdout).trim(), "feature");
    }

    #[tokio::test]
    async fn checkout_carries_a_dirty_file_that_does_not_conflict() {
        let repo = init_repo();
        write(repo.path(), "a.txt", "one");
        commit_all(repo.path(), "initial");
        assert!(git(repo.path(), &["checkout", "-q", "-b", "feature"]).status.success());
        assert!(git(repo.path(), &["checkout", "-q", "master"]).status.success());
        // Dirty a file that `feature` never touched - git carries this across
        // a checkout rather than refusing it.
        write(repo.path(), "untouched.txt", "dirty edit");

        let cwd = repo.path().to_string_lossy().to_string();
        let result = super::checkout_branch(cwd, "feature".to_string()).await;
        assert!(result.is_ok(), "{result:?}");
        assert_eq!(std::fs::read_to_string(repo.path().join("untouched.txt")).unwrap(), "dirty edit");
    }

    #[tokio::test]
    async fn checkout_refused_by_a_conflicting_local_change_returns_gits_text() {
        let repo = init_repo();
        write(repo.path(), "a.txt", "one");
        commit_all(repo.path(), "initial");
        assert!(git(repo.path(), &["checkout", "-q", "-b", "feature"]).status.success());
        write(repo.path(), "a.txt", "feature version");
        commit_all(repo.path(), "feature change");
        assert!(git(repo.path(), &["checkout", "-q", "master"]).status.success());
        // Dirty the same file master also has a different version of -
        // checkout must refuse rather than silently overwrite or force past it.
        write(repo.path(), "a.txt", "uncommitted conflicting edit");

        let cwd = repo.path().to_string_lossy().to_string();
        let result = super::checkout_branch(cwd, "feature".to_string()).await;
        let err = result.expect_err("checkout should have been refused");
        assert!(err.to_lowercase().contains("overwritten") || err.to_lowercase().contains("checkout"), "{err}");
        // Never forced: the conflicting edit is still here, uncommitted.
        assert_eq!(std::fs::read_to_string(repo.path().join("a.txt")).unwrap(), "uncommitted conflicting edit");
    }

    #[tokio::test]
    async fn pull_ff_only_succeeds_from_a_bare_remote() {
        let remote = TempDir::new().unwrap();
        assert!(git(remote.path(), &["init", "-q", "--bare", "-b", "master"]).status.success());

        let origin = init_repo();
        write(origin.path(), "a.txt", "one");
        commit_all(origin.path(), "initial");
        assert!(git(origin.path(), &["remote", "add", "origin", &remote.path().to_string_lossy()]).status.success());
        assert!(git(origin.path(), &["push", "-q", "-u", "origin", "master"]).status.success());

        let clone = TempDir::new().unwrap();
        let clone_out = Command::new("git")
            .args(["clone", "-q", &remote.path().to_string_lossy(), &clone.path().to_string_lossy()])
            .output()
            .expect("git clone");
        assert!(clone_out.status.success(), "{}", String::from_utf8_lossy(&clone_out.stderr));
        assert!(git(clone.path(), &["config", "user.email", "test@example.com"]).status.success());
        assert!(git(clone.path(), &["config", "user.name", "Test"]).status.success());

        // Advance origin so the clone is behind, then pull it.
        write(origin.path(), "b.txt", "two");
        commit_all(origin.path(), "second");
        assert!(git(origin.path(), &["push", "-q"]).status.success());

        let cwd = clone.path().to_string_lossy().to_string();
        let result = super::pull_commits(cwd).await;
        assert!(result.is_ok(), "{result:?}");
        assert!(clone.path().join("b.txt").exists());
    }

    #[tokio::test]
    async fn pull_refuses_a_non_fast_forward() {
        let remote = TempDir::new().unwrap();
        assert!(git(remote.path(), &["init", "-q", "--bare", "-b", "master"]).status.success());

        let origin = init_repo();
        write(origin.path(), "a.txt", "one");
        commit_all(origin.path(), "initial");
        assert!(git(origin.path(), &["remote", "add", "origin", &remote.path().to_string_lossy()]).status.success());
        assert!(git(origin.path(), &["push", "-q", "-u", "origin", "master"]).status.success());

        let clone = TempDir::new().unwrap();
        let clone_out = Command::new("git")
            .args(["clone", "-q", &remote.path().to_string_lossy(), &clone.path().to_string_lossy()])
            .output()
            .expect("git clone");
        assert!(clone_out.status.success(), "{}", String::from_utf8_lossy(&clone_out.stderr));
        assert!(git(clone.path(), &["config", "user.email", "test@example.com"]).status.success());
        assert!(git(clone.path(), &["config", "user.name", "Test"]).status.success());

        // Diverge both sides: origin gets a commit the clone doesn't have,
        // and the clone gets its own local commit - a real fast-forward is
        // impossible, only a merge could reconcile them.
        write(origin.path(), "b.txt", "two");
        commit_all(origin.path(), "origin-side");
        assert!(git(origin.path(), &["push", "-q"]).status.success());
        write(clone.path(), "c.txt", "three");
        commit_all(clone.path(), "clone-side");

        let cwd = clone.path().to_string_lossy().to_string();
        let result = super::pull_commits(cwd).await;
        let err = result.expect_err("pull should have refused a non-fast-forward");
        assert!(err.to_lowercase().contains("fast-forward") || err.to_lowercase().contains("ff"), "{err}");
        // No merge commit was created.
        let log = git(clone.path(), &["log", "--oneline", "-1"]);
        assert!(String::from_utf8_lossy(&log.stdout).contains("clone-side"));
    }
}
