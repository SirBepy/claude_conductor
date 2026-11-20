//! The home's watch on the machines that host its subs
//! (`docs/cross-machine-subchats.md`, "Host offline").
//!
//! A sub keeps running on its host while the link is down, and its events wait in
//! the host's outbox, so a gap is not a failure and Joe gets no card. The home only
//! records since when it has not heard from the host (`RemoteSub::unreachable_since`,
//! which `subchat status` shows) and wakes the main chat ONCE per gap, after
//! [`WAKE_AFTER`], so it can decide whether the job is urgent. A reconnect, or any
//! event from the host, clears the gap; the next gap wakes again.
//!
//! Runs on the busy_watchdog tick. "Reachable" is the peer link's own state
//! (`MirrorState::is_online`), which that link keeps true to the stream.

use super::records::{self, RemoteState, RemoteSub};
use crate::daemon::state::DaemonState;
use chrono::{DateTime, Duration, Utc};
use std::sync::Arc;

/// How long a host may be unreachable before the main chat is woken.
pub const WAKE_AFTER: Duration = Duration::minutes(10);

/// The wake text: ids, a name and a machine label kept to plain characters, and
/// fixed words. The label comes from the peer's own profile, so it is as untrusted
/// as a sub's name.
pub fn notice(name: &str, sub_id: &str, machine_label: &str, minutes: i64) -> String {
    let (short, shown) = crate::daemon::subchats::wake::short_and_shown(name, sub_id);
    let label = crate::daemon::subchats::wake::safe_name(machine_label);
    let label = if label.is_empty() { "its machine".to_string() } else { label };
    format!(
        "Sub \"{shown}\" (id {short}) runs on {label}, which has been unreachable for {minutes} minutes. The sub keeps running there and its results arrive when {label} is back, so nothing is lost. Read what is known with the subchat tool: action status, sub \"{shown}\". Joe was not asked."
    )
}

fn running(sub: &RemoteSub) -> bool {
    matches!(sub.state, RemoteState::Running | RemoteState::Held)
}

/// One pass: `online` says whether a machine's link is up now. Returns the ids of
/// the subs whose main chat was woken.
pub fn tick_at(state: &Arc<DaemonState>, now: DateTime<Utc>, online: impl Fn(&str) -> bool) -> Vec<String> {
    let mut woken = Vec::new();
    for sub in records::all().into_iter().filter(running) {
        if online(&sub.machine_id) {
            if sub.unreachable_since.is_some() || sub.woke_unreachable {
                let _ = records::update(&sub.sub_id, |r| {
                    r.unreachable_since = None;
                    r.woke_unreachable = false;
                });
            }
            continue;
        }
        let Some(since) = sub.unreachable_since.as_deref().and_then(|s| DateTime::parse_from_rfc3339(s).ok()).map(|t| t.with_timezone(&Utc)) else {
            let _ = records::update(&sub.sub_id, |r| r.unreachable_since = Some(now.to_rfc3339()));
            continue;
        };
        let gap = now.signed_duration_since(since);
        if gap < WAKE_AFTER || sub.woke_unreachable {
            continue;
        }
        // Marked before the wake, so a failure to write it can never wake twice.
        if records::update(&sub.sub_id, |r| r.woke_unreachable = true).is_err() {
            continue;
        }
        if !crate::daemon::subchats::held::chat_live(state, &sub.main_id) {
            continue;
        }
        let label = state.machines.get().and_then(|r| r.peer(&sub.machine_id)).map(|p| p.label).unwrap_or_default();
        let text = notice(&sub.name, &sub.sub_id, &label, gap.num_minutes());
        log::warn!("subchats: {} has been unreachable for {} minutes, waking {} about sub {}", sub.machine_id, gap.num_minutes(), sub.main_id, sub.sub_id);
        crate::daemon::subchats::wake::wake_main_chat(state, &sub.main_id, text);
        woken.push(sub.sub_id);
    }
    woken
}

/// The host's side: a visiting sub that waits in the held list for its home to send `sub_start`
/// is dropped once its home is no longer a paired machine, because nothing can ever start it
/// (and nothing on this machine ends a held visiting sub by itself: `held::orphaned` skips it,
/// `queue_watch` is inert for it). Only a registry file read cleanly says "unpaired"
/// ([`super::outbox::pairing_of`]): an unreadable one never drops a sub. A sub that started is
/// not touched, since it runs to its finish and the outbox keeps what it has to report.
/// Returns the ids dropped.
pub fn sweep_unhomed(state: &Arc<DaemonState>) -> Vec<String> {
    let Some(registry) = state.machines.get() else { return Vec::new() };
    let mut dropped = Vec::new();
    for held in crate::daemon::subchats::held::all() {
        let Some(home) = super::events::home_of(&held.sub_id) else { continue };
        if super::outbox::pairing_of(registry, &home.machine_id) != super::outbox::Pairing::Absent {
            continue;
        }
        match crate::daemon::subchats::queued::drop_now(state, &held.sub_id) {
            Ok(_) => {
                log::warn!("subchats: dropped held visiting sub {}: its home {} is no longer paired, so nothing can start it", held.sub_id, home.machine_id);
                dropped.push(held.sub_id);
            }
            Err(e) => log::debug!("subchats: held visiting sub {} of an unpaired home was not dropped: {e}", held.sub_id),
        }
    }
    dropped
}

/// The busy_watchdog tick: the gap watch over the peer links, and a delivery pass
/// for whatever waits in the outbox (a link that came back between ticks without a
/// connect hook, or an entry that failed on its last pass).
pub fn tick(state: &Arc<DaemonState>) {
    tick_at(state, Utc::now(), |machine| state.mirror.is_online(machine));
    sweep_unhomed(state);
    super::outbox::flush_in_background(state);
}

/// A peer link just connected: the host is reachable again, so the gap ends and
/// whatever waited for it is sent now.
pub fn on_peer_connected(state: &Arc<DaemonState>, machine_id: &str) {
    for sub in records::all().into_iter().filter(|s| s.machine_id == machine_id && (s.unreachable_since.is_some() || s.woke_unreachable)) {
        let _ = records::update(&sub.sub_id, |r| {
            r.unreachable_since = None;
            r.woke_unreachable = false;
        });
    }
    super::outbox::flush_in_background(state);
}

#[cfg(test)]
#[path = "watch_tests.rs"]
mod tests;
