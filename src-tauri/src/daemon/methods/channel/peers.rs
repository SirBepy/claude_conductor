//! `list_peers` scoping: who else is visible to a calling session, and how
//! widely (`scope`). Split out of `methods/channel.rs` (todo 915); the
//! sibling `post_message`/`read_messages` concern stays in the parent.

use crate::daemon::state::DaemonState;
use crate::settings::identity;
use serde_json::{json, Value};
use std::sync::Arc;

/// `list_peers`'s optional `scope`: "project" (default, and the only value
/// before this param existed - byte-identical output), "all" (every visible
/// session on THIS daemon plus every paired machine's mirrored rows), or
/// "machine:<label>" (just one machine's rows, self or a peer). An
/// unrecognized string fails safe to "project" rather than erroring - a
/// typo'd scope should never turn into "see nothing", the day-one behaviour.
enum PeerScope {
    Project,
    All,
    Machine(String),
}

fn parse_scope(raw: Option<&str>) -> PeerScope {
    match raw.map(str::trim) {
        None | Some("") | Some("project") => PeerScope::Project,
        Some("all") => PeerScope::All,
        Some(other) => match other.strip_prefix("machine:") {
            Some(label) if !label.trim().is_empty() => PeerScope::Machine(label.trim().to_string()),
            _ => PeerScope::Project,
        },
    }
}

/// `list_peers` tool: every OTHER still-live session sharing this project,
/// with enough state (busy/awaiting) to judge whether it's safe to interrupt.
/// `scope` widens this to every machine (see `parse_scope`).
pub(crate) fn list_peers(state: &Arc<DaemonState>, session_id: &str, scope: Option<&str>) -> Result<Value, String> {
    let project_id = super::caller_project(state, session_id)?;
    match parse_scope(scope) {
        PeerScope::Project => list_peers_project(state, session_id, &project_id),
        PeerScope::All => Ok(json!({"peers": list_peers_all(state, session_id)})),
        PeerScope::Machine(label) => list_peers_machine(state, session_id, &label),
    }
}

/// Today's exact behaviour (byte-identical to before `scope` existed): only
/// this session's own project, on this daemon.
fn list_peers_project(state: &Arc<DaemonState>, session_id: &str, project_id: &str) -> Result<Value, String> {
    let peers: Vec<Value> = state
        .registry
        .by_project(project_id)
        .into_iter()
        .filter(|i| i.session_id != session_id && i.ended_at.is_none())
        .map(|i| {
            // Worktrees share a project_id with the main checkout (todo 717),
            // so a peer's file claims can be about a different tree entirely.
            let worktree = identity::find_repo_root(&i.cwd).unwrap_or_else(|| i.cwd.clone());
            let branch = identity::current_branch(&worktree);
            json!({
                "session_id": i.session_id,
                "name": i.name,
                "busy": i.busy,
                "awaiting": i.awaiting,
                // Provenance (todo 503): lets a caller judge how much trust
                // a peer's claims deserve. `kind` is spawn origin, NOT
                // `is_remote` (that's transport) - never conflate the two.
                "pid": i.pid,
                "kind": i.kind,
                "cwd": i.cwd,
                "worktree": worktree,
                "branch": branch,
            })
        })
        .collect();
    Ok(json!({"peers": peers}))
}

/// This daemon's own label for tagging its own rows in a cross-machine
/// listing - `self_machine()`'s label when federation has been initialised,
/// else a plain fallback (a session on a daemon that never touched machine
/// federation has no other identity to show).
fn self_label(state: &Arc<DaemonState>) -> String {
    state
        .machines
        .get()
        .and_then(|r| r.self_machine())
        .map(|m| m.label)
        .unwrap_or_else(|| "this machine".to_string())
}

/// One local `Instance` -> the same shape `list_peers_project` emits, plus
/// `machine`/`online` (always this daemon's own label, always online to
/// itself) - the cross-machine listing's local half.
fn local_peer_json(i: &crate::types::Instance, machine: &str) -> Value {
    let worktree = identity::find_repo_root(&i.cwd).unwrap_or_else(|| i.cwd.clone());
    let branch = identity::current_branch(&worktree);
    json!({
        "session_id": i.session_id,
        "name": i.name,
        "busy": i.busy,
        "awaiting": i.awaiting,
        "pid": i.pid,
        "kind": i.kind,
        "cwd": i.cwd,
        "worktree": worktree,
        "branch": branch,
        "machine": machine,
        "online": true,
    })
}

/// One mirrored `Instance` (from `state.mirror.instances()`) -> the listing
/// shape. Never runs `identity::find_repo_root`/`current_branch` against
/// `i.cwd` - that path is on the OTHER machine's filesystem, so a local FS
/// read would either miss or, worse, resolve to an unrelated local dir that
/// happens to share the same absolute path.
fn mirrored_peer_json(i: &crate::types::Instance) -> Value {
    let m = i.machine.as_ref();
    json!({
        "session_id": i.session_id,
        "name": i.name,
        "busy": i.busy,
        "awaiting": i.awaiting,
        "pid": i.pid,
        "kind": i.kind,
        "cwd": i.cwd,
        "worktree": i.cwd,
        "branch": Value::Null,
        "machine": m.map(|m| m.label.clone()),
        "online": m.map(|m| m.online).unwrap_or(false),
    })
}

/// Jarvis and its worker sub-sessions never belong in a cross-machine peer
/// listing, same call `remote_handlers::strip_hidden_instances` already makes
/// for every remote listing surface - a peer machine's mirrored Jarvis rows
/// would otherwise leak into scope "all"/"machine:*", which no local listing
/// surface allows either.
fn visible_for_peers(i: &crate::types::Instance) -> bool {
    i.ended_at.is_none() && !i.jarvis && i.worker_of.is_none()
}

/// `scope: "all"`: this daemon's own live sessions (minus the caller itself)
/// plus every paired machine's mirrored rows, each tagged with its owning
/// machine's label and online state.
fn list_peers_all(state: &Arc<DaemonState>, session_id: &str) -> Vec<Value> {
    let me = self_label(state);
    let local = state
        .registry
        .list()
        .into_iter()
        .filter(|i| i.session_id != session_id && visible_for_peers(i))
        .map(|i| local_peer_json(&i, &me));
    let mirrored = state
        .mirror
        .instances()
        .into_iter()
        .filter(visible_for_peers)
        .map(|i| mirrored_peer_json(&i));
    local.chain(mirrored).collect()
}

/// `scope: "machine:<label>"`: resolves `label` against the machine registry
/// (self or a paired peer, same rule `spawn_chat`'s `machine` param uses) and
/// returns only that machine's rows.
fn list_peers_machine(state: &Arc<DaemonState>, session_id: &str, label: &str) -> Result<Value, String> {
    let Some(registry) = state.machines.get() else {
        return Err(format!("unknown machine '{label}': no machines are paired with this one"));
    };
    let resolved = crate::daemon::methods::spawn_chat::resolve_machine(registry, Some(label))?;
    let peers: Vec<Value> = match resolved {
        None => {
            let me = self_label(state);
            state
                .registry
                .list()
                .into_iter()
                .filter(|i| i.session_id != session_id && visible_for_peers(i))
                .map(|i| local_peer_json(&i, &me))
                .collect()
        }
        Some(peer) => state
            .mirror
            .instances()
            .into_iter()
            .filter(visible_for_peers)
            .filter(|i| i.machine.as_ref().map(|m| m.id == peer.machine_id).unwrap_or(false))
            .map(|i| mirrored_peer_json(&i))
            .collect(),
    };
    Ok(json!({"peers": peers}))
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

    fn mirrored_instance(session_id: &str) -> crate::types::Instance {
        use crate::sessions::kinds::InstanceKind;
        crate::types::Instance {
            session_id: session_id.into(),
            pid: 0,
            cwd: std::path::PathBuf::from("C:/mac-repo"),
            project_id: "mac-proj".into(),
            kind: InstanceKind::Interactive,
            is_remote: false,
            started_at: "2026-09-05T00:00:00Z".into(),
            transcript_path: None,
            bridge_session_id: None,
            name: None,
            ended_at: None,
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
            held_count: 0,
            local_task_running: false,
            successor_of: None,
            machine: None,
        }
    }

    #[test]
    fn list_peers_rejects_unknown_caller() {
        let state = test_state();
        let r = list_peers(&state, "ghost", None);
        assert_eq!(r, Err("unknown session: ghost".to_string()));
    }

    #[test]
    fn list_peers_excludes_self_and_ended_sessions() {
        let state = test_state();
        state.registry.upsert_interactive("s1", std::path::Path::new("."), "proj-1", "2026-07-30T00:00:00Z");
        state.registry.upsert_interactive("s2", std::path::Path::new("."), "proj-1", "2026-07-30T00:00:00Z");
        state.registry.upsert_interactive("s3", std::path::Path::new("."), "proj-1", "2026-07-30T00:00:00Z");
        state.registry.mark_ended("s3", crate::types::EndReason::Manual, "2026-07-30T00:00:01Z");

        let v = list_peers(&state, "s1", None).unwrap();
        let peers = v["peers"].as_array().unwrap();
        assert_eq!(peers.len(), 1, "only s2 should show up: not self (s1), not ended (s3)");
        assert_eq!(peers[0]["session_id"], "s2");
    }

    #[test]
    fn list_peers_excludes_sessions_in_other_projects() {
        let state = test_state();
        state.registry.upsert_interactive("s1", std::path::Path::new("."), "proj-1", "2026-07-30T00:00:00Z");
        state.registry.upsert_interactive("s2", std::path::Path::new("."), "proj-2", "2026-07-30T00:00:00Z");

        let v = list_peers(&state, "s1", None).unwrap();
        assert_eq!(v["peers"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn list_peers_reports_each_peers_worktree_and_branch() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        std::fs::create_dir_all(repo.join(".git")).unwrap();
        std::fs::write(repo.join(".git").join("HEAD"), "ref: refs/heads/master\n").unwrap();
        let worktree = repo.join(".claude").join("worktrees").join("feature-x");
        std::fs::create_dir_all(worktree.join("src")).unwrap();
        let gitdir = repo.join(".git").join("worktrees").join("feature-x");
        std::fs::create_dir_all(&gitdir).unwrap();
        std::fs::write(worktree.join(".git"), format!("gitdir: {}\n", gitdir.to_string_lossy())).unwrap();
        std::fs::write(gitdir.join("HEAD"), "ref: refs/heads/feature-x\n").unwrap();

        let state = test_state();
        state.registry.upsert_interactive("s1", &repo, "proj-1", "2026-07-30T00:00:00Z");
        // A nested cwd, so the reported worktree must be the tree root.
        state.registry.upsert_interactive("s2", &worktree.join("src"), "proj-1", "2026-07-30T00:00:00Z");

        let v = list_peers(&state, "s1", None).unwrap();
        let peers = v["peers"].as_array().unwrap();
        assert_eq!(peers.len(), 1);
        assert_eq!(peers[0]["branch"], "feature-x", "peer's own tree branch, not the caller's");
        assert_eq!(
            std::path::PathBuf::from(peers[0]["worktree"].as_str().unwrap()),
            worktree
        );
        // 503's provenance must survive the addition.
        assert_eq!(peers[0]["session_id"], "s2");
        assert!(peers[0].get("pid").is_some());
        assert!(peers[0].get("kind").is_some());
        assert!(peers[0].get("cwd").is_some());
    }

    // ── scope ────────────────────────────────────────────────────────────

    #[test]
    fn parse_scope_defaults_and_typos_fall_back_to_project() {
        assert!(matches!(parse_scope(None), PeerScope::Project));
        assert!(matches!(parse_scope(Some("")), PeerScope::Project));
        assert!(matches!(parse_scope(Some("project")), PeerScope::Project));
        assert!(matches!(parse_scope(Some("bogus")), PeerScope::Project));
        assert!(matches!(parse_scope(Some("machine:")), PeerScope::Project), "empty label falls back too");
    }

    #[test]
    fn parse_scope_recognizes_all_and_machine() {
        assert!(matches!(parse_scope(Some("all")), PeerScope::All));
        match parse_scope(Some("machine: Mac Mini ")) {
            PeerScope::Machine(label) => assert_eq!(label, "Mac Mini"),
            _ => panic!("expected PeerScope::Machine"),
        }
    }

    #[test]
    fn list_peers_scope_all_includes_mirrored_rows_with_machine_and_online() {
        let state = test_state();
        state.init_machines(tempfile::tempdir().unwrap().path().to_path_buf());
        state.machines.get().unwrap().ensure_self();
        state.machines.get().unwrap().set_label("This Box");
        state.registry.upsert_interactive("s1", std::path::Path::new("."), "proj-1", "2026-07-30T00:00:00Z");
        state.registry.upsert_interactive("s2", std::path::Path::new("."), "proj-2", "2026-07-30T00:00:00Z");
        state.mirror.set_instances("mac-id", "Mac Mini", vec![mirrored_instance("m1")]);

        let v = list_peers(&state, "s1", Some("all")).unwrap();
        let peers = v["peers"].as_array().unwrap();
        let ids: Vec<&str> = peers.iter().map(|p| p["session_id"].as_str().unwrap()).collect();
        assert!(ids.contains(&"s2"), "scope all crosses projects: {ids:?}");
        assert!(ids.contains(&"m1"), "scope all includes mirrored rows: {ids:?}");
        assert!(!ids.contains(&"s1"), "caller's own session must not list itself");

        let s2 = peers.iter().find(|p| p["session_id"] == "s2").unwrap();
        assert_eq!(s2["machine"], "This Box");
        assert_eq!(s2["online"], true);
        let m1 = peers.iter().find(|p| p["session_id"] == "m1").unwrap();
        assert_eq!(m1["machine"], "Mac Mini");
        assert_eq!(m1["online"], true);
    }

    #[test]
    fn list_peers_scope_all_excludes_jarvis_and_worker_rows() {
        let state = test_state();
        state.registry.upsert_interactive("s1", std::path::Path::new("."), "proj-1", "2026-07-30T00:00:00Z");
        state.registry.upsert_interactive("jarvis-1", std::path::Path::new("."), "proj-2", "2026-07-30T00:00:00Z");
        state.registry.set_jarvis("jarvis-1", true);
        let v = list_peers(&state, "s1", Some("all")).unwrap();
        let ids: Vec<&str> = v["peers"].as_array().unwrap().iter().map(|p| p["session_id"].as_str().unwrap()).collect();
        assert!(!ids.contains(&"jarvis-1"), "jarvis must never appear in a cross-machine listing: {ids:?}");
    }

    #[test]
    fn list_peers_scope_machine_filters_to_one_machine() {
        let state = test_state();
        state.init_machines(tempfile::tempdir().unwrap().path().to_path_buf());
        state.machines.get().unwrap().ensure_self();
        // A mirrored row is only ever produced for an actually-paired machine
        // (see `pair_machine_peer`), so `resolve_machine` needs the matching
        // `PeerMachine` entry too, not just the mirror's own instances.
        state.machines.get().unwrap().upsert_peer(crate::daemon::machines::registry::PeerMachine {
            machine_id: "mac-id".into(),
            label: "Mac Mini".into(),
            os: "macos".into(),
            iroh_id: None,
            direct_url: None,
            token: "tok".into(),
            reverse_device_id: None,
            added_at: 0,
        });
        state.registry.upsert_interactive("s1", std::path::Path::new("."), "proj-1", "2026-07-30T00:00:00Z");
        state.registry.upsert_interactive("s2", std::path::Path::new("."), "proj-2", "2026-07-30T00:00:00Z");
        state.mirror.set_instances("mac-id", "Mac Mini", vec![mirrored_instance("m1")]);

        let v = list_peers(&state, "s1", Some("machine:mac mini")).unwrap();
        let ids: Vec<&str> = v["peers"].as_array().unwrap().iter().map(|p| p["session_id"].as_str().unwrap()).collect();
        assert_eq!(ids, vec!["m1"], "must be ONLY Mac Mini's row, not s2's local one");
    }

    #[test]
    fn list_peers_scope_machine_unknown_label_errors() {
        let state = test_state();
        state.init_machines(tempfile::tempdir().unwrap().path().to_path_buf());
        state.machines.get().unwrap().ensure_self();
        state.registry.upsert_interactive("s1", std::path::Path::new("."), "proj-1", "2026-07-30T00:00:00Z");
        let r = list_peers(&state, "s1", Some("machine:Ghost Box"));
        assert!(r.unwrap_err().contains("Ghost Box"));
    }
}
