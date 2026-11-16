//! The host half of landing a visiting sub's commits on its home
//! (`docs/cross-machine-subchats.md`, "Wire": `sub_update_branch`,
//! `sub_fetch_branch`, `sub_cleanup`).
//!
//! The home decides and merges; the host only moves its own clone. The home sends
//! the tip of its target branch (and the commits this clone lacks, as a bundle), the
//! host brings the sub's branch up to date with it by the same rebase a local sub
//! gets, and the home then asks for the sub's branch as a bundle that excludes that
//! tip, so a commit that exists only in this clone's other branches never rides
//! back. Once the home has merged, it names the head it merged and the host removes
//! the sub's tree.
//!
//! Every call is machine-only (`M`), and the machine is `ctx.transport`'s: a call
//! acts on a sub only when the sub's stored `home.machine_id` is the caller, so a
//! peer cannot move, read or remove the tree of a sub another machine started.

use super::git_sync;
use crate::daemon::rpc::{ConnectionContext, Router, RpcError};
use crate::daemon::state::DaemonState;
use crate::daemon::subchats::{worktree, WorktreeInfo};
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Arc;

/// Registers the three methods.
pub fn register(router: &mut Router, state: Arc<DaemonState>) {
    router.register("sub_update_branch", {
        let state = state.clone();
        move |params, ctx| {
            let state = state.clone();
            async move { update(&state, &ctx, decode(params)?).await }
        }
    });
    router.register("sub_fetch_branch", {
        let state = state.clone();
        move |params, ctx| {
            let state = state.clone();
            async move { fetch(&state, &ctx, decode(params)?).await }
        }
    });
    router.register("sub_cleanup", move |params, ctx| {
        let state = state.clone();
        async move { cleanup(&state, &ctx, decode(params)?).await }
    });
}

fn decode<T: for<'de> Deserialize<'de>>(params: Option<Value>) -> Result<T, RpcError> {
    serde_json::from_value(params.unwrap_or(Value::Null)).map_err(|e| RpcError::invalid_params(e.to_string()))
}

/// The tree of the sub `sub_id` names, when it is a visiting sub of the calling
/// machine's and has a worktree here. Everything else is one refusal, so a peer
/// learns nothing about a sub that is not its own.
fn own_tree(ctx: &ConnectionContext, method: &str, sub_id: &str) -> Result<WorktreeInfo, RpcError> {
    let from = super::host::peer_of(ctx, method)?;
    let refuse = || RpcError::invalid_params("no sub of a chat on your machine has that id here");
    if uuid::Uuid::parse_str(sub_id).is_err() {
        return Err(refuse());
    }
    let brief = crate::sessions::chat_config::get(sub_id).and_then(|c| c.subchat).ok_or_else(refuse)?;
    if brief.home.as_ref().map(|h| h.machine_id.as_str()) != Some(from.as_str()) {
        return Err(refuse());
    }
    brief.worktree_at.ok_or_else(|| RpcError::invalid_params("that sub has no worktree here, so it has no commits to land"))
}

/// A merge starts, and the tree goes, only after the sub finished, as a local one
/// does: a sub still working owns its tree. A sub with no live row (the daemon
/// restarted since it ended) counts as ended when its finish record is on disk: a
/// running sub is always in the registry, so a missing row plus a record means the
/// sub is not running.
fn require_finished(state: &DaemonState, sub_id: &str) -> Result<(), RpcError> {
    match state.registry.get(sub_id) {
        Some(i) if i.subchat_finished && !i.busy => Ok(()),
        Some(_) => Err(RpcError::invalid_params("that sub is still working")),
        None if crate::daemon::subchats::finish::read_record(sub_id).is_some() => Ok(()),
        None => Err(RpcError::invalid_params("no sub of a chat on your machine has that id here")),
    }
}

fn blocking_error(e: tokio::task::JoinError) -> RpcError {
    RpcError::internal(e.to_string())
}

#[derive(Debug, Deserialize)]
pub(super) struct UpdateParams {
    pub(super) sub_id: String,
    /// The tip of the target branch on the home.
    pub(super) target_tip: String,
    /// The commits of that tip this clone lacks, base64; absent when it has them all.
    #[serde(default)]
    pub(super) bundle: Option<String>,
}

async fn update(state: &Arc<DaemonState>, ctx: &ConnectionContext, req: UpdateParams) -> Result<Value, RpcError> {
    let info = own_tree(ctx, "sub_update_branch", &req.sub_id)?;
    require_finished(state, &req.sub_id)?;
    if !git_sync::is_commit_id(&req.target_tip) {
        return Err(RpcError::invalid_params("target_tip is not a full commit id"));
    }
    let out = tokio::task::spawn_blocking(move || update_blocking(&req, &info)).await.map_err(blocking_error)?;
    out.map_err(RpcError::invalid_params)
}

/// Moves the sub's private view of the home's target to the tip it was given
/// (importing the bundle first when it came with one) and rebases the sub's branch
/// onto it. The scratch ref is removed whatever happens.
pub(super) fn update_blocking(req: &UpdateParams, info: &WorktreeInfo) -> Result<Value, String> {
    let repo = PathBuf::from(&info.repo);
    let lock = worktree::repo_lock(&repo);
    let _held = lock.lock().unwrap_or_else(|p| p.into_inner());
    let target_ref = format!("refs/cc-sub/{}/target", req.sub_id);
    let next = format!("refs/cc-sub/{}/target-next", req.sub_id);
    let result = (|| {
        match req.bundle.as_deref().filter(|b| !b.is_empty()) {
            Some(text) => {
                let head = git_sync::import_bundle(&repo, &git_sync::decode(text)?, &next)?;
                if head != req.target_tip {
                    return Err("the bundle's head is not the target tip named".to_string());
                }
            }
            None => git_sync::pin_commit(&repo, &next, &req.target_tip)
                .map_err(|e| format!("this clone does not have the target tip and was sent no bundle for it: {e}"))?,
        }
        // The tip came from this call alone: the ref it moves is the sub's own.
        crate::daemon::subchats::git::run_git(&repo, &["update-ref", &target_ref, &req.target_tip])
            .filter(|(ok, _)| *ok)
            .ok_or("could not move the sub's view of the target")?;
        Ok(())
    })();
    git_sync::delete_ref(&repo, &next);
    result?;
    let moved = worktree::update_onto_ref(&req.sub_id, info, &target_ref);
    Ok(json!({ "ok": true, "status": moved.status, "files": moved.files, "why": moved.why, "head": moved.head, "ahead": moved.ahead }))
}

#[derive(Debug, Deserialize)]
struct FetchParams {
    sub_id: String,
    /// The target tip the home sent last, which the home has and the bundle leaves out.
    exclude: String,
}

async fn fetch(state: &Arc<DaemonState>, ctx: &ConnectionContext, req: FetchParams) -> Result<Value, RpcError> {
    let info = own_tree(ctx, "sub_fetch_branch", &req.sub_id)?;
    require_finished(state, &req.sub_id)?;
    if !git_sync::is_commit_id(&req.exclude) {
        return Err(RpcError::invalid_params("exclude is not a full commit id"));
    }
    let out = tokio::task::spawn_blocking(move || -> Result<Value, String> {
        let repo = PathBuf::from(&info.repo);
        let lock = worktree::repo_lock(&repo);
        let _held = lock.lock().unwrap_or_else(|p| p.into_inner());
        let head = git_sync::resolve_commit(&repo, &format!("refs/heads/{}", info.branch)).ok_or("the sub's branch is gone")?;
        let bundle = git_sync::make_bundle(&repo, &head, Some(&req.exclude))?;
        Ok(json!({ "ok": true, "head": head, "bundle": git_sync::encode(&bundle) }))
    })
    .await
    .map_err(blocking_error)?;
    out.map_err(RpcError::invalid_params)
}

#[derive(Debug, Deserialize)]
struct CleanupParams {
    sub_id: String,
    /// The head of the sub's branch the home merged.
    merged_head: String,
}

async fn cleanup(state: &Arc<DaemonState>, ctx: &ConnectionContext, req: CleanupParams) -> Result<Value, RpcError> {
    let info = own_tree(ctx, "sub_cleanup", &req.sub_id)?;
    if !git_sync::is_commit_id(&req.merged_head) {
        return Err(RpcError::invalid_params("merged_head is not a full commit id"));
    }
    // A sub still working owns its tree, whatever head the home names.
    require_finished(state, &req.sub_id)?;
    let removed = tokio::task::spawn_blocking(move || -> Result<bool, String> {
        let repo = PathBuf::from(&info.repo);
        let head = git_sync::resolve_commit(&repo, &format!("refs/heads/{}", info.branch));
        // The tree goes only when what the home merged is everything the branch holds.
        if head.as_deref().is_some_and(|h| h != req.merged_head) {
            return Err("the sub's branch holds commits the home did not merge, so its tree stays".to_string());
        }
        // Takes the repo lock itself.
        let done = worktree::remove_landed(&req.sub_id, &info, &req.merged_head);
        if done {
            git_sync::delete_ref(&repo, &format!("refs/cc-sub/{}/target", req.sub_id));
        }
        Ok(done)
    })
    .await
    .map_err(blocking_error)?;
    removed.map(|done| json!({ "ok": true, "removed": done })).map_err(RpcError::invalid_params)
}

#[cfg(test)]
#[path = "host_land_tests.rs"]
mod tests;
