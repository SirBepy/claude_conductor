//! Shared "register a freshly-spawned session" bookkeeping (todo 420),
//! extracted from `daemon::methods::lifecycle`'s `register_new_session` (todo
//! 278) so `schedule_fire::fire_new_chat` and `methods::jarvis`'s
//! `ensure_jarvis_session`/`spawn_worker` stop hand-copying the same sequence.
//! Lives as a `daemon`-level sibling of `methods` (not inside `methods/`)
//! since `schedule_fire.rs` sits outside that submodule and would otherwise
//! need a circular import back into it.

use crate::daemon::state::DaemonState;
use serde_json::json;
use std::path::Path;

/// Register a freshly-spawned session into the project/registry/chat-config
/// layers: upserts the cwd's project (publishing `project_created` if it's
/// new), records model/effort/account into both the registry and
/// `chat_config`, and clears `awaiting`. `auto_accept`/`character_id` carry
/// the persisted auto-accept flag and assigned character onto the new
/// session id when the caller has one to propagate (neither survives a
/// resume/fork under a fresh id, since both are keyed by session_id). Shared
/// by `start_session`, `move_session_to_account`, `fire_new_chat`,
/// `ensure_jarvis_session`, and `spawn_worker`, which all spawn a session via
/// `lifecycle::spawn_session` and then need this identical sequence to make
/// it visible session-wide. `is_remote` is true only for `start_session`'s
/// phone/remote-cockpit callers (`ConnectionContext::remote`); every other
/// caller is a daemon-internal spawn and always passes `false`.
pub(crate) fn register_new_session(
    state: &DaemonState,
    session_id: &str,
    cwd: &Path,
    model: &str,
    effort: &str,
    account_id: &str,
    now: &str,
    auto_accept: bool,
    character_id: Option<&str>,
    is_remote: bool,
) {
    let (project_id, created_new) = state.settings.upsert_project_for_cwd(cwd, now);
    if created_new {
        state.notifier.publish("project_created", json!({
            "project_id": project_id,
            "cwd": cwd.to_string_lossy(),
            "now": now,
        }));
    }
    state.registry.upsert_interactive(session_id, cwd, &project_id, now);
    if is_remote {
        state.registry.set_is_remote(session_id, true);
    }
    state.registry.set_model_effort(session_id, model, effort);
    state.registry.set_account(session_id, account_id);
    crate::sessions::chat_config::record(session_id, model, effort);
    crate::sessions::chat_config::set_account(session_id, account_id);
    state.registry.set_awaiting(session_id, None);
    if auto_accept {
        crate::sessions::chat_config::set_auto_accept(session_id, true);
    }
    if let Some(character_id) = character_id {
        state.settings.set_session_character(session_id, character_id);
        state.notifier.publish("session_character_assigned", json!({
            "session_id": session_id, "character_id": character_id,
        }));
    }
}

/// Flag `session_id` as the Jarvis singleton in the registry AND force-persist
/// `chat_config`'s auto-accept flag in the same call (hardening adjacent to
/// todo 441): Jarvis runs fully unattended, so even a future spawn path that
/// forgets to pass `auto_accept: true` into `register_new_session` can never
/// leave a Jarvis-flagged session able to pop a permission modal nobody is
/// watching for. `Registry::set_jarvis` itself stays a plain in-memory setter
/// (it has a direct unit-test caller - `jarvis_fleet.rs`'s eligible-pool test -
/// that must not trigger a real `chat-config.json` write), so the coupling
/// lives here instead, one level up, where `DaemonState` is available.
pub(crate) fn flag_as_jarvis(state: &DaemonState, session_id: &str) {
    state.registry.set_jarvis(session_id, true);
    crate::sessions::chat_config::set_auto_accept(session_id, true);
}
