//! Modes: ONE current mode (a name, a flag list and an optional end time) that
//! any local app sets through `POST /hooks/mode` (`hooks_server/mode.rs`).
//! Spec: the Modes section of docs/architecture/daemon-messages.md. The daemon stores it because only the daemon reaches
//! every chat and survives restarts; a timers app owns schedules and the OS
//! side and sends the flag list.
//!
//! This module owns the state, the flag vocabulary, the end-time rules and the
//! transitions. What a flag does to a chat (the `[mode]` rider) and to
//! Conductor's own sounds lives next to the code it touches. The one flag with
//! a side effect today, `pause_chats`, is gaming mode's park and resume
//! (`gaming_mode::turn_on` / `turn_off`), reached through [`PauseEffects`] so
//! the transitions are unit-testable.

pub mod mute;
mod persist;
pub mod rider;

use crate::daemon::gaming_mode::{self, GamingModeSummary};
use crate::daemon::state::DaemonState;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub use persist::{config_path_for, current, Loaded};

/// Gaming's park and resume (`gaming_mode::turn_on` / `turn_off`).
pub const PAUSE_CHATS: &str = "pause_chats";
/// Drops the turn sound and the phone push; cards still show, silently.
pub const MUTE_CONDUCTOR: &str = "mute_conductor";
/// The four flags that become one fixed sentence in the `[mode]` rider.
pub const TEST_WITHOUT_ASKING: &str = "test_without_asking";
pub const TAKE_OBVIOUS_ANSWER: &str = "take_obvious_answer";
pub const PARK_BLOCKERS: &str = "park_blockers";
pub const STOP_SERVERS_WHEN_DONE: &str = "stop_servers_when_done";

/// The fixed vocabulary. Anything else a caller sends is dropped and logged,
/// never an error, so a newer timers app does not break against an older daemon.
pub const KNOWN_FLAGS: &[&str] =
    &[PAUSE_CHATS, MUTE_CONDUCTOR, TEST_WITHOUT_ASKING, TAKE_OBVIOUS_ANSWER, PARK_BLOCKERS, STOP_SERVERS_WHEN_DONE];

/// The mode whose name always implies `pause_chats`, so the tray check item and
/// `get_gaming_mode` always match a mode of this name.
pub const GAMING: &str = "gaming";

/// The refusal for a stored mode that exists and cannot be read. It is the server's
/// problem, not the caller's, so the route answers it with a 503 and not a 400.
pub const UNREADABLE: &str = "the stored mode could not be read, so nothing was changed; try again";

/// The refusal for a mode that could not be written to disk; a 503 like [`UNREADABLE`].
pub const NOT_STORED: &str = "the mode could not be saved to disk, so it was not applied; try again";

const NAME_MAX: usize = 40;
const SET_BY_MAX: usize = 40;
/// How often the end time is checked (boot included). A mode ends at most this
/// late; nothing about it is time-critical to the second.
const EXPIRY_TICK: Duration = Duration::from_secs(15);

/// The stored mode. Every field is `#[serde(default)]` (CLAUDE.md: a present
/// but incomplete object must not fail the whole file).
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct ModeState {
    /// `None` = no mode.
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default)]
    pub flags: Vec<String>,
    /// RFC 3339; `None` = stays on until switched off.
    #[serde(default)]
    pub until: Option<String>,
    #[serde(default)]
    pub set_at: Option<String>,
    /// A short label for the log; never part of any chat text.
    #[serde(default)]
    pub set_by: Option<String>,
}

impl ModeState {
    pub fn has_flag(&self, flag: &str) -> bool {
        self.mode.is_some() && self.flags.iter().any(|f| f == flag)
    }

    fn until_at(&self) -> Option<DateTime<Utc>> {
        self.until.as_deref().and_then(|s| DateTime::parse_from_rfc3339(s).ok()).map(|d| d.with_timezone(&Utc))
    }

    /// The end time has passed. An unparseable stored value counts as expired:
    /// a mode that can never end is worse than one that ends early.
    pub fn is_expired(&self, now: DateTime<Utc>) -> bool {
        match (&self.until, self.until_at()) {
            (None, _) => false,
            (Some(_), Some(at)) => at <= now,
            (Some(_), None) => true,
        }
    }
}

/// What a caller asks for: `mode: None` clears.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ModeRequest {
    pub mode: Option<String>,
    pub flags: Vec<String>,
    pub until: Option<String>,
    pub set_by: Option<String>,
}

impl ModeRequest {
    pub fn clear() -> Self {
        Self::default()
    }

    pub fn gaming() -> Self {
        ModeRequest { mode: Some(GAMING.to_string()), flags: vec![PAUSE_CHATS.to_string()], until: None, set_by: Some("gaming-toggle".into()) }
    }
}

/// The request after validation. `dropped` names the unknown flags so the
/// caller can log them.
#[derive(Debug, PartialEq)]
pub struct Normalized {
    pub state: ModeState,
    pub dropped: Vec<String>,
}

/// Validates a request. `Err` is the reason, sent back as a 400.
pub fn normalize(req: &ModeRequest, now: DateTime<Utc>) -> Result<Normalized, String> {
    let Some(raw_name) = req.mode.as_deref() else {
        return Ok(Normalized { state: ModeState::default(), dropped: Vec::new() });
    };
    let name = raw_name.trim().to_ascii_lowercase();
    if name.is_empty() || name.chars().count() > NAME_MAX || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err(format!("mode must be 1-{NAME_MAX} characters of letters, digits, '-' or '_', or null to clear"));
    }

    let until = match req.until.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        None => None,
        Some(s) => {
            let at = DateTime::parse_from_rfc3339(s).map_err(|e| format!("until is not an RFC 3339 time ({e})"))?.with_timezone(&Utc);
            if at <= now {
                return Err("until has already passed".to_string());
            }
            Some(at.to_rfc3339())
        }
    };

    let mut flags: Vec<String> = Vec::new();
    let mut dropped: Vec<String> = Vec::new();
    for flag in &req.flags {
        let flag = flag.trim().to_ascii_lowercase();
        if KNOWN_FLAGS.contains(&flag.as_str()) {
            if !flags.contains(&flag) {
                flags.push(flag);
            }
        } else if !dropped.contains(&flag) {
            dropped.push(flag);
        }
    }
    if name == GAMING && !flags.iter().any(|f| f == PAUSE_CHATS) {
        flags.push(PAUSE_CHATS.to_string());
    }

    let set_by = req.set_by.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(|s| s.chars().take(SET_BY_MAX).collect());
    Ok(Normalized { state: ModeState { mode: Some(name), flags, until, set_at: Some(now.to_rfc3339()), set_by }, dropped })
}

/// What `pause_chats` must do to get from `old` to `new`. Two modes that both
/// carry it change nothing, so gaming does not churn through a resume-then-park.
#[derive(Debug, PartialEq, Eq)]
pub enum PauseStep {
    Nothing,
    Park,
    Resume,
}

pub fn pause_step(old: &ModeState, new: &ModeState) -> PauseStep {
    match (old.has_flag(PAUSE_CHATS), new.has_flag(PAUSE_CHATS)) {
        (false, true) => PauseStep::Park,
        (true, false) => PauseStep::Resume,
        _ => PauseStep::Nothing,
    }
}

/// The one side effect a flag has. The real one is gaming mode; a test records.
pub trait PauseEffects {
    fn set_paused(&self, on: bool) -> GamingModeSummary;

    /// Whether chats are parked right now, when the effect can tell (`None` = it
    /// cannot, and nothing is reconciled). The stored mode and the park are two
    /// writes with a crash between them, and a damaged mode file reads as no mode while
    /// gaming's own record still says chats are parked.
    fn is_paused(&self) -> Option<bool> {
        None
    }
}

struct RealPause(Arc<DaemonState>);

impl PauseEffects for RealPause {
    fn set_paused(&self, on: bool) -> GamingModeSummary {
        gaming_mode::set_on(&self.0, on)
    }

    fn is_paused(&self) -> Option<bool> {
        Some(gaming_mode::load_file().on)
    }
}

/// A transition's outcome.
#[derive(Debug)]
pub struct Applied {
    pub state: ModeState,
    /// Set only when `pause_chats` was parked or resumed by this call.
    pub gaming: Option<GamingModeSummary>,
    pub dropped: Vec<String>,
}

/// Switches to `req`'s mode. The new state is stored first, then the old mode's
/// `pause_chats` is resumed when the new one does not carry it, or the new one's
/// is parked when the old one lacked it. Blocking (gaming mode makes HTTP and subprocess calls): run
/// it under `spawn_blocking`.
pub fn apply_with(req: &ModeRequest, now: DateTime<Utc>, effects: &dyn PauseEffects) -> Result<Applied, String> {
    apply_announcing(req, now, effects, &|_| {})
}

/// [`apply_with`] that also runs `announce` on the outcome while the lock is still held,
/// so two transitions publish `mode_changed` in the order they were stored.
fn apply_announcing(
    req: &ModeRequest,
    now: DateTime<Utc>,
    effects: &dyn PauseEffects,
    announce: &dyn Fn(&Applied),
) -> Result<Applied, String> {
    let _held = MODE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let applied = apply_locked(req, now, effects)?;
    announce(&applied);
    Ok(applied)
}

/// One transition at a time: the route, the end-time tick and the tray toggle each
/// run on their own blocking thread and each reads the stored mode, decides, then
/// writes. Without this, a mode set at the instant the old one ends could be
/// cleared by the tick, and two parks could race through gaming's own check.
static MODE_LOCK: Mutex<()> = Mutex::new(());

fn apply_locked(req: &ModeRequest, now: DateTime<Utc>, effects: &dyn PauseEffects) -> Result<Applied, String> {
    let normalized = normalize(req, now)?;
    // A stored mode that cannot be read (not merely absent) stops the transition: with
    // an unknown old mode `pause_chats` could not be resumed, and saving would
    // overwrite the record that says chats are parked.
    let old = match persist::load_for_write() {
        Loaded::Ok(state) => state,
        Loaded::Missing | Loaded::Bad => ModeState::default(),
        Loaded::Unreadable => return Err(UNREADABLE.to_string()),
    };
    let step = reconciled_step(pause_step(&old, &normalized.state), &old, &normalized.state, effects.is_paused());
    let mut gaming = None;
    // Stored first, so a failed write changes nothing at all ("not applied" is then true):
    // parking under a mode that is not stored leaves chats parked under "no mode", and
    // resuming before the write leaves the stored mode saying gaming over running chats.
    // A crash between the write and the resume leaves chats parked under the new mode;
    // the tray toggle OFF resumes from gaming's own record.
    if !persist::save(&normalized.state) {
        return Err(NOT_STORED.to_string());
    }
    if step == PauseStep::Resume {
        gaming = Some(effects.set_paused(false));
    }
    if step == PauseStep::Park {
        gaming = Some(effects.set_paused(true));
    }
    if !normalized.dropped.is_empty() {
        log::info!("modes: ignored unknown flag(s) {:?}", normalized.dropped);
    }
    Ok(Applied { state: normalized.state, gaming, dropped: normalized.dropped })
}

/// `step`, corrected by what is actually parked when the two disagree for a reason
/// the stored modes cannot show:
/// - the new mode carries `pause_chats` and the old one did too (so nothing is to be
///   done), but chats are not parked: a crash between storing the mode and parking.
/// - neither mode carries it, yet chats are parked: the mode that parked them was lost
///   (its file was damaged and set aside), so nothing else would ever resume them.
fn reconciled_step(step: PauseStep, old: &ModeState, new: &ModeState, parked: Option<bool>) -> PauseStep {
    match (step, parked) {
        (PauseStep::Nothing, Some(false)) if new.has_flag(PAUSE_CHATS) => PauseStep::Park,
        (PauseStep::Nothing, Some(true)) if !new.has_flag(PAUSE_CHATS) && !old.has_flag(PAUSE_CHATS) => PauseStep::Resume,
        (step, _) => step,
    }
}

/// Boot: a stored mode that carries `pause_chats` while nothing is parked (a crash
/// between the two writes) gets its park now. `None` when there was nothing to do.
pub fn reconcile_with(effects: &dyn PauseEffects) -> Option<GamingModeSummary> {
    let _held = MODE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    match persist::load_for_write() {
        Loaded::Ok(state) if state.has_flag(PAUSE_CHATS) && !state.is_expired(Utc::now()) && effects.is_paused() == Some(false) => {
            Some(effects.set_paused(true))
        }
        _ => None,
    }
}

/// Ends the current mode when its end time has passed. `None` when nothing ended.
pub fn expire_with(now: DateTime<Utc>, effects: &dyn PauseEffects) -> Option<Applied> {
    expire_announcing(now, effects, &|_| {})
}

/// [`expire_with`] that announces under the lock, like [`apply_announcing`].
fn expire_announcing(now: DateTime<Utc>, effects: &dyn PauseEffects, announce: &dyn Fn(&Applied)) -> Option<Applied> {
    // The end time is checked again under the lock: a mode set while this tick waited
    // for it is the new one and must not be cleared.
    let _held = MODE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    match persist::load_for_write() {
        Loaded::Ok(state) if state.is_expired(now) => {}
        _ => return None,
    }
    let applied = apply_locked(&ModeRequest::clear(), now, effects).ok()?;
    announce(&applied);
    Some(applied)
}

/// Boot upgrade: gaming mode was on before modes existed, so its record becomes
/// the current mode (no side effect: gaming is already parked).
pub fn adopt_running_gaming(gaming_on: bool, now: DateTime<Utc>) {
    // A damaged file was moved aside by the read, so it reads as no mode: the gaming
    // record still says chats are parked, and adopting it is the only way they resume.
    if !gaming_on || !matches!(persist::load(), Loaded::Missing | Loaded::Bad) {
        return;
    }
    if let Ok(n) = normalize(&ModeRequest::gaming(), now) {
        persist::save(&n.state);
    }
}

/// The wire shape of the current mode (`GET /hooks/mode`, `mode_changed`).
pub fn state_json(state: &ModeState) -> Value {
    serde_json::to_value(state).unwrap_or(Value::Null)
}

/// Publishes what a transition changed and refreshes the rows a park touches.
fn announce(state: &Arc<DaemonState>, applied: &Applied) {
    state.notifier.publish("mode_changed", state_json(&applied.state));
    if let Some(summary) = &applied.gaming {
        state.notifier.publish("gaming_mode_changed", serde_json::to_value(summary).unwrap_or(Value::Null));
        // Rows carry the park (`SessionProgress::parked`), so a flip must reach them now.
        if crate::daemon::subchats::pause::sync_parked(state) {
            crate::daemon::machines::publish_instances_changed(state);
        }
    }
}

/// `POST /hooks/mode`, off the async runtime.
pub async fn apply(state: &Arc<DaemonState>, req: ModeRequest) -> Result<Applied, String> {
    let blocking = state.clone();
    let announcer = state.clone();
    tokio::task::spawn_blocking(move || apply_announcing(&req, Utc::now(), &RealPause(blocking), &|a| announce(&announcer, a)))
        .await
        .map_err(|e| e.to_string())?
}

/// The tray and Settings toggle (`set_gaming_mode`): gaming is one more mode.
/// ON switches to mode `gaming`; OFF clears the current mode only if it carries
/// `pause_chats`, and otherwise just undoes a gaming record an older build left.
pub fn set_gaming(state: &Arc<DaemonState>, on: bool) -> GamingModeSummary {
    let effects = RealPause(state.clone());
    let now = Utc::now();
    // The decision, the transition and the fallback park are one step under the lock:
    // a route call landing between them would otherwise be undone by the toggle.
    //
    // A refusal still publishes `gaming_mode_changed` (with the unchanged summary), so the
    // tray's check mark, which only follows that event, is put back.
    let (applied, summary) = 'locked: {
        let _held = MODE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let stored = match persist::load_for_write() {
            Loaded::Ok(s) => s,
            Loaded::Missing | Loaded::Bad => ModeState::default(),
            Loaded::Unreadable => {
                // The mode cannot be decided on a state that cannot be read, so nothing
                // is parked and the mode file is not written. Turning OFF still resumes
                // what gaming's own record says it parked: that is the way out when the
                // mode file stays unreadable.
                log::warn!("modes: the tray toggle did not touch the stored mode, it could not be read");
                let record = gaming_mode::load_file();
                break 'locked if !on && record.on {
                    (None, effects.set_paused(false))
                } else {
                    (None, gaming_mode::summary_of(&record))
                };
            }
        };
        let req = if on || stored.has_flag(PAUSE_CHATS) {
            Some(if on { ModeRequest::gaming() } else { ModeRequest::clear() })
        } else {
            None
        };
        let applied = match req {
            Some(req) => match apply_locked(&req, now, &effects) {
                Ok(a) => Some(a),
                Err(e) => {
                    log::warn!("modes: the tray toggle was not applied: {e}");
                    break 'locked (None, gaming_mode::summary_of(&gaming_mode::load_file()));
                }
            },
            None => None,
        };
        let mut summary = match &applied {
            Some(a) => a.gaming.clone().unwrap_or_else(|| gaming_mode::summary_of(&gaming_mode::load_file())),
            None => effects.set_paused(on),
        };
        if on && applied.is_some() && !summary.on {
            // The mode says gaming but nothing is parked: a crash between storing the mode
            // and parking left them apart. Park now, so the toggle does what it says.
            summary = effects.set_paused(true);
        }
        (applied, summary)
    };
    if let Some(applied) = &applied {
        state.notifier.publish("mode_changed", state_json(&applied.state));
    }
    state.notifier.publish("gaming_mode_changed", serde_json::to_value(&summary).unwrap_or(Value::Null));
    // Rows carry the park (`SessionProgress::parked`), so a flip must reach them now.
    if crate::daemon::subchats::pause::sync_parked(state) {
        crate::daemon::machines::publish_instances_changed(state);
    }
    summary
}

/// Boot: adopt a gaming record, then end an expired mode now and every
/// [`EXPIRY_TICK`] after. The first end check waits one tick so the registry and
/// the supervisor link are up before a resume messages chats.
pub fn spawn(state: Arc<DaemonState>) {
    adopt_running_gaming(gaming_mode::load_file().on, Utc::now());
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval_at(tokio::time::Instant::now() + EXPIRY_TICK, EXPIRY_TICK);
        let mut first = true;
        loop {
            ticker.tick().await;
            if std::mem::take(&mut first) {
                let blocking = state.clone();
                let parked = tokio::task::spawn_blocking(move || reconcile_with(&RealPause(blocking))).await;
                if let Ok(Some(summary)) = parked {
                    log::info!("modes: parked chats the stored mode asked for but a crash left running");
                    state.notifier.publish("gaming_mode_changed", serde_json::to_value(&summary).unwrap_or(Value::Null));
                    if crate::daemon::subchats::pause::sync_parked(&state) {
                        crate::daemon::machines::publish_instances_changed(&state);
                    }
                }
            }
            let blocking = state.clone();
            let announcer = state.clone();
            let ended = tokio::task::spawn_blocking(move || {
                expire_announcing(Utc::now(), &RealPause(blocking), &|a| announce(&announcer, a))
            })
            .await;
            if let Ok(Some(_)) = ended {
                log::info!("modes: the end time passed, mode cleared");
            }
        }
    });
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod announce_order_tests {
    use super::*;

    struct NoPause;
    impl PauseEffects for NoPause {
        fn set_paused(&self, on: bool) -> GamingModeSummary {
            GamingModeSummary { on, ..Default::default() }
        }
    }

    /// `mode_changed` is published while the transition lock is held: a second
    /// transition cannot store and publish between this one's store and its publish.
    #[test]
    fn an_outcome_is_announced_while_the_transition_lock_is_held() {
        let _guard = crate::util::ENV_MUTATION_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("CC_DATA_DIR", tmp.path());
        let held_during = std::cell::Cell::new(None);
        let probe = |_: &Applied| held_during.set(Some(MODE_LOCK.try_lock().is_err()));
        let now = Utc::now();
        let req = ModeRequest {
            mode: Some("sleep".into()),
            flags: vec![TEST_WITHOUT_ASKING.into()],
            until: Some((now + chrono::Duration::hours(1)).to_rfc3339()),
            ..Default::default()
        };
        apply_announcing(&req, now, &NoPause, &probe).unwrap();
        assert_eq!(held_during.get(), Some(true), "the route path announces under the lock");
        held_during.set(None);
        let ended = expire_announcing(now + chrono::Duration::hours(2), &NoPause, &probe);
        std::env::remove_var("CC_DATA_DIR");
        assert!(ended.is_some());
        assert_eq!(held_during.get(), Some(true), "the end-time tick announces under the lock");
    }
}
