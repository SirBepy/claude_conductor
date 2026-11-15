//! The model of "same personal settings on every paired machine" (todo pc-1455):
//! which `settings.json` keys are personal, how a local edit is stamped, and how
//! an incoming edit is merged. Pure: no transport, no disk. The transport (an
//! RPC on the peer link) and the save-path hook that calls [`stamp_changes`] are
//! later steps in the todo.
//!
//! Decided in the todo: last writer wins, per key, on a whitelist. A key that is
//! on neither list is NOT synced, so a field added later stays machine-local
//! until someone classifies it (the test below fails until they do). The
//! incoming payload is never trusted about what it may touch: a key outside
//! [`PERSONAL_KEYS`] is refused however it arrives, and a value that does not
//! fit [`Settings`] is refused without touching the local one.

use crate::types::Settings;
use chrono::{DateTime, Duration, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeMap;

/// Keys that mean the same thing on every machine. Named fields first, then the
/// dashboard-owned keys that ride in `Settings::extra` (the JSON is flat, so one
/// name serves both).
pub const PERSONAL_KEYS: &[&str] = &[
    "poll_interval_secs",
    "autoUpdate",
    "defaultCharacterWhitelist",
    "retention",
    "schedule_grace_secs",
    // `extra`: look and feel the dashboard saves.
    "colorApplyTo",
    "paceBand",
    "paceColors",
    "overlayBackgroundStyle",
    "dashboardWidgets",
    "backgroundEnabled",
    "backgroundVariant",
];

/// Named `Settings` fields that stay on their machine, with the reason each is
/// local. Every named field must be here or in [`PERSONAL_KEYS`].
pub const MACHINE_LOCAL_KEYS: &[&str] = &[
    "autostart",                      // the OS's startup entry on this machine
    "hook_port",                      // the port this daemon bound
    "projects",                       // folder paths exist per machine
    "hooks_registered",               // whether this machine's ~/.claude has the hook
    "hook_registration_declined",     // same
    "hook_install_version",           // same
    "legacy_obsidian_import_handled", // a one-time import on this machine
    "audioOutputDevice",              // a device id of this machine
    "sessionCharacters",              // session ids belong to the machine that hosts them
    "default_account_id",             // accounts are per machine
    "jarvis_session_id",              // a session on this machine
    "accounts_setup_prompt_dismissed",
    "settings_generation", // this machine's own save counter
];

pub fn is_personal(key: &str) -> bool {
    PERSONAL_KEYS.contains(&key)
}

/// Who wrote a key and when. Ordered by time, then by writer id so two machines
/// that stamp the same instant still agree on a winner.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Stamp {
    /// RFC 3339, UTC.
    pub at: String,
    /// The writing machine's id.
    pub by: String,
}

/// How far ahead of this machine's clock an incoming stamp may be. A stamp further
/// out is refused: it would win its key until that time arrived, whatever either
/// machine edited meanwhile.
pub const MAX_FUTURE_SKEW_MINUTES: i64 = 5;

/// True when `stamp` is far enough ahead of `now` that a merge refuses it (the same
/// test `merge_at` applies). A stamp that is not a time is refused for that reason,
/// not for a clock, so it is not "skewed".
pub fn is_skewed(stamp: &Stamp, now: DateTime<Utc>) -> bool {
    stamp.instant().is_some_and(|at| at > now + Duration::minutes(MAX_FUTURE_SKEW_MINUTES))
}

impl Stamp {
    /// The stamp's time as an instant. `at` is compared as a time, never as text:
    /// `...:00.5Z` sorts before `...:00Z` as a string and `12:00+02:00` after `11:00Z`.
    fn instant(&self) -> Option<DateTime<Utc>> {
        DateTime::parse_from_rfc3339(&self.at).ok().map(|d| d.with_timezone(&Utc))
    }

    /// An unreadable stamp loses to a readable one and ties with another unreadable one.
    fn beats(&self, other: &Stamp) -> bool {
        match (self.instant(), other.instant()) {
            (Some(a), Some(b)) => (a, &self.by) > (b, &other.by),
            (Some(_), None) => true,
            _ => false,
        }
    }
}

/// Per-key stamps. `#[serde(default)]` at every use: a file written before this
/// existed must still load (CLAUDE.md, todo 785).
pub type Clocks = BTreeMap<String, Stamp>;

/// One edited key, as it travels to a peer.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Change {
    pub key: String,
    pub value: Value,
    pub stamp: Stamp,
}

fn flat(settings: &Settings) -> Map<String, Value> {
    match serde_json::to_value(settings) {
        Ok(Value::Object(m)) => m,
        _ => Map::new(),
    }
}

/// The personal part of `settings`, for the first sync to a new peer.
pub fn personal_subset(settings: &Settings) -> Map<String, Value> {
    flat(settings).into_iter().filter(|(k, _)| is_personal(k)).collect()
}

/// True when `value` is what the UI shows for `key` while it is absent from the
/// settings file. Only the dashboard-owned keys (`Settings::extra`) can be absent;
/// the named fields always serialize.
fn is_what_absent_means(key: &str, value: &Value) -> bool {
    match key {
        "paceBand" => value == &Value::from(10),
        "overlayBackgroundStyle" => value == "circles",
        "backgroundEnabled" => value == &Value::Bool(false),
        "backgroundVariant" => value == "pattern",
        "paceColors" => {
            value
                == &serde_json::json!({"under": "#27ae60", "nearSafe": "#f1c40f", "nearOver": "#e67e22", "over": "#e74c3c"})
        }
        // Each toggle defaults on, so an object of only `true`s says nothing.
        "colorApplyTo" => value.as_object().is_some_and(|o| o.values().all(|v| v == &Value::Bool(true))),
        _ => false,
    }
}

/// Personal keys whose value differs between `old` and `new` (added, changed or removed).
/// A key that goes from absent to the value the UI already shows for an absent key
/// is not an edit: a fresh install's first Settings save writes those, and stamping
/// them would let a look nobody chose beat an older machine's custom one on the first pair.
pub fn changed_personal_keys(old: &Settings, new: &Settings) -> Vec<String> {
    let (old, new) = (flat(old), flat(new));
    PERSONAL_KEYS
        .iter()
        .filter(|k| old.get(**k) != new.get(**k))
        .filter(|k| !(old.get(**k).is_none() && new.get(**k).is_some_and(|v| is_what_absent_means(k, v))))
        .map(|k| k.to_string())
        .collect()
}

/// The time a local edit of a key with stamp `previous` is stamped: `now`, but never
/// at or before the stamp it replaces. A peer whose clock runs ahead leaves stamps
/// (accepted up to [`MAX_FUTURE_SKEW_MINUTES`] ahead) later than this machine's `now`,
/// and an edit stamped with `now` would lose to the value it just replaced.
fn local_stamp_time(now: &str, previous: Option<&Stamp>) -> String {
    let (Ok(now_t), Some(prev_t)) = (DateTime::parse_from_rfc3339(now), previous.and_then(Stamp::instant)) else {
        return now.to_string();
    };
    let next = prev_t + Duration::milliseconds(1);
    if next > now_t.with_timezone(&Utc) {
        next.to_rfc3339_opts(SecondsFormat::Millis, true)
    } else {
        now.to_string()
    }
}

/// Stamps every personal key a local save changed, and returns the changes to
/// send. A value that went away is sent as `null`, which a peer applies as
/// "back to the default". A key's stamp only ever moves forward (see
/// [`local_stamp_time`]).
pub fn stamp_changes(old: &Settings, new: &Settings, clocks: &mut Clocks, now: &str, by: &str) -> Vec<Change> {
    let new_flat = flat(new);
    let mut out = Vec::new();
    for key in changed_personal_keys(old, new) {
        let stamp = Stamp { at: local_stamp_time(now, clocks.get(&key)), by: by.to_string() };
        clocks.insert(key.clone(), stamp.clone());
        out.push(Change { value: new_flat.get(&key).cloned().unwrap_or(Value::Null), key, stamp });
    }
    out
}

/// The result of merging a peer's changes.
#[derive(Debug, PartialEq)]
pub struct Merged {
    pub settings: Settings,
    pub applied: Vec<String>,
    /// Keys not applied for a reason other than losing on time (not personal, or
    /// a value that does not fit), so the caller can log them.
    pub refused: Vec<String>,
}

/// Merges `incoming` into `local`, per key, last writer wins, as of `now` on this
/// machine's clock. `clocks` gains the winning stamp of every applied key. A change
/// whose stamp is not an RFC 3339 time, or is more than [`MAX_FUTURE_SKEW_MINUTES`]
/// ahead of `now`, is refused: a peer must not be able to win a key forever.
pub fn merge_at(local: &Settings, clocks: &mut Clocks, incoming: &[Change], now: DateTime<Utc>) -> Merged {
    let mut current = flat(local);
    let mut settings = local.clone();
    let mut applied = Vec::new();
    let mut refused = Vec::new();
    for change in incoming {
        if !is_personal(&change.key) {
            refused.push(change.key.clone());
            continue;
        }
        match change.stamp.instant() {
            Some(at) if at <= now + Duration::minutes(MAX_FUTURE_SKEW_MINUTES) => {}
            _ => {
                refused.push(change.key.clone());
                continue;
            }
        }
        if clocks.get(&change.key).is_some_and(|mine| !change.stamp.beats(mine)) {
            continue;
        }
        let mut next = current.clone();
        if change.value.is_null() {
            next.remove(&change.key);
        } else {
            next.insert(change.key.clone(), change.value.clone());
        }
        // `Settings` is `#[serde(default)]`, so a removed key reads as its default,
        // and a value of the wrong shape is caught here, before it replaces anything.
        match serde_json::from_value::<Settings>(Value::Object(next.clone())) {
            Ok(parsed) => {
                settings = parsed;
                // `timed_mute` is `#[serde(skip)]` (the tray's in-memory mute), so the
                // parsed copy never has it: carry this machine's over.
                settings.timed_mute = local.timed_mute;
                current = next;
                clocks.insert(change.key.clone(), change.stamp.clone());
                applied.push(change.key.clone());
            }
            Err(_) => refused.push(change.key.clone()),
        }
    }
    Merged { settings, applied, refused }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// The tests' clock: after every stamp they use, so none counts as ahead of it.
    fn merge(local: &Settings, clocks: &mut Clocks, incoming: &[Change]) -> Merged {
        let now = DateTime::parse_from_rfc3339("2026-11-16T00:00:00Z").unwrap().with_timezone(&Utc);
        merge_at(local, clocks, incoming, now)
    }

    fn stamp(at: &str, by: &str) -> Stamp {
        Stamp { at: at.to_string(), by: by.to_string() }
    }

    fn change(key: &str, value: Value, at: &str, by: &str) -> Change {
        Change { key: key.to_string(), value, stamp: stamp(at, by) }
    }

    /// Every top-level key `Settings` serializes (`extra` is flattened away) is
    /// classified exactly once, so a field added later cannot start syncing, or
    /// silently stay unclassified, without someone choosing.
    #[test]
    fn every_named_settings_field_is_classified_exactly_once() {
        let named: Vec<String> = flat(&Settings::default()).keys().cloned().collect();
        for key in &named {
            let personal = PERSONAL_KEYS.contains(&key.as_str());
            let local = MACHINE_LOCAL_KEYS.contains(&key.as_str());
            assert!(personal ^ local, "`{key}` must be in exactly one of PERSONAL_KEYS / MACHINE_LOCAL_KEYS");
        }
        for key in MACHINE_LOCAL_KEYS {
            assert!(named.iter().any(|k| k == key), "MACHINE_LOCAL_KEYS names `{key}`, which Settings no longer has");
        }
    }

    #[test]
    fn the_lists_do_not_overlap() {
        for key in PERSONAL_KEYS {
            assert!(!MACHINE_LOCAL_KEYS.contains(key), "{key}");
        }
    }

    #[test]
    fn the_personal_subset_never_carries_a_machine_local_key() {
        let mut s = Settings::default();
        s.hook_port = Some(4242);
        s.poll_interval_secs = 90;
        let subset = personal_subset(&s);
        assert_eq!(subset.get("poll_interval_secs"), Some(&json!(90)));
        for key in MACHINE_LOCAL_KEYS {
            assert!(!subset.contains_key(*key), "{key}");
        }
    }

    #[test]
    fn only_personal_edits_are_stamped_and_sent() {
        let old = Settings::default();
        let mut new = old.clone();
        new.poll_interval_secs = 120;
        new.hook_port = Some(9);
        new.extra.insert("paceBand".into(), json!(7));
        new.extra.insert("someFutureKey".into(), json!(1));
        let mut clocks = Clocks::new();
        let sent = stamp_changes(&old, &new, &mut clocks, "2026-11-15T10:00:00Z", "pc");
        let keys: Vec<&str> = sent.iter().map(|c| c.key.as_str()).collect();
        assert_eq!(keys, vec!["poll_interval_secs", "paceBand"]);
        assert_eq!(clocks.len(), 2);
        assert_eq!(clocks["paceBand"], stamp("2026-11-15T10:00:00Z", "pc"));
    }

    #[test]
    fn a_newer_remote_edit_wins_and_an_older_one_loses() {
        let local = Settings::default();
        let mut clocks = Clocks::new();
        clocks.insert("poll_interval_secs".into(), stamp("2026-11-15T10:00:00Z", "pc"));

        let older = merge(&local, &mut clocks, &[change("poll_interval_secs", json!(300), "2026-11-15T09:00:00Z", "mac")]);
        assert!(older.applied.is_empty());
        assert_eq!(older.settings.poll_interval_secs, local.poll_interval_secs);

        let newer = merge(&local, &mut clocks, &[change("poll_interval_secs", json!(300), "2026-11-15T11:00:00Z", "mac")]);
        assert_eq!(newer.applied, vec!["poll_interval_secs".to_string()]);
        assert_eq!(newer.settings.poll_interval_secs, 300);
        assert_eq!(clocks["poll_interval_secs"], stamp("2026-11-15T11:00:00Z", "mac"));
    }

    #[test]
    fn an_edit_at_the_same_instant_has_one_winner_on_both_machines() {
        let at = "2026-11-15T10:00:00Z";
        let (mut on_pc, mut on_mac) = (Clocks::new(), Clocks::new());
        on_pc.insert("paceBand".into(), stamp(at, "pc"));
        on_mac.insert("paceBand".into(), stamp(at, "mac"));
        let base = Settings::default();
        let pc_gets = merge(&base, &mut on_pc, &[change("paceBand", json!(2), at, "mac")]);
        let mac_gets = merge(&base, &mut on_mac, &[change("paceBand", json!(1), at, "pc")]);
        // "pc" > "mac", so the PC's value is the one both keep.
        assert!(pc_gets.applied.is_empty());
        assert_eq!(mac_gets.applied, vec!["paceBand".to_string()]);
        assert_eq!(mac_gets.settings.extra["paceBand"], json!(1));
    }

    #[test]
    fn a_key_with_no_local_stamp_takes_the_incoming_value() {
        let mut clocks = Clocks::new();
        let m = merge(&Settings::default(), &mut clocks, &[change("backgroundEnabled", json!(true), "2026-11-15T10:00:00Z", "mac")]);
        assert_eq!(m.settings.extra["backgroundEnabled"], json!(true));
    }

    #[test]
    fn a_machine_local_or_unknown_key_in_the_payload_is_refused_and_changes_nothing() {
        let local = Settings::default();
        let mut clocks = Clocks::new();
        let m = merge(
            &local,
            &mut clocks,
            &[
                change("hook_port", json!(1), "2026-11-15T10:00:00Z", "mac"),
                change("projects", json!([]), "2026-11-15T10:00:00Z", "mac"),
                change("sessionCharacters", json!({"s": "c"}), "2026-11-15T10:00:00Z", "mac"),
                change("neverClassified", json!(1), "2026-11-15T10:00:00Z", "mac"),
            ],
        );
        assert!(m.applied.is_empty());
        assert_eq!(m.refused.len(), 4);
        assert_eq!(m.settings, local);
        assert!(clocks.is_empty());
    }

    #[test]
    fn a_value_of_the_wrong_shape_is_refused_and_the_local_value_survives() {
        let mut local = Settings::default();
        local.poll_interval_secs = 77;
        let mut clocks = Clocks::new();
        let m = merge(&local, &mut clocks, &[change("poll_interval_secs", json!("not a number"), "2026-11-15T10:00:00Z", "mac")]);
        assert_eq!(m.refused, vec!["poll_interval_secs".to_string()]);
        assert_eq!(m.settings.poll_interval_secs, 77);
        assert!(!clocks.contains_key("poll_interval_secs"), "a refused edit leaves no stamp");
    }

    #[test]
    fn a_merge_never_touches_machine_local_fields() {
        let mut local = Settings::default();
        local.hook_port = Some(1234);
        local.autostart = true;
        let mut clocks = Clocks::new();
        let m = merge(&local, &mut clocks, &[change("poll_interval_secs", json!(200), "2026-11-15T10:00:00Z", "mac")]);
        assert_eq!(m.settings.hook_port, Some(1234));
        assert!(m.settings.autostart);
    }

    #[test]
    fn stamps_are_compared_as_times_not_as_text() {
        let mut clocks = Clocks::new();
        clocks.insert("paceBand".into(), stamp("2026-11-15T10:00:00Z", "pc"));
        // Later as a time, though `...:00.5Z` sorts before `...:00Z` as a string.
        let later = merge(&Settings::default(), &mut clocks, &[change("paceBand", json!(1), "2026-11-15T10:00:00.5Z", "mac")]);
        assert_eq!(later.applied, vec!["paceBand".to_string()]);
        // Earlier as a time, though `12:00+02:00` sorts after `11:00Z` as a string.
        let mut clocks = Clocks::new();
        clocks.insert("paceBand".into(), stamp("2026-11-15T11:00:00Z", "pc"));
        let earlier = merge(&Settings::default(), &mut clocks, &[change("paceBand", json!(1), "2026-11-15T12:00:00+02:00", "mac")]);
        assert!(earlier.applied.is_empty() && earlier.refused.is_empty());
    }

    #[test]
    fn a_stamp_that_is_not_a_time_or_is_far_ahead_is_refused_so_a_peer_cannot_win_a_key_forever() {
        let mut clocks = Clocks::new();
        let m = merge(
            &Settings::default(),
            &mut clocks,
            &[
                change("paceBand", json!(1), "9999", "mac"),
                change("paceColors", json!({}), "not a time", "mac"),
                change("backgroundEnabled", json!(true), "2999-01-01T00:00:00Z", "mac"),
            ],
        );
        assert!(m.applied.is_empty());
        assert_eq!(m.refused.len(), 3);
        assert!(clocks.is_empty(), "no stamp was stored, so a real edit still wins later");
    }

    #[test]
    fn the_trays_in_memory_timed_mute_survives_a_merge() {
        let mut local = Settings::default();
        local.timed_mute = Some(crate::types::TimedMute { until_ms: 4_000_000_000_000, secs: 3600 });
        let mut clocks = Clocks::new();
        let m = merge(&local, &mut clocks, &[change("poll_interval_secs", json!(200), "2026-11-15T10:00:00Z", "mac")]);
        assert_eq!(m.applied.len(), 1);
        assert_eq!(m.settings.timed_mute, local.timed_mute);
    }

    #[test]
    fn an_absent_key_written_as_what_the_ui_already_shows_is_not_an_edit() {
        let old = Settings::default();
        let mut new = old.clone();
        new.extra.insert("paceBand".into(), json!(10));
        new.extra.insert("paceColors".into(), json!({"under": "#27ae60", "nearSafe": "#f1c40f", "nearOver": "#e67e22", "over": "#e74c3c"}));
        new.extra.insert("colorApplyTo".into(), json!({"dashboard": true, "overlay": true}));
        new.extra.insert("overlayBackgroundStyle".into(), json!("circles"));
        new.extra.insert("backgroundEnabled".into(), json!(false));
        new.extra.insert("backgroundVariant".into(), json!("pattern"));
        assert!(changed_personal_keys(&old, &new).is_empty());
        let mut clocks = Clocks::new();
        assert!(stamp_changes(&old, &new, &mut clocks, "2026-11-15T10:00:00Z", "pc").is_empty());
        assert!(clocks.is_empty());
    }

    #[test]
    fn an_absent_key_written_as_something_else_is_an_edit_and_so_is_going_back_to_the_default() {
        let old = Settings::default();
        let mut custom = old.clone();
        custom.extra.insert("paceBand".into(), json!(25));
        custom.extra.insert("colorApplyTo".into(), json!({"dashboard": false, "overlay": true}));
        assert_eq!(changed_personal_keys(&old, &custom), vec!["colorApplyTo".to_string(), "paceBand".to_string()]);
        // A key that was set and now holds the default IS an edit: the peer must hear it.
        let mut back = custom.clone();
        back.extra.insert("paceBand".into(), json!(10));
        assert_eq!(changed_personal_keys(&custom, &back), vec!["paceBand".to_string()]);
    }

    #[test]
    fn a_local_edit_is_stamped_after_the_stamp_it_replaces_even_when_that_one_is_ahead_of_this_clock() {
        let (old, mut new) = (Settings::default(), Settings::default());
        new.extra.insert("paceBand".into(), json!(25));
        // The peer's clock runs 4 minutes ahead (accepted, under the 5 minute limit);
        // this machine's clock says 10:00:00 while the stamp on the key says 10:04:00.
        let mut clocks = Clocks::new();
        clocks.insert("paceBand".into(), stamp("2026-11-15T10:04:00Z", "mac"));
        let sent = stamp_changes(&old, &new, &mut clocks, "2026-11-15T10:00:00Z", "pc");
        assert_eq!(sent[0].stamp.at, "2026-11-15T10:04:00.001Z");
        // The peer merges it: the edit wins over the value it was stamped after.
        let mut theirs = Clocks::new();
        theirs.insert("paceBand".into(), stamp("2026-11-15T10:04:00Z", "mac"));
        let m = merge(&Settings::default(), &mut theirs, &sent);
        assert_eq!(m.applied, vec!["paceBand".to_string()]);
        // With a clock that is ahead of the old stamp, the edit just takes `now`.
        let mut clocks = Clocks::new();
        clocks.insert("paceBand".into(), stamp("2026-11-15T09:00:00Z", "mac"));
        let sent = stamp_changes(&old, &new, &mut clocks, "2026-11-15T10:00:00Z", "pc");
        assert_eq!(sent[0].stamp.at, "2026-11-15T10:00:00Z");
    }

    #[test]
    fn a_stamp_over_the_skew_limit_is_skewed_and_one_inside_it_is_not() {
        let now = DateTime::parse_from_rfc3339("2026-11-15T10:00:00Z").unwrap().with_timezone(&Utc);
        assert!(is_skewed(&stamp("2026-11-15T10:06:00Z", "mac"), now), "a peer clock ahead of this one");
        assert!(!is_skewed(&stamp("2026-11-15T10:04:00Z", "mac"), now));
        assert!(!is_skewed(&stamp("2026-11-15T09:00:00Z", "mac"), now), "a peer behind is not refused");
        assert!(!is_skewed(&stamp("not a time", "mac"), now));
        // The other direction: this machine's stamps are far ahead of the peer's clock.
        let peer_now = DateTime::parse_from_rfc3339("2026-11-15T09:50:00Z").unwrap().with_timezone(&Utc);
        assert!(is_skewed(&stamp("2026-11-15T10:00:00Z", "pc"), peer_now));
    }

    #[test]
    fn a_removed_value_arrives_as_null_and_reads_as_the_default() {
        let mut local = Settings::default();
        local.extra.insert("paceBand".into(), json!(5));
        let mut clocks = Clocks::new();
        let m = merge(&local, &mut clocks, &[change("paceBand", Value::Null, "2026-11-15T10:00:00Z", "mac")]);
        assert!(!m.settings.extra.contains_key("paceBand"));
        assert_eq!(m.applied, vec!["paceBand".to_string()]);
    }
}
