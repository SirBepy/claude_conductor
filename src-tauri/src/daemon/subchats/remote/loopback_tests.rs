//! Two in-process daemons over a real loopback link (`remote_server::spawn_on`):
//! a main chat on the home spawns a sub on the host through the tool's own entry
//! point, real bundles ride the HTTP body, and the host's requests pass the same
//! transport table a paired machine's do. Only the start of the `claude` child is
//! replaced (the starter records the id instead).

use super::test_support::*;
use super::{git_sync, host, records};
use crate::daemon::device_registry::DeviceRegistry;
use crate::daemon::machines::PeerMachine;
use crate::daemon::methods::spawn_chat::spawn_chat_or_forward;
use crate::daemon::remote_server::TestServerHandle;
use crate::daemon::rpc::Router;
use crate::daemon::state::DaemonState;
use crate::daemon::subchats::{SubchatArgs, TempDataDir};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

struct Rig {
    pair: Pair,
    home: Arc<DaemonState>,
    host: Arc<DaemonState>,
    host_id: String,
    started: Arc<Mutex<Vec<String>>>,
    host_serve: Option<TestServerHandle>,
    home_serve: Option<TestServerHandle>,
    _dirs: (tempfile::TempDir, tempfile::TempDir, tempfile::TempDir),
}

/// A home daemon with a main chat (Use subchats on) in `pair.home` and a host
/// daemon paired as its peer "Mac". With `host_has_clone` the host registers the
/// clone as a project; without it, an unrelated folder.
async fn rig(pair: Pair, host_has_clone: bool) -> Rig {
    let (a_dir, b_dir, other) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let home = state_with_projects(&[&pair.home]);
    let host = if host_has_clone { state_with_projects(&[&pair.host]) } else { state_with_projects(&[other.path()]) };
    let started = Arc::new(Mutex::new(Vec::new()));
    let seen = started.clone();
    let mut b_router = Router::new();
    host::register_with(&mut b_router, host.clone(), Arc::new(move |_, id| seen.lock().unwrap().push(id.to_string())));
    let (_, _a_port, home_serve) = crate::daemon::remote_server::spawn_on(home.clone(), a_dir.path().to_path_buf(), Router::new(), 0);
    let (_, b_port, host_serve) = crate::daemon::remote_server::spawn_on(host.clone(), b_dir.path().to_path_buf(), b_router, 0);
    let a_id = home.machines.get().unwrap().self_machine().unwrap().machine_id;
    let host_id = host.machines.get().unwrap().self_machine().unwrap().machine_id;
    host.machines.get().unwrap().set_label("Mac");
    let (token, _) = DeviceRegistry::add_machine_device("A", &a_id, b_dir.path()).unwrap();
    home.machines.get().unwrap().upsert_peer(PeerMachine {
        machine_id: host_id.clone(),
        label: "Mac".into(),
        os: "test".into(),
        iroh_id: None,
        direct_url: Some(format!("http://127.0.0.1:{b_port}")),
        token,
        reverse_device_id: None,
        added_at: 0,
        icon: None,
    });
    home.registry.upsert_interactive("home-main", &pair.home, "proj", "2026-11-15T00:00:00Z");
    crate::sessions::chat_config::set_subchats_on("home-main", true);
    Rig { pair, home, host, host_id, started, host_serve: Some(host_serve), home_serve: Some(home_serve), _dirs: (a_dir, b_dir, other) }
}

impl Rig {
    /// Shuts both servers down. A server's runtime cannot be dropped inside an async
    /// test, so every test ends here.
    fn stop(mut self) {
        for serve in [self.host_serve.take(), self.home_serve.take()].into_iter().flatten() {
            serve.kill();
        }
    }
}

fn job(writes: bool) -> SubchatArgs {
    SubchatArgs {
        task: Some("Build it".into()),
        goal: Some("Because".into()),
        done_when: Some("Done".into()),
        writes: Some(writes),
        files: writes.then(|| vec!["src/**".to_string()]),
        ..Default::default()
    }
}

async fn spawn(rig: &Rig, name: &str, args: &SubchatArgs) -> Value {
    let cwd = rig.pair.home.to_string_lossy().into_owned();
    spawn_chat_or_forward(&rig.home, "home-main", &cwd, "", None, None, Some(name), false, Some("Mac"), args).await
}

#[tokio::test]
async fn a_main_chat_spawns_a_writing_sub_on_a_paired_machine_with_the_commits_it_lacks() {
    let _data = TempDataDir::new();
    let pair = pair();
    commit(&pair.home, "a.txt", "one\n");
    let tip = commit(&pair.home, "b.txt", "two\n");
    let branch = crate::daemon::subchats::worktree::current_branch(&pair.home).unwrap();
    assert!(git_sync::resolve_commit(&pair.host, &tip).is_none(), "the clone starts behind");
    let rig = rig(pair, true).await;

    let reply = spawn(&rig, "port", &job(true)).await;
    assert_eq!(reply["ok"], true, "{reply}");
    assert_eq!(reply["machine"], "Mac");
    let sub = reply["session_id"].as_str().unwrap().to_string();

    // The host: a visiting row whose tree starts at the home's tip, which arrived as a bundle.
    let row = rig.host.registry.get(&sub).expect("a row on the host");
    assert_eq!(row.subchat_of.as_deref(), Some("home-main"));
    let cfg = crate::sessions::chat_config::get(&sub).unwrap();
    let home_ref = cfg.subchat.as_ref().unwrap().home.clone().unwrap();
    assert_eq!(home_ref.machine_id, rig.home.machines.get().unwrap().self_machine().unwrap().machine_id, "the home is named by the link, not the payload");
    assert_eq!(home_ref.main_id, "home-main");
    let info = cfg.subchat.unwrap().worktree_at.unwrap();
    assert_eq!(git_sync::resolve_commit(Path::new(&info.path), "HEAD").as_deref(), Some(tip.as_str()));
    assert_eq!(info.target, branch);
    assert_eq!(cfg.started_by_machine, home_ref.machine_id, "stamped as a chat the home started");
    assert_eq!(rig.started.lock().unwrap().as_slice(), [sub.clone()]);

    // The home: a record naming the host, and no row of the sub in its own registry.
    assert!(rig.home.registry.get(&sub).is_none());
    let record = records::get(&sub).expect("the home recorded it");
    assert_eq!((record.machine_id.as_str(), record.main_id.as_str(), record.name.as_str()), (rig.host_id.as_str(), "home-main", "port"));
    assert_eq!((record.target.as_str(), record.base.as_str()), (branch.as_str(), tip.as_str()));
    assert_eq!(record.state, records::RemoteState::Running);
    assert!(records::accepts(&sub, &rig.host_id));
    assert!(!records::accepts(&sub, "another-machine"), "a peer that does not host it is never accepted");
    rig.stop();
}

#[tokio::test]
async fn a_read_only_sub_runs_in_the_matched_folder_and_needs_no_commits() {
    let _data = TempDataDir::new();
    let pair = pair();
    commit(&pair.home, "a.txt", "ahead of the clone\n");
    let rig = rig(pair, true).await;
    let reply = spawn(&rig, "look", &job(false)).await;
    assert_eq!(reply["ok"], true, "{reply}");
    let sub = reply["session_id"].as_str().unwrap();
    let cfg = crate::sessions::chat_config::get(sub).unwrap();
    assert!(cfg.subchat.unwrap().worktree_at.is_none());
    assert_eq!(rig.host.registry.get(sub).unwrap().cwd, rig.pair.host, "the clone itself, as it is");
    assert_eq!(records::get(sub).unwrap().base, "", "no base for a reader");
    rig.stop();
}

#[tokio::test]
async fn no_matching_project_on_the_host_refuses_with_its_project_list_and_records_nothing() {
    let _data = TempDataDir::new();
    let rig = rig(pair(), false).await;
    let reply = spawn(&rig, "port", &job(true)).await;
    assert_eq!(reply["ok"], false);
    let err = reply["error"].as_str().unwrap();
    assert!(err.contains("No project on Mac") && err.contains("machine_cwd") && err.contains("projects registered on Mac"), "{err}");
    assert!(records::all().is_empty(), "no sub was recorded");
    assert!(rig.started.lock().unwrap().is_empty());
    assert_eq!(rig.home.registry.list().len(), 1, "nor a row on the home");
    rig.stop();
}

#[tokio::test]
async fn machine_cwd_names_the_host_folder_when_there_is_no_origin_to_match() {
    let _data = TempDataDir::new();
    let pair = pair();
    super::test_support::git(&pair.home, &["remote", "remove", "origin"]);
    let rig = rig(pair, true).await;
    let reply = spawn(&rig, "port", &job(false)).await;
    assert_eq!(reply["ok"], false);
    assert!(reply["error"].as_str().unwrap().contains("no git origin") && reply["error"].as_str().unwrap().contains("machine_cwd"), "{reply}");
    let mut args = job(false);
    args.machine_cwd = Some(rig.pair.host.to_string_lossy().into_owned());
    let reply = spawn(&rig, "port", &args).await;
    assert_eq!(reply["ok"], true, "{reply}");
    rig.stop();
}

#[tokio::test]
async fn the_cap_counts_the_main_chats_subs_on_every_machine() {
    let _data = TempDataDir::new();
    let rig = rig(pair(), true).await;
    for n in 0..crate::daemon::subchats::spawn::MAX_RUNNING {
        let reply = spawn(&rig, &format!("job-{n}"), &job(false)).await;
        assert_eq!(reply["ok"], true, "sub {n}: {reply}");
    }
    let over = spawn(&rig, "over", &job(false)).await;
    assert_eq!(over["ok"], false);
    assert!(over["error"].as_str().unwrap().contains("At most 10 subs") && over["error"].as_str().unwrap().contains("job-0"), "{over}");
    assert_eq!(rig.started.lock().unwrap().len(), crate::daemon::subchats::spawn::MAX_RUNNING, "the refused one started nothing");
    rig.stop();
}

#[tokio::test]
async fn a_name_a_remote_sub_has_cannot_be_reused() {
    let _data = TempDataDir::new();
    let rig = rig(pair(), true).await;
    assert_eq!(spawn(&rig, "port", &job(false)).await["ok"], true);
    let again = spawn(&rig, "Port", &job(false)).await;
    assert!(again["error"].as_str().unwrap().contains("already exists"), "{again}");
    rig.stop();
}

#[tokio::test]
async fn a_host_that_cannot_be_reached_leaves_no_record_to_hold_a_slot_or_a_name() {
    let _data = TempDataDir::new();
    let mut rig = rig(pair(), true).await;
    rig.host_serve.take().unwrap().kill();
    // Both a writer and a reader make the have-call first, so a sleeping host fails
    // before anything is recorded.
    for (name, writes) in [("port", true), ("look", false)] {
        let reply = spawn(&rig, name, &job(writes)).await;
        assert_eq!(reply["ok"], false);
        assert!(reply["error"].as_str().unwrap().contains("unreachable"), "{reply}");
        assert!(records::all().is_empty(), "{name}: nothing is counted or named");
    }
    rig.stop();
}

#[tokio::test]
async fn a_refusal_from_the_host_after_the_record_was_written_takes_the_record_back() {
    let _data = TempDataDir::new();
    let rig = rig(pair(), true).await;
    // The host has a chat under the main chat's id, so it refuses `sub_spawn` (not `sub_git_have`).
    rig.host.registry.upsert_interactive("home-main", &rig.pair.host, "proj", "2026-11-15T00:00:00Z");
    let reply = spawn(&rig, "port", &job(false)).await;
    assert_eq!(reply["ok"], false);
    assert!(reply["error"].as_str().unwrap().contains("names a chat on this machine"), "{reply}");
    assert!(records::all().is_empty(), "a sub the host refused is not counted or named");
    assert!(rig.started.lock().unwrap().is_empty());
    rig.stop();
}
