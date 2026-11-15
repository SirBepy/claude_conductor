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
    host_serve: Arc<Mutex<Option<TestServerHandle>>>,
    home_serve: Option<TestServerHandle>,
    _dirs: (tempfile::TempDir, tempfile::TempDir, tempfile::TempDir),
}

/// A home daemon with a main chat (Use subchats on) in `pair.home` and a host
/// daemon paired as its peer "Mac". With `host_has_clone` the host registers the
/// clone as a project; without it, an unrelated folder.
async fn rig(pair: Pair, host_has_clone: bool) -> Rig {
    rig_inner(pair, host_has_clone).await
}

async fn rig_inner(pair: Pair, host_has_clone: bool) -> Rig {
    let (a_dir, b_dir, other) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let home = state_with_projects(&[&pair.home]);
    let host = if host_has_clone { state_with_projects(&[&pair.host]) } else { state_with_projects(&[other.path()]) };
    let started = Arc::new(Mutex::new(Vec::new()));
    let seen = started.clone();
    let host_serve: Arc<Mutex<Option<TestServerHandle>>> = Arc::new(Mutex::new(None));
    let mut b_router = Router::new();
    host::register_with(&mut b_router, host.clone(), Arc::new(move |_, id| seen.lock().unwrap().push(id.to_string())));
    let (_, _a_port, home_serve) = crate::daemon::remote_server::spawn_on(home.clone(), a_dir.path().to_path_buf(), Router::new(), 0);
    let (_, b_port, b_handle) = crate::daemon::remote_server::spawn_on(host.clone(), b_dir.path().to_path_buf(), b_router, 0);
    *host_serve.lock().unwrap() = Some(b_handle);
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
    Rig { pair, home, host, host_id, started, host_serve, home_serve: Some(home_serve), _dirs: (a_dir, b_dir, other) }
}

impl Rig {
    /// Shuts both servers down. A server's runtime cannot be dropped inside an async
    /// test, so every test ends here.
    fn stop(mut self) {
        let host = self.host_serve.lock().unwrap().take();
        for serve in [host, self.home_serve.take()].into_iter().flatten() {
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
    let rig = rig(pair(), true).await;
    rig.host_serve.lock().unwrap().take().unwrap().kill();
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

/// A host that answers the have-call and then reads `sub_spawn` and drops the
/// connection without a word: the host may have started the sub, so the home keeps its
/// record (the cap, the name and step 3's events need it) and tells the main chat to check.
#[tokio::test]
async fn a_link_that_drops_after_the_host_read_the_spawn_keeps_the_record() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let _data = TempDataDir::new();
    let pair = pair();
    let dir = tempfile::tempdir().unwrap();
    let home = state_with_projects(&[&pair.home]);
    home.init_machines(dir.path().to_path_buf());
    home.machines.get().unwrap().ensure_self();
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let calls = Arc::new(Mutex::new(Vec::<String>::new()));
    let seen = calls.clone();
    let server = tokio::spawn(async move {
        loop {
            let Ok((mut sock, _)) = listener.accept().await else { return };
            let mut buf = Vec::new();
            let mut chunk = [0u8; 4096];
            // Read the whole request (headers, then the Content-Length body).
            let body_start = loop {
                let n = sock.read(&mut chunk).await.unwrap_or(0);
                if n == 0 {
                    break None;
                }
                buf.extend_from_slice(&chunk[..n]);
                if let Some(at) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                    break Some(at + 4);
                }
            };
            let Some(start) = body_start else { continue };
            let head = String::from_utf8_lossy(&buf[..start]).to_ascii_lowercase();
            let want: usize = head.lines().find_map(|l| l.strip_prefix("content-length:")).and_then(|v| v.trim().parse().ok()).unwrap_or(0);
            while buf.len() < start + want {
                let n = sock.read(&mut chunk).await.unwrap_or(0);
                if n == 0 {
                    break;
                }
                buf.extend_from_slice(&chunk[..n]);
            }
            let body = String::from_utf8_lossy(&buf[start..]).into_owned();
            if body.contains("sub_git_have") {
                seen.lock().unwrap().push("sub_git_have".into());
                let json = r#"{"ok":true,"have":null}"#;
                let reply = format!("HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{json}", json.len());
                let _ = sock.write_all(reply.as_bytes()).await;
            } else {
                seen.lock().unwrap().push("sub_spawn".into());
                // Read, then nothing: the connection just closes.
            }
        }
    });
    home.machines.get().unwrap().upsert_peer(PeerMachine {
        machine_id: "mac-id".into(),
        label: "Mac".into(),
        os: "test".into(),
        iroh_id: None,
        direct_url: Some(format!("http://127.0.0.1:{port}")),
        token: "t".into(),
        reverse_device_id: None,
        added_at: 0,
        icon: None,
    });
    home.registry.upsert_interactive("home-main", &pair.home, "proj", "2026-11-15T00:00:00Z");
    crate::sessions::chat_config::set_subchats_on("home-main", true);
    let cwd = pair.home.to_string_lossy().into_owned();
    let reply = spawn_chat_or_forward(&home, "home-main", &cwd, "", None, None, Some("look"), false, Some("Mac"), &job(false)).await;
    server.abort();
    assert_eq!(calls.lock().unwrap().as_slice(), ["sub_git_have", "sub_spawn"], "the reader made the preflight too");
    assert_eq!(reply["ok"], false, "{reply}");
    assert!(reply["error"].as_str().unwrap().contains("may still have started"), "{reply}");
    let recorded = records::all();
    assert_eq!(recorded.len(), 1, "kept");
    assert_eq!((recorded[0].machine_id.as_str(), recorded[0].name.as_str()), ("mac-id", "look"));
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
