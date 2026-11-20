//! The home half of a sub spawned on a paired machine: a subchats-mode
//! `spawn_chat` that names a `machine` (`docs/cross-machine-subchats.md`, step 2).
//!
//! The brief, tier, name and cap checks are the local ones (`spawn::plan_remote`,
//! the cap counting the family on every machine). A writing sub then needs its
//! commits over there: the base and target come from this checkout, the host says
//! which of this checkout's commits it already has (`sub_git_have`), and only the
//! rest rides along as a bundle with `sub_spawn`. The remote-subs record is
//! written before the call, so an event from the host can never arrive for a sub
//! this machine has not heard of.

use super::records::{self, RemoteState, RemoteSub};
use super::{git_sync, project_match};
use crate::daemon::machines::{client_for, PeerError, PeerMachine};
use crate::daemon::state::DaemonState;
use crate::daemon::subchats::{git, spawn, SubchatArgs};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

/// A call that carries a bundle can be tens of megabytes over a slow tunnel.
const BUNDLE_CALL: Duration = Duration::from_secs(120);

/// Everything `spawn_remote` needs from the caller's own call.
pub struct Request<'a> {
    pub caller: &'a str,
    pub cwd: &'a str,
    pub prompt: Option<&'a str>,
    pub model: Option<&'a str>,
    pub effort: Option<&'a str>,
    pub name: Option<&'a str>,
    pub args: &'a SubchatArgs,
}

/// How a remote spawn ended, for a caller that can fall back to a local one.
pub enum Outcome {
    /// Not a sub spawn (mode off, `plain`, unknown caller): the plain-chat path applies.
    NotASub,
    /// The sub is on the host, or the refusal is the answer.
    Done(Value),
    /// Nothing started on the host and no record is left: running the sub here is safe.
    Failed(Value),
}

/// A failed spawn: its text, and whether the host may have started the sub anyway (the link
/// dropped mid-call), which a fallback to a local spawn must never risk duplicating.
struct Fail {
    text: String,
    may_have_started: bool,
}

impl From<String> for Fail {
    fn from(text: String) -> Self {
        Fail { text, may_have_started: false }
    }
}

/// A mode-on `spawn_chat` with `machine`: plans the sub here, ships the commits
/// and starts it on `peer`. Returns the tool's body. `None` when this call is not
/// a sub spawn (mode off, `plain`, unknown caller), which the caller handles as the
/// plain-chat forward it always was.
pub async fn spawn_remote(state: &Arc<DaemonState>, peer: &PeerMachine, req: Request<'_>, accounts: &[crate::accounts::Account]) -> Option<Value> {
    match spawn_remote_outcome(state, peer, req, false, accounts).await {
        Outcome::NotASub => None,
        Outcome::Done(body) | Outcome::Failed(body) => Some(body),
    }
}

/// [`spawn_remote`] that tells a failure that left nothing behind from an answer. `scratch`
/// runs the sub in an empty scratch folder on the host with no project matched there
/// (`offload`: a read-only research sub placed without the main chat naming a machine).
pub async fn spawn_remote_outcome(state: &Arc<DaemonState>, peer: &PeerMachine, req: Request<'_>, scratch: bool, accounts: &[crate::accounts::Account]) -> Outcome {
    let inherited = crate::sessions::chat_config::get(req.caller).unwrap_or_default();
    let planned = spawn::plan_remote(state, req.caller, &inherited, req.prompt, req.model, req.effort, req.name, req.args, accounts);
    let mut plan = match planned {
        Ok(Some(plan)) => plan,
        Ok(None) => return Outcome::NotASub,
        Err(e) => return Outcome::Failed(json!({"ok": false, "error": e})),
    };
    match run(state, peer, &req, scratch, &mut plan).await {
        Ok(body) => Outcome::Done(body),
        Err(Fail { text, may_have_started: true }) => Outcome::Done(json!({"ok": false, "error": text})),
        Err(Fail { text, .. }) => Outcome::Failed(json!({"ok": false, "error": text})),
    }
}

async fn run(state: &Arc<DaemonState>, peer: &PeerMachine, req: &Request<'_>, scratch: bool, plan: &mut spawn::SubPlan) -> Result<Value, Fail> {
    if scratch && plan.brief.writes {
        return Err("a sub that edits files needs a project on the other machine, so it cannot run in a scratch folder".to_string().into());
    }
    // The folder on THIS machine the main chat's project is: the same guard a local
    // sub has (its own project or a known one). `cwd` is never a path on the host.
    // A scratch sub names no project: nothing here is matched or shipped.
    let (source, repo) = if scratch {
        (None, json!({}))
    } else {
        let caller_cwd = state.registry.get(req.caller).map(|i| i.cwd).ok_or_else(|| format!("unknown caller session: {}", req.caller))?;
        let home_cwd = crate::daemon::methods::spawn_chat::resolve_target_cwd(&caller_cwd, Path::new(req.cwd), &state.settings.snapshot().projects)?;
        let source = Source::of(&home_cwd, plan.brief.writes)?;
        let repo = json!({
            "origin": project_match::origin_of(&home_cwd),
            "machine_cwd": req.args.machine_cwd.as_deref().map(str::trim).filter(|c| !c.is_empty()),
        });
        if repo["origin"].is_null() && repo["machine_cwd"].is_null() {
            return Err(format!(
                "This project has no git origin to find the matching project on {} by. Ask Joe which folder on {} it is, then call spawn_chat again with machine_cwd set to it.",
                peer.label, peer.label
            )
            .into());
        }
        (source, repo)
    };
    // A scratch sub that falls back runs through `spawn_chat` here, which counts it itself, so
    // counting it up front too would spend two slots (and tell Joe twice) for one sub: it is
    // counted once, after the host took it.
    if !scratch {
        if let Err(refused) = crate::daemon::spawn_rate::admit("spawn_chat") {
            crate::daemon::spawn_rate::tell_joe(state, req.caller).await;
            return Err(refused.text.into());
        }
    }
    let client = client_for(state, peer).await.map_err(|e| unreachable_text(&peer.label, &e))?;

    // A writing sub's have-negotiation doubles as the preflight; a reader makes the
    // same call with nothing to offer, so a sleeping host or a project that matches
    // nothing there is known before anything is recorded. A scratch sub has no project
    // to match: `offload` asked the host (`sub_host_info`) a moment ago.
    let bundle = match &source {
        Some(src) => ship(&client, &peer.label, &repo, src).await?,
        None if scratch => None,
        None => {
            client.call("sub_git_have", json!({"repo": repo, "candidates": []})).await.map_err(|e| refusal_text(&peer.label, e))?;
            None
        }
    };

    let sub_id = uuid::Uuid::new_v4().to_string();
    let name = req.name.map(str::trim).filter(|n| !n.is_empty()).unwrap_or_default().to_string();
    // An `after` chain: the host registers the sub waiting and this machine starts it
    // when its targets are done (`remote::after`).
    let hold = plan.hold.clone();
    let record = RemoteSub {
        sub_id: sub_id.clone(),
        machine_id: peer.machine_id.clone(),
        main_id: req.caller.to_string(),
        name: name.clone(),
        state: if hold.is_some() { RemoteState::Held } else { RemoteState::Running },
        after: hold.as_ref().map(|h| h.targets.iter().map(|(id, _)| id.as_str()).collect::<Vec<_>>().join("\n")).unwrap_or_default(),
        after_name: hold.as_ref().map(|h| h.targets.iter().map(|(_, n)| n.replace('\n', " ")).collect::<Vec<_>>().join("\n")).unwrap_or_default(),
        cleared: Vec::new(),
        spawned_at: chrono::Utc::now().to_rfc3339(),
        unreachable_since: None,
        woke_unreachable: false,
        target: source.as_ref().map(|s| s.target.clone()).unwrap_or_default(),
        base: source.as_ref().map(|s| s.base.clone()).unwrap_or_default(),
        repo: source.as_ref().map(|s| s.top.clone()).unwrap_or_default(),
        last_seq: 0,
        finished_round: 0,
        steps_due: 0,
        finished_after_end: false,
        report_back: plan.brief.report_back,
    };
    // A waiting sub is not started before its host has registered it: a target that finishes
    // while the spawn call runs must not make the sweep send `sub_start` to a host that does
    // not know the sub yet.
    let start_claim = record_claiming(record, hold.is_some(), records::record)?;
    // The record is what counts from here, not the reserved slot.
    plan.release_slot();
    let params = json!({
        "sub_id": sub_id,
        "main_id": req.caller,
        "name": name,
        "repo": repo,
        "base": source.as_ref().map(|s| s.base.as_str()).unwrap_or_default(),
        "target": source.as_ref().map(|s| s.target.as_str()).unwrap_or_default(),
        "bundle": bundle,
        "brief": plan.brief,
        "first_message": plan.first_message,
        "model": plan.model,
        "effort": plan.effort,
        "hold": hold.is_some(),
        "scratch": scratch,
    });
    match client.call_with_timeout("sub_spawn", params, BUNDLE_CALL).await {
        Ok(reply) => {
            let mut out = json!({"ok": true, "session_id": sub_id, "machine": peer.label});
            if scratch {
                // The sub is running already, so a full budget changes nothing but the count.
                let _ = crate::daemon::spawn_rate::admit("spawn_chat");
                out["offloaded"] = json!(true);
            }
            if let Some(h) = &hold {
                // A target that finished while the call ran is seen by the next 60 s pass.
                drop(start_claim);
                out["queued"] = json!(true);
                out["note"] = json!(format!(
                    "Queued on {}: it starts by itself when {} is done, and asks Joe if that ends blocked. Its questions and results show in this chat.",
                    peer.label,
                    h.names_display()
                ));
                return Ok(out);
            }
            if scratch {
                out["note"] = json!(format!(
                    "Started on {}: this research sub runs there in an empty scratch folder with none of the project's files, to spare this machine. Its questions and results show in this chat.",
                    peer.label
                ));
                return Ok(out);
            }
            if let Some(branch) = reply.get("branch").and_then(Value::as_str) {
                out["note"] = json!(format!(
                    "Running on {} in its own worktree on branch {branch}; its commits come back to {} when it finishes. Its questions and results show in this chat.",
                    peer.label,
                    source.as_ref().map(|s| s.target.as_str()).unwrap_or("this checkout")
                ));
            }
            Ok(out)
        }
        // The host answered the have-call a moment ago, so an `Unreachable` here means
        // the link dropped or timed out mid-call: the host may have registered and
        // started the sub. The record stays (the cap and the name still cover it, and
        // the host's events need it); the main chat is told to check before spawning
        // again. For a scratch sub a `Protocol` error is the same case: it is raised when
        // the reply cannot be read (a connection that dropped mid-body, a proxy's 502
        // page), which can happen after the host acted, and an offloaded sub that falls
        // back to a local run would then run twice. A pinned-machine spawn keeps taking
        // its record back on it (a refusal the host never ran, such as an oversize body,
        // also reads as `Protocol`, and nothing falls back there). `NotSent` (the call
        // never reached the host) and a host's own refusal are known not to have started
        // it, so they take the record back.
        Err(e) if may_have_started(scratch, &e) => Err(Fail {
            text: format!(
                "{} The sub may still have started there, so it stays in this chat's list: check it with the subchat tool before spawning it again.",
                unreachable_text(&peer.label, &e)
            ),
            may_have_started: true,
        }),
        Err(e) => {
            let _ = records::remove(&sub_id);
            Err(refusal_text(&peer.label, e).into())
        }
    }
}

/// Whether a failed `sub_spawn` call may have been acted on by the host. A dropped link always
/// may; an unreadable reply (`Protocol`) does for a scratch sub only, because that sub's
/// failure falls back to a local run and a second copy is the worse outcome.
fn may_have_started(scratch: bool, e: &PeerError) -> bool {
    matches!(e, PeerError::Unreachable(_)) || (scratch && matches!(e, PeerError::Protocol(_)))
}

/// Writes `record`, having first taken the start claim of a waiting sub: the sweep that sends
/// `sub_start` finds a sub by its record, so a claim taken after the record leaves a window in
/// which a target that finished could start a sub its host has not registered. A fresh id has
/// no competing claim. `write` is `records::record`.
fn record_claiming(
    record: RemoteSub,
    waits: bool,
    write: impl FnOnce(RemoteSub) -> std::io::Result<()>,
) -> Result<Option<super::after::Claim>, String> {
    let claim = waits.then(|| super::after::claim(&record.sub_id)).flatten();
    write(record).map_err(|e| format!("could not record the sub before sending it: {e}"))?;
    Ok(claim)
}

/// Where a writing sub's tree starts and merges back to, read from this checkout.
struct Source {
    top: PathBuf,
    base: String,
    target: String,
}

impl Source {
    /// `None` for a read-only sub: it runs in the matched folder as it is and
    /// needs no commit shipped.
    fn of(home_cwd: &Path, writes: bool) -> Result<Option<Source>, String> {
        if !writes {
            return Ok(None);
        }
        let top = git::run_git(home_cwd, &["rev-parse", "--show-toplevel"])
            .filter(|(ok, _)| *ok)
            .map(|(_, out)| PathBuf::from(String::from_utf8_lossy(&out).trim()))
            .ok_or("A sub that edits files on another machine needs this project to be a git repository: its commits come back as git commits.")?;
        let target = crate::daemon::subchats::worktree::current_branch(&top).ok_or(
            "This chat's checkout is on a detached HEAD, so there is no branch for a sub's commits to merge into. Check a branch out first.",
        )?;
        let base = git::head(&top).ok_or("This repository has no commit yet, so there is nothing to start a sub from.")?;
        Ok(Some(Source { top, base, target }))
    }
}

/// The have-negotiation and the bundle: the host names the newest candidate commit
/// it already has, and the bundle carries what comes after it. `None` when the host
/// already has the base commit itself.
async fn ship(client: &crate::daemon::machines::PeerClient, label: &str, repo: &Value, src: &Source) -> Result<Option<String>, String> {
    let offered = {
        let (top, base) = (src.top.clone(), src.base.clone());
        tokio::task::spawn_blocking(move || git_sync::candidates(&top, &base)).await.map_err(|e| e.to_string())??
    };
    let reply = client
        .call("sub_git_have", json!({"repo": repo, "candidates": offered}))
        .await
        .map_err(|e| refusal_text(label, e))?;
    let have = reply.get("have").and_then(Value::as_str).map(str::to_string);
    if have.as_deref() == Some(src.base.as_str()) {
        return Ok(None);
    }
    let (top, base) = (src.top.clone(), src.base.clone());
    let bundle = tokio::task::spawn_blocking(move || git_sync::make_bundle(&top, &base, have.as_deref()))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| format!("{e} (the project on {label} is behind this checkout by more than a machine link carries, or shares no history with it)"))?;
    Ok(Some(git_sync::encode(&bundle)))
}

fn unreachable_text(label: &str, e: &PeerError) -> String {
    match e {
        PeerError::Unauthorized => format!("{label} rejected this machine's token: pair the two machines again."),
        other => format!("{label} is unreachable ({other}). Ask Joe to wake it and open Conductor there, then try again."),
    }
}

/// A peer's own refusal is already written for the main chat (it names the
/// projects registered there); anything else is the link's problem.
fn refusal_text(label: &str, e: PeerError) -> String {
    match e {
        PeerError::Rejected { message, .. } => message,
        other => unreachable_text(label, &other),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_scratch_sub_treats_an_unreadable_reply_as_maybe_started() {
        let dropped = PeerError::Unreachable("reset".into());
        let unreadable = PeerError::Protocol("body".into());
        let refused = PeerError::Rejected { code: -32602, message: "no".into() };
        for scratch in [false, true] {
            assert!(may_have_started(scratch, &dropped));
            assert!(!may_have_started(scratch, &refused));
            assert!(!may_have_started(scratch, &PeerError::NotSent("down".into())));
            assert!(!may_have_started(scratch, &PeerError::Unauthorized));
        }
        assert!(may_have_started(true, &unreadable), "a local fallback after it would run the sub twice");
        assert!(!may_have_started(false, &unreadable), "a pinned spawn keeps taking its record back");
    }

    fn record(id: &str) -> RemoteSub {
        RemoteSub { sub_id: id.into(), machine_id: "mac".into(), main_id: "m".into(), state: RemoteState::Held, ..Default::default() }
    }

    /// The sweep finds a waiting sub by its record, so the claim has to be there before the
    /// record is.
    #[test]
    fn a_waiting_subs_start_is_claimed_before_its_record_exists() {
        let seen = std::cell::Cell::new(None);
        let claim = record_claiming(record("rc-wait"), true, |r| {
            seen.set(Some(super::super::after::is_claimed(&r.sub_id)));
            Ok(())
        })
        .unwrap();
        assert_eq!(seen.get(), Some(true), "claimed when the record was written");
        assert!(claim.is_some());
        drop(claim);
        assert!(!super::super::after::is_claimed("rc-wait"), "released with the claim");
    }

    #[test]
    fn a_sub_that_does_not_wait_takes_no_claim_and_a_failed_write_gives_it_back() {
        assert!(record_claiming(record("rc-now"), false, |_| Ok(())).unwrap().is_none());
        assert!(!super::super::after::is_claimed("rc-now"));
        let err = record_claiming(record("rc-bad"), true, |_| Err(std::io::Error::other("disk full"))).err().unwrap();
        assert!(err.contains("disk full"));
        assert!(!super::super::after::is_claimed("rc-bad"), "a refused write leaves no claim behind");
    }
}
