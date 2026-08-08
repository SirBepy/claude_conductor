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

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::settings::{self, paths};
use crate::state::AppState;
use crate::util::{sha256_hex, to_hex};

// ── Token storage (mirrors daemon::remote_server, plaintext added) ────────────

fn token_file() -> Result<PathBuf, String> {
    Ok(paths::data_dir().map_err(|e| e.to_string())?.join("remote-access.json"))
}

/// Mint a fresh 32-byte hex token. Same scheme as the daemon's `ensure_token`.
fn mint_token() -> String {
    let mut bytes = [0u8; 32];
    rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut bytes);
    to_hex(&bytes)
}

/// Write both the hash (what the daemon validates) and the plaintext token (so
/// the QR is reproducible) to `remote-access.json`.
fn write_token(path: &Path, token: &str) -> Result<(), String> {
    let body = serde_json::json!({ "hash": sha256_hex(token), "token": token });
    std::fs::write(path, serde_json::to_string_pretty(&body).unwrap_or_default())
        .map_err(|e| e.to_string())
}

/// Read the current plaintext token for the QR.
///
/// Two writers provision the token and they disagree on format: the APP
/// (`write_token`) stores `{ hash, token }` in `remote-access.json`, while the
/// DAEMON's `ensure_token` writes a hash-only `remote-access.json` plus the
/// plaintext in a sibling `remote-access-token.txt`. When the daemon minted the
/// live token (e.g. after a fresh install, or the json was deleted to force a
/// re-pair), the json has no `"token"` field, so reading only the json returned
/// None and the QR/re-pair flow broke even though the plaintext existed on disk.
/// So: prefer the json `"token"`, then fall back to the daemon's sibling
/// `remote-access-token.txt`. Returns None only when neither carries a token.
fn read_plaintext_token(path: &Path) -> Option<String> {
    if let Ok(raw) = std::fs::read_to_string(path) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
            if let Some(tok) = v.get("token").and_then(|t| t.as_str()) {
                let tok = tok.trim();
                if !tok.is_empty() {
                    return Some(tok.to_string());
                }
            }
        }
    }
    // Fall back to the daemon-written plaintext handoff file (hash-only json case).
    let handoff = path.with_file_name("remote-access-token.txt");
    let tok = std::fs::read_to_string(handoff).ok()?;
    let tok = tok.trim();
    if tok.is_empty() {
        None
    } else {
        Some(tok.to_string())
    }
}

// ── Tailscale process helpers ─────────────────────────────────────────────────

/// Resolve the tailscale executable: prefer PATH, fall back to the default
/// Windows install location.
fn tailscale_exe() -> PathBuf {
    if let Ok(p) = which::which("tailscale") {
        return p;
    }
    PathBuf::from("C:\\Program Files\\Tailscale\\tailscale.exe")
}

/// Run a tailscale subcommand with output captured, console window suppressed.
/// Returns (stdout, stderr, success).
fn run_tailscale(args: &[&str]) -> Result<(String, String, bool), String> {
    let mut cmd = Command::new(tailscale_exe());
    cmd.args(args);
    crate::util::process::hide_console(&mut cmd);
    let out = cmd
        .output()
        .map_err(|e| format!("could not run tailscale (is it installed?): {e}"))?;
    Ok((
        String::from_utf8_lossy(&out.stdout).into_owned(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
        out.status.success(),
    ))
}

/// The tailscale-serve enable command. Reverse-proxies the daemon's local
/// remote-access port over the tailnet with Tailscale-managed HTTPS.
const SERVE_TARGET: &str = "http://127.0.0.1:27183";

fn serve_enable() -> Result<(), String> {
    let (_out, err, ok) = run_tailscale(&["serve", "--bg", "--https=443", SERVE_TARGET])?;
    if ok {
        Ok(())
    } else {
        Err(if err.trim().is_empty() {
            "tailscale serve failed (is tailscale connected? try `tailscale up`)".into()
        } else {
            err.trim().to_string()
        })
    }
}

fn serve_disable() -> Result<(), String> {
    // `tailscale serve --https=443 off` removes the 443 proxy. Best-effort: a
    // non-zero exit (e.g. nothing was being served) is not fatal for "turn off".
    let _ = run_tailscale(&["serve", "--https=443", "off"]);
    Ok(())
}

/// The tailnet DNS name for this machine, trailing dot stripped, or None if
/// tailscale is not up / not logged in.
fn tailscale_dnsname() -> Option<String> {
    let (out, _err, ok) = run_tailscale(&["status", "--json"]).ok()?;
    if !ok {
        return None;
    }
    let v: serde_json::Value = serde_json::from_str(&out).ok()?;
    let name = v.get("Self")?.get("DNSName")?.as_str()?;
    let trimmed = name.trim_end_matches('.');
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// Best-effort: whether `tailscale serve status` mentions our local target.
fn serve_running() -> bool {
    match run_tailscale(&["serve", "status"]) {
        Ok((out, _err, _ok)) => out.contains(SERVE_TARGET),
        Err(_) => false,
    }
}

// ── Settings persistence ──────────────────────────────────────────────────────

fn persist_enabled(enabled: bool, state: &State<AppState>, app: &AppHandle) {
    let snapshot = {
        let mut s = state.settings.lock().unwrap();
        s.remote_access_enabled = enabled;
        s.clone()
    };
    if let Ok(path) = paths::settings_file() {
        let _ = settings::save(&path, &snapshot);
    }
    let _ = app.emit("settings-changed", &snapshot);
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

// ── Pairing code helpers ──────────────────────────────────────────────────────

/// Mint a fresh pairing code, write hash + TTL to remote-pairing.json,
/// return the plaintext code. TTL: 2 minutes.
fn do_mint_pairing_code(app_data: &std::path::Path) -> Result<String, String> {
    let mut bytes = [0u8; 32];
    rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut bytes);
    let code: String = to_hex(&bytes);
    let expires_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        + 120;
    let body = serde_json::json!({ "code_hash": sha256_hex(&code), "expires_at": expires_at });
    std::fs::write(
        app_data.join("remote-pairing.json"),
        serde_json::to_string_pretty(&body).unwrap_or_default(),
    )
    .map_err(|e| e.to_string())?;
    Ok(code)
}

// ── Commands ──────────────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct PairingQrResult {
    pub svg: String,
    pub url: String,
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
#[tauri::command]
pub fn set_remote_access_enabled(
    enabled: bool,
    state: State<AppState>,
    app: AppHandle,
) -> Result<(), String> {
    persist_enabled(enabled, &state, &app);
    if enabled {
        serve_enable()
    } else {
        serve_disable()
    }
}

/// Current remote-access status for the Settings UI.
#[tauri::command]
pub fn remote_access_status(state: State<AppState>) -> RemoteAccessStatus {
    let enabled = state.settings.lock().unwrap().remote_access_enabled;
    let dnsname = tailscale_dnsname();
    RemoteAccessStatus {
        enabled,
        tailscale_up: dnsname.is_some(),
        serve_running: serve_running(),
        url: dnsname.map(|d| format!("https://{d}/")),
    }
}

/// No-op kept for backward compatibility. Use remote_access_qr() instead.
#[tauri::command]
pub fn regenerate_remote_token() -> Result<String, String> {
    Ok(String::new())
}

/// Mint a fresh pairing code, return SVG QR + URL.
/// Both encode the same code, so only one IPC call is needed per QR refresh.
#[tauri::command]
pub fn remote_access_qr() -> Result<PairingQrResult, String> {
    use qrcode::render::svg;
    use qrcode::QrCode;

    let dnsname = tailscale_dnsname()
        .ok_or_else(|| "tailscale is not connected (run `tailscale up` first)".to_string())?;
    let app_data = paths::data_dir().map_err(|e| e.to_string())?;
    let code = do_mint_pairing_code(&app_data)?;
    let url = format!("https://{dnsname}/?pair={code}");
    let qr = QrCode::new(url.as_bytes()).map_err(|e| format!("QR encode failed: {e}"))?;
    let svg = qr.render::<svg::Color>().min_dimensions(220, 220).build();
    Ok(PairingQrResult { svg, url })
}

/// Return just the pairing URL (re-mints a code). Prefer remote_access_qr() to get both.
#[tauri::command]
pub fn generate_pairing_url() -> Result<String, String> {
    let dnsname = tailscale_dnsname()
        .ok_or_else(|| "tailscale is not connected".to_string())?;
    let app_data = paths::data_dir().map_err(|e| e.to_string())?;
    let code = do_mint_pairing_code(&app_data)?;
    Ok(format!("https://{dnsname}/?pair={code}"))
}

/// List all paired devices (no token hashes).
#[tauri::command]
pub fn list_remote_devices() -> Result<Vec<crate::daemon::device_registry::RemoteDevice>, String> {
    let app_data = paths::data_dir().map_err(|e| e.to_string())?;
    Ok(crate::daemon::device_registry::DeviceRegistry::list_devices(&app_data))
}

/// Revoke a device by id. Returns true if the device existed and was removed.
#[tauri::command]
pub fn revoke_remote_device(id: String) -> Result<bool, String> {
    let app_data = paths::data_dir().map_err(|e| e.to_string())?;
    crate::daemon::device_registry::DeviceRegistry::revoke_device(&id, &app_data)
}

/// Toggle the kill switch. When false, the daemon returns 503 for all remote requests.
#[tauri::command]
pub fn set_remote_kill_switch(enabled: bool) -> Result<(), String> {
    let app_data = paths::data_dir().map_err(|e| e.to_string())?;
    crate::daemon::device_registry::DeviceRegistry::set_enabled(enabled, &app_data)
}

/// True = server active (not blocked); false = kill switch engaged.
#[tauri::command]
pub fn get_remote_kill_switch() -> Result<bool, String> {
    let app_data = paths::data_dir().map_err(|e| e.to_string())?;
    Ok(crate::daemon::device_registry::DeviceRegistry::is_enabled(&app_data))
}

/// Return the plaintext remote-access token so the desktop webview can open the
/// daemon's authed `/ws/transcribe` (voice) WebSocket on localhost. Same token
/// the phone carries; desktop has no `rc_token` in localStorage, so it reads it
/// here. Errors if no token is provisioned yet.
#[tauri::command]
pub fn get_remote_access_token() -> Result<String, String> {
    let path = token_file()?;
    read_plaintext_token(&path).ok_or_else(|| "no remote-access token provisioned".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn write_token_stores_both_hash_and_plaintext() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("remote-access.json");
        let token = "abc123";
        write_token(&path, token).unwrap();

        let raw = std::fs::read_to_string(&path).unwrap();
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        // Daemon validates against this hash.
        assert_eq!(v["hash"].as_str().unwrap(), sha256_hex(token));
        // Plaintext persisted so the QR is reproducible.
        assert_eq!(v["token"].as_str().unwrap(), token);
        assert_eq!(read_plaintext_token(&path).unwrap(), token);
    }

    #[test]
    fn read_plaintext_token_none_for_hash_only_legacy_file() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("remote-access.json");
        // A daemon-written file from before plaintext persistence: hash only,
        // and no sibling handoff file -> nothing to read.
        std::fs::write(&path, r#"{"hash":"deadbeef"}"#).unwrap();
        assert!(read_plaintext_token(&path).is_none());
    }

    #[test]
    fn read_plaintext_token_falls_back_to_daemon_handoff_file() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("remote-access.json");
        // Daemon-written: hash-only json + plaintext in the sibling .txt. The QR
        // must still recover the token from the handoff file.
        std::fs::write(&path, r#"{"hash":"deadbeef"}"#).unwrap();
        std::fs::write(dir.path().join("remote-access-token.txt"), "cafebabe\n").unwrap();
        assert_eq!(read_plaintext_token(&path).as_deref(), Some("cafebabe"));
    }

    #[test]
    fn read_plaintext_token_prefers_json_token_over_handoff() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("remote-access.json");
        write_token(&path, "from_json").unwrap();
        // A stale handoff file must NOT shadow the app-written json token.
        std::fs::write(dir.path().join("remote-access-token.txt"), "stale_handoff").unwrap();
        assert_eq!(read_plaintext_token(&path).as_deref(), Some("from_json"));
    }

    #[test]
    fn mint_token_is_64_hex_chars() {
        let t = mint_token();
        assert_eq!(t.len(), 64);
        assert!(t.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn mint_pairing_code_writes_hash_and_ttl() {
        let dir = tempdir().unwrap();
        let code = do_mint_pairing_code(dir.path()).unwrap();
        assert_eq!(code.len(), 64);
        let raw = std::fs::read_to_string(dir.path().join("remote-pairing.json")).unwrap();
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(v["code_hash"].as_str().unwrap(), sha256_hex(&code));
        let expires_at = v["expires_at"].as_u64().unwrap();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        assert!(expires_at > now);
        assert!(expires_at <= now + 120);
    }

    #[test]
    fn list_remote_devices_returns_empty_without_registry() {
        let dir = tempdir().unwrap();
        let devices = crate::daemon::device_registry::DeviceRegistry::list_devices(dir.path());
        assert!(devices.is_empty());
    }
}
