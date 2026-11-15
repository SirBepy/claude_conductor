//! Subs whose main chat lives on another paired machine: the home owns the
//! family, the host runs the sub's process. Design, trust rules, wire and the
//! build steps: `docs/cross-machine-subchats.md`.

pub mod git_sync;
pub mod host;
pub mod project_match;
pub mod records;
pub mod spawn;
#[cfg(test)]
mod loopback_tests;
#[cfg(test)]
mod test_support;

/// Daemon start: clears the scratch refs and bundle files a crash can leave, in
/// every repo this daemon makes or imports a bundle in: the ones its remote-subs
/// records name (it is the home) and the ones its visiting subs work in (it is the
/// host). Nothing is making or importing a bundle yet.
pub fn sweep_at_start() {
    records::sweep_at_start();
    host::sweep_at_start();
}

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
