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
