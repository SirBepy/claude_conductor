//! Which of a paired peer's chats are main chats ("Use subchats" on), so a viewer
//! can list them as main chats (Joe 2026-11-13: on the Mac he could not tell which
//! Windows chats were main chats). The host owns the flag; each peer's list is
//! fetched with `list_subchats_on` when its link connects and again on every
//! `subchats_on_changed` frame it sends, and cached in `MirrorState`.
//! [`mirrored_main_chat_ids`] is what a client merges into its own list: only ids a
//! peer both reports and hosts (a mirrored row of that peer exists), never one of ours.

use std::sync::Arc;

use serde_json::Value;

use super::peer_client;
use super::registry::PeerMachine;
use crate::daemon::state::DaemonState;

/// The main-chat ids of every paired peer, minus any id that names a chat hosted here.
pub fn mirrored_main_chat_ids(state: &DaemonState) -> Vec<String> {
    state.mirror.main_chat_ids().into_iter().filter(|id| !super::is_local_session(state, id)).collect()
}

/// Whether `txt` is a peer's "the set of main chats changed" frame.
pub(super) fn is_change_frame(txt: &str) -> bool {
    serde_json::from_str::<Value>(txt).ok().is_some_and(|f| f.get("method").and_then(Value::as_str) == Some("subchats_on_changed"))
}

/// Re-reads `peer`'s list. A failure keeps the last-known cache and leaves the next
/// change frame (or reconnect) to catch up. A change in what is shown is announced as
/// `subchats_on_changed`, which every client already answers by re-reading its list;
/// the peer's own link drops that echo, since the ids are not ones it mirrors.
pub(super) async fn fetch_peer(state: &Arc<DaemonState>, peer: &PeerMachine) {
    let client = match peer_client::client_for(state, peer).await {
        Ok(c) => c,
        Err(e) => {
            log::debug!("peer_link: main chats fetch for {} unreachable: {e}", peer.machine_id);
            return;
        }
    };
    match client.call("list_subchats_on", Value::Null).await {
        Ok(Value::Array(ids)) => {
            let ids: Vec<String> = ids.iter().filter_map(|v| v.as_str().map(str::to_string)).collect();
            let before = mirrored_main_chat_ids(state);
            state.mirror.set_main_chats(&peer.machine_id, ids);
            publish_if_changed(state, &before);
        }
        Ok(other) => log::warn!("peer_link: list_subchats_on for {} returned non-array: {other:?}", peer.machine_id),
        Err(e) => log::debug!("peer_link: list_subchats_on for {} failed: {e}", peer.machine_id),
    }
}

/// Announces a change of the shown set. Compared after the peer's rows are known too
/// (`peer_link` calls this once more after an `instances_changed` frame), since an id
/// only counts once its row is mirrored.
pub(super) fn publish_if_changed(state: &DaemonState, before: &[String]) {
    if mirrored_main_chat_ids(state) != before {
        state.notifier.publish("subchats_on_changed", serde_json::json!({}));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::sessions::kinds::InstanceKind;
    use crate::types::{Instance, Settings};

    fn row(state: &DaemonState, id: &str) -> Instance {
        state.registry.upsert_interactive("proto", std::path::Path::new("C:/x"), "proj", "2026-11-16T00:00:00Z");
        let mut i = state.registry.get("proto").unwrap();
        i.session_id = id.into();
        i.kind = InstanceKind::Interactive;
        i
    }

    #[test]
    fn a_peer_marks_only_chats_it_hosts_and_never_one_of_ours() {
        let state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        let rows = vec![row(&state, "mac-main"), row(&state, "mac-plain")];
        state.registry.upsert_interactive("ours", std::path::Path::new("C:/x"), "proj", "2026-11-16T00:00:00Z");
        state.mirror.set_instances("mac", "Mac", rows);
        state.mirror.set_main_chats("mac", vec!["mac-main".into(), "ours".into(), "not-hosted".into()]);
        assert_eq!(mirrored_main_chat_ids(&state), vec!["mac-main".to_string()]);
        // A third machine naming the Mac's chat does not make it one.
        state.mirror.set_instances("other", "Other", vec![]);
        state.mirror.set_main_chats("other", vec!["mac-plain".into()]);
        assert_eq!(mirrored_main_chat_ids(&state), vec!["mac-main".to_string()]);
        state.mirror.remove("mac");
        assert!(mirrored_main_chat_ids(&state).is_empty(), "an unpaired peer's list goes with it");
    }

    #[test]
    fn only_the_change_frame_asks_for_a_refetch() {
        assert!(is_change_frame(r#"{"jsonrpc":"2.0","method":"subchats_on_changed","params":{}}"#));
        assert!(!is_change_frame(r#"{"method":"instances_changed","params":{}}"#));
        assert!(!is_change_frame("not json"));
    }

    #[test]
    fn a_change_of_the_shown_set_is_announced_once() {
        let state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        state.mirror.set_instances("mac", "Mac", vec![row(&state, "mac-main")]);
        let mut rx = state.notifier.subscribe();
        let before = mirrored_main_chat_ids(&state);
        publish_if_changed(&state, &before);
        assert!(rx.try_recv().is_err(), "nothing moved, nothing said");
        state.mirror.set_main_chats("mac", vec!["mac-main".into()]);
        publish_if_changed(&state, &before);
        assert_eq!(rx.try_recv().expect("announced")["method"], "subchats_on_changed");
    }
}
