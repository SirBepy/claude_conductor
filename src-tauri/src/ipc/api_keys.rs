//! Tauri wrappers for `crate::api_keys`: list every known key with its
//! set/not-set status and save path, and set one by name. The value itself
//! never crosses the IPC boundary, before or after a save.

use crate::api_keys::{self, ApiKeyEntry};

#[derive(serde::Serialize, Clone, Debug, ts_rs::TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct ApiKeyStatus {
    pub env_name: String,
    pub label: String,
    pub purpose: String,
    pub used_by: String,
    pub create_url: String,
    pub is_set: bool,
    /// Absolute path to the file this key lives in (`~/.claude/.env`),
    /// shown so the modal can say where it saves without opening it.
    pub save_path: String,
}

fn status_for(entry: &ApiKeyEntry, text: &str, save_path: &str) -> ApiKeyStatus {
    ApiKeyStatus {
        env_name: entry.env_name.to_string(),
        label: entry.label.to_string(),
        purpose: entry.purpose.to_string(),
        used_by: entry.used_by.to_string(),
        create_url: entry.create_url.to_string(),
        is_set: api_keys::is_key_set(text, entry.env_name),
        save_path: save_path.to_string(),
    }
}

fn env_path_or_err() -> Result<std::path::PathBuf, String> {
    api_keys::env_path().ok_or_else(|| "could not resolve the home directory".to_string())
}

#[tauri::command]
pub async fn list_api_keys() -> Result<Vec<ApiKeyStatus>, String> {
    tokio::task::spawn_blocking(|| {
        let path = env_path_or_err()?;
        let text = std::fs::read_to_string(&path).unwrap_or_default();
        let save_path = path.display().to_string();
        Ok(api_keys::REGISTRY.iter().map(|e| status_for(e, &text, &save_path)).collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn set_api_key(name: String, value: String) -> Result<ApiKeyStatus, String> {
    tokio::task::spawn_blocking(move || {
        let entry = api_keys::entry(&name).ok_or_else(|| format!("{name} is not a known API key"))?;
        let path = env_path_or_err()?;
        api_keys::set_key(&path, &name, &value)?;
        let text = std::fs::read_to_string(&path).unwrap_or_default();
        Ok(status_for(entry, &text, &path.display().to_string()))
    })
    .await
    .map_err(|e| e.to_string())?
}
