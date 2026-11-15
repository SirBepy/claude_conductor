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

/// The checkout can be switched while the host works; the branch is read again at the merge.
#[test]
fn a_checkout_switched_after_the_offer_is_not_merged_into() {
    let _data = TempDataDir::new();
    let pair = pair();
    let c1 = git_sync::resolve_commit(&pair.home, "HEAD").unwrap();
    let c2 = commit(&pair.host, "x.txt", "the sub's commit\n");
    let r = rec(&pair.home, "switched-late", &c1);
    git(&pair.home, &["checkout", "-q", "-b", "elsewhere"]);
    let text = refused_text(merge_fetched(&r, &c1, &c2, &bundle_of(&pair.host, &c2, &c1)));
    assert!(text.contains("not on") && text.contains("any more"), "{text}");
    assert_eq!(git_sync::resolve_commit(&pair.home, "HEAD").as_deref(), Some(c1.as_str()), "nothing moved on the branch it is on now");
    assert!(!pair.home.join("x.txt").exists());
}

/// A link that fails during a retry must not turn a merge pending on dirty files into a
/// refused one the tick never retries.
#[test]
fn an_unreachable_host_keeps_a_merge_pending_on_dirty_files() {
    use crate::daemon::subchats::pending_merges::{self, Cause as Pending};
    let _data = TempDataDir::new();
    let state = crate::daemon::state::DaemonState::new(
        crate::daemon::session::new_session_map(),
        crate::daemon::settings_cache::SettingsCache::new(crate::types::Settings::default()),
    );
    let pair = pair();
    let r = rec(&pair.home, "pending-sub", "abc");
    pending_merges::store(&r.sub_id, Pending::DirtyFiles, vec!["d.txt".into()]);
    let Landing::Blocked(b) = unreachable("Mac", &PeerError::NotSent("down".into())) else { panic!("not refused") };
    merge_followup::on_blocked_remote(&state, &r, &b);
    let kept = pending_merges::all().into_iter().find(|p| p.sub_id == r.sub_id).unwrap();
    assert_eq!((kept.cause, kept.files), (Pending::DirtyFiles, vec!["d.txt".to_string()]));
    assert!(crate::daemon::subchats::plumbing::current("pending-sub").is_none(), "and the main chat is not told to fix something that retries by itself");
    // Refused for a real reason, it is replaced.
    let real = Blocked { verdict: "Not merged", text: "x".into(), points: Vec::new(), cause: Cause::Other };
    merge_followup::on_blocked_remote(&state, &r, &real);
    assert_eq!(pending_merges::all().into_iter().find(|p| p.sub_id == r.sub_id).unwrap().cause, Pending::Refused);
}

/// A finish numbered after its chat's end still counts: `subchat merge` does not call the
/// sub unfinished.
#[tokio::test]
async fn subchat_merge_takes_an_ended_sub_whose_finish_arrived_after_its_end() {
    let _data = TempDataDir::new();
    let state = crate::daemon::state::DaemonState::new(
        crate::daemon::session::new_session_map(),
        crate::daemon::settings_cache::SettingsCache::new(crate::types::Settings::default()),
    );
    let pair = pair();
    let mut r = rec(&pair.home, "ended-first", "abc");
    r.state = super::super::records::RemoteState::Ended;
    assert!(merge_now(&state, &r).await.unwrap_err().contains("has not finished"), "no finish round yet");
    r.finished_round = 1;
    assert!(merge_now(&state, &r).await.unwrap_err().contains("has not finished"), "a sub ended on purpose after its finish is not landed");
    r.finished_after_end = true;
    let said = merge_now(&state, &r).await.unwrap_err();
    assert!(!said.contains("has not finished"), "{said}");
}

/// Only a merge waiting on dirty files is retried by the tick, so only that one is kept
/// through a link failure; a refused one is replaced and the main chat is told.
#[test]
fn an_unreachable_host_replaces_a_refused_entry_and_wakes_the_main_chat() {
    use crate::daemon::subchats::pending_merges::{self, Cause as Pending};
    let _data = TempDataDir::new();
    let state = crate::daemon::state::DaemonState::new(
        crate::daemon::session::new_session_map(),
        crate::daemon::settings_cache::SettingsCache::new(crate::types::Settings::default()),
    );
    let pair = pair();
    let r = rec(&pair.home, "refused-sub", "abc");
    pending_merges::store(&r.sub_id, Pending::Refused, vec!["old.txt".into()]);
    let Landing::Blocked(b) = unreachable("Mac", &PeerError::NotSent("down".into())) else { panic!("not refused") };
    merge_followup::on_blocked_remote(&state, &r, &b);
    assert!(crate::daemon::subchats::plumbing::current("refused-sub").is_some(), "the main chat hears the merge could not run");
    assert!(pending_merges::contains(&r.sub_id));
}

/// An ended sub's refused merge is forgotten by the tick, as for a local sub; one waiting
/// on dirty files is still landed (its finish may have been numbered after its end).
#[tokio::test]
async fn the_tick_forgets_an_ended_remote_subs_refused_merge() {
    use crate::daemon::subchats::pending_merges::{self, Cause as Pending};
    let _data = TempDataDir::new();
    let state = crate::daemon::state::DaemonState::new(
        crate::daemon::session::new_session_map(),
        crate::daemon::settings_cache::SettingsCache::new(crate::types::Settings::default()),
    );
    let pair = pair();
    let mut r = rec(&pair.home, "ended-refused", "abc");
    r.state = super::super::records::RemoteState::Ended;
    r.finished_round = 1;
    super::super::records::record(r.clone()).unwrap();
    pending_merges::store(&r.sub_id, Pending::Refused, vec![]);
    // Ended on purpose after its finish: even a merge waiting on dirty files is forgotten.
    let mut deliberate = rec(&pair.home, "ended-dirty", "abc");
    deliberate.state = super::super::records::RemoteState::Ended;
    deliberate.finished_round = 1;
    super::super::records::record(deliberate.clone()).unwrap();
    pending_merges::store(&deliberate.sub_id, Pending::DirtyFiles, vec!["d.txt".into()]);
    merge_followup::retry_pending(&state).await;
    assert!(!pending_merges::contains(&r.sub_id), "nothing keeps an after sub waiting on an ended sub");
    assert!(!pending_merges::contains(&deliberate.sub_id));
}

