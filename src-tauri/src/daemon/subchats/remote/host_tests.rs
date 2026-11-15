use super::super::test_support::*;
use super::*;
use crate::daemon::subchats::TempDataDir;
use std::sync::Mutex;

/// A router with both methods and a starter that records the ids it was asked to
/// start instead of launching `claude`.
fn host_router(state: &Arc<DaemonState>) -> (Router, Arc<Mutex<Vec<String>>>) {
    let started = Arc::new(Mutex::new(Vec::new()));
    let seen = started.clone();
    let mut router = Router::new();
    register_with(&mut router, state.clone(), Arc::new(move |_, id| seen.lock().unwrap().push(id.to_string())));
    (router, started)
}

fn spawn_params(sub_id: &str, main: &str, pair: &Pair, writes: bool) -> Value {
    let base = git_sync::resolve_commit(&pair.home, "HEAD").unwrap();
    let have = git_sync::first_have(&pair.host, &git_sync::candidates(&pair.home, &base).unwrap());
    let bundle = match have.as_deref() {
        Some(h) if h == base => None,
        other => Some(git_sync::encode(&git_sync::make_bundle(&pair.home, &base, other).unwrap())),
    };
    json!({
        "sub_id": sub_id,
        "main_id": main,
        "name": "build",
        "repo": { "origin": project_match::normalize_origin(ORIGIN) },
        "base": base,
        "target": "pc-main",
        "bundle": if writes { json!(bundle) } else { Value::Null },
        "brief": brief(writes, main),
        "first_message": "Job: Build the thing",
        "model": "sonnet",
        "effort": "high",
    })
}

fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}

fn error_of(resp: &crate::daemon::rpc::Response) -> String {
    resp.error.as_ref().map(|e| e.message.clone()).unwrap_or_default()
}

#[tokio::test]
async fn a_writing_sub_from_a_peer_gets_a_tree_at_the_base_and_a_row_that_names_its_home() {
    let _data = TempDataDir::new();
    let pair = pair();
    // The home moves on: the host's clone lacks the tip and needs the bundle.
    commit(&pair.home, "a.txt", "from the home\n");
    let tip = commit(&pair.home, "b.txt", "and more\n");
    assert!(git_sync::resolve_commit(&pair.host, &tip).is_none());
    let state = state_with_projects(&[&pair.host]);
    let (router, started) = host_router(&state);

    // What does the host already have of the home's tip?
    let offer = git_sync::candidates(&pair.home, &tip).unwrap();
    let r = call(&router, peer("pc-id"), "sub_git_have", json!({"repo": {"origin": project_match::normalize_origin(ORIGIN)}, "candidates": offer})).await;
    let have = r.result.as_ref().unwrap()["have"].as_str().map(str::to_string);
    assert!(have.is_some() && have.as_deref() != Some(tip.as_str()), "the host has an ancestor, not the tip: {have:?}");

    let sub = id();
    let mut params = spawn_params(&sub, "pc-main", &pair, true);
    // A payload that claims another machine is its home must change nothing: the
    // transport names the caller.
    params["brief"]["home"] = json!({"machine_id": "evil", "main_id": "someone-elses-chat"});
    params["brief"]["parent"] = json!("someone-elses-chat");
    let r = call(&router, peer("pc-id"), "sub_spawn", params).await;
    assert!(r.error.is_none(), "{}", error_of(&r));
    assert_eq!(r.result.as_ref().unwrap()["session_id"], sub.as_str());

    let row = state.registry.get(&sub).expect("the visiting sub has a row here");
    assert_eq!(row.subchat_of.as_deref(), Some("pc-main"), "a sub of the home's main chat, which is not in this registry");
    assert!(state.registry.get("pc-main").is_none());
    let cfg = crate::sessions::chat_config::get(&sub).unwrap();
    let brief = cfg.subchat.unwrap();
    assert_eq!(brief.home, Some(HomeRef { machine_id: "pc-id".into(), main_id: "pc-main".into() }), "the home comes from the transport");
    assert_eq!(brief.parent, "pc-main");
    assert_eq!(cfg.started_by_machine, "pc-id", "so the home may drive it");
    assert!(crate::daemon::subchats::is_visiting(&sub));

    let info = brief.worktree_at.expect("a writing sub runs in its own worktree");
    assert_eq!(git_sync::resolve_commit(Path::new(&info.path), "HEAD").as_deref(), Some(tip.as_str()), "the tree starts at the home's tip");
    assert_eq!(info.target, "pc-main", "the home's branch name");
    assert_eq!(info.base.as_deref(), Some(tip.as_str()));
    assert_eq!(git_sync::resolve_commit(&pair.host, &format!("refs/cc-sub/{sub}/target")).as_deref(), Some(tip.as_str()));
    assert_eq!(row.cwd, PathBuf::from(&info.cwd), "it runs in the tree, not the host's own checkout");
    let held = held::all().into_iter().find(|h| h.sub_id == sub).expect("registered as a held launch");
    assert!(held.launch.first_message.starts_with("Job: Build the thing"), "the home's message");
    assert!(held.launch.first_message.contains("your own git worktree"), "plus the host's note about the tree");
    assert_eq!(started.lock().unwrap().as_slice(), [sub.clone()], "and started");
}

#[tokio::test]
async fn a_read_only_sub_runs_in_the_project_folder_and_ships_no_commits() {
    let _data = TempDataDir::new();
    let pair = pair();
    let state = state_with_projects(&[&pair.host]);
    let (router, started) = host_router(&state);
    let sub = id();
    let mut params = spawn_params(&sub, "pc-main", &pair, false);
    params["base"] = json!("");
    params["target"] = json!("");
    let r = call(&router, peer("pc-id"), "sub_spawn", params).await;
    assert!(r.error.is_none(), "{}", error_of(&r));
    let cfg = crate::sessions::chat_config::get(&sub).unwrap();
    assert!(cfg.subchat.as_ref().unwrap().worktree_at.is_none(), "no tree for a reader");
    assert_eq!(state.registry.get(&sub).unwrap().cwd, pair.host);
    assert!(git_sync::resolve_commit(&pair.host, &format!("refs/cc-sub/{sub}/target")).is_none());
    assert_eq!(started.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn a_base_the_clone_already_has_needs_no_bundle() {
    let _data = TempDataDir::new();
    let pair = pair();
    let state = state_with_projects(&[&pair.host]);
    let (router, _) = host_router(&state);
    let sub = id();
    let params = spawn_params(&sub, "pc-main", &pair, true);
    assert!(params["bundle"].is_null(), "the clone is at the home's tip already");
    let r = call(&router, peer("pc-id"), "sub_spawn", params).await;
    assert!(r.error.is_none(), "{}", error_of(&r));
    let base = git_sync::resolve_commit(&pair.home, "HEAD");
    assert_eq!(git_sync::resolve_commit(&pair.host, &format!("refs/cc-sub/{sub}/target")), base);
}

#[tokio::test]
async fn a_hold_registers_the_sub_and_starts_nothing() {
    let _data = TempDataDir::new();
    let pair = pair();
    let state = state_with_projects(&[&pair.host]);
    let (router, started) = host_router(&state);
    let sub = id();
    let mut params = spawn_params(&sub, "pc-main", &pair, true);
    params["hold"] = json!(true);
    let r = call(&router, peer("pc-id"), "sub_spawn", params).await;
    assert!(r.error.is_none(), "{}", error_of(&r));
    assert_eq!(r.result.unwrap()["held"], true);
    assert!(held::is_held(&sub));
    assert!(started.lock().unwrap().is_empty(), "the home starts it later");
}

#[tokio::test]
async fn only_a_peer_machine_may_call_either_method() {
    let _data = TempDataDir::new();
    let pair = pair();
    let state = state_with_projects(&[&pair.host]);
    let (router, started) = host_router(&state);
    let sub = id();
    for transport in [None, Some(Transport::Phone)] {
        let r = call(&router, transport.clone(), "sub_spawn", spawn_params(&sub, "pc-main", &pair, true)).await;
        assert!(error_of(&r).contains("only callable by a peer machine"), "{transport:?}: {}", error_of(&r));
        let r = call(&router, transport.clone(), "sub_git_have", json!({"repo": {"origin": "github.com/sirbepy/scratch"}, "candidates": []})).await;
        assert!(error_of(&r).contains("only callable by a peer machine"), "{transport:?}");
    }
    assert!(state.registry.get(&sub).is_none() && started.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_spawn_with_no_matching_project_is_refused_with_the_projects_the_host_has() {
    let _data = TempDataDir::new();
    let pair = pair();
    let other = tempfile::tempdir().unwrap();
    let state = state_with_projects(&[other.path()]);
    let (router, started) = host_router(&state);
    let sub = id();
    let r = call(&router, peer("pc-id"), "sub_spawn", spawn_params(&sub, "pc-main", &pair, true)).await;
    let err = error_of(&r);
    assert!(err.contains("No project") && err.contains("machine_cwd") && err.contains(&other.path().file_name().unwrap().to_string_lossy().to_string()), "{err}");
    assert!(state.registry.get(&sub).is_none() && started.lock().unwrap().is_empty());
    assert!(git_sync::resolve_commit(&pair.host, &format!("refs/cc-sub/{sub}/target")).is_none(), "nothing imported");

    // Two projects with the same origin is as much a refusal.
    let twin = pair.host.parent().unwrap().join("twin");
    git(pair.host.parent().unwrap(), &["clone", "-q", pair.host.to_string_lossy().trim_start_matches(r"\\?\"), "twin"]);
    git(&twin, &["remote", "set-url", "origin", ORIGIN]);
    let state = state_with_projects(&[&pair.host, &twin]);
    let (router, _) = host_router(&state);
    let r = call(&router, peer("pc-id"), "sub_spawn", spawn_params(&id(), "pc-main", &pair, true)).await;
    assert!(error_of(&r).contains("More than one project"), "{}", error_of(&r));
}

#[tokio::test]
async fn machine_cwd_must_be_a_registered_project_and_is_the_way_out_of_a_missing_origin() {
    let _data = TempDataDir::new();
    let pair = pair();
    let state = state_with_projects(&[&pair.host]);
    let (router, _) = host_router(&state);
    let mut params = spawn_params(&id(), "pc-main", &pair, true);
    params["repo"] = json!({"machine_cwd": pair.home.to_string_lossy()});
    let r = call(&router, peer("pc-id"), "sub_spawn", params).await;
    assert!(error_of(&r).contains("not a registered project"), "{}", error_of(&r));

    let mut params = spawn_params(&id(), "pc-main", &pair, true);
    params["repo"] = json!({"machine_cwd": pair.host.to_string_lossy()});
    let r = call(&router, peer("pc-id"), "sub_spawn", params).await;
    assert!(r.error.is_none(), "a registered folder is taken as named: {}", error_of(&r));

    let mut params = spawn_params(&id(), "pc-main", &pair, true);
    params["repo"] = json!({});
    let r = call(&router, peer("pc-id"), "sub_spawn", params).await;
    assert!(error_of(&r).contains("no git origin") && error_of(&r).contains("machine_cwd"), "{}", error_of(&r));
}

#[tokio::test]
async fn a_peers_spawn_is_validated_before_anything_is_made() {
    let _data = TempDataDir::new();
    let pair = pair();
    let state = state_with_projects(&[&pair.host]);
    let (router, started) = host_router(&state);
    let cases: Vec<(&str, Box<dyn Fn(&mut Value)>)> = vec![
        ("sub_id is not a session id", Box::new(|p| p["sub_id"] = json!("../../escape"))),
        ("main_id is not a chat id", Box::new(|p| p["main_id"] = json!("a b/../c"))),
        ("gate sub always runs", Box::new(|p| p["brief"]["gate"] = json!(true))),
        ("first_message must be", Box::new(|p| p["first_message"] = json!("  "))),
        ("needs base", Box::new(|p| p["base"] = json!("HEAD"))),
        ("needs target", Box::new(|p| p["target"] = json!("x; rm -rf"))),
        ("Opus sub cannot edit files", Box::new(|p| {
            p["model"] = json!("opus");
            p["effort"] = json!("high");
        })),
        ("not a sub tier", Box::new(|p| p["model"] = json!("haiku"))),
    ];
    for (needle, edit) in cases {
        let mut params = spawn_params(&id(), "pc-main", &pair, true);
        edit(&mut params);
        let r = call(&router, peer("pc-id"), "sub_spawn", params).await;
        assert!(error_of(&r).contains(needle), "{needle}: {}", error_of(&r));
    }
    assert!(started.lock().unwrap().is_empty());
    assert!(!pair.host.join(".claude").join("worktrees").exists(), "no tree was made for any of them");
}

#[tokio::test]
async fn a_second_spawn_of_the_same_sub_id_is_refused_and_leaves_the_first_alone() {
    let _data = TempDataDir::new();
    let pair = pair();
    let state = state_with_projects(&[&pair.host]);
    let (router, started) = host_router(&state);
    let sub = id();
    let first = call(&router, peer("pc-id"), "sub_spawn", spawn_params(&sub, "pc-main", &pair, true)).await;
    assert!(first.error.is_none(), "{}", error_of(&first));
    let again = call(&router, peer("pc-id"), "sub_spawn", spawn_params(&sub, "pc-main", &pair, true)).await;
    assert!(error_of(&again).contains("already exists"), "{}", error_of(&again));
    assert_eq!(started.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn a_bundle_whose_head_is_not_the_base_is_refused_and_leaves_no_ref_or_tree() {
    let _data = TempDataDir::new();
    let pair = pair();
    let base = git_sync::resolve_commit(&pair.home, "HEAD").unwrap();
    let newer = commit(&pair.home, "n.txt", "newer\n");
    let state = state_with_projects(&[&pair.host]);
    let (router, started) = host_router(&state);
    let sub = id();
    let mut params = spawn_params(&sub, "pc-main", &pair, true);
    // The bundle carries `newer`, but the call names the older commit as the base.
    params["base"] = json!(base);
    params["bundle"] = json!(git_sync::encode(&git_sync::make_bundle(&pair.home, &newer, Some(&base)).unwrap()));
    let r = call(&router, peer("pc-id"), "sub_spawn", params).await;
    assert!(error_of(&r).contains("not the base commit"), "{}", error_of(&r));
    assert!(git_sync::resolve_commit(&pair.host, &format!("refs/cc-sub/{sub}/target")).is_none(), "the imported ref was taken back");
    assert!(state.registry.get(&sub).is_none() && started.lock().unwrap().is_empty());
    assert!(!pair.host.join(".claude").join("worktrees").exists());
}

#[tokio::test]
async fn a_writing_sub_needs_a_worktree_and_is_refused_where_none_can_be_made() {
    let _data = TempDataDir::new();
    let pair = pair();
    // A folder that is not a git repository but is registered and carries no origin
    // the home could match: reached by machine_cwd.
    let plain = tempfile::tempdir().unwrap();
    let state = state_with_projects(&[plain.path()]);
    let (router, started) = host_router(&state);
    let mut params = spawn_params(&id(), "pc-main", &pair, true);
    params["repo"] = json!({"machine_cwd": plain.path().to_string_lossy()});
    let r = call(&router, peer("pc-id"), "sub_spawn", params).await;
    assert!(error_of(&r).len() > 0, "refused");
    assert!(started.lock().unwrap().is_empty());
}

#[test]
fn the_start_up_sweep_reads_the_repos_of_visiting_subs_off_their_stored_briefs() {
    let _data = TempDataDir::new();
    let pair = pair();
    let mut visiting: SubchatBrief = serde_json::from_value(brief(false, "m")).unwrap();
    visiting.home = Some(HomeRef { machine_id: "pc-id".into(), main_id: "m".into() });
    visiting.worktree_at = Some(crate::daemon::subchats::WorktreeInfo {
        cwd: String::new(),
        path: String::new(),
        branch: "sub/x".into(),
        target: "t".into(),
        repo: pair.host.to_string_lossy().into_owned(),
        base: None,
    });
    crate::sessions::chat_config::set_subchat("visitor", Some(visiting.clone()));
    // A local sub's repo is not this sweep's business: its own machine sweeps it.
    let mut local = visiting;
    local.home = None;
    local.worktree_at.as_mut().unwrap().repo = "C:/not-swept".into();
    crate::sessions::chat_config::set_subchat("local", Some(local));
    assert_eq!(visiting_repos(), vec![pair.host.clone()]);

    // A crash left a scratch ref in the host's clone: the sweep takes it.
    git(&pair.host, &["update-ref", "refs/cc-bundle/leftover", "HEAD"]);
    sweep_at_start();
    assert!(git_sync::resolve_commit(&pair.host, "refs/cc-bundle/leftover").is_none());
}
