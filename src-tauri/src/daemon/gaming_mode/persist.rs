//! On-disk state for gaming mode (mirrors `sessions::scheduled_items`'s
//! config_path/atomic-write shape): `<app_data>/gaming-mode{instance_suffix}.json`.

use super::GamingModeFile;
use std::path::PathBuf;

fn config_path() -> Option<PathBuf> {
    config_path_for(&crate::daemon::instance::instance_suffix())
}

pub fn config_path_for(suffix: &str) -> Option<PathBuf> {
    crate::settings::paths::data_dir().ok().map(|d| d.join(format!("gaming-mode{suffix}.json")))
}

pub fn load_file() -> GamingModeFile {
    let Some(path) = config_path() else { return GamingModeFile::default() };
    load_file_at(&path)
}

fn load_file_at(path: &std::path::Path) -> GamingModeFile {
    std::fs::read_to_string(path).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

pub fn save_file(file: &GamingModeFile) {
    let Some(path) = config_path() else { return };
    save_file_at(&path, file);
}

fn save_file_at(path: &std::path::Path, file: &GamingModeFile) {
    let json = match serde_json::to_string_pretty(file) {
        Ok(s) => s,
        Err(e) => {
            log::warn!("gaming-mode: serialize failed: {e}");
            return;
        }
    };
    if let Err(e) = crate::util::write_json_atomic(path, &json) {
        log::warn!("gaming-mode: write failed: {e}");
    }
}
