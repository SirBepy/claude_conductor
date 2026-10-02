//! Daemon RPC for the phone's "Create <name>" new-project flow (todo 1058).
//! The phone sends only a bare folder NAME, never a path: a paired phone has
//! no native folder-picker dialog (`pick_folder` is Tauri-only, desktop-side)
//! and must not be able to point folder creation anywhere on disk. The
//! daemon resolves the projects root itself - the same `newProjectLastParent`
//! setting + majority-parent inference `projects-root.ts` uses on desktop,
//! ported below so both sides agree - and creates `<root>/<name>`.

use crate::daemon::rpc::{Router, RpcError};
use crate::daemon::state::DaemonState;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Arc;

/// Settings key read from `Settings.extra` - the SAME key
/// `src/views/sessions/projects-root.ts::PROJECTS_ROOT_SETTINGS_KEY` writes,
/// so a root the user set from the desktop is honored here too.
const PROJECTS_ROOT_SETTINGS_KEY: &str = "newProjectLastParent";

/// Mirrors `projects-root.ts::isValidProjectName`, plus the drive-letter/
/// colon/separator cases spelled out explicitly for the Rust side: empty,
/// `.`/`..`, or any of `\ / : * ? " < > |` is rejected. A name that passes
/// this is a single path SEGMENT - joining it onto the root can never climb
/// out of it on its own; `register_create_project` below still re-checks via
/// a canonicalized prefix comparison as defense in depth.
pub(crate) fn is_valid_project_name(name: &str) -> bool {
    let t = name.trim();
    if t.is_empty() {
        return false;
    }
    if t == "." || t == ".." {
        return false;
    }
    !t.chars().any(|c| matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|'))
}

/// Parent directory of `path`, or `None` at a drive/filesystem root (ported
/// 1:1 from `projects-root.ts::parentOf` - `cut <= 2` covers `C:\x` and
/// `/x`, since a drive or filesystem root is never a sensible place to drop
/// new projects).
fn parent_of(path: &str) -> Option<String> {
    let normalized = path.trim_end_matches(['\\', '/']);
    let cut = normalized.rfind(['\\', '/'])?;
    if cut <= 2 {
        return None;
    }
    Some(normalized[..cut].to_string())
}

/// The directory most `paths` already live in, or `None` when there is no
/// majority worth trusting (ported 1:1 from
/// `projects-root.ts::inferProjectsRoot` - keep both in lockstep, they
/// implement the same UX rule on two sides of the wire). Ties keep the
/// first-seen parent, matching JS `Map` iteration order.
pub(crate) fn infer_projects_root(paths: &[String]) -> Option<String> {
    use std::collections::HashMap;
    let mut order: Vec<String> = Vec::new();
    let mut counts: HashMap<String, (u32, String)> = HashMap::new();
    for p in paths {
        let Some(parent) = parent_of(p) else { continue };
        let key = parent.to_lowercase();
        match counts.get_mut(&key) {
            Some(entry) => entry.0 += 1,
            None => {
                counts.insert(key.clone(), (1, parent));
                order.push(key);
            }
        }
    }
    let mut best: Option<(u32, String)> = None;
    for key in &order {
        let (n, display) = counts.get(key).expect("just inserted");
        let is_better = match &best {
            Some((bn, _)) => n > bn,
            None => true,
        };
        if is_better {
            best = Some((*n, display.clone()));
        }
    }
    // A single project tells you nothing about where the NEXT one goes; two
    // sharing a parent is the first point at which "this is where I keep
    // them" is a real signal rather than a coincidence.
    best.filter(|(n, _)| *n >= 2).map(|(_, d)| d)
}

/// The root to use: an explicit stored choice wins over the inference, which
/// wins over nothing (ported from `projects-root.ts::resolveProjectsRoot`).
pub(crate) fn resolve_projects_root(stored: Option<&str>, project_paths: &[String]) -> Option<String> {
    if let Some(s) = stored {
        if !s.is_empty() {
            return Some(s.to_string());
        }
    }
    infer_projects_root(project_paths)
}

/// Joins `root` and `name` with the separator `root` itself uses (ported
/// from `projects-root.ts::joinProjectPath`), so a Windows root never
/// produces a mixed `C:\a\b/c`.
fn join_project_path(root: &str, name: &str) -> String {
    let sep = if root.contains('\\') { '\\' } else { '/' };
    let trimmed = root.trim_end_matches(['\\', '/']);
    format!("{trimmed}{sep}{name}")
}

pub fn register_create_project(router: &mut Router, state: Arc<DaemonState>) {
    router.register("create_project_folder", move |params, _ctx| {
        let state = state.clone();
        async move {
            #[derive(serde::Deserialize)]
            struct P {
                name: String,
            }
            let p: P = serde_json::from_value(params.unwrap_or(Value::Null))
                .map_err(|e| RpcError::invalid_params(e.to_string()))?;
            let name = p.name.trim().to_string();
            if !is_valid_project_name(&name) {
                return Err(RpcError::invalid_params("invalid project name".to_string()));
            }

            let settings = state.settings.snapshot();
            let stored = settings
                .extra
                .get(PROJECTS_ROOT_SETTINGS_KEY)
                .and_then(|v| v.as_str());
            let paths: Vec<String> = settings
                .projects
                .iter()
                .map(|proj| proj.path.to_string_lossy().into_owned())
                .collect();
            let root = resolve_projects_root(stored, &paths).ok_or_else(|| {
                RpcError::invalid_params(
                    "no projects root configured - set one on the desktop first".to_string(),
                )
            })?;

            let full_path = join_project_path(&root, &name);
            let create_target = PathBuf::from(&full_path);

            // Escape check (defense in depth, todo 1058): canonicalize the
            // root - it must already exist, being either a stored setting or
            // inferred from real project paths - and confirm the joined
            // path's parent is exactly that directory. `name` was already
            // validated to carry no separators/`..`, so this can only ever
            // fire on a bug in the validation above, never a legitimate name.
            let root_for_canon = PathBuf::from(&root);
            let canon_root = tokio::task::spawn_blocking(move || root_for_canon.canonicalize())
                .await
                .map_err(|e| RpcError::internal(format!("join: {e}")))?
                .map_err(|e| {
                    RpcError::invalid_params(format!("projects root is not accessible: {e}"))
                })?;
            let canon_joined = canon_root.join(&name);
            if canon_joined.parent() != Some(canon_root.as_path()) {
                return Err(RpcError::invalid_params(
                    "name would escape the projects root".to_string(),
                ));
            }

            let outcome = tokio::task::spawn_blocking(move || -> Result<(), String> {
                // A clear error instead of silently "succeeding" into
                // someone's existing directory - intentionally stricter than
                // the desktop `create_folder` Tauri command (`create_dir_all`,
                // idempotent), since the phone never gets to choose a
                // different existing folder to resolve the name clash itself.
                if create_target.exists() {
                    return Err(format!("{} already exists", create_target.display()));
                }
                std::fs::create_dir_all(&create_target).map_err(|e| e.to_string())
            })
            .await
            .map_err(|e| RpcError::internal(format!("join: {e}")))?;
            outcome.map_err(RpcError::invalid_params)?;

            // Registered right away, the same way a session spawn registers its
            // cwd: every cwd-gated RPC the new-chat screen calls next (file
            // list, git info, slash commands, account) rejects an unknown cwd,
            // and the phone has no ensure_project to do it itself.
            let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
            let (project_id, created_new) =
                state.settings.upsert_project_for_cwd(std::path::Path::new(&full_path), &now);
            if created_new {
                state.notifier.publish("project_created", json!({
                    "project_id": project_id,
                    "cwd": full_path,
                    "now": now,
                }));
            }

            Ok(json!({ "path": full_path }))
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::rpc::{ConnectionContext, Request};
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::types::{ProjectConfig, Settings};
    use serde_json::json;
    use tempfile::tempdir;

    fn dummy_ctx() -> ConnectionContext {
        let (tx, _rx) = tokio::sync::mpsc::channel(16);
        ConnectionContext::new(tx)
    }

    fn state_with_settings(settings: Settings) -> Arc<DaemonState> {
        DaemonState::new(new_session_map(), SettingsCache::new(settings))
    }

    async fn call(state: Arc<DaemonState>, params: serde_json::Value) -> crate::daemon::rpc::Response {
        let mut r = Router::new();
        register_create_project(&mut r, state);
        r.dispatch(
            Request {
                jsonrpc: "2.0".into(),
                id: json!(1),
                method: "create_project_folder".into(),
                params: Some(params),
            },
            dummy_ctx(),
        )
        .await
    }

    fn project(path: &std::path::Path) -> ProjectConfig {
        ProjectConfig {
            id: uuid::Uuid::new_v4().to_string(),
            path: path.to_path_buf(),
            name: path.file_name().unwrap().to_string_lossy().into_owned(),
            avatar: Default::default(),
            automation: None,
            created_at: "2026-01-01T00:00:00Z".to_string(),
            last_active_at: None,
            whitelist: Default::default(),
            preferred_account_id: None,
            last_worktree_path: None,
            last_start_folder_rel: None,
            claude_ai_connectors: false,
            tracker: None,
        }
    }

    // ── Name validation rejections ──────────────────────────────────────────

    #[test]
    fn rejects_empty_name() {
        assert!(!is_valid_project_name(""));
        assert!(!is_valid_project_name("   "));
    }

    #[test]
    fn rejects_dot_and_dotdot() {
        assert!(!is_valid_project_name("."));
        assert!(!is_valid_project_name(".."));
    }

    #[test]
    fn rejects_separators() {
        assert!(!is_valid_project_name("a/b"));
        assert!(!is_valid_project_name("a\\b"));
        assert!(!is_valid_project_name("../evil"));
        assert!(!is_valid_project_name("..\\evil"));
    }

    #[test]
    fn rejects_drive_letters_and_colons() {
        assert!(!is_valid_project_name("C:"));
        assert!(!is_valid_project_name("C:\\Windows"));
    }

    #[test]
    fn rejects_absolute_paths() {
        assert!(!is_valid_project_name("/etc/passwd"));
        assert!(!is_valid_project_name("\\\\server\\share"));
    }

    #[test]
    fn accepts_a_plain_name() {
        assert!(is_valid_project_name("my-new-app"));
        assert!(is_valid_project_name("  spaced  "));
    }

    // ── Root inference / resolution ──────────────────────────────────────────

    #[test]
    fn infers_majority_parent() {
        let paths = vec![
            "C:\\Users\\joe\\Projects\\a".to_string(),
            "C:\\Users\\joe\\Projects\\b".to_string(),
            "D:\\scratch".to_string(),
        ];
        assert_eq!(infer_projects_root(&paths), Some("C:\\Users\\joe\\Projects".to_string()));
    }

    #[test]
    fn single_project_infers_nothing() {
        let paths = vec!["C:\\Users\\joe\\Projects\\a".to_string()];
        assert_eq!(infer_projects_root(&paths), None);
    }

    #[test]
    fn stored_root_wins_over_inference() {
        let paths = vec![
            "C:\\Users\\joe\\Projects\\a".to_string(),
            "C:\\Users\\joe\\Projects\\b".to_string(),
        ];
        assert_eq!(
            resolve_projects_root(Some("D:\\elsewhere"), &paths),
            Some("D:\\elsewhere".to_string())
        );
    }

    #[test]
    fn empty_stored_falls_back_to_inference() {
        let paths = vec![
            "C:\\Users\\joe\\Projects\\a".to_string(),
            "C:\\Users\\joe\\Projects\\b".to_string(),
        ];
        assert_eq!(
            resolve_projects_root(Some(""), &paths),
            Some("C:\\Users\\joe\\Projects".to_string())
        );
    }

    // ── RPC behavior ──────────────────────────────────────────────────────

    #[tokio::test]
    async fn rejects_an_invalid_name_before_touching_disk() {
        let dir = tempdir().unwrap();
        let mut settings = Settings::default();
        settings.extra.insert(
            "newProjectLastParent".to_string(),
            json!(dir.path().to_string_lossy()),
        );
        let resp = call(state_with_settings(settings), json!({"name": "../evil"})).await;
        assert!(resp.error.is_some(), "a traversal-shaped name must be rejected");
        assert!(!dir.path().join("evil").exists());
    }

    #[tokio::test]
    async fn errors_with_no_resolvable_root() {
        let resp = call(state_with_settings(Settings::default()), json!({"name": "new-app"})).await;
        assert!(resp.error.is_some(), "no stored/inferable root must error, not guess");
    }

    #[tokio::test]
    async fn creates_the_folder_under_the_stored_root() {
        let dir = tempdir().unwrap();
        let mut settings = Settings::default();
        settings.extra.insert(
            "newProjectLastParent".to_string(),
            json!(dir.path().to_string_lossy()),
        );
        let resp = call(state_with_settings(settings), json!({"name": "new-app"})).await;
        assert!(resp.error.is_none(), "got {:?}", resp.error);
        let created = dir.path().join("new-app");
        assert!(created.is_dir());
        let returned = resp.result.unwrap()["path"].as_str().unwrap().to_string();
        assert_eq!(std::path::Path::new(&returned), created);
    }

    #[tokio::test]
    async fn registers_the_created_folder_as_a_known_project() {
        // Not tempdir(): upsert_project_for_cwd never registers a cwd under the OS temp dir.
        let dir = crate::settings::identity::test_support::non_ephemeral_tempdir();
        let mut settings = Settings::default();
        settings.extra.insert(
            "newProjectLastParent".to_string(),
            json!(dir.path().to_string_lossy()),
        );
        let state = state_with_settings(settings);
        let resp = call(state.clone(), json!({"name": "fresh"})).await;
        assert!(resp.error.is_none(), "got {:?}", resp.error);
        let returned = resp.result.unwrap()["path"].as_str().unwrap().to_string();
        assert!(
            crate::daemon::methods::pr_review::is_known_cwd(&state, &returned),
            "a just-created project must pass the cwd gate the new-chat RPCs use"
        );
    }

    #[tokio::test]
    async fn creates_the_folder_under_the_inferred_root() {
        let dir = tempdir().unwrap();
        let existing_a = dir.path().join("a");
        let existing_b = dir.path().join("b");
        std::fs::create_dir_all(&existing_a).unwrap();
        std::fs::create_dir_all(&existing_b).unwrap();
        let mut settings = Settings::default();
        settings.projects = vec![project(&existing_a), project(&existing_b)];
        let resp = call(state_with_settings(settings), json!({"name": "c"})).await;
        assert!(resp.error.is_none(), "got {:?}", resp.error);
        assert!(dir.path().join("c").is_dir());
    }

    #[tokio::test]
    async fn errors_clearly_when_the_folder_already_exists() {
        let dir = tempdir().unwrap();
        let mut settings = Settings::default();
        settings.extra.insert(
            "newProjectLastParent".to_string(),
            json!(dir.path().to_string_lossy()),
        );
        std::fs::create_dir_all(dir.path().join("dup")).unwrap();
        let resp = call(state_with_settings(settings), json!({"name": "dup"})).await;
        let err = resp.error.expect("already-existing folder must error");
        assert!(err.message.contains("already exists"), "got {:?}", err.message);
    }
}
