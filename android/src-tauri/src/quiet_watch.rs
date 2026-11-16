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

/// Time with frames sent and no acknowledgement back after which iroh is told
/// the network may have changed, and after which the connection is dropped.
/// Shorter than the quiet limits: silence can be a healthy idle link, but an
/// ACK is due about 25ms after a frame arrives, so seconds without one while
/// the PC's datagrams still come in means the path we send on is swallowing
/// them. Measured 2026-11-16: opening a chat sat 40s on such a connection
/// while a redial on a fresh endpoint takes about 150ms.
pub(crate) const UPLINK_NUDGE: Duration = Duration::from_secs(4);
pub(crate) const UPLINK_DEAD: Duration = Duration::from_secs(8);
const UPLINK_NUDGE_TICKS: u32 = (UPLINK_NUDGE.as_millis() / WATCHDOG_TICK.as_millis()) as u32;
pub(crate) const UPLINK_DEAD_TICKS: u32 = (UPLINK_DEAD.as_millis() / WATCHDOG_TICK.as_millis()) as u32;

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

/// Counters read off a connection once per watchdog tick.
#[derive(Default, Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Traffic {
    /// UDP datagrams received from the PC.
    pub rx: u64,
    /// Ack-eliciting frames this side sent (STREAM and PING, retransmissions
    /// included): each one makes the PC acknowledge within ~25ms when it arrives.
    pub sent: u64,
    /// ACK frames received from the PC.
    pub acked: u64,
}

/// The counters of a live connection. `PATH_ACK` counts too: with multipath
/// negotiated the PC acknowledges on it instead of on a plain ACK.
pub(crate) fn read_traffic(conn: &iroh::endpoint::Connection) -> Traffic {
    let stats = conn.stats();
    Traffic {
        rx: stats.udp_rx.datagrams,
        sent: stats.frame_tx.stream + stats.frame_tx.ping,
        acked: stats.frame_rx.acks + stats.frame_rx.path_acks,
    }
}

/// One tick of the acknowledgement watch: `(verdict, ticks spent waiting)`.
///
/// The received-traffic watch only sees the downlink. A phone whose uplink
/// died while the PC's datagrams (its keep-alive PINGs, the heartbeat frames)
/// keep arriving receives something every few seconds, so that watch stays
/// quiet while every request the page sends vanishes, until iroh heals the
/// path on its own (journal 2026-11-13/14: 35-57s of silent requests with no
/// `quiet` line, the global stream's ping unanswered). Here the signal is the
/// uplink's own: the connection has sent ack-eliciting frames and the PC's
/// ACK counter has not moved since. QUIC backs its retransmissions off
/// exponentially, so `sent` is not required to move on every tick: once a
/// wait has started it runs until an ACK arrives. A connection that sends
/// nothing never waits, because an idle one gets no ACKs at all (the PC's
/// PINGs are acknowledged by us, not the other way round).
fn uplink_step(prev: Traffic, cur: Traffic, waiting: u32, streams_open: usize) -> (QuietVerdict, u32) {
    if streams_open == 0 || cur.acked != prev.acked {
        return (QuietVerdict::Nothing, 0);
    }
    if cur.sent == prev.sent && waiting == 0 {
        return (QuietVerdict::Nothing, 0);
    }
    let waiting = waiting + 1;
    let verdict = if waiting >= UPLINK_DEAD_TICKS {
        QuietVerdict::Drop
    } else if waiting == UPLINK_NUDGE_TICKS {
        QuietVerdict::Nudge
    } else {
        QuietVerdict::Nothing
    };
    (verdict, waiting)
}

/// What one tick of both watches asks for.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Verdicts {
    /// The PC's datagrams stopped arriving.
    pub downlink: QuietVerdict,
    /// Datagrams arrive but nothing we send is acknowledged.
    pub uplink: QuietVerdict,
}

/// The watches' memory between ticks. It belongs to one connection: a
/// different `stable_id` starts it over.
#[derive(Default)]
pub(crate) struct QuietWatch {
    conn: Option<usize>,
    last: Traffic,
    quiet: u32,
    waiting: u32,
}

impl QuietWatch {
    pub(crate) fn step(&mut self, conn: usize, now: Traffic, streams_open: usize) -> Verdicts {
        if self.conn != Some(conn) {
            *self = Self { conn: Some(conn), last: now, quiet: 0, waiting: 0 };
            return Verdicts { downlink: QuietVerdict::Nothing, uplink: QuietVerdict::Nothing };
        }
        let (downlink, quiet) = quiet_step(self.last.rx, now.rx, self.quiet, streams_open);
        let (uplink, waiting) = uplink_step(self.last, now, self.waiting, streams_open);
        self.last = now;
        self.quiet = quiet;
        self.waiting = waiting;
        Verdicts { downlink, uplink }
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
        let still = Traffic { rx: 9, ..Traffic::default() };
        let mut watch = QuietWatch::default();
        assert_eq!(watch.step(1, still, 1).downlink, QuietVerdict::Nothing, "the first sample is only a baseline");
        for _ in 0..QUIET_DEAD_TICKS - 1 {
            watch.step(1, still, 1);
        }
        assert_eq!(watch.quiet, QUIET_DEAD_TICKS - 1);
        // One tick from a drop on connection 1; connection 2 must not inherit it.
        assert_eq!(watch.step(2, still, 1).downlink, QuietVerdict::Nothing);
        assert_eq!(watch.quiet, 0);
        assert_eq!(watch.step(2, still, 1).downlink, QuietVerdict::Nothing);
        assert_eq!(watch.quiet, 1);
    }

    fn traffic(rx: u64, sent: u64, acked: u64) -> Traffic {
        Traffic { rx, sent, acked }
    }

    /// The journal case: datagrams keep arriving, requests keep being sent, the
    /// PC acknowledges none of it. The receive watch sees a healthy link.
    #[test]
    fn data_sent_and_never_acknowledged_nudges_at_4s_and_drops_at_8s_while_datagrams_arrive() {
        assert_eq!((UPLINK_NUDGE_TICKS, UPLINK_DEAD_TICKS), (2, 4));
        let mut watch = QuietWatch::default();
        watch.step(1, traffic(10, 5, 5), 2);
        let mut nudges = Vec::new();
        let mut drops = Vec::new();
        for tick in 1..=UPLINK_DEAD_TICKS {
            // rx moves every tick; `sent` moves once, on the first tick, and then
            // stays put as QUIC's backed-off retransmissions are spaced out.
            let v = watch.step(1, traffic(10 + u64::from(tick), 6, 5), 2);
            assert_eq!(v.downlink, QuietVerdict::Nothing, "datagrams are arriving");
            match v.uplink {
                QuietVerdict::Nudge => nudges.push(tick),
                QuietVerdict::Drop => drops.push(tick),
                QuietVerdict::Nothing => {}
            }
        }
        assert_eq!(nudges, vec![UPLINK_NUDGE_TICKS]);
        assert_eq!(drops, vec![UPLINK_DEAD_TICKS]);
    }

    #[test]
    fn an_acknowledgement_ends_the_wait() {
        let mut watch = QuietWatch::default();
        watch.step(1, traffic(1, 1, 1), 1);
        for tick in 0..UPLINK_DEAD_TICKS - 1 {
            watch.step(1, traffic(2 + u64::from(tick), 2, 1), 1);
        }
        assert_eq!(watch.waiting, UPLINK_DEAD_TICKS - 1);
        assert_eq!(watch.step(1, traffic(99, 2, 2), 1).uplink, QuietVerdict::Nothing);
        assert_eq!(watch.waiting, 0, "one ACK is proof the uplink works");
    }

    /// An idle connection receives no ACKs because it sends nothing the PC would
    /// acknowledge; only the PC's own PINGs flow, and those are acknowledged by us.
    #[test]
    fn a_connection_that_sends_nothing_never_waits_for_acknowledgements() {
        let mut watch = QuietWatch::default();
        watch.step(1, traffic(1, 4, 4), 1);
        for tick in 1..=QUIET_DEAD_TICKS * 3 {
            let v = watch.step(1, traffic(1 + u64::from(tick), 4, 4), 1);
            assert_eq!(v.uplink, QuietVerdict::Nothing);
        }
        assert_eq!(watch.waiting, 0);
    }

    #[test]
    fn nobody_waiting_on_the_connection_means_no_uplink_verdict() {
        let mut watch = QuietWatch::default();
        watch.step(1, traffic(1, 1, 1), 0);
        for tick in 1..=QUIET_DEAD_TICKS * 2 {
            let v = watch.step(1, traffic(1, 1 + u64::from(tick), 1), 0);
            assert_eq!(v.uplink, QuietVerdict::Nothing);
        }
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
