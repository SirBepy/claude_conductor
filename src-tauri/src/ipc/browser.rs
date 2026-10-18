//! Settings' "Show Claude's browser" button: relays to the daemon, which owns
//! the Chrome process (`daemon::browser`).

use serde_json::Value;
use tauri::State;

use crate::state::AppState;

#[tauri::command]
pub async fn browser_status(state: State<'_, AppState>) -> Result<Value, String> {
    let client = state.client().await.ok_or_else(|| "daemon client not connected".to_string())?;
    client.call("browser_status", serde_json::json!({})).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn browser_set_shown(shown: bool, state: State<'_, AppState>) -> Result<Value, String> {
    if shown {
        allow_any_foreground();
    }
    let client = state.client().await.ok_or_else(|| "daemon client not connected".to_string())?;
    client
        .call("browser_set_shown", serde_json::json!({ "shown": shown }))
        .await
        .map_err(|e| e.to_string())
}

/// Windows only lets the foreground app hand focus on, and the click came to
/// this app, not to the daemon or Chrome. Without this grant the shown window
/// only flashes in the taskbar instead of coming to the front.
fn allow_any_foreground() {
    #[cfg(windows)]
    {
        use windows::Win32::UI::WindowsAndMessaging::{AllowSetForegroundWindow, ASFW_ANY};
        // SAFETY: plain Win32 call with no pointers.
        let _ = unsafe { AllowSetForegroundWindow(ASFW_ANY) };
    }
}
