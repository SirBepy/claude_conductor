use std::path::{Path, PathBuf};
use serde::{Deserialize, Serialize};

use crate::util::{sha256_hex, to_hex};

fn mint_token() -> String {
    let mut bytes = [0u8; 32];
    rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut bytes);
    to_hex(&bytes)
}

fn mint_id() -> String {
    let mut bytes = [0u8; 8];
    rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut bytes);
    to_hex(&bytes)
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[derive(Serialize, Deserialize, Default, Clone)]
struct DeviceEntry {
    id: String,
    name: String,
    token_hash: String,
    created_at: u64,
}

#[derive(Serialize, Deserialize, Default, Clone)]
struct RegistryFile {
    devices: Vec<DeviceEntry>,
    #[serde(default = "bool_true")]
    enabled: bool,
}

fn bool_true() -> bool { true }

/// Phone device summary exposed via IPC. token_hash is never included.
#[derive(Serialize, Clone)]
pub struct RemoteDevice {
    pub id: String,
    pub name: String,
    pub created_at: u64,
}

fn registry_path(app_data: &Path) -> PathBuf {
    app_data.join("remote-devices.json")
}

fn desktop_token_path(app_data: &Path) -> PathBuf {
    app_data.join("remote-access.json")
}

fn load(app_data: &Path) -> RegistryFile {
    std::fs::read_to_string(registry_path(app_data))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn save(reg: &RegistryFile, app_data: &Path) -> Result<(), String> {
    let body = serde_json::to_string_pretty(reg).map_err(|e| e.to_string())?;
    std::fs::write(registry_path(app_data), body).map_err(|e| e.to_string())
}

pub struct DeviceRegistry;

impl DeviceRegistry {
    /// Ensures the "desktop" device is registered so /ws/transcribe can authenticate.
    /// Also writes the plaintext token to remote-access.json so get_remote_access_token IPC still works.
    /// Idempotent: no-op if desktop device already exists.
    pub fn ensure_desktop_device(app_data: &Path) {
        let mut reg = load(app_data);
        if reg.devices.iter().any(|d| d.id == "desktop") {
            return;
        }
        let token = mint_token();
        reg.devices.push(DeviceEntry {
            id: "desktop".to_string(),
            name: "Desktop (this PC)".to_string(),
            token_hash: sha256_hex(&token),
            created_at: now_secs(),
        });
        reg.enabled = true;
        if let Err(e) = save(&reg, app_data) {
            log::error!("device_registry: failed to save desktop device: {e}");
            return;
        }
        let body = serde_json::json!({ "hash": sha256_hex(&token), "token": token });
        if let Err(e) = std::fs::write(
            desktop_token_path(app_data),
            serde_json::to_string_pretty(&body).unwrap_or_default(),
        ) {
            log::error!("device_registry: failed to write desktop token file: {e}");
        }
        log::info!("device_registry: desktop device registered");
    }

    /// True when the kill switch allows requests (default: true).
    pub fn is_enabled(app_data: &Path) -> bool {
        load(app_data).enabled
    }

    /// True when the presented bearer token matches any registered device.
    /// Fail-closed: returns false when registry is missing or unreadable.
    pub fn validate_token(token: &str, app_data: &Path) -> bool {
        let hash = sha256_hex(token);
        load(app_data).devices.iter().any(|d| d.token_hash == hash)
    }

    /// Mint a new device token, append to the registry, return plaintext token.
    pub fn add_device(name: &str, app_data: &Path) -> Result<String, String> {
        let mut reg = load(app_data);
        let token = mint_token();
        reg.devices.push(DeviceEntry {
            id: mint_id(),
            name: name.to_string(),
            token_hash: sha256_hex(&token),
            created_at: now_secs(),
        });
        save(&reg, app_data)?;
        Ok(token)
    }

    /// Remove a device by id. Returns true if found and removed.
    pub fn revoke_device(id: &str, app_data: &Path) -> Result<bool, String> {
        let mut reg = load(app_data);
        let before = reg.devices.len();
        reg.devices.retain(|d| d.id != id);
        if reg.devices.len() < before {
            save(&reg, app_data)?;
            Ok(true)
        } else {
            Ok(false)
        }
    }

    /// Set the kill switch. When false, auth_mw returns 503.
    pub fn set_enabled(enabled: bool, app_data: &Path) -> Result<(), String> {
        let mut reg = load(app_data);
        reg.enabled = enabled;
        save(&reg, app_data)
    }

    /// List devices without token hashes (IPC-safe).
    pub fn list_devices(app_data: &Path) -> Vec<RemoteDevice> {
        load(app_data).devices.iter().map(|d| RemoteDevice {
            id: d.id.clone(),
            name: d.name.clone(),
            created_at: d.created_at,
        }).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn validate_token_fail_closed_without_registry() {
        let dir = tempdir().unwrap();
        assert!(!DeviceRegistry::validate_token("anything", dir.path()));
    }

    #[test]
    fn add_and_validate_device() {
        let dir = tempdir().unwrap();
        let token = DeviceRegistry::add_device("My Phone", dir.path()).unwrap();
        assert_eq!(token.len(), 64);
        assert!(token.chars().all(|c| c.is_ascii_hexdigit()));
        assert!(DeviceRegistry::validate_token(&token, dir.path()));
        assert!(!DeviceRegistry::validate_token("wrong", dir.path()));
    }

    #[test]
    fn revoke_removes_device() {
        let dir = tempdir().unwrap();
        let token = DeviceRegistry::add_device("Test", dir.path()).unwrap();
        let devices = DeviceRegistry::list_devices(dir.path());
        assert_eq!(devices.len(), 1);
        let id = devices[0].id.clone();
        assert!(DeviceRegistry::revoke_device(&id, dir.path()).unwrap());
        assert!(!DeviceRegistry::validate_token(&token, dir.path()));
        assert!(DeviceRegistry::list_devices(dir.path()).is_empty());
    }

    #[test]
    fn kill_switch_toggle() {
        let dir = tempdir().unwrap();
        DeviceRegistry::set_enabled(true, dir.path()).unwrap();
        assert!(DeviceRegistry::is_enabled(dir.path()));
        DeviceRegistry::set_enabled(false, dir.path()).unwrap();
        assert!(!DeviceRegistry::is_enabled(dir.path()));
    }

    #[test]
    fn ensure_desktop_device_is_idempotent() {
        let dir = tempdir().unwrap();
        DeviceRegistry::ensure_desktop_device(dir.path());
        let d1 = DeviceRegistry::list_devices(dir.path());
        assert_eq!(d1.len(), 1);
        assert_eq!(d1[0].id, "desktop");
        DeviceRegistry::ensure_desktop_device(dir.path());
        let d2 = DeviceRegistry::list_devices(dir.path());
        assert_eq!(d2.len(), 1);
    }

    #[test]
    fn ensure_desktop_writes_plaintext_for_ipc() {
        let dir = tempdir().unwrap();
        DeviceRegistry::ensure_desktop_device(dir.path());
        let raw = std::fs::read_to_string(dir.path().join("remote-access.json")).unwrap();
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        let token = v["token"].as_str().unwrap();
        assert!(!token.is_empty());
        assert!(DeviceRegistry::validate_token(token, dir.path()));
    }
}
