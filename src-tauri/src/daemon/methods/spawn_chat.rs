//! `spawn_chat`: the unconditional sibling-session spawn, shared by the
//! `spawn_chat` and `respawn` MCP tools.
//! Not `jarvis_fleet::spawn_worker`, which is `CC_JARVIS`-gated and fleet-
//! tagged. Guards instead: own-cwd only, one spawn per turn; and it inherits
//! the caller's own model/effort/account/character/auto-accept.

use crate::daemon::lifecycle::{self, StartSessionParams};
use crate::daemon::state::DaemonState;
use serde_json::json;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

/// Used only when the caller has no recorded `chat_config` at all (a session
/// that predates the config file, or one whose record was lost). A real
/// respawn always inherits.
const FALLBACK_MODEL: &str = "sonnet";
const FALLBACK_EFFORT: &str = "medium";

/// `caller_session_id` -> the `turn_gen` it last spawned in. A static rather
/// than a `DaemonState` field: one guard does not earn a field threaded
/// through every construction site, and the daemon is a single process.
static SPAWNED_IN_GEN: Mutex<Option<HashMap<String, u64>>> = Mutex::new(None);

/// True if the caller has NOT spawned during its current turn, recording this
/// attempt as it goes.
fn claim_turn_slot(state: &Arc<DaemonState>, caller_session_id: &str) -> bool {
    let gen = state.registry.current_turn_gen(caller_session_id);
    let mut guard = SPAWNED_IN_GEN.lock().unwrap_or_else(|e| e.into_inner());
    let map = guard.get_or_insert_with(HashMap::new);
    if map.get(caller_session_id) == Some(&gen) {
        return false;
    }
    map.insert(caller_session_id.to_string(), gen);
    true
}

/// Tolerates the shapes a model emits for its own cwd (trailing separators,
/// `.`-segments, Windows case). An uncanonicalizable path falls back to a
/// literal compare, which can only reject, never wrongly accept.
fn same_dir(a: &std::path::Path, b: &std::path::Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(a), Ok(b)) => a == b,
        _ => a == b,
    }
}

/// Spawns a new Interactive session in the caller's own project and sends
/// `prompt` as its first turn. The prompt lands as a real, visible user
/// message - the whole point of this over the retired handoff button, which
/// hid its context in a scratch file. `respawn` makes it a takeover instead:
/// `successor_of = caller` plus a close flag the caller's pump acts on at
/// turn end, both here so the old spawn-then-close ordering trap is gone.
pub(crate) async fn spawn_chat(
    state: &Arc<DaemonState>,
    caller_session_id: &str,
    cwd: &str,
    prompt: &str,
    model: Option<&str>,
    effort: Option<&str>,
    name: Option<&str>,
    respawn: bool,
) -> Result<String, String> {
    let caller = state
        .registry
        .get(caller_session_id)
        .ok_or_else(|| format!("unknown caller session: {caller_session_id}"))?;

    let requested = std::path::PathBuf::from(cwd);
    if !same_dir(&caller.cwd, &requested) {
        return Err(format!(
            "spawn_chat only spawns into the calling session's own working directory ({}) - \
             refusing {}",
            caller.cwd.display(),
            requested.display()
        ));
    }

    if !claim_turn_slot(state, caller_session_id) {
        return Err(
            "this session already spawned a chat during the current turn - one spawn per turn"
                .to_string(),
        );
    }

    let inherited = crate::sessions::chat_config::get(caller_session_id).unwrap_or_default();
    let model = model
        .filter(|m| !m.is_empty())
        .unwrap_or(if inherited.model.is_empty() { FALLBACK_MODEL } else { &inherited.model })
        .to_string();
    let effort = effort
        .filter(|e| !e.is_empty())
        .unwrap_or(if inherited.effort.is_empty() { FALLBACK_EFFORT } else { &inherited.effort })
        .to_string();
    let account_id = Some(inherited.account_id.clone()).filter(|a| !a.is_empty());

    let params = StartSessionParams {
        cwd: caller.cwd.clone(),
        model: model.clone(),
        effort: effort.clone(),
        resume_id: None,
        remote: false,
        account_id,
        fork: false,
        new_session_id: None,
    };
    let session = lifecycle::spawn_session(state, params).await.map_err(|e| e.to_string())?;
    let sid = session.session_id.clone();

    // Character is keyed by session id and never survives a fresh id, so the
    // successor would otherwise reroll a different avatar mid-handoff.
    let character_id = state.settings.snapshot().session_characters.get(caller_session_id).cloned();
    let now = chrono::Utc::now().to_rfc3339();
    crate::daemon::session_registration::register_new_session(
        state,
        &sid,
        &caller.cwd,
        &model,
        &effort,
        &session.account_id,
        &now,
        inherited.auto_accept,
        character_id.as_deref(),
        false,
    );
    if let Some(n) = name {
        state.registry.set_name(&sid, n.to_string());
    }
    if respawn {
        state.registry.set_successor_of(&sid, caller_session_id);
        state.registry.set_close_requested(caller_session_id);
    }
    crate::sessions::persistence::save_snapshot_default(&state.registry);

    lifecycle::send_message(&session, prompt, false).await.map_err(|e| e.to_string())?;
    state.registry.set_awaiting(&sid, None);
    state.registry.set_busy(&sid, true);
    crate::sessions::chat_state::set_busy(&sid, true);
    state.notifier.publish("instances_changed", json!({"instances": state.registry.list()}));
    Ok(sid)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::types::Settings;

    fn test_state() -> Arc<DaemonState> {
        DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()))
    }

    /// An unregistered caller is rejected before `spawn_session` is reached, so
    /// this test never spawns a real `claude` child.
    #[tokio::test]
    async fn spawn_chat_rejects_an_unknown_caller() {
        let state = test_state();
        let r = spawn_chat(&state, "ghost", ".", "carry on", None, None, None, false).await;
        let err = r.expect_err("unknown caller must be rejected");
        assert!(err.contains("unknown caller session"), "{err}");
    }

    /// The cwd guard is what keeps an unconditional spawn tool from being a
    /// way to start sessions in arbitrary directories on the machine. Checked
    /// before the turn slot is claimed, so a rejected call does not burn it.
    #[tokio::test]
    async fn spawn_chat_rejects_a_cwd_outside_the_callers_own() {
        let state = test_state();
        state.registry.upsert_interactive(
            "sess-1",
            std::path::Path::new("."),
            "proj-x",
            "2026-08-18T00:00:00Z",
        );
        let elsewhere = if cfg!(windows) { "C:\\Windows" } else { "/etc" };
        let r = spawn_chat(&state, "sess-1", elsewhere, "carry on", None, None, None, false).await;
        let err = r.expect_err("foreign cwd must be rejected");
        assert!(err.contains("own working directory"), "{err}");
    }

    #[test]
    fn turn_slot_is_claimable_once_per_generation() {
        let state = test_state();
        state.registry.upsert_interactive(
            "sess-gen",
            std::path::Path::new("."),
            "proj-x",
            "2026-08-18T00:00:00Z",
        );
        assert!(claim_turn_slot(&state, "sess-gen"), "first claim in a turn succeeds");
        assert!(!claim_turn_slot(&state, "sess-gen"), "second claim in the same turn is refused");
    }

    #[test]
    fn same_dir_tolerates_a_trailing_separator() {
        let here = std::env::current_dir().unwrap();
        let mut trailing = here.clone().into_os_string();
        trailing.push(std::path::MAIN_SEPARATOR.to_string());
        assert!(same_dir(&here, std::path::Path::new(&trailing)));
    }
}
