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
}

struct RealPause(Arc<DaemonState>);

impl PauseEffects for RealPause {
    fn set_paused(&self, on: bool) -> GamingModeSummary {
        gaming_mode::set_on(&self.0, on)
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

/// Switches to `req`'s mode. The old mode's `pause_chats` is resumed first when
/// the new one does not carry it, then the new state is stored, then the new
/// one's is parked. Blocking (gaming mode makes HTTP and subprocess calls): run
/// it under `spawn_blocking`.
pub fn apply_with(req: &ModeRequest, now: DateTime<Utc>, effects: &dyn PauseEffects) -> Result<Applied, String> {
    let _held = MODE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    apply_locked(req, now, effects)
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
        Loaded::Unreadable => return Err("the stored mode could not be read, so nothing was changed; try again".to_string()),
    };
    let step = pause_step(&old, &normalized.state);
    let mut gaming = None;
    if step == PauseStep::Resume {
        gaming = Some(effects.set_paused(false));
    }
    persist::save(&normalized.state);
    if step == PauseStep::Park {
        gaming = Some(effects.set_paused(true));
    }
    if !normalized.dropped.is_empty() {
        log::info!("modes: ignored unknown flag(s) {:?}", normalized.dropped);
    }
    Ok(Applied { state: normalized.state, gaming, dropped: normalized.dropped })
}

/// Ends the current mode when its end time has passed. `None` when nothing ended.
pub fn expire_with(now: DateTime<Utc>, effects: &dyn PauseEffects) -> Option<Applied> {
    // The end time is checked again under the lock: a mode set while this tick waited
    // for it is the new one and must not be cleared.
    let _held = MODE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    match persist::load_for_write() {
        Loaded::Ok(state) if state.is_expired(now) => {}
        _ => return None,
    }
    apply_locked(&ModeRequest::clear(), now, effects).ok()
}

/// Boot upgrade: gaming mode was on before modes existed, so its record becomes
/// the current mode (no side effect: gaming is already parked).
pub fn adopt_running_gaming(gaming_on: bool, now: DateTime<Utc>) {
    if !gaming_on || persist::load() != Loaded::Missing {
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
    let applied = tokio::task::spawn_blocking(move || apply_with(&req, Utc::now(), &RealPause(blocking)))
        .await
        .map_err(|e| e.to_string())??;
    announce(state, &applied);
    Ok(applied)
}

/// The tray and Settings toggle (`set_gaming_mode`): gaming is one more mode.
/// ON switches to mode `gaming`; OFF clears the current mode only if it carries
/// `pause_chats`, and otherwise just undoes a gaming record an older build left.
pub fn set_gaming(state: &Arc<DaemonState>, on: bool) -> GamingModeSummary {
    let effects = RealPause(state.clone());
    let now = Utc::now();
    // The decision, the transition and the fallback park are one step under the lock:
    // a route call landing between them would otherwise be undone by the toggle.
    let (applied, summary) = {
        let _held = MODE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let req = if on || current().has_flag(PAUSE_CHATS) {
            Some(if on { ModeRequest::gaming() } else { ModeRequest::clear() })
        } else {
            None
        };
        let applied = req.and_then(|req| apply_locked(&req, now, &effects).ok());
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
        loop {
            ticker.tick().await;
            let blocking = state.clone();
            let ended = tokio::task::spawn_blocking(move || expire_with(Utc::now(), &RealPause(blocking))).await;
            if let Ok(Some(applied)) = ended {
                log::info!("modes: the end time passed, mode cleared");
                announce(&state, &applied);
            }
        }
    });
}

#[cfg(test)]
mod tests;
