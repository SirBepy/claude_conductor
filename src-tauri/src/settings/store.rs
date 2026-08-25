//! Load and save user settings to disk.

use crate::types::Settings;
use anyhow::{Context, Result};
use std::path::Path;
use tauri::{AppHandle, Emitter};

// Re-export identity helpers so existing call sites that reach into
// `settings::store::*` keep resolving without changes.
pub use super::identity::{
    find_repo_root, is_ephemeral_root_path, normalize_cwd_key, normalize_path, project_key, project_root,
};
use super::identity::dedupe_projects_by_path_key;

/// Probes each top-level key against an otherwise-default document: kept if it
/// round-trips alone, defaulted if not. Returns the keys it had to default;
/// empty means no single key reproduced the failure.
fn salvage_fields(v: &serde_json::Value) -> (Settings, Vec<String>) {
    let Some(obj) = v.as_object() else {
        return (Settings::default(), Vec::new());
    };
    let default_obj = match serde_json::to_value(Settings::default()) {
        Ok(serde_json::Value::Object(m)) => m,
        _ => return (Settings::default(), Vec::new()),
    };
    let mut candidate = default_obj.clone();
    let mut failed = Vec::new();
    for (key, val) in obj {
        let mut probe = default_obj.clone();
        probe.insert(key.clone(), val.clone());
        if serde_json::from_value::<Settings>(serde_json::Value::Object(probe)).is_ok() {
            candidate.insert(key.clone(), val.clone());
        } else {
            failed.push(key.clone());
        }
    }
    let settings = serde_json::from_value::<Settings>(serde_json::Value::Object(candidate))
        .unwrap_or_default();
    (settings, failed)
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
                            let (settings, failed) = salvage_fields(&v);
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
        return (p.id.clone(), false);
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
    });
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
    });
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
pub fn persist(app: &AppHandle, snapshot: &Settings) {
    if let Ok(path) = super::paths::settings_file() {
        let _ = save(&path, snapshot);
    }
    let _ = app.emit("settings-changed", snapshot);
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
}
