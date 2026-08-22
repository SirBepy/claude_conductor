//! Project-identity helpers: turn a CWD into a stable, canonicalized
//! project key so we can collapse case/separator variants and roll
//! subfolders up to their owning repo root.

/// Walks `start` and its ancestors looking for a `.git` entry (file or dir).
/// Returns the first ancestor that has one. None if no ancestor does.
pub fn find_repo_root(start: &std::path::Path) -> Option<std::path::PathBuf> {
    let mut cur: Option<&std::path::Path> = Some(start);
    while let Some(p) = cur {
        if p.join(".git").exists() {
            return Some(p.to_path_buf());
        }
        cur = p.parent();
    }
    None
}

/// Resolves the git directory backing the working tree at `path`:
/// `<path>/.git` when that is a directory, else the target of its
/// `gitdir: <path>` pointer (worktrees and submodules both use one).
pub fn git_dir_for(path: &std::path::Path) -> Option<std::path::PathBuf> {
    let git_path = path.join(".git");
    if git_path.is_dir() {
        return Some(git_path);
    }
    if !git_path.is_file() {
        return None;
    }
    let contents = std::fs::read_to_string(&git_path).ok()?;
    let gitdir = contents.trim().strip_prefix("gitdir:")?.trim();
    if gitdir.is_empty() {
        return None;
    }
    let gitdir_path = std::path::Path::new(gitdir);
    Some(if gitdir_path.is_absolute() {
        gitdir_path.to_path_buf()
    } else {
        path.join(gitdir_path)
    })
}

/// Branch checked out in the working tree at `path`, read straight out of
/// HEAD. No `git` subprocess: this runs once per peer on every `list_peers`,
/// and each spawn flashes a console window on Windows. Detached HEAD yields
/// the short sha instead of a name.
pub fn current_branch(path: &std::path::Path) -> Option<String> {
    let head = std::fs::read_to_string(git_dir_for(path)?.join("HEAD")).ok()?;
    let head = head.trim();
    match head.strip_prefix("ref:") {
        Some(reference) => {
            let reference = reference.trim();
            Some(reference.strip_prefix("refs/heads/").unwrap_or(reference).to_string())
        }
        None if head.is_empty() => None,
        None => Some(head.chars().take(8).collect()),
    }
}

/// If `path` is a git worktree checkout, returns the main repo's root path.
/// A worktree's `.git` is a *file* (not a directory) reading
/// `gitdir: <main-repo>/.git/worktrees/<name>`; this walks that pointer back
/// to `<main-repo>`. Returns `None` for a normal repo, a submodule (whose
/// `.git` file points at `.../modules/<name>`, not `.../worktrees/<name>`),
/// or a non-repo path.
pub fn worktree_main_repo(path: &std::path::Path) -> Option<std::path::PathBuf> {
    if !path.join(".git").is_file() {
        return None;
    }
    let gitdir_path = git_dir_for(path)?;

    // Expect a tail of `.../.git/worktrees/<name>`.
    let mut components: Vec<std::path::Component> = gitdir_path.components().collect();
    components.pop()?; // <name>
    let worktrees_seg = components.pop()?;
    if worktrees_seg.as_os_str() != "worktrees" {
        return None;
    }
    let git_seg = components.pop()?;
    if git_seg.as_os_str() != ".git" {
        return None;
    }
    let main_repo: std::path::PathBuf = components.iter().collect();
    if main_repo.as_os_str().is_empty() {
        return None;
    }
    Some(main_repo)
}

/// Canonicalizes via the filesystem (resolves real casing, junctions,
/// symlinks). On Windows, strips the `\\?\` UNC prefix that
/// `fs::canonicalize` emits. Falls back to `normalize_cwd_key` when the
/// path doesn't exist (so missing dirs still produce a stable key).
pub fn normalize_path(p: &std::path::Path) -> String {
    match std::fs::canonicalize(p) {
        Ok(canon) => {
            let s = canon.to_string_lossy().into_owned();
            #[cfg(windows)]
            {
                if let Some(stripped) = s.strip_prefix(r"\\?\") {
                    return normalize_cwd_key(std::path::Path::new(stripped));
                }
            }
            normalize_cwd_key(std::path::Path::new(&s))
        }
        Err(_) => normalize_cwd_key(p),
    }
}

/// Root path a cwd belongs to: its `.git` ancestor, rolled up to the main
/// checkout when that ancestor is a worktree. Falls back to the input path
/// when there is no repo. Every project-identity call site must go through
/// this, so a worktree never registers under its own folder name.
pub fn project_root(p: &std::path::Path) -> std::path::PathBuf {
    let root = find_repo_root(p).unwrap_or_else(|| p.to_path_buf());
    worktree_main_repo(&root).unwrap_or(root)
}

/// Identity key for a project: the normalized form of `project_root`.
/// Worktrees share their main repo's key, so two sessions on one repo find
/// each other in `list_peers` no matter which tree they run in (todo 717).
pub fn project_key(p: &std::path::Path) -> String {
    normalize_path(&project_root(p))
}

/// Effective account binding for `path`: own `preferred_account_id` if set,
/// else the PARENT repo's binding for an unbound worktree. Frontend call
/// sites used to `find()` on raw path strings, missing worktrees (separate
/// repo root) and any casing/separator drift.
pub fn resolve_effective_preferred_account_id(
    projects: &[crate::types::ProjectConfig],
    path: &std::path::Path,
) -> Option<String> {
    let own_root = find_repo_root(path).unwrap_or_else(|| path.to_path_buf());
    let own_key = normalize_path(&own_root);
    let by_root = |root_key: &str| -> Option<String> {
        projects
            .iter()
            .find(|p| normalize_path(&p.path) == root_key)
            .and_then(|p| p.preferred_account_id.clone())
    };
    if let Some(id) = by_root(&own_key) {
        return Some(id);
    }
    let main_key = normalize_path(&worktree_main_repo(&own_root)?);
    by_root(&main_key)
}

/// Canonical key used to decide whether two recorded cwds refer to the
/// same project. On Windows and macOS (default APFS), paths are
/// case-insensitive and can arrive with either `\` or `/` separators
/// (hook payloads, token-history, IPC all vary); without normalization
/// the same folder registered as a different project every time the
/// casing flipped.
pub fn normalize_cwd_key(p: &std::path::Path) -> String {
    let raw = p.to_string_lossy();
    let swapped: String = raw.chars().map(|c| if c == '/' { '\\' } else { c }).collect();
    let trimmed = swapped.trim_end_matches('\\');
    if cfg!(any(windows, target_os = "macos")) {
        trimmed.to_lowercase()
    } else {
        trimmed.to_string()
    }
}

/// True when `path` sits under a scratch root: the OS temp dir, or the
/// `C:\tmp` convention skill-eval/rules-probe scratch runs use. Shared by
/// `upsert_project_for_cwd` and `filter_out_ephemeral_projects` so neither
/// drifts from the other.
pub fn is_ephemeral_root_path(p: &std::path::Path) -> bool {
    let key = normalize_cwd_key(p);
    if key.is_empty() {
        return false;
    }
    let roots = [normalize_cwd_key(&std::env::temp_dir()), normalize_cwd_key(std::path::Path::new(r"C:\tmp"))];
    roots.iter().any(|root| !root.is_empty() && (key == *root || key.starts_with(&format!("{root}\\"))))
}

/// One-shot migration run on every load. Collapses duplicate project
/// entries that point at the same folder under different casing or
/// separator styles. The surviving entry keeps the first id seen (so
/// existing references stay valid), the oldest `created_at`, the latest
/// `last_active_at`, and any non-empty avatar / automation / name that a
/// later duplicate had filled in.
pub(crate) fn dedupe_projects_by_path_key(projects: &mut Vec<crate::types::ProjectConfig>) {
    use std::collections::HashMap;
    let mut by_key: HashMap<String, usize> = HashMap::new();
    let mut survivors: Vec<crate::types::ProjectConfig> = Vec::with_capacity(projects.len());
    for p in projects.drain(..) {
        let key = project_key(&p.path);
        match by_key.get(&key).copied() {
            None => {
                by_key.insert(key, survivors.len());
                survivors.push(p);
            }
            Some(idx) => {
                let keep = &mut survivors[idx];
                if p.created_at < keep.created_at {
                    keep.created_at = p.created_at.clone();
                }
                match (&keep.last_active_at, &p.last_active_at) {
                    (None, Some(_)) => keep.last_active_at = p.last_active_at.clone(),
                    (Some(a), Some(b)) if b > a => keep.last_active_at = p.last_active_at.clone(),
                    _ => {}
                }
                if matches!(keep.avatar, crate::types::Avatar::None)
                    && !matches!(p.avatar, crate::types::Avatar::None)
                {
                    keep.avatar = p.avatar.clone();
                }
                if keep.automation.is_none() && p.automation.is_some() {
                    keep.automation = p.automation.clone();
                }
                if keep.preferred_account_id.is_none() && p.preferred_account_id.is_some() {
                    keep.preferred_account_id = p.preferred_account_id.clone();
                }
            }
        }
    }
    *projects = survivors;
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    /// Rooted beside the test binary, not `tempfile::tempdir()`'s OS-temp
    /// default - avoids tripping `is_ephemeral_root_path` or this repo's own `.git`.
    fn non_ephemeral_tempdir() -> tempfile::TempDir {
        let exe_dir = std::env::current_exe().unwrap().parent().unwrap().to_path_buf();
        tempfile::Builder::new().prefix("cc-test-").tempdir_in(exe_dir).unwrap()
    }

    fn sample_project(path: std::path::PathBuf, preferred_account_id: Option<&str>) -> crate::types::ProjectConfig {
        crate::types::ProjectConfig {
            id: "id-1".into(),
            path,
            name: "proj".into(),
            avatar: crate::types::Avatar::None,
            automation: None,
            created_at: "2026-04-21T00:00:00Z".into(),
            last_active_at: None,
            whitelist: crate::types::CharacterWhitelist::default(),
            preferred_account_id: preferred_account_id.map(str::to_string),
            last_worktree_path: None,
            last_start_folder_rel: None,
        }
    }

    #[test]
    fn dedupe_carries_forward_preferred_account_id_from_a_duplicate() {
        let dir = tempdir().unwrap();
        let repo = dir.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        std::fs::create_dir_all(repo.join(".git")).unwrap();

        // Two entries for the same path (e.g. survived a casing/separator
        // split); only the second carries a binding.
        let mut projects = vec![
            sample_project(repo.clone(), None),
            sample_project(repo.clone(), Some("acct-work")),
        ];
        dedupe_projects_by_path_key(&mut projects);

        assert_eq!(projects.len(), 1, "duplicates must collapse to one entry");
        assert_eq!(projects[0].preferred_account_id.as_deref(), Some("acct-work"));
    }

    #[test]
    fn dedupe_keeps_the_survivors_own_binding_when_it_already_has_one() {
        let dir = tempdir().unwrap();
        let repo = dir.path().join("repo2");
        std::fs::create_dir_all(&repo).unwrap();
        std::fs::create_dir_all(repo.join(".git")).unwrap();

        let mut projects = vec![
            sample_project(repo.clone(), Some("acct-personal")),
            sample_project(repo.clone(), Some("acct-work")),
        ];
        dedupe_projects_by_path_key(&mut projects);

        assert_eq!(projects.len(), 1);
        // First-seen survivor keeps its own binding; a later duplicate never
        // overwrites an existing one (mirrors the avatar/automation rule).
        assert_eq!(projects[0].preferred_account_id.as_deref(), Some("acct-personal"));
    }

    #[test]
    fn find_repo_root_returns_dir_with_git_subdir() {
        let dir = tempdir().unwrap();
        let repo = dir.path().join("repo");
        let sub = repo.join("packages").join("app");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::create_dir_all(repo.join(".git")).unwrap();
        let found = find_repo_root(&sub).expect("expected to find repo root");
        assert_eq!(found, repo);
    }

    #[test]
    fn find_repo_root_returns_dir_with_git_file() {
        // Submodules use a `.git` *file* pointing at the parent's modules dir.
        let dir = tempdir().unwrap();
        let repo = dir.path().join("submod");
        let sub = repo.join("src");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(repo.join(".git"), b"gitdir: ../.git/modules/submod").unwrap();
        let found = find_repo_root(&sub).expect("expected to find repo root");
        assert_eq!(found, repo);
    }

    #[test]
    fn find_repo_root_returns_none_outside_repo() {
        let dir = tempdir().unwrap();
        let nested = dir.path().join("a").join("b");
        std::fs::create_dir_all(&nested).unwrap();
        assert!(find_repo_root(&nested).is_none());
    }

    #[test]
    fn project_key_rolls_up_subfolder_to_repo_root() {
        let dir = tempdir().unwrap();
        let repo = dir.path().join("repo");
        let sub = repo.join("nested").join("inner");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::create_dir_all(repo.join(".git")).unwrap();
        let key_root = project_key(&repo);
        let key_sub = project_key(&sub);
        assert_eq!(key_root, key_sub, "subfolder must share repo-root key");
    }

    /// `<repo>/.claude/worktrees/<name>` wired up the way `git worktree add`
    /// leaves it: a `.git` FILE pointing back at the main repo's admin dir.
    fn make_worktree(repo: &std::path::Path, name: &str) -> std::path::PathBuf {
        let worktree = repo.join(".claude").join("worktrees").join(name);
        std::fs::create_dir_all(&worktree).unwrap();
        let gitdir = repo.join(".git").join("worktrees").join(name);
        std::fs::create_dir_all(&gitdir).unwrap();
        std::fs::write(worktree.join(".git"), format!("gitdir: {}\n", gitdir.to_string_lossy())).unwrap();
        worktree
    }

    #[test]
    fn project_key_rolls_a_worktree_up_to_its_main_repo() {
        let dir = tempdir().unwrap();
        let repo = dir.path().join("repo");
        std::fs::create_dir_all(repo.join(".git")).unwrap();
        let worktree = make_worktree(&repo, "feature-x");
        assert_eq!(
            project_key(&worktree),
            project_key(&repo),
            "a worktree must share the main checkout's project key"
        );
        // And a nested cwd inside the worktree, not just its root.
        let nested = worktree.join("src");
        std::fs::create_dir_all(&nested).unwrap();
        assert_eq!(project_key(&nested), project_key(&repo));
    }

    #[test]
    fn project_key_still_separates_two_different_repos() {
        let dir = tempdir().unwrap();
        let a = dir.path().join("repo-a");
        let b = dir.path().join("repo-b");
        std::fs::create_dir_all(a.join(".git")).unwrap();
        std::fs::create_dir_all(b.join(".git")).unwrap();
        assert_ne!(project_key(&a), project_key(&b));
    }

    #[test]
    fn current_branch_reads_head_of_the_worktree_not_the_main_repo() {
        let dir = tempdir().unwrap();
        let repo = dir.path().join("repo");
        std::fs::create_dir_all(repo.join(".git")).unwrap();
        std::fs::write(repo.join(".git").join("HEAD"), "ref: refs/heads/master\n").unwrap();
        let worktree = make_worktree(&repo, "feature-x");
        std::fs::write(
            repo.join(".git").join("worktrees").join("feature-x").join("HEAD"),
            "ref: refs/heads/feature-x\n",
        )
        .unwrap();

        assert_eq!(current_branch(&repo).as_deref(), Some("master"));
        assert_eq!(current_branch(&worktree).as_deref(), Some("feature-x"));
    }

    #[test]
    fn current_branch_reports_a_short_sha_when_head_is_detached() {
        let dir = tempdir().unwrap();
        let repo = dir.path().join("repo");
        std::fs::create_dir_all(repo.join(".git")).unwrap();
        std::fs::write(repo.join(".git").join("HEAD"), "69a7dedf1234567890abcdef1234567890abcdef\n").unwrap();
        assert_eq!(current_branch(&repo).as_deref(), Some("69a7dedf"));
    }

    #[test]
    fn current_branch_none_outside_a_repo() {
        let dir = tempdir().unwrap();
        assert_eq!(current_branch(dir.path()), None);
    }

    #[test]
    fn project_key_falls_back_to_normalized_path_when_not_in_repo() {
        let dir = tempdir().unwrap();
        let p = dir.path().join("standalone");
        std::fs::create_dir_all(&p).unwrap();
        let key = project_key(&p);
        // We don't compare against an exact string (canonicalize varies by OS),
        // but it must be non-empty and stable across calls with the same path.
        assert!(!key.is_empty());
        assert_eq!(key, project_key(&p));
    }

    #[test]
    fn project_key_for_missing_path_uses_normalize_fallback() {
        // Path doesn't exist on disk; canonicalize fails, fallback kicks in.
        let p = std::path::Path::new("Z:\\definitely\\does\\not\\exist\\xyz");
        let key = project_key(p);
        assert!(!key.is_empty());
        assert_eq!(key, normalize_cwd_key(p));
    }

    #[test]
    fn worktree_main_repo_resolves_gitdir_pointer() {
        let dir = tempdir().unwrap();
        let repo = dir.path().join("fibo");
        let worktree = repo.join(".claude").join("worktrees").join("v2-frontend-shell");
        std::fs::create_dir_all(&worktree).unwrap();
        std::fs::create_dir_all(repo.join(".git").join("worktrees").join("v2-frontend-shell")).unwrap();
        let gitdir = repo.join(".git").join("worktrees").join("v2-frontend-shell");
        std::fs::write(worktree.join(".git"), format!("gitdir: {}\n", gitdir.to_string_lossy())).unwrap();
        let found = worktree_main_repo(&worktree).expect("expected a main repo");
        assert_eq!(found, repo);
    }

    #[test]
    fn worktree_main_repo_none_for_submodule_gitdir() {
        // Submodule .git files point at `.../modules/<name>`, not `.../worktrees/<name>`.
        let dir = tempdir().unwrap();
        let repo = dir.path().join("submod");
        std::fs::create_dir_all(&repo).unwrap();
        std::fs::write(repo.join(".git"), b"gitdir: ../.git/modules/submod").unwrap();
        assert!(worktree_main_repo(&repo).is_none());
    }

    #[test]
    fn worktree_main_repo_none_for_normal_repo() {
        let dir = tempdir().unwrap();
        let repo = dir.path().join("repo");
        std::fs::create_dir_all(repo.join(".git")).unwrap();
        assert!(worktree_main_repo(&repo).is_none());
    }

    #[test]
    fn resolve_effective_preferred_account_id_uses_own_binding_when_present() {
        let dir = tempdir().unwrap();
        let repo = dir.path().join("repo");
        std::fs::create_dir_all(repo.join(".git")).unwrap();
        let projects = vec![sample_project(repo.clone(), Some("acct-own"))];
        assert_eq!(
            resolve_effective_preferred_account_id(&projects, &repo).as_deref(),
            Some("acct-own")
        );
    }

    #[test]
    fn resolve_effective_preferred_account_id_falls_back_to_parent_for_unbound_worktree() {
        let dir = tempdir().unwrap();
        let repo = dir.path().join("fibo");
        let worktree = repo.join(".claude").join("worktrees").join("v2-frontend-shell");
        std::fs::create_dir_all(&worktree).unwrap();
        std::fs::create_dir_all(repo.join(".git").join("worktrees").join("v2-frontend-shell")).unwrap();
        let gitdir = repo.join(".git").join("worktrees").join("v2-frontend-shell");
        std::fs::write(worktree.join(".git"), format!("gitdir: {}\n", gitdir.to_string_lossy())).unwrap();

        let projects = vec![sample_project(repo.clone(), Some("acct-parent"))];
        assert_eq!(
            resolve_effective_preferred_account_id(&projects, &worktree).as_deref(),
            Some("acct-parent"),
            "worktree with no binding of its own must inherit the main repo's"
        );
    }

    #[test]
    fn resolve_effective_preferred_account_id_prefers_worktrees_own_binding_over_parent() {
        let dir = tempdir().unwrap();
        let repo = dir.path().join("fibo");
        let worktree = repo.join(".claude").join("worktrees").join("v2-frontend-shell");
        std::fs::create_dir_all(&worktree).unwrap();
        std::fs::create_dir_all(repo.join(".git").join("worktrees").join("v2-frontend-shell")).unwrap();
        let gitdir = repo.join(".git").join("worktrees").join("v2-frontend-shell");
        std::fs::write(worktree.join(".git"), format!("gitdir: {}\n", gitdir.to_string_lossy())).unwrap();

        let projects = vec![
            sample_project(repo.clone(), Some("acct-parent")),
            sample_project(worktree.clone(), Some("acct-worktree")),
        ];
        assert_eq!(
            resolve_effective_preferred_account_id(&projects, &worktree).as_deref(),
            Some("acct-worktree")
        );
    }

    #[test]
    fn resolve_effective_preferred_account_id_none_when_unregistered() {
        let dir = tempdir().unwrap();
        let repo = dir.path().join("repo");
        std::fs::create_dir_all(repo.join(".git")).unwrap();
        assert_eq!(resolve_effective_preferred_account_id(&[], &repo), None);
    }

    #[cfg(windows)]
    #[test]
    fn project_key_collapses_drive_letter_casing() {
        let dir = tempdir().unwrap();
        let repo = dir.path().join("Repo");
        std::fs::create_dir_all(&repo).unwrap();
        std::fs::create_dir_all(repo.join(".git")).unwrap();
        let lower = project_key(&repo);
        // Re-create the same path with toggled drive-letter case.
        let raw = repo.to_string_lossy();
        let toggled: String = raw.chars().enumerate().map(|(i, c)| {
            if i == 0 { if c.is_ascii_uppercase() { c.to_ascii_lowercase() } else { c.to_ascii_uppercase() } } else { c }
        }).collect();
        let upper = project_key(std::path::Path::new(&toggled));
        assert_eq!(lower, upper, "drive-letter casing must not split the key");
    }

    #[test]
    fn is_ephemeral_root_path_matches_os_temp_dir() {
        let inside = std::env::temp_dir().join("skill-eval-cwd-abc123");
        assert!(is_ephemeral_root_path(&inside));
        assert!(is_ephemeral_root_path(&std::env::temp_dir()));
    }

    #[cfg(windows)]
    #[test]
    fn is_ephemeral_root_path_matches_c_tmp_case_insensitive() {
        assert!(is_ephemeral_root_path(std::path::Path::new(r"c:\TMP\rules-probe\work")));
        assert!(is_ephemeral_root_path(std::path::Path::new(r"C:\tmp")));
    }

    #[test]
    fn is_ephemeral_root_path_does_not_match_real_projects() {
        let dir = non_ephemeral_tempdir();
        let repo = dir.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        assert!(!is_ephemeral_root_path(&repo));
        // A sibling that merely starts with the same prefix as `C:\tmp`
        // (e.g. `C:\tmpfoo`) must not false-match.
        assert!(!is_ephemeral_root_path(std::path::Path::new(r"C:\tmpfoo\work")));
    }
}
