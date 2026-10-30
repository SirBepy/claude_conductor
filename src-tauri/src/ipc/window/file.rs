//! The `session-file` window: the in-app file viewer/editor for any path on
//! disk, opened from a todo row, a dashboard file, or a chat file chip outside
//! the chat's repo. Same exists-vs-build split as
//! `code.rs`. The label sits under `session-*` so the default capability
//! already covers it.

use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

pub(super) const LABEL: &str = "session-file";

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
struct OpenRequest {
    path: String,
    line: Option<u32>,
}

/// Opens for the live window that arrive before its webview has registered the
/// `file-window-open` listener. `ipc::ready` cannot cover this: its heartbeat
/// fires at page start, well before the lazily imported file-window module has
/// mounted and listened, and an event emitted into that gap is lost. Kept pure
/// so the queue/drain order is testable without a window.
#[derive(Default)]
struct OpenQueue {
    listening: bool,
    pending: Vec<OpenRequest>,
}

impl OpenQueue {
    /// A freshly built window has no listener yet, whatever the last one had.
    fn reset(&mut self) {
        self.listening = false;
        self.pending.clear();
    }

    /// Some(open) = emit it now; None = held until `listener_ready`.
    fn offer(&mut self, open: OpenRequest) -> Option<OpenRequest> {
        if self.listening {
            return Some(open);
        }
        self.pending.push(open);
        None
    }

    /// The held opens, oldest first; later offers go straight through.
    fn listener_ready(&mut self) -> Vec<OpenRequest> {
        self.listening = true;
        std::mem::take(&mut self.pending)
    }
}

static QUEUE: Mutex<OpenQueue> = Mutex::new(OpenQueue { listening: false, pending: Vec::new() });

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
        let send = QUEUE.lock().unwrap().offer(OpenRequest { path, line });
        if let Some(open) = send {
            let _ = existing.emit("file-window-open", open);
        }
        return Ok(());
    }
    let url = window_url(&path, line);
    // Before the build, not after: once the window exists a concurrent open
    // takes the existing-window branch and must find the queue not listening.
    QUEUE.lock().unwrap().reset();
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

/// The Files webview has registered its `file-window-open` listener: flush the
/// opens queued while it loaded. Any other window calling this is ignored.
#[tauri::command]
pub async fn file_window_ready(app: AppHandle, window: tauri::Window) {
    if window.label() != LABEL {
        return;
    }
    let held = QUEUE.lock().unwrap().listener_ready();
    let Some(target) = app.get_webview_window(LABEL) else { return };
    for open in held {
        let _ = target.emit("file-window-open", open);
    }
}

#[cfg(test)]
mod tests {
    use super::{window_url, OpenQueue, OpenRequest};

    fn open(path: &str) -> OpenRequest {
        OpenRequest { path: path.into(), line: None }
    }

    #[test]
    fn an_open_before_the_listener_is_held_then_flushed_in_order() {
        let mut q = OpenQueue::default();
        assert_eq!(q.offer(open("a")), None);
        assert_eq!(q.offer(open("b")), None);
        assert_eq!(q.listener_ready(), vec![open("a"), open("b")]);
    }

    #[test]
    fn an_open_after_the_listener_goes_straight_through_and_nothing_replays() {
        let mut q = OpenQueue::default();
        assert!(q.listener_ready().is_empty());
        assert_eq!(q.offer(open("a")), Some(open("a")));
        assert!(q.listener_ready().is_empty(), "a second ready must not replay a delivered open");
    }

    #[test]
    fn a_rebuilt_window_drops_the_old_one_state() {
        let mut q = OpenQueue::default();
        q.offer(open("stale"));
        q.reset();
        assert!(q.listener_ready().is_empty(), "a reset drops what the destroyed window never got");
        q.reset();
        assert_eq!(q.offer(open("fresh")), None, "the new webview has no listener yet");
        assert_eq!(q.listener_ready(), vec![open("fresh")]);
    }

    #[test]
    fn the_path_survives_the_url_round_trip() {
        let path = r"C:\Users\Joe Doe\proj\.claude\todos\12-a&b #c.md";
        let url = window_url(path, Some(7));
        let query = url.split_once("#file?").unwrap().1;
        let pairs: Vec<(String, String)> = url::form_urlencoded::parse(query.as_bytes()).into_owned().collect();
        assert_eq!(pairs, vec![("path".into(), path.into()), ("line".into(), "7".into())]);
    }
}
