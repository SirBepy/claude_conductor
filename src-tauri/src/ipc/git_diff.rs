//! PR range-diff subsystem: file-change listing and single-file diffs across a
//! commit range `(lower, to]`. Split out of `git.rs` to keep that module to
//! branch/repo/commit-sync/context-status concerns; self-contained beyond
//! spawning `git` via the shared `run_git` helper. Read-only branch-file
//! listing lives in the sibling `git_branch_preview` module.

// Glob, not a named `pub use`: a named re-export drops the hidden items
// `#[tauri::command]` generates, and `generate_handler!` plus the daemon's
// `pr_review.rs` both reach `list_branch_files` through this path.
pub use super::git_branch_preview::*;

use super::git::run_git;
use super::git_range_parse::{parse_range_files, resolve_lower_bound};

#[derive(Debug, serde::Serialize, ts_rs::TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct PrFileChange {
    pub path: String,
    pub status: String,
    pub added: u32,
    pub removed: u32,
    pub old_path: Option<String>,
}

/// Resolves the lower bound of a `(lower, to]` range: the parent of `from` if
/// given, else the parent of `to`. Falls back to the git empty-tree hash when
/// the target commit has no parent (root commit).
/// Refuses a revision/pathspec that git would read as an option. `git diff`
/// accepts `--output=<file>`, so an unchecked `to` is an arbitrary-file-write
/// primitive for anything that can reach these commands - and `get_range_files`
/// / `get_file_diff` are both phone-reachable (`remote_transport_table.rs`).
/// A real revision or path never starts with `-`.
pub(super) fn reject_option_like(label: &str, value: &str) -> Result<(), String> {
    if value.starts_with('-') {
        return Err(format!("invalid {label}: must not start with '-'"));
    }
    Ok(())
}

#[cfg(test)]
mod option_guard_tests {
    use super::reject_option_like;

    #[test]
    fn plain_revisions_and_paths_pass() {
        for v in ["HEAD", "main", "abc1234", "src/main.rs", "a b/c.txt", ""] {
            assert!(reject_option_like("to", v).is_ok(), "rejected {v:?}");
        }
    }

    #[test]
    fn a_leading_dash_is_refused() {
        // `git diff --output=<file>` writes the diff wherever it is pointed, so
        // this is the difference between a read and an arbitrary file write.
        for v in ["--output=C:/Users/x/startup.bat", "-o", "--no-index", "-"] {
            assert!(reject_option_like("to", v).is_err(), "accepted {v:?}");
        }
    }

    #[test]
    fn the_error_names_which_argument_was_bad() {
        let err = reject_option_like("from", "--output=x").unwrap_err();
        assert!(err.contains("from"), "{err}");
    }
}

/// The base a working-tree diff compares against: `from` itself (default
/// `HEAD`), not its parent - `git diff <from> --` - so `from: "@{u}"` means
/// everything not on the upstream yet, committed or not.
fn worktree_base(from: &Option<String>) -> String {
    from.clone().unwrap_or_else(|| "HEAD".to_string())
}

/// Untracked, not-ignored files, repo-root relative like `git diff`'s own
/// output. `git diff <rev>` never lists them, but a brand new file is exactly
/// what a working-tree scope exists to show.
fn untracked_files(cwd: &str, path: Option<&str>) -> Result<Vec<String>, String> {
    let mut args = vec!["ls-files", "--others", "--exclude-standard", "--full-name", "-z"];
    if let Some(p) = path {
        args.extend(["--", p]);
    }
    let out = run_git(cwd, &args)?;
    Ok(out.split('\0').filter(|s| !s.is_empty()).map(str::to_string).collect())
}

/// Reads a repo-root-relative path from disk, refusing anything that resolves
/// outside the repo (`..`, an absolute path, a symlink out): these commands are
/// phone-reachable, and only the repo's own files are in scope.
fn read_worktree_bytes(cwd: &str, path: &str, cap: usize) -> Result<(Vec<u8>, bool), String> {
    let top = run_git(cwd, &["rev-parse", "--show-toplevel"])?;
    let full = crate::util::path::confine(std::path::Path::new(&top), path).map_err(|e| {
        if e.ends_with(crate::util::path::OUTSIDE_ROOT) {
            format!("{path}: outside the repository")
        } else {
            e
        }
    })?;
    let mut bytes = std::fs::read(&full).map_err(|e| format!("{path}: {e}"))?;
    let truncated = bytes.len() > cap;
    bytes.truncate(cap);
    Ok((bytes, truncated))
}

/// A NUL in the first 8KB is git's own binary heuristic.
fn looks_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(8000).any(|&b| b == 0)
}

/// The unified diff `git diff --no-index /dev/null <path>` would print for an
/// untracked file, built in-process: `/dev/null` is not a path on Windows.
fn new_file_diff(path: &str, bytes: &[u8]) -> String {
    let header = format!("diff --git a/{path} b/{path}\nnew file mode 100644\n--- /dev/null\n+++ b/{path}\n");
    if looks_binary(bytes) {
        return format!("{header}Binary files /dev/null and b/{path} differ\n");
    }
    let text = String::from_utf8_lossy(bytes);
    let lines: Vec<&str> = text.lines().collect();
    let mut out = format!("{header}@@ -0,0 +1,{} @@\n", lines.len());
    for l in &lines {
        out.push('+');
        out.push_str(l);
        out.push('\n');
    }
    out
}

fn count_lines(bytes: &[u8]) -> u32 {
    if looks_binary(bytes) {
        return 0;
    }
    String::from_utf8_lossy(bytes).lines().count() as u32
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
#[tauri::command]
pub async fn get_range_files(cwd: String, from: Option<String>, to: Option<String>, base: Option<String>) -> Result<Vec<PrFileChange>, String> {
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

/// Returns the raw unified diff for a single file in the range `(lower, to]`,
/// with the same lower-bound resolution as `get_range_files`, including the
/// `base` exact-override. `context` is git's `-U<n>` (lines kept around each
/// change); a caller wanting the whole file passes a large one. Truncates at
/// a line boundary before 1MB with a trailing marker. `to: None` diffs
/// against the working tree, an untracked file coming back as an all-added
/// diff; `base` has no effect on that path.
#[tauri::command]
pub async fn get_file_diff(
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

/// A file's content as of revision `rev` (`git show <rev>:<path>`), for the
/// file view of a past commit, where the working tree would show the wrong
/// version. `rev: None` reads the working-tree copy from disk, confined to
/// the repo. Capped like `read_text_file`, lossy UTF-8.
#[tauri::command]
pub async fn get_file_at_rev(cwd: String, rev: Option<String>, path: String) -> Result<crate::ipc::files::TextFileData, String> {
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
        let data = get_file_at_rev(cwd(), Some("HEAD".into()), "package.json".into()).await.unwrap();
        assert!(data.content.contains("\"name\""));
        assert!(!data.truncated);
    }

    #[tokio::test]
    async fn file_at_rev_refuses_option_like_input() {
        assert!(get_file_at_rev(cwd(), Some("--output=x".into()), "a".into()).await.is_err());
        assert!(get_file_at_rev(cwd(), Some("HEAD".into()), "-x".into()).await.is_err());
        assert!(get_file_at_rev(cwd(), None, "-x".into()).await.is_err());
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
        let full = get_file_diff(repo.clone(), None, Some("HEAD".into()), None, path.clone(), Some(1_000_000)).await.unwrap();
        let short = get_file_diff(repo, None, Some("HEAD".into()), None, path, None).await.unwrap();
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
        let files = get_range_files(repo, None, None, None).await.unwrap();
        let tracked = files.iter().find(|f| f.path == "tracked.txt").expect("modified file listed");
        assert_eq!((tracked.status.as_str(), tracked.added, tracked.removed), ("M", 1, 1));
        let new = files.iter().find(|f| f.path == "sub/new.txt").expect("untracked file listed");
        assert_eq!((new.status.as_str(), new.added), ("A", 3));
    }

    #[tokio::test]
    async fn worktree_diff_covers_tracked_and_untracked_files() {
        let (_dir, repo) = worktree_repo();
        let tracked = get_file_diff(repo.clone(), None, None, None, "tracked.txt".into(), None).await.unwrap();
        assert!(tracked.contains("-two") && tracked.contains("+TWO"), "{tracked}");
        let new = get_file_diff(repo, None, None, None, "sub/new.txt".into(), None).await.unwrap();
        assert!(new.contains("@@ -0,0 +1,3 @@") && new.contains("+c"), "{new}");
    }

    #[tokio::test]
    async fn worktree_file_reads_disk_but_never_outside_the_repo() {
        let (dir, repo) = worktree_repo();
        let data = get_file_at_rev(repo.clone(), None, "tracked.txt".into()).await.unwrap();
        assert_eq!(data.content.replace("\r\n", "\n"), "one\nTWO\n");
        let outside = tempfile::NamedTempFile::new_in(dir.path().parent().unwrap()).unwrap();
        let rel = format!("../{}", outside.path().file_name().unwrap().to_string_lossy());
        let Err(err) = get_file_at_rev(repo, None, rel).await else { panic!("read a file outside the repo") };
        assert!(err.contains("outside the repository"), "{err}");
    }
}
