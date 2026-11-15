use super::super::test_support::*;
use super::*;
use crate::daemon::rpc::Transport;
use crate::daemon::subchats::TempDataDir;

const METHODS: [&str; 3] = ["sub_update_branch", "sub_fetch_branch", "sub_cleanup"];

fn router(state: &Arc<DaemonState>) -> Router {
    let mut router = Router::new();
    register(&mut router, state.clone());
    router
}

fn error_of(resp: &crate::daemon::rpc::Response) -> String {
    resp.error.as_ref().map(|e| e.message.clone()).unwrap_or_default()
}

fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}

fn params(method: &str, sub: &str) -> Value {
    let commit = "a".repeat(40);
    match method {
        "sub_update_branch" => json!({"sub_id": sub, "target_tip": commit}),
        "sub_fetch_branch" => json!({"sub_id": sub, "exclude": commit}),
        _ => json!({"sub_id": sub, "merged_head": commit}),
    }
}

/// A sub visiting from `machine`, with or without a tree of its own.
fn visiting(sub: &str, machine: &str, with_tree: bool) {
    crate::daemon::subchats::store_visiting_brief(sub, "home-main", machine);
    let mut brief = crate::sessions::chat_config::get(sub).and_then(|c| c.subchat).unwrap();
    if with_tree {
        brief.worktree_at = Some(WorktreeInfo {
            cwd: String::new(),
            path: String::new(),
            branch: format!("sub/{sub}"),
            target: "main".into(),
            repo: ".".into(),
            base: None,
        });
    }
    crate::sessions::chat_config::set_subchat(sub, Some(brief));
}

#[tokio::test]
async fn only_a_peer_machine_may_call_the_landing_methods() {
    let _data = TempDataDir::new();
    let state = state_with_projects(&[]);
    let router = router(&state);
    let sub = id();
    visiting(&sub, "pc-id", true);
    for method in METHODS {
        for transport in [None, Some(Transport::Phone)] {
            let r = call(&router, transport.clone(), method, params(method, &sub)).await;
            assert!(error_of(&r).contains("only callable by a peer machine"), "{method} {transport:?}: {}", error_of(&r));
        }
    }
}

/// A peer learns nothing about a sub that is not its own: another machine's sub, a
/// local chat and an id nobody has all get the same refusal.
#[tokio::test]
async fn a_sub_that_is_not_the_callers_is_one_refusal_whatever_the_reason() {
    let _data = TempDataDir::new();
    let state = state_with_projects(&[]);
    let router = router(&state);
    let (theirs, local, nobody) = (id(), id(), id());
    visiting(&theirs, "pc-id", true);
    crate::daemon::subchats::store_sub_brief(&local, "local-main");
    for method in METHODS {
        let mut seen = Vec::new();
        for sub in [&theirs, &local, &nobody, &"not-a-uuid".to_string()] {
            let r = call(&router, peer("some-other-machine"), method, params(method, sub)).await;
            seen.push(error_of(&r));
        }
        assert!(seen.iter().all(|e| e.contains("no sub of a chat on your machine has that id here")), "{method}: {seen:?}");
        assert!(seen.windows(2).all(|w| w[0] == w[1]), "{method}: the refusals differ: {seen:?}");
    }
}

#[tokio::test]
async fn a_sub_that_has_no_tree_here_has_no_commits_to_land() {
    let _data = TempDataDir::new();
    let state = state_with_projects(&[]);
    let router = router(&state);
    let sub = id();
    visiting(&sub, "pc-id", false);
    for method in METHODS {
        let r = call(&router, peer("pc-id"), method, params(method, &sub)).await;
        assert!(error_of(&r).contains("no worktree"), "{method}: {}", error_of(&r));
    }
}

/// A merge starts after the sub finished, as a local one does: a sub still working
/// owns its tree, so the two that read or move it wait.
#[tokio::test]
async fn a_sub_that_is_still_working_is_not_rebased_or_read() {
    let _data = TempDataDir::new();
    let state = state_with_projects(&[]);
    let router = router(&state);
    let sub = id();
    visiting(&sub, "pc-id", true);
    state.registry.upsert_interactive(&sub, std::path::Path::new("."), "proj", "2026-11-15T00:00:00Z");
    for method in ["sub_update_branch", "sub_fetch_branch"] {
        let r = call(&router, peer("pc-id"), method, params(method, &sub)).await;
        assert!(error_of(&r).contains("still working"), "{method}: {}", error_of(&r));
    }
}

#[tokio::test]
async fn a_commit_id_that_is_not_one_is_refused_before_git_sees_it() {
    let _data = TempDataDir::new();
    let state = state_with_projects(&[]);
    let router = router(&state);
    let sub = id();
    visiting(&sub, "pc-id", true);
    state.registry.upsert_interactive(&sub, std::path::Path::new("."), "proj", "2026-11-15T00:00:00Z");
    state.registry.set_subchat_finished(&sub, true);
    let bad = "--upload-pack=evil";
    for (method, key) in [("sub_update_branch", "target_tip"), ("sub_fetch_branch", "exclude"), ("sub_cleanup", "merged_head")] {
        let r = call(&router, peer("pc-id"), method, json!({"sub_id": sub, key: bad})).await;
        assert!(error_of(&r).contains("is not a full commit id"), "{method}: {}", error_of(&r));
    }
}
