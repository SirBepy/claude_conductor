//! PR range-diff subsystem: file-change listing and single-file diffs across a
//! commit range `(lower, to]`. Split out of `git.rs` to keep that module to
//! branch/repo/commit-sync/context-status concerns; self-contained beyond
//! spawning `git` via the shared `run_git` helper. Read-only branch-file
//! listing lives in the sibling `git_branch_preview` module.

// Glob, not a named `pub use`: a named re-export drops the hidden items
// `#[tauri::command]` generates, and `generate_handler!` plus the daemon's
// `pr_review.rs` both reach `list_branch_files` through this path.
pub use super::git_branch_preview::*;

mod option_guard;
mod worktree;

use tauri::State;

use super::git::run_git;
use super::git_range_parse::{parse_range_files, resolve_lower_bound};
use crate::state::AppState;

pub(in crate::ipc) use option_guard::reject_option_like;
use worktree::{count_lines, new_file_diff, read_worktree_bytes, untracked_files, worktree_base};

#[derive(Debug, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct PrFileChange {
    pub path: String,
    pub status: String,
    pub added: u32,
    pub removed: u32,
    pub old_path: Option<String>,
}

/// Returns the files changed in the range `(lower, to]`, where `lower` is the
/// parent of `from` if given, else the parent of `to`. Passing `from: None`
/// yields the files touched by the single commit `to`; passing `from: Some(oldest)`
/// yields the cumulative files touched across the whole range up to `to`.
///
/// `base`, when given, is used verbatim as the lower bound instead of the
/// `from`/`to`-derived one above - the branch-preview scope needs `HEAD`
/// itself as the exact lower bound (`HEAD..branch`), not `HEAD^`.
///
/// `to: None` diffs against the working tree instead (see `worktree_base`),
/// listing untracked files as added; `base` has no effect on that path.
///
/// `pub(crate)` pure local read, reused directly by the daemon's own
/// `get_range_files` RPC handler (`daemon/methods/pr_review.rs`) - see
/// `git::get_git_dirty_local`'s doc for why the Tauri-facing wrapper below is
/// split out from this one.
pub(crate) async fn get_range_files_local(cwd: String, from: Option<String>, to: Option<String>, base: Option<String>) -> Result<Vec<PrFileChange>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(t) = to.as_deref() { reject_option_like("to", t)?; }
        if let Some(f) = from.as_deref() { reject_option_like("from", f)?; }
        if let Some(b) = base.as_deref() { reject_option_like("base", b)?; }

        let Some(to) = to else {
            let wt_base = worktree_base(&from);
            let name_status = run_git(&cwd, &["diff", "--name-status", "-M", &wt_base, "--"])?;
            let numstat = run_git(&cwd, &["diff", "--numstat", "-M", &wt_base, "--"])?;
            let mut files = parse_range_files(&name_status, &numstat);
            for path in untracked_files(&cwd, None)? {
                if files.iter().any(|f| f.path == path) {
                    continue;
                }
                let added = read_worktree_bytes(&cwd, &path, 1_000_000).map(|(b, _)| count_lines(&b)).unwrap_or(0);
                files.push(PrFileChange { path, status: "A".to_string(), added, removed: 0, old_path: None });
            }
            return Ok(files);
        };

        let lower = base.unwrap_or_else(|| resolve_lower_bound(&cwd, &from, &to));

        let name_status = run_git(&cwd, &["diff", "--name-status", "-M", &lower, &to, "--"])?;
        let numstat = run_git(&cwd, &["diff", "--numstat", "-M", &lower, &to, "--"])?;

        Ok(parse_range_files(&name_status, &numstat))
    })
    .await
    .map_err(|e| format!("get_range_files join error: {e}"))?
}

/// Tauri-facing command: routes to the owning peer when `session_id`
/// resolves to a mirrored session (G10, docs/multi-machine.md), else runs
/// the same local read as before.
#[tauri::command]
pub async fn get_range_files(
    cwd: String,
    from: Option<String>,
    to: Option<String>,
    base: Option<String>,
    session_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<PrFileChange>, String> {
    get_range_files_routed(cwd, from, to, base, session_id, &state.cached_instances, state.client().await).await
}

/// `get_range_files` with its two inputs from `AppState` passed in, so a test
/// can drive the mirrored branch with a fake client.
async fn get_range_files_routed<C: crate::ipc::mirror::MirrorReads>(
    cwd: String,
    from: Option<String>,
    to: Option<String>,
    base: Option<String>,
    session_id: Option<String>,
    instances: &std::sync::Mutex<Vec<crate::types::Instance>>,
    client: Option<C>,
) -> Result<Vec<PrFileChange>, String> {
    if let Some(client) = crate::ipc::mirror::route_mirrored(instances, session_id.as_deref(), client) {
        let sid = session_id.as_deref().unwrap_or_default();
        return client
            .get_range_files(sid, &cwd, from.as_deref(), to.as_deref(), base.as_deref())
            .await
            .map_err(|e| e.to_string());
    }
    get_range_files_local(cwd, from, to, base).await
}

/// Returns the raw unified diff for a single file in the range `(lower, to]`,
/// with the same lower-bound resolution as `get_range_files`, including the
/// `base` exact-override. `context` is git's `-U<n>` (lines kept around each
/// change); a caller wanting the whole file passes a large one. Truncates at
/// a line boundary before 1MB with a trailing marker. `to: None` diffs
/// against the working tree, an untracked file coming back as an all-added
/// diff; `base` has no effect on that path.
///
/// `pub(crate)` pure local read - see `get_range_files_local`'s doc.
pub(crate) async fn get_file_diff_local(
    cwd: String,
    from: Option<String>,
    to: Option<String>,
    base: Option<String>,
    path: String,
    context: Option<u32>,
) -> Result<String, String> {
    const MAX_BYTES: usize = 1_000_000;

    tauri::async_runtime::spawn_blocking(move || {
        if let Some(t) = to.as_deref() { reject_option_like("to", t)?; }
        reject_option_like("path", &path)?;
        if let Some(f) = from.as_deref() { reject_option_like("from", f)?; }
        if let Some(b) = base.as_deref() { reject_option_like("base", b)?; }
        let unified = format!("-U{}", context.unwrap_or(3));

        let mut cmd = std::process::Command::new("git");
        cmd.arg("-C").arg(&cwd);
        match to.as_deref() {
            Some(to) => {
                let lower = base.unwrap_or_else(|| resolve_lower_bound(&cwd, &from, to));
                cmd.args(["diff", &unified, &lower, to, "--", &path]);
            }
            None => {
                if !untracked_files(&cwd, Some(&path))?.is_empty() {
                    let (bytes, _) = read_worktree_bytes(&cwd, &path, MAX_BYTES)?;
                    return Ok(new_file_diff(&path, &bytes));
                }
                cmd.args(["diff", &unified, &worktree_base(&from), "--", &path]);
            }
        }
        crate::util::process::hide_console(&mut cmd);
        let output = cmd.output().map_err(|e| format!("failed to run git: {e}"))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(if stderr.is_empty() { "git command failed".to_string() } else { stderr });
        }
        let text = String::from_utf8_lossy(&output.stdout).to_string();

        if text.len() <= MAX_BYTES {
            return Ok(text);
        }
        let mut cut = MAX_BYTES;
        while cut > 0 && !text.is_char_boundary(cut) {
            cut -= 1;
        }
        let truncated = match text[..cut].rfind('\n') {
            Some(idx) => &text[..idx],
            None => &text[..cut],
        };
        Ok(format!("{truncated}\n... (diff truncated)"))
    })
    .await
    .map_err(|e| format!("get_file_diff join error: {e}"))?
}

/// Tauri-facing command: routes to the owning peer when `session_id`
/// resolves to a mirrored session (G10, docs/multi-machine.md), else runs
/// the same local read as before.
#[tauri::command]
pub async fn get_file_diff(
    cwd: String,
    from: Option<String>,
    to: Option<String>,
    base: Option<String>,
    path: String,
    context: Option<u32>,
    session_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    get_file_diff_routed(cwd, from, to, base, path, context, session_id, &state.cached_instances, state.client().await).await
}

/// `get_file_diff` with its two inputs from `AppState` passed in, so a test can
/// drive the mirrored branch with a fake client.
async fn get_file_diff_routed<C: crate::ipc::mirror::MirrorReads>(
    cwd: String,
    from: Option<String>,
    to: Option<String>,
    base: Option<String>,
    path: String,
    context: Option<u32>,
    session_id: Option<String>,
    instances: &std::sync::Mutex<Vec<crate::types::Instance>>,
    client: Option<C>,
) -> Result<String, String> {
    if let Some(client) = crate::ipc::mirror::route_mirrored(instances, session_id.as_deref(), client) {
        let sid = session_id.as_deref().unwrap_or_default();
        return client
            .get_file_diff(sid, &cwd, from.as_deref(), to.as_deref(), base.as_deref(), &path, context)
            .await
            .map_err(|e| e.to_string());
    }
    get_file_diff_local(cwd, from, to, base, path, context).await
}

/// A file's content as of revision `rev` (`git show <rev>:<path>`), for the
/// file view of a past commit, where the working tree would show the wrong
/// version. `rev: None` reads the working-tree copy from disk, confined to
/// the repo. Capped like `read_text_file`, lossy UTF-8.
///
/// `pub(crate)` pure local read - see `get_range_files_local`'s doc.
pub(crate) async fn get_file_at_rev_local(cwd: String, rev: Option<String>, path: String) -> Result<crate::ipc::files::TextFileData, String> {
    const MAX_BYTES: usize = 2 * 1024 * 1024;

    tauri::async_runtime::spawn_blocking(move || {
        reject_option_like("path", &path)?;
        let Some(rev) = rev else {
            let (bytes, truncated) = read_worktree_bytes(&cwd, &path, MAX_BYTES)?;
            return Ok(crate::ipc::files::TextFileData { content: String::from_utf8_lossy(&bytes).into_owned(), truncated });
        };
        reject_option_like("rev", &rev)?;
        let mut cmd = std::process::Command::new("git");
        cmd.arg("-C").arg(&cwd).args(["show", &format!("{rev}:{path}")]);
        crate::util::process::hide_console(&mut cmd);
        let output = cmd.output().map_err(|e| format!("failed to run git: {e}"))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(if stderr.is_empty() { "git command failed".to_string() } else { stderr });
        }
        let truncated = output.stdout.len() > MAX_BYTES;
        let bytes = if truncated { &output.stdout[..MAX_BYTES] } else { &output.stdout[..] };
        Ok(crate::ipc::files::TextFileData { content: String::from_utf8_lossy(bytes).into_owned(), truncated })
    })
    .await
    .map_err(|e| format!("get_file_at_rev join error: {e}"))?
}

/// Tauri-facing command: routes to the owning peer when `session_id`
/// resolves to a mirrored session (G10, docs/multi-machine.md), else runs
/// the same local read as before.
#[tauri::command]
pub async fn get_file_at_rev(
    cwd: String,
    rev: Option<String>,
    path: String,
    session_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<crate::ipc::files::TextFileData, String> {
    get_file_at_rev_routed(cwd, rev, path, session_id, &state.cached_instances, state.client().await).await
}

/// `get_file_at_rev` with its two inputs from `AppState` passed in, so a test
/// can drive the mirrored branch with a fake client.
async fn get_file_at_rev_routed<C: crate::ipc::mirror::MirrorReads>(
    cwd: String,
    rev: Option<String>,
    path: String,
    session_id: Option<String>,
    instances: &std::sync::Mutex<Vec<crate::types::Instance>>,
    client: Option<C>,
) -> Result<crate::ipc::files::TextFileData, String> {
    if let Some(client) = crate::ipc::mirror::route_mirrored(instances, session_id.as_deref(), client) {
        let sid = session_id.as_deref().unwrap_or_default();
        return client.get_file_at_rev(sid, &cwd, rev.as_deref(), &path).await.map_err(|e| e.to_string());
    }
    get_file_at_rev_local(cwd, rev, path).await
}

#[cfg(test)]
mod mirrored_branch_tests {
    use super::*;
    use crate::ipc::mirror::fake::{instance_cache, FakeMirror, PEER_CONTENT, PEER_DIFF, PEER_FILE};

    #[tokio::test]
    async fn a_mirrored_row_reads_the_range_files_through_the_client_by_session_id() {
        let fake = FakeMirror::ok();
        let cache = instance_cache("local-1", "mirror-1");

        let files = get_range_files_routed(
            "C:/peer/repo".into(),
            Some("aaa".into()),
            Some("bbb".into()),
            None,
            Some("mirror-1".into()),
            &cache,
            Some(fake.clone()),
        )
        .await
        .unwrap();

        assert_eq!(files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), [PEER_FILE]);
        assert_eq!(
            fake.calls(),
            [("get_range_files".into(), "mirror-1".into(), "C:/peer/repo|Some(\"aaa\")|Some(\"bbb\")|None".into())]
        );
    }

    #[tokio::test]
    async fn a_client_error_fails_the_range_files_read() {
        let fake = FakeMirror::failing();
        let cache = instance_cache("local-1", "mirror-1");

        let err = get_range_files_routed("C:/peer/repo".into(), None, None, None, Some("mirror-1".into()), &cache, Some(fake.clone()))
            .await
            .unwrap_err();

        assert!(err.contains("peer unreachable"), "got: {err}");
    }

    #[tokio::test]
    async fn a_mirrored_row_reads_the_file_diff_through_the_client_by_session_id() {
        let fake = FakeMirror::ok();
        let cache = instance_cache("local-1", "mirror-1");

        let diff = get_file_diff_routed(
            "C:/peer/repo".into(),
            None,
            Some("bbb".into()),
            Some("HEAD".into()),
            "src/a.rs".into(),
            Some(9),
            Some("mirror-1".into()),
            &cache,
            Some(fake.clone()),
        )
        .await
        .unwrap();

        assert_eq!(diff, PEER_DIFF);
        assert_eq!(
            fake.calls(),
            [("get_file_diff".into(), "mirror-1".into(), "C:/peer/repo|None|Some(\"bbb\")|Some(\"HEAD\")|src/a.rs|Some(9)".into())]
        );
    }

    #[tokio::test]
    async fn a_client_error_fails_the_file_diff_read() {
        let fake = FakeMirror::failing();
        let cache = instance_cache("local-1", "mirror-1");

        let err = get_file_diff_routed(
            "C:/peer/repo".into(),
            None,
            None,
            None,
            "src/a.rs".into(),
            None,
            Some("mirror-1".into()),
            &cache,
            Some(fake.clone()),
        )
        .await
        .unwrap_err();

        assert!(err.contains("peer unreachable"), "got: {err}");
    }

    #[tokio::test]
    async fn a_mirrored_row_reads_the_file_at_a_rev_through_the_client_by_session_id() {
        let fake = FakeMirror::ok();
        let cache = instance_cache("local-1", "mirror-1");

        let data = get_file_at_rev_routed(
            "C:/peer/repo".into(),
            Some("abc".into()),
            "src/a.rs".into(),
            Some("mirror-1".into()),
            &cache,
            Some(fake.clone()),
        )
        .await
        .unwrap();

        assert_eq!(data.content, PEER_CONTENT);
        assert_eq!(
            fake.calls(),
            [("get_file_at_rev".into(), "mirror-1".into(), "C:/peer/repo|Some(\"abc\")|src/a.rs".into())]
        );
    }

    #[tokio::test]
    async fn a_client_error_fails_the_file_at_rev_read() {
        let fake = FakeMirror::failing();
        let cache = instance_cache("local-1", "mirror-1");

        let err = get_file_at_rev_routed("C:/peer/repo".into(), None, "src/a.rs".into(), Some("mirror-1".into()), &cache, Some(fake.clone()))
            .await
            .map(|d| d.content)
            .unwrap_err();

        assert!(err.contains("peer unreachable"), "got: {err}");
    }
}

#[cfg(test)]
mod rev_tests {
    use super::*;

    // Repo root, not the test's src-tauri cwd: diff pathspecs are cwd-relative.
    fn cwd() -> String {
        let here = std::env::current_dir().unwrap().to_string_lossy().to_string();
        run_git(&here, &["rev-parse", "--show-toplevel"]).unwrap()
    }

    #[tokio::test]
    async fn file_at_rev_reads_the_committed_blob() {
        let data = get_file_at_rev_local(cwd(), Some("HEAD".into()), "package.json".into()).await.unwrap();
        assert!(data.content.contains("\"name\""));
        assert!(!data.truncated);
    }

    #[tokio::test]
    async fn file_at_rev_refuses_option_like_input() {
        assert!(get_file_at_rev_local(cwd(), Some("--output=x".into()), "a".into()).await.is_err());
        assert!(get_file_at_rev_local(cwd(), Some("HEAD".into()), "-x".into()).await.is_err());
        assert!(get_file_at_rev_local(cwd(), None, "-x".into()).await.is_err());
    }

    #[tokio::test]
    async fn a_large_context_keeps_every_line_of_the_file() {
        // A throwaway repo, not this one's history: CI's test job checks out
        // depth 1, so no older commit sha resolves there.
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().to_string_lossy().to_string();
        let git = |args: &[&str]| run_git(&repo, args).unwrap();
        git(&["init", "-q"]);
        git(&["config", "user.email", "test@example.com"]);
        git(&["config", "user.name", "test"]);
        let lines: Vec<String> = (0..200).map(|i| format!("line {i}")).collect();
        std::fs::write(dir.path().join("big.txt"), lines.join("\n")).unwrap();
        git(&["add", "big.txt"]);
        git(&["commit", "-q", "-m", "base"]);
        let mut edited = lines.clone();
        edited[100] = "changed".into();
        std::fs::write(dir.path().join("big.txt"), edited.join("\n")).unwrap();
        git(&["commit", "-q", "-am", "edit"]);

        // One changed line: full context carries the whole file, -U3 only ~7 lines.
        let path = "big.txt".to_string();
        let full = get_file_diff_local(repo.clone(), None, Some("HEAD".into()), None, path.clone(), Some(1_000_000)).await.unwrap();
        let short = get_file_diff_local(repo, None, Some("HEAD".into()), None, path, None).await.unwrap();
        assert!(full.lines().count() > short.lines().count() + 50, "full {} vs short {}", full.lines().count(), short.lines().count());
    }

    // One commit, then one modified tracked file and one untracked file: the
    // shapes a working-tree scope has to show.
    fn worktree_repo() -> (tempfile::TempDir, String) {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().to_string_lossy().to_string();
        let git = |args: &[&str]| run_git(&repo, args).unwrap();
        git(&["init", "-q"]);
        git(&["config", "user.email", "test@example.com"]);
        git(&["config", "user.name", "test"]);
        std::fs::write(dir.path().join("tracked.txt"), "one\ntwo\n").unwrap();
        git(&["add", "tracked.txt"]);
        git(&["commit", "-q", "-m", "base"]);
        std::fs::write(dir.path().join("tracked.txt"), "one\nTWO\n").unwrap();
        std::fs::create_dir(dir.path().join("sub")).unwrap();
        std::fs::write(dir.path().join("sub/new.txt"), "a\nb\nc\n").unwrap();
        (dir, repo)
    }

    #[tokio::test]
    async fn worktree_range_lists_modified_and_untracked_files() {
        let (_dir, repo) = worktree_repo();
        let files = get_range_files_local(repo, None, None, None).await.unwrap();
        let tracked = files.iter().find(|f| f.path == "tracked.txt").expect("modified file listed");
        assert_eq!((tracked.status.as_str(), tracked.added, tracked.removed), ("M", 1, 1));
        let new = files.iter().find(|f| f.path == "sub/new.txt").expect("untracked file listed");
        assert_eq!((new.status.as_str(), new.added), ("A", 3));
    }

    #[tokio::test]
    async fn worktree_diff_covers_tracked_and_untracked_files() {
        let (_dir, repo) = worktree_repo();
        let tracked = get_file_diff_local(repo.clone(), None, None, None, "tracked.txt".into(), None).await.unwrap();
        assert!(tracked.contains("-two") && tracked.contains("+TWO"), "{tracked}");
        let new = get_file_diff_local(repo, None, None, None, "sub/new.txt".into(), None).await.unwrap();
        assert!(new.contains("@@ -0,0 +1,3 @@") && new.contains("+c"), "{new}");
    }

    #[tokio::test]
    async fn worktree_file_reads_disk_but_never_outside_the_repo() {
        let (dir, repo) = worktree_repo();
        let data = get_file_at_rev_local(repo.clone(), None, "tracked.txt".into()).await.unwrap();
        assert_eq!(data.content.replace("\r\n", "\n"), "one\nTWO\n");
        let outside = tempfile::NamedTempFile::new_in(dir.path().parent().unwrap()).unwrap();
        let rel = format!("../{}", outside.path().file_name().unwrap().to_string_lossy());
        let Err(err) = get_file_at_rev_local(repo, None, rel).await else { panic!("read a file outside the repo") };
        assert!(err.contains("outside the repository"), "{err}");
    }
}
