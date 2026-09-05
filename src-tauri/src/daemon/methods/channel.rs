//! Inter-agent coordination tools: `list_peers` (who else is active in this
//! session's project right now), `post_message` (a short note to every OTHER
//! live session in the project, or to caller-named target ids only, see
//! `repo_channel_wake::resolve_targets`), `read_messages` (messages this
//! session hasn't read yet, see `sessions::repo_channel::list_unread`).
//! Unlike the Jarvis fleet tools, these are
//! advertised UNCONDITIONALLY in `mcp::server`'s `tools/list` - any session
//! should be able to coordinate, not just a Jarvis worker - so there's no
//! privileged-caller re-validation here, just "does `session_id` resolve to a
//! live registry entry", the same trust level as any other MCP tool call
//! riding that session's own `CC_SESSION_ID` env.
//!
//! Complements, doesn't replace, `hooks_server::commit_lock`: that mutex only
//! serializes the instant `git commit` itself runs; this channel covers the
//! much longer editing window before a commit, where the actual collision
//! risk lives.

use crate::daemon::machines::forward::map_peer_err;
use crate::daemon::repo_channel_wake;
use crate::daemon::rpc::{Router, RpcError, Transport};
use crate::daemon::state::DaemonState;
use crate::sessions::repo_channel;
use crate::settings::identity;
use serde_json::{json, Value};
use std::sync::Arc;

/// Resolves the calling session's own `project_id`, straight off the
/// registry entry created at session start - no separate `cwd` argument is
/// ever taken from the caller, so a confused/compromised turn can't query or
/// post into a repo it isn't actually running in.
pub(super) fn caller_project(state: &Arc<DaemonState>, session_id: &str) -> Result<String, String> {
    state
        .registry
        .get(session_id)
        .map(|i| i.project_id)
        .ok_or_else(|| format!("unknown session: {session_id}"))
}

/// Human-readable caption for a posting session: a self-reported turn title
/// (`registry.set_name`), NOT a stable identity (todo 733) - two sessions can
/// pick the same title, and it changes mid-run. `short_id` below is what
/// actually correlates two messages from the same session.
fn caption(state: &Arc<DaemonState>, session_id: &str) -> String {
    state
        .registry
        .get(session_id)
        .and_then(|i| i.name)
        .unwrap_or_else(|| session_id.to_string())
}

/// First 4 chars of the session id (a UUIDv4, see `lifecycle::spawn`) - short
/// enough to sit inline in a caption, still enough entropy that two peers in
/// one project collide only by chance. NOT unique on its own; the full
/// `session_id` on `ChannelMessage` remains the actual correlation key.
fn short_id(session_id: &str) -> &str {
    let end = session_id.char_indices().nth(4).map(|(i, _)| i).unwrap_or(session_id.len());
    &session_id[..end]
}

/// The caption a human reads, suffixed with the sender's `short_id` so two
/// messages from the same session can be told apart from two sessions that
/// happened to pick the same turn title (todo 733) - "Title + short stable
/// id", the interim shown until a real avatar surface exists (todo 756).
pub(super) fn display_name(state: &Arc<DaemonState>, session_id: &str) -> String {
    format!("{} ({})", caption(state, session_id), short_id(session_id))
}

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
    let project_id = caller_project(state, session_id)?;
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
    let resolved = super::spawn_chat::resolve_machine(registry, Some(label))?;
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

/// `read_messages` tool: messages this session hasn't read yet for its
/// project (see `sessions::repo_channel::list_unread` for the cursor), not
/// the full retained history - repeat calls don't redeliver the same note.
pub(crate) fn read_messages(state: &Arc<DaemonState>, session_id: &str) -> Result<Value, String> {
    let project_id = caller_project(state, session_id)?;
    let messages = repo_channel::list_unread(&project_id, session_id);
    Ok(json!({"messages": messages}))
}

/// `post_message` tool: appends `text` to this project's channel, then wakes
/// either every OTHER live session in the project or, if `target` names ids,
/// only those (see `repo_channel_wake::resolve_targets` for the security
/// rule) - fire-and-forget, never blocks the caller's own turn on delivery.
pub(crate) fn post_message(
    state: &Arc<DaemonState>,
    session_id: &str,
    text: &str,
    target: Option<&[String]>,
) -> Result<Value, String> {
    if text.trim().is_empty() {
        return Err("message text is empty".to_string());
    }
    let project_id = caller_project(state, session_id)?;
    let author = display_name(state, session_id);

    // Resolve BEFORE persisting: a rejected target used to still leave the text
    // in durable channel history, readable by every project member.
    let targets = repo_channel_wake::resolve_targets(state, session_id, target)?;
    let msg = repo_channel::post(&project_id, session_id, &author, text, None);

    let mut notified = 0usize;
    for target_id in &targets {
        // `msg.text` (already truncated to MAX_TEXT_LEN by `repo_channel::post`
        // above), NOT the raw `text` argument - otherwise the length cap only
        // ever applied to the persisted JSON history, and an unbounded string
        // still landed as a real injected turn in every peer's live session.
        // No `[repo-channel] {author}: ` wrapper (todo 743): the sender's
        // identity rides as `author_session_id`, not text a hook could parse.
        repo_channel_wake::enqueue(state, target_id, session_id, msg.text.clone());
        repo_channel_wake::spawn_drain(state, target_id);
        notified += 1;
    }
    // `delivered` (todo 717): a bare `notified: 0` read as "no peers exist"
    // and got reported to the dev as fact. It only ever means the note is a
    // dead drop for a future reader.
    Ok(json!({
        "ok": true,
        "message": msg,
        "notified": notified,
        "delivered": notified > 0,
    }))
}

/// `post_message`'s optional `to` (a session id): a direct message instead
/// of the broadcast/`target`-woken note `post_message` above sends - local or
/// cross-machine. This is the async entry point `hooks_server::channel`'s
/// route calls; `post_message` above (broadcast/`target`, unchanged) stays
/// synchronous, so every existing caller and test of it is untouched. Builds
/// the full `{"ok": ...}` body itself (rather than `Result`) so a
/// peer-communication failure's numeric code (reused from `machines::forward`)
/// can ride alongside the message, same pattern as `spawn_chat_or_forward`.
pub(crate) async fn post_message_or_forward(
    state: &Arc<DaemonState>,
    session_id: &str,
    text: &str,
    target: Option<&[String]>,
    to: Option<&str>,
) -> Value {
    let Some(to_id) = to.map(str::trim).filter(|s| !s.is_empty()) else {
        return match post_message(state, session_id, text, target) {
            Ok(v) => v,
            Err(e) => json!({"ok": false, "error": e}),
        };
    };
    if text.trim().is_empty() {
        return json!({"ok": false, "error": "message text is empty"});
    }
    if to_id == session_id {
        return json!({"ok": false, "error": "cannot target your own session"});
    }
    if state.registry.get(session_id).is_none() {
        return json!({"ok": false, "error": format!("unknown session: {session_id}")});
    }
    let author = display_name(state, session_id);

    // Local direct delivery: `to` is a session hosted on THIS daemon. Stored
    // in the ADDRESSEE's own project channel (not the caller's) so it lands
    // wherever `to_id`'s own `read_messages` actually looks, even if the two
    // sessions are in different projects.
    if let Some(inst) = state.registry.get(to_id) {
        if inst.ended_at.is_some() {
            return json!({"ok": false, "error": format!("target session has already ended: {to_id}")});
        }
        let msg = repo_channel::post(&inst.project_id, session_id, &author, text, Some(to_id));
        repo_channel_wake::enqueue(state, to_id, session_id, msg.text.clone());
        repo_channel_wake::spawn_drain(state, to_id);
        return json!({"ok": true, "message": msg, "notified": 1, "delivered": true});
    }

    // Cross-machine: `to` is a session mirrored from a paired peer.
    let Some(machine_id) = state.mirror.owner_of(to_id) else {
        return json!({"ok": false, "error": format!("unknown target session: {to_id}")});
    };
    let Some(registry) = state.machines.get() else {
        return json!({"ok": false, "error": format!("unknown target session: {to_id}")});
    };
    let Some(peer) = registry.peer(&machine_id) else {
        return json!({"ok": false, "error": format!("unknown target session: {to_id}")});
    };
    let client = match crate::daemon::machines::client_for(state, &peer).await {
        Ok(c) => c,
        Err(e) => {
            let rpc_err = map_peer_err(e);
            return json!({"ok": false, "error": rpc_err.message, "code": rpc_err.code});
        }
    };
    let payload = json!({
        "to_session_id": to_id,
        "text": text,
        // `from.name` is trusted only as a hint (see `register_channel_rpc`):
        // the receiving daemon appends the machine label FROM ITS OWN
        // registry, never from this payload.
        "from": {"session_id": session_id, "name": display_name(state, session_id)},
    });
    match client.call("peer_channel_post", payload).await {
        Ok(v) => v,
        Err(e) => {
            let rpc_err = map_peer_err(e);
            json!({"ok": false, "error": rpc_err.message, "code": rpc_err.code})
        }
    }
}

/// Registers the peer-facing half of `post_message`'s `to` param on the
/// shared RPC router: reached only via `remote_handlers::TRANSPORT_TABLE`'s
/// `M`-only entry, so `ctx.transport` is always `Transport::PeerMachine(..)`
/// here. SECURITY: the stored author's machine label comes from THAT (via
/// `state.machines`'s own registry of who `machine_id` is), never from
/// `params.from`'s `name` field's implied machine - a payload cannot forge
/// which machine it claims to be from.
pub fn register_channel_rpc(router: &mut Router, state: Arc<DaemonState>) {
    router.register("peer_channel_post", move |params, ctx| {
        let state = state.clone();
        async move {
            let p = params.unwrap_or(Value::Null);
            let to_id = p.get("to_session_id").and_then(Value::as_str).unwrap_or_default();
            let text = p.get("text").and_then(Value::as_str).unwrap_or_default();
            let from = p.get("from");
            let from_session_id =
                from.and_then(|f| f.get("session_id")).and_then(Value::as_str).unwrap_or("unknown");
            let from_name = from.and_then(|f| f.get("name")).and_then(Value::as_str).unwrap_or(from_session_id);

            let machine_id = match &ctx.transport {
                Transport::PeerMachine(id) => id.clone(),
                _ => return Err(RpcError::invalid_params("peer_channel_post is machine-only")),
            };
            let label = state
                .machines
                .get()
                .and_then(|r| r.peer(&machine_id))
                .map(|p| p.label)
                .unwrap_or(machine_id);

            let Some(inst) = state.registry.get(to_id) else {
                return Err(RpcError::invalid_params(format!("unknown session: {to_id}")));
            };
            if inst.ended_at.is_some() {
                return Err(RpcError::invalid_params(format!("target session has already ended: {to_id}")));
            }
            let author = format!("{from_name} @ {label}");
            let msg = repo_channel::post(&inst.project_id, from_session_id, &author, text, Some(to_id));
            repo_channel_wake::enqueue(&state, to_id, from_session_id, msg.text.clone());
            repo_channel_wake::spawn_drain(&state, to_id);
            Ok(json!({"ok": true, "message": msg}))
        }
    });
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

    /// Test-only mirror of `post_message`'s wiring with `repo_channel::post_at`
    /// substituted for `repo_channel::post`, so notify/deliver bookkeeping is
    /// exercised against a tempdir instead of real app data (todo 757), same
    /// as the retitle test below.
    fn post_message_at(
        state: &Arc<DaemonState>,
        session_id: &str,
        text: &str,
        target: Option<&[String]>,
        path: &std::path::Path,
    ) -> Result<Value, String> {
        let author = display_name(state, session_id);
        let targets = repo_channel_wake::resolve_targets(state, session_id, target)?;
        let msg = repo_channel::post_at(Some(path), session_id, &author, text, None);

        let mut notified = 0usize;
        for target_id in &targets {
            repo_channel_wake::enqueue(state, target_id, session_id, msg.text.clone());
            repo_channel_wake::spawn_drain(state, target_id);
            notified += 1;
        }
        Ok(json!({
            "ok": true,
            "message": msg,
            "notified": notified,
            "delivered": notified > 0,
        }))
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

    #[test]
    fn display_name_survives_a_title_change_via_the_stable_session_id() {
        // Todo 733: the caption (turn title) is not a stable identity - it
        // changes as the session works. The short id suffix must not.
        let state = test_state();
        state.registry.upsert_interactive("s1", std::path::Path::new("."), "proj-1", "2026-07-30T00:00:00Z");
        state.registry.set_name("s1", "Building 675 waiting chip".to_string());
        let before = display_name(&state, "s1");

        state.registry.set_name("s1", "Fixing the retitle bug".to_string());
        let after = display_name(&state, "s1");

        assert_ne!(before, after, "caption itself must reflect the retitle");
        assert_eq!(
            short_id("s1"),
            short_id("s1"),
            "short_id is a pure function of session_id, unaffected by set_name"
        );
        assert!(before.ends_with(&format!("({})", short_id("s1"))));
        assert!(after.ends_with(&format!("({})", short_id("s1"))));
    }

    #[test]
    fn post_message_correlates_two_posts_across_a_title_change() {
        // Acceptance test: session_id must match though author differs after
        // a retitle. Uses `repo_channel::post_at`/`list_at` + a tempdir, not
        // `post_message`'s real `%APPDATA%` path (not overridable), or
        // `history.len()` drifts on every repeated run (todo 733).
        let state = test_state();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("proj-733-retitle.json");
        state.registry.upsert_interactive("s1", std::path::Path::new("."), "proj-733-retitle", "2026-07-30T00:00:00Z");
        state.registry.set_name("s1", "Building 675 waiting chip".to_string());

        repo_channel::post_at(Some(&path), "s1", &display_name(&state, "s1"), "about to edit foo.ts", None);
        state.registry.set_name("s1", "Now doing something else entirely".to_string());
        repo_channel::post_at(Some(&path), "s1", &display_name(&state, "s1"), "done with foo.ts", None);

        let history = repo_channel::list_at(&path);
        assert_eq!(history.len(), 2);
        assert_eq!(history[0].session_id, history[1].session_id, "same sender, must correlate");
        assert_ne!(history[0].author, history[1].author, "caption changed with the retitle");
        assert!(history[0].author.contains(short_id("s1")), "short id must survive into the caption");
        assert!(history[1].author.contains(short_id("s1")));
    }

    #[test]
    fn post_message_rejects_empty_text() {
        let state = test_state();
        state.registry.upsert_interactive("s1", std::path::Path::new("."), "proj-1", "2026-07-30T00:00:00Z");
        let r = post_message(&state, "s1", "   ", None);
        assert!(r.is_err());
    }

    #[test]
    fn post_message_rejects_unknown_caller() {
        let state = test_state();
        let r = post_message(&state, "ghost", "hello", None);
        assert_eq!(r, Err("unknown session: ghost".to_string()));
    }

    #[tokio::test]
    async fn post_message_wake_line_uses_truncated_text_not_raw() {
        // Regression: the wake line handed to peers must be built from the
        // returned message's (already-truncated) text, not the caller's raw
        // argument - otherwise MAX_TEXT_LEN only ever capped the persisted
        // JSON history while an unbounded string still landed as a real
        // injected turn in every peer's live session. `post_message` always
        // calls `spawn_drain` (a synchronous `tokio::spawn`) for each
        // notified peer, so this needs a live runtime (`#[tokio::test]`)
        // even though the peer being marked busy makes the spawned task
        // itself a guaranteed no-op - the enqueue this test asserts on
        // happens synchronously, before that task is ever dispatched.
        let state = test_state();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("proj-1.json");
        state.registry.upsert_interactive("s1", std::path::Path::new("."), "proj-1", "2026-07-30T00:00:00Z");
        state.registry.upsert_interactive("s2", std::path::Path::new("."), "proj-1", "2026-07-30T00:00:00Z");
        state.registry.set_busy("s2", true);

        let long = "x".repeat(3000); // exceeds repo_channel::MAX_TEXT_LEN (2000)
        let v = post_message_at(&state, "s1", &long, None, &path).unwrap();
        assert_eq!(v["notified"], 1);

        let queues = state.repo_channel_wakes.lock().unwrap();
        let pending = queues.get("s2").expect("wake queued for s2");
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].text.chars().count(), 2000, "wake line must be truncated");
        assert_eq!(pending[0].author_session_id, "s1");
    }

    #[tokio::test]
    async fn post_message_wake_line_carries_no_envelope_text() {
        // Todo 743: identity rides as `author_session_id`, never as
        // `"[repo-channel] {author}: "` text a receiving hook could misparse.
        let state = test_state();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("proj-743.json");
        state.registry.upsert_interactive("s1", std::path::Path::new("."), "proj-743", "2026-07-30T00:00:00Z");
        state.registry.upsert_interactive("s2", std::path::Path::new("."), "proj-743", "2026-07-30T00:00:00Z");
        state.registry.set_busy("s2", true);

        post_message_at(&state, "s1", "touching pump.rs, anyone on this?", None, &path).unwrap();

        let queues = state.repo_channel_wakes.lock().unwrap();
        let pending = queues.get("s2").expect("wake queued for s2");
        assert_eq!(pending[0].text, "touching pump.rs, anyone on this?");
        assert_eq!(pending[0].author_session_id, "s1");
    }

    #[tokio::test]
    async fn post_message_notifies_only_other_live_project_peers() {
        // post_message's wake delivery goes through `spawn_drain`, which calls
        // `tokio::spawn` internally - that requires a live Tokio runtime
        // context, hence `#[tokio::test]` here (plain `#[test]` would panic
        // with "no reactor running").
        let state = test_state();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("proj-1.json");
        state.registry.upsert_interactive("s1", std::path::Path::new("."), "proj-1", "2026-07-30T00:00:00Z");
        state.registry.upsert_interactive("s2", std::path::Path::new("."), "proj-1", "2026-07-30T00:00:00Z");
        state.registry.upsert_interactive("s3", std::path::Path::new("."), "proj-2", "2026-07-30T00:00:00Z");

        let v = post_message_at(&state, "s1", "touching pending-pane.ts, anyone on this?", None, &path).unwrap();
        assert_eq!(v["ok"], true);
        assert_eq!(v["notified"], 1, "only s2 shares proj-1 with the poster");
        assert_eq!(v["delivered"], true);
    }

    #[tokio::test]
    async fn post_message_to_an_empty_project_reports_not_delivered() {
        let state = test_state();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("proj-lonely.json");
        state.registry.upsert_interactive("lonely", std::path::Path::new("."), "proj-lonely", "2026-07-30T00:00:00Z");

        let v = post_message_at(&state, "lonely", "anyone here?", None, &path).unwrap();
        assert_eq!(v["notified"], 0);
        assert_eq!(
            v["delivered"], false,
            "a dead drop must be distinguishable from a real broadcast"
        );
    }

    #[tokio::test]
    async fn post_message_with_a_target_wakes_only_that_peer() {
        let state = test_state();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("proj-1.json");
        state.registry.upsert_interactive("s1", std::path::Path::new("."), "proj-1", "2026-07-30T00:00:00Z");
        state.registry.upsert_interactive("s2", std::path::Path::new("."), "proj-1", "2026-07-30T00:00:00Z");
        state.registry.upsert_interactive("s3", std::path::Path::new("."), "proj-1", "2026-07-30T00:00:00Z");

        let target = vec!["s3".to_string()];
        let v = post_message_at(&state, "s1", "for s3 only", Some(&target), &path).unwrap();
        assert_eq!(v["notified"], 1);

        let queues = state.repo_channel_wakes.lock().unwrap();
        assert!(queues.get("s3").is_some(), "targeted peer must be woken");
        assert!(queues.get("s2").is_none(), "untargeted peer must not be woken");
    }

    #[test]
    fn post_message_with_an_unknown_target_errors_without_broadcasting() {
        let state = test_state();
        state.registry.upsert_interactive("s1", std::path::Path::new("."), "proj-1", "2026-07-30T00:00:00Z");
        state.registry.upsert_interactive("s2", std::path::Path::new("."), "proj-1", "2026-07-30T00:00:00Z");

        let target = vec!["typo".to_string()];
        let r = post_message(&state, "s1", "hello", Some(&target));
        assert_eq!(r, Err("unknown target session: typo".to_string()));

        let queues = state.repo_channel_wakes.lock().unwrap();
        assert!(queues.get("s2").is_none(), "a bad target must never fall back to broadcast");
    }

    #[test]
    fn post_message_with_a_bad_target_leaves_no_trace_in_history() {
        // Its own tempdir path: other tests here post to proj-1, so sharing
        // one would flake.
        let state = test_state();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("proj-post-guard.json");
        state.registry.upsert_interactive("g1", std::path::Path::new("."), "proj-post-guard", "2026-07-30T00:00:00Z");

        let before = repo_channel::list_at(&path).len();
        let target = vec!["typo".to_string()];
        let r = post_message_at(&state, "g1", "secret coordination note", Some(&target), &path);
        assert!(r.is_err(), "an unknown target must fail the call");

        // Persisting before validating leaked the text into durable history that
        // every project member can read, while still returning Err to the caller.
        assert_eq!(
            repo_channel::list_at(&path).len(),
            before,
            "a rejected post must not append to channel history"
        );
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

    // ── post_message's `to` (direct messages) ───────────────────────────

    #[tokio::test]
    async fn post_message_or_forward_without_to_delegates_to_the_broadcast_path() {
        let state = test_state();
        state.registry.upsert_interactive("s1", std::path::Path::new("."), "proj-1", "2026-07-30T00:00:00Z");
        let v = post_message_or_forward(&state, "s1", "hello", None, None).await;
        assert_eq!(v["ok"], true);
    }

    #[tokio::test]
    async fn post_message_or_forward_delivers_a_local_direct_message() {
        let state = test_state();
        state.registry.upsert_interactive("s1", std::path::Path::new("."), "proj-1", "2026-07-30T00:00:00Z");
        state.registry.upsert_interactive("s2", std::path::Path::new("."), "proj-1", "2026-07-30T00:00:00Z");
        state.registry.upsert_interactive("s3", std::path::Path::new("."), "proj-1", "2026-07-30T00:00:00Z");

        let v = post_message_or_forward(&state, "s1", "just for s2", None, Some("s2")).await;
        assert_eq!(v["ok"], true);
        assert_eq!(v["notified"], 1);

        let queues = state.repo_channel_wakes.lock().unwrap();
        assert!(queues.get("s2").is_some(), "addressee must be woken");
        assert!(queues.get("s3").is_none(), "an unaddressed peer must not be woken");
    }

    #[tokio::test]
    async fn post_message_or_forward_direct_message_is_invisible_to_other_readers() {
        // A random, not merely a distinct fixed, project id: `post_message_or_forward`
        // goes through `repo_channel::post`'s real (non-tempdir) disk path
        // (todo 757), and this test reads the backlog back via
        // `read_messages` - a fixed id would accumulate leftover messages
        // both from other tests here AND across repeated `cargo test` runs
        // on the same machine.
        let state = test_state();
        let project = format!("proj-direct-msg-{}", uuid::Uuid::new_v4());
        state.registry.upsert_interactive("s1", std::path::Path::new("."), &project, "2026-07-30T00:00:00Z");
        state.registry.upsert_interactive("s2", std::path::Path::new("."), &project, "2026-07-30T00:00:00Z");
        state.registry.upsert_interactive("s3", std::path::Path::new("."), &project, "2026-07-30T00:00:00Z");

        post_message_or_forward(&state, "s1", "just for s2", None, Some("s2")).await;

        let for_s2 = read_messages(&state, "s2").unwrap();
        assert_eq!(for_s2["messages"].as_array().unwrap().len(), 1, "addressee must see it");
        let for_s3 = read_messages(&state, "s3").unwrap();
        assert_eq!(for_s3["messages"].as_array().unwrap().len(), 0, "an unaddressed peer must not see it");
    }

    #[tokio::test]
    async fn post_message_or_forward_rejects_targeting_yourself() {
        let state = test_state();
        state.registry.upsert_interactive("s1", std::path::Path::new("."), "proj-1", "2026-07-30T00:00:00Z");
        let v = post_message_or_forward(&state, "s1", "hi", None, Some("s1")).await;
        assert_eq!(v["ok"], false);
        assert!(v["error"].as_str().unwrap().contains("own session"));
    }

    #[tokio::test]
    async fn post_message_or_forward_rejects_an_unknown_to_with_no_federation() {
        let state = test_state();
        state.registry.upsert_interactive("s1", std::path::Path::new("."), "proj-1", "2026-07-30T00:00:00Z");
        let v = post_message_or_forward(&state, "s1", "hi", None, Some("nonexistent")).await;
        assert_eq!(v["ok"], false);
        assert!(v["error"].as_str().unwrap().contains("unknown target session: nonexistent"));
    }

    #[tokio::test]
    async fn post_message_or_forward_to_an_offline_mirrored_session_reports_the_forward_error_code() {
        let state = test_state();
        state.init_machines(tempfile::tempdir().unwrap().path().to_path_buf());
        state.machines.get().unwrap().ensure_self();
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
        state.mirror.set_instances("mac-id", "Mac Mini", vec![mirrored_instance("m1")]);
        state.registry.upsert_interactive("s1", std::path::Path::new("."), "proj-1", "2026-07-30T00:00:00Z");

        let v = post_message_or_forward(&state, "s1", "hi", None, Some("m1")).await;
        assert_eq!(v["ok"], false);
        assert_eq!(v["code"], json!(crate::daemon::machines::forward::ERR_MACHINE_OFFLINE));
    }

    /// The two-daemon loopback fixture from `machines::peer_link`'s own tests,
    /// adapted: A posts a direct message `to` a session mirrored from B. B's
    /// `read_messages` for that session must return it with author
    /// `<name> @ <A's label>` - the label MUST come from B's OWN registry
    /// entry for A (registered as "A" below), never from A's self-label
    /// ("B" is B's OWN label for itself and must never appear here) nor from
    /// the (here deliberately spoofed) payload.
    #[tokio::test]
    async fn cross_machine_direct_message_lands_with_the_receivers_own_machine_label() {
        use crate::daemon::device_registry::DeviceRegistry;
        use crate::daemon::machines::registry::PeerMachine;
        use crate::daemon::rpc::Router;
        use crate::daemon::session::new_session_map;

        let a_dir = tempfile::tempdir().unwrap();
        let b_dir = tempfile::tempdir().unwrap();
        let a_state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        let b_state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));

        let mut b_router = Router::new();
        register_channel_rpc(&mut b_router, b_state.clone());
        let (_a_stt, _a_port, a_serve) =
            crate::daemon::remote_server::spawn_on(a_state.clone(), a_dir.path().to_path_buf(), Router::new(), 0);
        let (_b_stt, b_port, b_serve) =
            crate::daemon::remote_server::spawn_on(b_state.clone(), b_dir.path().to_path_buf(), b_router, 0);

        let a_id = a_state.machines.get().unwrap().self_machine().unwrap().machine_id;
        b_state.machines.get().unwrap().set_label("B");
        let b_id = b_state.machines.get().unwrap().self_machine().unwrap().machine_id;

        // Random suffix, not a fixed "proj-b": this test reads the backlog
        // back via `read_messages` against real (non-tempdir) disk (todo
        // 757), so a fixed id would accumulate messages across repeated
        // `cargo test` runs on the same machine, not just other tests in
        // this same process.
        let project_b = format!("proj-b-{}", uuid::Uuid::new_v4());
        b_state.registry.upsert_interactive("b-session-1", std::path::Path::new("."), &project_b, "2026-09-05T00:00:00Z");

        let (token_for_a, _device_id) = DeviceRegistry::add_machine_device("A", &a_id, b_dir.path()).unwrap();
        a_state.machines.get().unwrap().upsert_peer(PeerMachine {
            machine_id: b_id.clone(),
            label: "B".into(),
            os: "test".into(),
            iroh_id: None,
            direct_url: Some(format!("http://127.0.0.1:{b_port}")),
            token: token_for_a,
            reverse_device_id: None,
            added_at: 0,
        });
        // The real `/api/pair` handshake (`pair_machine_peer`) registers a
        // `PeerMachine` on BOTH sides - B needs its own entry for A so
        // `register_channel_rpc`'s `state.machines.peer(ctx.transport's id)`
        // lookup (B processing A's forwarded call) resolves to a real label
        // instead of falling back to A's raw machine_id.
        b_state.machines.get().unwrap().upsert_peer(PeerMachine {
            machine_id: a_id.clone(),
            label: "A".into(),
            os: "test".into(),
            iroh_id: None,
            direct_url: None,
            token: "dummy-b-never-calls-a".into(),
            reverse_device_id: None,
            added_at: 0,
        });
        // A's own mirror must know "b-session-1" is hosted on B for
        // `post_message_or_forward`'s `mirror.owner_of` lookup to resolve it -
        // normally kept current by `peer_link`'s live WS subscription; set
        // directly here since this test only needs the RPC forwarding half.
        a_state.mirror.set_instances(&b_id, "B", vec![mirrored_instance("b-session-1")]);

        a_state.registry.upsert_interactive("a-session-1", std::path::Path::new("."), "proj-a", "2026-09-05T00:00:00Z");
        a_state.registry.set_name("a-session-1", "Fixing the thing".to_string());

        let v = post_message_or_forward(&a_state, "a-session-1", "ping from A", None, Some("b-session-1")).await;
        assert_eq!(v["ok"], true, "forward must succeed: {v:?}");

        let for_recipient = read_messages(&b_state, "b-session-1").unwrap();
        let messages = for_recipient["messages"].as_array().unwrap();
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0]["text"], "ping from A");
        assert!(
            messages[0]["author"].as_str().unwrap().ends_with("@ A"),
            "must carry B's OWN registry label for A, not anything the payload could spoof: {messages:?}"
        );

        a_serve.kill();
        b_serve.kill();
    }

    /// Direct proof that a spoofed `from.name` claiming a fake machine cannot
    /// override the label the receiver derives from `ctx.transport` - calls
    /// the registered handler through a real router dispatch (so `ctx` is
    /// genuinely `Transport::PeerMachine`), bypassing `post_message_or_forward`
    /// entirely so the payload is under this test's full control.
    #[tokio::test]
    async fn peer_channel_post_ignores_a_spoofed_machine_label_in_the_payload() {
        use crate::daemon::rpc::{ConnectionContext, Request, Transport, TRANSPORT};
        use crate::daemon::session::new_session_map;

        let state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        state.init_machines(tempfile::tempdir().unwrap().path().to_path_buf());
        state.machines.get().unwrap().ensure_self();
        state.machines.get().unwrap().upsert_peer(crate::daemon::machines::registry::PeerMachine {
            machine_id: "real-peer-id".into(),
            label: "Real Peer".into(),
            os: "test".into(),
            iroh_id: None,
            direct_url: None,
            token: "tok".into(),
            reverse_device_id: None,
            added_at: 0,
        });
        // A random project id (see `post_message_or_forward_direct_message_is_invisible_to_other_readers`'s
        // comment): this test reads the backlog back via `read_messages`, so
        // a fixed id would pick up leftover messages from other tests AND
        // from this same test's own prior runs.
        let project = format!("proj-peer-spoof-{}", uuid::Uuid::new_v4());
        state.registry.upsert_interactive("recipient", std::path::Path::new("."), &project, "2026-09-05T00:00:00Z");

        let mut router = Router::new();
        register_channel_rpc(&mut router, state.clone());

        let req = Request {
            jsonrpc: "2.0".into(),
            id: json!(1),
            method: "peer_channel_post".into(),
            params: Some(json!({
                "to_session_id": "recipient",
                "text": "hi",
                "from": {"session_id": "attacker", "name": "Attacker", "machine_label": "TOTALLY NOT REAL PEER"},
            })),
        };
        let resp = TRANSPORT
            .scope(Transport::PeerMachine("real-peer-id".into()), async {
                let (tx, _rx) = tokio::sync::mpsc::channel(16);
                router.dispatch(req, ConnectionContext::new(tx)).await
            })
            .await;
        assert!(resp.error.is_none(), "expected success, got {:?}", resp.error);

        let stored = read_messages(&state, "recipient").unwrap();
        let author = stored["messages"][0]["author"].as_str().unwrap();
        assert!(author.ends_with("@ Real Peer"), "must use the REAL registry label: {author}");
        assert!(!author.contains("TOTALLY NOT REAL PEER"), "payload's claimed label must never win: {author}");
    }
}
