//! PR range-diff subsystem: file-change listing and single-file diffs across a
//! commit range `(lower, to]`. Split out of `git.rs` to keep that module to
//! branch/repo/commit-sync/context-status concerns; self-contained beyond
//! spawning `git` via the shared `run_git` helper.

use super::git::run_git;

/// Git empty-tree hash, used as the lower bound when the requested commit
/// has no parent (root commit).
const EMPTY_TREE_SHA: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

#[derive(serde::Serialize, ts_rs::TS)]
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

/// Returns the files changed in the range `(lower, to]`, where `lower` is the
/// parent of `from` if given, else the parent of `to`. Passing `from: None`
/// yields the files touched by the single commit `to`; passing `from: Some(oldest)`
/// yields the cumulative files touched across the whole range up to `to`.
#[tauri::command]
pub async fn get_range_files(cwd: String, from: Option<String>, to: String) -> Result<Vec<PrFileChange>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        reject_option_like("to", &to)?;
        if let Some(f) = from.as_deref() { reject_option_like("from", f)?; }
        let lower = resolve_lower_bound(&cwd, &from, &to);

        let name_status = run_git(&cwd, &["diff", "--name-status", "-M", &lower, &to, "--"])?;
        let numstat = run_git(&cwd, &["diff", "--numstat", "-M", &lower, &to, "--"])?;

        Ok(parse_range_files(&name_status, &numstat))
    })
    .await
    .map_err(|e| format!("get_range_files join error: {e}"))?
}

/// Returns the raw unified diff for a single file in the range `(lower, to]`,
/// with the same lower-bound resolution as `get_range_files`. `context` is
/// git's `-U<n>` (lines kept around each change); a caller wanting the whole
/// file passes a large one. Truncates at a line boundary before 1MB with a
/// trailing marker.
#[tauri::command]
pub async fn get_file_diff(
    cwd: String,
    from: Option<String>,
    to: String,
    path: String,
    context: Option<u32>,
) -> Result<String, String> {
    const MAX_BYTES: usize = 1_000_000;

    tauri::async_runtime::spawn_blocking(move || {
        reject_option_like("to", &to)?;
        reject_option_like("path", &path)?;
        if let Some(f) = from.as_deref() { reject_option_like("from", f)?; }
        let lower = resolve_lower_bound(&cwd, &from, &to);
        let unified = format!("-U{}", context.unwrap_or(3));

        let mut cmd = std::process::Command::new("git");
        cmd.arg("-C").arg(&cwd).args(["diff", &unified, &lower, &to, "--", &path]);
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
/// version. Capped like `read_text_file`, lossy UTF-8.
#[tauri::command]
pub async fn get_file_at_rev(cwd: String, rev: String, path: String) -> Result<crate::ipc::files::TextFileData, String> {
    const MAX_BYTES: usize = 2 * 1024 * 1024;

    tauri::async_runtime::spawn_blocking(move || {
        reject_option_like("rev", &rev)?;
        reject_option_like("path", &path)?;
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
        let data = get_file_at_rev(cwd(), "HEAD".into(), "package.json".into()).await.unwrap();
        assert!(data.content.contains("\"name\""));
        assert!(!data.truncated);
    }

    #[tokio::test]
    async fn file_at_rev_refuses_option_like_input() {
        assert!(get_file_at_rev(cwd(), "--output=x".into(), "a".into()).await.is_err());
        assert!(get_file_at_rev(cwd(), "HEAD".into(), "-x".into()).await.is_err());
    }

    #[tokio::test]
    async fn a_large_context_keeps_every_line_of_the_file() {
        // 469a502f changes 5 lines of project-detail.ts; with full context
        // the diff carries the whole file, far more lines than -U3 does.
        let path = "src/views/project-detail/project-detail.ts".to_string();
        let full = get_file_diff(cwd(), None, "469a502f".into(), path.clone(), Some(1_000_000)).await.unwrap();
        let short = get_file_diff(cwd(), None, "469a502f".into(), path, None).await.unwrap();
        assert!(full.lines().count() > short.lines().count() + 50, "full {} vs short {}", full.lines().count(), short.lines().count());
    }
}
