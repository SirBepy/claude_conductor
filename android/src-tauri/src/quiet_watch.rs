//! The received-traffic watch: how long a connection somebody is waiting on has
//! heard nothing, and the gauge of forwarded streams it is judged against.

use std::sync::atomic::Ordering;
use std::time::Duration;

use crate::iroh_tunnel::WATCHDOG_TICK;

/// Quiet time (no datagram received on a connection in use) after which iroh is
/// told the network may have changed. If the phone really moved networks this is
/// what makes iroh re-check its relay link; otherwise it is a harmless no-op.
pub(crate) const QUIET_NUDGE: Duration = Duration::from_secs(8);

/// Quiet time after which a connection in use is declared dead and dropped, so
/// the page's sockets close at once and redial instead of hanging until QUIC's
/// 30s idle timeout (which stays: iroh keeps a connection across short relay
/// outages on purpose). Both ends send a keep-alive PING after 5s of silence and
/// a PING is acknowledged, so a healthy connection receives a datagram every few
/// seconds. 12s is two missed keep-alives plus margin, and above the 7s relay
/// stalls measured on this setup.
pub(crate) const QUIET_DEAD: Duration = Duration::from_secs(12);

/// `QUIET_NUDGE` and `QUIET_DEAD` in watchdog ticks. Quiet time is counted in
/// ticks that ran, never in clock time: a frozen process runs no ticks, so
/// sleeping is never quiet (the resume check owns that case).
const QUIET_NUDGE_TICKS: u32 = (QUIET_NUDGE.as_millis() / WATCHDOG_TICK.as_millis()) as u32;
pub(crate) const QUIET_DEAD_TICKS: u32 = (QUIET_DEAD.as_millis() / WATCHDOG_TICK.as_millis()) as u32;

/// What one tick of the received-traffic watch asks for.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum QuietVerdict {
    Nothing,
    Nudge,
    Drop,
}

/// One tick of the received-traffic watch: `(verdict, quiet ticks so far)`.
/// Only a connection in use (`streams_open > 0`) is judged: with no stream
/// open nobody is waiting, so a quiet connection is left to QUIC. The nudge
/// fires on exactly one tick per quiet spell, the one that reaches
/// `QUIET_NUDGE_TICKS`.
fn quiet_step(prev_rx: u64, rx: u64, quiet: u32, streams_open: usize) -> (QuietVerdict, u32) {
    if streams_open == 0 || rx != prev_rx {
        return (QuietVerdict::Nothing, 0);
    }
    let quiet = quiet + 1;
    let verdict = if quiet >= QUIET_DEAD_TICKS {
        QuietVerdict::Drop
    } else if quiet == QUIET_NUDGE_TICKS {
        QuietVerdict::Nudge
    } else {
        QuietVerdict::Nothing
    };
    (verdict, quiet)
}

/// The watch's memory between ticks. It belongs to one connection: a different
/// `stable_id` starts it over.
#[derive(Default)]
pub(crate) struct QuietWatch {
    conn: Option<usize>,
    rx: u64,
    quiet: u32,
}

impl QuietWatch {
    pub(crate) fn step(&mut self, conn: usize, rx: u64, streams_open: usize) -> QuietVerdict {
        if self.conn != Some(conn) {
            *self = Self { conn: Some(conn), rx, quiet: 0 };
            return QuietVerdict::Nothing;
        }
        let (verdict, quiet) = quiet_step(self.rx, rx, self.quiet, streams_open);
        self.rx = rx;
        self.quiet = quiet;
        verdict
    }
}

/// Counts one open forwarded stream for as long as it lives, so every exit of
/// `forward` (error, cancel, normal end) releases it.
pub(crate) struct StreamGauge<'a>(&'a std::sync::atomic::AtomicUsize);

impl<'a> StreamGauge<'a> {
    pub(crate) fn new(open: &'a std::sync::atomic::AtomicUsize) -> Self {
        open.fetch_add(1, Ordering::SeqCst);
        Self(open)
    }
}

impl Drop for StreamGauge<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_quiet_marks_are_8_and_12_seconds_of_watchdog_ticks() {
        assert_eq!(QUIET_NUDGE_TICKS, 4);
        assert_eq!(QUIET_DEAD_TICKS, 6);
    }

    #[test]
    fn a_moving_counter_never_triggers_and_resets_the_quiet_count() {
        let mut quiet = 0;
        let mut rx = 10;
        for _ in 0..50 {
            let (verdict, q) = quiet_step(rx, rx + 1, quiet, 3);
            assert_eq!(verdict, QuietVerdict::Nothing);
            assert_eq!(q, 0);
            rx += 1;
            quiet = q;
        }
        // Movement after a long quiet spell starts the count over.
        let (verdict, q) = quiet_step(5, 6, QUIET_DEAD_TICKS - 1, 1);
        assert_eq!((verdict, q), (QuietVerdict::Nothing, 0));
    }

    #[test]
    fn a_still_counter_with_a_stream_open_nudges_at_8s_once_and_drops_at_12s() {
        let mut quiet = 0;
        let mut seen = Vec::new();
        for tick in 1..=QUIET_DEAD_TICKS {
            let (verdict, q) = quiet_step(7, 7, quiet, 1);
            seen.push((tick, verdict));
            quiet = q;
        }
        let nudges: Vec<u32> = seen.iter().filter(|(_, v)| *v == QuietVerdict::Nudge).map(|(t, _)| *t).collect();
        assert_eq!(nudges, vec![QUIET_NUDGE_TICKS], "one nudge, on the tick that reaches 8s");
        let drops: Vec<u32> = seen.iter().filter(|(_, v)| *v == QuietVerdict::Drop).map(|(t, _)| *t).collect();
        assert_eq!(drops, vec![QUIET_DEAD_TICKS], "one drop, on the tick that reaches 12s");
    }

    #[test]
    fn a_still_counter_with_no_stream_open_never_triggers_and_does_not_accumulate() {
        let mut quiet = 0;
        for _ in 0..50 {
            let (verdict, q) = quiet_step(7, 7, quiet, 0);
            assert_eq!(verdict, QuietVerdict::Nothing);
            assert_eq!(q, 0);
            quiet = q;
        }
        // A stream opening after a long idle spell starts its count at one tick.
        assert_eq!(quiet_step(7, 7, quiet, 1), (QuietVerdict::Nothing, 1));
    }

    #[test]
    fn a_different_connection_starts_the_watch_over() {
        let mut watch = QuietWatch::default();
        assert_eq!(watch.step(1, 9, 1), QuietVerdict::Nothing, "the first sample is only a baseline");
        for _ in 0..QUIET_DEAD_TICKS - 1 {
            watch.step(1, 9, 1);
        }
        assert_eq!(watch.quiet, QUIET_DEAD_TICKS - 1);
        // One tick from a drop on connection 1; connection 2 must not inherit it.
        assert_eq!(watch.step(2, 9, 1), QuietVerdict::Nothing);
        assert_eq!(watch.quiet, 0);
        assert_eq!(watch.step(2, 9, 1), QuietVerdict::Nothing);
        assert_eq!(watch.quiet, 1);
    }

    #[test]
    fn the_stream_gauge_counts_while_it_lives() {
        let open = std::sync::atomic::AtomicUsize::new(0);
        let a = StreamGauge::new(&open);
        let b = StreamGauge::new(&open);
        assert_eq!(open.load(Ordering::SeqCst), 2);
        drop(a);
        assert_eq!(open.load(Ordering::SeqCst), 1);
        drop(b);
        assert_eq!(open.load(Ordering::SeqCst), 0);
    }
}
