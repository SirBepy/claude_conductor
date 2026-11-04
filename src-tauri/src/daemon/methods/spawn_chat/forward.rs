//! Cross-machine half of `spawn_chat`/`respawn` (todo 916, split out of
//! `spawn_chat`'s own module for size): resolving the caller's `machine`
//! argument to a paired peer, spawning on a peer's behalf when its own
//! `spawn_chat` RPC method forwards to us, and the top-level dispatch that
//! either spawns locally (today's plain `spawn_chat`, in the parent module,
//! untouched) or forwards to the resolved peer. See the parent module's own
//! doc comment for why this is not `daemon::machines::forward`: that module
//! forwards a call for a session `mirror` already knows is mirrored, keyed
//! on `session_id`; everything here dispatches a brand-new spawn to an
//! explicitly named `machine` argument, before any session exists to mirror.

use crate::daemon::lifecycle::{self, StartSessionParams};
use crate::daemon::machines::registry::{MachineRegistry, PeerMachine};
use crate::daemon::state::DaemonState;
use serde_json::{json, Value};
use std::sync::Arc;

use super::spawn_chat;

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
/// inherit from. `model`/`effort` arrive already resolved by the RPC handler
/// (`peer_model_effort`): the caller's explicit values, else THIS machine's
/// project default. `cwd` existing on THIS machine is `spawn_session`'s own
/// `LifecycleError::CwdMissing` check - no separate validation needed here.
pub(crate) async fn spawn_chat_for_peer(
    state: &Arc<DaemonState>,
    cwd: &str,
    prompt: &str,
    model: &str,
    effort: &str,
    name: Option<&str>,
    account_id: Option<String>,
) -> Result<String, String> {
    let cwd = std::path::PathBuf::from(cwd);
    let params = StartSessionParams {
        cwd: cwd.clone(),
        model: model.to_string(),
        effort: effort.to_string(),
        resume_id: None,
        account_id,
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

/// `spawn_chat`/`respawn` MCP tools' full body, local or cross-machine:
/// resolves `machine` and either spawns here (today's `spawn_chat`, untouched)
/// or forwards to the peer's own `spawn_chat` RPC method. A local spawn
/// resolves model/effort here; a forwarded one sends only what the caller
/// named and lets the peer apply its own project default (a plain spawn never
/// inherits the caller's `chat_config`, and `respawn` is refused across
/// machines, so there is nothing else to carry). Returns a full hooks-server
/// body (`{"ok": ...}`) rather than `Result`, so a peer-communication
/// failure's numeric code (reused from `machines::forward`'s consts) can ride
/// alongside the message.
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
    // The target path lives on the peer, so the peer's own project default is
    // the right one: model/effort ride along only when the caller named them.
    let mut peer_params = json!({"cwd": cwd, "prompt": prompt, "name": name});
    for (key, value) in [("model", model), ("effort", effort)] {
        if let Some(v) = value.filter(|v| !v.is_empty()) {
            peer_params[key] = json!(v);
        }
    }

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
            icon: None,
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
    async fn spawn_chat_or_forward_rejects_an_unknown_machine() {
        let state = test_state();
        state.init_machines(tempfile::tempdir().unwrap().path().to_path_buf());
        state.machines.get().unwrap().ensure_self();
        state.registry.upsert_interactive("sess-unknown-machine", std::path::Path::new("."), "proj-x", "2026-08-18T00:00:00Z");
        let result =
            spawn_chat_or_forward(&state, "sess-unknown-machine", ".", "carry on", None, None, None, false, Some("Ghost Box")).await;
        assert_eq!(result["ok"], false);
        assert!(result["error"].as_str().unwrap().contains("Ghost Box"));
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
            icon: None,
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
            icon: None,
        });
        state.registry.upsert_interactive("sess-unreachable-peer", std::path::Path::new("."), "proj-x", "2026-08-18T00:00:00Z");
        // Twice in one turn: spawn_chat has no per-turn cap, so the second
        // call must reach the peer too rather than be refused locally.
        for _ in 0..2 {
            let result = spawn_chat_or_forward(
                &state, "sess-unreachable-peer", ".", "carry on", None, None, None, false, Some("Mac Mini"),
            )
            .await;
            assert_eq!(result["ok"], false);
            assert_eq!(result["code"], json!(crate::daemon::machines::forward::ERR_MACHINE_OFFLINE), "{result:?}");
        }
    }

    /// Paired peer whose `direct_url` is a local mock server, with a caller
    /// session registered and a Settings-wide default model that the CALLER's
    /// project would resolve to. Returns the state and the mock server.
    async fn forwarding_fixture() -> (Arc<DaemonState>, mockito::ServerGuard) {
        let server = mockito::Server::new_async().await;
        let mut settings = Settings::default();
        settings.extra.insert("defaultModel".into(), json!("haiku"));
        settings.extra.insert("defaultEffort".into(), json!("low"));
        let state = DaemonState::new(new_session_map(), SettingsCache::new(settings));
        state.init_machines(tempfile::tempdir().unwrap().path().to_path_buf());
        state.machines.get().unwrap().ensure_self();
        state.machines.get().unwrap().upsert_peer(PeerMachine {
            machine_id: "peer-id".into(),
            label: "Mac Mini".into(),
            os: "macos".into(),
            iroh_id: None,
            direct_url: Some(server.url()),
            token: "tok".into(),
            reverse_device_id: None,
            added_at: 0,
            icon: None,
        });
        state.registry.upsert_interactive("sess-fwd", std::path::Path::new("."), "proj-x", "2026-11-04T00:00:00Z");
        (state, server)
    }

    /// The target machine owns the default for a spawn it receives, so a call
    /// that names no model/effort must reach it without either key. Sending the
    /// caller's resolved default instead pinned the peer to a model chosen by
    /// the wrong machine's project settings.
    #[tokio::test]
    async fn a_forwarded_spawn_without_model_or_effort_sends_neither() {
        let (state, mut server) = forwarding_fixture().await;
        let rpc = server
            .mock("POST", "/api/rpc")
            .match_body(mockito::Matcher::Json(json!({
                "method": "spawn_chat",
                "params": {"cwd": ".", "prompt": "carry on", "name": null}
            })))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(json!({"ok": true, "session_id": "peer-sess"}).to_string())
            .create_async()
            .await;
        let result =
            spawn_chat_or_forward(&state, "sess-fwd", ".", "carry on", None, None, None, false, Some("Mac Mini")).await;
        assert_eq!(result["ok"], true, "{result:?}");
        assert_eq!(result["machine"], "Mac Mini");
        rpc.assert_async().await;
    }

    #[tokio::test]
    async fn a_forwarded_spawn_with_explicit_model_and_effort_sends_exactly_those() {
        let (state, mut server) = forwarding_fixture().await;
        let rpc = server
            .mock("POST", "/api/rpc")
            .match_body(mockito::Matcher::Json(json!({
                "method": "spawn_chat",
                "params": {"cwd": ".", "prompt": "carry on", "name": null, "model": "opus", "effort": "high"}
            })))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(json!({"ok": true, "session_id": "peer-sess"}).to_string())
            .create_async()
            .await;
        let result = spawn_chat_or_forward(
            &state, "sess-fwd", ".", "carry on", Some("opus"), Some("high"), None, false, Some("Mac Mini"),
        )
        .await;
        assert_eq!(result["ok"], true, "{result:?}");
        rpc.assert_async().await;
    }
}
