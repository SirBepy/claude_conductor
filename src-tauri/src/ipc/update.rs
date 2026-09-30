use tauri::{AppHandle, Manager};

/// Caches the latest update state in AppState and emits `update-state` so the
/// settings UI + tray menu can stay in sync without polling.
pub fn set_update_state(app: &AppHandle, value: serde_json::Value) {
    use tauri::Emitter;
    if let Some(state) = app.try_state::<crate::state::AppState>() {
        *state.update_state.lock().unwrap() = value.clone();
    }
    let _ = app.emit("update-state", &value);
}

/// Runs the updater check and emits an `update-state` event for every outcome
/// so the settings UI can surface progress without polling. When `auto_install`
/// is true and an update is available, the binary is downloaded + installed in
/// the background; the app restarts on next launch.
pub async fn run_update_check(app: &AppHandle, auto_install: bool) -> serde_json::Value {
    use tauri_plugin_updater::UpdaterExt;
    let result = match app.updater() {
        Ok(updater) => match updater.check().await {
            Ok(Some(u)) => {
                let version = u.version.clone();
                let available = serde_json::json!({ "state": "available", "version": version });
                set_update_state(app, available.clone());
                if auto_install {
                    set_update_state(app, serde_json::json!({ "state": "downloading", "version": version }));
                    match u.download_and_install(|_, _| {}, || {}).await {
                        Ok(_) => {
                            let downloaded = serde_json::json!({ "state": "downloaded", "version": version });
                            set_update_state(app, downloaded.clone());
                            return downloaded;
                        }
                        Err(e) => {
                            log::warn!("auto-install failed: {e}");
                            let err = serde_json::json!({ "state": "error", "message": e.to_string() });
                            set_update_state(app, err.clone());
                            return err;
                        }
                    }
                }
                return available;
            }
            Ok(None) => serde_json::json!({ "state": "up-to-date" }),
            Err(e) => serde_json::json!({ "state": "error", "message": e.to_string() }),
        },
        Err(e) => serde_json::json!({ "state": "error", "message": e.to_string() }),
    };
    set_update_state(app, result.clone());
    result
}

#[tauri::command]
pub async fn check_for_updates(app: AppHandle) -> Result<serde_json::Value, String> {
    use crate::types::AutoUpdateMode;
    let auto_install = app.state::<crate::state::AppState>()
        .settings.lock().unwrap().auto_update == AutoUpdateMode::Immediate;
    Ok(run_update_check(&app, auto_install).await)
}

#[tauri::command]
pub async fn download_and_install_update(app: AppHandle) -> Result<(), String> {
    use tauri_plugin_updater::UpdaterExt;
    let updater = app.updater().map_err(|e| e.to_string())?;
    let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
        return Err("no update available".into());
    };
    let version = update.version.clone();
    set_update_state(&app, serde_json::json!({ "state": "downloading", "version": version }));
    match update.download_and_install(|_, _| {}, || {}).await {
        Ok(_) => {
            set_update_state(&app, serde_json::json!({ "state": "downloaded", "version": version }));
            Ok(())
        }
        Err(e) => {
            let msg = e.to_string();
            set_update_state(&app, serde_json::json!({ "state": "error", "message": msg.clone() }));
            Err(msg)
        }
    }
}

// sync-command: does no IO (restart exits the process), and tray/menu.rs calls
// it synchronously, where an async fn would be a silently dropped Future.
#[tauri::command]
pub fn install_update(app: AppHandle) {
    app.restart();
}

#[tauri::command]
pub async fn get_update_state(app: AppHandle) -> serde_json::Value {
    app.state::<crate::state::AppState>().update_state.lock().unwrap().clone()
}
