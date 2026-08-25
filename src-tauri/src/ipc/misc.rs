//! App lifecycle (quit, frontend-ready) and version/install-date IPC commands.
//! File/folder/log commands live in `files.rs`; piper/sound preview commands
//! live in `audio_preview.rs`.

use serde::Serialize;
use tauri::{AppHandle, Manager};

/// The model/effort a chat ran with, from the durable chat-config store. Used by
/// the chat-detail view to show effort on a CLOSED chat (live chats read it off
/// the live Instance instead). None for chats that closed before the store
/// existed.
#[tauri::command]
pub fn get_session_config(session_id: String) -> Option<crate::sessions::chat_config::ChatConfig> {
    crate::sessions::chat_config::get(&session_id)
}

/// Session ids with auto-accept-permissions enabled. The frontend permission
/// gate seeds its in-memory set from this on launch so the toggle survives a
/// restart. Read-only local file read (writes go through `set_auto_accept`,
/// which forwards to the daemon as the sole writer).
#[tauri::command]
pub fn list_auto_accept() -> Vec<String> {
    crate::sessions::chat_config::list_auto_accept()
}

/// A chat's durable busy/last-reconciled marker (`sessions::chat_state`). Lets
/// a freshly-opened window (no in-memory dedup state yet) judge whether a
/// cached session may have moved on without it. None if never recorded.
#[tauri::command]
pub fn get_chat_state(session_id: String) -> Option<crate::sessions::chat_state::ChatState> {
    crate::sessions::chat_state::get(&session_id)
}

#[tauri::command]
pub fn quit_app(app: AppHandle) {
    use std::sync::atomic::Ordering;
    if let Some(state) = app.try_state::<crate::state::AppState>() {
        state.should_quit.store(true, Ordering::SeqCst);
    }
    app.exit(0);
}

/// Frontend signals it loaded successfully. Watchdog in lib.rs::setup uses
/// this to detect a stalled webview (WebView2 "can't reach this page" error)
/// and trigger a reload. Also drains any pending main-window navigation that
/// was queued while the webview was still loading (see `pending_main_nav`).
/// Idempotent; safe to call from every page load.
#[tauri::command]
pub fn frontend_ready(app: AppHandle, window: tauri::Window) {
    use std::sync::atomic::Ordering;
    use tauri::{Emitter, Manager};
    // Every window sends this, so it doubles as the per-window ready gate in
    // `ipc::ready`; unregistered labels (`main`) are a no-op there.
    crate::ipc::ready::mark_ready(&app, window.label());
    if let Some(state) = app.try_state::<crate::state::AppState>() {
        state.frontend_alive.store(true, Ordering::SeqCst);
        let pending = state.pending_main_nav.lock().unwrap().take();
        if let Some(nav) = pending {
            if let Some(w) = app.get_webview_window("main") {
                if nav == "dashboard" {
                    let _ = w.emit("navigate-to-dashboard", ());
                } else if nav == "settings-accounts" {
                    let _ = w.emit("navigate-to-settings-accounts", ());
                } else if let Some(cwd) = nav.strip_prefix("project:") {
                    let _ = w.emit("navigate-to-project", cwd.to_string());
                } else if let Some(acc) = nav.strip_prefix("account:") {
                    let _ = w.emit("navigate-to-account", acc.to_string());
                }
            }
        }
    }
}

/// Heartbeat for the lib.rs renderer-crash watchdog; catches a WebView2
/// crash after boot that `frontend_alive` (one-way, set-once) can't see.
/// `raf_tick` is a `requestAnimationFrame` counter - a paint-liveness signal
/// distinct from this call succeeding, since JS can keep running while the
/// compositor stops presenting frames. Only bumps the timestamp when the
/// tick actually changes, so a frozen tick reads as increasingly stale.
#[tauri::command]
pub fn frontend_ping(app: AppHandle, raf_tick: u64) {
    if let Some(state) = app.try_state::<crate::state::AppState>() {
        *state.last_frontend_ping.lock().unwrap() = Some(std::time::Instant::now());
        let mut raf = state.last_frontend_raf.lock().unwrap();
        if raf.0 != raf_tick {
            *raf = (raf_tick, std::time::Instant::now());
        }
    }
}

#[tauri::command]
pub fn get_platform() -> String {
    match std::env::consts::OS {
        "macos" => "darwin".into(),
        "windows" => "win32".into(),
        other => other.into(),
    }
}

#[tauri::command]
pub fn get_app_version(app: AppHandle) -> String {
    if option_env!("CI").is_none() {
        return "local-build".to_string();
    }
    let cfg = app.config().version.clone();
    cfg.filter(|v| !v.is_empty())
        .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string())
}

#[derive(Serialize)]
pub struct VersionInfo {
    pub version: String,
    pub build_date: String,
    pub installed_at: Option<String>,
}

#[tauri::command]
pub async fn get_version_info(app: AppHandle) -> VersionInfo {
    let version = get_app_version(app.clone());
    let base_date = option_env!("BUILD_DATE").unwrap_or("unknown").to_string();
    let build_date = if base_date == "unknown" {
        base_date
    } else {
        let data_dir = app.path().app_data_dir().ok();
        match data_dir {
            Some(dir) => fetch_build_datetime(&version, &base_date, &dir).await,
            None => base_date,
        }
    };
    let installed_at = load_or_record_install_date(&version);
    VersionInfo { version, build_date, installed_at }
}

/// Returns `"YYYY-MM-DD HH:MM"` for the given version by fetching the GitHub
/// release `published_at` field. Caches the result so only the first call per
/// version hits the network. Falls back to `base_date` (`"YYYY-MM-DD"`) on any
/// error so the UI always shows at least a date.
async fn fetch_build_datetime(version: &str, base_date: &str, data_dir: &std::path::Path) -> String {
    // Local / non-release builds: nothing to fetch.
    if version == "local-build" || version == "unknown" {
        return base_date.to_string();
    }

    #[derive(serde::Deserialize, serde::Serialize)]
    struct BuildTimeCache { version: String, datetime: String }

    let cache_path = data_dir.join("build-time-cache.json");

    // Cache hit?
    if let Ok(raw) = std::fs::read_to_string(&cache_path) {
        if let Ok(c) = serde_json::from_str::<BuildTimeCache>(&raw) {
            if c.version == version {
                return c.datetime;
            }
        }
    }

    // Fetch from GitHub releases API.
    let url = format!(
        "https://api.github.com/repos/SirBepy/claude_conductor/releases/tags/v{version}"
    );
    let result: Option<String> = async {
        #[derive(serde::Deserialize)]
        struct GhRelease { published_at: Option<String> }

        let client = reqwest::Client::builder()
            .user_agent("claude-companion-app")
            .timeout(std::time::Duration::from_secs(8))
            .build()
            .ok()?;
        let resp = client.get(&url).send().await.ok()?;
        let release: GhRelease = resp.json().await.ok()?;
        let iso = release.published_at?;
        // ISO 8601: "2026-06-28T13:35:00Z" → "2026-06-28 13:35"
        let date_part = iso.get(..10)?;
        let time_part = iso.get(11..16)?;
        Some(format!("{date_part} {time_part}"))
    }.await;

    match result {
        Some(datetime) => {
            let cache = BuildTimeCache { version: version.to_string(), datetime: datetime.clone() };
            if let Ok(json) = serde_json::to_string(&cache) {
                let _ = std::fs::write(&cache_path, json);
            }
            datetime
        }
        None => base_date.to_string(),
    }
}

fn load_or_record_install_date(current_version: &str) -> Option<String> {
    #[derive(serde::Deserialize, serde::Serialize)]
    struct InstallInfo { version: String, installed_at: String }

    let dir = crate::settings::paths::data_dir().ok()?;
    let path = dir.join("install-info.json");

    if let Ok(content) = std::fs::read_to_string(&path) {
        if let Ok(info) = serde_json::from_str::<InstallInfo>(&content) {
            if info.version == current_version {
                return Some(info.installed_at);
            }
        }
    }

    // UTC date string (matches the prior hand-rolled epoch->YMD math, which also
    // worked off UNIX_EPOCH seconds). chrono is already a crate dependency.
    let today = chrono::Utc::now().format("%Y-%m-%d %H:%M").to_string();
    let info = InstallInfo { version: current_version.to_string(), installed_at: today.clone() };
    if let Ok(json) = serde_json::to_string(&info) {
        let _ = std::fs::write(&path, json);
    }
    Some(today)
}

#[cfg(test)]
mod tests {
    use tempfile::tempdir;

    #[test]
    fn check_paths_exist_reports_each_path_independently() {
        use super::super::projects::check_paths_exist;
        let dir = tempdir().unwrap();
        let real = dir.path().join("real");
        std::fs::create_dir(&real).unwrap();
        let fake = dir.path().join("not-here");

        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let result = rt.block_on(check_paths_exist(vec![
            real.to_string_lossy().to_string(),
            fake.to_string_lossy().to_string(),
        ]));
        assert_eq!(result[&real.to_string_lossy().to_string()], true);
        assert_eq!(result[&fake.to_string_lossy().to_string()], false);
    }
}
