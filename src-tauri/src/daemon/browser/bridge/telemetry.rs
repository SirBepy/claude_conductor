//! What the daemon logs about the extension socket, so a drop can be told
//! apart from a dead worker. Brave closed that socket about every 5 minutes
//! on 2026-11-21 (76 drops) and the old log said only "connection N closed".
//!
//! The extension's `hello` carries when its MV3 worker started and how its
//! previous socket ended; comparing the worker start across hellos says
//! whether Chrome killed the worker (new start time) or only the socket
//! dropped (same worker, a close code). Everything here is a pure function
//! of the messages, so the log lines are tested without a browser.

use std::collections::HashMap;
use std::sync::Mutex;

use serde_json::Value;

/// How the extension says its previous socket ended (`lastClose` in `hello`).
#[derive(Debug, Clone, PartialEq, Default)]
pub(super) struct LastClose {
    pub code: Option<i64>,
    pub reason: String,
    pub was_clean: Option<bool>,
    /// How long that socket lived, in ms.
    pub lived_ms: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub(super) struct Hello {
    pub browser: String,
    pub user_agent: String,
    pub install_id: String,
    pub version: String,
    /// Epoch ms at which the extension's worker script started.
    pub worker_started_at: Option<i64>,
    pub last_close: Option<LastClose>,
    /// Whether the extension holds the native-messaging keepalive port.
    pub native_port: Option<bool>,
    /// Why the keepalive port last disconnected, when it did.
    pub native_disconnect: Option<String>,
}

impl Hello {
    /// An older extension sends only `browser` and `userAgent`; every other
    /// field is then empty, never an error.
    pub fn parse(v: &Value) -> Hello {
        let text = |k: &str| v[k].as_str().unwrap_or_default().to_string();
        let last_close = v["lastClose"].is_object().then(|| {
            let c = &v["lastClose"];
            LastClose {
                code: c["code"].as_i64(),
                reason: c["reason"].as_str().unwrap_or_default().to_string(),
                was_clean: c["wasClean"].as_bool(),
                lived_ms: c["livedMs"].as_i64(),
            }
        });
        Hello {
            browser: text("browser"),
            user_agent: text("userAgent"),
            install_id: text("installId"),
            version: text("version"),
            worker_started_at: v["workerStartedAt"].as_i64(),
            last_close,
            native_port: v["nativePort"].as_bool(),
            native_disconnect: v["nativeDisconnect"].as_str().map(str::to_string),
        }
    }

    /// One log line. `now_ms` is the daemon's clock; the worker's age uses it,
    /// so a skewed clock shows as an odd age rather than a wrong verdict
    /// (the verdict itself is `WorkerLog::note`'s, which never reads a clock).
    pub fn describe(&self, ext: u64, worker: WorkerChange, now_ms: i64) -> String {
        let mut line = format!("{} connected (connection {ext})", or_q(&self.browser));
        if !self.version.is_empty() {
            line.push_str(&format!(", extension {}", self.version));
        }
        match self.worker_started_at {
            Some(t) => line.push_str(&format!(", worker up {}s ({})", (now_ms - t).max(0) / 1000, worker.label())),
            None => line.push_str(", no worker start time (extension predates the keepalive)"),
        }
        match self.native_port {
            Some(true) => line.push_str(", keepalive port held"),
            Some(false) => line.push_str(&format!(", keepalive port NOT held{}", self.native_disconnect.as_deref().map(|e| format!(" ({e})")).unwrap_or_default())),
            None => {}
        }
        if let Some(c) = &self.last_close {
            line.push_str(&format!(
                ", previous socket ended code {} reason {:?} clean {} after {}",
                c.code.map_or("?".to_string(), |n| n.to_string()),
                c.reason,
                c.was_clean.map_or("?".to_string(), |b| b.to_string()),
                c.lived_ms.map_or("?".to_string(), |ms| format!("{}s", ms / 1000)),
            ));
        }
        line
    }
}

fn or_q(s: &str) -> &str {
    if s.is_empty() { "?" } else { s }
}

/// Whether this hello comes from the worker the same install reported last.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(super) enum WorkerChange {
    /// First hello from this install since the daemon started.
    First,
    /// Same worker as the previous hello: only the socket dropped.
    Same,
    /// A different worker start: Chrome stopped the worker and started a new one.
    Restarted,
    /// The hello gave no worker start time.
    Unknown,
}

impl WorkerChange {
    fn label(self) -> &'static str {
        match self {
            WorkerChange::First => "first connection seen",
            WorkerChange::Same => "same worker as the last connection, only the socket dropped",
            WorkerChange::Restarted => "NEW worker, the browser stopped the old one",
            WorkerChange::Unknown => "worker identity unknown",
        }
    }
}

/// The last worker start per install, kept for the daemon's lifetime.
#[derive(Default)]
pub(super) struct WorkerLog(HashMap<String, i64>);

impl WorkerLog {
    pub fn note(&mut self, hello: &Hello) -> WorkerChange {
        let Some(started) = hello.worker_started_at else { return WorkerChange::Unknown };
        match self.0.insert(hello.install_id.clone(), started) {
            None => WorkerChange::First,
            Some(prev) if prev == started => WorkerChange::Same,
            Some(_) => WorkerChange::Restarted,
        }
    }
}

/// Shared by every extension connection of this daemon.
pub(super) fn note_worker(hello: &Hello) -> WorkerChange {
    static LOG: std::sync::OnceLock<Mutex<WorkerLog>> = std::sync::OnceLock::new();
    LOG.get_or_init(Default::default).lock().unwrap_or_else(|p| p.into_inner()).note(hello)
}

/// How the extension's socket ended, as the daemon saw it.
#[derive(Debug, Clone, PartialEq)]
pub(super) enum SocketEnd {
    /// A close frame, with the code and reason the peer sent (none when the frame was empty).
    Frame(Option<(u16, String)>),
    /// The TCP stream ended with no close frame, the way a killed worker looks.
    Ended,
    /// The read failed.
    Error(String),
}

impl SocketEnd {
    pub fn describe(&self) -> String {
        match self {
            SocketEnd::Frame(Some((code, reason))) => format!("close frame code {code} reason {reason:?}"),
            SocketEnd::Frame(None) => "close frame without a code".to_string(),
            SocketEnd::Ended => "stream ended without a close frame".to_string(),
            SocketEnd::Error(e) => format!("read error: {e}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn a_full_hello_is_parsed_and_every_field_reaches_the_log_line() {
        let h = Hello::parse(&json!({
            "browser": "brave", "userAgent": "UA", "installId": "i1", "version": "1.1.0",
            "workerStartedAt": 1_000_000, "nativePort": true,
            "lastClose": { "code": 1006, "reason": "", "wasClean": false, "livedMs": 288_000 },
        }));
        assert_eq!(h.install_id, "i1");
        assert_eq!(h.last_close, Some(LastClose { code: Some(1006), reason: String::new(), was_clean: Some(false), lived_ms: Some(288_000) }));
        let line = h.describe(3, WorkerChange::Same, 1_090_000);
        for part in ["brave connected (connection 3)", "extension 1.1.0", "worker up 90s", "only the socket dropped", "keepalive port held", "code 1006", "clean false", "after 288s"] {
            assert!(line.contains(part), "{part:?} missing from {line}");
        }
    }

    #[test]
    fn an_old_extension_hello_parses_with_no_telemetry_and_is_not_an_error() {
        let h = Hello::parse(&json!({ "browser": "brave", "userAgent": "UA" }));
        assert_eq!((h.worker_started_at, h.last_close.clone(), h.native_port), (None, None, None));
        let line = h.describe(1, WorkerChange::Unknown, 5);
        assert!(line.contains("predates the keepalive"), "{line}");
        assert!(!line.contains("previous socket"), "{line}");
    }

    #[test]
    fn a_missing_keepalive_port_names_why_it_dropped() {
        let h = Hello::parse(&json!({ "browser": "brave", "workerStartedAt": 1, "nativePort": false, "nativeDisconnect": "Native host has exited." }));
        assert!(h.describe(1, WorkerChange::First, 2000).contains("NOT held (Native host has exited.)"));
    }

    #[test]
    fn a_new_worker_start_is_told_apart_from_a_socket_that_only_dropped() {
        let hello = |install: &str, started: Option<i64>| Hello { install_id: install.into(), worker_started_at: started, ..Default::default() };
        let mut log = WorkerLog::default();
        assert_eq!(log.note(&hello("a", Some(10))), WorkerChange::First);
        assert_eq!(log.note(&hello("a", Some(10))), WorkerChange::Same);
        assert_eq!(log.note(&hello("a", Some(99))), WorkerChange::Restarted);
        assert_eq!(log.note(&hello("a", Some(99))), WorkerChange::Same);
        assert_eq!(log.note(&hello("b", Some(10))), WorkerChange::First, "another profile is tracked apart");
        assert_eq!(log.note(&hello("a", None)), WorkerChange::Unknown);
    }

    /// The extension and the parser agree on the field names only by
    /// convention, and a rename on one side would silently log "?" forever.
    #[test]
    fn the_extension_sends_every_field_the_daemon_reads() {
        let js = include_str!("../../../../../browser-extension/background.js");
        for key in ["workerStartedAt", "lastClose", "nativePort", "nativeDisconnect", "installId", "version", "livedMs", "wasClean", "connectNative"] {
            assert!(js.contains(key), "background.js lost {key}");
        }
        let manifest: Value = serde_json::from_str(include_str!("../../../../../browser-extension/manifest.json")).unwrap();
        assert_ne!(manifest["version"], json!("1.0.0"), "an extension change needs a new version so the hello shows which build runs");
    }

    #[test]
    fn every_way_the_socket_can_end_is_told_apart() {
        assert_eq!(SocketEnd::Frame(Some((1001, "going away".into()))).describe(), "close frame code 1001 reason \"going away\"");
        assert_eq!(SocketEnd::Frame(None).describe(), "close frame without a code");
        assert!(SocketEnd::Ended.describe().contains("without a close frame"));
        assert!(SocketEnd::Error("reset".into()).describe().contains("reset"));
    }
}
