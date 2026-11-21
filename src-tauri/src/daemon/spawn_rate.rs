//! A rolling cap on chats that other chats, schedules and Jarvis start. A chat that
//! loops on `spawn_chat`, a respawn chain, or a scheduled prompt that schedules the
//! next one has no bound of its own: the guards elsewhere cap concurrent subs and
//! one respawn per turn, not the total started over time. Past [`LIMIT`] starts in
//! [`WINDOW`] the next one is refused; Joe is told once per window unless a main
//! chat's own sub spawn was refused (see [`card_wanted`]).
//!
//! Only chats that actually start count. A sub registered queued (`after`, the
//! writer slot) is checked against the budget but counted when its child starts
//! (`held::launch_claimed`), so a main chat can register a long chain at once.
//!
//! 20 in 5 minutes leaves a normal fan-out alone (the busiest recorded burst, a
//! release of held subs on 2026-11-10, was 9 in about 5 minutes) and stops a loop
//! within a minute or two. Joe starting a chat by hand never passes through here,
//! and neither does a resume.

use std::collections::VecDeque;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

pub const LIMIT: usize = 20;
pub const WINDOW: Duration = Duration::from_secs(300);

#[derive(Default)]
struct Starts {
    at: VecDeque<Instant>,
    /// Whether Joe was already told about the current burst; cleared once the
    /// window empties enough to admit again, so a loop cannot flood cards.
    told: bool,
}

/// The outcome of asking to start one more chat.
#[derive(Debug, PartialEq, Eq)]
pub enum Verdict {
    Allowed,
    /// Refused; `first` is true when this is the first refusal of the burst, the
    /// moment to tell Joe. `wait` is how long until the oldest start leaves the window.
    Refused { first: bool, wait: Duration },
}

impl Starts {
    fn prune(&mut self, now: Instant) {
        while self.at.front().is_some_and(|t| now.duration_since(*t) >= WINDOW) {
            self.at.pop_front();
        }
    }

    /// Asks whether one more chat may start, without counting it. A sub registered
    /// queued (`after`, the writer slot) starts nothing yet, so it only asks.
    /// `quiet` is a main chat's sub spawn: its refusal draws no card, so it must not use
    /// up the burst's one card either (an unattended loop refused after it still gets it).
    fn check(&mut self, now: Instant, quiet: bool) -> Verdict {
        self.prune(now);
        if self.at.len() < LIMIT {
            self.told = false;
            return Verdict::Allowed;
        }
        let first = !self.told;
        self.told = self.told || !quiet;
        let wait = self.at.front().map_or(WINDOW, |t| WINDOW.saturating_sub(now.duration_since(*t)));
        Verdict::Refused { first, wait }
    }

    /// Counts a chat that has started. Never refuses: the process exists already.
    fn record(&mut self, now: Instant) {
        self.prune(now);
        self.at.push_back(now);
    }

    /// [`Self::check`] then [`Self::record`], for a chat that starts right away.
    fn admit(&mut self, now: Instant) -> Verdict {
        let verdict = self.check(now, false);
        if verdict == Verdict::Allowed {
            self.record(now);
        }
        verdict
    }

    /// One spawn request: counted now when its child starts now, only checked when
    /// it is registered to start later (its start counts through [`Self::record`]).
    fn gate(&mut self, now: Instant, starts_now: bool, quiet: bool) -> Verdict {
        if starts_now && !quiet {
            self.admit(now)
        } else {
            let verdict = self.check(now, quiet);
            if starts_now && verdict == Verdict::Allowed {
                self.record(now);
            }
            verdict
        }
    }
}

static STARTS: LazyLock<Mutex<Starts>> = LazyLock::new(|| Mutex::new(Starts::default()));

/// Why a start was refused, for the caller to return and, on the first refusal of
/// a burst, to show Joe.
#[derive(Debug)]
pub struct Refused {
    pub text: String,
    pub first: bool,
    /// Until the oldest counted start leaves the window.
    pub wait: Duration,
}

/// Counts one chat start made by a chat, a schedule or Jarvis; `source` names the
/// path in the log.
pub fn admit(source: &str) -> Result<(), Refused> {
    gate(source, true, false)
}

/// Asks whether a chat may start, counting nothing: for a sub that is registered
/// queued and starts later. Its start is counted by [`record`], so a burst of
/// queued registrations never fills the budget a real loop would.
pub fn check(source: &str, by_sub_spawn: bool) -> Result<(), Refused> {
    gate(source, false, by_sub_spawn)
}

/// [`admit`] for a request that may only register its child: counted now when
/// `starts_now`, otherwise only checked. `by_sub_spawn` is a main chat spawning a
/// sub (see [`card_wanted`]).
pub fn gate(source: &str, starts_now: bool, by_sub_spawn: bool) -> Result<(), Refused> {
    // The lib's tests share one process and start far more than LIMIT chats between
    // them; the rolling logic is covered on `Starts` directly. A per-thread count
    // lets a test see WHERE in a spawn the count happens.
    if cfg!(test) {
        if starts_now {
            TEST_ADMITS.with(|n| n.set(n.get() + 1));
        }
        return Ok(());
    }
    match STARTS.lock().unwrap_or_else(|e| e.into_inner()).gate(Instant::now(), starts_now, by_sub_spawn) {
        Verdict::Allowed => Ok(()),
        Verdict::Refused { first, wait } => {
            if first {
                log::warn!(
                    "spawn guard: {LIMIT} chats started in {}s, refusing the next one (from {source}); waits {}s",
                    WINDOW.as_secs(),
                    wait.as_secs()
                );
            }
            Err(Refused { text: refusal(wait), first, wait })
        }
    }
}

/// Counts a queued sub's child that has just started (the moment its process is
/// created), so a chain of N queued subs spends the budget one start at a time.
pub fn record(_source: &str) {
    if cfg!(test) {
        TEST_ADMITS.with(|n| n.set(n.get() + 1));
        return;
    }
    STARTS.lock().unwrap_or_else(|e| e.into_inner()).record(Instant::now());
}

/// Whether Joe is shown the card for a refusal. `first` is the burst's first
/// refusal; `by_sub_spawn` is true when the caller was a main chat spawning subs.
/// That refusal returns to the main chat as the tool error that says how long to
/// wait, and a card would only be plumbing for Joe. A loop with no main chat's sub
/// behind it (a schedule, Jarvis, a plain chat) is the one he must see.
pub fn card_wanted(first: bool, by_sub_spawn: bool) -> bool {
    first && !by_sub_spawn
}

thread_local! {
    static TEST_ADMITS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// How many starts this thread has counted under `cfg(test)`.
#[cfg(test)]
pub fn test_admits() -> usize {
    TEST_ADMITS.with(|n| n.get())
}

/// Shows Joe one card in the window of the chat that hit the cap, so a loop he did
/// not start is seen instead of silently refused. The card needs no answer.
pub async fn tell_joe(state: &std::sync::Arc<crate::daemon::state::DaemonState>, session_id: &str) {
    use crate::daemon::subchats::cards::{raise_card, CardOption, RaisedCard};
    let card = RaisedCard {
        kind: "spawn_guard",
        display_session_id: session_id.to_string(),
        sub_id: None,
        header: "Chat start limit".to_string(),
        question: format!(
            "{LIMIT} chats were started by chats, schedules or Jarvis in {} minutes, so one more was refused: that pattern looks like a loop. Nothing else was stopped. Check which chat keeps starting others; starting a chat by hand still works.",
            WINDOW.as_secs() / 60
        ),
        options: vec![CardOption::new("Got it", "Dismiss. Chats can start again as the window clears.")],
        domain: Some("tooling"),
    };
    if let Err(e) = raise_card(state, card).await {
        log::debug!("spawn guard: no card for {session_id}: {e}");
    }
}

pub fn refusal(wait: Duration) -> String {
    format!(
        "Chat start limit: {LIMIT} chats were started by chats, schedules or Jarvis in the last {} minutes, which looks like a loop, so this one was refused. Wait about {} seconds, or ask Joe to start it by hand. Do not retry in a loop.",
        WINDOW.as_secs() / 60,
        wait.as_secs().max(1)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_twenty_first_start_inside_the_window_is_refused_and_only_the_first_refusal_is_flagged() {
        let mut s = Starts::default();
        let t0 = Instant::now();
        for i in 0..LIMIT {
            assert_eq!(s.admit(t0 + Duration::from_secs(i as u64)), Verdict::Allowed, "start {i}");
        }
        let now = t0 + Duration::from_secs(30);
        match s.admit(now) {
            Verdict::Refused { first, wait } => {
                assert!(first);
                assert_eq!(wait, WINDOW - Duration::from_secs(30), "waits for the oldest start to age out");
            }
            v => panic!("{v:?}"),
        }
        assert!(matches!(s.admit(now), Verdict::Refused { first: false, .. }), "one card per burst");
    }

    #[test]
    fn starts_age_out_and_the_guard_reopens() {
        let mut s = Starts::default();
        let t0 = Instant::now();
        for _ in 0..LIMIT {
            s.admit(t0);
        }
        assert!(matches!(s.admit(t0 + Duration::from_secs(10)), Verdict::Refused { .. }));
        assert_eq!(s.admit(t0 + WINDOW), Verdict::Allowed, "a start leaves the window after exactly WINDOW");
        // A new burst is flagged again.
        for _ in 1..LIMIT {
            s.admit(t0 + WINDOW);
        }
        assert!(matches!(s.admit(t0 + WINDOW), Verdict::Refused { first: true, .. }));
    }

    #[test]
    fn a_normal_fan_out_passes() {
        let mut s = Starts::default();
        let t0 = Instant::now();
        // The busiest recorded burst: 9 in about 5 minutes, twice over.
        for i in 0..18 {
            assert_eq!(s.admit(t0 + Duration::from_secs(i * 30)), Verdict::Allowed);
        }
    }

    #[test]
    fn a_burst_of_queued_registrations_is_accepted_and_spends_nothing() {
        let mut s = Starts::default();
        let t0 = Instant::now();
        // 30 chained subs registered at once: none has started.
        for i in 0..30 {
            assert_eq!(s.gate(t0, false, true), Verdict::Allowed, "registration {i}");
        }
        assert!(s.at.is_empty(), "registering counted nothing");
        // Their starts count one at a time, and a real start still goes through.
        for i in 0..LIMIT {
            assert_eq!(s.gate(t0 + Duration::from_secs(i as u64), true, false), Verdict::Allowed, "start {i}");
        }
    }

    #[test]
    fn real_starts_still_trip_the_guard_and_a_queued_registration_is_refused_then_too() {
        let mut s = Starts::default();
        let t0 = Instant::now();
        for _ in 0..LIMIT {
            s.record(t0);
        }
        assert!(matches!(s.gate(t0, true, false), Verdict::Refused { first: true, .. }), "the 21st real start is refused");
        assert!(matches!(s.gate(t0, false, false), Verdict::Refused { first: false, .. }), "a loop's queued registration is refused too");
        assert_eq!(s.at.len(), LIMIT, "a refusal counts nothing");
        assert_eq!(s.gate(t0 + WINDOW, false, false), Verdict::Allowed, "the window clears");
    }

    #[test]
    fn a_main_chats_sub_refusal_does_not_use_up_the_bursts_card() {
        let mut s = Starts::default();
        let t0 = Instant::now();
        for _ in 0..LIMIT {
            s.record(t0);
        }
        assert!(matches!(s.gate(t0, true, true), Verdict::Refused { first: true, .. }));
        assert!(matches!(s.gate(t0, true, true), Verdict::Refused { first: true, .. }), "a sub spawn's refusal never marks Joe as told");
        assert!(matches!(s.gate(t0, true, false), Verdict::Refused { first: true, .. }), "the unattended loop still gets its card");
        assert!(matches!(s.gate(t0, true, false), Verdict::Refused { first: false, .. }));
    }

    #[test]
    fn a_main_chats_sub_refusal_never_draws_a_card_but_an_unattended_loop_does_once() {
        assert!(!card_wanted(true, true), "a main chat's sub spawn gets the tool error only");
        assert!(card_wanted(true, false), "a loop with no main chat's sub behind it is shown to Joe");
        assert!(!card_wanted(false, false), "once per burst");
    }

    #[test]
    fn the_refusal_says_what_happened_and_what_to_do() {
        let text = refusal(Duration::from_secs(42));
        assert!(text.contains("20 chats") && text.contains("42 seconds") && text.contains("by hand"), "{text}");
    }
}
