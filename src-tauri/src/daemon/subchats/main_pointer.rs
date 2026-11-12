//! A project knows its main chat: `ProjectConfig.main_chat_id` names the one live
//! chat with "Use subchats" on that a new chat in the project goes to, and that
//! the sidebar's Main chats group lists for the project.
//!
//! The pointer is reconciled against the registry rather than set and cleared at
//! every place a chat can start or end (the form, the menu flip, a schedule, a
//! respawn, a crash, the phone): [`reconcile`] keeps a live pointer, replaces a
//! dead one with the project's newest live main chat, and clears it when there is
//! none. It runs on every mode flip, after a new main chat registers, when a
//! main chat is closed, at boot and on the 60 second tick, so a pointer that
//! outlives its chat (a crash, a close path that never asked) heals on its own.
//! It also seeds the pointer for projects that already had main chats before the
//! field existed.

use crate::daemon::state::DaemonState;
use crate::types::Instance;
use std::collections::HashSet;

/// The settings notification the app process turns into a persisted write.
pub const NOTIFY: &str = "project_main_chat_set";

fn is_live_main(i: &Instance, mode_on: &HashSet<String>) -> bool {
    i.ended_at.is_none()
        && i.end_reason.is_none()
        && i.machine.is_none()
        && !super::is_sub(i)
        && mode_on.contains(&i.session_id)
}

/// The pointer a project should hold, given the live main chats it has. A chat on
/// its way out (`closing`, the "Wait for them" pick) holds the pointer only while
/// no other main chat is open, since a new chat sent to it would be sent to a chat
/// that is about to close.
fn desired(current: Option<&str>, mains: &[&Instance]) -> Option<String> {
    let open: Vec<&&Instance> = mains.iter().filter(|i| !i.closing).collect();
    if let Some(cur) = current {
        if open.iter().any(|i| i.session_id == cur) {
            return Some(cur.to_string());
        }
    }
    // Newest first: an RFC 3339 start time sorts as text.
    if let Some(newest) = open.iter().max_by(|a, b| a.started_at.cmp(&b.started_at)) {
        return Some(newest.session_id.clone());
    }
    current.filter(|cur| mains.iter().any(|i| i.session_id == *cur)).map(str::to_string)
}

/// One reconcile at a time: two overlapping runs (a registration and a mode flip)
/// each read the registry, and the older read must not overwrite the newer pointer.
static RECONCILE: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Tells clients the pointers moved. A phone has no `settings-changed`; it re-reads
/// the project list on the mode nudge, which therefore has to follow the move.
fn announce(state: &DaemonState, project_id: &str, session_id: Option<&str>) {
    state.notifier.publish(NOTIFY, serde_json::json!({ "project_id": project_id, "session_id": session_id }));
    state.notifier.publish("subchats_on_changed", serde_json::json!({}));
}

/// [`reconcile`] with the set of mode-on chats passed in, so a test touches no
/// chat-config file. Returns the projects whose pointer changed.
pub fn reconcile_with(state: &DaemonState, mode_on: &HashSet<String>) -> Vec<String> {
    let _one_at_a_time = RECONCILE.lock().unwrap_or_else(|p| p.into_inner());
    apply(state, mode_on)
}

fn apply(state: &DaemonState, mode_on: &HashSet<String>) -> Vec<String> {
    let rows = state.registry.list();
    let mut changed = Vec::new();
    for project in state.settings.snapshot().projects {
        let mains: Vec<&Instance> = rows.iter().filter(|i| i.project_id == project.id && is_live_main(i, mode_on)).collect();
        let want = desired(project.main_chat_id.as_deref(), &mains);
        if want.as_deref() == project.main_chat_id.as_deref() {
            continue;
        }
        if state.settings.set_project_main_chat(&project.id, want.as_deref()) {
            announce(state, &project.id, want.as_deref());
            changed.push(project.id);
        }
    }
    changed
}

/// Brings every project's pointer in line with the live main chats.
pub fn reconcile(state: &DaemonState) -> Vec<String> {
    // Nothing to point at: skip reading the chat-config file.
    if state.settings.snapshot().projects.is_empty() {
        return Vec::new();
    }
    // The mode set is read under the lock, so a run that waited behind another one
    // never applies a set that run has already superseded.
    let _one_at_a_time = RECONCILE.lock().unwrap_or_else(|p| p.into_inner());
    let mode_on: HashSet<String> = crate::sessions::chat_config::list_subchats_on().into_iter().collect();
    apply(state, &mode_on)
}

/// The project whose main chat `session_id` is, when the pointer names it.
pub fn project_of_main(state: &DaemonState, session_id: &str) -> Option<String> {
    state
        .settings
        .snapshot()
        .projects
        .into_iter()
        .find(|p| p.main_chat_id.as_deref() == Some(session_id))
        .map(|p| p.id)
}

/// A `respawn` successor takes over its predecessor's place at once, so the pointer
/// never names a chat that is about to close.
pub fn hand_over(state: &DaemonState, predecessor: &str, successor: &str) {
    let _one_at_a_time = RECONCILE.lock().unwrap_or_else(|p| p.into_inner());
    let Some(project_id) = project_of_main(state, predecessor) else { return };
    if state.settings.set_project_main_chat(&project_id, Some(successor)) {
        announce(state, &project_id, Some(successor));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::types::{ProjectConfig, Settings};
    use std::sync::Arc;

    fn project(id: &str) -> ProjectConfig {
        let mut s = Settings::default();
        let (pid, _) = crate::settings::upsert_project_for_cwd(&mut s, std::path::Path::new(env!("CARGO_MANIFEST_DIR")), "2026-11-12T00:00:00Z");
        let mut p = s.projects.into_iter().find(|p| p.id == pid).unwrap();
        p.id = id.to_string();
        p.main_chat_id = None;
        p
    }

    fn state_with(projects: &[&str]) -> Arc<DaemonState> {
        let mut s = Settings::default();
        s.projects = projects.iter().map(|id| project(id)).collect();
        DaemonState::new(new_session_map(), SettingsCache::new(s))
    }

    fn chat(st: &DaemonState, id: &str, project: &str, started: &str) {
        st.registry.upsert_interactive(id, std::path::Path::new("."), project, started);
    }

    fn on(ids: &[&str]) -> HashSet<String> {
        ids.iter().map(|s| s.to_string()).collect()
    }

    fn pointer(st: &DaemonState, project: &str) -> Option<String> {
        st.settings.snapshot().projects.into_iter().find(|p| p.id == project).and_then(|p| p.main_chat_id)
    }

    #[test]
    fn a_main_chat_starting_sets_the_pointer_and_it_publishes_the_write() {
        let st = state_with(&["pa"]);
        let mut rx = st.notifier.subscribe();
        chat(&st, "m1", "pa", "2026-11-12T10:00:00Z");
        assert_eq!(pointer(&st, "pa"), None, "a plain chat is nobody's main chat");
        assert!(reconcile_with(&st, &on(&[])).is_empty());
        assert_eq!(reconcile_with(&st, &on(&["m1"])), ["pa"]);
        assert_eq!(pointer(&st, "pa").as_deref(), Some("m1"));
        let frame = rx.try_recv().expect("the app process is told to persist it");
        assert_eq!(frame["method"], NOTIFY);
        assert_eq!(frame["params"]["project_id"], "pa");
        assert_eq!(frame["params"]["session_id"], "m1");
    }

    #[test]
    fn closing_the_main_chat_clears_the_pointer_and_a_second_main_chat_does_not_steal_it() {
        let st = state_with(&["pa"]);
        chat(&st, "m1", "pa", "2026-11-12T10:00:00Z");
        reconcile_with(&st, &on(&["m1"]));
        // A second chat flipping the mode later does not take the project over.
        chat(&st, "m2", "pa", "2026-11-12T11:00:00Z");
        assert!(reconcile_with(&st, &on(&["m1", "m2"])).is_empty());
        assert_eq!(pointer(&st, "pa").as_deref(), Some("m1"));
        // The pointed chat closes: the other main chat takes the place.
        st.registry.mark_ended("m1", crate::types::EndReason::Manual, "2026-11-12T12:00:00Z");
        assert_eq!(reconcile_with(&st, &on(&["m1", "m2"])), ["pa"]);
        assert_eq!(pointer(&st, "pa").as_deref(), Some("m2"));
        // The last one closes: no pointer.
        st.registry.mark_ended("m2", crate::types::EndReason::Manual, "2026-11-12T13:00:00Z");
        assert_eq!(reconcile_with(&st, &on(&["m1", "m2"])), ["pa"]);
        assert_eq!(pointer(&st, "pa"), None);
    }

    #[test]
    fn one_pointer_per_project_and_a_sub_is_never_a_main_chat() {
        let st = state_with(&["pa", "pb"]);
        chat(&st, "a1", "pa", "2026-11-12T10:00:00Z");
        chat(&st, "b1", "pb", "2026-11-12T10:00:00Z");
        chat(&st, "sub", "pa", "2026-11-12T11:00:00Z");
        st.registry.set_subchat_of("sub", Some("a1".into()));
        reconcile_with(&st, &on(&["a1", "b1", "sub"]));
        assert_eq!(pointer(&st, "pa").as_deref(), Some("a1"));
        assert_eq!(pointer(&st, "pb").as_deref(), Some("b1"));
    }

    #[test]
    fn a_pointer_move_also_sends_the_mode_nudge_a_phone_re_reads_projects_on() {
        let st = state_with(&["pa"]);
        let mut rx = st.notifier.subscribe();
        chat(&st, "m1", "pa", "2026-11-12T10:00:00Z");
        reconcile_with(&st, &on(&["m1"]));
        let methods: Vec<String> = std::iter::from_fn(|| rx.try_recv().ok()).map(|f| f["method"].as_str().unwrap().to_string()).collect();
        assert_eq!(methods, [NOTIFY, "subchats_on_changed"]);
        // Nothing moved, nothing is announced.
        reconcile_with(&st, &on(&["m1"]));
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn a_chat_waiting_to_close_gives_the_pointer_to_another_open_main_chat() {
        let st = state_with(&["pa"]);
        chat(&st, "old", "pa", "2026-11-12T10:00:00Z");
        reconcile_with(&st, &on(&["old"]));
        chat(&st, "new", "pa", "2026-11-12T11:00:00Z");
        st.registry.set_closing("old", true);
        assert_eq!(reconcile_with(&st, &on(&["old", "new"])), ["pa"]);
        assert_eq!(pointer(&st, "pa").as_deref(), Some("new"));
        // The pointed chat ends and only the closing one is left: nobody to send to.
        st.registry.mark_ended("new", crate::types::EndReason::Manual, "2026-11-12T12:00:00Z");
        assert_eq!(reconcile_with(&st, &on(&["old", "new"])), ["pa"]);
        assert_eq!(pointer(&st, "pa"), None);
    }

    #[test]
    fn a_closing_chat_that_is_already_pointed_at_keeps_the_pointer_when_nothing_else_is_open() {
        let st = state_with(&["pa"]);
        chat(&st, "only", "pa", "2026-11-12T10:00:00Z");
        reconcile_with(&st, &on(&["only"]));
        st.registry.set_closing("only", true);
        assert!(reconcile_with(&st, &on(&["only"])).is_empty());
        assert_eq!(pointer(&st, "pa").as_deref(), Some("only"));
    }

    #[test]
    fn a_respawn_successor_takes_the_pointer_over() {
        let st = state_with(&["pa"]);
        chat(&st, "old", "pa", "2026-11-12T10:00:00Z");
        reconcile_with(&st, &on(&["old"]));
        chat(&st, "new", "pa", "2026-11-12T11:00:00Z");
        hand_over(&st, "old", "new");
        assert_eq!(pointer(&st, "pa").as_deref(), Some("new"));
        // A chat that was not a main chat hands nothing over.
        hand_over(&st, "stranger", "new");
        assert_eq!(pointer(&st, "pa").as_deref(), Some("new"));
    }
}
