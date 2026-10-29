//! The `session-file` window: the in-app file viewer/editor for any path on
//! disk, opened from a todo row, a dashboard file, or a chat file chip outside
//! the chat's repo. Same exists-vs-build split as
//! `code.rs`. The label sits under `session-*` so the default capability
//! already covers it.

use tauri::{AppHandle, Emitter, Manager};

const LABEL: &str = "session-file";

fn window_url(path: &str, line: Option<u32>) -> String {
    let mut q = url::form_urlencoded::Serializer::new(String::new());
    q.append_pair("path", path);
    if let Some(line) = line {
        q.append_pair("line", &line.to_string());
    }
    format!("index.html?filewindow=1#file?{}", q.finish())
}

/// Open `path` in the file window, building the window on first use. An
/// already-open window gets the path as a new tab via `file-window-open`.
// `(async)`: can build `session-file` - see the module doc's deadlock rule.
#[tauri::command(async)]
pub fn open_file_window(app: AppHandle, path: String, line: Option<u32>) -> Result<(), String> {
    if path.trim().is_empty() {
        return Err("empty path".into());
    }
    if let Some(existing) = app.get_webview_window(LABEL) {
        super::activation::before_show(&app, LABEL);
        let _ = existing.show();
        let _ = existing.unminimize();
        existing.set_focus().map_err(|e| e.to_string())?;
        let _ = existing.emit("file-window-open", serde_json::json!({ "path": path, "line": line }));
        return Ok(());
    }
    let url = window_url(&path, line);
    let window = tauri::WebviewWindowBuilder::new(&app, LABEL, tauri::WebviewUrl::App(url.clone().into()))
        .title(super::test_title("Files"))
        .inner_size(1100.0, 800.0)
        .min_inner_size(420.0, 320.0)
        .resizable(true)
        .visible(false)
        .background_color(tauri::window::Color(22, 21, 31, 255))
        .build()
        .map_err(|e| e.to_string())?;
    super::attach_hide_to_tray_with(&window, |_| {});
    crate::ipc::ready::watch(&app, LABEL, &url);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::window_url;

    #[test]
    fn the_path_survives_the_url_round_trip() {
        let path = r"C:\Users\Joe Doe\proj\.claude\todos\12-a&b #c.md";
        let url = window_url(path, Some(7));
        let query = url.split_once("#file?").unwrap().1;
        let pairs: Vec<(String, String)> = url::form_urlencoded::parse(query.as_bytes()).into_owned().collect();
        assert_eq!(pairs, vec![("path".into(), path.into()), ("line".into(), "7".into())]);
    }
}
