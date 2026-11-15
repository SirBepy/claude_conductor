//! The home half of landing a visiting sub's commits
//! (`docs/cross-machine-subchats.md`, step 4): the remote twin of
//! `worktree::land_with`, run under the same per-repo lock and ending in the same
//! `merge --ff-only --no-overwrite-ignore` in the main chat's checkout.
//!
//! The sub's commits live in the host's clone, so a landing is a conversation:
//! 1. this side reads the target branch's tip and makes a bundle of what the host
//!    lacks of it (`base..tip`; the host has `base`, it started its tree there);
//! 2. `sub_update_branch`: the host rebases the sub's branch onto that tip (a
//!    conflict comes back as the files, nothing merged, the host's branch untouched);
//! 3. `sub_fetch_branch`: the sub's branch comes back as a bundle that excludes that
//!    tip, and is imported as `refs/heads/sub/<id>` here;
//! 4. the imported head must descend from the tip that was sent (the import accepts
//!    any commit this repo already has), the files it changes are checked against
//!    this checkout's uncommitted files, and the branch is fast-forwarded in.
//! A target that moved between 2 and 4 costs one more round, as locally. After a
//! merge the imported branch is deleted and the host is told (`sub_cleanup`) which
//! head landed, through the outbox, so it removes the tree even if it was offline.
//!
//! Nothing here trusts the host: the branch names are this side's (`sub/<sub id>`,
//! the id minted here), the host's claimed head must equal what the bundle holds,
//! and a bundle is only ever imported into that one ref.

use super::records::RemoteSub;
use super::{git_sync, outbox};
use crate::daemon::machines::{client_for, PeerError};
use crate::daemon::state::DaemonState;
use crate::daemon::subchats::merge_followup;
use crate::daemon::subchats::worktree::{self, Blocked, Cause, Landing};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

/// A call that carries a bundle can be tens of megabytes over a slow tunnel.
const BUNDLE_CALL: Duration = Duration::from_secs(120);

fn refused(verdict: &'static str, text: String, points: Vec<String>, cause: Cause) -> Landing {
    Landing::Blocked(Blocked { verdict, text, points, cause })
}

/// Whether `rec` is a sub whose commits come back: a writing sub carries the base
/// its tree started from and the branch it merges into here.
pub fn lands(rec: &RemoteSub) -> bool {
    !rec.base.is_empty() && !rec.target.is_empty() && !rec.repo.as_os_str().is_empty()
}

fn branch_ref(sub_id: &str) -> String {
    format!("refs/heads/sub/{sub_id}")
}

/// What step 1 found, or the refusal.
struct Offer {
    tip: String,
    bundle: Option<String>,
}

fn offer(rec: &RemoteSub) -> Result<Offer, Landing> {
    let repo = rec.repo.as_path();
    let lock = worktree::repo_lock(repo);
    let _held = lock.lock().unwrap_or_else(|p| p.into_inner());
    if !repo.is_dir() {
        return Err(refused("Not merged", format!("The checkout {} is gone, so the commits could not be merged.", repo.display()), Vec::new(), Cause::Other));
    }
    let now = worktree::current_branch(repo);
    if now.as_deref() != Some(rec.target.as_str()) {
        return Err(refused(
            "Not merged",
            format!(
                "The main checkout is on {} now, but this sub started from {t}. Nothing was merged. Its commits are safe on its branch on the other machine: switch the main checkout back to {t}, then merge again.",
                now.map(|n| format!("branch {n}")).unwrap_or_else(|| "a detached HEAD".to_string()),
                t = rec.target
            ),
            Vec::new(),
            Cause::BranchSwitched,
        ));
    }
    let Some(tip) = git_sync::resolve_commit(repo, &format!("refs/heads/{}", rec.target)) else {
        return Err(refused("Not merged", format!("The branch {} no longer exists here.", rec.target), Vec::new(), Cause::Other));
    };
    let bundle = if tip == rec.base {
        None
    } else {
        let bytes = git_sync::make_bundle(repo, &tip, Some(&rec.base)).map_err(|e| {
            refused("Not merged", format!("{} has moved too far from where the sub started for a machine link to carry it: {e}", rec.target), Vec::new(), Cause::Other)
        })?;
        Some(git_sync::encode(&bytes))
    };
    Ok(Offer { tip, bundle })
}

/// What step 4 did.
enum Step {
    Landed,
    /// The target moved under the rebase: another round re-bases on its new tip.
    Moved,
    Refused(Landing),
}

/// Imports the host's branch, checks it, and fast-forwards it in. `head` and `bundle`
/// are what `sub_fetch_branch` answered; `tip` is what was sent to the host.
fn merge_fetched(rec: &RemoteSub, tip: &str, head: &str, bundle: &str) -> Step {
    let repo = rec.repo.as_path();
    let lock = worktree::repo_lock(repo);
    let _held = lock.lock().unwrap_or_else(|p| p.into_inner());
    let branch = branch_ref(&rec.sub_id);
    let result = merge_locked(rec, repo, &branch, tip, head, bundle);
    // The imported branch only ever served this merge.
    git_sync::delete_ref(repo, &branch);
    result
}

fn merge_locked(rec: &RemoteSub, repo: &Path, branch: &str, tip: &str, head: &str, bundle: &str) -> Step {
    let other = |why: String| Step::Refused(refused("Not merged", why, Vec::new(), Cause::Other));
    if !git_sync::is_commit_id(head) {
        return other("The other machine did not name a commit for the sub's branch.".to_string());
    }
    let bytes = match git_sync::decode(bundle) {
        Ok(b) => b,
        Err(e) => return other(format!("The bundle from the other machine could not be read: {e}")),
    };
    match git_sync::import_bundle(repo, &bytes, branch) {
        Ok(got) if got == head => {}
        Ok(_) => return other("The bundle's head is not the commit the other machine named, so nothing was merged.".to_string()),
        Err(e) => return other(format!("The sub's commits could not be imported: {e}")),
    }
    // `import_bundle` takes any commit this repo already has, so a host that named the
    // target itself or an unrelated old commit would pass it: the branch must be the
    // target tip this side sent, plus the sub's own commits.
    if head == tip || !worktree::is_ancestor(repo, tip, branch) {
        return if head == tip { Step::Landed } else { other("The sub's branch does not build on the target tip that was sent, so nothing was merged.".to_string()) };
    }
    // The checkout may have been switched while the host worked: the branch is read again
    // under the same lock hold as the merge, as the local landing does.
    if worktree::current_branch(repo).as_deref() != Some(rec.target.as_str()) {
        return other(format!("The main checkout is not on {} any more, so nothing was merged. The commits are safe on the other machine: switch back, then merge again.", rec.target));
    }
    let top = worktree::run(repo, &["rev-parse", "--show-toplevel"]).out.trim().to_string();
    let target_ref = format!("refs/heads/{}", rec.target);
    let changed = worktree::run(repo, &["-c", "core.quotepath=false", "diff", "--name-only", &target_ref, branch]).lines();
    let dirty = crate::daemon::subchats::git::dirty_keys(repo).unwrap_or_default();
    let overlap: Vec<String> =
        changed.into_iter().filter(|name| dirty.contains(&crate::daemon::subchats::git::path_key(&format!("{top}/{name}")))).collect();
    if !overlap.is_empty() {
        return Step::Refused(refused(
            "Not merged",
            "The main checkout has uncommitted changes in files this sub also changed, so the merge was refused and nothing there was touched. It stays pending and merges by itself once those files are committed. Its commits are safe on its branch on the other machine.".to_string(),
            overlap,
            Cause::DirtyOverlap,
        ));
    }
    // `--no-overwrite-ignore` for the reason the local landing has it: an ignored local
    // file (a `.env`) the sub committed with `add -f` is never written over.
    let merged = worktree::run(repo, &["merge", "--ff-only", "--no-overwrite-ignore", "-q", branch]);
    if merged.ok {
        return Step::Landed;
    }
    if !worktree::is_ancestor(repo, &target_ref, branch) {
        return Step::Moved;
    }
    other(format!("git refused to fast-forward {}: {}. Nothing was changed there, and the sub's commits are safe on the other machine.", rec.target, worktree::short(&merged.err, 300)))
}

/// The verdict of a refusal that only says the other machine could not be reached: a
/// merge that was pending on dirty files stays pending for the tick.
pub const UNREACHABLE: &str = "Not merged (unreachable)";

fn unreachable(label: &str, e: &PeerError) -> Landing {
    refused(
        UNREACHABLE,
        format!("{label} could not be reached ({e}), so the commits could not be fetched. They are safe on its branch there: merge again once it is back."),
        Vec::new(),
        Cause::Other,
    )
}

async fn call(client: &crate::daemon::machines::PeerClient, method: &str, params: Value) -> Result<Value, PeerError> {
    client.call_with_timeout(method, params, BUNDLE_CALL).await
}

/// Lands `rec`'s commits in the checkout of its main chat. Blocking work runs on the
/// blocking pool; the host calls are awaited.
pub async fn land(state: &Arc<DaemonState>, rec: &RemoteSub) -> Landing {
    if !lands(rec) {
        return Landing::Nothing;
    }
    let Some(peer) = state.machines.get().and_then(|r| r.peer(&rec.machine_id)) else {
        return refused("Not merged", "The machine that hosts this sub is not paired any more, so its commits could not be fetched.".to_string(), Vec::new(), Cause::Other);
    };
    let client = match client_for(state, &peer).await {
        Ok(c) => c,
        Err(e) => return unreachable(&peer.label, &e),
    };
    for attempt in 0..2 {
        let r = rec.clone();
        let offered = match tokio::task::spawn_blocking(move || offer(&r)).await {
            Ok(Ok(o)) => o,
            Ok(Err(landing)) => return landing,
            Err(e) => return refused("Not merged", format!("The merge did not run: {e}"), Vec::new(), Cause::Other),
        };
        let updated = match call(&client, "sub_update_branch", json!({ "sub_id": rec.sub_id, "target_tip": offered.tip, "bundle": offered.bundle })).await {
            Ok(v) => v,
            Err(PeerError::Rejected { message, .. }) => {
                return refused("Not merged", format!("{} would not bring the sub's branch up to date: {}", peer.label, crate::util::text::flat_clip(&message, 300)), Vec::new(), Cause::Other)
            }
            Err(e) => return unreachable(&peer.label, &e),
        };
        let files: Vec<String> = updated["files"]
            .as_array()
            .map(|a| a.iter().filter_map(|f| f.as_str()).map(|f| crate::util::text::flat_clip(f, 200)).filter(|f| !f.is_empty()).take(20).collect())
            .unwrap_or_default();
        match updated["status"].as_str() {
            Some("done") => {}
            Some("conflict") => {
                return refused(
                    "Merge conflict",
                    format!("Its commits conflict with {t}. Nothing was merged, and the commits are safe on its branch on {l}. The sub has to bring its branch up to date with {t}, resolve the conflict in these files, commit, and finish again.", t = rec.target, l = peer.label),
                    files,
                    Cause::Conflict,
                );
            }
            _ => {
                let why = updated["why"].as_str().unwrap_or("it did not say why");
                return refused("Not merged", format!("Its branch could not be brought up to date with {}: {}. Nothing was merged and the commits are safe on {}.", rec.target, crate::util::text::flat_clip(why, 300), peer.label), Vec::new(), Cause::Other);
            }
        }
        if updated["ahead"].as_u64() == Some(0) {
            return Landing::Nothing;
        }
        let fetched = match call(&client, "sub_fetch_branch", json!({ "sub_id": rec.sub_id, "exclude": offered.tip })).await {
            Ok(v) => v,
            Err(PeerError::Rejected { message, .. }) => {
                return refused("Not merged", format!("{} would not hand over the sub's branch: {}", peer.label, crate::util::text::flat_clip(&message, 300)), Vec::new(), Cause::Other)
            }
            Err(e) => return unreachable(&peer.label, &e),
        };
        let (head, bundle) = (fetched["head"].as_str().unwrap_or_default().to_string(), fetched["bundle"].as_str().unwrap_or_default().to_string());
        let (r, tip) = (rec.clone(), offered.tip.clone());
        match tokio::task::spawn_blocking(move || merge_fetched(&r, &tip, &head, &bundle)).await {
            Ok(Step::Landed) => {
                let merged = fetched["head"].as_str().unwrap_or_default();
                if let Err(e) = outbox::enqueue(&rec.machine_id, "sub_cleanup", json!({ "sub_id": rec.sub_id, "merged_head": merged })) {
                    log::warn!("subchats: could not queue the tree cleanup of {} for {}: {e}", rec.sub_id, rec.machine_id);
                }
                outbox::flush_in_background(state);
                return Landing::Merged;
            }
            Ok(Step::Moved) if attempt == 0 => continue,
            Ok(Step::Moved) => {
                return refused("Not merged", format!("{} kept moving while the merge ran. Merge again.", rec.target), Vec::new(), Cause::Other);
            }
            Ok(Step::Refused(landing)) => return landing,
            Err(e) => return refused("Not merged", format!("The merge did not run: {e}"), Vec::new(), Cause::Other),
        }
    }
    refused("Not merged", format!("{} kept moving while the merge ran. Merge again.", rec.target), Vec::new(), Cause::Other)
}

/// [`land`], then what a local landing does with its result: a refusal is handed to
/// the follow-up (pending on disk, or the main chat woken), a landing clears it.
pub async fn land_and_report(state: &Arc<DaemonState>, rec: &RemoteSub) -> Landing {
    let landing = land(state, rec).await;
    match &landing {
        Landing::Blocked(b) => merge_followup::on_blocked_remote(state, rec, b),
        _ => merge_followup::on_landed(state, &rec.sub_id),
    }
    landing
}

/// `subchat merge` for a remote sub: the same landing, with a refusal as the call's
/// result rather than a wake.
pub async fn merge_now(state: &Arc<DaemonState>, rec: &RemoteSub) -> Result<String, String> {
    let name = if rec.name.trim().is_empty() { rec.sub_id.chars().take(8).collect() } else { rec.name.trim().to_string() };
    if rec.state != super::records::RemoteState::Finished {
        return Err(format!("{name} has not finished: it merges by itself when it finishes."));
    }
    if !lands(rec) {
        return Err(format!("{name} has no commits of its own to merge: it ran in the project folder as it was."));
    }
    let _quiet = crate::daemon::subchats::plumbing::quiet(&rec.sub_id);
    let landing = land_and_report(state, rec).await;
    match landing {
        Landing::Merged => {
            crate::daemon::subchats::held::on_target_done(state);
            Ok(format!("{name}'s commits are now in {}.", rec.target))
        }
        Landing::Nothing => {
            crate::daemon::subchats::held::on_target_done(state);
            Ok(format!("{name}'s branch has nothing {} lacks, so there was nothing to merge.", rec.target))
        }
        Landing::Blocked(b) => {
            let files = if b.points.is_empty() { String::new() } else { format!(" Files: {}.", b.points.join(", ")) };
            Err(format!("Not merged: {}{files}", b.text))
        }
    }
}

/// Whether any of `files` (paths from the repo's top) is dirty in the checkout `rec`
/// merges into. A git failure counts as dirty: nothing is merged on a guess.
pub fn still_dirty(rec: &RemoteSub, files: &[String]) -> bool {
    let repo: PathBuf = rec.repo.clone();
    let Some((true, top)) = crate::daemon::subchats::git::run_git(&repo, &["rev-parse", "--show-toplevel"]) else { return true };
    let top = String::from_utf8_lossy(&top).trim().to_string();
    let Some(dirty) = crate::daemon::subchats::git::dirty_keys(&repo) else { return true };
    files.iter().any(|f| dirty.contains(&crate::daemon::subchats::git::path_key(&format!("{top}/{f}"))))
}

#[cfg(test)]
#[path = "land_tests.rs"]
mod tests;
