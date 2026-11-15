//! A main chat's family: its subs on this machine (registry rows) and the subs it
//! runs on paired machines (the remote-subs records, `remote::records`).
//!
//! A remote sub has no row here, so every reader that asks "which subs does this
//! main chat have" or "whose sub is this" goes through this one lookup instead of
//! scanning `state.registry` for `subchat_of`. The remote half is the home's own
//! record, never anything a peer said (`docs/cross-machine-subchats.md`, "Identity
//! and trust").

use super::remote::records::{self, RemoteState};
use crate::daemon::state::DaemonState;

/// One unfinished-or-finished, not-ended sub of a main chat.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Member {
    pub sub_id: String,
    /// It called `finish_subchat` and has not been continued since.
    pub finished: bool,
    /// It runs on a paired machine.
    pub remote: bool,
}

/// The subs of `main` that have not ended: local rows, then recorded remote subs.
pub fn live_subs(state: &DaemonState, main: &str) -> Vec<Member> {
    let mut out: Vec<Member> = state
        .registry
        .list()
        .into_iter()
        .filter(|i| i.subchat_of.as_deref() == Some(main) && i.ended_at.is_none() && i.end_reason.is_none())
        .map(|i| Member { sub_id: i.session_id, finished: i.subchat_finished, remote: false })
        .collect();
    out.extend(
        records::of_main(main)
            .into_iter()
            .filter(|s| s.state != RemoteState::Ended)
            .map(|s| Member { sub_id: s.sub_id, finished: s.state == RemoteState::Finished, remote: true }),
    );
    out
}

/// The main chat `sub_id` belongs to: its row's parent, else the one its remote
/// record names.
pub fn main_of(state: &DaemonState, sub_id: &str) -> Option<String> {
    state
        .registry
        .get(sub_id)
        .and_then(|i| i.subchat_of)
        .or_else(|| records::get(sub_id).map(|s| s.main_id).filter(|m| !m.is_empty()))
}

/// Whether `main` still has a sub running (or waiting to start) on another machine.
pub fn has_remote_running(main: &str) -> bool {
    records::of_main(main).iter().any(|s| matches!(s.state, RemoteState::Running | RemoteState::Held))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::subchats::remote::records::RemoteSub;

    fn state() -> std::sync::Arc<DaemonState> {
        DaemonState::new(
            crate::daemon::session::new_session_map(),
            crate::daemon::settings_cache::SettingsCache::new(crate::types::Settings::default()),
        )
    }

    fn remote(id: &str, main: &str, state: RemoteState) -> RemoteSub {
        RemoteSub { sub_id: id.into(), machine_id: "mac".into(), main_id: main.into(), name: id.into(), state, ..Default::default() }
    }

    #[test]
    fn a_family_is_its_local_rows_and_its_recorded_remote_subs_without_the_ended_ones() {
        let _data = crate::daemon::subchats::TempDataDir::new();
        let st = state();
        for id in ["fam-main", "fam-local", "fam-done", "fam-ended"] {
            st.registry.upsert_interactive(id, std::path::Path::new("."), "proj", "2026-11-15T00:00:00Z");
        }
        for id in ["fam-local", "fam-done", "fam-ended"] {
            st.registry.set_subchat_of(id, Some("fam-main".into()));
        }
        st.registry.set_subchat_finished("fam-done", true);
        st.registry.mark_ended("fam-ended", crate::types::EndReason::Manual, "2026-11-15T00:00:00Z");
        records::record(remote("fam-r-run", "fam-main", RemoteState::Running)).unwrap();
        records::record(remote("fam-r-done", "fam-main", RemoteState::Finished)).unwrap();
        records::record(remote("fam-r-gone", "fam-main", RemoteState::Ended)).unwrap();
        records::record(remote("fam-r-other", "someone-else", RemoteState::Running)).unwrap();
        let mut family: Vec<(String, bool, bool)> = live_subs(&st, "fam-main").into_iter().map(|m| (m.sub_id, m.finished, m.remote)).collect();
        family.sort();
        assert_eq!(
            family,
            [
                ("fam-done".to_string(), true, false),
                ("fam-local".to_string(), false, false),
                ("fam-r-done".to_string(), true, true),
                ("fam-r-run".to_string(), false, true),
            ]
        );
    }

    #[test]
    fn a_remote_subs_main_chat_comes_from_its_record_and_a_local_subs_from_its_row() {
        let _data = crate::daemon::subchats::TempDataDir::new();
        let st = state();
        st.registry.upsert_interactive("fm-sub", std::path::Path::new("."), "proj", "2026-11-15T00:00:00Z");
        st.registry.set_subchat_of("fm-sub", Some("fm-main".into()));
        records::record(remote("fm-r", "fm-rmain", RemoteState::Running)).unwrap();
        assert_eq!(main_of(&st, "fm-sub").as_deref(), Some("fm-main"));
        assert_eq!(main_of(&st, "fm-r").as_deref(), Some("fm-rmain"));
        assert_eq!(main_of(&st, "nobody"), None);
    }

    #[test]
    fn a_held_or_running_remote_sub_counts_as_running_and_a_finished_one_does_not() {
        let _data = crate::daemon::subchats::TempDataDir::new();
        records::record(remote("rr-held", "rr-main", RemoteState::Held)).unwrap();
        assert!(has_remote_running("rr-main"));
        records::update("rr-held", |r| r.state = RemoteState::Finished).unwrap();
        assert!(!has_remote_running("rr-main"));
    }
}
