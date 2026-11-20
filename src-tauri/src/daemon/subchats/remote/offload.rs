//! Placing a read-only research sub on a paired machine without the main chat naming
//! one (`docs/cross-machine-subchats.md`, "Offloading read-only subs"; pc-1782).
//!
//! A sub is offloaded only when every one of these holds, and the spawn is a plain local
//! one in every other case, with no error and no wait beyond one short probe:
//! - Settings' "Offload research subs" switch is on (off by default),
//! - the brief is a reader (`writes` false) that names no project files, is not a gate,
//!   not `plain`, not `continue_from`, not given a `machine_cwd` and not asked for a worktree,
//! - the caller is a main chat with Use subchats on,
//! - a paired machine is online and says it has at least [`scratch::MIN_FREE_BYTES`] free.
//!
//! The sub then runs in an empty scratch folder on that machine (`scratch`), never in a
//! clone of the project, so the other machine keeps no copy of anything.

use super::{scratch, spawn};
use crate::daemon::machines::{client_for, PeerMachine};
use crate::daemon::state::DaemonState;
use crate::daemon::subchats::SubchatArgs;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;

/// Settings key of the switch. Off until the Mac acceptance of pc-1782 has passed: a research
/// sub there sees none of the project's files, which only Joe can judge on his own jobs.
pub const SETTING_KEY: &str = "offloadReadOnlySubs";

/// How long the home waits for a machine's answer to the free-disk question. A machine that
/// is online but not answering costs the spawn this much once, then the spawn runs here.
const PROBE_TIMEOUT: Duration = Duration::from_secs(4);

/// Whether the switch is on.
pub fn enabled(state: &DaemonState) -> bool {
    state.settings.snapshot().extra.get(SETTING_KEY).and_then(Value::as_bool).unwrap_or(false)
}

/// Whether this brief is the kind that needs nothing from the project, from its arguments alone.
/// `files` names paths a sub means to read or write, so a brief that lists some wants the project.
pub fn eligible(args: &SubchatArgs) -> bool {
    let blank = |v: &Option<String>| v.as_deref().map(str::trim).filter(|s| !s.is_empty()).is_none();
    args.writes == Some(false)
        && args.gate != Some(true)
        && args.plain != Some(true)
        && args.worktree != Some(true)
        && blank(&args.continue_from)
        && blank(&args.machine_cwd)
        && args.files.iter().flatten().all(|f| f.trim().is_empty())
}

/// The online machine with the most free disk of those that report at least `min_free`, or
/// `None`. A machine that is offline, does not answer, or does not know the question (an
/// older build) is passed over.
pub async fn pick(state: &Arc<DaemonState>, min_free: u64) -> Option<PeerMachine> {
    let registry = state.machines.get()?;
    let mut best: Option<(u64, PeerMachine)> = None;
    for peer in registry.peers() {
        if !state.mirror.is_online(&peer.machine_id) {
            continue;
        }
        let Ok(client) = client_for(state, &peer).await else { continue };
        let Ok(reply) = client.call_with_timeout("sub_host_info", json!({}), PROBE_TIMEOUT).await else { continue };
        if reply.get("scratch").and_then(Value::as_bool) != Some(true) {
            continue;
        }
        let Some(free) = reply.get("free_bytes").and_then(Value::as_u64).filter(|f| *f >= min_free) else { continue };
        if best.as_ref().map_or(true, |(b, _)| free > *b) {
            best = Some((free, peer));
        }
    }
    best.map(|(_, peer)| peer)
}

/// What `spawn_chat` hands over: the call as the main chat made it, with no `machine`.
pub struct Call<'a> {
    pub caller: &'a str,
    pub prompt: Option<&'a str>,
    pub model: Option<&'a str>,
    pub effort: Option<&'a str>,
    pub name: Option<&'a str>,
    pub args: &'a SubchatArgs,
}

/// The tool's body when the sub was placed on another machine (or failed in a way a local
/// spawn must not repeat), `None` when it should run here.
pub async fn try_offload(state: &Arc<DaemonState>, call: Call<'_>, accounts: &[crate::accounts::Account]) -> Option<Value> {
    if !enabled(state) {
        return None;
    }
    try_offload_with(state, call, accounts, free_disk_bar()).await
}

/// The free-disk bar of the real entry point. A test thread may lower it so the test does not
/// depend on how full the disk of the machine running it is.
fn free_disk_bar() -> u64 {
    #[cfg(test)]
    if let Some(bar) = TEST_BAR.with(std::cell::Cell::get) {
        return bar;
    }
    scratch::MIN_FREE_BYTES
}

#[cfg(test)]
thread_local! {
    static TEST_BAR: std::cell::Cell<Option<u64>> = const { std::cell::Cell::new(None) };
}

/// Sets the bar for `try_offload` on this thread (tests run one thread per test).
#[cfg(test)]
pub(crate) fn set_test_bar(bar: u64) {
    TEST_BAR.with(|b| b.set(Some(bar)));
}

/// [`try_offload`] with the switch taken as read and the free-disk bar passed in.
pub(crate) async fn try_offload_with(state: &Arc<DaemonState>, call: Call<'_>, accounts: &[crate::accounts::Account], min_free: u64) -> Option<Value> {
    if !eligible(call.args) || !crate::sessions::chat_config::get(call.caller).is_some_and(|c| c.subchats_on) {
        return None;
    }
    let peer = pick(state, min_free).await?;
    let request = spawn::Request {
        caller: call.caller,
        cwd: "",
        prompt: call.prompt,
        model: call.model,
        effort: call.effort,
        name: call.name,
        args: call.args,
    };
    match spawn::spawn_remote_outcome(state, &peer, request, true, accounts).await {
        spawn::Outcome::Done(body) => Some(body),
        spawn::Outcome::NotASub => None,
        spawn::Outcome::Failed(body) => {
            // The brief itself may be what is wrong (a thin one): the local spawn says so in its
            // own words. Anything else (a host that went to sleep between the probe and the
            // call) is the silent fall back this feature promises.
            log::info!("subchats: offloading a research sub to {} failed, running it here: {}", peer.label, body["error"].as_str().unwrap_or("no reason given"));
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reader() -> SubchatArgs {
        SubchatArgs { task: Some("t".into()), goal: Some("g".into()), done_when: Some("d".into()), writes: Some(false), ..Default::default() }
    }

    #[test]
    fn only_a_plain_reader_that_names_no_files_is_eligible() {
        assert!(eligible(&reader()));
        assert!(eligible(&SubchatArgs { files: Some(vec!["  ".into()]), ..reader() }), "blank file names are no names");
        let no = |a: SubchatArgs| assert!(!eligible(&a), "{a:?}");
        no(SubchatArgs { writes: Some(true), files: Some(vec!["a.rs".into()]), ..reader() });
        no(SubchatArgs { writes: None, ..reader() });
        no(SubchatArgs { gate: Some(true), ..reader() });
        no(SubchatArgs { plain: Some(true), ..reader() });
        no(SubchatArgs { worktree: Some(true), ..reader() });
        no(SubchatArgs { continue_from: Some("old".into()), ..reader() });
        no(SubchatArgs { machine_cwd: Some("/x".into()), ..reader() });
        no(SubchatArgs { files: Some(vec!["src/lib.rs".into()]), ..reader() });
    }

    #[test]
    fn the_switch_is_off_until_it_is_set() {
        use crate::daemon::session::new_session_map;
        use crate::daemon::settings_cache::SettingsCache;
        let off = DaemonState::new(new_session_map(), SettingsCache::new(crate::types::Settings::default()));
        assert!(!enabled(&off));
        let mut settings = crate::types::Settings::default();
        settings.extra.insert(SETTING_KEY.into(), json!(true));
        assert!(enabled(&DaemonState::new(new_session_map(), SettingsCache::new(settings))));
        let mut settings = crate::types::Settings::default();
        settings.extra.insert(SETTING_KEY.into(), json!("yes"));
        assert!(!enabled(&DaemonState::new(new_session_map(), SettingsCache::new(settings))), "only a real true counts");
    }
}
