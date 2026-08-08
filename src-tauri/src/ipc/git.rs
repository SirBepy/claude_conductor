//! Git info IPC: branch/repo/ahead-behind/dirty status + the daemon-aligned
//! context-window status (which resolves a transcript on local disk). Split out
//! of `misc.rs` so each module keeps a single responsibility. The PR range-diff
//! subsystem (file-change listing + single-file diffs across a commit range)
//! lives in the sibling `git_diff` module.

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

/// Resolves a session's transcript path from the app's mirrored instance
/// cache. The daemon registry isn't directly reachable here; `cached_instances`
/// is the app-side mirror refreshed via `instances_changed`.
fn resolve_session_transcript(
    state: &crate::state::AppState,
    session_id: &str,
) -> Option<std::path::PathBuf> {
    use crate::tokens::walker;

    let instances = state.cached_instances.lock().unwrap();
    instances
        .iter()
        .find(|i| i.session_id == session_id)
        .and_then(|inst| {
            inst.transcript_path
                .as_ref()
                .filter(|p| p.exists())
                .cloned()
                .or_else(|| walker::transcript_for_session(&inst.cwd, session_id))
        })
}

/// Fallback for when the mirrored instance cache doesn't resolve a transcript:
/// scans `~/.claude/projects/*/<session_id>.jsonl` directly. Blocking - call
/// from within `spawn_blocking`.
fn scan_projects_for_session(session_id: &str) -> Option<std::path::PathBuf> {
    use crate::tokens::walker;

    let projects = walker::claude_projects_dir()?;
    let target = format!("{session_id}.jsonl");
    let entries = std::fs::read_dir(&projects).ok()?;
    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let candidate = dir.join(&target);
        if candidate.exists() {
            return Some(candidate);
        }
    }
    None
}

/// Daemon-aligned context-window status for a session. The transcript lives on
/// local disk, so the app resolves it itself (cwd from the mirrored instance
/// cache, else a project-dir scan) and runs the same core scorer the daemon's
/// `/context` endpoint uses. This is the least-coupled option: no daemon RPC,
/// one shared `compute_context_status` for both surfaces. Returns None when the
/// transcript can't be resolved or carries no usage lines.
#[tauri::command]
pub async fn context_status(
    session_id: String,
    state: tauri::State<'_, crate::state::AppState>,
) -> Result<Option<crate::context_status::ContextStatus>, String> {
    let resolved = resolve_session_transcript(&state, &session_id);

    let status = tauri::async_runtime::spawn_blocking(move || {
        if let Some(path) = resolved {
            return crate::context_status::compute_context_status(&path);
        }
        // Fallback: scan ~/.claude/projects/*/<session_id>.jsonl directly.
        let candidate = scan_projects_for_session(&session_id)?;
        crate::context_status::compute_context_status(&candidate)
    })
    .await
    .map_err(|e| format!("context_status join error: {e}"))?;

    Ok(status)
}

/// Scans a transcript for the most recent line carrying a non-empty `cwd`,
/// reading from the end so large transcripts stay cheap (we stop at the first
/// cwd-bearing line). Claude Code writes the CLI's working directory on every
/// `user`/`assistant` line (`last-prompt`/`mode` rows omit it), so the last
/// such value is where the session is *actually* operating - which differs from
/// the daemon-recorded spawn dir once the AI moves into a git worktree.
fn last_transcript_cwd(path: &std::path::Path) -> Option<String> {
    let content = std::fs::read_to_string(path).ok()?;
    for line in content.lines().rev() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
            if let Some(cwd) = v.get("cwd").and_then(|c| c.as_str()) {
                if !cwd.is_empty() {
                    return Some(cwd.to_string());
                }
            }
        }
    }
    None
}

/// Returns the session's *live* working directory - the last `cwd` recorded in
/// its transcript - so git chips can follow the AI into a worktree instead of
/// pinning to the spawn dir. Resolves the transcript the same way
/// `context_status` does (mirrored instance cache, else a project-dir scan).
/// Falls back to `fallback` (the spawn cwd) when the transcript can't be
/// resolved or records no cwd, so callers always get a usable directory.
#[tauri::command]
pub async fn session_live_cwd(
    session_id: String,
    fallback: String,
    state: tauri::State<'_, crate::state::AppState>,
) -> Result<String, String> {
    let resolved = resolve_session_transcript(&state, &session_id);

    let cwd = tauri::async_runtime::spawn_blocking(move || -> Option<String> {
        let path = resolved.or_else(|| scan_projects_for_session(&session_id))?;
        last_transcript_cwd(&path)
    })
    .await
    .map_err(|e| format!("session_live_cwd join error: {e}"))?;

    Ok(cwd.unwrap_or(fallback))
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

#[derive(serde::Serialize)]
pub struct CommitEntry {
    pub short_sha: String,
    pub message: String,
}

#[derive(serde::Serialize)]
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

#[cfg(test)]
mod live_cwd_tests {
    use super::last_transcript_cwd;
    use std::io::Write;

    fn write_tmp(name: &str, body: &str) -> std::path::PathBuf {
        let mut path = std::env::temp_dir();
        path.push(format!("cc_livecwd_{name}.jsonl"));
        let mut f = std::fs::File::create(&path).unwrap();
        f.write_all(body.as_bytes()).unwrap();
        path
    }

    #[test]
    fn returns_last_line_cwd() {
        let path = write_tmp(
            "last",
            "{\"type\":\"user\",\"cwd\":\"C:\\\\repo\"}\n\
             {\"type\":\"assistant\",\"cwd\":\"C:\\\\repo\\\\wt\"}\n",
        );
        assert_eq!(last_transcript_cwd(&path).as_deref(), Some("C:\\repo\\wt"));
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn skips_trailing_lines_without_cwd() {
        // `last-prompt`/`mode` rows carry no cwd; the scan must fall back to the
        // most recent line that does.
        let path = write_tmp(
            "skip",
            "{\"type\":\"assistant\",\"cwd\":\"C:\\\\repo\\\\wt\"}\n\
             {\"type\":\"last-prompt\"}\n\
             {\"type\":\"mode\"}\n",
        );
        assert_eq!(last_transcript_cwd(&path).as_deref(), Some("C:\\repo\\wt"));
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn none_when_no_cwd_anywhere() {
        let path = write_tmp("nocwd", "{\"type\":\"mode\"}\n{\"type\":\"summary\"}\n");
        assert_eq!(last_transcript_cwd(&path), None);
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn ignores_empty_cwd_and_blank_lines() {
        let path = write_tmp(
            "empty",
            "{\"type\":\"user\",\"cwd\":\"C:\\\\repo\"}\n\n{\"type\":\"assistant\",\"cwd\":\"\"}\n",
        );
        assert_eq!(last_transcript_cwd(&path).as_deref(), Some("C:\\repo"));
        std::fs::remove_file(&path).ok();
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
