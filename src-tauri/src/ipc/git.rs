//! Git info IPC: branch/repo/ahead-behind/dirty status. Split out of `misc.rs`
//! so each module keeps a single responsibility. The PR range-diff subsystem
//! lives in the sibling `git_diff` module; session/context-transcript
//! resolution lives in `context_status`; commit-sync/history lives in
//! `git_sync`.
//!
//! Every read-only command below takes an optional `session_id`: when it
//! resolves to a session mirrored from a paired peer machine (G10,
//! docs/multi-machine.md), the read is routed one hop to the owning peer via
//! the daemon (`ipc::mirror::route_mirrored`) instead of running `git`
//! against `cwd`, which is a path on the PEER's disk, not this one's.

use tauri::State;

use crate::state::AppState;

// Re-exported so `ipc::*`/`ipc::git::*` callers (including the daemon
// statusbar router's fully-qualified paths) keep resolving after the move.
pub use super::git_sync::*;

#[derive(serde::Serialize, serde::Deserialize, ts_rs::TS)]
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
///
/// `pub(crate)` (not `#[tauri::command]`): this is the pure local read,
/// reused directly by the daemon's own `get_git_dirty` RPC handler
/// (`daemon/methods/statusbar.rs`), which runs in a separate process with no
/// `AppState` and always wants the local read - by the time a forwarded call
/// reaches a handler, `machines/forward.rs` already routed it to the owning
/// peer, so that peer's own handler must read ITS OWN disk, never recurse
/// into mirror routing again. The Tauri-facing command below (same name,
/// public) is the only caller that needs the mirror check.
pub(crate) async fn get_git_dirty_local(cwd: String) -> Vec<String> {
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

/// Tauri-facing command: routes to the owning peer when `session_id`
/// resolves to a mirrored session (G10, docs/multi-machine.md), else runs
/// the same local read as before.
///
/// `Result`-wrapped (always `Ok`, never actually fails) solely because Tauri
/// requires an async command taking a `State<'_, _>` reference to return
/// `Result` - the JS side still just sees a plain `string[]` on success,
/// same as before this command took `state`.
#[tauri::command]
pub async fn get_git_dirty(cwd: String, session_id: Option<String>, state: State<'_, AppState>) -> Result<Vec<String>, String> {
    Ok(get_git_dirty_routed(cwd, session_id, &state.cached_instances, state.client().await).await)
}

/// `get_git_dirty` with its two inputs from `AppState` passed in, so a test can
/// drive the mirrored branch with a fake client.
async fn get_git_dirty_routed<C: crate::ipc::mirror::MirrorReads>(
    cwd: String,
    session_id: Option<String>,
    instances: &std::sync::Mutex<Vec<crate::types::Instance>>,
    client: Option<C>,
) -> Vec<String> {
    if let Some(client) = crate::ipc::mirror::route_mirrored(instances, session_id.as_deref(), client) {
        let sid = session_id.as_deref().unwrap_or_default();
        return client.get_git_dirty(sid, &cwd).await.unwrap_or_default();
    }
    get_git_dirty_local(cwd).await
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
pub(super) fn run_git_opt(cwd: &str, args: &[&str]) -> Option<String> {
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
pub(crate) async fn get_git_info_local(cwd: String) -> GitInfo {
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

/// Tauri-facing command: routes to the owning peer when `session_id`
/// resolves to a mirrored session (G10, docs/multi-machine.md), else runs
/// the same local read as before. See `get_git_dirty`'s doc for why this
/// returns `Result` (always `Ok`) and why the pure read is split out.
#[tauri::command]
pub async fn get_git_info(cwd: String, session_id: Option<String>, state: State<'_, AppState>) -> Result<GitInfo, String> {
    Ok(get_git_info_routed(cwd, session_id, &state.cached_instances, state.client().await).await)
}

/// `get_git_info` with its two inputs from `AppState` passed in, so a test can
/// drive the mirrored branch with a fake client.
async fn get_git_info_routed<C: crate::ipc::mirror::MirrorReads>(
    cwd: String,
    session_id: Option<String>,
    instances: &std::sync::Mutex<Vec<crate::types::Instance>>,
    client: Option<C>,
) -> GitInfo {
    if let Some(client) = crate::ipc::mirror::route_mirrored(instances, session_id.as_deref(), client) {
        let sid = session_id.as_deref().unwrap_or_default();
        // The empty answer hides the git chip with no trace, so the reason a
        // peer read failed is only ever visible here.
        return client.get_git_info(sid, &cwd).await.unwrap_or_else(|e| {
            log::warn!("get_git_info: mirrored session {sid} read failed: {e}");
            GitInfo { branch: None, repo: None, ahead: None, behind: None, sha: None, insertions: None, deletions: None }
        });
    }
    get_git_info_local(cwd).await
}

#[derive(serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct BranchEntry {
    pub name: String,
    pub current: bool,
    pub short_sha: Option<String>,
    pub upstream: Option<String>,
}

/// Returns recent local branches sorted by last commit date (most recent first),
/// up to 15. Each entry carries the current-branch marker, short SHA, and
/// tracking upstream ref if configured.
pub(crate) async fn get_recent_branches_local(cwd: String) -> Vec<BranchEntry> {
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

/// Tauri-facing command: routes to the owning peer when `session_id`
/// resolves to a mirrored session (G10, docs/multi-machine.md), else runs
/// the same local read as before. See `get_git_dirty_local`'s doc for why
/// the pure read is split out.
#[tauri::command]
pub async fn get_recent_branches(cwd: String, session_id: Option<String>, state: State<'_, AppState>) -> Result<Vec<BranchEntry>, String> {
    Ok(get_recent_branches_routed(cwd, session_id, &state.cached_instances, state.client().await).await)
}

/// `get_recent_branches` with its two inputs from `AppState` passed in, so a
/// test can drive the mirrored branch with a fake client.
async fn get_recent_branches_routed<C: crate::ipc::mirror::MirrorReads>(
    cwd: String,
    session_id: Option<String>,
    instances: &std::sync::Mutex<Vec<crate::types::Instance>>,
    client: Option<C>,
) -> Vec<BranchEntry> {
    if let Some(client) = crate::ipc::mirror::route_mirrored(instances, session_id.as_deref(), client) {
        let sid = session_id.as_deref().unwrap_or_default();
        return client.get_recent_branches(sid, &cwd).await.unwrap_or_default();
    }
    get_recent_branches_local(cwd).await
}

#[cfg(test)]
mod git_info_mirrored_tests {
    use super::*;
    use crate::ipc::mirror::fake::{instance_cache, FakeMirror, PEER_BRANCH, PEER_FILE};

    #[tokio::test]
    async fn a_mirrored_row_reads_the_info_through_the_client_by_session_id() {
        let fake = FakeMirror::ok();
        let cache = instance_cache("local-1", "mirror-1");

        let info = get_git_info_routed("C:/peer/repo".into(), Some("mirror-1".into()), &cache, Some(fake.clone())).await;

        assert_eq!(info.branch.as_deref(), Some(PEER_BRANCH));
        assert_eq!(fake.calls(), [("get_git_info".into(), "mirror-1".into(), "C:/peer/repo".into())]);
    }

    #[tokio::test]
    async fn a_client_error_reads_as_an_empty_info() {
        let fake = FakeMirror::failing();
        let cache = instance_cache("local-1", "mirror-1");

        let info = get_git_info_routed("C:/peer/repo".into(), Some("mirror-1".into()), &cache, Some(fake.clone())).await;

        assert!(info.branch.is_none() && info.repo.is_none() && info.sha.is_none());
        assert_eq!(fake.calls().len(), 1, "the failed read must have been attempted, not skipped");
    }

    #[tokio::test]
    async fn a_mirrored_row_reads_the_dirty_files_through_the_client_by_session_id() {
        let fake = FakeMirror::ok();
        let cache = instance_cache("local-1", "mirror-1");

        let dirty = get_git_dirty_routed("C:/peer/repo".into(), Some("mirror-1".into()), &cache, Some(fake.clone())).await;

        assert_eq!(dirty, [PEER_FILE]);
        assert_eq!(fake.calls(), [("get_git_dirty".into(), "mirror-1".into(), "C:/peer/repo".into())]);
    }

    #[tokio::test]
    async fn a_client_error_reads_as_no_dirty_files() {
        let fake = FakeMirror::failing();
        let cache = instance_cache("local-1", "mirror-1");

        let dirty = get_git_dirty_routed("C:/peer/repo".into(), Some("mirror-1".into()), &cache, Some(fake.clone())).await;

        assert!(dirty.is_empty());
        assert_eq!(fake.calls().len(), 1, "the failed read must have been attempted, not skipped");
    }

    #[tokio::test]
    async fn a_mirrored_row_reads_the_branches_through_the_client_by_session_id() {
        let fake = FakeMirror::ok();
        let cache = instance_cache("local-1", "mirror-1");

        let branches = get_recent_branches_routed("C:/peer/repo".into(), Some("mirror-1".into()), &cache, Some(fake.clone())).await;

        assert_eq!(branches.iter().map(|b| b.name.as_str()).collect::<Vec<_>>(), [PEER_BRANCH]);
        assert_eq!(fake.calls(), [("get_recent_branches".into(), "mirror-1".into(), "C:/peer/repo".into())]);
    }

    #[tokio::test]
    async fn a_client_error_reads_as_no_branches() {
        let fake = FakeMirror::failing();
        let cache = instance_cache("local-1", "mirror-1");

        let branches = get_recent_branches_routed("C:/peer/repo".into(), Some("mirror-1".into()), &cache, Some(fake.clone())).await;

        assert!(branches.is_empty());
        assert_eq!(fake.calls().len(), 1, "the failed read must have been attempted, not skipped");
    }
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
