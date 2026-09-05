//! Resolves on-disk paths for app data (settings, history, session).

use anyhow::{anyhow, Result};
use std::path::PathBuf;

/// Resolves the data dir given an optional `CC_DATA_DIR` override value.
/// Pure so it's testable without touching process env state.
fn resolve_data_dir(override_: Option<&str>) -> Result<PathBuf> {
    if let Some(v) = override_ {
        if !v.is_empty() {
            return Ok(PathBuf::from(v));
        }
    }
    let base = dirs::config_dir()
        .ok_or_else(|| anyhow!("could not resolve user config dir"))?;
    Ok(base.join("claude-conductor"))
}

/// Returns the directory where we store everything: settings, history, session.
/// On Windows this is `%APPDATA%\claude-conductor`, unless `CC_DATA_DIR` is
/// set: a second daemon instance (test, or a peer machine's dev run) uses it
/// to keep a fully separate app-data tree.
pub fn data_dir() -> Result<PathBuf> {
    resolve_data_dir(std::env::var("CC_DATA_DIR").ok().as_deref())
}

/// Pre-rename data directory (`%APPDATA%\claude-usage-tauri`). The app shipped
/// under this name before the "Claude Conductor" rename; user data (settings,
/// `companion.db`, characters, sound packs, etc.) still lives here for anyone who
/// upgrades across the rename. See `migrate_legacy_data_dir`.
fn legacy_data_dir() -> Result<PathBuf> {
    let base = dirs::config_dir()
        .ok_or_else(|| anyhow!("could not resolve user config dir"))?;
    Ok(base.join("claude-usage-tauri"))
}

/// One-shot, non-destructive migration of pre-rename user data into the current
/// data dir. Copies any file present in the legacy dir but MISSING in the new dir
/// (recursively), never overwriting a file the new build already wrote. Guarded by
/// a marker so it runs at most once, even across app/daemon restarts.
///
/// Without this, the rename silently pointed the app at an empty data dir and
/// orphaned every prior install's history, settings, and characters.
pub fn migrate_legacy_data_dir() {
    let (Ok(legacy), Ok(new)) = (legacy_data_dir(), data_dir()) else { return };
    if !legacy.exists() || legacy == new {
        return;
    }
    let marker = new.join(".migrated-from-claude-usage-tauri");
    if marker.exists() {
        return;
    }
    if let Err(e) = std::fs::create_dir_all(&new) {
        log::warn!("legacy migration: could not create data dir: {e:#}");
        return;
    }
    let copied = copy_missing_recursive(&legacy, &new);
    if copied > 0 {
        log::info!("legacy migration: recovered {copied} file(s) from claude-usage-tauri");
    }
    // Write the marker regardless so a partially-failed copy doesn't loop forever;
    // copy_missing_recursive already logged any per-file failures.
    if let Err(e) = std::fs::write(&marker, b"migrated\n") {
        log::warn!("legacy migration: could not write marker: {e:#}");
    }
}

/// Copies every file under `src` into the mirrored path under `dst`, skipping any
/// file that already exists in `dst`. Returns the number of files copied. Skips
/// ephemeral runtime artifacts (locks, port files, logs) that the new instance
/// owns and regenerates.
pub(crate) fn copy_missing_recursive(src: &std::path::Path, dst: &std::path::Path) -> usize {
    let mut copied = 0;
    let entries = match std::fs::read_dir(src) {
        Ok(e) => e,
        Err(e) => {
            log::warn!("legacy migration: cannot read {}: {e:#}", src.display());
            return 0;
        }
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        // Ephemeral / instance-owned files the new process regenerates.
        if name_str.ends_with(".lock")
            || name_str.starts_with("hooks_port")
            || (name_str.starts_with("daemon") && name_str.ends_with(".log"))
            || name_str == "mcp"
        {
            continue;
        }
        let from = entry.path();
        let to = dst.join(&name);
        if from.is_dir() {
            if let Err(e) = std::fs::create_dir_all(&to) {
                log::warn!("legacy migration: mkdir {} failed: {e:#}", to.display());
                continue;
            }
            copied += copy_missing_recursive(&from, &to);
        } else if !to.exists() {
            match std::fs::copy(&from, &to) {
                Ok(_) => copied += 1,
                Err(e) => log::warn!("legacy migration: copy {} failed: {e:#}", from.display()),
            }
        }
    }
    copied
}

pub fn settings_file() -> Result<PathBuf> {
    Ok(data_dir()?.join("settings.json"))
}

pub fn history_file() -> Result<PathBuf> {
    Ok(data_dir()?.join("history.jsonl"))
}

pub fn session_file() -> Result<PathBuf> {
    Ok(data_dir()?.join("session.txt"))
}

pub fn token_history_file() -> Result<PathBuf> {
    Ok(data_dir()?.join("token-history.json"))
}

/// Durable `busy` + last-reconciled marker per chat (`sessions::chat_state`).
/// Mirrors `chat-config.json`'s shape/ownership: daemon-only writer, atomic.
pub fn chat_state_file() -> Result<PathBuf> {
    Ok(data_dir()?.join("chat-state.json"))
}

/// Persisted self-calibrating window-capacity estimate, in cost-weighted drain
/// units (see `tokens::capacity`). Drives each chat's "% of a 5h session".
pub fn session_capacity_file() -> Result<PathBuf> {
    Ok(data_dir()?.join("session-capacity.json"))
}

/// SQLite store consolidating usage / token / skill history. Lives in the same
/// data dir as the other persisted files.
pub fn companion_db() -> Result<PathBuf> {
    Ok(data_dir()?.join("companion.db"))
}

pub fn sounds_dir() -> anyhow::Result<std::path::PathBuf> {
    // In dev: tauri/assets/sounds. In bundle: resource dir beside the exe.
    let exe = std::env::current_exe()?;
    let bundled = exe.parent().map(|p| p.join("resources").join("assets").join("sounds"));
    if let Some(p) = bundled.filter(|p| p.exists()) { return Ok(p); }
    // Dev fallback:
    let manifest = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    Ok(manifest.join("assets").join("sounds"))
}

/// Ensures the data directory exists. Idempotent.
pub fn ensure_data_dir() -> Result<PathBuf> {
    let dir = data_dir()?;
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

pub fn piper_voices_dir() -> anyhow::Result<std::path::PathBuf> {
    let d = ensure_data_dir()?;
    let p = d.join("piper").join("voices");
    std::fs::create_dir_all(&p)?;
    Ok(p)
}

pub fn log_file() -> anyhow::Result<std::path::PathBuf> {
    let d = ensure_data_dir()?;
    let p = d.join("logs");
    std::fs::create_dir_all(&p).ok();
    Ok(p.join("claude-conductor.log"))
}

/// Target-triple suffix Tauri appends to sidecar binaries at build and bundle
/// time. Matches the `externalBin` convention in `tauri.conf.json`, where
/// `binaries/piper/piper` expands to `piper-<triple><ext>` on disk both in
/// `target/<profile>/` (dev) and next to the app exe (release bundle).
fn piper_sidecar_name() -> &'static str {
    if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        "piper-x86_64-pc-windows-msvc.exe"
    } else if cfg!(all(target_os = "windows", target_arch = "aarch64")) {
        "piper-aarch64-pc-windows-msvc.exe"
    } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
        "piper-x86_64-apple-darwin"
    } else if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        "piper-aarch64-apple-darwin"
    } else if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        "piper-x86_64-unknown-linux-gnu"
    } else if cfg!(all(target_os = "linux", target_arch = "aarch64")) {
        "piper-aarch64-unknown-linux-gnu"
    } else if cfg!(windows) {
        "piper.exe"
    } else {
        "piper"
    }
}

pub fn piper_binary_path() -> anyhow::Result<std::path::PathBuf> {
    let exe = std::env::current_exe()?;
    let parent = exe.parent().ok_or_else(|| anyhow::anyhow!("no exe parent"))?;
    Ok(parent.join(piper_sidecar_name()))
}

pub fn sound_packs_dir() -> anyhow::Result<std::path::PathBuf> {
    let d = ensure_data_dir()?;
    let p = d.join("sound-packs");
    std::fs::create_dir_all(&p)?;
    Ok(p)
}

pub fn characters_dir() -> anyhow::Result<std::path::PathBuf> {
    let d = ensure_data_dir()?;
    let p = d.join("characters");
    std::fs::create_dir_all(&p)?;
    Ok(p)
}

pub fn hooks_port_file() -> anyhow::Result<std::path::PathBuf> {
    Ok(data_dir()?.join("hooks_port.txt"))
}

/// Read the daemon hook port from `hooks_port[suffix].txt`. Returns `None` if
/// the file is absent or the content cannot be parsed as a `u16`.
pub(crate) fn read_hook_port(suffix: &str) -> Option<u16> {
    hooks_port_file().ok().map(|p| {
        if suffix.is_empty() { p } else { p.with_file_name(format!("hooks_port{suffix}.txt")) }
    })
    .and_then(|p| std::fs::read_to_string(p).ok())
    .and_then(|s| s.trim().parse().ok())
}

pub fn news_file() -> Result<PathBuf> {
    Ok(data_dir()?.join("news.json"))
}

pub fn interactive_sessions_file() -> Result<PathBuf> {
    // Instance-scoped, like the daemon lockfile/pipe/hook-port: a test or wdio
    // daemon (CC_DAEMON_INSTANCE set) must not read or clobber the production
    // user's snapshot. Empty suffix for the default (production) instance.
    let suffix = crate::daemon::instance::instance_suffix();
    Ok(data_dir()?.join(format!("interactive-sessions{suffix}.json")))
}

/// Instance-scoped daemon log, mirroring `interactive_sessions_file()`: a dev,
/// wdio or test daemon must not interleave its lines into the production log.
/// Empty suffix for the default instance, so production stays `daemon.log`.
pub fn daemon_log_name() -> String {
    format!("daemon{}.log", crate::daemon::instance::instance_suffix())
}

pub fn mcp_temp_dir() -> anyhow::Result<std::path::PathBuf> {
    let d = ensure_data_dir()?;
    let p = d.join("mcp");
    std::fs::create_dir_all(&p)?;
    Ok(p)
}

pub fn skill_usage_dir() -> anyhow::Result<std::path::PathBuf> {
    let d = ensure_data_dir()?;
    let p = d.join("skill-usage");
    std::fs::create_dir_all(&p)?;
    Ok(p)
}

/// Persisted multi-account registry (`Vec<Account>`). See `crate::accounts`.
pub fn accounts_file() -> Result<PathBuf> {
    Ok(data_dir()?.join("accounts.json"))
}

/// Per-account sessionKey cookie file, keyed by account id. Legacy
/// single-account `session_file()` keeps working until migration (milestone
/// 08); this is the per-account successor used by the add-account wizard.
pub fn account_session_file(account_id: &str) -> Result<PathBuf> {
    Ok(data_dir()?.join(format!("session-{account_id}.txt")))
}

/// Per-account chrome profile dir for the web-cookie login flow (avoids
/// cookie collisions between accounts). Keyed by account id, mirroring
/// `account_session_file`.
pub fn account_chrome_profile_dir(account_id: &str) -> Result<PathBuf> {
    Ok(data_dir()?.join("chrome-profiles").join(account_id))
}

/// Per-account persisted window-capacity estimate (see `tokens::capacity`),
/// keyed by account id so each account's cost-weighted drain ruler is
/// calibrated against its own utilization/window-reset numbers. Legacy
/// single-account callers keep using `session_capacity_file()` unchanged.
pub fn account_session_capacity_file(account_id: &str) -> Result<PathBuf> {
    Ok(data_dir()?.join(format!("session-capacity-{account_id}.json")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_data_dir_override_wins() {
        let d = resolve_data_dir(Some("C:/tmp/cc-test-data-dir")).unwrap();
        assert_eq!(d, PathBuf::from("C:/tmp/cc-test-data-dir"));
    }

    #[test]
    fn resolve_data_dir_empty_override_falls_back_to_default() {
        let d = resolve_data_dir(Some("")).unwrap();
        assert!(d.ends_with("claude-conductor"));
    }

    #[test]
    fn resolve_data_dir_none_falls_back_to_default() {
        let d = resolve_data_dir(None).unwrap();
        assert!(d.ends_with("claude-conductor"));
    }
}
