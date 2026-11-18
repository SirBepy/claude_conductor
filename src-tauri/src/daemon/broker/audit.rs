//! Append-only JSONL audit log of every broker call, including the ones the
//! guards, the policy or the ownership check refused. One line per call:
//!
//! ```text
//! {"ts","session","service","method","path","status","outcome","reason",
//!  "req_bytes","resp_bytes","unmasked","get_volume":{...},"flags":[...]}
//! ```
//!
//! A line never holds a token: `path` and `reason` are masked by the engine
//! before they get here, and no header or body is logged. GETs also carry a
//! rolling volume per (session, service) and outlier flags, so a chat walking
//! every ticket shows up without the log needing a reader to count. Flags
//! annotate, they do not block: blocking is the policy's job.
//!
//! The file is opened per line in append mode (never truncated or rewritten
//! here), so deleting or rotating it between calls is safe.

use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// When a GET pattern is flagged.
#[derive(Clone, Copy, Debug)]
pub struct VolumeLimits {
    /// GETs in the last minute at or above this raise `burst`.
    pub burst_per_min: usize,
    /// GETs in the last hour at or above this raise `sustained`.
    pub sustained_per_hour: usize,
    /// One response at or above this many bytes raises `large_response`.
    pub large_response_bytes: usize,
}

impl Default for VolumeLimits {
    fn default() -> Self {
        Self { burst_per_min: 60, sustained_per_hour: 600, large_response_bytes: 1024 * 1024 }
    }
}

/// What the engine reports about one call.
#[derive(Clone, Debug)]
pub struct AuditEntry {
    pub session: String,
    pub service: String,
    pub method: String,
    /// Path and query, already masked.
    pub path: String,
    pub status: Option<u16>,
    /// `ok`, `upstream_error`, `denied_guard`, `denied_policy`, `denied_owner`,
    /// `no_secret` or `error`.
    pub outcome: &'static str,
    pub reason: Option<String>,
    pub req_bytes: usize,
    pub resp_bytes: usize,
    /// True when the result was returned without masking (binary `out_file`).
    pub unmasked: bool,
}

#[derive(Default)]
struct State {
    /// (session, service) -> (when, response bytes) of recent GETs.
    gets: HashMap<(String, String), VecDeque<(Instant, usize)>>,
}

pub struct AuditLog {
    path: PathBuf,
    limits: VolumeLimits,
    state: Mutex<State>,
}

impl AuditLog {
    pub fn new(path: PathBuf) -> Self {
        Self::with_limits(path, VolumeLimits::default())
    }

    pub fn with_limits(path: PathBuf, limits: VolumeLimits) -> Self {
        Self { path, limits, state: Mutex::new(State::default()) }
    }

    pub fn path(&self) -> &std::path::Path {
        &self.path
    }

    /// Appends the line for one call and returns it.
    pub fn record(&self, e: &AuditEntry) -> Result<Value, String> {
        self.record_at(e, Instant::now())
    }

    pub(crate) fn record_at(&self, e: &AuditEntry, now: Instant) -> Result<Value, String> {
        let ts = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let mut line = json!({
            "ts": ts,
            "session": e.session,
            "service": e.service,
            "method": e.method,
            "path": e.path,
            "status": e.status,
            "outcome": e.outcome,
            "reason": e.reason,
            "req_bytes": e.req_bytes,
            "resp_bytes": e.resp_bytes,
            "unmasked": e.unmasked,
        });
        // Only a GET that reached the service counts toward volume.
        if e.method == "GET" && e.status.is_some() {
            let (volume, flags) = self.note_get(&e.session, &e.service, e.resp_bytes, now);
            line["get_volume"] = volume;
            line["flags"] = json!(flags);
        }
        let mut text = serde_json::to_string(&line).map_err(|e| e.to_string())?;
        text.push('\n');
        // The lock also serializes writers so two lines never interleave.
        let _guard = self.state.lock().unwrap();
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut f = std::fs::OpenOptions::new().create(true).append(true).open(&self.path).map_err(|e| e.to_string())?;
        f.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
        Ok(line)
    }

    fn note_get(&self, session: &str, service: &str, bytes: usize, now: Instant) -> (Value, Vec<&'static str>) {
        let mut st = self.state.lock().unwrap();
        let q = st.gets.entry((session.to_string(), service.to_string())).or_default();
        q.push_back((now, bytes));
        let hour = Duration::from_secs(3600);
        while q.front().is_some_and(|(t, _)| now.duration_since(*t) > hour) {
            q.pop_front();
        }
        let minute = Duration::from_secs(60);
        let recent = || q.iter().filter(|(t, _)| now.duration_since(*t) <= minute);
        let last_min = recent().count();
        let bytes_last_min: usize = recent().map(|(_, b)| *b).sum();
        let last_hour = q.len();
        let mut flags = Vec::new();
        if last_min >= self.limits.burst_per_min {
            flags.push("burst");
        }
        if last_hour >= self.limits.sustained_per_hour {
            flags.push("sustained");
        }
        if bytes >= self.limits.large_response_bytes {
            flags.push("large_response");
        }
        (json!({ "last_min": last_min, "last_hour": last_hour, "bytes_last_min": bytes_last_min }), flags)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(method: &str, status: Option<u16>, bytes: usize) -> AuditEntry {
        AuditEntry {
            session: "s1".into(),
            service: "shortcut".into(),
            method: method.into(),
            path: "/api/v3/stories/1".into(),
            status,
            outcome: "ok",
            reason: None,
            req_bytes: 0,
            resp_bytes: bytes,
            unmasked: false,
        }
    }

    fn lines(log: &AuditLog) -> Vec<Value> {
        std::fs::read_to_string(log.path()).unwrap().lines().map(|l| serde_json::from_str(l).unwrap()).collect()
    }

    #[test]
    fn each_call_appends_one_json_line_and_existing_lines_survive() {
        let dir = tempfile::tempdir().unwrap();
        let log = AuditLog::new(dir.path().join("nested").join("audit.jsonl"));
        log.record(&entry("POST", Some(201), 10)).unwrap();
        let before = std::fs::read_to_string(log.path()).unwrap();
        log.record(&entry("GET", Some(200), 10)).unwrap();
        let after = std::fs::read_to_string(log.path()).unwrap();
        assert!(after.starts_with(&before), "earlier lines are never rewritten");
        let l = lines(&log);
        assert_eq!(l.len(), 2);
        assert_eq!(l[0]["method"], "POST");
        assert_eq!(l[0]["status"], 201);
        assert_eq!(l[0]["session"], "s1");
        assert_eq!(l[0]["unmasked"], false);
        assert!(l[0].get("get_volume").is_none(), "only GETs carry volume");
        assert!(l[0]["ts"].as_str().unwrap().ends_with('Z'));
    }

    #[test]
    fn a_refused_call_is_logged_without_a_status_or_volume() {
        let dir = tempfile::tempdir().unwrap();
        let log = AuditLog::new(dir.path().join("audit.jsonl"));
        let mut e = entry("GET", None, 0);
        e.outcome = "denied_policy";
        e.reason = Some("no row".into());
        log.record(&e).unwrap();
        let l = &lines(&log)[0];
        assert_eq!(l["outcome"], "denied_policy");
        assert_eq!(l["reason"], "no row");
        assert!(l["status"].is_null());
        assert!(l.get("get_volume").is_none());
    }

    #[test]
    fn get_volume_counts_per_session_and_service_and_flags_a_burst() {
        let dir = tempfile::tempdir().unwrap();
        let log = AuditLog::with_limits(dir.path().join("a.jsonl"), VolumeLimits { burst_per_min: 3, sustained_per_hour: 5, large_response_bytes: 100 });
        let t0 = Instant::now();
        let mut last = Value::Null;
        for i in 0..3 {
            last = log.record_at(&entry("GET", Some(200), 10), t0 + Duration::from_secs(i)).unwrap();
        }
        assert_eq!(last["get_volume"]["last_min"], 3);
        assert_eq!(last["flags"], json!(["burst"]));
        // Another session has its own count.
        let mut other = entry("GET", Some(200), 10);
        other.session = "s2".into();
        let o = log.record_at(&other, t0 + Duration::from_secs(3)).unwrap();
        assert_eq!(o["get_volume"]["last_min"], 1);
        assert_eq!(o["flags"], json!([]));
    }

    #[test]
    fn old_gets_leave_the_window_and_sustained_and_large_responses_are_flagged() {
        let dir = tempfile::tempdir().unwrap();
        let log = AuditLog::with_limits(dir.path().join("a.jsonl"), VolumeLimits { burst_per_min: 1000, sustained_per_hour: 3, large_response_bytes: 100 });
        let t0 = Instant::now();
        log.record_at(&entry("GET", Some(200), 1), t0).unwrap();
        log.record_at(&entry("GET", Some(200), 1), t0 + Duration::from_secs(120)).unwrap();
        let third = log.record_at(&entry("GET", Some(200), 500), t0 + Duration::from_secs(200)).unwrap();
        assert_eq!(third["get_volume"]["last_min"], 1, "the two older GETs are outside the minute");
        assert_eq!(third["get_volume"]["last_hour"], 3);
        assert_eq!(third["get_volume"]["bytes_last_min"], 500);
        assert_eq!(third["flags"], json!(["sustained", "large_response"]));
        let later = log.record_at(&entry("GET", Some(200), 1), t0 + Duration::from_secs(4000)).unwrap();
        assert_eq!(later["get_volume"]["last_hour"], 1, "everything older than an hour is dropped");
    }

    #[test]
    fn deleting_the_file_between_calls_just_starts_a_new_one() {
        let dir = tempfile::tempdir().unwrap();
        let log = AuditLog::new(dir.path().join("a.jsonl"));
        log.record(&entry("POST", Some(200), 1)).unwrap();
        std::fs::remove_file(log.path()).unwrap();
        log.record(&entry("POST", Some(200), 1)).unwrap();
        assert_eq!(lines(&log).len(), 1);
    }
}
