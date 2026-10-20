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

/// Which side of the federation boundary a device is: a phone/browser
/// client, or a peer daemon (multi-machine mirroring). Old registries never
/// wrote this field, so `#[serde(default)]` on `DeviceEntry::kind` resolves
/// them to `Phone` - the only kind that existed before this.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Default)]
#[serde(rename_all = "lowercase")]
pub enum DeviceKind {
    #[default]
    Phone,
    Machine,
}

#[derive(Serialize, Deserialize, Default, Clone)]
struct DeviceEntry {
    id: String,
    name: String,
    token_hash: String,
    created_at: u64,
    #[serde(default)]
    kind: DeviceKind,
    #[serde(default)]
    machine_id: Option<String>,
    /// Unix seconds of the last successful auth, written at most once per
    /// `LAST_USED_WRITE_INTERVAL_SECS`. `None` only in a registry written
    /// before this field existed; `stamp_missing_last_used` fills it on the
    /// first auth so an upgrade never starts the idle clock at `created_at`.
    #[serde(default)]
    last_used: Option<u64>,
}

#[derive(Serialize, Deserialize, Default, Clone)]
struct RegistryFile {
    devices: Vec<DeviceEntry>,
    /// The one remote-access switch: gates the remote server's authed routes,
    /// pairing, and whether the iroh tunnel is bound at all.
    #[serde(default = "bool_true")]
    enabled: bool,
    /// 0 = written before remote access became off-by-default. Every daemon
    /// boot used to force `enabled: true` (`ensure_desktop_device`), so a
    /// schema-0 `true` is not a user choice and `migrate` re-derives it.
    #[serde(default)]
    schema: u32,
}

const SCHEMA: u32 = 1;

/// A token unused this long stops authenticating, so a leaked phone or peer
/// token retires itself without outliving a forgotten device by years.
const IDLE_EXPIRY_SECS: u64 = 90 * 24 * 60 * 60;

/// Auth runs on every request; writing the registry each time would hammer
/// the disk, and a one-hour grain is far below the 90-day window.
const LAST_USED_WRITE_INTERVAL_SECS: u64 = 60 * 60;

fn bool_true() -> bool { true }

/// Off-by-default migration: a schema-0 registry keeps remote access on only
/// if something was actually paired (a phone, or a peer machine), so an
/// install that never used it stops publishing an iroh endpoint. A schema-0
/// `false` was the user's own kill switch and stays off.
fn migrate(mut reg: RegistryFile) -> RegistryFile {
    if reg.schema < SCHEMA {
        reg.enabled = reg.enabled && reg.devices.iter().any(|d| d.id != DESKTOP_ID);
        reg.schema = SCHEMA;
    }
    reg
}

/// The local desktop webview's own token (voice `/ws/transcribe`), not a
/// remote device: it never counts as "something was paired".
const DESKTOP_ID: &str = "desktop";

/// Device summary exposed via IPC. token_hash is never included.
#[derive(Serialize, Clone)]
pub struct RemoteDevice {
    pub id: String,
    pub name: String,
    pub created_at: u64,
    pub kind: DeviceKind,
    /// `None` until the device's first auth after the field was introduced.
    pub last_used: Option<u64>,
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
        .map(migrate)
        .unwrap_or(RegistryFile { schema: SCHEMA, ..Default::default() })
}

/// Gives every pre-field entry `last_used = now`, so the upgrade itself never
/// locks a device out. Returns whether anything changed (caller persists).
fn stamp_missing_last_used(reg: &mut RegistryFile, now: u64) -> bool {
    let mut changed = false;
    for d in reg.devices.iter_mut().filter(|d| d.last_used.is_none()) {
        d.last_used = Some(now);
        changed = true;
    }
    changed
}

fn save(reg: &RegistryFile, app_data: &Path) -> Result<(), String> {
    let body = serde_json::to_string_pretty(reg).map_err(|e| e.to_string())?;
    crate::util::write_json_atomic(&registry_path(app_data), &body).map_err(|e| e.to_string())
}

/// Result of checking a presented token against the registry and the
/// remote-access switch.
#[derive(Debug, PartialEq, Clone)]
pub enum AuthOutcome {
    Ok(DeviceKind, Option<String>),
    /// Remote access is switched off: refuse everything, even a valid token.
    Disabled,
    Invalid,
}

pub struct DeviceRegistry;

impl DeviceRegistry {
    /// Ensures the "desktop" device is registered so /ws/transcribe can authenticate.
    /// Also writes the plaintext token to remote-access.json so get_remote_access_token IPC still works.
    /// Idempotent: no-op if desktop device already exists.
    pub fn ensure_desktop_device(app_data: &Path) {
        let mut reg = load(app_data);
        if reg.devices.iter().any(|d| d.id == DESKTOP_ID) {
            return;
        }
        let token = mint_token();
        reg.devices.push(DeviceEntry {
            id: DESKTOP_ID.to_string(),
            name: "Desktop (this PC)".to_string(),
            token_hash: sha256_hex(&token),
            created_at: now_secs(),
            kind: DeviceKind::Phone,
            machine_id: None,
            last_used: Some(now_secs()),
        });
        if let Err(e) = save(&reg, app_data) {
            log::error!("device_registry: failed to save desktop device: {e}");
            return;
        }
        let body = serde_json::json!({ "hash": sha256_hex(&token), "token": token });
        if let Err(e) = crate::util::write_json_atomic(
            &desktop_token_path(app_data),
            &serde_json::to_string_pretty(&body).unwrap_or_default(),
        ) {
            log::error!("device_registry: failed to write desktop token file: {e}");
        }
        log::info!("device_registry: desktop device registered");
    }

    /// True when remote access is switched on (default: off).
    pub fn is_enabled(app_data: &Path) -> bool {
        load(app_data).enabled
    }

    /// True when remote access is on AND the presented token matches a
    /// registered device. Fail-closed: false when the registry is missing or
    /// unreadable.
    pub fn validate_token(token: &str, app_data: &Path) -> bool {
        Self::resolve_token(token, app_data).is_some()
    }

    /// Resolve a bearer token to its device kind + machine id (Machine
    /// devices only). Fail-closed: `None` when the registry is missing,
    /// unreadable, remote access is switched off, or no entry's token hash
    /// matches. The switch check lives here so a self-authenticating route
    /// (query-token WS, preview GET) cannot forget it.
    pub fn resolve_token(token: &str, app_data: &Path) -> Option<(DeviceKind, Option<String>)> {
        match Self::authenticate(token, app_data) {
            AuthOutcome::Ok(kind, machine_id) => Some((kind, machine_id)),
            AuthOutcome::Disabled | AuthOutcome::Invalid => None,
        }
    }

    /// Switch and token check off ONE registry read, distinguishing "switched
    /// off" (503) from "bad token" (401). Blocking file I/O: async callers
    /// use `authenticate_blocking_safe`.
    pub fn authenticate(token: &str, app_data: &Path) -> AuthOutcome {
        Self::authenticate_at(token, app_data, now_secs())
    }

    /// `authenticate` for the local voice socket only: the desktop device's own
    /// token passes even with Remote access off (that is the default, and
    /// dictation must work there), while every other token, and the desktop
    /// token on any other route, still gets `Disabled`.
    pub fn authenticate_desktop_voice(token: &str, app_data: &Path) -> AuthOutcome {
        Self::authenticate_with(token, app_data, now_secs(), true)
    }

    /// `authenticate` with an injected clock so expiry and the write throttle
    /// are testable without sleeping.
    fn authenticate_at(token: &str, app_data: &Path, now: u64) -> AuthOutcome {
        Self::authenticate_with(token, app_data, now, false)
    }

    fn authenticate_with(token: &str, app_data: &Path, now: u64, desktop_bypasses_switch: bool) -> AuthOutcome {
        let mut reg = load(app_data);
        let hash = sha256_hex(token);
        if !reg.enabled {
            let is_desktop = reg.devices.iter().any(|d| d.id == DESKTOP_ID && d.token_hash == hash);
            if !(desktop_bypasses_switch && is_desktop) {
                return AuthOutcome::Disabled;
            }
        }
        let mut dirty = stamp_missing_last_used(&mut reg, now);
        let outcome = match reg.devices.iter_mut().find(|d| d.token_hash == hash) {
            // The desktop token backs the local voice socket and is never
            // re-presented by a device that could go idle.
            Some(d) if d.id != DESKTOP_ID
                && now.saturating_sub(d.last_used.unwrap_or(now)) > IDLE_EXPIRY_SECS =>
            {
                AuthOutcome::Invalid
            }
            Some(d) => {
                if now.saturating_sub(d.last_used.unwrap_or(0)) >= LAST_USED_WRITE_INTERVAL_SECS {
                    d.last_used = Some(now);
                    dirty = true;
                }
                AuthOutcome::Ok(d.kind, d.machine_id.clone())
            }
            None => AuthOutcome::Invalid,
        };
        if dirty {
            if let Err(e) = save(&reg, app_data) {
                log::warn!("device_registry: failed to record last_used: {e}");
            }
        }
        outcome
    }

    /// `authenticate` on the blocking pool. The registry is re-read from disk
    /// per call rather than cached because the app process (a different
    /// process from the daemon) writes it on pair/revoke/toggle and those must
    /// take effect immediately; the read just must not run on an async worker.
    pub async fn authenticate_blocking_safe(token: String, app_data: PathBuf) -> AuthOutcome {
        // A join error (panic in the closure) denies, never admits.
        tokio::task::spawn_blocking(move || Self::authenticate(&token, &app_data))
            .await
            .unwrap_or(AuthOutcome::Invalid)
    }

    /// `authenticate_desktop_voice` on the blocking pool.
    pub async fn authenticate_desktop_voice_blocking_safe(token: String, app_data: PathBuf) -> AuthOutcome {
        tokio::task::spawn_blocking(move || Self::authenticate_desktop_voice(&token, &app_data))
            .await
            .unwrap_or(AuthOutcome::Invalid)
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
            kind: DeviceKind::Phone,
            machine_id: None,
            last_used: Some(now_secs()),
        });
        save(&reg, app_data)?;
        Ok(token)
    }

    /// Mint a token for a paired peer daemon (kind Machine). This is the
    /// bearer THEY present to US; the caller separately records the token
    /// WE present to THEM in `MachineRegistry::PeerMachine::token`. Returns
    /// `(plaintext_token, device_id)` - the id is needed by the pairing flow
    /// to stamp `PeerMachine::reverse_device_id` so an unpair/re-pair can
    /// revoke exactly this entry later.
    pub fn add_machine_device(name: &str, machine_id: &str, app_data: &Path) -> Result<(String, String), String> {
        let mut reg = load(app_data);
        let token = mint_token();
        let id = mint_id();
        reg.devices.push(DeviceEntry {
            id: id.clone(),
            name: name.to_string(),
            token_hash: sha256_hex(&token),
            created_at: now_secs(),
            kind: DeviceKind::Machine,
            machine_id: Some(machine_id.to_string()),
            last_used: Some(now_secs()),
        });
        save(&reg, app_data)?;
        Ok((token, id))
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

    /// Flip the remote-access switch. When false, auth_mw and pairing return
    /// 503 and `iroh_tunnel` closes its endpoint on its next poll.
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
            kind: d.kind,
            last_used: d.last_used,
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
        DeviceRegistry::set_enabled(true, dir.path()).unwrap();
        let token = DeviceRegistry::add_device("My Phone", dir.path()).unwrap();
        assert_eq!(token.len(), 64);
        assert!(token.chars().all(|c| c.is_ascii_hexdigit()));
        assert!(DeviceRegistry::validate_token(&token, dir.path()));
        assert!(!DeviceRegistry::validate_token("wrong", dir.path()));
    }

    #[test]
    fn revoke_removes_device() {
        let dir = tempdir().unwrap();
        DeviceRegistry::set_enabled(true, dir.path()).unwrap();
        let token = DeviceRegistry::add_device("Test", dir.path()).unwrap();
        assert!(DeviceRegistry::validate_token(&token, dir.path()));
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
    fn fresh_install_is_off_until_enabled() {
        let dir = tempdir().unwrap();
        assert!(!DeviceRegistry::is_enabled(dir.path()));
        DeviceRegistry::ensure_desktop_device(dir.path());
        assert!(!DeviceRegistry::is_enabled(dir.path()), "registering the desktop token must not switch remote access on");
    }

    fn write_schema0(dir: &Path, devices: serde_json::Value, enabled: bool) {
        let body = serde_json::json!({ "devices": devices, "enabled": enabled });
        std::fs::write(registry_path(dir), body.to_string()).unwrap();
    }

    fn device_json(id: &str) -> serde_json::Value {
        serde_json::json!({"id": id, "name": id, "token_hash": sha256_hex(id), "created_at": 0})
    }

    #[test]
    fn schema0_with_only_the_desktop_token_migrates_off() {
        let dir = tempdir().unwrap();
        write_schema0(dir.path(), serde_json::json!([device_json("desktop")]), true);
        assert!(!DeviceRegistry::is_enabled(dir.path()));
    }

    #[test]
    fn schema0_with_a_paired_phone_stays_on() {
        let dir = tempdir().unwrap();
        write_schema0(dir.path(), serde_json::json!([device_json("desktop"), device_json("p1")]), true);
        assert!(DeviceRegistry::is_enabled(dir.path()));
    }

    #[test]
    fn schema0_kill_switch_engaged_stays_off_even_with_a_phone() {
        let dir = tempdir().unwrap();
        write_schema0(dir.path(), serde_json::json!([device_json("p1")]), false);
        assert!(!DeviceRegistry::is_enabled(dir.path()));
    }

    #[test]
    fn migration_runs_once_so_enabling_with_nothing_paired_sticks() {
        let dir = tempdir().unwrap();
        write_schema0(dir.path(), serde_json::json!([device_json("desktop")]), true);
        DeviceRegistry::set_enabled(true, dir.path()).unwrap();
        DeviceRegistry::ensure_desktop_device(dir.path());
        assert!(DeviceRegistry::is_enabled(dir.path()));
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
        DeviceRegistry::set_enabled(true, dir.path()).unwrap();
        let raw = std::fs::read_to_string(dir.path().join("remote-access.json")).unwrap();
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        let token = v["token"].as_str().unwrap();
        assert!(!token.is_empty());
        assert!(DeviceRegistry::validate_token(token, dir.path()));
    }

    #[test]
    fn old_registry_without_kind_field_defaults_to_phone() {
        let dir = tempdir().unwrap();
        let body = serde_json::json!({
            "devices": [{"id": "d1", "name": "Old Phone", "token_hash": sha256_hex("tok"), "created_at": 0}],
            "enabled": true
        });
        std::fs::write(registry_path(dir.path()), body.to_string()).unwrap();
        let devices = DeviceRegistry::list_devices(dir.path());
        assert_eq!(devices.len(), 1);
        assert_eq!(devices[0].kind, DeviceKind::Phone);
    }

    #[test]
    fn machine_device_resolves_kind_and_machine_id() {
        let dir = tempdir().unwrap();
        DeviceRegistry::set_enabled(true, dir.path()).unwrap();
        let (token, id) = DeviceRegistry::add_machine_device("Mac Mini", "mach-123", dir.path()).unwrap();
        let (kind, machine_id) = DeviceRegistry::resolve_token(&token, dir.path()).unwrap();
        assert_eq!(kind, DeviceKind::Machine);
        assert_eq!(machine_id.as_deref(), Some("mach-123"));
        assert!(DeviceRegistry::revoke_device(&id, dir.path()).unwrap());
    }

    #[test]
    fn switched_off_registry_refuses_a_valid_token() {
        let dir = tempdir().unwrap();
        let token = DeviceRegistry::add_device("Phone", dir.path()).unwrap();
        assert_eq!(DeviceRegistry::authenticate(&token, dir.path()), AuthOutcome::Disabled);
        assert!(DeviceRegistry::resolve_token(&token, dir.path()).is_none());
        assert!(!DeviceRegistry::validate_token(&token, dir.path()));
        DeviceRegistry::set_enabled(true, dir.path()).unwrap();
        assert!(matches!(DeviceRegistry::authenticate(&token, dir.path()), AuthOutcome::Ok(DeviceKind::Phone, None)));
        assert_eq!(DeviceRegistry::authenticate("wrong", dir.path()), AuthOutcome::Invalid);
    }

    #[test]
    fn desktop_token_passes_the_voice_gate_with_the_switch_off_and_nothing_else_does() {
        let dir = tempdir().unwrap();
        DeviceRegistry::ensure_desktop_device(dir.path());
        let desktop = std::fs::read_to_string(desktop_token_path(dir.path())).unwrap();
        let desktop: serde_json::Value = serde_json::from_str(&desktop).unwrap();
        let desktop = desktop["token"].as_str().unwrap().to_string();
        let phone = DeviceRegistry::add_device("Phone", dir.path()).unwrap();
        let (machine, _) = DeviceRegistry::add_machine_device("Mac", "m-1", dir.path()).unwrap();
        assert!(!DeviceRegistry::is_enabled(dir.path()), "default install is off");

        assert!(matches!(DeviceRegistry::authenticate_desktop_voice(&desktop, dir.path()), AuthOutcome::Ok(..)));
        // The switch stays fully effective for everything else.
        assert_eq!(DeviceRegistry::authenticate_desktop_voice(&phone, dir.path()), AuthOutcome::Disabled);
        assert_eq!(DeviceRegistry::authenticate_desktop_voice(&machine, dir.path()), AuthOutcome::Disabled);
        assert_eq!(DeviceRegistry::authenticate_desktop_voice("wrong", dir.path()), AuthOutcome::Disabled);
        // And the desktop token is still refused on every non-voice route.
        assert_eq!(DeviceRegistry::authenticate(&desktop, dir.path()), AuthOutcome::Disabled);
    }

    #[tokio::test]
    async fn blocking_safe_auth_sees_toggle_and_revoke_immediately() {
        let dir = tempdir().unwrap();
        DeviceRegistry::set_enabled(true, dir.path()).unwrap();
        let token = DeviceRegistry::add_device("Phone", dir.path()).unwrap();
        let go = || DeviceRegistry::authenticate_blocking_safe(token.clone(), dir.path().to_path_buf());
        assert!(matches!(go().await, AuthOutcome::Ok(..)));
        DeviceRegistry::set_enabled(false, dir.path()).unwrap();
        assert_eq!(go().await, AuthOutcome::Disabled);
        DeviceRegistry::set_enabled(true, dir.path()).unwrap();
        let id = DeviceRegistry::list_devices(dir.path())[0].id.clone();
        DeviceRegistry::revoke_device(&id, dir.path()).unwrap();
        assert_eq!(go().await, AuthOutcome::Invalid);
    }

    const DAY: u64 = 24 * 60 * 60;

    fn last_used_of(dir: &Path) -> Option<u64> {
        DeviceRegistry::list_devices(dir)[0].last_used
    }

    #[test]
    fn token_unused_for_over_90_days_stops_authenticating() {
        let dir = tempdir().unwrap();
        DeviceRegistry::set_enabled(true, dir.path()).unwrap();
        let token = DeviceRegistry::add_device("Phone", dir.path()).unwrap();
        let t0 = last_used_of(dir.path()).unwrap();
        assert!(matches!(DeviceRegistry::authenticate_at(&token, dir.path(), t0 + 89 * DAY), AuthOutcome::Ok(..)));
        // The success above refreshed last_used, so measure from there.
        let t1 = last_used_of(dir.path()).unwrap();
        assert_eq!(DeviceRegistry::authenticate_at(&token, dir.path(), t1 + 91 * DAY), AuthOutcome::Invalid);
    }

    #[test]
    fn an_active_device_never_expires() {
        let dir = tempdir().unwrap();
        DeviceRegistry::set_enabled(true, dir.path()).unwrap();
        let token = DeviceRegistry::add_device("Phone", dir.path()).unwrap();
        let t0 = last_used_of(dir.path()).unwrap();
        for day in (30..=400).step_by(30) {
            let out = DeviceRegistry::authenticate_at(&token, dir.path(), t0 + day * DAY);
            assert!(matches!(out, AuthOutcome::Ok(..)), "day {day}");
        }
    }

    #[test]
    fn last_used_write_is_throttled_to_once_an_hour() {
        let dir = tempdir().unwrap();
        DeviceRegistry::set_enabled(true, dir.path()).unwrap();
        let token = DeviceRegistry::add_device("Phone", dir.path()).unwrap();
        let t0 = last_used_of(dir.path()).unwrap();
        DeviceRegistry::authenticate_at(&token, dir.path(), t0 + 600);
        assert_eq!(last_used_of(dir.path()), Some(t0), "10 min later: no write");
        DeviceRegistry::authenticate_at(&token, dir.path(), t0 + 3600);
        assert_eq!(last_used_of(dir.path()), Some(t0 + 3600));
    }

    #[test]
    fn registry_without_last_used_loads_and_counts_first_auth_as_now() {
        let dir = tempdir().unwrap();
        let body = serde_json::json!({
            "devices": [{"id": "d1", "name": "Old", "token_hash": sha256_hex("tok"), "created_at": 0}],
            "enabled": true, "schema": 1
        });
        std::fs::write(registry_path(dir.path()), body.to_string()).unwrap();
        assert_eq!(last_used_of(dir.path()), None);
        // created_at = 0 is far past 90 days: must still admit on upgrade.
        let now = 1_800_000_000;
        assert!(matches!(DeviceRegistry::authenticate_at("tok", dir.path(), now), AuthOutcome::Ok(..)));
        assert_eq!(last_used_of(dir.path()), Some(now));
        assert_eq!(DeviceRegistry::authenticate_at("tok", dir.path(), now + 91 * DAY), AuthOutcome::Invalid);
    }

    #[test]
    fn the_desktop_token_never_idles_out() {
        let dir = tempdir().unwrap();
        DeviceRegistry::ensure_desktop_device(dir.path());
        DeviceRegistry::set_enabled(true, dir.path()).unwrap();
        let raw = std::fs::read_to_string(dir.path().join("remote-access.json")).unwrap();
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        let token = v["token"].as_str().unwrap();
        let t0 = last_used_of(dir.path()).unwrap();
        assert!(matches!(DeviceRegistry::authenticate_at(token, dir.path(), t0 + 500 * DAY), AuthOutcome::Ok(..)));
    }
}
