use super::super::test_support::*;
use super::*;
use crate::daemon::subchats::TempDataDir;

fn rec(repo: &Path, sub: &str, base: &str) -> RemoteSub {
    RemoteSub {
        sub_id: sub.into(),
        machine_id: "mac".into(),
        main_id: "main".into(),
        name: "port".into(),
        repo: repo.to_path_buf(),
        target: worktree::current_branch(repo).unwrap(),
        base: base.into(),
        ..Default::default()
    }
}

fn bundle_of(repo: &Path, tip: &str, exclude: &str) -> String {
    git_sync::encode(&git_sync::make_bundle(repo, tip, Some(exclude)).unwrap())
}

fn refused_text(step: Step) -> String {
    match step {
        Step::Refused(Landing::Blocked(b)) => b.text,
        Step::Landed => "landed".into(),
        Step::Moved => "moved".into(),
        Step::Refused(other) => format!("{other:?}"),
    }
}

/// `import_bundle` takes any commit the repo already has, so a host could name the
/// target's own history as "the sub's branch": it must descend from the tip that was sent.
#[test]
fn a_branch_that_does_not_build_on_the_tip_that_was_sent_is_refused_and_not_kept() {
    let _data = TempDataDir::new();
    let pair = pair();
    let c1 = git_sync::resolve_commit(&pair.home, "HEAD").unwrap();
    let c2 = commit(&pair.home, "b.txt", "two\n");
    let c3 = commit(&pair.home, "c.txt", "three\n");
    let r = rec(&pair.home, "old-branch", &c1);
    let step = merge_fetched(&r, &c3, &c2, &bundle_of(&pair.home, &c2, &c1));
    assert!(refused_text(step).contains("does not build on the target tip"));
    assert!(git_sync::resolve_commit(&pair.home, "refs/heads/sub/old-branch").is_none(), "the imported branch is not kept");
    assert_eq!(git_sync::resolve_commit(&pair.home, "HEAD").as_deref(), Some(c3.as_str()));
}

#[test]
fn a_head_the_bundle_does_not_hold_or_that_is_not_a_commit_id_is_refused() {
    let _data = TempDataDir::new();
    let pair = pair();
    let c1 = git_sync::resolve_commit(&pair.home, "HEAD").unwrap();
    let c2 = commit(&pair.home, "b.txt", "two\n");
    let r = rec(&pair.home, "claimed", &c1);
    let bundle = bundle_of(&pair.home, &c2, &c1);
    assert!(refused_text(merge_fetched(&r, &c1, &c1, &bundle)).contains("not the commit the other machine named"));
    assert!(refused_text(merge_fetched(&r, &c1, "--upload-pack=evil", &bundle)).contains("did not name a commit"));
    assert!(refused_text(merge_fetched(&r, &c1, &c2, "not base64 !!")).contains("could not be read"));
    assert!(git_sync::resolve_commit(&pair.home, "refs/heads/sub/claimed").is_none());
}

#[test]
fn a_main_checkout_on_another_branch_is_refused_before_anything_is_asked_of_the_host() {
    let _data = TempDataDir::new();
    let pair = pair();
    let c1 = git_sync::resolve_commit(&pair.home, "HEAD").unwrap();
    let r = rec(&pair.home, "switched", &c1);
    git(&pair.home, &["checkout", "-q", "-b", "elsewhere"]);
    let Err(Landing::Blocked(b)) = offer(&r) else { panic!("not refused") };
    assert_eq!(b.cause, Cause::BranchSwitched);
    assert!(b.text.contains("elsewhere"), "{}", b.text);
}

#[test]
fn what_the_host_lacks_of_the_target_is_a_bundle_from_the_base_and_nothing_when_it_has_it_all() {
    let _data = TempDataDir::new();
    let pair = pair();
    let base = git_sync::resolve_commit(&pair.home, "HEAD").unwrap();
    let r = rec(&pair.home, "offer", &base);
    let same = offer(&r).ok().unwrap();
    assert_eq!((same.tip.as_str(), same.bundle), (base.as_str(), None), "the target did not move");
    let tip = commit(&pair.home, "b.txt", "two\n");
    let moved = offer(&r).ok().unwrap();
    assert_eq!(moved.tip, tip);
    let bytes = git_sync::decode(&moved.bundle.expect("a bundle for the commits since the base")).unwrap();
    // The host side of it: the bundle imports into the host's clone and its head is the tip.
    assert_eq!(git_sync::import_bundle(&pair.host, &bytes, "refs/cc-sub/x/target-next").unwrap(), tip);
}

#[test]
fn only_a_writing_sub_with_a_base_and_a_checkout_is_landed() {
    let pair = pair();
    assert!(!lands(&RemoteSub::default()));
    assert!(lands(&rec(&pair.home, "w", "abc")));
    assert!(!lands(&rec(&pair.home, "reader", "")), "a reader has no base and no commits");
}
