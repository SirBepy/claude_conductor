//! Git info IPC: branch/repo/ahead-behind/dirty status. Split out of `misc.rs`
//! so each module keeps a single responsibility. The PR range-diff subsystem
//! lives in the sibling `git_diff` module; session/context-transcript
//! resolution lives in `context_status`.

#[derive(serde::Serialize, ts_rs::TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct GitInfo {
    pub branch: Option<String>,
    pub repo: Option<String>,
    pub ahead: Option<u32>,
    pub behind: Option<u32>,
    pub sha: Option<String>,
    pub insertions: Option<u32>,
    pub deletions: Option<u32>,
}

/// Parse `git diff --shortstat` output into (insertions, deletions). Empty
/// output (clean tree) => (None, None); a present line with only one side =>
/// the missing side is 0.
pub fn parse_shortstat(s: &str) -> (Option<u32>, Option<u32>) {
    let s = s.trim();
    if s.is_empty() {
        return (None, None);
    }
    let grab = |needle: &str| -> Option<u32> {
        let idx = s.find(needle)?;
        s[..idx]
            .rsplit(|c: char| !c.is_ascii_digit())
            .find(|p| !p.is_empty())
            .and_then(|p| p.parse().ok())
    };
    (Some(grab("insertion").unwrap_or(0)), Some(grab("deletion").unwrap_or(0)))
}

/// Returns the list of files with uncommitted changes in the given directory.
/// Used to detect whether there is work to commit before closing a chat session.
/// Returns an empty vec if the directory is not a git repo or git is unavailable.
#[tauri::command]
pub async fn get_git_dirty(cwd: String) -> Vec<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = std::process::Command::new("git");
        cmd.arg("-C").arg(&cwd).args(["status", "--porcelain"]);
        crate::util::process::hide_console(&mut cmd);
        cmd.output()
            .ok()
            .filter(|o| o.status.success())
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .map(|s| {
                s.lines()
                    .filter(|l| l.len() > 3)
                    .map(|l| l[3..].trim().to_string())
                    .filter(|p| !p.is_empty())
                    .collect()
            })
            .unwrap_or_default()
    })
    .await
    .unwrap_or_default()
}

/// Runs `git -C <cwd> <args>`, hiding the console window on Windows. Returns
/// trimmed stdout on success, or the trimmed stderr (falling back to a
/// generic message when stderr is empty) on failure.
pub(super) fn run_git(cwd: &str, args: &[&str]) -> Result<String, String> {
    let mut cmd = std::process::Command::new("git");
    cmd.arg("-C").arg(cwd).args(args);
    crate::util::process::hide_console(&mut cmd);
    let output = cmd.output().map_err(|e| format!("failed to run git: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() { "git command failed".to_string() } else { stderr });
    }
    String::from_utf8(output.stdout)
        .map(|s| s.trim().to_string())
        .map_err(|e| format!("git output was not utf-8: {e}"))
}

/// `run_git`, discarding errors and treating an empty result as absent - the
/// shape most call sites in this file want (a missing branch/remote/sha is
/// not an error).
fn run_git_opt(cwd: &str, args: &[&str]) -> Option<String> {
    run_git(cwd, args).ok().filter(|s| !s.is_empty())
}

/// Returns the current git branch and repository name for the given working
/// directory. Used by the session statusbar to show branch + repo context.
/// Never fails - missing git / no repo / no remote all produce None fields.
///
/// Runs on the blocking pool: spawning `git` is real process IO which
/// must NOT happen on the Tauri runtime thread or the webview UI hangs
/// for the duration of the spawn. On Windows the spawned `git.exe` is
/// flagged CREATE_NO_WINDOW to suppress the otherwise-visible console
/// flash on every chat open.
#[tauri::command]
pub async fn get_git_info(cwd: String) -> GitInfo {
    tauri::async_runtime::spawn_blocking(move || {
        let branch = run_git_opt(&cwd, &["branch", "--show-current"]);

        let remote_url = run_git_opt(&cwd, &["remote", "get-url", "origin"]);
        let repo = if let Some(url) = &remote_url {
            url.split('/')
                .last()
                .map(|s| s.trim_end_matches(".git").to_string())
                .filter(|s| !s.is_empty())
        } else {
            std::path::Path::new(&cwd)
                .file_name()
                .and_then(|s| s.to_str())
                .map(|s| s.to_string())
        };

        // Upstream ahead/behind: `behind<TAB>ahead`. None when no upstream.
        let (ahead, behind) = run_git_opt(&cwd, &["rev-list", "--left-right", "--count", "@{u}...HEAD"])
            .and_then(|s| {
                let mut it = s.split_whitespace();
                let behind = it.next()?.parse::<u32>().ok()?;
                let ahead = it.next()?.parse::<u32>().ok()?;
                Some((Some(ahead), Some(behind)))
            })
            .unwrap_or((None, None));

        let sha = run_git_opt(&cwd, &["rev-parse", "--short", "HEAD"]);

        let (insertions, deletions) = run_git_opt(&cwd, &["diff", "--shortstat"])
            .map(|s| parse_shortstat(&s))
            .unwrap_or((None, None));

        GitInfo { branch, repo, ahead, behind, sha, insertions, deletions }
    })
    .await
    .unwrap_or(GitInfo { branch: None, repo: None, ahead: None, behind: None, sha: None, insertions: None, deletions: None })
}

#[derive(serde::Serialize, ts_rs::TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct BranchEntry {
    pub name: String,
    pub current: bool,
    pub short_sha: Option<String>,
    pub upstream: Option<String>,
}

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

/// Returns recent local branches sorted by last commit date (most recent first),
/// up to 15. Each entry carries the current-branch marker, short SHA, and
/// tracking upstream ref if configured.
#[tauri::command]
pub async fn get_recent_branches(cwd: String) -> Vec<BranchEntry> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = std::process::Command::new("git");
        cmd.arg("-C").arg(&cwd).args([
            "branch",
            "--sort=-committerdate",
            "--format=%(HEAD)|%(refname:short)|%(objectname:short)|%(upstream:short)",
        ]);
        crate::util::process::hide_console(&mut cmd);
        let out = cmd
            .output()
            .ok()
            .filter(|o| o.status.success())
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .unwrap_or_default();
        out.lines()
            .take(15)
            .filter_map(|line| {
                let mut parts = line.splitn(4, '|');
                let head = parts.next()?;
                let name = parts.next()?.trim().to_string();
                if name.is_empty() { return None; }
                let short_sha = parts.next().map(|s| s.trim()).filter(|s| !s.is_empty()).map(str::to_string);
                let upstream = parts.next().map(|s| s.trim()).filter(|s| !s.is_empty()).map(str::to_string);
                Some(BranchEntry { name, current: head.trim() == "*", short_sha, upstream })
            })
            .collect()
    })
    .await
    .unwrap_or_default()
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

#[cfg(test)]
mod git_info_tests {
    use super::parse_shortstat;

    #[test]
    fn parses_insertions_and_deletions() {
        assert_eq!(parse_shortstat(" 3 files changed, 42 insertions(+), 7 deletions(-)"), (Some(42), Some(7)));
    }
    #[test]
    fn parses_insertions_only() {
        assert_eq!(parse_shortstat(" 1 file changed, 5 insertions(+)"), (Some(5), Some(0)));
    }
    #[test]
    fn parses_deletions_only() {
        assert_eq!(parse_shortstat(" 1 file changed, 9 deletions(-)"), (Some(0), Some(9)));
    }
    #[test]
    fn empty_is_none() {
        assert_eq!(parse_shortstat(""), (None, None));
    }
}
