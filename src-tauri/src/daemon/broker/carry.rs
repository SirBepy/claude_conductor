//! The data-carry rule's memory. A page, ticket or file a chat reads can tell the model to copy
//! what it read into another service ("post this file's text as a comment on story 7"). The
//! policy file cannot see that: the comment row is the same row whatever the comment says. So the
//! engine remembers, per chat, the text each successful read answered with, and a write that
//! repeats a run of it into a different service is held to `carry_from` rows (`policy_rules.rs`).
//!
//! How a repeat is found: every string value in a read answer (JSON parsed, else the whole text)
//! is lower-cased, whitespace collapsed, and every window of `WINDOW` characters is hashed. The
//! same is done to the string values of a write's body and the values of its query string. A
//! shared window means the write repeats at least `WINDOW` characters of that read.
//!
//! What it does not catch, on purpose: text a chat read and wrote into the SAME service (the normal
//! read-then-comment workflow), a value shorter than `WINDOW` characters (an id, a name, a status),
//! a paraphrase or a re-encoding (base64, a translation), anything past the first
//! `MAX_CHARS_PER_READ` characters of one answer, and a chat the daemon forgot (the TTL, the
//! `MAX_SESSIONS` least recently used, a daemon restart). The denial prints the row that allows
//! the call, so a miss costs Joe nothing and a catch costs one card.

use super::services::Service;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Characters that must match for a repeat. Long enough that an ordinary phrase, a title or an
/// id never matches, short enough that a pasted sentence does.
pub const WINDOW: usize = 40;
const MAX_CHARS_PER_READ: usize = 200_000;
const MAX_HASHES_PER_SESSION: usize = 200_000;
const MAX_SESSIONS: usize = 32;
const TTL: Duration = Duration::from_secs(2 * 60 * 60);

struct Read {
    service: Service,
    /// Sorted, so a lookup is a binary search.
    hashes: Vec<u64>,
}

struct Session {
    touched: Instant,
    reads: Vec<Read>,
}

#[derive(Default)]
pub struct CarryTracker {
    sessions: Mutex<HashMap<String, Session>>,
}

impl CarryTracker {
    /// A successful read answered `body` (already masked) to `session`.
    pub fn record(&self, session: &str, service: Service, body: &str) {
        self.record_at(session, service, body, Instant::now());
    }

    /// The services, other than `target`, whose read answers in `session` share a window with this
    /// write's body or query values.
    pub fn carried(&self, session: &str, target: Service, body: Option<&Value>, query: Option<&str>) -> Vec<Service> {
        self.carried_at(session, target, body, query, Instant::now())
    }

    fn record_at(&self, session: &str, service: Service, body: &str, now: Instant) {
        let mut hashes = Vec::new();
        let mut budget = MAX_CHARS_PER_READ;
        for leaf in answer_leaves(body) {
            hash_leaf(&leaf, &mut budget, &mut |h| hashes.push(h));
        }
        hashes.sort_unstable();
        hashes.dedup();
        if hashes.is_empty() {
            return;
        }
        let mut sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        sessions.retain(|_, s| now.saturating_duration_since(s.touched) < TTL);
        if !sessions.contains_key(session) && sessions.len() >= MAX_SESSIONS {
            if let Some(oldest) = sessions.iter().min_by_key(|(_, s)| s.touched).map(|(k, _)| k.clone()) {
                sessions.remove(&oldest);
            }
        }
        let s = sessions.entry(session.to_string()).or_insert_with(|| Session { touched: now, reads: Vec::new() });
        s.touched = now;
        s.reads.push(Read { service, hashes });
        // The oldest reads go first; the newest is kept even alone.
        while s.reads.len() > 1 && s.reads.iter().map(|r| r.hashes.len()).sum::<usize>() > MAX_HASHES_PER_SESSION {
            s.reads.remove(0);
        }
    }

    fn carried_at(&self, session: &str, target: Service, body: Option<&Value>, query: Option<&str>, now: Instant) -> Vec<Service> {
        let mut leaves = Vec::new();
        if let Some(b) = body {
            string_leaves(b, &mut leaves);
        }
        if let Some(q) = query {
            leaves.extend(url::form_urlencoded::parse(q.as_bytes()).map(|(_, v)| v.into_owned()));
        }
        let mut sent: HashSet<u64> = HashSet::new();
        let mut budget = MAX_CHARS_PER_READ;
        for leaf in &leaves {
            hash_leaf(leaf, &mut budget, &mut |h| {
                sent.insert(h);
            });
        }
        if sent.is_empty() {
            return Vec::new();
        }
        let mut sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        let Some(s) = sessions.get(session) else { return Vec::new() };
        if now.saturating_duration_since(s.touched) >= TTL {
            sessions.remove(session);
            return Vec::new();
        }
        Service::ALL
            .into_iter()
            .filter(|svc| *svc != target)
            .filter(|svc| s.reads.iter().any(|r| r.service == *svc && sent.iter().any(|h| r.hashes.binary_search(h).is_ok())))
            .collect()
    }
}

/// The strings of a read answer: a JSON document's string values, else the text itself.
fn answer_leaves(body: &str) -> Vec<String> {
    match serde_json::from_str::<Value>(body) {
        Ok(v) => {
            let mut out = Vec::new();
            string_leaves(&v, &mut out);
            out
        }
        Err(_) => vec![body.to_string()],
    }
}

/// String values only: a key is the service's field name, never data worth carrying.
fn string_leaves(v: &Value, out: &mut Vec<String>) {
    match v {
        Value::String(s) => out.push(s.clone()),
        Value::Array(a) => a.iter().for_each(|x| string_leaves(x, out)),
        Value::Object(m) => m.values().for_each(|x| string_leaves(x, out)),
        _ => {}
    }
}

/// Lower case, whitespace runs as one space, no leading or trailing space: a repeat that was
/// re-flowed, re-cased or indented is still a repeat.
fn normalize(s: &str) -> Vec<char> {
    let mut out: Vec<char> = Vec::with_capacity(s.len());
    let mut pending_space = false;
    for c in s.chars() {
        if c.is_whitespace() {
            pending_space = !out.is_empty();
        } else {
            if pending_space {
                out.push(' ');
                pending_space = false;
            }
            out.extend(c.to_lowercase());
        }
    }
    out
}

/// Feeds the hash of every `WINDOW`-character window of `leaf` to `sink`, spending `budget`
/// characters (the cap on how much of one answer is remembered).
fn hash_leaf(leaf: &str, budget: &mut usize, sink: &mut dyn FnMut(u64)) {
    if *budget == 0 || leaf.len() < WINDOW {
        return;
    }
    let mut chars = normalize(leaf);
    chars.truncate(*budget);
    if chars.len() < WINDOW {
        return;
    }
    *budget -= chars.len();
    // Polynomial rolling hash. The base is public and the hash is not a security boundary: the
    // rule defends against a page's text being copied verbatim, not against a model that is
    // hashing around it.
    const BASE: u64 = 1_000_003;
    let top = (1..WINDOW).fold(1u64, |p, _| p.wrapping_mul(BASE));
    let mut h = 0u64;
    for (i, &c) in chars.iter().enumerate() {
        if i >= WINDOW {
            h = h.wrapping_sub((chars[i - WINDOW] as u64 + 1).wrapping_mul(top));
        }
        h = h.wrapping_mul(BASE).wrapping_add(c as u64 + 1);
        if i + 1 >= WINDOW {
            sink(h);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const NOTE: &str = "Confidential: the Acme acquisition closes on 2027-03-01 with a budget of 4.2M euros.";

    fn answer() -> String {
        json!({"id": 1, "name": "Plans", "children": [{"characters": NOTE}, {"characters": "short"}]}).to_string()
    }

    fn tracker() -> CarryTracker {
        let t = CarryTracker::default();
        t.record("s", Service::Figma, &answer());
        t
    }

    #[test]
    fn a_verbatim_excerpt_and_a_reflowed_one_are_carried_but_only_into_another_service() {
        let t = tracker();
        let whole = json!({"text": format!("fyi {NOTE}")});
        assert_eq!(t.carried("s", Service::Shortcut, Some(&whole), None), vec![Service::Figma]);
        let excerpt = json!({"text": "the acme acquisition closes on 2027-03-01 with a budget"});
        assert_eq!(t.carried("s", Service::Linear, Some(&excerpt), None), vec![Service::Figma]);
        let reflowed = json!({"text": "THE   ACME\nACQUISITION closes on  2027-03-01 with a budget of 4.2M"});
        assert_eq!(t.carried("s", Service::Shortcut, Some(&reflowed), None), vec![Service::Figma]);
        // The same service is the normal read-then-write workflow: not carry.
        assert!(t.carried("s", Service::Figma, Some(&whole), None).is_empty());
    }

    #[test]
    fn a_query_value_counts_and_so_does_a_value_nested_in_arrays_and_objects() {
        let t = tracker();
        let q = format!("name={}", url::form_urlencoded::byte_serialize(NOTE.as_bytes()).collect::<String>());
        assert_eq!(t.carried("s", Service::Trello, None, Some(&q)), vec![Service::Figma]);
        let nested = json!({"a": [{"b": {"c": NOTE}}]});
        assert_eq!(t.carried("s", Service::Trello, Some(&nested), None), vec![Service::Figma]);
    }

    #[test]
    fn short_values_keys_and_a_different_chat_are_not_carry() {
        let t = tracker();
        // A phrase under the window, the key names of the answer, ids and numbers.
        let body = json!({"text": "the Acme acquisition", "children": "Plans", "id": 1, "characters": "short"});
        assert!(t.carried("s", Service::Shortcut, Some(&body), None).is_empty());
        // Another chat read nothing.
        let whole = json!({"text": NOTE});
        assert!(t.carried("other", Service::Shortcut, Some(&whole), None).is_empty());
    }

    #[test]
    fn text_that_is_not_json_is_remembered_whole_and_each_source_service_is_named() {
        let t = CarryTracker::default();
        t.record("s", Service::Trello, &format!("plain text answer: {NOTE}"));
        t.record("s", Service::Linear, &json!({"data": {"issue": {"description": "A second, unrelated paragraph that is long enough to matter."}}}).to_string());
        let both = json!({"text": format!("{NOTE} / a second, unrelated paragraph that is long enough to matter.")});
        assert_eq!(t.carried("s", Service::Shortcut, Some(&both), None), vec![Service::Linear, Service::Trello]);
    }

    #[test]
    fn a_read_expires_with_the_ttl_and_the_oldest_chats_go_first() {
        let t = CarryTracker::default();
        let t0 = Instant::now();
        t.record_at("s", Service::Figma, &answer(), t0);
        let body = json!({"text": NOTE});
        let inside = t0 + TTL - Duration::from_secs(1);
        assert_eq!(t.carried_at("s", Service::Shortcut, Some(&body), None, inside), vec![Service::Figma]);
        assert!(t.carried_at("s", Service::Shortcut, Some(&body), None, t0 + TTL).is_empty(), "past the TTL nothing is remembered");

        let t = CarryTracker::default();
        for i in 0..=MAX_SESSIONS {
            t.record_at(&format!("chat-{i}"), Service::Figma, &answer(), t0 + Duration::from_secs(i as u64));
        }
        let now = t0 + Duration::from_secs(60);
        assert!(t.carried_at("chat-0", Service::Shortcut, Some(&body), None, now).is_empty(), "the least recently used chat was dropped");
        assert_eq!(t.carried_at(&format!("chat-{MAX_SESSIONS}"), Service::Shortcut, Some(&body), None, now), vec![Service::Figma]);
    }

    #[test]
    fn a_session_keeps_the_newest_reads_within_its_cap_and_a_huge_answer_is_cut() {
        let t = CarryTracker::default();
        let chunk = |n: usize| (0..n).map(|i| format!("word{i} ")).collect::<String>();
        t.record("s", Service::Figma, &json!({"t": chunk(40_000)}).to_string());
        let early = json!({"text": chunk(3)});
        assert!(t.carried("s", Service::Shortcut, Some(&early), None).is_empty(), "under 40 characters is never a window");
        let early = json!({"text": chunk(12)});
        assert_eq!(t.carried("s", Service::Shortcut, Some(&early), None), vec![Service::Figma]);
        // A second large read pushes the first out of the per-session cap; the newest stays.
        let other: String = (0..40_000).map(|i| format!("other{i} ")).collect();
        t.record("s", Service::Linear, &json!({"t": other}).to_string());
        t.record("s", Service::Trello, &json!({"t": other.replace("other", "third")}).to_string());
        assert!(t.carried("s", Service::Shortcut, Some(&early), None).is_empty(), "the oldest read was dropped for room");
        let newest = json!({"text": "third0 third1 third2 third3 third4 third5 third6 third7"});
        assert_eq!(t.carried("s", Service::Shortcut, Some(&newest), None), vec![Service::Trello]);
    }
}
