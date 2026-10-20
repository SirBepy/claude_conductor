//! Working-tree side of the range diffs: untracked files and on-disk reads.

use crate::ipc::git::run_git;

/// The base a working-tree diff compares against: `from` itself (default
/// `HEAD`), not its parent - `git diff <from> --` - so `from: "@{u}"` means
/// everything not on the upstream yet, committed or not.
pub(super) fn worktree_base(from: &Option<String>) -> String {
    from.clone().unwrap_or_else(|| "HEAD".to_string())
}

/// Untracked, not-ignored files, repo-root relative like `git diff`'s own
/// output. `git diff <rev>` never lists them, but a brand new file is exactly
/// what a working-tree scope exists to show.
pub(super) fn untracked_files(cwd: &str, path: Option<&str>) -> Result<Vec<String>, String> {
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
pub(super) fn read_worktree_bytes(cwd: &str, path: &str, cap: usize) -> Result<(Vec<u8>, bool), String> {
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
pub(super) fn new_file_diff(path: &str, bytes: &[u8]) -> String {
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

pub(super) fn count_lines(bytes: &[u8]) -> u32 {
    if looks_binary(bytes) {
        return 0;
    }
    String::from_utf8_lossy(bytes).lines().count() as u32
}
