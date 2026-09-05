//! `spawn_chat`: the unconditional sibling-session spawn, shared by the
//! `spawn_chat` and `respawn` MCP tools.
//! Not `jarvis_fleet::spawn_worker`, which is `CC_JARVIS`-gated and fleet-
//! tagged. Guards instead: own-cwd only, one spawn per turn; and it inherits
//! the caller's own model/effort/account/character/auto-accept.

use crate::daemon::lifecycle::{self, StartSessionParams};
use crate::daemon::machines::registry::{MachineRegistry, PeerMachine};
use crate::daemon::rpc::{Router, RpcError};
use crate::daemon::state::DaemonState;
use serde_json::{json, Value};
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
        // Durable twin of the registry link: the snapshot drops the caller the
        // moment it ends, and the successor's transcript chain must still
        // resolve after that.
        crate::sessions::chat_config::set_predecessor(&sid, caller_session_id);
        state.registry.set_close_requested(caller_session_id);
    }
    crate::sessions::persistence::save_snapshot_default(&state.registry);

    lifecycle::send_message(&session, prompt, false).await.map_err(|e| e.to_string())?;
    state.registry.set_awaiting(&sid, None);
    state.registry.set_busy(&sid, true);
    crate::sessions::chat_state::set_busy(&sid, true);
    crate::daemon::machines::publish_instances_changed(&state);
    Ok(sid)
}

/// `spawn_chat`'s optional `machine`: label or id of a paired peer, or
/// omitted/self for "spawn locally" (today's behaviour, byte-identical).
/// Case-insensitive on label, exact on id - a machine_id is a long opaque
/// endpoint id nobody types by hand, so only the label needs typo tolerance.
/// An unresolvable name errors with the known labels listed, rather than
/// silently falling back to local (a caller who typos "Mca Mini" must not
/// have their chat land on the wrong box unnoticed).
pub(crate) fn resolve_machine(
    registry: &MachineRegistry,
    arg: Option<&str>,
) -> Result<Option<PeerMachine>, String> {
    let arg = match arg.map(str::trim) {
        Some(a) if !a.is_empty() => a,
        _ => return Ok(None),
    };
    if let Some(me) = registry.self_machine() {
        if me.label.eq_ignore_ascii_case(arg) || me.machine_id == arg {
            return Ok(None);
        }
    }
    if let Some(peer) = registry.find_peer(arg) {
        return Ok(Some(peer));
    }
    let known: Vec<String> = registry.peers().into_iter().map(|p| p.label).collect();
    Err(if known.is_empty() {
        format!("unknown machine '{arg}': no machines are paired with this one")
    } else {
        format!("unknown machine '{arg}': known machines are {}", known.join(", "))
    })
}

/// `spawn_chat` forwarded FROM a paired peer machine: the caller's own
/// session lives on the OTHER daemon, so there is no local registry entry to
/// validate a same-cwd guard against, and no per-session `chat_config` to
/// inherit from - the peer already resolved model/effort against ITS OWN
/// caller before forwarding (see `spawn_chat_or_forward`), so `model`/
/// `effort` arrive pre-resolved, never blank. `cwd` existing on THIS machine
/// is `spawn_session`'s own `LifecycleError::CwdMissing` check - no separate
/// validation needed here.
pub(crate) async fn spawn_chat_for_peer(
    state: &Arc<DaemonState>,
    cwd: &str,
    prompt: &str,
    model: &str,
    effort: &str,
    name: Option<&str>,
) -> Result<String, String> {
    let cwd = std::path::PathBuf::from(cwd);
    let params = StartSessionParams {
        cwd: cwd.clone(),
        model: model.to_string(),
        effort: effort.to_string(),
        resume_id: None,
        remote: false,
        account_id: None,
        fork: false,
        new_session_id: None,
    };
    let session = lifecycle::spawn_session(state, params).await.map_err(|e| e.to_string())?;
    let sid = session.session_id.clone();
    let now = chrono::Utc::now().to_rfc3339();
    crate::daemon::session_registration::register_new_session(
        state, &sid, &cwd, model, effort, &session.account_id, &now, false, None, false,
    );
    if let Some(n) = name {
        state.registry.set_name(&sid, n.to_string());
    }
    crate::sessions::persistence::save_snapshot_default(&state.registry);

    lifecycle::send_message(&session, prompt, false).await.map_err(|e| e.to_string())?;
    state.registry.set_awaiting(&sid, None);
    state.registry.set_busy(&sid, true);
    crate::sessions::chat_state::set_busy(&sid, true);
    crate::daemon::machines::publish_instances_changed(state);
    Ok(sid)
}

/// Registers the peer-facing half of `spawn_chat` on the shared RPC router
///: reached only via `remote_handlers::TRANSPORT_TABLE`'s `M`-only entry,
/// so only a paired peer machine's forwarded call ever lands here. Always
/// spawns locally and unconditionally - the forwarded params never carry a
/// `machine` field (`spawn_chat_or_forward` strips it before calling out), so
/// there is nothing here that could re-forward to a third machine and loop.
pub fn register_spawn_chat_rpc(router: &mut Router, state: Arc<DaemonState>) {
    router.register("spawn_chat", move |params, _ctx| {
        let state = state.clone();
        async move {
            let p = params.unwrap_or(Value::Null);
            let cwd = p.get("cwd").and_then(Value::as_str).unwrap_or_default();
            let prompt = p.get("prompt").and_then(Value::as_str).unwrap_or_default();
            let model = p.get("model").and_then(Value::as_str).unwrap_or(FALLBACK_MODEL);
            let effort = p.get("effort").and_then(Value::as_str).unwrap_or(FALLBACK_EFFORT);
            let name = p.get("name").and_then(Value::as_str);
            match spawn_chat_for_peer(&state, cwd, prompt, model, effort, name).await {
                Ok(session_id) => Ok(json!({"ok": true, "session_id": session_id})),
                Err(e) => Err(RpcError::invalid_params(e)),
            }
        }
    });
}

/// `spawn_chat`/`respawn` MCP tools' full body, local or cross-machine:
/// resolves `machine` and either spawns here (today's `spawn_chat`, untouched)
/// or forwards to the peer's own `spawn_chat` RPC method. Model/effort
/// inheritance from the caller's `chat_config` is resolved HERE in both
/// branches (never on the peer), since only this daemon knows the calling
/// session. Returns a full hooks-server body (`{"ok": ...}`) rather than
/// `Result`, so a peer-communication failure's numeric code (reused from
/// `machines::forward`'s consts) can ride alongside the message.
pub(crate) async fn spawn_chat_or_forward(
    state: &Arc<DaemonState>,
    caller_session_id: &str,
    cwd: &str,
    prompt: &str,
    model: Option<&str>,
    effort: Option<&str>,
    name: Option<&str>,
    respawn: bool,
    machine: Option<&str>,
) -> Value {
    let resolved = match state.machines.get() {
        // No machine registry at all (federation never initialised): `machine`
        // can only ever mean "local".
        None => None,
        Some(registry) => match resolve_machine(registry, machine) {
            Ok(r) => r,
            Err(e) => return json!({"ok": false, "error": e}),
        },
    };
    let Some(peer) = resolved else {
        return match spawn_chat(state, caller_session_id, cwd, prompt, model, effort, name, respawn).await {
            Ok(sid) => json!({"ok": true, "session_id": sid}),
            Err(e) => json!({"ok": false, "error": e}),
        };
    };
    if respawn {
        // Closing the caller and handing off across a machine boundary would
        // strand the successor link (`successor_of` resolves through the
        // LOCAL registry snapshot) - only a same-machine spawn can respawn.
        return json!({"ok": false, "error": "respawn cannot target another machine - use spawn_chat instead"});
    }
    if !claim_turn_slot(state, caller_session_id) {
        return json!({"ok": false, "error": "this session already spawned a chat during the current turn - one spawn per turn"});
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
    let peer_params = json!({"cwd": cwd, "prompt": prompt, "model": model, "effort": effort, "name": name});

    let client = match crate::daemon::machines::client_for(state, &peer).await {
        Ok(c) => c,
        Err(e) => {
            let rpc_err = crate::daemon::machines::forward::map_peer_err(e);
            return json!({"ok": false, "error": rpc_err.message, "code": rpc_err.code});
        }
    };
    match client.call("spawn_chat", peer_params).await {
        Ok(mut result) => {
            if let Some(obj) = result.as_object_mut() {
                obj.insert("machine".to_string(), json!(peer.label));
            }
            result
        }
        Err(e) => {
            let rpc_err = crate::daemon::machines::forward::map_peer_err(e);
            json!({"ok": false, "error": rpc_err.message, "code": rpc_err.code})
        }
    }
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

    fn machine_registry_with_a_peer() -> MachineRegistry {
        let dir = tempfile::tempdir().unwrap();
        let registry = MachineRegistry::load(dir.path());
        registry.ensure_self();
        registry.set_label("This Box");
        registry.upsert_peer(PeerMachine {
            machine_id: "peer-mac-id".into(),
            label: "Mac Mini".into(),
            os: "macos".into(),
            iroh_id: None,
            direct_url: Some("http://127.0.0.1:1".into()),
            token: "tok".into(),
            reverse_device_id: None,
            added_at: 0,
        });
        registry
    }

    #[test]
    fn resolve_machine_none_or_blank_stays_local() {
        let registry = machine_registry_with_a_peer();
        assert_eq!(resolve_machine(&registry, None).unwrap(), None);
        assert_eq!(resolve_machine(&registry, Some("")).unwrap(), None);
        assert_eq!(resolve_machine(&registry, Some("   ")).unwrap(), None);
    }

    #[test]
    fn resolve_machine_self_label_or_id_stays_local() {
        let registry = machine_registry_with_a_peer();
        let me = registry.self_machine().unwrap();
        assert_eq!(resolve_machine(&registry, Some("this box")).unwrap(), None, "case-insensitive self label");
        assert_eq!(resolve_machine(&registry, Some(&me.machine_id)).unwrap(), None, "self id");
    }

    #[test]
    fn resolve_machine_matches_a_peer_label_case_insensitively() {
        let registry = machine_registry_with_a_peer();
        let resolved = resolve_machine(&registry, Some("mac mini")).unwrap();
        assert_eq!(resolved.unwrap().machine_id, "peer-mac-id");
    }

    #[test]
    fn resolve_machine_matches_a_peer_id_exactly() {
        let registry = machine_registry_with_a_peer();
        let resolved = resolve_machine(&registry, Some("peer-mac-id")).unwrap();
        assert_eq!(resolved.unwrap().label, "Mac Mini");
    }

    #[test]
    fn resolve_machine_unknown_name_lists_known_labels() {
        let registry = machine_registry_with_a_peer();
        let err = resolve_machine(&registry, Some("Nonexistent Box")).unwrap_err();
        assert!(err.contains("Nonexistent Box"), "{err}");
        assert!(err.contains("Mac Mini"), "{err}");
    }

    #[test]
    fn resolve_machine_unknown_name_with_no_peers_says_none_paired() {
        let dir = tempfile::tempdir().unwrap();
        let registry = MachineRegistry::load(dir.path());
        registry.ensure_self();
        let err = resolve_machine(&registry, Some("Anything")).unwrap_err();
        assert!(err.contains("no machines are paired"), "{err}");
    }

    /// No machine registry initialised at all (`state.init_machines` never
    /// called, as in most unit tests) - `machine` can only mean local, and
    /// the plain local spawn path (`spawn_chat`) must be the one that runs,
    /// not silently short-circuited elsewhere. Trips `spawn_chat`'s OWN cwd
    /// guard with a mismatched `cwd` to prove that deterministically, the
    /// same trick every other RPC test in this daemon uses to avoid ever
    /// reaching `lifecycle::spawn_session`'s account resolution (see
    /// `methods::jarvis`'s own comment on this) - that call reads the REAL,
    /// unmocked accounts.json on this machine and can launch a real `claude`
    /// child process under `cargo test --lib`.
    #[tokio::test]
    async fn spawn_chat_or_forward_with_no_machine_registry_spawns_locally() {
        let state = test_state();
        state.registry.upsert_interactive("sess-no-registry", std::path::Path::new("."), "proj-x", "2026-08-18T00:00:00Z");
        let elsewhere = if cfg!(windows) { "C:\\Windows" } else { "/etc" };
        let result =
            spawn_chat_or_forward(&state, "sess-no-registry", elsewhere, "carry on", None, None, None, false, None).await;
        assert_eq!(result["ok"], false);
        assert!(
            result["error"].as_str().unwrap().contains("own working directory"),
            "must reach spawn_chat's own cwd guard (proof the plain local path ran), not a forward error: {result:?}"
        );
    }

    #[tokio::test]
    async fn spawn_chat_or_forward_rejects_an_unknown_machine_before_touching_the_turn_slot() {
        let state = test_state();
        state.init_machines(tempfile::tempdir().unwrap().path().to_path_buf());
        state.machines.get().unwrap().ensure_self();
        // Its own session id: `claim_turn_slot`'s `SPAWNED_IN_GEN` is a
        // process-global static keyed only by session id string, shared with
        // every other test in this file - reusing "sess-1" here collided with
        // `spawn_chat_or_forward_to_an_unreachable_peer_reports_the_forward_error_code`'s
        // own successful claim on the same id whenever the two ran in the
        // same `cargo test` process.
        state.registry.upsert_interactive("sess-unknown-machine", std::path::Path::new("."), "proj-x", "2026-08-18T00:00:00Z");
        let result =
            spawn_chat_or_forward(&state, "sess-unknown-machine", ".", "carry on", None, None, None, false, Some("Ghost Box")).await;
        assert_eq!(result["ok"], false);
        assert!(result["error"].as_str().unwrap().contains("Ghost Box"));
        // The rejected machine name must not have consumed this turn's spawn
        // slot - a real local spawn right after must still succeed.
        assert!(claim_turn_slot(&state, "sess-unknown-machine"));
    }

    #[tokio::test]
    async fn spawn_chat_or_forward_rejects_respawn_across_machines() {
        let state = test_state();
        state.init_machines(tempfile::tempdir().unwrap().path().to_path_buf());
        state.machines.get().unwrap().ensure_self();
        state.machines.get().unwrap().upsert_peer(PeerMachine {
            machine_id: "peer-id".into(),
            label: "Mac Mini".into(),
            os: "macos".into(),
            iroh_id: None,
            direct_url: Some("http://127.0.0.1:1".into()),
            token: "tok".into(),
            reverse_device_id: None,
            added_at: 0,
        });
        state.registry.upsert_interactive("sess-1", std::path::Path::new("."), "proj-x", "2026-08-18T00:00:00Z");
        let result =
            spawn_chat_or_forward(&state, "sess-1", ".", "carry on", None, None, None, true, Some("Mac Mini")).await;
        assert_eq!(result["ok"], false);
        assert!(result["error"].as_str().unwrap().contains("respawn"));
    }

    /// An unreachable peer (no iroh id, unresolvable direct_url) must surface
    /// as a clean `{"ok": false, ...}` body with the same numeric code
    /// `machines::forward` uses, never a panic or a hung call.
    #[tokio::test]
    async fn spawn_chat_or_forward_to_an_unreachable_peer_reports_the_forward_error_code() {
        let state = test_state();
        state.init_machines(tempfile::tempdir().unwrap().path().to_path_buf());
        state.machines.get().unwrap().ensure_self();
        state.machines.get().unwrap().upsert_peer(PeerMachine {
            machine_id: "peer-id".into(),
            label: "Mac Mini".into(),
            os: "macos".into(),
            iroh_id: None,
            direct_url: None,
            token: "tok".into(),
            reverse_device_id: None,
            added_at: 0,
        });
        // Its own session id (see the sibling test's comment on
        // `SPAWNED_IN_GEN` being a process-global, session-id-keyed static):
        // this call DOES reach `claim_turn_slot` (the peer resolves fine, so
        // it falls through past the respawn/unknown-machine early returns).
        state.registry.upsert_interactive("sess-unreachable-peer", std::path::Path::new("."), "proj-x", "2026-08-18T00:00:00Z");
        let result = spawn_chat_or_forward(
            &state, "sess-unreachable-peer", ".", "carry on", None, None, None, false, Some("Mac Mini"),
        )
        .await;
        assert_eq!(result["ok"], false);
        assert_eq!(result["code"], json!(crate::daemon::machines::forward::ERR_MACHINE_OFFLINE));
    }
}
