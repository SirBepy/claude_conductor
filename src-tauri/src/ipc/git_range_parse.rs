//! Lower-bound resolution and the name-status/numstat merge behind
//! `git_diff`'s `get_range_files`/`get_file_diff`: pure string/process logic,
//! no further dependency on `git_diff` beyond the `PrFileChange` return type.

use super::git_diff::PrFileChange;

/// Git empty-tree hash, used as the lower bound when the requested commit
/// has no parent (root commit).
const EMPTY_TREE_SHA: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

pub(super) fn resolve_lower_bound(cwd: &str, from: &Option<String>, to: &str) -> String {
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
pub(super) fn parse_range_files(name_status: &str, numstat: &str) -> Vec<PrFileChange> {
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
