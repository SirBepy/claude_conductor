use crate::state::AppState;
use crate::storage::token_store;
use crate::tokens::{self, BackfillResult, TokenRecord};
use tauri::{AppHandle, Emitter, Manager, State};

/// Loads token history from the consolidated SQLite store. `since` is a
/// unix-seconds floor on `recorded_at`; 0 means all history.
fn load_history_from_db(state: &AppState, since: i64) -> Vec<TokenRecord> {
    let mgr = state.db.lock().unwrap();
    match token_store::get_token_records(mgr.conn(), since) {
        Ok(records) => records
            .into_iter()
            .filter(|r| !r.session_id.is_empty())
            .collect(),
        Err(e) => {
            log::warn!("get_token_records failed: {e:#}");
            Vec::new()
        }
    }
}

#[tauri::command]
pub async fn get_token_history(
    state: State<'_, AppState>,
    since: Option<i64>,
) -> Result<Vec<TokenRecord>, String> {
    Ok(load_history_from_db(&state, since.unwrap_or(0)))
}

#[tauri::command]
pub async fn get_active_sessions(state: State<'_, AppState>) -> Result<Vec<TokenRecord>, String> {
    let history = load_history_from_db(&state, 0);
    tauri::async_runtime::spawn_blocking(move || tokens::active_sessions_from_history(&history))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn backfill_transcripts(app: AppHandle) -> Result<BackfillResult, String> {
    // `AppState.db` is a bare `Mutex`, so the handle crosses, not the db.
    let handle = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let state = handle.state::<AppState>();
        let mut mgr = state.db.lock().unwrap_or_else(|e| e.into_inner());
        tokens::backfill_all(mgr.conn_mut())
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;

    let history = load_history_from_db(&app.state::<AppState>(), 0);
    let _ = app.emit("token-history-updated", history);
    Ok(result)
}
