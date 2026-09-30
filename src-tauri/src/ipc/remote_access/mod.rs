//! App-process IPC for the phone remote-access feature: an on/off toggle that
//! runs `tailscale serve` itself (no manual command), plus QR pairing.
//!
//! The daemon owns the actual HTTP server (binds 127.0.0.1:27183) and validates
//! every request against the SHA-256 hash stored in `<app-data>/remote-access.json`.
//! It re-reads that file per request (see `daemon::remote_server::stored_token_hash`),
//! so regenerating the token here takes effect live with no daemon restart.
//!
//! Persistence note (a deliberate security trade-off the user accepted): the
//! plaintext token is also stored in `remote-access.json` under a `"token"`
//! field so the QR can be shown anytime. The daemon keeps validating against the
//! `"hash"` field, which we always write in lockstep.
//!
//! Split by concern so no single file mixes unrelated helpers: `tailscale` -
//! shelling out to `tailscale.exe` (serve on/off, status, dnsname); `token` -
//! reading the plaintext token off disk; `pairing` - minting a pairing code
//! and building the pairing URL. All `#[tauri::command]` fns stay here so
//! `lib.rs`'s `generate_handler!` list keeps working unchanged (a named
//! re-export of a `#[tauri::command]` fn breaks the macro; only the plain
//! helpers move out).

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::settings::{self, paths};
use crate::state::AppState;

mod pairing;
mod tailscale;
mod token;
use pairing::{build_pairing_url, do_mint_pairing_code};
use tailscale::{serve_disable, serve_enable, serve_running, tailscale_dnsname};
use token::{read_plaintext_token, token_file};

// ── Settings persistence ──────────────────────────────────────────────────────

fn persist_enabled(enabled: bool, state: &State<AppState>, app: &AppHandle) {
    let path = match paths::settings_file() {
        Ok(p) => p,
        Err(e) => {
            log::error!("[remote_access] persist_enabled: could not resolve settings path: {e}");
            return;
        }
    };
    match settings::mutate_and_save(&state.settings, &path, |s| {
        s.remote_access_enabled = enabled;
        Ok(())
    }) {
        Ok(snapshot) => {
            let _ = app.emit("settings-changed", &snapshot);
        }
        Err(e) => {
            log::error!("[remote_access] persist_enabled: save to {path:?} failed: {e}");
        }
    }
}

// ── Public boot helper ────────────────────────────────────────────────────────

/// Re-apply `tailscale serve` on app boot when the persisted flag is on.
/// Best-effort: logs on failure, never panics. Called from `lib.rs` setup.
pub fn reapply_on_boot(enabled: bool) {
    if !enabled {
        return;
    }
    std::thread::spawn(|| match serve_enable() {
        Ok(()) => log::info!("remote-access: re-applied tailscale serve on boot"),
        Err(e) => log::warn!("remote-access: boot re-apply of tailscale serve failed: {e}"),
    });
}

/// Spawn a background thread that re-applies `tailscale serve` when it has
/// dropped while remote access is still enabled. Polls every 5 minutes (was
/// 30s), reading `remote_access_enabled` straight from the in-memory
/// `AppState.settings` lock instead of re-reading + re-parsing settings.json
/// off disk every tick. `serve status` (a subprocess spawn) is only paid for
/// when the flag is on, so this tick IS the health check - toggling the
/// setting itself already runs `serve_enable`/`serve_disable` synchronously
/// (see `set_remote_access_enabled`), so this watcher only needs to notice
/// "serve died underneath us while still enabled", and a 5-minute worst-case
/// re-establish is an accepted trade-off for not shelling out every 30s.
/// Best-effort: errors are logged, never fatal.
pub fn start_tailscale_watcher(app: AppHandle) {
    use tauri::Manager;
    const POLL_INTERVAL: std::time::Duration = std::time::Duration::from_secs(5 * 60);
    std::thread::spawn(move || loop {
        std::thread::sleep(POLL_INTERVAL);
        let enabled = app
            .try_state::<AppState>()
            .map(|s| s.settings.lock().unwrap().remote_access_enabled)
            .unwrap_or(false);
        if enabled && !serve_running() {
            match serve_enable() {
                Ok(()) => log::info!("remote-access: watcher re-applied tailscale serve"),
                Err(e) => log::warn!("remote-access: watcher tailscale serve failed: {e}"),
            }
        }
    });
}

// ── Commands ──────────────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct PairingQrResult {
    pub svg: String,
    pub url: String,
    pub iroh: Option<String>,
}

#[derive(Serialize)]
pub struct RemoteAccessStatus {
    /// The persisted on/off flag from settings.
    pub enabled: bool,
    /// Whether tailscale is up + logged in (Self.DNSName non-empty).
    pub tailscale_up: bool,
    /// Best-effort: whether `tailscale serve` is proxying our local target.
    pub serve_running: bool,
    /// "https://<dnsname>/" (trailing dot stripped) or None if tailscale not up.
    pub url: Option<String>,
}

/// Toggle remote access. When enabling, runs `tailscale serve --bg --https=443
/// http://127.0.0.1:27183`; when disabling, runs `tailscale serve --https=443
/// off`. Persists the flag either way (even if the serve call fails, so the UI
/// reflects intent and a later boot/retry can re-apply).
///
/// `persist_enabled` (a settings-file write) runs before the blocking pool
/// hand-off, and only `enabled` (owned, `Copy`) crosses into the closure, so
/// no state guard lives across the `.await`.
#[tauri::command]
pub async fn set_remote_access_enabled(
    enabled: bool,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(), String> {
    persist_enabled(enabled, &state, &app);
    tokio::task::spawn_blocking(move || {
        if enabled {
            serve_enable()
        } else {
            serve_disable()
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Current remote-access status for the Settings UI. `tailscale_dnsname`/
/// `serve_running` each shell out to `tailscale.exe`, so they run on the
/// blocking pool; only the `enabled` bool (read from state first) crosses in.
#[tauri::command]
pub async fn remote_access_status(state: State<'_, AppState>) -> Result<RemoteAccessStatus, String> {
    let enabled = state.settings.lock().unwrap().remote_access_enabled;
    tokio::task::spawn_blocking(move || {
        let dnsname = tailscale_dnsname();
        RemoteAccessStatus {
            enabled,
            tailscale_up: dnsname.is_some(),
            serve_running: serve_running(),
            url: dnsname.map(|d| format!("https://{d}/")),
        }
    })
    .await
    .map_err(|e| e.to_string())
}

/// No-op kept for backward compatibility. Use remote_access_qr() instead.
#[tauri::command]
pub async fn regenerate_remote_token() -> Result<String, String> {
    Ok(String::new())
}

/// Mint a fresh pairing code, return SVG QR + URL. Both encode the same code,
/// so only one IPC call is needed per QR refresh. `tailscale_dnsname` shells
/// out to `tailscale.exe`, so the whole body runs on the blocking pool.
#[tauri::command]
pub async fn remote_access_qr() -> Result<PairingQrResult, String> {
    tokio::task::spawn_blocking(|| {
        use qrcode::render::svg;
        use qrcode::QrCode;

        let app_data = paths::data_dir().map_err(|e| e.to_string())?;
        let dnsname = tailscale_dnsname();
        let iroh_id = crate::daemon::iroh_tunnel::endpoint_id_from_disk(&app_data).map(|id| id.to_string());
        let code = do_mint_pairing_code(&app_data)?;
        let url = build_pairing_url(dnsname.as_deref(), iroh_id.as_deref(), &code)?;
        let qr = QrCode::new(url.as_bytes()).map_err(|e| format!("QR encode failed: {e}"))?;
        let svg = qr.render::<svg::Color>().min_dimensions(220, 220).build();
        Ok(PairingQrResult { svg, url, iroh: iroh_id })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Return just the pairing URL (re-mints a code). Prefer remote_access_qr() to
/// get both. `tailscale_dnsname` shells out to `tailscale.exe`, so the body
/// runs on the blocking pool.
#[tauri::command]
pub async fn generate_pairing_url() -> Result<String, String> {
    tokio::task::spawn_blocking(|| {
        let dnsname = tailscale_dnsname()
            .ok_or_else(|| "tailscale is not connected".to_string())?;
        let app_data = paths::data_dir().map_err(|e| e.to_string())?;
        let code = do_mint_pairing_code(&app_data)?;
        Ok(format!("https://{dnsname}/?pair={code}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// List all paired devices (no token hashes).
#[tauri::command]
pub async fn list_remote_devices() -> Result<Vec<crate::daemon::device_registry::RemoteDevice>, String> {
    let app_data = paths::data_dir().map_err(|e| e.to_string())?;
    Ok(crate::daemon::device_registry::DeviceRegistry::list_devices(&app_data))
}

/// Revoke a device by id. Returns true if the device existed and was removed.
#[tauri::command]
pub async fn revoke_remote_device(id: String) -> Result<bool, String> {
    let app_data = paths::data_dir().map_err(|e| e.to_string())?;
    crate::daemon::device_registry::DeviceRegistry::revoke_device(&id, &app_data)
}

/// Toggle the kill switch. When false, the daemon returns 503 for all remote requests.
#[tauri::command]
pub async fn set_remote_kill_switch(enabled: bool) -> Result<(), String> {
    let app_data = paths::data_dir().map_err(|e| e.to_string())?;
    crate::daemon::device_registry::DeviceRegistry::set_enabled(enabled, &app_data)
}

/// True = server active (not blocked); false = kill switch engaged.
#[tauri::command]
pub async fn get_remote_kill_switch() -> Result<bool, String> {
    let app_data = paths::data_dir().map_err(|e| e.to_string())?;
    Ok(crate::daemon::device_registry::DeviceRegistry::is_enabled(&app_data))
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
    fn list_remote_devices_returns_empty_without_registry() {
        let dir = tempdir().unwrap();
        let devices = crate::daemon::device_registry::DeviceRegistry::list_devices(dir.path());
        assert!(devices.is_empty());
    }
}
