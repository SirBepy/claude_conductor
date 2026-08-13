//! Per-kind daemon-notification handlers, called from
//! `super::handle_daemon_notification`'s match arms. Extracted from
//! `daemon_link.rs` (ai_todo 540); pure move, no behavior change.

/// Given the set of currently-attached session ids and the latest instance
/// snapshot, return the attached ids that should be detached: those that have
/// ended (`ended_at` set) or have vanished from the snapshot entirely. Used to
/// stop the per-session bridge pump when a session ends (ai_todo 66 #2).
fn stale_attached_sessions(
    attached: &std::collections::HashMap<String, u64>,
    instances: &[crate::types::Instance],
) -> Vec<String> {
    let live: std::collections::HashSet<&str> = instances
        .iter()
        .filter(|i| i.ended_at.is_none())
        .map(|i| i.session_id.as_str())
        .collect();
    attached
        .keys()
        .filter(|id| !live.contains(id.as_str()))
        .cloned()
        .collect()
}

/// Attached sessions whose `channel_epoch` moved past what we attached at -
/// a daemon-internal respawn swapped the channel without the -32004 path.
fn respawned_attached_sessions(
    attached: &std::collections::HashMap<String, u64>,
    instances: &[crate::types::Instance],
) -> Vec<String> {
    instances
        .iter()
        .filter(|i| i.ended_at.is_none())
        .filter(|i| attached.get(&i.session_id).is_some_and(|e| *e != i.channel_epoch))
        .map(|i| i.session_id.clone())
        .collect()
}

/// `instances_changed`: detach any attached session that just ended/vanished
/// (ai_todo 66 #2), reattach any whose channel was replaced by a daemon-internal
/// respawn, reseed `cached_instances`, then forward the raw payload.
pub(super) async fn handle_instances_changed(app: &tauri::AppHandle, params: serde_json::Value) {
    use tauri::{Emitter, Manager};
    let state = app.state::<crate::state::AppState>();
    if let Some(instances) = params.get("instances").cloned() {
        if let Ok(parsed) = serde_json::from_value::<Vec<crate::types::Instance>>(instances.clone()) {
            // Collect under the sync lock, then release it BEFORE awaiting.
            let (stale, respawned) = {
                let attached = state.attached_sessions.lock().unwrap();
                (stale_attached_sessions(&attached, &parsed), respawned_attached_sessions(&attached, &parsed))
            };
            if !stale.is_empty() {
                let guard = state.daemon_client.lock().await;
                if let Some(client) = guard.as_ref() {
                    for id in &stale {
                        let _ = client.detach_session(id).await;
                    }
                }
            }
            // `reattach` is idempotent, so a race with the -32004 path is harmless.
            for id in respawned {
                let app2 = app.clone();
                tokio::spawn(async move {
                    let _ = crate::ipc::chat::daemon_bridge::reattach(&app2, &id).await;
                });
            }
            super::store_cached_instances(&state, parsed);
        }
        let _ = app.emit("instances-changed", instances);
    }
}

/// The daemon already updated its own in-memory settings cache for an instant
/// read; here the app process (if running) merges the same project upsert into
/// its AppState and persists it to settings.json.
pub(super) fn handle_project_created(app: &tauri::AppHandle, params: serde_json::Value) {
    use tauri::Manager;
    if let (Some(project_id), Some(cwd), Some(now)) = (
        params.get("project_id").and_then(|v| v.as_str()),
        params.get("cwd").and_then(|v| v.as_str()),
        params.get("now").and_then(|v| v.as_str()),
    ) {
        let state = app.state::<crate::state::AppState>();
        let mut settings_guard = state.settings.lock().unwrap();
        crate::settings::upsert_project_with_id_for_cwd(
            &mut settings_guard,
            project_id,
            &std::path::PathBuf::from(cwd),
            now,
        );
        let snapshot = settings_guard.clone();
        drop(settings_guard);
        crate::settings::persist(app, &snapshot);
    }
}

/// The daemon assigned a character to a session created on the remote
/// (phone/browser) transport, where there is no app-process Tauri command to
/// do this in-process (ipc/characters.rs's `ensure_session_character`).
/// Mirrors `handle_project_created` above.
pub(super) fn handle_session_character_assigned(app: &tauri::AppHandle, params: serde_json::Value) {
    use tauri::Manager;
    if let (Some(session_id), Some(character_id)) = (
        params.get("session_id").and_then(|v| v.as_str()),
        params.get("character_id").and_then(|v| v.as_str()),
    ) {
        let state = app.state::<crate::state::AppState>();
        let mut settings_guard = state.settings.lock().unwrap();
        settings_guard.session_characters.insert(session_id.to_string(), character_id.to_string());
        let snapshot = settings_guard.clone();
        drop(settings_guard);
        crate::settings::persist(app, &snapshot);
    }
}

/// The daemon spawned the singleton Jarvis session (ensure_jarvis_session,
/// todo 272) and updated its own in-memory settings cache for an instant read.
/// Mirrors `handle_session_character_assigned` above.
pub(super) fn handle_jarvis_session_created(app: &tauri::AppHandle, params: serde_json::Value) {
    use tauri::Manager;
    if let Some(session_id) = params.get("session_id").and_then(|v| v.as_str()) {
        let state = app.state::<crate::state::AppState>();
        let mut settings_guard = state.settings.lock().unwrap();
        settings_guard.jarvis_session_id = Some(session_id.to_string());
        let snapshot = settings_guard.clone();
        drop(settings_guard);
        crate::settings::persist(app, &snapshot);
    }
}

#[cfg(test)]
mod tests {
    use super::{respawned_attached_sessions, stale_attached_sessions};
    use crate::sessions::kinds::InstanceKind;
    use crate::types::Instance;
    use std::collections::HashMap;

    fn instance(session_id: &str, ended: bool) -> Instance {
        Instance {
            session_id: session_id.to_string(),
            pid: 0,
            cwd: std::path::PathBuf::from("C:/x"),
            project_id: "proj".into(),
            kind: InstanceKind::Interactive,
            is_remote: false,
            started_at: "2026-05-22T00:00:00Z".into(),
            transcript_path: None,
            bridge_session_id: None,
            name: None,
            ended_at: if ended { Some("2026-05-22T00:00:01Z".to_string()) } else { None },
            end_reason: None,
            busy: false,
            model: String::new(),
            effort: String::new(),
            awaiting: None,
            last_notified_awaiting: None,
            autopilot: false,
            jarvis: false,
            worker_of: None,
            closing: false,
            turn_gen: 0,
            last_event_at: None,
            channel_epoch: 0,
            account_id: None,
            rate_limited_resets_at: None,
            rate_limited_type: None,
            frozen: false,
            frozen_needs_continue: false,
            auto_frozen: false,
        }
    }

    fn instance_with_epoch(session_id: &str, ended: bool, channel_epoch: u64) -> Instance {
        let mut i = instance(session_id, ended);
        i.channel_epoch = channel_epoch;
        i
    }

    fn attached(ids: &[&str]) -> HashMap<String, u64> {
        ids.iter().map(|s| (s.to_string(), 0)).collect()
    }

    fn attached_at(pairs: &[(&str, u64)]) -> HashMap<String, u64> {
        pairs.iter().map(|(id, ep)| (id.to_string(), *ep)).collect()
    }

    #[test]
    fn live_attached_session_is_not_stale() {
        let stale = stale_attached_sessions(&attached(&["a"]), &[instance("a", false)]);
        assert!(stale.is_empty());
    }

    #[test]
    fn ended_attached_session_is_stale() {
        let stale = stale_attached_sessions(&attached(&["a"]), &[instance("a", true)]);
        assert_eq!(stale, vec!["a".to_string()]);
    }

    #[test]
    fn vanished_attached_session_is_stale() {
        // Attached id no longer present in the snapshot at all.
        let stale = stale_attached_sessions(&attached(&["a"]), &[instance("b", false)]);
        assert_eq!(stale, vec!["a".to_string()]);
    }

    #[test]
    fn unattached_ended_session_is_ignored() {
        // We only detach sessions we are actually attached to.
        let stale = stale_attached_sessions(&attached(&[]), &[instance("a", true)]);
        assert!(stale.is_empty());
    }

    #[test]
    fn same_epoch_is_not_respawned() {
        let attached = attached_at(&[("a", 3)]);
        let out = respawned_attached_sessions(&attached, &[instance_with_epoch("a", false, 3)]);
        assert!(out.is_empty());
    }

    #[test]
    fn bumped_epoch_on_live_session_is_respawned() {
        // A daemon-internal respawn (jarvis wake / schedule fire / etc) bumped
        // the epoch without ever calling the app's -32004 reattach path.
        let attached = attached_at(&[("a", 3)]);
        let out = respawned_attached_sessions(&attached, &[instance_with_epoch("a", false, 4)]);
        assert_eq!(out, vec!["a".to_string()]);
    }

    #[test]
    fn bumped_epoch_on_ended_session_is_ignored() {
        // stale_attached_sessions already detaches an ended session; this must
        // not also try to reattach it.
        let attached = attached_at(&[("a", 3)]);
        let out = respawned_attached_sessions(&attached, &[instance_with_epoch("a", true, 4)]);
        assert!(out.is_empty());
    }

    #[test]
    fn unattached_session_epoch_change_is_ignored() {
        // Only currently-attached sessions are candidates for reattach.
        let out = respawned_attached_sessions(&attached(&[]), &[instance_with_epoch("a", false, 4)]);
        assert!(out.is_empty());
    }
}
