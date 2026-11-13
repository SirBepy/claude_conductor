//! A rolling cap on chats that other chats, schedules and Jarvis start. A chat that
//! loops on `spawn_chat`, a respawn chain, or a scheduled prompt that schedules the
//! next one has no bound of its own: the guards elsewhere cap concurrent subs and
//! one respawn per turn, not the total started over time. Past [`LIMIT`] starts in
//! [`WINDOW`] the next one is refused and Joe is told once per window.
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
    fn admit(&mut self, now: Instant) -> Verdict {
        while self.at.front().is_some_and(|t| now.duration_since(*t) >= WINDOW) {
            self.at.pop_front();
        }
        if self.at.len() < LIMIT {
            self.at.push_back(now);
            self.told = false;
            return Verdict::Allowed;
        }
        let first = !self.told;
        self.told = true;
        let wait = self.at.front().map_or(WINDOW, |t| WINDOW.saturating_sub(now.duration_since(*t)));
        Verdict::Refused { first, wait }
    }
}

static STARTS: LazyLock<Mutex<Starts>> = LazyLock::new(|| Mutex::new(Starts::default()));

/// Why a start was refused, for the caller to return and, on the first refusal of
/// a burst, to show Joe.
#[derive(Debug)]
pub struct Refused {
    pub text: String,
    pub first: bool,
}

/// Counts one chat start made by a chat, a schedule or Jarvis; `source` names the
/// path in the log.
pub fn admit(source: &str) -> Result<(), Refused> {
    // The lib's tests share one process and start far more than LIMIT chats between
    // them; the rolling logic is covered on `Starts` directly.
    if cfg!(test) {
        return Ok(());
    }
    match STARTS.lock().unwrap_or_else(|e| e.into_inner()).admit(Instant::now()) {
        Verdict::Allowed => Ok(()),
        Verdict::Refused { first, wait } => {
            if first {
                log::warn!(
                    "spawn guard: {LIMIT} chats started in {}s, refusing the next one (from {source}); waits {}s",
                    WINDOW.as_secs(),
                    wait.as_secs()
                );
            }
            Err(Refused { text: refusal(wait), first })
        }
    }
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
    fn the_refusal_says_what_happened_and_what_to_do() {
        let text = refusal(Duration::from_secs(42));
        assert!(text.contains("20 chats") && text.contains("42 seconds") && text.contains("by hand"), "{text}");
    }
}
