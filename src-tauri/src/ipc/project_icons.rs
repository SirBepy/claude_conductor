//! Project face fallback: detect a project's own icon file or its tech stack so
//! the frontend can render a real logo instead of the `Avatar::None` placeholder
//! (ai_todo 99). Ported from server_supervisor's `icons.rs`. Read-only; both
//! commands fail soft (None) so a missing/odd project never breaks the list.

use crate::ipc::chat::attachments::AttachmentData;
use std::path::{Path, PathBuf};

/// Max icon file size we'll inline as base64 (larger = skip, keeps the payload
/// sane). Matches server_supervisor.
const MAX_ICON_BYTES: u64 = 512 * 1024;

/// Icon/logo file candidates, priority-ordered (first existing wins). Mirrors
/// server_supervisor's CANDIDATES list.
const ICON_CANDIDATES: &[&str] = &[
    "icon.svg", "icon.png", "icon.ico",
    "logo.svg", "logo.png", "app-icon.png",
    "assets/icons/app_icon.svg", "assets/icons/app_icon.png",
    "assets/icon/app_icon.png", "assets/icon/icon.png",
    "assets/icon.svg", "assets/icon.png",
    "assets/logo.svg", "assets/logo.png",
    "assets/icons/logo.svg", "assets/icons/logo.png",
    "assets/images/logo.png",
    "favicon.svg", "favicon.ico", "favicon.png",
    "public/favicon.svg", "public/favicon.ico", "public/favicon.png",
    "public/logo.png",
    "frontend/public/icon.svg", "frontend/public/icon.png",
    "frontend/public/logo.svg", "frontend/public/logo.png",
    "frontend/public/favicon.svg", "frontend/public/favicon.ico", "frontend/public/favicon.png",
    "static/favicon.svg", "static/favicon.ico", "static/favicon.png",
    "web/icons/Icon-192.png", "web/favicon.png",
    "src-tauri/icons/128x128.png", "src-tauri/icons/icon.png",
];

/// Common monorepo container dirs - checked one level deep, only when a
/// dir's own ICON_CANDIDATES come up empty (e.g. hubbub's `apps/web/public/`).
const WORKSPACE_CONTAINERS: &[&str] = &["apps", "packages", "services"];

fn mime_for(ext: &str) -> Option<&'static str> {
    match ext.to_ascii_lowercase().as_str() {
        "svg" => Some("image/svg+xml"),
        "png" => Some("image/png"),
        "ico" => Some("image/x-icon"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "webp" => Some("image/webp"),
        "gif" => Some("image/gif"),
        _ => None,
    }
}

/// Ancestor directories to check for a project's icon/tech, closest first:
/// `dir` itself, then its parents, stopping (inclusive) at the first one
/// holding a `.git` (the repo root) or after `max_depth` levels, whichever
/// comes first. Lets a subfolder chat (e.g. a monorepo's `frontend/`) inherit
/// the repo root's icon/tech instead of being detected in isolation.
///
/// The `.git` boundary check is `settings::identity::find_repo_root` (same
/// walk, used unbounded there for project-key resolution); here we only need
/// its result as a stop condition while re-walking `dir`'s own ancestors up
/// to `max_depth`, so a `.git` beyond that depth is treated the same as
/// "none found" - unchanged from the prior standalone implementation.
fn ancestors_upto_repo_root(dir: &Path, max_depth: usize) -> Vec<PathBuf> {
    let repo_root = crate::settings::identity::find_repo_root(dir);
    let mut list = Vec::new();
    let mut current = dir.to_path_buf();
    for _ in 0..=max_depth {
        list.push(current.clone());
        if repo_root.as_deref() == Some(current.as_path()) {
            break;
        }
        match current.parent() {
            Some(p) => current = p.to_path_buf(),
            None => break,
        }
    }
    list
}

/// Detect a project's primary tech stack from marker files in a SINGLE dir.
/// Priority-ordered so a more-specific marker wins over a generic
/// `package.json` (e.g. a Tauri app with a bundled frontend reads as `rust`,
/// not `node`). Mirrors server_supervisor's `detect_tech`.
fn detect_tech_at(root: &Path) -> Option<&'static str> {
    let has = |rel: &str| root.join(rel).exists();
    if has("pubspec.yaml") {
        return Some("flutter");
    }
    if has("Cargo.toml") {
        return Some("rust");
    }
    if has("pyproject.toml") || has("requirements.txt") || has("setup.py") || has("Pipfile") {
        return Some("python");
    }
    if has("go.mod") {
        return Some("go");
    }
    if has("deno.json") || has("deno.jsonc") {
        return Some("deno");
    }
    let has_dotnet = std::fs::read_dir(root).ok().is_some_and(|entries| {
        entries.flatten().any(|e| {
            e.path()
                .extension()
                .and_then(|x| x.to_str())
                .is_some_and(|x| x.eq_ignore_ascii_case("csproj") || x.eq_ignore_ascii_case("sln"))
        })
    });
    if has_dotnet {
        return Some("dotnet");
    }
    if has("package.json") {
        return Some("node");
    }
    None
}

/// The detected tech-stack key for a project dir (e.g. "rust", "node"), or
/// None - walks up to the repo root (see `ancestors_upto_repo_root`) so a
/// subfolder with no markers of its own inherits the repo's stack instead of
/// reading as undetected. Cheap (a handful of file-existence checks per
/// level); the frontend caches per path.
#[tauri::command]
pub fn get_project_tech(root: String) -> Option<String> {
    ancestors_upto_repo_root(Path::new(&root), 8)
        .iter()
        .find_map(|dir| detect_tech_at(dir))
        .map(|s| s.to_string())
}

/// ICON_CANDIDATES lookup against a single dir. Shared by the direct
/// ancestor check and the workspace-container scan below.
fn find_icon_in_dir(dir: &Path) -> Option<AttachmentData> {
    use base64::Engine;
    for cand in ICON_CANDIDATES {
        let path = dir.join(cand);
        let Ok(meta) = std::fs::metadata(&path) else { continue };
        if !meta.is_file() || meta.len() > MAX_ICON_BYTES {
            continue;
        }
        let Some(mime) = path.extension().and_then(|e| e.to_str()).and_then(mime_for) else {
            continue;
        };
        let Ok(bytes) = std::fs::read(&path) else { continue };
        let base64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
        return Some(AttachmentData { mime: mime.to_string(), base64 });
    }
    None
}

/// One level into `dir`'s workspace containers, subdirs sorted for
/// determinism - first icon match wins.
fn find_icon_in_workspace_containers(dir: &Path) -> Option<AttachmentData> {
    for container in WORKSPACE_CONTAINERS {
        let Ok(entries) = std::fs::read_dir(dir.join(container)) else { continue };
        let mut subdirs: Vec<PathBuf> = entries.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect();
        subdirs.sort();
        if let Some(icon) = subdirs.iter().find_map(|sub| find_icon_in_dir(sub)) {
            return Some(icon);
        }
    }
    None
}

/// The project's own icon/logo file as `{mime, base64}`, or None when no
/// candidate exists / it's too big / unreadable - walks up to the repo root
/// (see `ancestors_upto_repo_root`) so a subfolder chat inherits the repo
/// root's icon instead of missing it. Closest dir wins: `root` itself is
/// checked before any ancestor, then falls back to a one-level workspace-
/// container scan. Runs on the blocking pool (file IO) so it never stalls
/// the webview, mirroring `read_image_file`.
#[tauri::command]
pub async fn get_project_icon(root: String) -> Option<AttachmentData> {
    tauri::async_runtime::spawn_blocking(move || {
        for dir in ancestors_upto_repo_root(Path::new(&root), 8) {
            if let Some(icon) = find_icon_in_dir(&dir) {
                return Some(icon);
            }
            if let Some(icon) = find_icon_in_workspace_containers(&dir) {
                return Some(icon);
            }
        }
        None
    })
    .await
    .ok()
    .flatten()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    /// A subfolder with its OWN marker (e.g. `frontend/package.json` in a
    /// Rust+Node monorepo) must keep reading as its own tech, not the repo
    /// root's - closest dir wins.
    #[test]
    fn subfolder_with_own_marker_is_not_overridden_by_repo_root() {
        let root = tempdir().unwrap();
        std::fs::write(root.path().join(".git"), "").unwrap();
        std::fs::write(root.path().join("pyproject.toml"), "").unwrap();
        let frontend = root.path().join("frontend");
        std::fs::create_dir_all(&frontend).unwrap();
        std::fs::write(frontend.join("package.json"), "{}").unwrap();

        assert_eq!(
            get_project_tech(frontend.to_string_lossy().to_string()),
            Some("node".to_string())
        );
        assert_eq!(
            get_project_tech(root.path().to_string_lossy().to_string()),
            Some("python".to_string())
        );
    }

    /// A subfolder with NO markers of its own (e.g. `docs/`) inherits the
    /// repo root's detected tech instead of reading as undetected.
    #[test]
    fn subfolder_with_no_markers_inherits_repo_root_tech() {
        let root = tempdir().unwrap();
        std::fs::write(root.path().join(".git"), "").unwrap();
        std::fs::write(root.path().join("Cargo.toml"), "").unwrap();
        let docs = root.path().join("docs");
        std::fs::create_dir_all(&docs).unwrap();

        assert_eq!(
            get_project_tech(docs.to_string_lossy().to_string()),
            Some("rust".to_string())
        );
    }

    /// A subfolder with no icon file of its own inherits the repo root's icon
    /// file - the scenario this walk-up exists for (a single project icon
    /// showing consistently across every subfolder's chats).
    #[tokio::test]
    async fn subfolder_with_no_icon_inherits_repo_root_icon() {
        let root = tempdir().unwrap();
        std::fs::write(root.path().join(".git"), "").unwrap();
        std::fs::write(root.path().join("icon.png"), [0u8, 1, 2, 3]).unwrap();
        let frontend = root.path().join("frontend");
        std::fs::create_dir_all(&frontend).unwrap();

        let icon = get_project_icon(frontend.to_string_lossy().to_string()).await;
        assert!(icon.is_some(), "expected the repo root's icon.png to be inherited");
        assert_eq!(icon.unwrap().mime, "image/png");
    }

    /// Monorepo root, favicons only under `apps/<name>/public/` (hubbub's
    /// layout) - workspace scan must find the alphabetically-first one.
    #[tokio::test]
    async fn workspace_container_scan_finds_per_app_favicon() {
        let root = tempdir().unwrap();
        std::fs::write(root.path().join(".git"), "").unwrap();
        for app in ["web", "controller"] {
            let public = root.path().join("apps").join(app).join("public");
            std::fs::create_dir_all(&public).unwrap();
            std::fs::write(public.join("favicon.svg"), b"<svg/>").unwrap();
        }

        let icon = get_project_icon(root.path().to_string_lossy().to_string()).await;
        assert!(icon.is_some(), "expected apps/controller/public/favicon.svg (alphabetically first)");
        assert_eq!(icon.unwrap().mime, "image/svg+xml");
    }

    /// The walk-up must not escape the repo boundary: a `.git`-bearing dir is
    /// the last one checked, even if its own parent also has a marker.
    #[test]
    fn walk_up_stops_at_repo_root() {
        let outer = tempdir().unwrap();
        std::fs::write(outer.path().join("Cargo.toml"), "").unwrap();
        let repo = outer.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        std::fs::write(repo.join(".git"), "").unwrap();
        let sub = repo.join("sub");
        std::fs::create_dir_all(&sub).unwrap();

        assert_eq!(get_project_tech(sub.to_string_lossy().to_string()), None);
    }
}
