use crate::state::AppState;
use crate::types::AuthState;
use crate::settings::paths;
use crate::auth::session;
use tauri::{AppHandle, Emitter, Manager, State};

#[tauri::command]
pub async fn auth_status(state: State<'_, AppState>) -> Result<AuthState, String> {
    Ok(*state.auth_state.lock().unwrap())
}

/// Convenience: clears the stored session.
#[tauri::command]
pub async fn logout(state: State<'_, AppState>, app: AppHandle) -> Result<(), String> {
    let path = paths::session_file().map_err(|e| e.to_string())?;
    session::clear(&path).map_err(|e| e.to_string())?;
    *state.auth_state.lock().unwrap() = AuthState::NeedsLogin;
    *state.current_usage.lock().unwrap() = None;
    let _ = app.emit("usage-updated", serde_json::Value::Null);
    let _ = app.emit("auth-progress", serde_json::json!({"stage": "needs-login"}));
    Ok(())
}

#[tauri::command]
pub async fn start_login(app: AppHandle) -> Result<(), String> {
    {
        let state = app.state::<AppState>();
        *state.auth_state.lock().unwrap() = AuthState::InProgress;
    }
    let _ = app.emit("auth-progress", serde_json::json!({"stage": "starting"}));
    match crate::auth::run(app.clone()).await {
        Ok(()) => {
            let state = app.state::<AppState>();
            *state.auth_state.lock().unwrap() = AuthState::LoggedIn;
            let h = app.clone();
            tauri::async_runtime::spawn(async move {
                let _ = crate::scheduler::poll_once(&h, crate::scheduler::PollTrigger::Manual).await;
            });
            Ok(())
        }
        Err(e) => {
            let state = app.state::<AppState>();
            *state.auth_state.lock().unwrap() = AuthState::NeedsLogin;
            Err(e.to_string())
        }
    }
}
