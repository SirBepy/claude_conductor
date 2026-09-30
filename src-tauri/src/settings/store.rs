//! Load and save user settings to disk.

use crate::types::Settings;
use anyhow::{Context, Result};
use std::path::Path;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

// Re-export identity helpers so existing call sites that reach into
// `settings::store::*` keep resolving without changes.
pub use super::identity::{
    find_repo_root, is_ephemeral_root_path, normalize_cwd_key, normalize_path, project_key, project_root,
};
use super::identity::dedupe_projects_by_path_key;

/// Adds each key onto a running document, re-parsing after every insertion,
/// so no key is ever kept until the whole document parses with it in. No
/// separate final re-parse can fail as a unit after per-field probes pass.
/// Returns the keys that never made it in.
fn salvage_fields<T>(v: &serde_json::Value) -> (T, Vec<String>)
where
    T: serde::Serialize + serde::de::DeserializeOwned + Default,
{
    let Some(obj) = v.as_object() else {
        return (T::default(), Vec::new());
    };
    let default_obj = match serde_json::to_value(T::default()) {
        Ok(serde_json::Value::Object(m)) => m,
        _ => return (T::default(), Vec::new()),
    };
    let mut accepted = default_obj.clone();
    let mut result = T::default();
    let mut failed = Vec::new();
    for (key, val) in obj {
        let mut candidate = accepted.clone();
        candidate.insert(key.clone(), val.clone());
        match serde_json::from_value::<T>(serde_json::Value::Object(candidate.clone())) {
            Ok(parsed) => {
                accepted = candidate;
                result = parsed;
            }
            Err(_) => failed.push(key.clone()),
        }
    }
    (result, failed)
}

/// Loads settings from disk, defaulting when the file is missing. An
/// unparsable file is renamed to `settings.json.broken-<unix-ts>` and then
/// salvaged key-by-key, so one bad field cannot discard the whole document.
pub fn load(path: &Path) -> Settings {
    load_with_notice(path).0
}

/// Same as `load`, plus a one-line, user-facing notice when the file had to
/// be salvaged or reset (`None` on a clean load). The caller surfaces this
/// once to the frontend - see `AppState::settings_load_notice`.
pub fn load_with_notice(path: &Path) -> (Settings, Option<String>) {
    let mut notice: Option<String> = None;
    let mut s: Settings = match std::fs::read_to_string(path) {
        Err(_) => Settings::default(),
        Ok(raw) => {
            let backup = |err: &serde_json::Error| -> std::path::PathBuf {
                let ts = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                let backup = path.with_extension(format!("json.broken-{ts}"));
                let _ = std::fs::rename(path, &backup);
                log::error!("[settings] parse failed ({err}); preserved at {}", backup.display());
                backup
            };
            match serde_json::from_str::<serde_json::Value>(&raw) {
                Err(err) => {
                    let backup_path = backup(&err);
                    log::error!("[settings] raw file was not valid JSON; loaded defaults");
                    notice = Some(format!(
                        "Some settings could not be read and were reset. Your previous file is kept as {}.",
                        backup_path.display()
                    ));
                    Settings::default()
                }
                Ok(mut v) => {
                    // Legacy snake_case → camelCase migration. We used to use
                    // `#[serde(alias = "auto_update")]` here, but ts-rs warns
                    // on `alias`, so the migration runs by hand instead.
                    if let Some(obj) = v.as_object_mut() {
                        if !obj.contains_key("autoUpdate") {
                            if let Some(legacy) = obj.remove("auto_update") {
                                obj.insert("autoUpdate".to_string(), legacy);
                            }
                        }
                    }
                    match serde_json::from_value::<Settings>(v.clone()) {
                        Ok(parsed) => parsed,
                        Err(err) => {
                            let backup_path = backup(&err);
                            let (settings, failed) = salvage_fields::<Settings>(&v);
                            if failed.is_empty() {
                                log::error!(
                                    "[settings] no single field reproduced the failure; loaded defaults"
                                );
                                notice = Some(format!(
                                    "Some settings could not be read and were reset. Your previous file is kept as {}.",
                                    backup_path.display()
                                ));
                            } else {
                                log::error!(
                                    "[settings] defaulted unparsable field(s) [{}], salvaged the rest",
                                    failed.join(", ")
                                );
                                notice = Some(format!(
                                    "Some settings ({}) could not be read and were reset; the rest were kept. Your previous file is kept as {}.",
                                    failed.join(", "),
                                    backup_path.display()
                                ));
                            }
                            settings
                        }
                    }
                }
            }
        }
    };
    // Migrate stale default from earlier tauri-rewrite builds that shipped
    // with a 1-hour poll before the 10-minute default landed. No UI ever
    // exposed this value, so any persisted 3600 is the old default, not
    // a user choice.
    if s.poll_interval_secs == 3600 {
        s.poll_interval_secs = 600;
    }
    // Migrate: drop the legacy projectNotifOverrides map. Replaced by
    // Avatar::Character on each ProjectConfig in v2 (Characters feature).
    s.extra.remove("projectNotifOverrides");
    dedupe_projects_by_path_key(&mut s.projects);
    (s, notice)
}

/// Finds or creates a `ProjectConfig` for this cwd. Returns `(id, created_new)`.
///
/// If the project already exists, updates `last_active_at`. If created,
/// populates `id` (uuid v4), `name` (basename), `avatar` (None), and
/// timestamps (`now` comes from the caller so tests can inject).
///
/// Skips persisting for `is_ephemeral_root_path` cwds - id stays
/// deterministic (keyed off `key`) so a repeat call agrees.
pub fn upsert_project_for_cwd(
    settings: &mut crate::types::Settings,
    cwd: &std::path::Path,
    now: &str,
) -> (String, bool) {
    let key = project_key(cwd);
    if let Some(p) = settings
        .projects
        .iter_mut()
        .find(|p| project_key(&p.path) == key)
    {
        p.last_active_at = Some(now.to_string());
        let id = p.id.clone();
        settings.bump_generation();
        return (id, false);
    }
    if is_ephemeral_root_path(cwd) {
        return (format!("ephemeral:{key}"), false);
    }
    // `project_root`, not `find_repo_root`: it also rolls a worktree up to
    // its main checkout, so the stored path/name match the key looked up
    // above instead of naming the worktree folder (todo 717).
    let root = project_root(cwd);
    let id = uuid::Uuid::new_v4().to_string();
    let name = root
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("(unknown)")
        .to_string();
    settings.projects.push(crate::types::ProjectConfig {
        id: id.clone(),
        path: root,
        name,
        avatar: crate::types::Avatar::None,
        automation: None,
        created_at: now.to_string(),
        last_active_at: Some(now.to_string()),
        whitelist: crate::types::CharacterWhitelist::default(),
        preferred_account_id: None,
        last_worktree_path: None,
        last_start_folder_rel: None,
        claude_ai_connectors: false,
    });
    settings.bump_generation();
    (id, true)
}

/// Companion to `upsert_project_for_cwd` for cases where the project_id was
/// already generated elsewhere (e.g. daemon-side registry). Idempotent: if a
/// project for `cwd` already exists with any id, this is a no-op. Also skips
/// persisting for `is_ephemeral_root_path` cwds, matching `upsert_project_for_cwd`.
pub fn upsert_project_with_id_for_cwd(
    settings: &mut crate::types::Settings,
    project_id: &str,
    cwd: &std::path::Path,
    now: &str,
) {
    let key = project_key(cwd);
    if settings
        .projects
        .iter()
        .any(|p| project_key(&p.path) == key)
    {
        return;
    }
    if is_ephemeral_root_path(cwd) {
        return;
    }
    let root = project_root(cwd);
    let name = root
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("(unknown)")
        .to_string();
    settings.projects.push(crate::types::ProjectConfig {
        id: project_id.to_string(),
        path: root,
        name,
        avatar: crate::types::Avatar::None,
        automation: None,
        created_at: now.to_string(),
        last_active_at: Some(now.to_string()),
        whitelist: crate::types::CharacterWhitelist::default(),
        preferred_account_id: None,
        last_worktree_path: None,
        last_start_folder_rel: None,
        claude_ai_connectors: false,
    });
    settings.bump_generation();
}

/// Saves settings to disk, creating parent dirs if needed.
pub fn save(path: &Path, settings: &Settings) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("creating parent dir {parent:?}"))?;
    }
    let raw = serde_json::to_string_pretty(settings)
        .context("serializing settings")?;
    // Write-temp-then-rename: a crash or kill mid-write truncates the temp
    // file, never `path` itself, so it can't produce the same torn-file
    // shape `load` has to salvage from.
    let tmp_path = path.with_extension(format!("json.tmp-{}", std::process::id()));
    std::fs::write(&tmp_path, raw)
        .with_context(|| format!("writing settings to {tmp_path:?}"))?;
    std::fs::rename(&tmp_path, path)
        .with_context(|| format!("renaming {tmp_path:?} to {path:?}"))?;
    Ok(())
}

/// Save `snapshot` to `settings_file()` and emit `settings-changed`. The
/// shared tail of every settings mutation (ai_todo 555/539 - was hand-rolled
/// six times).
///
/// Never emits `settings-changed` for a write that didn't land - a listener
/// (the UI, the daemon push) has no other way to tell a real save from a
/// silently-dropped one, so a failed `save` logs loudly instead and returns
/// without emitting.
pub fn persist(app: &AppHandle, snapshot: &Settings) {
    let path = match super::paths::settings_file() {
        Ok(path) => path,
        Err(e) => {
            log::error!("[settings] persist: could not resolve settings_file() path: {e:#}; settings NOT saved, settings-changed NOT emitted");
            return;
        }
    };
    if let Err(e) = save(&path, snapshot) {
        log::error!("[settings] persist: save to {path:?} failed: {e:#}; settings-changed NOT emitted");
        return;
    }
    let _ = app.emit("settings-changed", snapshot);
}

/// Error `save_settings` returns to the frontend for a stale save (todo
/// 1004): the frontend's `settings_generation` is behind the live value, so
/// accepting the save could silently revert any field a daemon-owned writer
/// touched since the frontend's snapshot was read - not just the three fields
/// the earlier merge-based fix (`44295410`) covered. The frontend's
/// `updateSettings` helper (`src/shared/settings-update.ts`) re-reads fresh
/// settings, reapplies its own mutation on top, and retries on this error.
pub const SETTINGS_STALE: &str = "SETTINGS_STALE";

/// Generation-checked reconciliation behind `ipc::settings::save_settings`.
/// `updated` is the frontend's about-to-be-saved snapshot; `current` is the
/// live in-memory settings, read under the SAME lock the caller uses to write
/// `updated` back to disk and cache right after.
///
/// Equal generations mean the frontend read the latest state, so `updated` is
/// accepted as-is and `updated.settings_generation` is advanced one past
/// `current`'s, so the disk write and the cache assignment the caller
/// performs next always agree with each other.
///
/// A behind generation means some other writer (a daemon-owned field write,
/// or another save) landed since that read: rather than merging a fixed
/// allowlist of fields (the old approach, which silently missed any
/// daemon-owned field not on the list - e.g. `default_account_id` cleared by
/// `remove_account`), this rejects the save outright with `SETTINGS_STALE`
/// and leaves `updated`/disk/cache untouched, so the caller can re-read and
/// retry with its edit reapplied on top of the current state instead.
pub fn reconcile_save(updated: &mut Settings, current: &Settings) -> Result<(), &'static str> {
    if updated.settings_generation != current.settings_generation {
        log::warn!(
            "[settings] save_settings: rejecting stale snapshot (generation {} behind live {})",
            updated.settings_generation, current.settings_generation,
        );
        return Err(SETTINGS_STALE);
    }
    updated.settings_generation = current.settings_generation.wrapping_add(1);
    Ok(())
}

/// Clones `settings`, applies `mutate` to the clone (which may reject the
/// change before any save is attempted), bumps the clone's generation, saves
/// it, and only on success commits the clone back as the new cache content -
/// all under one continuous lock so no other writer can interleave between
/// the read and the commit (todo 1020). On a failed mutate or a failed save
/// the cache (and its generation) are left exactly as they were. Infallible
/// callers just return `Ok(())` from `mutate`. Pure enough to unit-test
/// directly: no `State`/`AppHandle` needed, just a `Mutex` and a path. This
/// was three near-identical copies (hook_registration.rs, remote_access,
/// projects.rs) before being consolidated here alongside `reconcile_save`,
/// the other shared settings-write primitive.
pub fn mutate_and_save(
    settings: &Mutex<Settings>,
    path: &Path,
    mutate: impl FnOnce(&mut Settings) -> std::result::Result<(), String>,
) -> std::result::Result<Settings, String> {
    let mut guard = settings.lock().unwrap();
    let mut candidate = guard.clone();
    mutate(&mut candidate)?;
    candidate.bump_generation();
    save(path, &candidate).map_err(|e| e.to_string())?;
    *guard = candidate.clone();
    Ok(candidate)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::identity::test_support::non_ephemeral_tempdir;
    use crate::types::Settings;
    use tempfile::tempdir;

    #[test]
    fn load_missing_file_returns_defaults() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("nope.json");
        let s = load(&path);
        assert_eq!(s, Settings::default());
    }

    #[test]
    fn load_corrupt_file_returns_defaults() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(&path, "{ not valid json").unwrap();
        let s = load(&path);
        assert_eq!(s, Settings::default());
    }

    #[test]
    fn load_corrupt_file_preserves_original_so_save_cannot_clobber() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(&path, "{ not valid json").unwrap();
        let _ = load(&path);
        assert!(!path.exists(), "broken file must be moved aside");
        let backups: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with("settings.json.broken-")
            })
            .collect();
        assert_eq!(backups.len(), 1, "exactly one backup file");
    }

    #[test]
    fn load_migrates_legacy_snake_case_auto_update_key() {
        use crate::types::AutoUpdateMode;
        let dir = tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(&path, r#"{ "auto_update": false }"#).unwrap();
        let s = load(&path);
        assert_eq!(s.auto_update, AutoUpdateMode::Never);
    }

    #[test]
    fn save_then_load_roundtrips() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("sub").join("settings.json");
        let mut s = Settings::default();
        s.poll_interval_secs = 42;
        save(&path, &s).unwrap();
        let back = load(&path);
        assert_eq!(s, back);
    }

    #[test]
    fn upsert_creates_when_absent() {
        let mut s = Settings::default();
        let (id, created) = upsert_project_for_cwd(&mut s, std::path::Path::new("C:/new"), "now");
        assert!(created);
        assert_eq!(s.projects.len(), 1);
        assert_eq!(s.projects[0].id, id);
        assert_eq!(s.projects[0].path, std::path::PathBuf::from("C:/new"));
        assert_eq!(s.projects[0].name, "new");
    }

    #[test]
    fn upsert_returns_existing_when_path_matches() {
        let mut s = Settings::default();
        let (id1, _) = upsert_project_for_cwd(&mut s, std::path::Path::new("C:/same"), "now");
        let (id2, created) = upsert_project_for_cwd(&mut s, std::path::Path::new("C:/same"), "later");
        assert!(!created);
        assert_eq!(id1, id2);
        assert_eq!(s.projects.len(), 1);
        assert_eq!(s.projects[0].last_active_at.as_deref(), Some("later"));
    }

    #[test]
    fn upsert_skips_persisting_for_ephemeral_cwd() {
        let mut s = Settings::default();
        let temp_cwd = std::env::temp_dir().join("skill-eval-cwd-abc123");
        let (id, created) = upsert_project_for_cwd(&mut s, &temp_cwd, "now");
        assert!(!created, "ephemeral cwd must never mint a persisted project");
        assert!(s.projects.is_empty());
        assert!(!id.is_empty());
    }

    #[test]
    fn upsert_returns_stable_id_for_repeated_ephemeral_cwd() {
        // Nothing is persisted, so a naive fresh-uuid-per-miss would hand
        // two callers for the same session two different ids.
        let mut s = Settings::default();
        let temp_cwd = std::env::temp_dir().join("skill-eval-cwd-abc123");
        let (id1, _) = upsert_project_for_cwd(&mut s, &temp_cwd, "t1");
        let (id2, _) = upsert_project_for_cwd(&mut s, &temp_cwd, "t2");
        assert_eq!(id1, id2);
    }

    #[cfg(windows)]
    #[test]
    fn upsert_merges_case_variants_on_windows() {
        let mut s = Settings::default();
        let (id1, _) = upsert_project_for_cwd(
            &mut s,
            std::path::Path::new("C:\\Users\\joe\\proj"),
            "t1",
        );
        let (id2, created) = upsert_project_for_cwd(
            &mut s,
            std::path::Path::new("c:\\users\\JOE\\proj"),
            "t2",
        );
        assert!(!created, "same folder with different casing must not split");
        assert_eq!(id1, id2);
        assert_eq!(s.projects.len(), 1);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn upsert_merges_case_variants_on_macos() {
        let mut s = Settings::default();
        let (id1, _) = upsert_project_for_cwd(
            &mut s,
            std::path::Path::new("/Users/joe/Proj"),
            "t1",
        );
        let (id2, created) = upsert_project_for_cwd(
            &mut s,
            std::path::Path::new("/users/JOE/proj"),
            "t2",
        );
        assert!(!created, "same folder with different casing must not split");
        assert_eq!(id1, id2);
        assert_eq!(s.projects.len(), 1);
    }

    #[test]
    fn upsert_merges_separator_variants() {
        let mut s = Settings::default();
        let (id1, _) = upsert_project_for_cwd(&mut s, std::path::Path::new("C:\\a\\b"), "t1");
        let (id2, created) = upsert_project_for_cwd(&mut s, std::path::Path::new("C:/a/b"), "t2");
        assert!(!created);
        assert_eq!(id1, id2);
        assert_eq!(s.projects.len(), 1);
    }

    #[test]
    fn upsert_merges_trailing_separator() {
        let mut s = Settings::default();
        let (id1, _) = upsert_project_for_cwd(&mut s, std::path::Path::new("C:\\a\\b"), "t1");
        let (id2, created) = upsert_project_for_cwd(&mut s, std::path::Path::new("C:\\a\\b\\"), "t2");
        assert!(!created);
        assert_eq!(id1, id2);
        assert_eq!(s.projects.len(), 1);
    }

    #[test]
    fn upsert_rolls_a_worktree_up_to_the_main_repo_root() {
        let dir = non_ephemeral_tempdir();
        let repo = dir.path().join("myrepo");
        std::fs::create_dir_all(repo.join(".git")).unwrap();
        let worktree = repo.join(".claude").join("worktrees").join("feature-x");
        std::fs::create_dir_all(&worktree).unwrap();
        let gitdir = repo.join(".git").join("worktrees").join("feature-x");
        std::fs::create_dir_all(&gitdir).unwrap();
        std::fs::write(worktree.join(".git"), format!("gitdir: {}\n", gitdir.to_string_lossy())).unwrap();

        let mut s = Settings::default();
        let (id1, _) = upsert_project_for_cwd(&mut s, &worktree, "t1");
        let (id2, created) = upsert_project_for_cwd(&mut s, &repo, "t2");

        assert!(!created, "a worktree and its main checkout are one project");
        assert_eq!(id1, id2);
        assert_eq!(s.projects.len(), 1);
        // Created from the worktree cwd, yet named/rooted at the main repo:
        // rolling up only the dedup key would store "feature-x" here.
        assert_eq!(s.projects[0].path, repo);
        assert_eq!(s.projects[0].name, "myrepo");
    }

    #[test]
    fn upsert_rolls_subfolder_up_to_repo_root() {
        let dir = non_ephemeral_tempdir();
        let repo = dir.path().join("myrepo");
        let sub = repo.join("packages").join("app");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::create_dir_all(repo.join(".git")).unwrap();

        let mut s = Settings::default();
        let (id1, _) = upsert_project_for_cwd(&mut s, &repo, "t1");
        let (id2, created) = upsert_project_for_cwd(&mut s, &sub, "t2");

        assert!(!created, "subfolder of a known repo must reuse the repo entry");
        assert_eq!(id1, id2);
        assert_eq!(s.projects.len(), 1);
        // Path stays at the repo root regardless of which cwd was passed.
        assert_eq!(s.projects[0].path, repo);
        assert_eq!(s.projects[0].name, "myrepo");
    }

    #[test]
    fn upsert_creates_subfolder_entry_when_not_in_repo() {
        let dir = non_ephemeral_tempdir();
        let p = dir.path().join("plain");
        std::fs::create_dir_all(&p).unwrap();
        let mut s = Settings::default();
        let (_id, created) = upsert_project_for_cwd(&mut s, &p, "t1");
        assert!(created);
        assert_eq!(s.projects[0].name, "plain");
    }

    #[test]
    fn load_collapses_subfolder_into_repo_root_entry() {
        let dir = tempdir().unwrap();
        let repo = dir.path().join("repo");
        let sub = repo.join("inner");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::create_dir_all(repo.join(".git")).unwrap();
        let path = dir.path().join("settings.json");
        let raw = format!(
            r#"{{
                "projects": [
                    {{
                        "id": "first",
                        "path": {repo:?},
                        "name": "repo",
                        "created_at": "2026-04-01T00:00:00Z",
                        "last_active_at": "2026-04-10T00:00:00Z"
                    }},
                    {{
                        "id": "second",
                        "path": {sub:?},
                        "name": "inner",
                        "created_at": "2026-04-05T00:00:00Z",
                        "last_active_at": "2026-04-20T00:00:00Z"
                    }}
                ]
            }}"#,
            repo = repo.to_string_lossy().replace('\\', "\\\\"),
            sub = sub.to_string_lossy().replace('\\', "\\\\"),
        );
        std::fs::write(&path, raw).unwrap();
        let s = load(&path);
        assert_eq!(s.projects.len(), 1, "subfolder entry must merge into repo entry");
        assert_eq!(s.projects[0].id, "first");
        assert_eq!(
            s.projects[0].last_active_at.as_deref(),
            Some("2026-04-20T00:00:00Z"),
            "latest last_active_at wins",
        );
    }

    #[test]
    fn load_collapses_duplicate_projects_on_disk() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let raw = r#"{
            "projects": [
                {
                    "id": "first",
                    "path": "C:\\users\\joe\\proj",
                    "name": "proj",
                    "created_at": "2026-04-01T00:00:00Z",
                    "last_active_at": "2026-04-10T00:00:00Z"
                },
                {
                    "id": "second",
                    "path": "C:/Users/Joe/proj",
                    "name": "proj",
                    "avatar": {"kind": "emoji", "value": "🦊"},
                    "created_at": "2026-03-01T00:00:00Z",
                    "last_active_at": "2026-04-20T00:00:00Z"
                }
            ]
        }"#;
        std::fs::write(&path, raw).unwrap();
        let s = load(&path);
        assert_eq!(s.projects.len(), 1, "duplicates must collapse");
        let p = &s.projects[0];
        assert_eq!(p.id, "first", "survivor keeps earliest-seen id");
        assert_eq!(p.created_at, "2026-03-01T00:00:00Z", "oldest created_at wins");
        assert_eq!(
            p.last_active_at.as_deref(),
            Some("2026-04-20T00:00:00Z"),
            "latest last_active_at wins",
        );
        assert!(
            matches!(p.avatar, crate::types::Avatar::Emoji(ref e) if e == "🦊"),
            "avatar from duplicate propagates when survivor had none",
        );
    }

    /// Redacted copy of a real `settings.json.broken-*` recovered on
    /// 2026-08-22. Its `retention` object predates the `skipped_questions`
    /// dataset, so it is present-but-incomplete: the shape that used to
    /// reject the whole document and wipe 7 top-level keys.
    const BROKEN_FIXTURE: &str =
        include_str!("../../tests/fixtures/settings_broken_1787406007.json");

    /// The root-cause guard. `RetentionPolicies` carries `#[serde(default)]`,
    /// so an older `retention` object missing a newer dataset key no longer
    /// fails. Remove that attribute and this test goes red.
    #[test]
    fn a_retention_object_predating_a_dataset_still_parses() {
        let v: serde_json::Value = serde_json::from_str(BROKEN_FIXTURE).unwrap();
        let s = serde_json::from_value::<Settings>(v)
            .expect("an older retention object must not reject the whole document");

        assert_eq!(s.default_account_id.as_deref(), Some("11111111-1111-1111-1111-111111111111"));
        for key in [
            "defaultAutoAllow",
            "defaultRemoteControl",
            "models",
            "effortPresets",
            "colorThresholds",
            "newProjectLastParent",
            "newsNotificationsEnabled",
            "statuslineRows",
        ] {
            assert!(s.extra.contains_key(key), "{key} must survive");
        }
        assert_eq!(
            s.retention.skipped_questions,
            crate::storage::RetentionPolicies::default().skipped_questions,
        );
    }

    #[test]
    fn a_clean_load_moves_nothing_aside_and_raises_no_notice() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(&path, BROKEN_FIXTURE).unwrap();
        let (s, notice) = load_with_notice(&path);

        assert!(path.exists(), "a parseable file must not be moved aside");
        assert!(notice.is_none(), "a clean load must not nag the user");
        assert_eq!(s.extra.get("defaultAutoAllow"), Some(&serde_json::json!(true)));
    }

    /// The safety net, for a field no default can rescue: `retention` present
    /// but the wrong TYPE. Everything else must still survive.
    #[test]
    fn load_salvages_every_other_key_when_one_field_is_unparsable() {
        let mut v: serde_json::Value = serde_json::from_str(BROKEN_FIXTURE).unwrap();
        v["retention"] = serde_json::json!("not an object");
        let dir = tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(&path, serde_json::to_string(&v).unwrap()).unwrap();

        let (s, notice) = load_with_notice(&path);

        assert!(!path.exists(), "an unsalvageable file must be moved aside");
        assert!(notice.is_some_and(|n| n.contains("retention")), "the notice must name the field");
        assert_eq!(s.retention, crate::storage::RetentionPolicies::default());
        assert_eq!(s.default_account_id.as_deref(), Some("11111111-1111-1111-1111-111111111111"));
        assert_eq!(s.extra.get("defaultAutoAllow"), Some(&serde_json::json!(true)));
        assert!(s.extra.contains_key("statuslineRows"), "statuslineRows must survive");
    }

    /// The `ProjectConfig` half of todo 785, at the `load()` pipeline level:
    /// one project missing a required field drops only itself, so this is a
    /// CLEAN load (unlike the retention safety-net test above) - no backup
    /// file, no notice, every other project and top-level key intact.
    #[test]
    fn load_drops_only_the_unparsable_project_and_keeps_the_rest_clean() {
        let mut v: serde_json::Value = serde_json::from_str(BROKEN_FIXTURE).unwrap();
        v["projects"] = serde_json::json!([
            { "id": "keep", "path": "C:/keep", "name": "keep", "created_at": "2026-01-01T00:00:00Z" },
            { "path": "C:/broken", "name": "broken", "created_at": "2026-01-01T00:00:00Z" }
        ]);
        let dir = tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(&path, serde_json::to_string(&v).unwrap()).unwrap();

        let (s, notice) = load_with_notice(&path);

        assert!(path.exists(), "a project entry alone must not trigger the broken-file path");
        assert!(notice.is_none(), "one bad project must not nag the user");
        assert_eq!(s.projects.len(), 1, "the broken entry drops, the good one survives");
        assert_eq!(s.projects[0].id, "keep");
        assert_eq!(s.default_account_id.as_deref(), Some("11111111-1111-1111-1111-111111111111"));
        assert_eq!(s.extra.get("defaultAutoAllow"), Some(&serde_json::json!(true)));
    }

    /// Todo 787: `AutomationConfig` carries `#[serde(default)]`, so a project's
    /// `automation` object predating a newer field no longer fails that
    /// project entry. Remove that attribute and this test goes red.
    #[test]
    fn an_automation_object_predating_a_field_still_parses() {
        let mut v: serde_json::Value = serde_json::from_str(BROKEN_FIXTURE).unwrap();
        v["projects"] = serde_json::json!([
            {
                "id": "keep",
                "path": "C:/keep",
                "name": "keep",
                "created_at": "2026-01-01T00:00:00Z",
                "automation": { "enabled": true, "autostart_on_boot": true }
            }
        ]);
        let s = serde_json::from_value::<Settings>(v)
            .expect("an older automation object must not reject the project entry");

        assert_eq!(s.projects.len(), 1);
        let automation = s.projects[0]
            .automation
            .as_ref()
            .expect("automation must still parse");
        assert!(automation.enabled);
        assert!(automation.autostart_on_boot);
        assert_eq!(automation.continue_flag, bool::default());
        assert_eq!(automation.session_name_prefix, None);
    }

    /// Manufactures the conflict real `Settings` cannot reproduce (todo
    /// 797's caveat): `a` and `b` each parse fine alone but reject each
    /// other's presence together.
    #[derive(serde::Serialize, Default, Debug, PartialEq)]
    #[serde(default)]
    struct ConflictProbe {
        a: bool,
        b: bool,
    }

    impl<'de> serde::Deserialize<'de> for ConflictProbe {
        fn deserialize<D>(d: D) -> Result<Self, D::Error>
        where
            D: serde::Deserializer<'de>,
        {
            #[derive(serde::Deserialize, Default)]
            #[serde(default)]
            struct Raw {
                a: bool,
                b: bool,
            }
            let raw = Raw::deserialize(d)?;
            if raw.a && raw.b {
                return Err(serde::de::Error::custom("a and b cannot both be true"));
            }
            Ok(ConflictProbe { a: raw.a, b: raw.b })
        }
    }

    #[test]
    fn salvage_fields_reports_a_conflict_it_could_not_apply_instead_of_claiming_it() {
        let v = serde_json::json!({ "a": true, "b": true });
        let (result, failed) = salvage_fields::<ConflictProbe>(&v);

        // A probe-only implementation would report `failed` as empty while
        // actually keeping just one field - a false "everything kept".
        assert!(!failed.is_empty(), "the conflicting key must be reported, not silently dropped");
        assert!(!(result.a && result.b), "the returned value must be a state that actually parsed");
        if result.a {
            assert_eq!(failed, vec!["b".to_string()]);
        } else if result.b {
            assert_eq!(failed, vec!["a".to_string()]);
        } else {
            panic!("neither key was applied; the accepted default state was never overwritten");
        }
    }

    /// Reproduces the confirmed settings-loss race, now closed by rejection
    /// rather than a merge: a daemon-side mutation (project auto-registration)
    /// lands on `state.settings` while a Settings panel is still holding a
    /// snapshot read moments earlier. `reconcile_save` must refuse the stale
    /// save (leaving the daemon's project alone) instead of accepting it and
    /// dropping the mutation the old blind `*s = updated.clone()` used to.
    #[test]
    fn reconcile_save_rejects_a_save_built_from_a_stale_snapshot_leaving_current_untouched() {
        let dir = non_ephemeral_tempdir();
        let now = "2026-09-28T00:00:00Z";

        // What the Settings panel read via get_settings, before the race.
        let frontend_snapshot = Settings::default();

        // Daemon-side mutation lands after that read (mirrors
        // daemon_link/handlers.rs::handle_project_created).
        let mut current = frontend_snapshot.clone();
        upsert_project_with_id_for_cwd(&mut current, "proj-1", dir.path(), now);
        let current_before = current.clone();
        assert_eq!(current.projects.len(), 1, "setup: the daemon-side mutation must actually land");

        // The frontend's Save is built from its stale snapshot, not `current`,
        // plus the user's real edit.
        let mut updated = frontend_snapshot.clone();
        updated.autostart = true;
        let updated_before = updated.clone();

        let result = reconcile_save(&mut updated, &current);

        assert_eq!(result, Err(SETTINGS_STALE));
        assert_eq!(updated, updated_before, "a rejected save must leave `updated` untouched");
        assert_eq!(current, current_before, "a rejected save must leave `current` untouched");
    }

    /// A frontend edit to a daemon-owned field (`default_account_id`, cleared
    /// by `remove_account`) is the concrete gap the old three-field merge
    /// allowlist could not close - it was never one of the three merged
    /// fields, and a clear is not additive. Rejection closes it for free: the
    /// save never applies, so the daemon's clear can't be reverted.
    #[test]
    fn reconcile_save_rejects_regardless_of_which_daemon_owned_field_moved() {
        let mut current = Settings::default();
        current.default_account_id = Some("acct-1".to_string());
        current.bump_generation();
        // Daemon-side clear (mirrors ipc/accounts/management.rs::remove_account).
        current.default_account_id = None;

        let mut updated = Settings::default();
        updated.default_account_id = Some("acct-1".to_string()); // the stale value

        let result = reconcile_save(&mut updated, &current);

        assert_eq!(result, Err(SETTINGS_STALE));
        assert_eq!(updated.default_account_id.as_deref(), Some("acct-1"), "rejected save leaves `updated` untouched");
    }

    // -----------------------------------------------------------------
    // todo 1004: settings_generation / reconcile_save
    // -----------------------------------------------------------------

    #[test]
    fn bump_generation_increments_and_returns_the_new_value() {
        let mut s = Settings::default();
        assert_eq!(s.settings_generation, 0);
        assert_eq!(s.bump_generation(), 1);
        assert_eq!(s.settings_generation, 1);
        assert_eq!(s.bump_generation(), 2);
    }

    /// A fresh save (the frontend's snapshot generation matches the live one)
    /// must be accepted exactly as sent - no merge - and must still advance
    /// the generation counter so a subsequent stale save from an older reader
    /// is correctly detected as behind.
    #[test]
    fn reconcile_save_with_current_generation_writes_exactly_what_was_sent_and_bumps() {
        let mut current = Settings::default();
        current.bump_generation(); // generation 1, as if some earlier write happened
        current.jarvis_session_id = Some("daemon-value".to_string());

        // Frontend read generation 1, then made its own edit plus dropped the
        // jarvis field from its own local model (nothing daemon-owned changed
        // in between, so this must NOT be treated as a loss).
        let mut updated = current.clone();
        updated.jarvis_session_id = None;
        updated.autostart = false;

        let result = reconcile_save(&mut updated, &current);

        assert_eq!(result, Ok(()));
        assert_eq!(
            updated.jarvis_session_id, None,
            "an up-to-date save is trusted as-is"
        );
        assert!(!updated.autostart);
        assert_eq!(
            updated.settings_generation,
            current.settings_generation + 1,
            "a save must advance the generation past the value it was checked against"
        );
    }

    /// A stale save (frontend generation behind the live one) must be
    /// rejected wholesale rather than merged, and must leave `current`'s own
    /// generation untouched - only an accepted save advances the counter.
    #[test]
    fn reconcile_save_with_stale_generation_is_rejected_and_current_generation_is_unchanged() {
        let dir = non_ephemeral_tempdir();
        let now = "2026-09-29T00:00:00Z";

        let frontend_snapshot = Settings::default(); // generation 0, as read

        let mut current = frontend_snapshot.clone();
        upsert_project_with_id_for_cwd(&mut current, "proj-1", dir.path(), now);
        // upsert bumped current's generation past the frontend's stale read.
        assert!(current.settings_generation > frontend_snapshot.settings_generation);
        let current_generation_before = current.settings_generation;

        let mut updated = frontend_snapshot.clone();
        updated.autostart = true;

        let result = reconcile_save(&mut updated, &current);

        assert_eq!(result, Err(SETTINGS_STALE));
        assert_eq!(updated.projects.len(), 0, "a rejected save is not merged with the daemon's project");
        assert_eq!(current.settings_generation, current_generation_before, "a rejected save must not touch `current`");
    }

    /// `extra` must round-trip through `reconcile_save` untouched on the
    /// accepted path - a bump that dropped it would itself be the data-loss
    /// bug this todo is about.
    #[test]
    fn reconcile_save_preserves_extra_on_the_accepted_path() {
        let mut current = Settings::default();
        current.extra.insert("someDashboardOnlyField".to_string(), serde_json::json!("keep-me"));

        let mut fresh = current.clone();
        let result = reconcile_save(&mut fresh, &current);
        assert_eq!(result, Ok(()));
        assert_eq!(
            fresh.extra.get("someDashboardOnlyField"),
            Some(&serde_json::json!("keep-me")),
        );
    }

    /// `upsert_project_for_cwd` mutates the live guard on every call (either
    /// creating a project or touching `last_active_at` on an existing one),
    /// so both branches must bump the generation - this is the helper every
    /// project-writing call site (`ensure_project`, `handle_project_created`'s
    /// sibling `upsert_project_with_id_for_cwd`, the legacy-import path) relies
    /// on to bump on its behalf instead of remembering to call
    /// `bump_generation` itself.
    #[test]
    fn upsert_project_for_cwd_bumps_generation_on_create_and_on_update() {
        let mut s = Settings::default();
        let (_, created) = upsert_project_for_cwd(&mut s, std::path::Path::new("C:/new"), "t1");
        assert!(created);
        assert_eq!(s.settings_generation, 1, "creating a project must bump");

        let (_, created2) = upsert_project_for_cwd(&mut s, std::path::Path::new("C:/new"), "t2");
        assert!(!created2);
        assert_eq!(s.settings_generation, 2, "touching last_active_at on an existing project must also bump");
    }

    /// `upsert_project_with_id_for_cwd` is a no-op when the project already
    /// exists (unlike its sibling above, which still updates `last_active_at`)
    /// - it must not bump the generation for a call that changed nothing.
    #[test]
    fn upsert_project_with_id_for_cwd_bumps_only_when_it_actually_inserts() {
        let dir = non_ephemeral_tempdir();
        let mut s = Settings::default();
        upsert_project_with_id_for_cwd(&mut s, "proj-1", dir.path(), "t1");
        assert_eq!(s.settings_generation, 1);

        upsert_project_with_id_for_cwd(&mut s, "proj-1", dir.path(), "t2");
        assert_eq!(s.settings_generation, 1, "a no-op call for an already-registered project must not bump");
    }

    /// Parent-is-a-file forces `save`'s `create_dir_all` to fail,
    /// deterministically and cross-platform (no reliance on OS
    /// read-only-permission semantics).
    fn unsavable_path(dir: &std::path::Path) -> std::path::PathBuf {
        let blocker = dir.join("blocker");
        std::fs::write(&blocker, "not a directory").unwrap();
        blocker.join("settings.json")
    }

    #[test]
    fn mutate_and_save_leaves_cache_unchanged_on_failed_save() {
        let dir = tempdir().unwrap();
        let bad_path = unsavable_path(dir.path());
        let settings = Mutex::new(Settings::default());

        let result = mutate_and_save(&settings, &bad_path, |s| {
            s.hooks_registered = true;
            Ok(())
        });

        assert!(result.is_err(), "save must fail against an unwritable path");
        let cached = settings.lock().unwrap();
        assert!(!cached.hooks_registered, "cache must not carry the unsaved mutation");
        assert_eq!(cached.settings_generation, 0, "generation must not bump on a failed save");
    }

    #[test]
    fn mutate_and_save_leaves_cache_unchanged_when_mutate_rejects() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let settings = Mutex::new(Settings::default());

        let result = mutate_and_save(&settings, &path, |_s| {
            Err("rejected before any save attempt".to_string())
        });

        assert!(result.is_err());
        let cached = settings.lock().unwrap();
        assert_eq!(cached.settings_generation, 0, "a mutate rejection must never reach save or bump generation");
        assert!(!path.exists(), "a rejected mutate must never touch disk");
    }

    #[test]
    fn mutate_and_save_commits_cache_on_successful_save() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let settings = Mutex::new(Settings::default());

        let result = mutate_and_save(&settings, &path, |s| {
            s.hooks_registered = true;
            Ok(())
        });

        assert!(result.is_ok());
        let cached = settings.lock().unwrap();
        assert!(cached.hooks_registered);
        assert_eq!(cached.settings_generation, 1);
        assert!(path.exists(), "a successful save must land on disk");
    }
}
