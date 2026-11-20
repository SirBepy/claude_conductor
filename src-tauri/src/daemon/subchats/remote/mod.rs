//! Subs whose main chat lives on another paired machine: the home owns the
//! family, the host runs the sub's process. Design, trust rules, wire and the
//! build steps: `docs/cross-machine-subchats.md`.

pub mod actions;
pub mod after;
pub mod events;
pub mod git_sync;
pub mod land;
pub mod home;
pub mod host;
pub mod host_actions;
pub mod host_land;
pub mod outbox;
pub mod project_match;
pub mod records;
pub mod spawn;
pub mod watch;
#[cfg(test)]
mod loopback_tests;
#[cfg(test)]
pub(crate) mod test_support;

/// How a paired machine is named on a card: its label from the registry, cut to plain
/// characters (it comes from the peer's own profile). `None` when the machine is not paired
/// or has no usable label.
pub fn machine_label(state: &crate::daemon::state::DaemonState, machine_id: &str) -> Option<String> {
    let label = state.machines.get()?.peer(machine_id)?.label;
    Some(crate::daemon::subchats::wake::safe_name(&label)).filter(|l| !l.is_empty())
}

/// Daemon start: clears the scratch refs and bundle files a crash can leave, in
/// every repo this daemon makes or imports a bundle in: the ones its remote-subs
/// records name (it is the home) and the ones its visiting subs work in (it is the
/// host). Nothing is making or importing a bundle yet.
pub fn sweep_at_start() {
    records::sweep_at_start();
    host::sweep_at_start();
}

pub use home::recover_finish_steps;

#[cfg(test)]
mod tests {
    use super::test_support::*;
    use super::*;
    use crate::daemon::subchats::{HomeRef, SubchatBrief, TempDataDir, WorktreeInfo};

    #[test]
    fn a_daemon_start_sweeps_the_repos_of_its_remote_subs_and_of_its_visiting_subs() {
        let _data = TempDataDir::new();
        let pair = pair();
        let leftover = |repo: &std::path::Path| git(repo, &["update-ref", "refs/cc-bundle/leftover", "HEAD"]);
        let gone = |repo: &std::path::Path| git_sync::resolve_commit(repo, "refs/cc-bundle/leftover").is_none();
        // This daemon is the home of a sub recorded against `pair.home`...
        records::record(records::RemoteSub { sub_id: "s".into(), machine_id: "mac".into(), repo: pair.home.clone(), ..Default::default() }).unwrap();
        // ...and the host of a visiting sub whose tree belongs to `pair.host`.
        let mut visiting: SubchatBrief = serde_json::from_value(brief(true, "m")).unwrap();
        visiting.home = Some(HomeRef { machine_id: "pc".into(), main_id: "m".into() });
        visiting.worktree_at = Some(WorktreeInfo {
            cwd: String::new(),
            path: String::new(),
            branch: "sub/x".into(),
            target: "t".into(),
            repo: pair.host.to_string_lossy().into_owned(),
            base: None,
        });
        crate::sessions::chat_config::set_subchat("visitor", Some(visiting));
        leftover(&pair.home);
        leftover(&pair.host);
        sweep_at_start();
        assert!(gone(&pair.home), "the home's side");
        assert!(gone(&pair.host), "the host's side");
    }
}
