use crate::state::AppState;
use crate::types::Settings;
use crate::settings::{self, paths};
use tauri::{AppHandle, Emitter, State};

#[tauri::command]
pub async fn get_settings(state: State<'_, AppState>) -> Result<Settings, String> {
    Ok(state.settings.lock().unwrap().clone())
}

/// One-shot: `Some(message)` the first time this is called after a startup
/// that had to salvage or reset settings.json (see `settings::load_with_notice`),
/// `None` on every call after (and on every normal startup).
#[tauri::command]
pub async fn get_settings_load_notice(state: State<'_, AppState>) -> Result<Option<String>, String> {
    Ok(state.settings_load_notice.lock().unwrap().take())
}

#[tauri::command]
pub async fn save_settings(mut updated: Settings, state: State<'_, AppState>, app: AppHandle)
    -> Result<(), String>
{
    let path = paths::settings_file().map_err(|e| e.to_string())?;
    // Generation check, disk write, and cache write all happen inside ONE
    // lock acquisition (todo 1004): a single critical section leaves no
    // window between the check and the cache write for a daemon-owned
    // mutation to land and get silently dropped on the next cache overwrite.
    // `settings::save` runs synchronously on this async command's task either
    // way (todo #1005 covers moving it to the blocking pool), so holding the
    // lock across it adds no new blocking.
    // `reconcile_save` rejects the whole save with `SETTINGS_STALE` when
    // `updated.settings_generation` is behind the live value - see its doc
    // comment (`settings::store::reconcile_save`). Nothing is written to disk
    // or cache on that path; the frontend's `updateSettings` helper re-reads,
    // reapplies its own change, and retries.
    let old_device = {
        let mut s = state.settings.lock().unwrap();
        settings::reconcile_save(&mut updated, &s).map_err(|e| e.to_string())?;
        settings::save(&path, &updated).map_err(|e| e.to_string())?;
        let old = s.audio_output_device.clone();
        *s = updated.clone();
        old
    };
    if old_device != updated.audio_output_device {
        state.audio_stream.reinit(updated.audio_output_device.as_deref());
    }
    // Keep the daemon's in-memory settings cache (used e.g. for
    // default_account_id resolution on session spawn) from going stale for
    // the lifetime of an already-connected session - see push_settings_to_daemon.
    crate::daemon_link::push_settings_to_daemon(&state, &updated).await;
    let _ = app.emit("settings-changed", updated.clone());
    // Sync screen-capture exclusion immediately so toggling the setting
    // mid-meeting takes effect without waiting for the next meeting edge.
    {
        use std::sync::atomic::Ordering;
        let meeting = state.meeting_active.load(Ordering::Relaxed);
        crate::meeting::apply_capture_affinity(meeting && updated.hide_in_meeting());
    }
    Ok(())
}
