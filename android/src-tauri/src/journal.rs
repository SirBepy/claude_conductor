//! A small in-memory journal of what the tunnel did, readable by the page.
//!
//! The phone's own events never reached the PC, so a "keeps disconnecting"
//! report could only be investigated from the PC's side. The page reads this
//! from the tunnel's journal port (the loopback port + 1) and uploads it; a
//! same-port path would ride a kept-alive connection that is already spliced
//! to the PC. The journal is process-wide
//! (`global`) because the tunnel is rebuilt when the user switches PC and the
//! history must outlive that.
//!
//! Details never carry a token, a full endpoint id or an address.

use std::collections::VecDeque;
use std::sync::{Arc, LazyLock, Mutex};

const CAPACITY: usize = 200;
const DETAIL_MAX_CHARS: usize = 200;

struct Event {
    t: u64,
    k: String,
    d: String,
}

pub struct Journal {
    /// A std mutex: held for a push or a copy only, never across an await.
    events: Mutex<VecDeque<Event>>,
}

static GLOBAL: LazyLock<Arc<Journal>> = LazyLock::new(|| Arc::new(Journal::new()));

/// The journal every tunnel of this process writes to.
pub fn global() -> Arc<Journal> {
    GLOBAL.clone()
}

impl Journal {
    pub fn new() -> Self {
        Self { events: Mutex::new(VecDeque::new()) }
    }

    /// Appends an event stamped `now_ms` (wall clock), dropping the oldest past `CAPACITY`.
    pub fn record(&self, now_ms: u64, kind: &str, detail: &str) {
        let event = Event { t: now_ms, k: kind.to_string(), d: detail.chars().take(DETAIL_MAX_CHARS).collect() };
        let mut events = self.events.lock().unwrap_or_else(|p| p.into_inner());
        if events.len() >= CAPACITY {
            events.pop_front();
        }
        events.push_back(event);
    }

    /// The whole journal as JSON, newest event last. Reading does not clear it.
    pub fn snapshot_json(&self, now_ms: u64) -> String {
        let events = self.events.lock().unwrap_or_else(|p| p.into_inner());
        let mut out = format!("{{\"v\":1,\"now_ms\":{now_ms},\"events\":[");
        for (i, e) in events.iter().enumerate() {
            if i > 0 {
                out.push(',');
            }
            out.push_str(&format!("{{\"t\":{},\"k\":\"", e.t));
            escape_into(&mut out, &e.k);
            out.push_str("\",\"d\":\"");
            escape_into(&mut out, &e.d);
            out.push_str("\"}");
        }
        out.push_str("]}");
        out
    }
}

fn escape_into(out: &mut String, s: &str) {
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_ring_keeps_the_newest_200_and_drops_the_oldest() {
        let j = Journal::new();
        for i in 0..250u64 {
            j.record(i, "k", &format!("n{i}"));
        }
        let json = j.snapshot_json(1000);
        assert_eq!(json.matches("\"k\":\"k\"").count(), 200);
        assert!(!json.contains("\"d\":\"n49\""), "the oldest events are dropped");
        assert!(json.contains("\"d\":\"n50\""));
        assert!(json.find("\"d\":\"n50\"").unwrap() < json.find("\"d\":\"n249\"").unwrap(), "newest last");
        assert!(json.ends_with("\"d\":\"n249\"}]}"), "{json}");
    }

    #[test]
    fn snapshot_json_escapes_quote_backslash_newline_and_control_characters() {
        let j = Journal::new();
        j.record(5, "k", "a\"b\\c\nd\u{1}");
        assert_eq!(
            j.snapshot_json(9),
            "{\"v\":1,\"now_ms\":9,\"events\":[{\"t\":5,\"k\":\"k\",\"d\":\"a\\\"b\\\\c\\nd\\u0001\"}]}"
        );
    }

    #[test]
    fn an_empty_journal_is_valid_and_a_detail_is_cut_to_200_chars() {
        let j = Journal::new();
        assert_eq!(j.snapshot_json(1), "{\"v\":1,\"now_ms\":1,\"events\":[]}");
        j.record(2, "k", &"x".repeat(500));
        assert_eq!(j.snapshot_json(3).matches('x').count(), 200);
    }
}
