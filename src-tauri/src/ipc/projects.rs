use crate::state::AppState;
use crate::types::{ProjectConfig, ProjectsSortBy};
use crate::settings::{self, paths};
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
    let mut guard = state.settings.lock().unwrap();
    match projects_test_helpers::update_in(&mut guard, &id, patch) {
        Ok(()) => {}
        Err(projects_test_helpers::UpdateErr::NotFound) => {
            return Err(format!("project_not_found: {id}"));
        }
        Err(projects_test_helpers::UpdateErr::InvalidPatch(msg)) => {
            return Err(format!("invalid_patch: {msg}"));
        }
    }
    settings::save(&settings_path, &guard).map_err(|e| e.to_string())?;
    let snapshot = guard.clone();
    drop(guard);
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
    let mut guard = state.settings.lock().unwrap();
    if !projects_test_helpers::delete_in(&mut guard, &id) {
        return Err(format!("project_not_found: {id}"));
    }
    settings::save(&settings_path, &guard).map_err(|e| e.to_string())?;
    let snapshot = guard.clone();
    drop(guard);
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
    let mut guard = state.settings.lock().unwrap();
    projects_test_helpers::set_sort_by(&mut guard, sort_by);
    settings::save(&settings_path, &guard).map_err(|e| e.to_string())?;
    let snapshot = guard.clone();
    drop(guard);
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
    let snapshot = {
        let mut guard = state.settings.lock().unwrap();
        if accept {
            if let Some(appdata) = dirs::config_dir() {
                let config_path = appdata.join("obsidian_claude_remote").join("config.json");
                if let Ok(raw) = std::fs::read_to_string(&config_path) {
                    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
                    let _ = legacy_import_test_helpers::import_into(&mut guard, &raw, &now);
                }
            }
        }
        guard.legacy_obsidian_import_handled = true;
        guard.clone()
    };
    let settings_path = paths::settings_file().map_err(|e| e.to_string())?;
    settings::save(&settings_path, &snapshot).map_err(|e| e.to_string())?;
    let _ = app.emit("settings-changed", snapshot);
    Ok(())
}

/// Open a filesystem path in the OS file manager (Explorer on Windows,
/// Finder on macOS, default handler on Linux). Intentionally does NOT
/// suppress the console window because explorer/open/xdg-open ARE the
/// user-facing window the click is asking for.
#[tauri::command]
pub async fn open_in_explorer(path: String) -> Result<(), String> {
    if path.is_empty() { return Err("empty path".into()) }
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(target_os = "windows")]
        {
            std::process::Command::new("explorer")
                .arg(&path)
                .spawn()
                .map(|_| ())
                .map_err(|e| format!("explorer spawn failed: {e}"))
        }
        #[cfg(target_os = "macos")]
        {
            std::process::Command::new("open").arg(&path).spawn()
                .map(|_| ()).map_err(|e| format!("open spawn failed: {e}"))
        }
        #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
        {
            std::process::Command::new("xdg-open").arg(&path).spawn()
                .map(|_| ()).map_err(|e| format!("xdg-open spawn failed: {e}"))
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Open a folder in VS Code.
#[tauri::command]
pub async fn open_in_vscode(path: String) -> Result<(), String> {
    if path.is_empty() { return Err("empty path".into()) }
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(target_os = "windows")]
        {
            // VS Code on Windows ships only as `code.cmd`, so launch via
            // cmd.exe /C. Hide the console window the cmd shim would otherwise
            // flash.
            let mut cmd = std::process::Command::new("cmd");
            cmd.args(["/C", "code", "-n", &path]);
            crate::util::process::hide_console(&mut cmd);
            cmd.spawn()
                .map(|_| ())
                .map_err(|e| format!("code launch failed: {e}"))
        }
        #[cfg(not(target_os = "windows"))]
        {
            let mut cmd = std::process::Command::new("code");
            cmd.args(["-n", &path]);
            crate::util::process::hide_console(&mut cmd);
            cmd.spawn()
                .map(|_| ())
                .map_err(|e| format!("code launch failed: {e}"))
        }
    })
    .await
    .map_err(|e| e.to_string())?
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

// --- Instances ---

#[tauri::command]
pub fn list_instances(state: State<AppState>) -> Vec<crate::types::Instance> {
    state.cached_instances.lock().unwrap().clone()
}

#[tauri::command]
pub async fn is_daemon_connected(state: State<'_, AppState>) -> Result<bool, ()> {
    Ok(state.daemon_client.lock().await.is_some())
}

#[tauri::command]
pub fn list_instances_for_project(
    project_id: String,
    state: State<AppState>,
) -> Vec<crate::types::Instance> {
    state
        .cached_instances
        .lock()
        .unwrap()
        .iter()
        .filter(|i| i.project_id == project_id)
        .cloned()
        .collect()
}

#[tauri::command]
pub fn phone_link(session_id: String, state: State<AppState>) -> Option<String> {
    let inst = state
        .cached_instances
        .lock()
        .unwrap()
        .iter()
        .find(|i| i.session_id == session_id)
        .cloned()?;
    let bridge = inst.bridge_session_id?;
    Some(format!("https://claude.ai/code/{bridge}"))
}

#[tauri::command]
pub fn instance_token_stats(session_id: String, state: State<AppState>) -> serde_json::Value {
    let empty = serde_json::json!({ "tokens": 0, "turns": 0, "prompts": 0 });
    let Some(inst) = state
        .cached_instances
        .lock()
        .unwrap()
        .iter()
        .find(|i| i.session_id == session_id)
        .cloned()
    else { return empty };
    let path = match inst.transcript_path.as_ref() {
        Some(p) if p.exists() => p.clone(),
        _ => match crate::tokens::transcript_for_session(&inst.cwd, &inst.session_id)
            .or_else(|| crate::tokens::latest_transcript_for_cwd(&inst.cwd))
        {
            Some(p) => p,
            None => return empty,
        },
    };
    let t = crate::tokens::parse_transcript(&path);
    let total = t.input_tokens + t.output_tokens + t.cache_read_tokens + t.cache_creation_tokens;
    serde_json::json!({
        "tokens": total,
        "turns": t.turns,
        "prompts": t.user_prompts,
    })
}

// --- Hook registration ---

#[tauri::command]
pub fn get_hook_registration_state(
    state: State<AppState>,
    app: AppHandle,
) -> serde_json::Value {
    // Self-heal: if global settings already contain our hook entries
    // (e.g. app-data was wiped on reinstall but ~/.claude/settings.json
    // survived), flip the local flag so the consent modal stops
    // re-prompting forever.
    let needs_heal = {
        let s = state.settings.lock().unwrap();
        !s.hooks_registered && !s.hook_registration_declined
    };
    if needs_heal && crate::hooks::is_installed_globally() {
        let snapshot = {
            let mut g = state.settings.lock().unwrap();
            g.hooks_registered = true;
            g.hook_install_version = crate::hooks::CURRENT_INSTALL_VERSION;
            g.clone()
        };
        if let Ok(path) = paths::settings_file() {
            let _ = settings::save(&path, &snapshot);
        }
        let _ = app.emit("settings-changed", snapshot);
    }
    let s = state.settings.lock().unwrap();
    serde_json::json!({
        "registered": s.hooks_registered,
        "declined": s.hook_registration_declined,
        "port": s.hook_port,
    })
}

#[tauri::command]
pub fn register_hooks_globally(
    state: State<AppState>,
    app: AppHandle,
) -> Result<(), String> {
    let port = {
        let s = state.settings.lock().unwrap();
        s.hook_port.ok_or_else(|| "hook server not started yet".to_string())?
    };
    crate::hooks::install(crate::hooks::HookConfig { port })
        .map_err(|e| e.to_string())?;
    let snapshot = {
        let mut g = state.settings.lock().unwrap();
        g.hooks_registered = true;
        g.hook_registration_declined = false;
        g.hook_install_version = crate::hooks::CURRENT_INSTALL_VERSION;
        g.clone()
    };
    let path = paths::settings_file().map_err(|e| e.to_string())?;
    settings::save(&path, &snapshot).map_err(|e| e.to_string())?;
    let _ = app.emit("settings-changed", snapshot);
    Ok(())
}

#[tauri::command]
pub fn skip_hook_registration(
    state: State<AppState>,
    app: AppHandle,
) -> Result<(), String> {
    let snapshot = {
        let mut g = state.settings.lock().unwrap();
        g.hook_registration_declined = true;
        g.clone()
    };
    let path = paths::settings_file().map_err(|e| e.to_string())?;
    settings::save(&path, &snapshot).map_err(|e| e.to_string())?;
    let _ = app.emit("settings-changed", snapshot);
    Ok(())
}

