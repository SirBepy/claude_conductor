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

fn source_label(kind: Option<crate::sessions::kinds::InstanceKind>) -> &'static str {
    use crate::sessions::kinds::InstanceKind;
    match kind {
        Some(InstanceKind::Interactive) => "interactive",
        Some(InstanceKind::Automated) => "automated",
        Some(InstanceKind::External) => "external",
        None => "unknown",
    }
}

/// Sums the persisted token history by session `kind` (Interactive CLI vs
/// Automated/External app-hosted chats) so the dashboard can compare tokens
/// burned per source. Rows with no `kind` (written before this field existed)
/// land in "unknown" rather than being guessed at.
#[tauri::command]
pub fn token_stats_by_source(state: State<AppState>) -> serde_json::Value {
    let history = {
        let mgr = state.db.lock().unwrap();
        crate::storage::token_store::get_token_records(mgr.conn(), 0).unwrap_or_default()
    };
    serde_json::json!({ "buckets": aggregate_by_source(&history) })
}

/// `history` must arrive newest-first, as `get_token_records` returns it.
fn aggregate_by_source(history: &[crate::tokens::TokenRecord]) -> Vec<serde_json::Value> {
    let order = ["interactive", "automated", "external", "unknown"];
    let mut sessions = std::collections::HashMap::new();
    let mut tokens = std::collections::HashMap::new();
    let mut turns = std::collections::HashMap::new();

    // token_records is append-only and the startup backfill re-inserts a row per
    // session every boot (185k rows / 1.8k sessions on the dev machine), so raw
    // sums over-counted tokens ~658x and reported the row count as "sessions".
    // Newest-first means first-wins per session_id is that session's latest row.
    let mut seen = std::collections::HashSet::new();
    for r in history.iter().filter(|r| seen.insert(r.session_id.as_str())) {
        let key = source_label(r.kind);
        *sessions.entry(key).or_insert(0u64) += 1;
        *tokens.entry(key).or_insert(0u64) +=
            r.input_tokens + r.output_tokens + r.cache_read_tokens + r.cache_creation_tokens;
        *turns.entry(key).or_insert(0u64) += r.turns;
    }

    order.iter().map(|&key| {
        let s = *sessions.get(key).unwrap_or(&0);
        let t = *tokens.get(key).unwrap_or(&0);
        let tu = *turns.get(key).unwrap_or(&0);
        let avg = if tu > 0 { t as f64 / tu as f64 } else { 0.0 };
        serde_json::json!({
            "kind": key,
            "sessions": s,
            "tokens": t,
            "turns": tu,
            "avgTokensPerTurn": avg,
        })
    }).collect()
}

#[cfg(test)]
mod token_source_tests {
    use super::*;
    use crate::sessions::kinds::InstanceKind;
    use crate::tokens::TokenRecord;

    fn rec(session_id: &str, tokens: u64, turns: u64, kind: Option<InstanceKind>) -> TokenRecord {
        TokenRecord {
            session_id: session_id.into(),
            cwd: None,
            date: "2026-08-12".into(),
            input_tokens: tokens,
            output_tokens: 0,
            cache_read_tokens: 0,
            cache_creation_tokens: 0,
            turns,
            started_at: "2026-08-12T00:00:00Z".into(),
            last_active_at: "2026-08-12T00:00:00Z".into(),
            recorded_at: "2026-08-12T00:00:00Z".into(),
            live: None,
            merged_subagents: None,
            kind,
        }
    }

    fn bucket<'a>(buckets: &'a [serde_json::Value], kind: &str) -> &'a serde_json::Value {
        buckets.iter().find(|b| b["kind"] == kind).expect("bucket present")
    }

    #[test]
    fn counts_each_session_once_despite_duplicate_rows() {
        // The backfill re-inserts the same session on every boot; newest row first.
        let history = vec![
            rec("a", 500, 5, None),
            rec("a", 400, 4, None),
            rec("a", 300, 3, None),
            rec("b", 100, 1, None),
        ];
        let out = aggregate_by_source(&history);
        let unknown = bucket(&out, "unknown");
        assert_eq!(unknown["sessions"], 2, "two distinct sessions, not four rows");
        assert_eq!(unknown["tokens"], 600, "newest row per session only");
        assert_eq!(unknown["turns"], 6);
    }

    #[test]
    fn buckets_split_by_kind_and_legacy_rows_stay_unknown() {
        let history = vec![
            rec("a", 100, 1, Some(InstanceKind::Interactive)),
            rec("b", 200, 2, Some(InstanceKind::Automated)),
            rec("c", 300, 3, Some(InstanceKind::External)),
            rec("d", 400, 4, None),
        ];
        let out = aggregate_by_source(&history);
        assert_eq!(bucket(&out, "interactive")["tokens"], 100);
        assert_eq!(bucket(&out, "automated")["tokens"], 200);
        assert_eq!(bucket(&out, "external")["tokens"], 300);
        assert_eq!(bucket(&out, "unknown")["tokens"], 400);
    }

    #[test]
    fn empty_history_yields_four_zero_buckets() {
        let out = aggregate_by_source(&[]);
        assert_eq!(out.len(), 4);
        for b in &out {
            assert_eq!(b["sessions"], 0);
            assert_eq!(b["avgTokensPerTurn"], 0.0);
        }
    }
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

