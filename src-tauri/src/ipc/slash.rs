use std::path::PathBuf;

use crate::slash::{enumerate, SlashEntry};

#[tauri::command]
pub async fn list_slash_commands(project_dir: Option<String>) -> Result<Vec<SlashEntry>, String> {
    let project = project_dir.map(PathBuf::from);
    tauri::async_runtime::spawn_blocking(move || enumerate::scan_menu(project.as_deref()))
        .await
        .map_err(|e| e.to_string())
}
