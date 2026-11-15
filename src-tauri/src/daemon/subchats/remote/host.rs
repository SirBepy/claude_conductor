//! The host half of a sub spawned from a main chat on a paired machine
//! (`docs/cross-machine-subchats.md`, "Wire"): `sub_git_have` and `sub_spawn`.
//!
//! The home asks which of its commits this clone already has, ships a bundle of
//! the rest (a writing sub only), and then asks for the sub. Here the sub gets its
//! own worktree at the home's commit, a row (`subchat_of` the home's main chat, a
//! chat that is not in this registry), a brief whose [`HomeRef`] names the home
//! machine from the transport of the call, and a launch through the same held
//! launch every worktree sub uses. Both methods are machine-only (`M`): the caller
//! is `ctx.transport`'s machine, never anything a payload says.
//!
//! A read-only sub runs in the matched project folder itself, as a local one does,
//! so it needs no commits shipped.

use super::{git_sync, project_match};
use crate::daemon::rpc::{ConnectionContext, Router, RpcError, Transport};
use crate::daemon::state::DaemonState;
use crate::daemon::subchats::spawn::SubPlan;
use crate::daemon::subchats::{held, worktree, HomeRef, SubchatBrief};
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// Longest first message a peer may hand a sub. A brief and its extra context fit
/// far inside it; it only stops a peer filling the chat-config with megabytes.
const MAX_FIRST_MESSAGE: usize = 200_000;
const MAX_NAME: usize = 200;
const MAX_ID: usize = 100;

/// How a registered sub is started: production runs the held launch in the
/// background (a bootstrap script can take minutes, and the home's call must not
/// wait on it); a test passes one that starts no `claude`.
pub type Starter = Arc<dyn Fn(&Arc<DaemonState>, &str) + Send + Sync>;

fn production_starter() -> Starter {
    Arc::new(|state, sub_id| {
        let Ok(handle) = tokio::runtime::Handle::try_current() else { return };
        let (state, sub_id) = (state.clone(), sub_id.to_string());
        handle.spawn(async move { crate::daemon::subchats::writers::run_start(&state, crate::daemon::subchats::writers::Start::Launch { sub_id }).await });
    })
}

/// Registers the two methods with the production starter.
pub fn register(router: &mut Router, state: Arc<DaemonState>) {
    register_with(router, state, production_starter());
}

/// [`register`] with the way a sub is started passed in.
pub fn register_with(router: &mut Router, state: Arc<DaemonState>, start: Starter) {
    router.register("sub_git_have", {
        let state = state.clone();
        move |params, ctx| {
            let state = state.clone();
            async move {
                let req: HaveParams = decode(params)?;
                have(&state, &ctx, req).await
            }
        }
    });
    router.register("sub_spawn", move |params, ctx| {
        let (state, start) = (state.clone(), start.clone());
        async move {
            let req: SubSpawn = decode(params)?;
            spawn(&state, &start, &ctx, req).await
        }
    });
}

fn decode<T: for<'de> Deserialize<'de>>(params: Option<Value>) -> Result<T, RpcError> {
    serde_json::from_value(params.unwrap_or(Value::Null)).map_err(|e| RpcError::invalid_params(e.to_string()))
}

/// The caller's machine, from the transport. A phone, the desktop pipe or anything
/// else is refused.
fn peer_of(ctx: &ConnectionContext, method: &str) -> Result<String, RpcError> {
    match &ctx.transport {
        Transport::PeerMachine(id) => Ok(id.clone()),
        _ => Err(RpcError::invalid_params(format!("{method} is only callable by a peer machine"))),
    }
}

/// Which folder on this machine a sub's repository is.
#[derive(Debug, Default, Deserialize)]
pub struct RepoSel {
    /// The home's normalised origin URL (`project_match::origin_of`, never the raw
    /// URL, which can carry a token).
    #[serde(default)]
    pub origin: Option<String>,
    /// A folder on this machine the main chat named after the origin match failed.
    #[serde(default)]
    pub machine_cwd: Option<String>,
}

#[derive(Debug, Deserialize)]
struct HaveParams {
    repo: RepoSel,
    #[serde(default)]
    candidates: Vec<String>,
}

/// What this machine calls itself, for the refusal texts a main chat reads.
fn own_label(state: &DaemonState) -> String {
    state.machines.get().and_then(|r| r.self_machine()).map(|m| m.label).filter(|l| !l.trim().is_empty()).unwrap_or_else(|| "that machine".to_string())
}

/// The project folder `sel` names, or why not. A refusal says what this machine
/// has, so the main chat can ask Joe which folder it is.
pub fn resolve_repo(state: &DaemonState, sel: &RepoSel) -> Result<PathBuf, String> {
    let projects = state.settings.snapshot().projects;
    let label = own_label(state);
    if let Some(cwd) = sel.machine_cwd.as_deref().map(str::trim).filter(|c| !c.is_empty()) {
        // Only a registered project, like a plain `spawn_chat` from a peer: `claude`
        // runs with this folder, so an unchecked one would let a peer pick any readable path.
        return crate::daemon::methods::spawn_chat::known_project_root(Path::new(cwd), &projects)
            .ok_or_else(|| format!("{cwd} is not a registered project on {label}; {}", project_list(&projects, &label)));
    }
    // Already the home's normalised form (the wire carries `origin_of`, never the raw URL),
    // which `match_projects` compares the projects' own normalised origins against.
    let Some(want) = sel.origin.as_deref().map(str::trim).filter(|o| !o.is_empty()) else {
        return Err(format!(
            "the main chat's project has no git origin to match a project on {label} by. Ask Joe which folder on {label} it is, then call spawn_chat again with machine_cwd set to it; {}",
            project_list(&projects, &label)
        ));
    };
    let candidates: Vec<(PathBuf, Option<String>)> = projects.iter().map(|p| (p.path.clone(), project_match::origin_url(&p.path))).collect();
    match project_match::match_projects(&want, &candidates) {
        project_match::Match::One(path) => Ok(path),
        project_match::Match::None => Err(format!(
            "No project on {label} has the git origin {want}. Ask Joe which folder on {label} it is (or to set the project up there first), then call spawn_chat again with machine_cwd set to that folder; {}",
            project_list(&projects, &label)
        )),
        project_match::Match::Many(found) => Err(format!(
            "More than one project on {label} has the git origin {want}: {}. Ask Joe which one it is, then call spawn_chat again with machine_cwd set to its folder.",
            found.iter().map(|p| p.display().to_string()).collect::<Vec<_>>().join(", ")
        )),
    }
}

fn project_list(projects: &[crate::types::ProjectConfig], label: &str) -> String {
    if projects.is_empty() {
        return format!("{label} has no projects registered.");
    }
    format!("the projects registered on {label} are {}.", projects.iter().map(|p| format!("{} ({})", p.name, p.path.display())).collect::<Vec<_>>().join(", "))
}

async fn have(state: &Arc<DaemonState>, ctx: &ConnectionContext, req: HaveParams) -> Result<Value, RpcError> {
    peer_of(ctx, "sub_git_have")?;
    let repo = resolve_blocking(state, req.repo).await.map_err(RpcError::invalid_params)?;
    let found = tokio::task::spawn_blocking(move || git_sync::first_have(&repo, &req.candidates))
        .await
        .map_err(|e| RpcError::internal(e.to_string()))?;
    Ok(json!({ "ok": true, "have": found }))
}

#[derive(Debug, Deserialize)]
struct SubSpawn {
    /// Minted by the home, so its records and this machine's row share one id.
    sub_id: String,
    /// The main chat on the home; never in this machine's registry.
    main_id: String,
    #[serde(default)]
    name: String,
    repo: RepoSel,
    /// The home commit a writing sub's tree starts from and the branch its commits
    /// merge into there. Both are required for a writing sub, unused otherwise.
    #[serde(default)]
    base: String,
    #[serde(default)]
    target: String,
    /// The commits this clone lacks, base64 (`git_sync::encode`); absent when it
    /// already has `base`.
    #[serde(default)]
    bundle: Option<String>,
    brief: SubchatBrief,
    first_message: String,
    model: String,
    effort: String,
    /// Register the sub without starting it (an `after` chain): the home starts it later.
    #[serde(default)]
    hold: bool,
}

/// A conservative branch name: it only reaches a system prompt and the facts, but
/// it comes from another machine.
fn plain_ref_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 200
        && name.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'/' | b'-'))
        // What git itself refuses in a branch name, and what could read as an option.
        && !name.starts_with(['-', '/', '.'])
        && !name.ends_with(['/', '.'])
        && !name.contains("..")
        && !name.contains("//")
        && !name.ends_with(".lock")
}

/// The longest stored brief a peer may hand over, all its text fields together.
const MAX_BRIEF_BYTES: usize = 100_000;

/// Sub ids being spawned right now, so a second call for the same id cannot race
/// the first one's existence check (the loser's cleanup would take the winner's ref).
static IN_FLIGHT: std::sync::Mutex<Option<std::collections::HashSet<String>>> = std::sync::Mutex::new(None);

struct InFlight(String);

impl InFlight {
    fn claim(sub_id: &str) -> Option<InFlight> {
        let mut guard = IN_FLIGHT.lock().unwrap_or_else(|e| e.into_inner());
        guard.get_or_insert_with(Default::default).insert(sub_id.to_string()).then(|| InFlight(sub_id.to_string()))
    }
}

impl Drop for InFlight {
    fn drop(&mut self) {
        if let Some(set) = IN_FLIGHT.lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
            set.remove(&self.0);
        }
    }
}

/// [`resolve_repo`] off the async worker: it runs a git process per registered project.
async fn resolve_blocking(state: &Arc<DaemonState>, sel: RepoSel) -> Result<PathBuf, String> {
    let state = state.clone();
    tokio::task::spawn_blocking(move || resolve_repo(&state, &sel)).await.map_err(|e| e.to_string())?
}

fn plain_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= MAX_ID && id.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-' | b':'))
}

fn validate(req: &SubSpawn) -> Result<(String, String), String> {
    if uuid::Uuid::parse_str(&req.sub_id).is_err() {
        return Err("sub_id is not a session id".to_string());
    }
    if !plain_id(&req.main_id) {
        return Err("main_id is not a chat id".to_string());
    }
    if req.brief.gate {
        return Err("A gate sub always runs on the machine its main chat is on: it pushes from that checkout.".to_string());
    }
    if req.first_message.trim().is_empty() || req.first_message.len() > MAX_FIRST_MESSAGE {
        return Err("first_message must be the sub's brief, not empty and not over 200000 bytes".to_string());
    }
    if req.name.len() > MAX_NAME {
        return Err("name is too long".to_string());
    }
    if req.brief.writes {
        if !git_sync::is_commit_id(&req.base) {
            return Err("a writing sub needs base, the full id of the commit its tree starts from".to_string());
        }
        if !plain_ref_name(&req.target) {
            return Err("a writing sub needs target, the name of the branch its commits merge into on its main chat's machine".to_string());
        }
    }
    // The tier rules are the home's, but a peer's call is not trusted to have applied them.
    crate::daemon::subchats::spawn::resolve_tier(Some(&req.model), Some(&req.effort), req.brief.writes)
}

/// What is made on disk for a spawn, so a failure later can take it back.
struct Made {
    repo: PathBuf,
    import_ref: Option<String>,
    tree: Option<crate::daemon::subchats::WorktreeInfo>,
}

impl Made {
    fn undo(self) {
        if let Some(info) = &self.tree {
            worktree::discard(info);
        }
        if let Some(name) = &self.import_ref {
            git_sync::delete_ref(&self.repo, name);
        }
    }
}

async fn spawn(state: &Arc<DaemonState>, start: &Starter, ctx: &ConnectionContext, req: SubSpawn) -> Result<Value, RpcError> {
    let from = peer_of(ctx, "sub_spawn")?;
    let (model, effort) = validate(&req).map_err(RpcError::invalid_params)?;
    // The home's main chat is never a chat of this machine: a peer that names one of
    // ours would make its sub part of that chat's family (its cap, its wakes, its sends).
    if state.registry.get(&req.main_id).is_some() {
        return Err(RpcError::invalid_params("main_id names a chat on this machine, not on the machine that sent the call"));
    }
    if serde_json::to_string(&req.brief).map_or(true, |b| b.len() > MAX_BRIEF_BYTES) {
        return Err(RpcError::invalid_params("the brief is over 100000 bytes"));
    }
    let Some(_in_flight) = InFlight::claim(&req.sub_id) else {
        return Err(RpcError::invalid_params(format!("{} is already being spawned", req.sub_id)));
    };
    if state.registry.get(&req.sub_id).is_some() || crate::sessions::chat_config::get(&req.sub_id).is_some() {
        return Err(RpcError::invalid_params(format!("{} already exists on this machine", req.sub_id)));
    }
    let repo = resolve_blocking(state, req.repo).await.map_err(RpcError::invalid_params)?;
    // A rolling cap on chats started by chats, like a local `spawn_chat`: a loop on
    // the other machine must not start subs here without end.
    if let Err(refused) = crate::daemon::spawn_rate::admit("sub_spawn") {
        return Err(RpcError::invalid_params(refused.text));
    }
    let job = TreeJob {
        repo: repo.clone(),
        sub_id: req.sub_id.clone(),
        writes: req.brief.writes,
        base: req.base.clone(),
        target: req.target.clone(),
        bundle: req.bundle.clone(),
    };
    let (made, prepared) = tokio::task::spawn_blocking(move || make_tree(job))
        .await
        .map_err(|e| RpcError::internal(e.to_string()))?
        .map_err(RpcError::invalid_params)?;
    let cwd = prepared.as_ref().map(|p| PathBuf::from(&p.info.cwd)).unwrap_or_else(|| repo.clone());

    let mut brief = req.brief;
    brief.parent = req.main_id.clone();
    brief.home = Some(HomeRef { machine_id: from.clone(), main_id: req.main_id.clone() });
    brief.worktree_at = prepared.as_ref().map(|p| p.info.clone());
    brief.git_head_at_spawn = None;
    brief.upstream_at_spawn = None;
    let mut first_message = req.first_message;
    if let Some(p) = &prepared {
        first_message.push_str(&worktree::first_message_note(p));
    }
    let reason = if prepared.is_some() { worktree::SETUP_TEXT } else { "starting" };
    let mut plan = SubPlan::visiting(req.main_id.clone(), brief, first_message.clone(), model.clone(), effort.clone());
    let spec = held::LaunchSpec { cwd, model, effort, account_id: None, first_message };
    let name = Some(req.name.trim()).filter(|n| !n.is_empty());
    let registered = held::register_held_row(
        state,
        &req.main_id,
        name,
        &crate::sessions::chat_config::ChatConfig::default(),
        spec,
        &mut plan,
        req.sub_id.clone(),
        reason.to_string(),
        None,
    );
    if let Err(e) = registered {
        // The row and brief may exist already (the failure can be the hold's store).
        if state.registry.get(&req.sub_id).is_some() {
            held::drop_held(state, &req.sub_id);
            crate::sessions::chat_config::set_subchat(&req.sub_id, None);
        }
        made.undo();
        return Err(RpcError::invalid_params(e));
    }
    // So `peer_scope` lets the home drive it, as for any chat a peer starts.
    crate::sessions::chat_config::set_started_by_machine(&req.sub_id, &from);
    if !req.hold {
        start(state, &req.sub_id);
    }
    log::info!("subchats: sub {} from {from} registered on {}{}", req.sub_id, repo.display(), if req.hold { " (held)" } else { "" });
    let mut out = json!({ "ok": true, "session_id": req.sub_id, "held": req.hold });
    if let Some(p) = &prepared {
        out["branch"] = json!(p.info.branch);
    }
    Ok(out)
}

struct TreeJob {
    repo: PathBuf,
    sub_id: String,
    writes: bool,
    base: String,
    target: String,
    bundle: Option<String>,
}

/// Everything a writing sub needs on disk: the base commit in this clone (imported
/// from the bundle, or pinned when this clone already has it) under
/// `refs/cc-sub/<id>/target` and the worktree at it. A read-only sub needs none.
fn make_tree(job: TreeJob) -> Result<(Made, Option<worktree::Prepared>), String> {
    let TreeJob { repo, sub_id, writes, base, target, bundle } = job;
    let mut made = Made { repo: repo.clone(), import_ref: None, tree: None };
    if !writes {
        return Ok((made, None));
    }
    let import_ref = format!("refs/cc-sub/{sub_id}/target");
    match bundle.as_deref().filter(|b| !b.is_empty()) {
        Some(text) => {
            let bytes = git_sync::decode(text)?;
            let head = git_sync::import_bundle(&repo, &bytes, &import_ref)?;
            made.import_ref = Some(import_ref.clone());
            if head != base {
                made.undo();
                return Err("the bundle's head is not the base commit named".to_string());
            }
        }
        None => {
            git_sync::pin_commit(&repo, &import_ref, &base).map_err(|e| {
                format!("this clone does not have the commit {} and was sent none: {e}. Fetch the project on this machine first.", &base[..12.min(base.len())])
            })?;
            made.import_ref = Some(import_ref);
        }
    }
    match worktree::prepare_at(&repo, &sub_id, &base, &target) {
        Ok(worktree::Prepare::Ready(p)) => {
            made.tree = Some(p.info.clone());
            Ok((made, Some(p)))
        }
        Ok(worktree::Prepare::Unusable(why)) => {
            made.undo();
            Err(format!("A writing sub needs its own worktree on this machine, and this folder cannot have one: {why}"))
        }
        Err(e) => {
            made.undo();
            Err(e)
        }
    }
}

/// Daemon start, host side: clears the scratch refs and bundle files a crash can
/// leave in every repo a visiting sub works in. The home keeps a record of the
/// repos it ships bundles from (`records::sweep_at_start`); this machine has none,
/// so it reads them off the stored briefs that carry a `home`.
pub fn sweep_at_start() {
    for repo in visiting_repos() {
        if repo.is_dir() {
            git_sync::sweep_leftovers(&repo);
        }
    }
}

/// The distinct repo folders the visiting subs' worktrees belong to.
fn visiting_repos() -> Vec<PathBuf> {
    let mut repos: Vec<PathBuf> = Vec::new();
    for brief in crate::sessions::chat_config::sub_briefs().into_iter().map(|(_, b)| b).filter(|b| b.home.is_some()) {
        if let Some(info) = brief.worktree_at.filter(|i| !i.repo.is_empty()) {
            let repo = PathBuf::from(info.repo);
            if !repos.contains(&repo) {
                repos.push(repo);
            }
        }
    }
    repos
}

#[cfg(test)]
#[path = "host_tests.rs"]
mod tests;
