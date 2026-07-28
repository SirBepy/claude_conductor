//! CLAUDE.md subfolder-scope scanning for the location picker's "Start
//! folder" field. Independent of worktree selection: a monorepo can have
//! several CLAUDE.md files at different depths (e.g. `apps/api`,
//! `apps/web`), and the dev may want the session's `cwd` to land on one of
//! those subfolders instead of the worktree's own root.

use std::path::{Path, PathBuf};

#[derive(serde::Serialize, ts_rs::TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct ClaudeMdScope {
    /// Forward-slash-separated path relative to the worktree root. Empty
    /// string means the worktree's own root has a CLAUDE.md.
    pub rel_path: String,
    pub abs_path: String,
    /// "Repo root" for `rel_path == ""`, otherwise `rel_path` itself.
    pub label: String,
    /// True when another scope found in the same scan is an ancestor
    /// folder of this one - a hint that conventions may compose rather
    /// than replace, not a validation error.
    pub nested: bool,
}

const MAX_DEPTH: usize = 6;

/// Heavy or irrelevant directories never worth descending into. Combined
/// with a blanket skip of dot-directories (`.git`, `.claude` - which also
/// keeps this scan from re-descending into sibling worktrees living under
/// `.claude/worktrees` - `.venv`, `.next`, `.turbo`, `.cache`, etc.).
const EXCLUDED_DIR_NAMES: &[&str] = &["node_modules", "target", "dist", "build", "vendor", "venv", "__pycache__"];

fn should_skip_dir(name: &str) -> bool {
    name.starts_with('.') || EXCLUDED_DIR_NAMES.contains(&name)
}

/// Scans `worktree_path` for every `CLAUDE.md` file up to `MAX_DEPTH`
/// levels deep, excluding heavy/irrelevant directories. Best-effort -
/// unreadable subdirs are skipped silently rather than erroring the whole
/// scan, matching this codebase's other filesystem walks.
#[tauri::command]
pub async fn list_claude_md_scopes(worktree_path: String) -> Result<Vec<ClaudeMdScope>, String> {
    tauri::async_runtime::spawn_blocking(move || Ok(list_claude_md_scopes_sync(&worktree_path)))
        .await
        .map_err(|e| format!("list_claude_md_scopes join error: {e}"))?
}

fn list_claude_md_scopes_sync(worktree_path: &str) -> Vec<ClaudeMdScope> {
    let root = Path::new(worktree_path);
    let mut rel_paths: Vec<String> = Vec::new();
    walk(root, "", 0, &mut rel_paths);
    rel_paths.sort();

    rel_paths
        .iter()
        .map(|rel_path| {
            let abs: PathBuf = if rel_path.is_empty() { root.to_path_buf() } else { root.join(rel_path) };
            let label = if rel_path.is_empty() { "Repo root".to_string() } else { rel_path.clone() };
            let nested = !rel_path.is_empty()
                && rel_paths.iter().any(|other| !other.is_empty() && other != rel_path && is_ancestor(other, rel_path));
            ClaudeMdScope { rel_path: rel_path.clone(), abs_path: abs.to_string_lossy().into_owned(), label, nested }
        })
        .collect()
}

/// True when `ancestor_rel` is a proper ancestor folder of `descendant_rel`
/// (both forward-slash-separated, relative paths).
fn is_ancestor(ancestor_rel: &str, descendant_rel: &str) -> bool {
    descendant_rel.len() > ancestor_rel.len()
        && descendant_rel.starts_with(ancestor_rel)
        && descendant_rel.as_bytes()[ancestor_rel.len()] == b'/'
}

fn walk(dir: &Path, rel: &str, depth: usize, out: &mut Vec<String>) {
    if dir.join("CLAUDE.md").is_file() {
        out.push(rel.to_string());
    }
    if depth >= MAX_DEPTH {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|s| s.to_str()) else { continue };
        if should_skip_dir(name) {
            continue;
        }
        let child_rel = if rel.is_empty() { name.to_string() } else { format!("{rel}/{name}") };
        walk(&path, &child_rel, depth + 1, out);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn finds_root_claude_md() {
        let d = tempdir().unwrap();
        fs::write(d.path().join("CLAUDE.md"), "").unwrap();
        let scopes = list_claude_md_scopes_sync(d.path().to_str().unwrap());
        assert_eq!(scopes.len(), 1);
        assert_eq!(scopes[0].rel_path, "");
        assert_eq!(scopes[0].label, "Repo root");
        assert!(!scopes[0].nested);
    }

    #[test]
    fn finds_nested_claude_md_files_and_flags_nesting() {
        let d = tempdir().unwrap();
        fs::create_dir_all(d.path().join("apps/api/worker")).unwrap();
        fs::create_dir_all(d.path().join("apps/web")).unwrap();
        fs::write(d.path().join("apps/api/CLAUDE.md"), "").unwrap();
        fs::write(d.path().join("apps/api/worker/CLAUDE.md"), "").unwrap();
        fs::write(d.path().join("apps/web/CLAUDE.md"), "").unwrap();

        let scopes = list_claude_md_scopes_sync(d.path().to_str().unwrap());
        assert_eq!(scopes.len(), 3);
        let by_rel = |rel: &str| scopes.iter().find(|s| s.rel_path == rel).unwrap();
        assert!(!by_rel("apps/api").nested);
        assert!(by_rel("apps/api/worker").nested);
        assert!(!by_rel("apps/web").nested);
    }

    #[test]
    fn skips_node_modules_and_dot_dirs() {
        let d = tempdir().unwrap();
        fs::create_dir_all(d.path().join("node_modules/some-pkg")).unwrap();
        fs::write(d.path().join("node_modules/some-pkg/CLAUDE.md"), "").unwrap();
        fs::create_dir_all(d.path().join(".claude/worktrees/other")).unwrap();
        fs::write(d.path().join(".claude/worktrees/other/CLAUDE.md"), "").unwrap();
        fs::create_dir_all(d.path().join("apps/api")).unwrap();
        fs::write(d.path().join("apps/api/CLAUDE.md"), "").unwrap();

        let scopes = list_claude_md_scopes_sync(d.path().to_str().unwrap());
        assert_eq!(scopes.len(), 1);
        assert_eq!(scopes[0].rel_path, "apps/api");
    }

    #[test]
    fn returns_empty_for_missing_dir() {
        let scopes = list_claude_md_scopes_sync("Z:\\definitely\\does\\not\\exist\\zzz");
        assert!(scopes.is_empty());
    }
}
