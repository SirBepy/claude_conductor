//! PR range-diff subsystem: file-change listing and single-file diffs across a
//! commit range `(lower, to]`. Split out of `git.rs` to keep that module to
//! branch/repo/commit-sync/context-status concerns; self-contained beyond
//! spawning `git` via the shared `run_git` helper.

use super::git::run_git;

/// Git empty-tree hash, used as the lower bound when the requested commit
/// has no parent (root commit).
const EMPTY_TREE_SHA: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

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
fn reject_option_like(label: &str, value: &str) -> Result<(), String> {
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

fn resolve_lower_bound(cwd: &str, from: &Option<String>, to: &str) -> String {
    let target = from.as_deref().unwrap_or(to);
    let mut cmd = std::process::Command::new("git");
    cmd.arg("-C").arg(cwd).args(["rev-parse", &format!("{target}^")]);
    crate::util::process::hide_console(&mut cmd);
    cmd.output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| EMPTY_TREE_SHA.to_string())
}

/// Expands a rename path as it appears in `--numstat` output, which can be
/// either the plain arrow form (`old => new`) or the brace-shortened form
/// (`prefix{old => new}suffix`). Returns the resolved new path.
fn resolve_numstat_new_path(raw: &str) -> String {
    if let Some(brace_start) = raw.find('{') {
        if let Some(brace_end) = raw[brace_start..].find('}') {
            let brace_end = brace_start + brace_end;
            let prefix = &raw[..brace_start];
            let suffix = &raw[brace_end + 1..];
            let inner = &raw[brace_start + 1..brace_end];
            if let Some((_old, new)) = inner.split_once(" => ") {
                return format!("{prefix}{new}{suffix}");
            }
            return raw.to_string();
        }
    }
    if let Some((_old, new)) = raw.split_once(" => ") {
        return new.to_string();
    }
    raw.to_string()
}

/// Merges `git diff --name-status -M` and `git diff --numstat -M` output for
/// the same range into a single list of file changes. name-status supplies
/// status + rename old/new paths; numstat supplies added/removed counts
/// (`-`/`-` for binary files, treated as 0/0). Joined by the new path; if a
/// numstat line can't be resolved to a known path, the file is kept with
/// zeroed counts rather than dropped.
fn parse_range_files(name_status: &str, numstat: &str) -> Vec<PrFileChange> {
    let mut entries: Vec<PrFileChange> = Vec::new();

    for line in name_status.lines() {
        let mut parts = line.splitn(2, '\t');
        let raw_status = match parts.next() {
            Some(s) if !s.is_empty() => s,
            _ => continue,
        };
        let rest = match parts.next() {
            Some(r) => r,
            None => continue,
        };
        let status = raw_status.chars().next().unwrap_or('M').to_string();

        if raw_status.starts_with('R') {
            let mut fields = rest.splitn(2, '\t');
            let old_path = fields.next().unwrap_or_default().to_string();
            let path = fields.next().unwrap_or_default().to_string();
            if path.is_empty() {
                continue;
            }
            entries.push(PrFileChange { path, status, added: 0, removed: 0, old_path: Some(old_path) });
        } else {
            if rest.is_empty() {
                continue;
            }
            entries.push(PrFileChange { path: rest.to_string(), status, added: 0, removed: 0, old_path: None });
        }
    }

    for line in numstat.lines() {
        let mut parts = line.splitn(3, '\t');
        let added = match parts.next() {
            Some(s) => s,
            None => continue,
        };
        let removed = match parts.next() {
            Some(s) => s,
            None => continue,
        };
        let name_field = match parts.next() {
            Some(s) => s,
            None => continue,
        };

        let added: u32 = added.parse().unwrap_or(0);
        let removed: u32 = removed.parse().unwrap_or(0);
        let new_path = resolve_numstat_new_path(name_field);

        if let Some(entry) = entries.iter_mut().find(|e| e.path == new_path) {
            entry.added = added;
            entry.removed = removed;
        } else if !new_path.is_empty() {
            // No matching name-status line (shouldn't normally happen since both
            // commands cover the same range) - keep the file rather than drop it.
            entries.push(PrFileChange {
                path: new_path,
                status: "M".to_string(),
                added,
                removed,
                old_path: None,
            });
        }
    }

    entries
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

#[cfg(test)]
mod range_files_tests {
    use super::parse_range_files;

    #[test]
    fn normal_modify_add_delete() {
        let name_status = "M\tsrc/a.rs\nA\tsrc/b.rs\nD\tsrc/c.rs";
        let numstat = "3\t1\tsrc/a.rs\n10\t0\tsrc/b.rs\n0\t5\tsrc/c.rs";
        let files = parse_range_files(name_status, numstat);
        assert_eq!(files.len(), 3);

        let a = files.iter().find(|f| f.path == "src/a.rs").unwrap();
        assert_eq!(a.status, "M");
        assert_eq!(a.added, 3);
        assert_eq!(a.removed, 1);
        assert_eq!(a.old_path, None);

        let b = files.iter().find(|f| f.path == "src/b.rs").unwrap();
        assert_eq!(b.status, "A");
        assert_eq!(b.added, 10);
        assert_eq!(b.removed, 0);

        let c = files.iter().find(|f| f.path == "src/c.rs").unwrap();
        assert_eq!(c.status, "D");
        assert_eq!(c.added, 0);
        assert_eq!(c.removed, 5);
    }

    #[test]
    fn rename_with_counts_plain_arrow() {
        let name_status = "R100\told/name.rs\tnew/name.rs";
        let numstat = "2\t2\told/name.rs => new/name.rs";
        let files = parse_range_files(name_status, numstat);
        assert_eq!(files.len(), 1);
        let f = &files[0];
        assert_eq!(f.path, "new/name.rs");
        assert_eq!(f.status, "R");
        assert_eq!(f.old_path.as_deref(), Some("old/name.rs"));
        assert_eq!(f.added, 2);
        assert_eq!(f.removed, 2);
    }

    #[test]
    fn binary_file_counts_are_zero() {
        let name_status = "M\tassets/logo.png";
        let numstat = "-\t-\tassets/logo.png";
        let files = parse_range_files(name_status, numstat);
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].added, 0);
        assert_eq!(files[0].removed, 0);
    }

    #[test]
    fn rename_with_brace_form_path() {
        let name_status = "R095\tsrc/old_dir/file.rs\tsrc/new_dir/file.rs";
        let numstat = "4\t1\tsrc/{old_dir => new_dir}/file.rs";
        let files = parse_range_files(name_status, numstat);
        assert_eq!(files.len(), 1);
        let f = &files[0];
        assert_eq!(f.path, "src/new_dir/file.rs");
        assert_eq!(f.status, "R");
        assert_eq!(f.old_path.as_deref(), Some("src/old_dir/file.rs"));
        assert_eq!(f.added, 4);
        assert_eq!(f.removed, 1);
    }
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

/// Repo-relative file list for `<branch>` without checking it out, for the
/// read-only branch-preview scope: `git ls-tree -r --name-only -z
/// --end-of-options <branch>`. `--end-of-options` (git's own
/// end-of-option-parsing marker) plus `reject_option_like` below both exist
/// so a crafted branch name can never be read as a git flag - this is
/// phone-reachable, same concern as `get_range_files`/`get_file_at_rev` above.
#[tauri::command]
pub async fn list_branch_files(cwd: String, branch: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        reject_option_like("branch", &branch)?;
        let out = run_git(&cwd, &["ls-tree", "-r", "--name-only", "-z", "--end-of-options", &branch])?;
        Ok(out.split('\0').filter(|s| !s.is_empty()).map(str::to_string).collect())
    })
    .await
    .map_err(|e| format!("list_branch_files join error: {e}"))?
}

#[cfg(test)]
mod branch_files_tests {
    use super::*;

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

        let files = list_branch_files(repo.clone(), "feature".into()).await.unwrap();
        assert!(files.contains(&"feature.txt".to_string()), "{files:?}");
        assert!(files.contains(&"base.txt".to_string()), "{files:?}");

        assert_eq!(run_git(&repo, &["rev-parse", "HEAD"]).unwrap(), head_before, "HEAD moved");
        assert_eq!(run_git(&repo, &["status", "--porcelain"]).unwrap(), status_before, "working tree changed");
        assert_eq!(run_git(&repo, &["branch", "--show-current"]).unwrap(), base_branch, "branch changed");
    }

    #[tokio::test]
    async fn rejects_a_dash_prefixed_branch_name() {
        let (_dir, repo, _base) = two_branch_repo();
        let err = list_branch_files(repo, "--output=x".into()).await.unwrap_err();
        assert!(err.contains("branch"), "{err}");
    }

    #[tokio::test]
    async fn range_files_with_base_diffs_head_to_branch_not_the_worktree() {
        let (dir, repo, _base) = two_branch_repo();
        // Dirtying the checked-out branch's worktree must not leak into a
        // base=HEAD..feature diff: both ends are already pinned commits.
        std::fs::write(dir.path().join("base.txt"), "base\nuncommitted-edit\n").unwrap();

        let files = get_range_files(repo, None, Some("feature".into()), Some("HEAD".into())).await.unwrap();
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

        let diff = get_file_diff(repo, None, Some("feature".into()), Some("HEAD".into()), "base.txt".into(), None)
            .await
            .unwrap();
        assert!(diff.contains("+feature-added-line"), "{diff}");
        assert!(!diff.contains("uncommitted-edit"), "{diff}");
    }

    #[tokio::test]
    async fn rejects_a_dash_prefixed_base() {
        let (_dir, repo, _base) = two_branch_repo();
        let err = get_range_files(repo, None, Some("feature".into()), Some("--output=x".into())).await.unwrap_err();
        assert!(err.contains("base"), "{err}");
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
