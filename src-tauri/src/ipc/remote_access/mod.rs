//! App-process IPC for remote access: the on/off switch, its status, and QR
//! pairing for phones and peer machines.
//!
//! The daemon owns the actual HTTP server (binds 127.0.0.1:27183, reached from
//! outside only through its iroh tunnel) and validates every request against
//! the device registry in `<app-data>/remote-devices.json`. Both the switch and
//! the registry are re-read per request (and by `iroh_tunnel` every couple of
//! seconds), so changes made here take effect live with no daemon restart.
//!
//! Persistence note (a deliberate security trade-off the user accepted): the
//! plaintext token is also stored in `remote-access.json` under a `"token"`
//! field so the QR can be shown anytime. The daemon keeps validating against the
//! `"hash"` field, which we always write in lockstep.
//!
//! Split by concern: `token` - reading the plaintext token off disk; `pairing` -
//! minting a pairing code and building the pairing URL. All `#[tauri::command]`
//! fns stay here so `lib.rs`'s `generate_handler!` list keeps working unchanged
//! (a named re-export of a `#[tauri::command]` fn breaks the macro; only the
//! plain helpers move out).

use serde::Serialize;

use crate::daemon::device_registry::DeviceRegistry;
use crate::settings::paths;

mod pairing;
mod token;
use pairing::{build_pairing_url, do_mint_pairing_code};
use token::{read_plaintext_token, token_file};

// ── Commands ──────────────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct PairingQrResult {
    pub svg: String,
    pub url: String,
    pub iroh: Option<String>,
}

#[derive(Serialize)]
pub struct RemoteAccessStatus {
    /// The remote-access switch (`DeviceRegistry::is_enabled`).
    pub enabled: bool,
}

/// Flip the one remote-access switch. Off = the daemon refuses every remote
/// request and pairing with 503 and closes its iroh endpoint; on = it binds the
/// endpoint again. Both happen in the daemon on its own, off this file write.
#[tauri::command]
pub async fn set_remote_access_enabled(enabled: bool) -> Result<(), String> {
    let app_data = paths::data_dir().map_err(|e| e.to_string())?;
    DeviceRegistry::set_enabled(enabled, &app_data)
}

#[tauri::command]
pub async fn remote_access_status() -> Result<RemoteAccessStatus, String> {
    let app_data = paths::data_dir().map_err(|e| e.to_string())?;
    Ok(RemoteAccessStatus { enabled: DeviceRegistry::is_enabled(&app_data) })
}

/// No-op kept for backward compatibility. Use remote_access_qr() instead.
#[tauri::command]
pub async fn regenerate_remote_token() -> Result<String, String> {
    Ok(String::new())
}

/// Mint a fresh pairing code, return SVG QR + URL. Both encode the same code,
/// so only one IPC call is needed per QR refresh. QR rendering is CPU work, so
/// the body runs on the blocking pool.
#[tauri::command]
pub async fn remote_access_qr() -> Result<PairingQrResult, String> {
    tokio::task::spawn_blocking(|| {
        use qrcode::render::svg;
        use qrcode::QrCode;

        let app_data = paths::data_dir().map_err(|e| e.to_string())?;
        let iroh_id = crate::daemon::iroh_tunnel::endpoint_id_from_disk(&app_data).map(|id| id.to_string());
        let code = do_mint_pairing_code(&app_data)?;
        let url = build_pairing_url(iroh_id.as_deref(), &code)?;
        let qr = QrCode::new(url.as_bytes()).map_err(|e| format!("QR encode failed: {e}"))?;
        let svg = qr.render::<svg::Color>().min_dimensions(220, 220).build();
        Ok(PairingQrResult { svg, url, iroh: iroh_id })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// List all paired devices (no token hashes).
#[tauri::command]
pub async fn list_remote_devices() -> Result<Vec<crate::daemon::device_registry::RemoteDevice>, String> {
    let app_data = paths::data_dir().map_err(|e| e.to_string())?;
    Ok(DeviceRegistry::list_devices(&app_data))
}

/// Revoke a device by id. Returns true if the device existed and was removed.
#[tauri::command]
pub async fn revoke_remote_device(id: String) -> Result<bool, String> {
    let app_data = paths::data_dir().map_err(|e| e.to_string())?;
    DeviceRegistry::revoke_device(&id, &app_data)
}

/// Rename a paired phone. Same 1..=40 character rule as a machine label.
/// Returns true if the device existed.
#[tauri::command]
pub async fn rename_remote_device(id: String, name: String) -> Result<bool, String> {
    let app_data = paths::data_dir().map_err(|e| e.to_string())?;
    rename_phone(&id, &name, &app_data)
}

/// A machine's entry is refused: its name follows the machine's nickname
/// (`rename_machine`), which also restamps the chat list, and renaming only
/// this copy would leave the two disagreeing.
fn rename_phone(id: &str, name: &str, app_data: &std::path::Path) -> Result<bool, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() || trimmed.chars().count() > 40 {
        return Err("name must be 1..=40 characters".to_string());
    }
    let is_machine = DeviceRegistry::list_devices(app_data)
        .iter()
        .any(|d| d.id == id && d.kind == crate::daemon::device_registry::DeviceKind::Machine);
    if is_machine {
        return Err("a paired machine is renamed under Paired machines".to_string());
    }
    DeviceRegistry::rename_device(id, trimmed, app_data)
}

/// Return the plaintext remote-access token so the desktop webview can open the
/// daemon's authed `/ws/transcribe` (voice) WebSocket on localhost. Same token
/// the phone carries; desktop has no `rc_token` in localStorage, so it reads it
/// here. Errors if no token is provisioned yet.
#[tauri::command]
pub async fn get_remote_access_token() -> Result<String, String> {
    let path = token_file()?;
    read_plaintext_token(&path).ok_or_else(|| "no remote-access token provisioned".to_string())
}

#[cfg(test)]
mod tests {
    use tempfile::tempdir;

    #[test]
    fn rename_phone_refuses_a_machine_entry() {
        let dir = tempdir().unwrap();
        let (_, machine_id) = super::DeviceRegistry::add_machine_device("Mac", "mach-1", dir.path()).unwrap();
        assert!(super::rename_phone(&machine_id, "Other", dir.path()).is_err());
        super::DeviceRegistry::add_device("Phone", dir.path()).unwrap();
        let phone = super::DeviceRegistry::list_devices(dir.path()).into_iter().find(|d| d.name == "Phone").unwrap();
        assert_eq!(super::rename_phone(&phone.id, " Pixel ", dir.path()), Ok(true));
        assert!(super::rename_phone(&phone.id, "  ", dir.path()).is_err());
    }

    #[test]
    fn list_remote_devices_returns_empty_without_registry() {
        let dir = tempdir().unwrap();
        let devices = super::DeviceRegistry::list_devices(dir.path());
        assert!(devices.is_empty());
    }
}
