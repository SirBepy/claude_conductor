use crate::state::AppState;
use crate::types::{ProjectConfig, ProjectsSortBy};
use crate::settings::{self, paths};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};

/// Pure helpers extracted from the Tauri command wrappers so they can be
/// unit-tested without standing up a full app handle.
pub mod projects_test_helpers {
    use crate::types::{ProjectConfig, ProjectsSortBy, Settings};

    pub fn list_from(s: &Settings) -> Vec<ProjectConfig> { s.projects.clone() }

    pub fn get_from(s: &Settings, id: &str) -> Option<ProjectConfig> {
        s.projects.iter().find(|p| p.id == id).cloned()
    }

    /// Applies a partial JSON patch in-place. Unknown keys are ignored.
    /// Returns `true` if the project existed.
    pub enum UpdateErr {
        NotFound,
        InvalidPatch(String),
    }

    pub fn update_in(s: &mut Settings, id: &str, patch: serde_json::Value)
        -> Result<(), UpdateErr>
    {
        let Some(p) = s.projects.iter_mut().find(|p| p.id == id) else {
            return Err(UpdateErr::NotFound);
        };
        // Round-trip the project through JSON, apply the patch, deserialize
        // back. This gives us a free partial update without per-field code.
        let mut obj = serde_json::to_value(&*p).ok().and_then(|v| v.as_object().cloned()).unwrap_or_default();
        if let Some(patch_obj) = patch.as_object() {
            for (k, v) in patch_obj {
                obj.insert(k.clone(), v.clone());
            }
        }
        match serde_json::from_value::<ProjectConfig>(serde_json::Value::Object(obj)) {
            Ok(updated) => { *p = updated; Ok(()) }
            Err(e) => Err(UpdateErr::InvalidPatch(e.to_string())),
        }
    }

    pub fn delete_in(s: &mut Settings, id: &str) -> bool {
        let before = s.projects.len();
        s.projects.retain(|p| p.id != id);
        s.projects.len() < before
    }

    pub fn set_sort_by(s: &mut Settings, sort_by: ProjectsSortBy) {
        s.projects_sort_by = sort_by;
    }
}

pub mod legacy_import_test_helpers {
    use crate::types::{AutomationConfig, ProjectConfig, Settings};

    pub fn import_into(
        settings: &mut Settings,
        legacy_raw: &str,
        now: &str,
    ) -> Option<ProjectConfig> {
        let v: serde_json::Value = serde_json::from_str(legacy_raw).ok()?;
        let vault = v.get("vault_path").and_then(|p| p.as_str())?;
        let (id, _) = crate::settings::upsert_project_for_cwd(
            settings,
            std::path::Path::new(vault),
            now,
        );
        let p = settings.projects.iter_mut().find(|p| p.id == id).unwrap();
        if p.automation.is_none() {
            p.automation = Some(AutomationConfig {
                enabled: true,
                autostart_on_boot: v
                    .get("auto_registered_startup")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(true),
                session_name_prefix: None,
                continue_flag: true,
            });
        }
        Some(p.clone())
    }
}

#[tauri::command]
pub fn list_projects(state: State<AppState>) -> Vec<ProjectConfig> {
    projects_test_helpers::list_from(&state.settings.lock().unwrap())
}

#[tauri::command]
pub fn get_project(id: String, state: State<AppState>) -> Option<ProjectConfig> {
    projects_test_helpers::get_from(&state.settings.lock().unwrap(), &id)
}

/// Resolves the account a new chat under `cwd` should spawn on: the matching
/// project's own `preferred_account_id`, or its parent repo's binding when
/// `cwd` is a worktree with no binding of its own. Replaces the frontend's
/// old raw-path `.find()` (see `settings::identity::resolve_effective_preferred_account_id`).
#[tauri::command]
pub fn resolve_project_account(cwd: String, state: State<AppState>) -> Option<String> {
    let guard = state.settings.lock().unwrap();
    crate::settings::identity::resolve_effective_preferred_account_id(
        &guard.projects,
        std::path::Path::new(&cwd),
    )
}

/// Ensures a `ProjectConfig` exists for the given cwd. If one is already
/// registered (by project key) it is returned as-is; otherwise a fresh
/// entry is created via `upsert_project_for_cwd` and persisted. Exposed for
/// dashboard surfaces like the Project Detail view, which can open on a cwd
/// seen only via token-stats (never hooked) and thus absent from
/// `settings.projects`.
#[tauri::command]
pub fn ensure_project(
    cwd: String,
    state: State<AppState>,
    app: AppHandle,
) -> Result<ProjectConfig, String> {
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    let (project, changed, snapshot) = {
        let mut guard = state.settings.lock().unwrap();
        let (id, created) = crate::settings::upsert_project_for_cwd(
            &mut guard,
            std::path::Path::new(&cwd),
            &now,
        );
        let p = guard.projects.iter().find(|p| p.id == id)
            .cloned()
            .ok_or("project upsert produced no entry")?;
        (p, created, guard.clone())
    };
    if changed {
        let settings_path = paths::settings_file().map_err(|e| e.to_string())?;
        settings::save(&settings_path, &snapshot).map_err(|e| e.to_string())?;
        let _ = app.emit("settings-changed", snapshot);
    }
    Ok(project)
}

#[tauri::command]
pub fn update_project(
    id: String,
    patch: serde_json::Value,
    state: State<AppState>,
    app: AppHandle,
) -> Result<(), String> {
    let settings_path = paths::settings_file().map_err(|e| e.to_string())?;
    let snapshot = settings::mutate_and_save(&state.settings, &settings_path, |s| {
        match projects_test_helpers::update_in(s, &id, patch) {
            Ok(()) => Ok(()),
            Err(projects_test_helpers::UpdateErr::NotFound) => {
                Err(format!("project_not_found: {id}"))
            }
            Err(projects_test_helpers::UpdateErr::InvalidPatch(msg)) => {
                Err(format!("invalid_patch: {msg}"))
            }
        }
    })?;
    let _ = app.emit("settings-changed", snapshot);
    Ok(())
}

#[tauri::command]
pub fn delete_project(
    id: String,
    state: State<AppState>,
    app: AppHandle,
) -> Result<(), String> {
    let settings_path = paths::settings_file().map_err(|e| e.to_string())?;
    let snapshot = settings::mutate_and_save(&state.settings, &settings_path, |s| {
        if projects_test_helpers::delete_in(s, &id) {
            Ok(())
        } else {
            Err(format!("project_not_found: {id}"))
        }
    })?;
    let _ = app.emit("settings-changed", snapshot);
    Ok(())
}

#[tauri::command]
pub fn set_projects_sort_by(
    sort_by: ProjectsSortBy,
    state: State<AppState>,
    app: AppHandle,
) -> Result<(), String> {
    let settings_path = paths::settings_file().map_err(|e| e.to_string())?;
    let snapshot = settings::mutate_and_save(&state.settings, &settings_path, |s| {
        projects_test_helpers::set_sort_by(s, sort_by);
        Ok(())
    })?;
    let _ = app.emit("settings-changed", snapshot);
    Ok(())
}

/// Preview-only: reads the legacy obsidian_claude_remote config.json and
/// returns what WOULD be imported. Does NOT write settings. Returns None if
/// the user has already handled the prompt (accept or decline) in a prior
/// session, if there is no legacy file on disk, or if it lacks a vault_path.
#[tauri::command]
pub fn import_legacy_obsidian_config(
    state: State<AppState>,
) -> Result<Option<crate::types::ProjectConfig>, String> {
    {
        let guard = state.settings.lock().unwrap();
        if guard.legacy_obsidian_import_handled {
            return Ok(None);
        }
    }
    let Some(appdata) = dirs::config_dir() else { return Ok(None) };
    let config_path = appdata.join("obsidian_claude_remote").join("config.json");
    let raw = match std::fs::read_to_string(&config_path) {
        Ok(s) => s,
        Err(_) => return Ok(None),
    };
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    let mut preview = state.settings.lock().unwrap().clone();
    Ok(legacy_import_test_helpers::import_into(&mut preview, &raw, &now))
}

/// Commit the user's choice on the legacy import banner. When `accept` is
/// true, the legacy config is actually imported into settings. Either way,
/// the handled flag is set so the banner never shows again on future loads.
#[tauri::command]
pub fn confirm_legacy_obsidian_import(
    accept: bool,
    state: State<AppState>,
    app: AppHandle,
) -> Result<(), String> {
    let settings_path = paths::settings_file().map_err(|e| e.to_string())?;
    let snapshot = settings::mutate_and_save(&state.settings, &settings_path, |s| {
        if accept {
            if let Some(appdata) = dirs::config_dir() {
                let config_path = appdata.join("obsidian_claude_remote").join("config.json");
                if let Ok(raw) = std::fs::read_to_string(&config_path) {
                    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
                    let _ = legacy_import_test_helpers::import_into(s, &raw, &now);
                }
            }
        }
        s.legacy_obsidian_import_handled = true;
        Ok(())
    })?;
    let _ = app.emit("settings-changed", snapshot);
    Ok(())
}

/// Bulk existence check for project directories. Each `.exists()` is a
/// `stat` syscall and on Windows can stall on disconnected network drives,
/// so run on the blocking pool.
#[tauri::command]
pub async fn check_paths_exist(paths: Vec<String>) -> std::collections::HashMap<String, bool> {
    tauri::async_runtime::spawn_blocking(move || {
        paths
            .into_iter()
            .map(|p| {
                let exists = std::path::Path::new(&p).exists();
                (p, exists)
            })
            .collect()
    })
    .await
    .unwrap_or_default()
}

// --- Vault detector ---

#[tauri::command]
pub async fn detect_obsidian_vaults() -> Vec<std::path::PathBuf> {
    tauri::async_runtime::spawn_blocking(|| {
        crate::channels::vault_detector::detect().unwrap_or_default()
    })
    .await
    .unwrap_or_default()
}

#[cfg(test)]
mod mutate_and_save_tests {
    use super::*;
    use crate::types::Settings;
    use tempfile::tempdir;

    /// Parent-is-a-file forces `settings::save`'s `create_dir_all` to fail,
    /// deterministically and cross-platform (no reliance on OS
    /// read-only-permission semantics).
    fn unsavable_path(dir: &std::path::Path) -> std::path::PathBuf {
        let blocker = dir.join("blocker");
        std::fs::write(&blocker, "not a directory").unwrap();
        blocker.join("settings.json")
    }

    fn settings_with_one_project() -> (Mutex<Settings>, String) {
        let mut s = Settings::default();
        let (id, _created) = crate::settings::upsert_project_for_cwd(
            &mut s,
            std::path::Path::new("C:/proj"),
            "now",
        );
        (Mutex::new(s), id)
    }

    #[test]
    fn update_project_shape_leaves_cache_unchanged_on_failed_save() {
        let dir = tempdir().unwrap();
        let bad_path = unsavable_path(dir.path());
        let (settings, id) = settings_with_one_project();
        // upsert_project_for_cwd itself bumps generation to 1 on create; the
        // failed save below must not move it any further.
        let generation_before = settings.lock().unwrap().settings_generation;
        let patch = serde_json::json!({ "name": "renamed" });

        let result = settings::mutate_and_save(&settings, &bad_path, |s| {
            match projects_test_helpers::update_in(s, &id, patch) {
                Ok(()) => Ok(()),
                Err(projects_test_helpers::UpdateErr::NotFound) => {
                    Err(format!("project_not_found: {id}"))
                }
                Err(projects_test_helpers::UpdateErr::InvalidPatch(msg)) => {
                    Err(format!("invalid_patch: {msg}"))
                }
            }
        });

        assert!(result.is_err(), "save must fail against an unwritable path");
        let cached = settings.lock().unwrap();
        assert_ne!(cached.projects[0].name, "renamed", "cache must not carry the unsaved rename");
        assert_eq!(cached.settings_generation, generation_before, "generation must not bump on a failed save");
    }

    #[test]
    fn delete_project_shape_leaves_cache_unchanged_on_failed_save() {
        let dir = tempdir().unwrap();
        let bad_path = unsavable_path(dir.path());
        let (settings, id) = settings_with_one_project();
        // upsert_project_for_cwd itself bumps generation to 1 on create; the
        // failed save below must not move it any further.
        let generation_before = settings.lock().unwrap().settings_generation;

        let result = settings::mutate_and_save(&settings, &bad_path, |s| {
            if projects_test_helpers::delete_in(s, &id) {
                Ok(())
            } else {
                Err(format!("project_not_found: {id}"))
            }
        });

        assert!(result.is_err(), "save must fail against an unwritable path");
        let cached = settings.lock().unwrap();
        assert_eq!(cached.projects.len(), 1, "cache must still carry the project the failed save never removed");
        assert_eq!(cached.settings_generation, generation_before, "generation must not bump on a failed save");
    }

    /// `confirm_legacy_obsidian_import`'s closure does more than one site
    /// field: on `accept`, it imports a whole project via
    /// `legacy_import_test_helpers::import_into` before also flipping
    /// `legacy_obsidian_import_handled`. This proves the failed-save rollback
    /// discards BOTH the imported project and the flag, not just a single
    /// scalar - genuinely beyond what the generic helper test in
    /// settings/store.rs already proves for a single-field mutate.
    #[test]
    fn confirm_legacy_obsidian_import_shape_leaves_cache_unchanged_on_failed_save() {
        let dir = tempdir().unwrap();
        let bad_path = unsavable_path(dir.path());
        let settings = Mutex::new(Settings::default());
        let raw = r#"{"vault_path": "C:/legacy-vault"}"#;

        let result = settings::mutate_and_save(&settings, &bad_path, |s| {
            let _ = legacy_import_test_helpers::import_into(s, raw, "now");
            s.legacy_obsidian_import_handled = true;
            Ok(())
        });

        assert!(result.is_err(), "save must fail against an unwritable path");
        let cached = settings.lock().unwrap();
        assert!(!cached.legacy_obsidian_import_handled, "cache must not claim the banner was handled");
        assert!(cached.projects.is_empty(), "cache must not carry the imported project either");
        assert_eq!(cached.settings_generation, 0, "generation must not bump on a failed save");
    }
}


