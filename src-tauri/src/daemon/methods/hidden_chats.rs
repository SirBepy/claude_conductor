//! The sidebar's per-chat Hide/Unhide and project-rail filter, shared by every
//! client of this daemon (desktop app and phone) via `sessions::hidden_chats`.
//! The machine hosting a chat owns its hidden flag, so a hide aimed at a
//! mirrored chat is forwarded to its host (`machines::hidden`).

use crate::daemon::machines::forward::resolve_peer_client;
use crate::daemon::machines::hidden::{local_lists, merged_lists, update_local, view};
use crate::daemon::machines::{is_local_session, mirrored_owner};
use crate::daemon::rpc::{Router, RpcError, Transport};
use crate::daemon::state::DaemonState;
use crate::sessions::hidden_chats::HiddenDelta;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::sync::Arc;

/// Session ids of `delta` that a paired host owns, grouped per host as
/// `(add, remove)`. Only the session lists travel: hidden projects are
/// per machine. A `remove` is also applied locally by the caller so an id
/// hidden here before the flag moved to the host cannot stay stuck.
fn split_by_owner(state: &DaemonState, delta: &HiddenDelta) -> BTreeMap<String, (Vec<String>, Vec<String>)> {
    let mut out: BTreeMap<String, (Vec<String>, Vec<String>)> = BTreeMap::new();
    for id in &delta.add {
        if let Some(owner) = mirrored_owner(state, id) {
            out.entry(owner).or_default().0.push(id.clone());
        }
    }
    for id in &delta.remove {
        if let Some(owner) = mirrored_owner(state, id) {
            out.entry(owner).or_default().1.push(id.clone());
        }
    }
    out
}

/// A peer machine only decides for chats this daemon hosts, and never for
/// projects: it has no authority over what we host, and a cwd it names is
/// meaningless here.
fn clamp_peer_delta(state: &DaemonState, delta: HiddenDelta) -> HiddenDelta {
    let ours = |ids: Vec<String>| ids.into_iter().filter(|id| is_local_session(state, id)).collect();
    HiddenDelta { add: ours(delta.add), remove: ours(delta.remove), ..Default::default() }
}

/// Applies the delta and, only when the merged list a client sees changed,
/// tells every other client. Clients also refetch when they become visible,
/// since the notifier can drop frames (`project_daemon_notifier_broadcast_lossy`).
async fn update_hidden_chats(state: &Arc<DaemonState>, transport: &Transport, delta: HiddenDelta) -> Result<Value, RpcError> {
    let from_peer = matches!(transport, Transport::PeerMachine(_));
    let delta = if from_peer { clamp_peer_delta(state, delta) } else { delta };
    let before = merged_lists(state);
    // What Joe did by hand is his: the idle rule never overrules it.
    crate::daemon::auto_hide::note_hand_change(state, &delta.add, &delta.remove);

    // A call that already came from a peer is about this daemon's own chats
    // (docs/architecture/multi-machine.md mirroring loop guards), so it is never forwarded again.
    if !from_peer {
        // Every host is resolved (known and online) before the first call, so
        // an unknown or offline host fails the delta before any host changes.
        // A host that drops after this check can still leave earlier hosts
        // changed and local state untouched.
        let mut targets = Vec::new();
        for (owner, (add, remove)) in split_by_owner(state, &delta) {
            let client = resolve_peer_client(state, &owner).await?;
            targets.push((owner, add, remove, client));
        }
        for (owner, add, remove, client) in targets {
            client
                .call("update_hidden_chats", json!({"add": add, "remove": remove}))
                .await
                .map_err(crate::daemon::machines::forward::map_peer_err)?;
            state.mirror.apply_hidden_delta(&owner, &add, &remove);
        }
    }

    // Hosted-elsewhere ids are the host's to add; removes still apply here to
    // clear anything stored locally before the host owned the flag.
    let local = HiddenDelta {
        add: delta.add.iter().filter(|id| mirrored_owner(state, id).is_none()).cloned().collect(),
        remove: delta.remove.clone(),
        add_projects: delta.add_projects,
        remove_projects: delta.remove_projects,
    };
    update_local(state, &local);
    let after = merged_lists(state);
    if after != before {
        state.notifier.publish("hidden_chats_changed", view(&after));
    }
    Ok(view(&after))
}

pub fn register_hidden_chats(router: &mut Router, state: Arc<DaemonState>) {
    router.register("get_hidden_chats", {
        let state = state.clone();
        move |_params, ctx| {
            let state = state.clone();
            async move {
                // A peer is told only what this daemon decides itself, so the
                // other machine's own flags never come back to it as ours.
                if matches!(ctx.transport, Transport::PeerMachine(_)) {
                    return Ok(view(&local_lists(&state)));
                }
                Ok(view(&merged_lists(&state)))
            }
        }
    });
    router.register("update_hidden_chats", move |params, ctx| {
        let state = state.clone();
        async move {
            let delta: HiddenDelta = serde_json::from_value(params.unwrap_or(Value::Null))
                .map_err(|e| RpcError::invalid_params(e.to_string()))?;
            update_hidden_chats(&state, &ctx.transport, delta).await
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::daemon::subchats::TempDataDir;
    use crate::sessions::auto_hidden;

    #[tokio::test]
    async fn showing_a_chat_the_rule_hid_records_joes_choice_so_the_rule_leaves_it_alone() {
        let _data = TempDataDir::new();
        let state = DaemonState::new(new_session_map(), SettingsCache::new(crate::types::Settings::default()));
        state.registry.upsert_interactive("c1", std::path::Path::new("C:/p"), "p", "2026-11-16T10:00:00Z");
        auto_hidden::hide("c1", "");
        update_local(&state, &HiddenDelta { add: vec!["c1".into()], ..Default::default() });

        let delta = HiddenDelta { remove: vec!["c1".into()], ..Default::default() };
        update_hidden_chats(&state, &Transport::Local, delta).await.unwrap();

        let lists = auto_hidden::list();
        assert!(lists.hidden.is_empty(), "no longer the rule's");
        assert!(lists.shown.contains_key("c1"), "Joe showed it, so the rule waits for its state to change");
    }

    #[tokio::test]
    async fn hiding_a_chat_by_hand_takes_it_off_the_rules_list() {
        let _data = TempDataDir::new();
        let state = DaemonState::new(new_session_map(), SettingsCache::new(crate::types::Settings::default()));
        state.registry.upsert_interactive("c1", std::path::Path::new("C:/p"), "p", "2026-11-16T10:00:00Z");
        auto_hidden::hide("c1", "");

        let delta = HiddenDelta { add: vec!["c1".into()], ..Default::default() };
        update_hidden_chats(&state, &Transport::Local, delta).await.unwrap();

        assert!(auto_hidden::list().hidden.is_empty(), "his hide outranks the rule's");
    }
}
