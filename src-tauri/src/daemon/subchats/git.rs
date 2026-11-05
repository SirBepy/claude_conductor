//! Git and transcript reads behind `finish_subchat`'s "files this sub itself
//! edited are uncommitted" refusal. The tree is shared with peer chats, so a
//! plain dirty check would refuse over somebody else's work; the sub's own
//! edits come from its transcript instead (memory
//! `project_concurrent_autopilot_on_master`).

use std::path::Path;

/// Tools whose `input` names a file the sub wrote. `Bash` writes (`sed -i`,
/// redirects) are invisible here on purpose: parsing shell for writes would be a
/// guess, and the spec scopes "itself" to these inputs.
pub(super) const EDIT_TOOLS: [&str; 4] = ["Edit", "Write", "NotebookEdit", "MultiEdit"];

/// Blocking git run with the console hidden on Windows. `None` when git could
/// not be started at all; `(success, raw stdout)` otherwise.
pub(super) fn run_git(cwd: &Path, args: &[&str]) -> Option<(bool, Vec<u8>)> {
    let mut cmd = std::process::Command::new("git");
    cmd.arg("-C").arg(cwd).args(args);
    crate::util::process::hide_console(&mut cmd);
    let out = cmd.output().ok()?;
    Some((out.status.success(), out.stdout))
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).trim().to_string()
}

/// `HEAD` of the repo containing `cwd`, `None` outside a repo or with no commit.
pub fn head(cwd: &Path) -> Option<String> {
    let (ok, out) = run_git(cwd, &["rev-parse", "HEAD"])?;
    let sha = text(&out);
    (ok && !sha.is_empty()).then_some(sha)
}

/// Compare-key for a path: forward slashes, no `\\?\` prefix, no trailing
/// slash, and lowercase on Windows where the filesystem ignores case. Applied
/// to both sides of the comparison, so only agreement matters, not fidelity.
pub fn path_key(raw: &str) -> String {
    let mut s = raw.replace('\\', "/");
    if let Some(rest) = s.strip_prefix("//?/") {
        s = rest.to_string();
    }
    while s.len() > 1 && s.ends_with('/') {
        s.pop();
    }
    if cfg!(windows) {
        s = s.to_lowercase();
    }
    s
}

/// Every path git reports as modified, staged, deleted, renamed or untracked
/// under the repo containing `cwd`, as compare-keys of absolute paths. `None`
/// when `cwd` is not in a repo (nothing to be uncommitted against).
pub fn dirty_keys(cwd: &Path) -> Option<Vec<String>> {
    let (ok, top) = run_git(cwd, &["rev-parse", "--show-toplevel"])?;
    if !ok {
        return None;
    }
    let top = text(&top);
    // `-z` keeps odd file names unquoted; `--untracked-files=all` lists each new
    // file instead of its folder, so a new file the sub wrote can be matched.
    let (ok, raw) = run_git(cwd, &["status", "--porcelain=v1", "-z", "--untracked-files=all"])?;
    if !ok {
        return None;
    }
    let mut keys = Vec::new();
    let mut fields = raw.split(|b| *b == 0).filter(|f| !f.is_empty());
    while let Some(field) = fields.next() {
        // `XY path`; a rename or copy is followed by a second field, the source.
        if field.len() < 4 {
            continue;
        }
        let (xy, path) = (&field[..2], &field[3..]);
        keys.push(path_key(&format!("{top}/{}", String::from_utf8_lossy(path))));
        if matches!(xy[0], b'R' | b'C') || matches!(xy[1], b'R' | b'C') {
            if let Some(src) = fields.next() {
                keys.push(path_key(&format!("{top}/{}", String::from_utf8_lossy(src))));
            }
        }
    }
    Some(keys)
}

/// Absolute paths the transcript's Edit, Write, NotebookEdit and MultiEdit
/// calls named, in first-seen order. A relative path is resolved against `cwd`.
pub fn edited_files(transcript: &Path, cwd: &Path) -> Vec<String> {
    let Ok(raw) = std::fs::read_to_string(transcript) else { return Vec::new() };
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for line in raw.lines() {
        // Cheap reject before a JSON parse: most lines name none of the tools.
        if !EDIT_TOOLS.iter().any(|t| line.contains(t)) {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        let Some(blocks) = v["message"]["content"].as_array() else { continue };
        for b in blocks {
            if b["type"] != "tool_use" || !EDIT_TOOLS.iter().any(|t| b["name"] == *t) {
                continue;
            }
            let input = &b["input"];
            let Some(p) = input["file_path"].as_str().or_else(|| input["notebook_path"].as_str()) else {
                continue;
            };
            let abs = if Path::new(p).is_absolute() {
                p.to_string()
            } else {
                cwd.join(p).to_string_lossy().into_owned()
            };
            if seen.insert(path_key(&abs)) {
                out.push(abs);
            }
        }
    }
    out
}

/// The files the sub edited that git still reports as uncommitted. Empty when
/// `cwd` is not a repo or the transcript names nothing, so a missing signal
/// never refuses a finish.
pub fn own_uncommitted(transcript: &Path, cwd: &Path) -> Vec<String> {
    let edited = edited_files(transcript, cwd);
    if edited.is_empty() {
        return Vec::new();
    }
    let Some(dirty) = dirty_keys(cwd) else { return Vec::new() };
    edited.into_iter().filter(|p| dirty.contains(&path_key(p))).collect()
}

#[cfg(test)]
pub(crate) mod test_repo {
    use super::run_git;
    use std::path::{Path, PathBuf};

    /// A scratch repo with one committed file `base.txt`. The temp dir is
    /// returned so the caller's binding keeps it alive.
    pub fn init() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        // Long form: git reports the long path, so an 8.3 temp path would never match.
        let root = std::fs::canonicalize(dir.path()).unwrap();
        git(&root, &["init", "-q"]);
        git(&root, &["config", "user.email", "t@example.com"]);
        git(&root, &["config", "user.name", "t"]);
        git(&root, &["config", "commit.gpgsign", "false"]);
        std::fs::write(root.join("base.txt"), "base\n").unwrap();
        git(&root, &["add", "base.txt"]);
        git(&root, &["commit", "-q", "-m", "base"]);
        (dir, root)
    }

    pub fn git(cwd: &Path, args: &[&str]) {
        let (ok, _) = run_git(cwd, args).expect("git must be installed to run this test");
        assert!(ok, "git {args:?} failed");
    }

    /// A transcript whose assistant turn called each `(tool, path)` once.
    pub fn transcript(dir: &Path, edits: &[(&str, &Path)]) -> PathBuf {
        let path = dir.join("sub-transcript.jsonl");
        let lines: Vec<String> = edits
            .iter()
            .map(|(tool, file)| {
                let key = if *tool == "NotebookEdit" { "notebook_path" } else { "file_path" };
                serde_json::json!({"type": "assistant", "message": {"content": [
                    {"type": "tool_use", "name": tool, "input": { key: file.to_string_lossy() }}
                ]}})
                .to_string()
            })
            .collect();
        std::fs::write(&path, lines.join("\n")).unwrap();
        path
    }
}

#[cfg(test)]
mod tests {
    use super::test_repo::{git, init, transcript};
    use super::*;

    #[test]
    fn path_key_agrees_across_slash_style_prefix_and_case_on_windows() {
        assert_eq!(path_key("C:\\Repo\\a.txt"), path_key("c:/repo/a.txt"));
        assert_eq!(path_key("\\\\?\\C:\\Repo\\a.txt"), path_key("C:/Repo/a.txt"));
        assert_eq!(path_key("/tmp/x/"), path_key("/tmp/x"));
    }

    #[test]
    fn edited_files_reads_each_edit_tool_once_and_ignores_the_rest() {
        let (dir, root) = init();
        let a = root.join("a.txt");
        let b = root.join("b.ipynb");
        let tp = transcript(dir.path(), &[("Edit", &a), ("Write", &a), ("NotebookEdit", &b), ("Read", &root)]);
        let got = edited_files(&tp, &root);
        assert_eq!(got.len(), 2, "{got:?}");
        assert!(got.iter().any(|p| path_key(p) == path_key(&a.to_string_lossy())));
        assert!(got.iter().any(|p| path_key(p) == path_key(&b.to_string_lossy())));
    }

    #[test]
    fn own_uncommitted_names_only_the_files_the_sub_edited() {
        let (dir, root) = init();
        let mine = root.join("mine.txt");
        let peers = root.join("peers.txt");
        std::fs::write(&mine, "x").unwrap();
        std::fs::write(&peers, "y").unwrap();
        let tp = transcript(dir.path(), &[("Write", &mine)]);
        let dirty = own_uncommitted(&tp, &root);
        assert_eq!(dirty.len(), 1, "a peer's dirty file must not be named: {dirty:?}");
        assert_eq!(path_key(&dirty[0]), path_key(&mine.to_string_lossy()));
    }

    #[test]
    fn a_committed_edit_is_not_uncommitted() {
        let (dir, root) = init();
        let mine = root.join("mine.txt");
        std::fs::write(&mine, "x").unwrap();
        git(&root, &["add", "mine.txt"]);
        git(&root, &["commit", "-q", "-m", "mine"]);
        let tp = transcript(dir.path(), &[("Write", &mine)]);
        assert!(own_uncommitted(&tp, &root).is_empty());
    }

    #[test]
    fn a_modified_tracked_file_and_a_staged_one_both_count() {
        let (dir, root) = init();
        std::fs::write(root.join("base.txt"), "changed\n").unwrap();
        let tp = transcript(dir.path(), &[("Edit", &root.join("base.txt"))]);
        assert_eq!(own_uncommitted(&tp, &root).len(), 1);
        git(&root, &["add", "base.txt"]);
        assert_eq!(own_uncommitted(&tp, &root).len(), 1, "staged is still uncommitted");
    }

    #[test]
    fn outside_a_repo_nothing_is_uncommitted() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("x.txt");
        std::fs::write(&f, "x").unwrap();
        let tp = transcript(dir.path(), &[("Write", &f)]);
        assert!(own_uncommitted(&tp, dir.path()).is_empty());
        assert_eq!(head(dir.path()), None);
    }

    #[test]
    fn head_is_the_commit_sha() {
        let (_dir, root) = init();
        let sha = head(&root).expect("a commit exists");
        assert_eq!(sha.len(), 40);
    }
}
